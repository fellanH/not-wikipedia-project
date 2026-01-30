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


## Current Task: 2.1 - Fix Silent DB Errors in wiki-create-article.ts

### 2.1 Fix Silent DB Errors in wiki-create-article.ts

**Status**: `IN_PROGRESS`
**Priority**: P0
**Effort**: Low
**Dependencies**: 1.3 (tests first)

**Specification**:
- Replace `console.error` with proper error throws
- Add transaction-like behavior for create → register → discover
- Implement rollback if any step fails

**Files to Modify**:
- `local-agent/lib/mcp/src/tools/wiki-create-article.ts` (lines 194-209)

**Current Code** (problematic):
```typescript
try {
  db.registerArticle(...)
} catch (e) {
  console.error('Failed to register:', e)  // Silent failure!
}
```

**Target Code**:
```typescript
try {
  db.registerArticle(...)
} catch (e) {
  // Rollback: delete the file we just created
  await fs.unlink(filePath)
  throw new Error(`Article creation failed: ${e.message}`)
}
```

**Acceptance Criteria**:
- [ ] DB errors propagate to caller
- [ ] Failed articles are cleaned up
- [ ] Error messages are descriptive
- [ ] Existing tests still pass

---

---

## After Completing

When you have completed all the acceptance criteria, respond with:

```
TASK_COMPLETE: 2.1
```

If you encounter a blocker that prevents completion, respond with:

```
TASK_BLOCKED: 2.1
REASON: <description of the blocker>
```

