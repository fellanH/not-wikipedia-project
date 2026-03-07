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

## Current Task: 2.2 - Add Retry Logic to wiki-git-publish.ts

### 2.2 Add Retry Logic to wiki-git-publish.ts

**Status**: `IN_PROGRESS`
**Priority**: P1
**Effort**: Low
**Dependencies**: 1.6 (tests first)

**Specification**:

- Add retry with exponential backoff for git push
- Maximum 3 attempts
- Log each retry attempt
- Return detailed failure info if all retries fail

**Files to Modify**:

- `local-agent/lib/mcp/src/tools/wiki-git-publish.ts` (lines 99-112)

**Implementation**:

```typescript
async function pushWithRetry(maxAttempts = 3): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      execSync("git push", { cwd: WIKI_CONTENT_DIR });
      return true;
    } catch (e) {
      if (attempt === maxAttempts) {
        console.error(`Push failed after ${maxAttempts} attempts`);
        return false;
      }
      const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return false;
}
```

**Acceptance Criteria**:

- [ ] Push retries up to 3 times
- [ ] Backoff delays increase exponentially
- [ ] Final failure returns structured error
- [ ] Success on retry is reported correctly

---

---

## Creating User Tasks

If during task execution you identify follow-up work, improvements, or related tasks that should be tracked, you can create user tasks using:

```bash
# Create a user task (will be picked up by agents)
# Path is relative to project root
./roadmap-dashboard/create-user-task.sh "Task Title" "Description" [PRIORITY] [--assign]

# Examples:
./roadmap-dashboard/create-user-task.sh "Add tests for feature X" "Add unit tests for the new feature" P3
./roadmap-dashboard/create-user-task.sh "Refactor Y component" "Refactor for better maintainability" P5 --assign
```

User tasks will be automatically processed by agents in future runs. Use this for:

- Follow-up improvements identified during implementation
- Related work that should be tracked separately
- Tasks that emerge from the current work but aren't part of the original spec

---

## After Completing

When you have completed all the acceptance criteria, respond with:

```
TASK_COMPLETE: 2.2
```

If you encounter a blocker that prevents completion, respond with:

```
TASK_BLOCKED: 2.2
REASON: <description of the blocker>
```
