#!/bin/bash
#
# create-user-task.sh - Helper script for agents to create user tasks
#
# Usage:
#   ./create-user-task.sh "Task Title" "Description" [PRIORITY] [--assign]
#
# Examples:
#   ./create-user-task.sh "Fix bug" "Fix the bug in X"
#   ./create-user-task.sh "Add feature" "Add Y feature" P2 --assign
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DASHBOARD_PORT=${DASHBOARD_PORT:-3001}
API_URL="http://localhost:${DASHBOARD_PORT}/api/agent/user-tasks"

# Parse arguments
TITLE="$1"
DESCRIPTION="$2"
PRIORITY="${3:-P5}"
ASSIGN_TO_AGENT=false

if [ -z "$TITLE" ]; then
    echo "Error: Title is required" >&2
    echo "Usage: $0 \"Title\" \"Description\" [PRIORITY] [--assign]" >&2
    exit 1
fi

# Check for --assign flag
for arg in "$@"; do
    if [ "$arg" = "--assign" ]; then
        ASSIGN_TO_AGENT=true
        # Remove --assign from priority if it was passed as priority
        if [ "$PRIORITY" = "--assign" ]; then
            PRIORITY="P5"
        fi
    fi
done

# Build JSON payload
if command -v jq >/dev/null 2>&1; then
    JSON_PAYLOAD=$(cat <<EOF
{
  "title": $(echo "$TITLE" | jq -R .),
  "description": $(echo "$DESCRIPTION" | jq -R .),
  "priority": "$PRIORITY",
  "assignToAgent": $ASSIGN_TO_AGENT,
  "sourceAgent": "roadmap-agent"
}
EOF
)
else
    # Fallback: escape JSON manually
    TITLE_ESC=$(echo "$TITLE" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g')
    DESC_ESC=$(echo "$DESCRIPTION" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g')
    JSON_PAYLOAD=$(cat <<EOF
{
  "title": "$TITLE_ESC",
  "description": "$DESC_ESC",
  "priority": "$PRIORITY",
  "assignToAgent": $ASSIGN_TO_AGENT,
  "sourceAgent": "roadmap-agent"
}
EOF
)
fi

# Make API call
if command -v curl >/dev/null 2>&1; then
    RESPONSE=$(curl -s -X POST "$API_URL" \
        -H "Content-Type: application/json" \
        -d "$JSON_PAYLOAD")
elif command -v wget >/dev/null 2>&1; then
    TMP_FILE=$(mktemp)
    echo "$JSON_PAYLOAD" > "$TMP_FILE"
    RESPONSE=$(wget -q -O- --post-data="$(cat $TMP_FILE)" \
        --header="Content-Type: application/json" \
        "$API_URL")
    rm -f "$TMP_FILE"
else
    echo "Error: Neither curl nor wget found. Cannot create user task." >&2
    exit 1
fi

# Check if request was successful
if echo "$RESPONSE" | grep -q '"success":true'; then
    TASK_ID=$(echo "$RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
    echo "✓ User task created: $TASK_ID"
    if command -v jq >/dev/null 2>&1; then
        echo "$RESPONSE" | jq '.'
    else
        echo "$RESPONSE"
    fi
    exit 0
else
    echo "Error: Failed to create user task" >&2
    echo "$RESPONSE" >&2
    exit 1
fi
