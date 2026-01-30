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


## Current Task: 1.1 - Add Vitest Test Framework

### 1.1 Add Vitest Test Framework

**Status**: `IN_PROGRESS`
**Priority**: P0
**Effort**: Low
**Dependencies**: None

**Specification**:
- Install Vitest as dev dependency in `local-agent/lib/mcp/`
- Configure `vitest.config.ts` for TypeScript support
- Add test scripts to `package.json`
- Create `src/__tests__/` directory structure

**Files to Create/Modify**:
- `local-agent/lib/mcp/package.json` - Add vitest dependency and scripts
- `local-agent/lib/mcp/vitest.config.ts` - New file
- `local-agent/lib/mcp/src/__tests__/.gitkeep` - New directory

**Acceptance Criteria**:
- [ ] `npm test` runs Vitest
- [ ] `npm run test:watch` runs in watch mode
- [ ] `npm run test:coverage` generates coverage report
- [ ] TypeScript files can be tested without compilation step

**Implementation Notes**:
```bash
cd local-agent/lib/mcp
npm install -D vitest @vitest/coverage-v8
```

---

---

## After Completing

When you have completed all the acceptance criteria, respond with:

```
TASK_COMPLETE: 1.1
```

If you encounter a blocker that prevents completion, respond with:

```
TASK_BLOCKED: 1.1
REASON: <description of the blocker>
```

