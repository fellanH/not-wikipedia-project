#!/bin/bash
#
# roadmap-agent.sh - Orchestrate Claude Code agents to execute ROADMAP.md tasks
#
# Usage:
#   ./roadmap-agent.sh                  # Run continuously
#   ./roadmap-agent.sh --single         # Run one task and exit
#   ./roadmap-agent.sh --task 1.1       # Run specific task
#   ./roadmap-agent.sh --list           # List available tasks
#   ./roadmap-agent.sh --status         # Show roadmap status
#   ./roadmap-agent.sh --dry-run        # Show what would run without executing
#

set -e

# ============================================================================
# Configuration
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROADMAP_FILE="$SCRIPT_DIR/ROADMAP.md"
PROMPT_FILE="$SCRIPT_DIR/ROADMAP_PROMPT.md"
LOG_DIR="$SCRIPT_DIR/roadmap-logs"
LOCK_DIR="$SCRIPT_DIR/.roadmap-locks"

# Agent settings
MAX_LOOPS=${MAX_LOOPS:-0}           # 0 = unlimited
LOOP_DELAY=${LOOP_DELAY:-5}         # Seconds between tasks
AUTO_COMMIT=${AUTO_COMMIT:-true}    # Commit changes after each task
DRY_RUN=${DRY_RUN:-false}
SINGLE_MODE=${SINGLE_MODE:-false}
SPECIFIC_TASK=${SPECIFIC_TASK:-""}

# Claude settings
CLAUDE_MODEL=${CLAUDE_MODEL:-""}    # Empty = default model
CLAUDE_TIMEOUT=${CLAUDE_TIMEOUT:-600}  # 10 minutes per task

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ============================================================================
# Utility Functions
# ============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $(date '+%H:%M:%S') $1"
}

log_success() {
    echo -e "${GREEN}[DONE]${NC} $(date '+%H:%M:%S') $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $(date '+%H:%M:%S') $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $(date '+%H:%M:%S') $1"
}

log_task() {
    echo -e "${CYAN}[TASK]${NC} $(date '+%H:%M:%S') $1"
}

ensure_dirs() {
    mkdir -p "$LOG_DIR"
    mkdir -p "$LOCK_DIR"
}

run_with_timeout() {
    local timeout_seconds="$1"
    shift

    if command -v timeout >/dev/null 2>&1; then
        timeout "$timeout_seconds" "$@"
        return $?
    fi

    if command -v gtimeout >/dev/null 2>&1; then
        gtimeout "$timeout_seconds" "$@"
        return $?
    fi

    if command -v perl >/dev/null 2>&1; then
        perl -e 'alarm shift; exec @ARGV' "$timeout_seconds" "$@"
        return $?
    fi

    if command -v python3 >/dev/null 2>&1; then
        python3 - "$timeout_seconds" "$@" <<'PY'
import os
import signal
import sys

seconds = int(sys.argv[1])
cmd = sys.argv[2:]
signal.alarm(seconds)
os.execvp(cmd[0], cmd)
PY
        return $?
    fi

    log_warn "No timeout utility found; running without timeout."
    "$@"
}

# ============================================================================
# Roadmap Parsing
# ============================================================================

# Extract all task IDs and their status from ROADMAP.md
get_all_tasks() {
    grep -E "^### [0-9]+\.[0-9]+ " "$ROADMAP_FILE" | \
        sed 's/### //' | \
        awk '{print $1}'
}

# Get task status (PENDING, IN_PROGRESS, DONE, BLOCKED, SKIPPED)
get_task_status() {
    local task_id="$1"
    local section_start=$(grep -n "^### $task_id " "$ROADMAP_FILE" | head -1 | cut -d: -f1)

    if [ -z "$section_start" ]; then
        echo "NOT_FOUND"
        return
    fi

    # Look for **Status**: `STATUS` within next 10 lines
    tail -n +$section_start "$ROADMAP_FILE" | head -20 | \
        grep -oE '\*\*Status\*\*: `[A-Z_]+`' | \
        sed 's/.*`\([A-Z_]*\)`.*/\1/' | head -1
}

# Get task title
get_task_title() {
    local task_id="$1"
    grep "^### $task_id " "$ROADMAP_FILE" | sed "s/^### $task_id //"
}

