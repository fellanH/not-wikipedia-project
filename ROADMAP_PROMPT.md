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


## Current Task: 1.6 - Unit Tests for wiki-git-publish.ts

### 1.6 Unit Tests for wiki-git-publish.ts

**Status**: `IN_PROGRESS`
**Priority**: P1
**Effort**: Low
**Dependencies**: 1.1

**Specification**:
- Test git command construction
- Test commit message generation
- Test push error handling
- Mock execSync for isolation

**Files to Create**:
- `local-agent/lib/mcp/src/__tests__/tools/wiki-git-publish.test.ts`

**Test Cases**:
```typescript
describe('wiki-git-publish', () => {
  describe('commit operations', () => {
    it('stages all changes in wiki directory')
    it('generates descriptive commit message')
    it('handles empty commits gracefully')
  })

  describe('push operations', () => {
    it('pushes to origin on success')
    it('handles push failures gracefully')
    it('reports partial success (commit ok, push failed)')
  })
})
```

**Acceptance Criteria**:
- [ ] Git commands verified via mocks
- [ ] Error handling tested
- [ ] Coverage > 80% for wiki-git-publish.ts

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
TASK_COMPLETE: 1.6
```

If you encounter a blocker that prevents completion, respond with:

```
TASK_BLOCKED: 1.6
REASON: <description of the blocker>
```