# Get task dependencies
get_task_dependencies() {
    local task_id="$1"
    local section_start=$(grep -n "^### $task_id " "$ROADMAP_FILE" | head -1 | cut -d: -f1)

    if [ -z "$section_start" ]; then
        echo ""
        return
    fi

    # Look for **Dependencies**: within next 10 lines
    local deps=$(tail -n +$section_start "$ROADMAP_FILE" | head -15 | \
        grep -E '\*\*Dependencies\*\*:' | \
        sed 's/.*Dependencies\*\*: //')

    # Extract task IDs like 1.1, 1.2
    echo "$deps" | grep -oE '[0-9]+\.[0-9]+' | tr '\n' ' '
}

# Get task priority
get_task_priority() {
    local task_id="$1"
    local section_start=$(grep -n "^### $task_id " "$ROADMAP_FILE" | head -1 | cut -d: -f1)

    if [ -z "$section_start" ]; then
        echo "P9"
        return
    fi

    tail -n +$section_start "$ROADMAP_FILE" | head -10 | \
        grep -oE '\*\*Priority\*\*: P[0-9]' | \
        sed 's/.*P/P/' | head -1
}

# Get full task section from ROADMAP.md
get_task_section() {
    local task_id="$1"
    local section_start=$(grep -n "^### $task_id " "$ROADMAP_FILE" | head -1 | cut -d: -f1)

    if [ -z "$section_start" ]; then
        echo ""
        return
    fi

    # Find next section (next ### or next ##)
    local section_end=$(tail -n +$((section_start + 1)) "$ROADMAP_FILE" | \
        grep -n "^###\|^## " | head -1 | cut -d: -f1)

    if [ -z "$section_end" ]; then
        # No next section, read to end
        tail -n +$section_start "$ROADMAP_FILE"
    else
        tail -n +$section_start "$ROADMAP_FILE" | head -$((section_end - 1))
    fi
}

# Check if all dependencies are DONE
check_dependencies() {
    local task_id="$1"
    local deps=$(get_task_dependencies "$task_id")

    if [ -z "$deps" ] || [ "$deps" = "None" ]; then
        return 0  # No dependencies
    fi

    for dep in $deps; do
        local dep_status=$(get_task_status "$dep")
        if [ "$dep_status" != "DONE" ]; then
            return 1  # Dependency not met
        fi
    done

    return 0  # All dependencies met
}

# Find next available task (PENDING with dependencies met)
find_next_task() {
    local tasks=$(get_all_tasks)

    # Sort by priority (P0 first)
    for priority in P0 P1 P2 P3; do
        for task_id in $tasks; do
            local status=$(get_task_status "$task_id")
            local task_priority=$(get_task_priority "$task_id")

            if [ "$status" = "PENDING" ] && [ "$task_priority" = "$priority" ]; then
                if check_dependencies "$task_id"; then
                    echo "$task_id"
                    return
                fi
            fi
        done
    done

    echo ""  # No task available
}

# ============================================================================
# Status Management
# ============================================================================

# Update task status in ROADMAP.md
update_task_status() {
    local task_id="$1"
    local new_status="$2"

    if [ "$DRY_RUN" = "true" ]; then
        log_info "DRY RUN: Would update $task_id to $new_status"
        return
    fi

    # Find the line with the status
    local section_start=$(grep -n "^### $task_id " "$ROADMAP_FILE" | head -1 | cut -d: -f1)

    if [ -z "$section_start" ]; then
        log_error "Task $task_id not found in ROADMAP.md"
        return 1
    fi

    # Update status line using sed
    # Match: **Status**: `ANYTHING`
    # Replace with: **Status**: `NEW_STATUS`
    sed -i.bak -E "/^### $task_id /,/^### [0-9]/{
        s/(\*\*Status\*\*: )\`[A-Z_]+\`/\1\`$new_status\`/
    }" "$ROADMAP_FILE"

    rm -f "$ROADMAP_FILE.bak"

    log_info "Updated $task_id status to $new_status"
}

# Update header counts
update_roadmap_counts() {
    local total=$(get_all_tasks | wc -w)
    local done=$(grep -c '`DONE`' "$ROADMAP_FILE" 2>/dev/null || echo 0)
    local in_progress=$(grep -c '`IN_PROGRESS`' "$ROADMAP_FILE" 2>/dev/null || echo 0)
    local pending=$((total - done - in_progress))

    # Update the header section
    sed -i.bak -E "
        s/\*\*Total Tasks\*\*: [0-9]+/**Total Tasks**: $total/
        s/\*\*Completed\*\*: [0-9]+/**Completed**: $done/
        s/\*\*In Progress\*\*: [0-9]+/**In Progress**: $in_progress/
        s/\*\*Pending\*\*: [0-9]+/**Pending**: $pending/
    " "$ROADMAP_FILE"

    rm -f "$ROADMAP_FILE.bak"
}

# ============================================================================
# Lock Management (for parallel execution safety)
# ============================================================================

acquire_lock() {
    local task_id="$1"
    local lock_file="$LOCK_DIR/task-${task_id}.lock"

    if mkdir "$lock_file" 2>/dev/null; then
        echo $$ > "$lock_file/pid"
        return 0
    else
        return 1
    fi
}

release_lock() {
    local task_id="$1"
    local lock_file="$LOCK_DIR/task-${task_id}.lock"
    rm -rf "$lock_file"
}

cleanup_stale_locks() {
    for lock_dir in "$LOCK_DIR"/task-*.lock; do
        if [ -d "$lock_dir" ]; then
            local pid_file="$lock_dir/pid"
            if [ -f "$pid_file" ]; then
                local pid=$(cat "$pid_file")
                if ! kill -0 "$pid" 2>/dev/null; then
                    log_warn "Cleaning up stale lock: $lock_dir"
                    rm -rf "$lock_dir"
                fi
            fi
        fi
    done
}

# ============================================================================
# Prompt Generation
# ============================================================================

generate_prompt() {
    local task_id="$1"
    local task_section=$(get_task_section "$task_id")
    local task_title=$(get_task_title "$task_id")

    cat > "$PROMPT_FILE" << 'PROMPT_HEADER'
# Roadmap Task Execution

You are executing a task from the Not-Wikipedia project ROADMAP.md. Follow the specification exactly.

## Instructions

1. Read the task specification carefully
2. Implement the changes as specified
3. Verify acceptance criteria are met
4. Do NOT mark the task as complete - the orchestrator will do that based on your success

## Important Rules

- Only modify files explicitly listed in the task
- Follow existing code patterns in the project
- Run tests if they exist (`npm test` in local-agent/lib/mcp)
- Do not create unnecessary files
- Keep changes minimal and focused

---

PROMPT_HEADER

    cat >> "$PROMPT_FILE" << TASK_SECTION

## Current Task: $task_id - $task_title

$task_section

---

## Creating User Tasks

If during task execution you identify follow-up work, improvements, or related tasks that should be tracked, you can create user tasks using:

\`\`\`bash
# Create a user task (will be picked up by agents)
# Path is relative to project root
./roadmap-dashboard/create-user-task.sh "Task Title" "Description" [PRIORITY] [--assign]

# Examples:
./roadmap-dashboard/create-user-task.sh "Add tests for feature X" "Add unit tests for the new feature" P3
./roadmap-dashboard/create-user-task.sh "Refactor Y component" "Refactor for better maintainability" P5 --assign
\`\`\`

User tasks will be automatically processed by agents in future runs. Use this for:
- Follow-up improvements identified during implementation
- Related work that should be tracked separately
- Tasks that emerge from the current work but aren't part of the original spec

---

## After Completing

When you have completed all the acceptance criteria, respond with:

\`\`\`
TASK_COMPLETE: $task_id
\`\`\`

If you encounter a blocker that prevents completion, respond with:

\`\`\`
TASK_BLOCKED: $task_id
REASON: <description of the blocker>
\`\`\`

TASK_SECTION

    log_info "Generated prompt for task $task_id"
}

# ============================================================================
# Task Execution
# ============================================================================

run_task() {
    local task_id="$1"
    local task_title=$(get_task_title "$task_id")
    local log_file="$LOG_DIR/task-${task_id}-$(date +%Y%m%d-%H%M%S).log"

    log_task "Starting: $task_id - $task_title"

    # Try to acquire lock
    if ! acquire_lock "$task_id"; then
        log_warn "Task $task_id is already being worked on"
        return 1
    fi

    # Update status to IN_PROGRESS
    update_task_status "$task_id" "IN_PROGRESS"
    update_roadmap_counts

    # Generate the prompt
    generate_prompt "$task_id"

    if [ "$DRY_RUN" = "true" ]; then
        log_info "DRY RUN: Would execute Claude on task $task_id"
        log_info "Prompt file: $PROMPT_FILE"
        cat "$PROMPT_FILE"
        release_lock "$task_id"
        return 0
    fi

    # Build Claude command
    local claude_cmd="claude -p \"$PROMPT_FILE\" --allowedTools \"Bash(read-only:true),Read,Glob,Grep,Edit,Write,Task,TodoWrite\" --dangerously-skip-permissions"

    if [ -n "$CLAUDE_MODEL" ]; then
        claude_cmd="$claude_cmd --model $CLAUDE_MODEL"
    fi

    # Run Claude and capture output
    log_info "Running Claude Code agent..."
    local start_time=$(date +%s)

    set +e  # Don't exit on error
    run_with_timeout "$CLAUDE_TIMEOUT" bash -c "$claude_cmd" 2>&1 | tee "$log_file"
    local exit_code=${PIPESTATUS[0]}
    set -e

    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    log_info "Task completed in ${duration}s (exit code: $exit_code)"

    # Check outcome
    local task_result="UNKNOWN"
    if grep -q "TASK_COMPLETE: $task_id" "$log_file"; then
        task_result="DONE"
        log_success "Task $task_id completed successfully"
    elif grep -q "TASK_BLOCKED: $task_id" "$log_file"; then
        task_result="BLOCKED"
        local reason=$(grep -A1 "TASK_BLOCKED: $task_id" "$log_file" | grep "REASON:" | sed 's/REASON: //')
        log_warn "Task $task_id blocked: $reason"
        
        # Create a user task for the blocker
        if [ -n "$reason" ]; then
            local blocker_title="Resolve blocker for task $task_id: $(echo "$task_title" | cut -c1-50)"
            local blocker_description="Task $task_id was blocked with reason: $reason

Original task: $task_id - $task_title
Blocked at: $(date '+%Y-%m-%d %H:%M:%S')

This user task was automatically created to track resolution of the blocker."
            
            log_info "Creating user task for blocker: $blocker_title"
            if create_user_task "$blocker_title" "$blocker_description" "P2" "false"; then
                log_success "User task created for blocker"
            else
                log_warn "Failed to create user task for blocker (dashboard may not be running)"
            fi
        fi
    elif [ $exit_code -ne 0 ]; then
        task_result="PENDING"  # Reset to pending for retry
        log_error "Task $task_id failed (exit code: $exit_code)"
    else
        # Claude finished but didn't report completion - check if files were modified
        if git diff --quiet 2>/dev/null; then
            task_result="PENDING"
            log_warn "Task $task_id: No changes detected, keeping as PENDING"
        else
            task_result="DONE"
            log_success "Task $task_id: Changes detected, marking as DONE"
        fi
    fi

    # Update status
    update_task_status "$task_id" "$task_result"
    update_roadmap_counts

    # Commit changes if enabled
    if [ "$AUTO_COMMIT" = "true" ] && [ "$task_result" = "DONE" ]; then
        commit_changes "$task_id" "$task_title"
    fi

    # Release lock
    release_lock "$task_id"

    # Return success only if task completed
    [ "$task_result" = "DONE" ]
}

commit_changes() {
    local task_id="$1"
    local task_title="$2"

    if [ "$DRY_RUN" = "true" ]; then
        log_info "DRY RUN: Would commit changes for $task_id"
        return
    fi

    # Check if there are changes to commit
    if git diff --quiet && git diff --cached --quiet; then
        log_info "No changes to commit"
        return
    fi

    log_info "Committing changes..."

    git add -A
    git commit -m "$(cat <<EOF
roadmap($task_id): $task_title

Automated commit from roadmap-agent.sh

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"

    log_success "Changes committed"
}

# ============================================================================
# Display Functions
# ============================================================================

show_status() {
    echo ""
    echo "========================================"
    echo "       ROADMAP STATUS SUMMARY"
    echo "========================================"
    echo ""

    local total=0
    local done=0
    local in_progress=0
    local pending=0
    local blocked=0

    for task_id in $(get_all_tasks); do
        local status=$(get_task_status "$task_id")
        local title=$(get_task_title "$task_id")
        local priority=$(get_task_priority "$task_id")

        ((total++))

        case $status in
            DONE)
                echo -e "${GREEN}✓${NC} [$priority] $task_id: $title"
                ((done++))
                ;;
            IN_PROGRESS)
                echo -e "${YELLOW}►${NC} [$priority] $task_id: $title"
                ((in_progress++))
                ;;
            BLOCKED)
                echo -e "${RED}✗${NC} [$priority] $task_id: $title"
                ((blocked++))
                ;;
            PENDING)
                if check_dependencies "$task_id"; then
                    echo -e "${BLUE}○${NC} [$priority] $task_id: $title"
                else
                    echo -e "${CYAN}◌${NC} [$priority] $task_id: $title (waiting on deps)"
                fi
                ((pending++))
                ;;
        esac
    done

    echo ""
    echo "----------------------------------------"
    echo -e "Total: $total | ${GREEN}Done: $done${NC} | ${YELLOW}In Progress: $in_progress${NC} | ${BLUE}Pending: $pending${NC} | ${RED}Blocked: $blocked${NC}"
    echo "----------------------------------------"
    echo ""
}

show_list() {
    echo ""
    echo "Available tasks (PENDING with dependencies met):"
    echo ""

    for task_id in $(get_all_tasks); do
        local status=$(get_task_status "$task_id")

        if [ "$status" = "PENDING" ] && check_dependencies "$task_id"; then
            local title=$(get_task_title "$task_id")
            local priority=$(get_task_priority "$task_id")
            echo "  [$priority] $task_id: $title"
        fi
    done

    echo ""
}

show_help() {
    cat << 'EOF'
roadmap-agent.sh - Execute ROADMAP.md tasks with Claude Code

USAGE:
    ./roadmap-agent.sh [OPTIONS]

OPTIONS:
    --single          Run one task and exit
    --task ID         Run specific task (e.g., --task 1.1)
    --list            List available tasks
    --status          Show roadmap status
    --dry-run         Show what would run without executing
    --no-commit       Don't auto-commit changes
    --help            Show this help message

ENVIRONMENT VARIABLES:
    MAX_LOOPS         Maximum tasks to run (0 = unlimited)
    LOOP_DELAY        Seconds between tasks (default: 5)
    AUTO_COMMIT       Commit after each task (default: true)
    CLAUDE_MODEL      Claude model to use
    CLAUDE_TIMEOUT    Timeout per task in seconds (default: 600)

EXAMPLES:
    ./roadmap-agent.sh                    # Run continuously
    ./roadmap-agent.sh --single           # Run one task
    ./roadmap-agent.sh --task 1.1         # Run task 1.1
    ./roadmap-agent.sh --status           # Show progress
    MAX_LOOPS=5 ./roadmap-agent.sh        # Run 5 tasks

EOF
}

# ============================================================================
# User Tasks Management
# ============================================================================

USER_TASKS_FILE="$SCRIPT_DIR/.roadmap-user-tasks.json"
DASHBOARD_PORT=${DASHBOARD_PORT:-3001}

# Check for user tasks that need to be processed
get_next_user_task() {
    if [ ! -f "$USER_TASKS_FILE" ]; then
        echo ""
        return
    fi

    # Use jq if available, otherwise use grep/sed
    if command -v jq >/dev/null 2>&1; then
        local task=$(jq -r '.tasks[] | select(.status == "ASSIGNED" or .status == "PENDING") | .id' "$USER_TASKS_FILE" | head -1)
        echo "$task"
    else
        # Fallback: grep for ASSIGNED or PENDING tasks
        grep -o '"id":"[^"]*"' "$USER_TASKS_FILE" | head -1 | sed 's/"id":"\([^"]*\)"/\1/' || echo ""
    fi
}

# Create a user task via API
create_user_task() {
    local title="$1"
    local description="$2"
    local priority="${3:-P5}"
    local assign="${4:-false}"

    if [ -z "$title" ]; then
        log_error "create_user_task: title is required"
        return 1
    fi

    local create_script="$SCRIPT_DIR/roadmap-dashboard/create-user-task.sh"
    if [ -f "$create_script" ]; then
        if [ "$assign" = "true" ]; then
            "$create_script" "$title" "$description" "$priority" --assign
        else
            "$create_script" "$title" "$description" "$priority"
        fi
    else
        log_warn "create-user-task.sh not found at $create_script, cannot create user task"
        return 1
    fi
}

# Process user tasks before roadmap tasks
process_user_tasks() {
    local user_task_id=$(get_next_user_task)
    
    if [ -z "$user_task_id" ]; then
        return 0  # No user tasks to process
    fi

    log_info "Found user task: $user_task_id"
    
    # Extract task details
    if command -v jq >/dev/null 2>&1; then
        local title=$(jq -r ".tasks[] | select(.id == \"$user_task_id\") | .title" "$USER_TASKS_FILE")
        local description=$(jq -r ".tasks[] | select(.id == \"$user_task_id\") | .description" "$USER_TASKS_FILE")
        local priority=$(jq -r ".tasks[] | select(.id == \"$user_task_id\") | .priority" "$USER_TASKS_FILE")
    else
        # Fallback parsing
        local title=$(grep -A 20 "\"id\":\"$user_task_id\"" "$USER_TASKS_FILE" | grep '"title"' | head -1 | sed 's/.*"title":"\([^"]*\)".*/\1/')
        local description=$(grep -A 20 "\"id\":\"$user_task_id\"" "$USER_TASKS_FILE" | grep '"description"' | head -1 | sed 's/.*"description":"\([^"]*\)".*/\1/')
        local priority="P5"
    fi

    log_task "Processing user task: $user_task_id - $title"
    
    # Create a temporary prompt file for the user task
    local temp_prompt="$PROMPT_FILE.user-task"
    cat > "$temp_prompt" << EOF
# User Task Execution

You are executing a user-created task from the roadmap dashboard.

## Task Details

**ID**: $user_task_id
**Title**: $title
**Priority**: $priority
**Description**: 
$description

## Instructions

1. Read the task description carefully
2. Implement the requested changes
3. Verify the work is complete
4. When done, respond with:

\`\`\`
USER_TASK_COMPLETE: $user_task_id
\`\`\`

If you cannot complete the task, respond with:

\`\`\`
USER_TASK_BLOCKED: $user_task_id
REASON: <description>
\`\`\`

EOF

    # Run Claude on the user task
    local log_file="$LOG_DIR/user-task-${user_task_id}-$(date +%Y%m%d-%H%M%S).log"
    local claude_cmd="claude -p \"$temp_prompt\" --allowedTools \"Bash(read-only:true),Read,Glob,Grep,Edit,Write,Task,TodoWrite\" --dangerously-skip-permissions"

    if [ -n "$CLAUDE_MODEL" ]; then
        claude_cmd="$claude_cmd --model $CLAUDE_MODEL"
    fi

    log_info "Running Claude Code agent on user task..."
    local start_time=$(date +%s)

    set +e
    run_with_timeout "$CLAUDE_TIMEOUT" bash -c "$claude_cmd" 2>&1 | tee "$log_file"
    local exit_code=${PIPESTATUS[0]}
    set -e

    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    # Check outcome
    if grep -q "USER_TASK_COMPLETE: $user_task_id" "$log_file"; then
        log_success "User task $user_task_id completed successfully"
        # Update task status via API if dashboard is running
        if command -v curl >/dev/null 2>&1; then
            curl -s -X PUT "http://localhost:${DASHBOARD_PORT}/api/user-tasks/$user_task_id" \
                -H "Content-Type: application/json" \
                -d '{"status":"COMPLETED"}' > /dev/null 2>&1 || true
        fi
        rm -f "$temp_prompt"
        return 0
    elif grep -q "USER_TASK_BLOCKED: $user_task_id" "$log_file"; then
        local reason=$(grep -A1 "USER_TASK_BLOCKED: $user_task_id" "$log_file" | grep "REASON:" | sed 's/REASON: //')
        log_warn "User task $user_task_id blocked: $reason"
        rm -f "$temp_prompt"
        return 1
    else
        log_warn "User task $user_task_id: No completion signal detected"
        rm -f "$temp_prompt"
        return 1
    fi
}

# ============================================================================
# Main Loop
# ============================================================================

main() {
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --single)
                SINGLE_MODE=true
                shift
                ;;
            --task)
                SPECIFIC_TASK="$2"
                SINGLE_MODE=true
                shift 2
                ;;
            --list)
                show_list
                exit 0
                ;;
            --status)
                show_status
                exit 0
                ;;
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --no-commit)
                AUTO_COMMIT=false
                shift
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done

    # Verify roadmap exists
    if [ ! -f "$ROADMAP_FILE" ]; then
        log_error "ROADMAP.md not found at $ROADMAP_FILE"
        exit 1
    fi

    # Verify Claude CLI
    if ! command -v claude &> /dev/null; then
        log_error "Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
        exit 1
    fi

    ensure_dirs
    cleanup_stale_locks

    echo ""
    echo "========================================"
    echo "     NOT-WIKIPEDIA ROADMAP AGENT"
    echo "========================================"
    echo ""
    echo "Configuration:"
    echo "  Single mode:  $SINGLE_MODE"
    echo "  Dry run:      $DRY_RUN"
    echo "  Auto commit:  $AUTO_COMMIT"
    echo "  Max loops:    $MAX_LOOPS"
    echo ""

    local loop_count=0
    local success_count=0
    local fail_count=0

    while true; do
        # Check loop limit
        if [ "$MAX_LOOPS" -gt 0 ] && [ "$loop_count" -ge "$MAX_LOOPS" ]; then
            log_info "Reached maximum loops ($MAX_LOOPS)"
            break
        fi

        # Check for user tasks first (they take priority)
        local user_task_id=$(get_next_user_task)
        if [ -n "$user_task_id" ]; then
            log_info "Processing user task: $user_task_id"
            if process_user_tasks; then
                ((success_count++))
            else
                ((fail_count++))
            fi
            
            if [ "$SINGLE_MODE" = "true" ]; then
                break
            fi
            
            log_info "Waiting ${LOOP_DELAY}s before next task..."
            sleep $LOOP_DELAY
            continue
        fi

        # Find next roadmap task
        local task_id
        if [ -n "$SPECIFIC_TASK" ]; then
            task_id="$SPECIFIC_TASK"

            # Verify task exists
            if [ "$(get_task_status "$task_id")" = "NOT_FOUND" ]; then
                log_error "Task $task_id not found in ROADMAP.md"
                exit 1
            fi
        else
            task_id=$(find_next_task)
        fi

        if [ -z "$task_id" ]; then
            log_info "No available tasks found"

            if [ "$SINGLE_MODE" = "true" ]; then
                break
            fi

            # Check if all done
            local pending_count=$(grep -c '`PENDING`' "$ROADMAP_FILE" 2>/dev/null || echo 0)
            if [ "$pending_count" -eq 0 ]; then
                log_success "All roadmap tasks completed!"
                # Still check for user tasks before breaking
                if [ -z "$(get_next_user_task)" ]; then
                    break
                fi
            fi

            log_info "Waiting for dependencies to be resolved..."
            sleep $LOOP_DELAY
            continue
        fi

        ((loop_count++))

        log_info "=== Loop $loop_count ==="

        if run_task "$task_id"; then
            ((success_count++))
        else
            ((fail_count++))
        fi

        if [ "$SINGLE_MODE" = "true" ]; then
            break
        fi

        log_info "Waiting ${LOOP_DELAY}s before next task..."
        sleep $LOOP_DELAY
    done

    echo ""
    echo "========================================"
    echo "            SUMMARY"
    echo "========================================"
    echo "  Tasks attempted: $loop_count"
    echo "  Successful:      $success_count"
    echo "  Failed:          $fail_count"
    echo "========================================"
    echo ""

    show_status
}

# Run main
main "$@"
