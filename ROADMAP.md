# Not-Wikipedia Improvement Roadmap

> Orchestration guide for Claude Code agents. Each task includes specification, acceptance criteria, and current status.

**Last Updated**: 2025-01-30
**Total Tasks**:       35
**Completed**: 4
**In Progress**: 2
**Pending**: 29

---

## Status Legend

| Status | Meaning |
|--------|---------|
| `DONE` | Task completed and verified |
| `IN_PROGRESS` | Currently being worked on |
| `PENDING` | Ready to start |
| `BLOCKED` | Waiting on dependency |
| `SKIPPED` | Decided not to implement |

---

## Phase 1: Testing Infrastructure (CRITICAL)

> No tests exist. This is the highest priority as it enables safe refactoring for all other improvements.

### 1.1 Add Vitest Test Framework

**Status**: `DONE`
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

### 1.2 Unit Tests for wiki-next-task.ts

**Status**: `PENDING`
**Priority**: P0
**Effort**: Medium
**Dependencies**: 1.1

**Specification**:
- Test task priority ordering (live 404 > broken link > placeholder > orphan > new)
- Test human seed fallback when Quotable API fails
- Test task claiming logic
- Mock database calls for isolation

**Files to Create**:
- `local-agent/lib/mcp/src/__tests__/tools/wiki-next-task.test.ts`

**Test Cases**:
```typescript
describe('wiki-next-task', () => {
  describe('task priority', () => {
    it('prioritizes live 404s over broken links')
    it('prioritizes broken links over placeholders')
    it('prioritizes placeholders over orphans')
    it('prioritizes orphans over new content')
  })

  describe('human seed', () => {
    it('fetches from Quotable API when available')
    it('falls back to local corpus on API timeout')
    it('uses secure random selection for fallback')
  })

  describe('task claiming', () => {
    it('marks task as claimed in database')
    it('prevents duplicate claims')
    it('handles concurrent claim attempts')
  })
})
```

**Acceptance Criteria**:
- [ ] All priority ordering tests pass
- [ ] Fallback behavior verified
- [ ] Database mocking works correctly
- [ ] Coverage > 80% for wiki-next-task.ts

---

### 1.3 Unit Tests for wiki-create-article.ts

**Status**: `PENDING`
**Priority**: P0
**Effort**: Medium
**Dependencies**: 1.1

**Specification**:
- Test HTML generation from markdown
- Test infobox rendering
- Test database registration
- Test error handling paths

**Files to Create**:
- `local-agent/lib/mcp/src/__tests__/tools/wiki-create-article.test.ts`

**Test Cases**:
```typescript
describe('wiki-create-article', () => {
  describe('HTML generation', () => {
    it('generates valid HTML structure')
    it('escapes special characters in content')
    it('renders infobox with correct color')
    it('generates proper internal links')
  })

  describe('database registration', () => {
    it('inserts article record on success')
    it('inserts link records for all hrefs')
    it('handles duplicate article gracefully')
  })

  describe('error handling', () => {
    it('throws on invalid file path')
    it('throws on malformed markdown')
    it('propagates database errors')
  })
})
```

**Acceptance Criteria**:
- [ ] HTML generation tested with various inputs
- [ ] Database operations mocked and verified
- [ ] Error paths have explicit tests
- [ ] Coverage > 80% for wiki-create-article.ts

---

### 1.4 Unit Tests for wiki-edit-article.ts

**Status**: `PENDING`
**Priority**: P1
**Effort**: Medium
**Dependencies**: 1.1

**Specification**:
- Test section finding logic
- Test content replacement
- Test link addition
- Test malformed HTML handling

**Files to Create**:
- `local-agent/lib/mcp/src/__tests__/tools/wiki-edit-article.test.ts`

**Test Cases**:
```typescript
describe('wiki-edit-article', () => {
  describe('section operations', () => {
    it('finds section by heading text')
    it('replaces section content correctly')
    it('handles missing section gracefully')
    it('preserves surrounding HTML')
  })

  describe('link operations', () => {
    it('adds link to existing paragraph')
    it('creates new paragraph if needed')
    it('validates link target exists')
  })

  describe('edge cases', () => {
    it('handles nested HTML elements')
    it('handles empty sections')
    it('fails safely on malformed HTML')
  })
})
```

**Acceptance Criteria**:
- [ ] Section finding tested with various HTML structures
- [ ] Link addition verified
- [ ] Malformed HTML doesn't corrupt file
- [ ] Coverage > 80% for wiki-edit-article.ts

---

### 1.5 Unit Tests for wiki-discover.ts

**Status**: `PENDING`
**Priority**: P1
**Effort**: Medium
**Dependencies**: 1.1

**Specification**:
- Test link extraction from HTML
- Test relevance filtering
- Test depth limiting
- Test priority calculation

**Files to Create**:
- `local-agent/lib/mcp/src/__tests__/tools/wiki-discover.test.ts`

**Test Cases**:
```typescript
describe('wiki-discover', () => {
  describe('link extraction', () => {
    it('extracts all href attributes')
    it('filters out external links')
    it('filters out anchor links')
    it('deduplicates links')
  })

  describe('relevance filtering', () => {
    it('accepts links matching required keywords')
    it('rejects links matching excluded keywords')
    it('enforces minimum filename length')
  })

  describe('priority calculation', () => {
    it('assigns higher priority to lower depth')
    it('boosts priority for multiple references')
    it('respects max depth limit')
  })
})
```

**Acceptance Criteria**:
- [ ] Link extraction handles all edge cases
- [ ] Relevance filtering works as documented
- [ ] Priority calculation matches specification
- [ ] Coverage > 80% for wiki-discover.ts

---

### 1.6 Unit Tests for wiki-git-publish.ts

**Status**: `PENDING`
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

### 1.7 Integration Tests for Multi-Worker Scenarios

**Status**: `PENDING`
**Priority**: P2
**Effort**: High
**Dependencies**: 1.1, 1.2, 1.3

**Specification**:
- Test concurrent task claiming
- Test database locking behavior
- Test parallel article creation
- Use actual SQLite database (test instance)

**Files to Create**:
- `local-agent/lib/mcp/src/__tests__/integration/multi-worker.test.ts`

**Test Cases**:
```typescript
describe('multi-worker integration', () => {
  it('prevents duplicate task claims')
  it('handles concurrent article creation')
  it('maintains database integrity under load')
  it('properly releases stale locks')
})
```

**Acceptance Criteria**:
- [ ] Tests run with real SQLite instance
- [ ] Concurrent operations don't corrupt data
- [ ] Lock behavior verified
- [ ] Tests complete in < 30 seconds

---

### 1.8 Add GitHub Actions CI Pipeline

**Status**: `PENDING`
**Priority**: P2
**Effort**: Low
**Dependencies**: 1.1

**Specification**:
- Run tests on PR and push to main
- Run TypeScript compilation check
- Report coverage to PR comments
- Cache node_modules for speed

**Files to Create**:
- `.github/workflows/ci.yml`

**Workflow Specification**:
```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: local-agent/lib/mcp/package-lock.json
      - run: cd local-agent/lib/mcp && npm ci
      - run: cd local-agent/lib/mcp && npm run build
      - run: cd local-agent/lib/mcp && npm test -- --coverage
```

**Acceptance Criteria**:
- [ ] CI runs on every PR
- [ ] Build failures block merge
- [ ] Test failures block merge
- [ ] Coverage report visible in PR

---

## Phase 2: Error Handling & Reliability

> Fix silent failures and add proper error propagation.

### 2.1 Fix Silent DB Errors in wiki-create-article.ts

**Status**: `PENDING`
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

### 2.2 Add Retry Logic to wiki-git-publish.ts

**Status**: `PENDING`
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
      execSync('git push', { cwd: WIKI_CONTENT_DIR })
      return true
    } catch (e) {
      if (attempt === maxAttempts) {
        console.error(`Push failed after ${maxAttempts} attempts`)
        return false
      }
      const delay = Math.pow(2, attempt) * 1000  // 2s, 4s, 8s
      await new Promise(r => setTimeout(r, delay))
    }
  }
  return false
}
```

**Acceptance Criteria**:
- [ ] Push retries up to 3 times
- [ ] Backoff delays increase exponentially
- [ ] Final failure returns structured error
- [ ] Success on retry is reported correctly

---

### 2.3 Add HTML Validation to wiki-edit-article.ts

**Status**: `PENDING`
**Priority**: P1
**Effort**: Medium
**Dependencies**: 1.4 (tests first)

**Specification**:
- Validate HTML structure before regex manipulation
- Check that target sections exist
- Verify HTML is well-formed after edit
- Reject edits that would corrupt structure

**Files to Modify**:
- `local-agent/lib/mcp/src/tools/wiki-edit-article.ts`

**Implementation Approach**:
```typescript
import { JSDOM } from 'jsdom'

function validateHtmlStructure(html: string): boolean {
  try {
    const dom = new JSDOM(html)
    // Check required elements exist
    const hasInfobox = dom.window.document.querySelector('.infobox')
    const hasContent = dom.window.document.querySelector('.mw-parser-output')
    return hasInfobox !== null && hasContent !== null
  } catch {
    return false
  }
}
```

**Acceptance Criteria**:
- [ ] Invalid HTML rejected before edit
- [ ] Missing sections reported clearly
- [ ] Edits verified after completion
- [ ] Corrupted articles prevented

---

### 2.4 Fix Race Condition in Live 404 Crawl

**Status**: `PENDING`
**Priority**: P2
**Effort**: Medium
**Dependencies**: 1.2 (tests first)

**Specification**:
- Make crawl and claim atomic
- Use database transaction for the sequence
- Add locking to prevent concurrent claims

**Files to Modify**:
- `local-agent/lib/mcp/src/tools/wiki-next-task.ts` (lines 233-268)

**Current Flow** (problematic):
```
1. Crawl live site for 404s
2. [TIME GAP - another worker can claim]
3. Claim task in database
```

**Target Flow**:
```
1. Begin transaction
2. Crawl live site for 404s
3. Claim task in same transaction
4. Commit transaction
```

**Acceptance Criteria**:
- [ ] No duplicate task claims possible
- [ ] Transaction ensures atomicity
- [ ] Performance not degraded significantly
- [ ] Integration tests verify behavior

---

### 2.5 Add Input Validation with Zod Schemas

**Status**: `PENDING`
**Priority**: P2
**Effort**: Medium
**Dependencies**: None

**Specification**:
- Add Zod schemas to all MCP tool inputs
- Validate at handler entry point
- Return descriptive validation errors
- Document schema in tool definition

**Files to Modify**:
- All files in `local-agent/lib/mcp/src/tools/`

**Example Implementation**:
```typescript
import { z } from 'zod'

const CreateArticleInput = z.object({
  path: z.string().regex(/^[a-z0-9-]+\.html$/, 'Invalid filename format'),
  title: z.string().min(1).max(200),
  content: z.string().min(100),
  infobox_color: z.string().regex(/^#[0-9a-f]{6}$/i).optional()
})

export const tool: ToolModule = {
  handler: async (rawArgs) => {
    const args = CreateArticleInput.parse(rawArgs)  // Throws on invalid
    // ... rest of handler
  }
}
```

**Acceptance Criteria**:
- [ ] All tools have Zod schemas
- [ ] Invalid inputs rejected with clear messages
- [ ] Schema matches tool definition inputSchema
- [ ] No runtime type errors from bad input

---

## Phase 3: Developer Experience

> Implement improvements from DX_IMPROVEMENTS.md

### 3.1 Create .env.example File

**Status**: `PENDING`
**Priority**: P1
**Effort**: Low
**Dependencies**: None

**Specification**:
- Document all configuration variables
- Include sensible defaults
- Add comments explaining each variable
- Place in project root

**Files to Create**:
- `.env.example`

**Content**:
```bash
# Agent Configuration
PARALLEL_WORKERS=3              # Number of concurrent agent workers
MAX_LOOPS_PER_WORKER=100        # Iterations before worker restarts (0=unlimited)
LOOP_DELAY=2                    # Seconds between iterations

# Publishing
AUTO_PUBLISH=true               # Push to GitHub after each article
WIKI_CONTENT_REPO=fellanH/wiki-content

# Discovery
MAX_DISCOVERY_DEPTH=3           # Recursive link discovery depth
USE_LIVE_CRAWL=false            # Crawl live site for 404s
MAX_CRAWL_PAGES=10              # Pages to crawl if USE_LIVE_CRAWL=true

# Health Checks
HEALTH_CHECK_INTERVAL=10        # Full health check every N loops

# Development
DRY_RUN=false                   # Skip publishing (for testing)
SINGLE_ITERATION=false          # Run once and exit

# API Configuration
QUOTABLE_API_TIMEOUT=5000       # Timeout for human seed API (ms)
CRAWL_DELAY_MS=50               # Delay between crawl requests
```

**Acceptance Criteria**:
- [ ] All ralph.sh variables documented
- [ ] File is valid bash syntax
- [ ] Comments explain purpose of each variable
- [ ] Defaults match current behavior

---

### 3.2 Add Environment Loading to ralph.sh

**Status**: `PENDING`
**Priority**: P1
**Effort**: Low
**Dependencies**: 3.1

**Specification**:
- Load `.env` file if present
- Environment variables override `.env` values
- Maintain backward compatibility

**Files to Modify**:
- `local-agent/lib/agent/ralph.sh` (add near top, after `set -e`)

**Implementation**:
```bash
# Load .env file if present (after set -e, before variable defaults)
ENV_FILE="$(dirname "$0")/../../.env"
if [ -f "$ENV_FILE" ]; then
    set -a  # Export all variables
    source "$ENV_FILE"
    set +a
fi
```

**Acceptance Criteria**:
- [ ] .env file loaded when present
- [ ] Missing .env doesn't cause error
- [ ] CLI env vars still override .env
- [ ] All existing functionality preserved

---

### 3.3 Implement --dry-run Flag

**Status**: `PENDING`
**Priority**: P1
**Effort**: Medium
**Dependencies**: None

**Specification**:
- Add `--dry-run` flag to ralph.sh
- Skip git commit and push when enabled
- Log what would have been published
- Allow testing without affecting live site

**Files to Modify**:
- `local-agent/lib/agent/ralph.sh`

**Implementation**:
```bash
# Add argument parsing section
DRY_RUN=${DRY_RUN:-false}

while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Modify publish section
if [ "$AUTO_PUBLISH" = "true" ] && [ "$DRY_RUN" = "false" ]; then
    # existing publish logic
else
    log_info "DRY RUN: Would publish $(git -C "$WIKI_CONTENT_DIR" status --short | wc -l) files"
fi
```

**Acceptance Criteria**:
- [ ] `./ralph.sh --dry-run` skips publishing
- [ ] `DRY_RUN=true ./ralph.sh` also works
- [ ] Articles still created locally
- [ ] Log shows what would be published

---

### 3.4 Implement --health-check Flag

**Status**: `PENDING`
**Priority**: P2
**Effort**: Low
**Dependencies**: None

**Specification**:
- Add `--health-check` flag for standalone health check
- Run ecosystem analysis and exit
- No article generation
- Quick status overview

**Files to Modify**:
- `local-agent/lib/agent/ralph.sh`

**Implementation**:
```bash
# Add to argument parsing
        --health-check)
            run_health_check
            exit 0
            ;;

# Add function
run_health_check() {
    echo "=== Ecosystem Health Check ==="
    cd "$MCP_DIR"
    node -e "
        import('./dist/tools/wiki-ecosystem.js')
            .then(m => m.tool.handler({}))
            .then(r => console.log(r.content[0].text))
    "
    echo ""
    echo "=== Top 10 Broken Links ==="
    node -e "
        import('./dist/tools/wiki-broken-links.js')
            .then(m => m.tool.handler({ limit: 10 }))
            .then(r => console.log(r.content[0].text))
    "
}
```

**Acceptance Criteria**:
- [ ] `./ralph.sh --health-check` shows ecosystem status
- [ ] Exits after displaying status
- [ ] No articles created
- [ ] Output is human-readable

---

### 3.5 Implement --single Flag

**Status**: `PENDING`
**Priority**: P2
**Effort**: Low
**Dependencies**: None

**Specification**:
- Add `--single` flag for single iteration mode
- Create one article and exit
- Useful for testing and debugging

**Files to Modify**:
- `local-agent/lib/agent/ralph.sh`

**Implementation**:
```bash
# Add to argument parsing
        --single)
            SINGLE_ITERATION=true
            MAX_LOOPS_PER_WORKER=1
            PARALLEL_WORKERS=1
            shift
            ;;
```

**Acceptance Criteria**:
- [ ] `./ralph.sh --single` creates one article
- [ ] Exits cleanly after completion
- [ ] All post-processing runs (discovery, publish)
- [ ] Useful for debugging

---

### 3.6 Add Setup Script

**Status**: `PENDING`
**Priority**: P2
**Effort**: Medium
**Dependencies**: None

**Specification**:
- Create `setup.sh` at project root
- Check prerequisites (Node.js 20+, Claude CLI)
- Install dependencies
- Verify database initialization
- Print success message with next steps

**Files to Create**:
- `setup.sh`

**Content**:
```bash
#!/bin/bash
set -e

echo "=== Not-Wikipedia Setup ==="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js not found. Install from https://nodejs.org"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "ERROR: Node.js 20+ required (found v$NODE_VERSION)"
    exit 1
fi
echo "✓ Node.js $(node -v)"

# Check Claude CLI
if ! command -v claude &> /dev/null; then
    echo "ERROR: Claude Code CLI not found."
    echo "Install: npm install -g @anthropic-ai/claude-code"
    exit 1
fi
echo "✓ Claude CLI found"

# Install MCP dependencies
echo ""
echo "Installing MCP tools..."
cd local-agent/lib/mcp
npm install
npm run build
cd ../../..
echo "✓ MCP tools built"

# Check database
if [ ! -f "local-agent/lib/meta/ralph.db" ]; then
    echo "Note: Database will be initialized on first run"
else
    echo "✓ Database exists"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Run the agent:"
echo "  npm run ralph"
echo ""
echo "Or with options:"
echo "  cd local-agent/lib/agent && ./ralph.sh --single"
```

**Acceptance Criteria**:
- [ ] `./setup.sh` runs without errors on fresh clone
- [ ] Prerequisites checked and reported
- [ ] Dependencies installed
- [ ] Clear next steps printed

---

### 3.7 Add MCP CLI Wrapper

**Status**: `PENDING`
**Priority**: P3
**Effort**: Medium
**Dependencies**: None

**Specification**:
- Create CLI tool for running MCP tools directly
- Parse command line arguments
- List available tools with `--help`
- Simpler than node one-liners

**Files to Create**:
- `local-agent/lib/mcp/cli.js`

**Files to Modify**:
- `local-agent/lib/mcp/package.json` (add bin and script)

**Implementation**:
```javascript
#!/usr/bin/env node
import { readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const toolsDir = join(__dirname, 'dist', 'tools')

const [,, toolName, ...args] = process.argv

if (!toolName || toolName === '--help') {
    console.log('Usage: npx mcp <tool-name> [--param value ...]')
    console.log('')
    console.log('Available tools:')
    const tools = readdirSync(toolsDir)
        .filter(f => f.startsWith('wiki-') && f.endsWith('.js'))
        .map(f => '  ' + f.replace('.js', ''))
    console.log(tools.join('\n'))
    process.exit(0)
}

// Parse args into object
const params = {}
for (let i = 0; i < args.length; i += 2) {
    if (args[i]?.startsWith('--')) {
        params[args[i].slice(2)] = args[i + 1]
    }
}

// Load and run tool
const toolPath = join(toolsDir, `${toolName}.js`)
import(toolPath)
    .then(m => m.tool.handler(params))
    .then(r => console.log(r.content[0].text))
    .catch(e => {
        console.error('Error:', e.message)
        process.exit(1)
    })
```

**Acceptance Criteria**:
- [ ] `npx mcp wiki-ecosystem` works
- [ ] `npx mcp --help` lists all tools
- [ ] Arguments passed correctly
- [ ] Errors reported cleanly

---

### 3.8 Add Root NPM Scripts

**Status**: `PARTIAL`
**Priority**: P1
**Effort**: Low
**Dependencies**: None

**Specification**:
- Ensure all common operations have npm scripts
- Add missing scripts for new features
- Document in README

**Files to Modify**:
- `package.json` (root)

**Target Scripts**:
```json
{
  "scripts": {
    "ralph": "cd local-agent/lib/agent && ./ralph.sh",
    "ralph:single": "cd local-agent/lib/agent && ./ralph.sh --single",
    "ralph:dry": "cd local-agent/lib/agent && ./ralph.sh --dry-run",
    "health": "cd local-agent/lib/agent && ./ralph.sh --health-check",
    "build": "cd local-agent/lib/mcp && npm run build",
    "test": "cd local-agent/lib/mcp && npm test",
    "test:watch": "cd local-agent/lib/mcp && npm run test:watch",
    "publish": "cd local-agent/lib/mcp && node -e \"require('./dist/tools/wiki-git-publish.js').tool.handler({}).then(r=>console.log(r.content[0].text))\"",
    "setup": "./setup.sh",
    "dashboard": "cd local-agent/lib/dashboard && node server.js"
  }
}
```

**Acceptance Criteria**:
- [ ] `npm run ralph` starts agent loop
- [ ] `npm run ralph:single` creates one article
- [ ] `npm run health` shows ecosystem status
- [ ] `npm test` runs test suite

---

## Phase 4: Observability & Monitoring

> Add structured logging and performance tracking.

### 4.1 Add Structured Logging Module

**Status**: `PENDING`
**Priority**: P1
**Effort**: Medium
**Dependencies**: None

**Specification**:
- Create logging utility with JSON output
- Support log levels (debug, info, warn, error)
- Include timestamp, worker ID, context
- Write to both stdout and file

**Files to Create**:
- `local-agent/lib/mcp/src/utils/logger.ts`

**Implementation**:
```typescript
type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
  timestamp: string
  level: LogLevel
  worker?: string
  message: string
  context?: Record<string, unknown>
}

export function createLogger(workerId?: string) {
  return {
    info: (message: string, context?: Record<string, unknown>) =>
      log('info', message, workerId, context),
    warn: (message: string, context?: Record<string, unknown>) =>
      log('warn', message, workerId, context),
    error: (message: string, context?: Record<string, unknown>) =>
      log('error', message, workerId, context),
  }
}

function log(level: LogLevel, message: string, worker?: string, context?: Record<string, unknown>) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    worker,
    message,
    context
  }
  console.log(JSON.stringify(entry))
}
```

**Acceptance Criteria**:
- [ ] Logger produces valid JSON
- [ ] Log levels filter correctly
- [ ] Worker ID included when available
- [ ] Timestamps are ISO format

---

### 4.2 Replace Console Statements with Logger

**Status**: `PENDING`
**Priority**: P2
**Effort**: Medium
**Dependencies**: 4.1

**Specification**:
- Replace all `console.log/error/warn` in MCP tools
- Use structured logger
- Add context to log messages
- Maintain existing functionality

**Files to Modify**:
- All files in `local-agent/lib/mcp/src/tools/`

**Acceptance Criteria**:
- [ ] No raw console.log in tools
- [ ] All logs have structured context
- [ ] Existing functionality preserved
- [ ] Logs are grep-able by JSON keys

---

### 4.3 Add Performance Timing to ralph.sh

**Status**: `PENDING`
**Priority**: P2
**Effort**: Low
**Dependencies**: None

**Specification**:
- Track loop duration
- Track task completion time
- Write metrics to JSONL file
- Alert on slow loops (> 5 minutes)

**Files to Modify**:
- `local-agent/lib/agent/ralph.sh`

**Implementation**:
```bash
METRICS_FILE="$SCRIPT_DIR/logs/metrics.jsonl"

log_metrics() {
    local loop_duration=$1
    local task_type=$2
    local article_count=$3

    echo "{\"ts\":\"$(date -Iseconds)\",\"duration_s\":$loop_duration,\"task\":\"$task_type\",\"articles\":$article_count}" >> "$METRICS_FILE"

    if (( loop_duration > 300 )); then
        log_warn "Loop took ${loop_duration}s (> 5 min threshold)"
    fi
}
```

**Acceptance Criteria**:
- [ ] Metrics written to JSONL file
- [ ] Duration tracked per loop
- [ ] Alert logged for slow loops
- [ ] File rotates or limits size

---

### 4.4 Add Dashboard WebSocket Support

**Status**: `PENDING`
**Priority**: P3
**Effort**: High
**Dependencies**: None

**Specification**:
- Replace polling with WebSocket updates
- Real-time worker status
- Push notifications for new articles
- Maintain backward compatibility

**Files to Modify**:
- `local-agent/lib/dashboard/server.js`
- `local-agent/lib/dashboard/index.html`

**Implementation Notes**:
- Use `ws` npm package
- Broadcast status changes to all connected clients
- Graceful degradation if WebSocket unavailable

**Acceptance Criteria**:
- [ ] Dashboard updates in real-time
- [ ] No polling required
- [ ] Works with multiple browser tabs
- [ ] Fallback to polling if WS fails

---

### 4.5 Add Error Rate Tracking

**Status**: `PENDING`
**Priority**: P2
**Effort**: Medium
**Dependencies**: 4.1

**Specification**:
- Track error count per tool
- Track error rate over time windows
- Alert on high error rates
- Store in database for analysis

**Files to Create**:
- `local-agent/lib/mcp/src/utils/error-tracker.ts`

**Files to Modify**:
- `local-agent/lib/mcp/src/db/schema.ts` (add errors table)

**Acceptance Criteria**:
- [ ] Errors logged to database
- [ ] Error rates calculable
- [ ] Alert threshold configurable
- [ ] Dashboard shows error metrics

---

## Phase 5: Performance Optimization

> Prepare for scale to 1K+ articles.

### 5.1 Implement In-Memory Link Cache

**Status**: `PENDING`
**Priority**: P2
**Effort**: Medium
**Dependencies**: None

**Specification**:
- Cache article existence checks in memory
- Cache link graph for orphan detection
- Invalidate on article creation
- TTL of 60 seconds

**Files to Create**:
- `local-agent/lib/mcp/src/cache/link-cache.ts`

**Implementation**:
```typescript
interface LinkCache {
  articles: Set<string>
  incomingLinks: Map<string, string[]>
  outgoingLinks: Map<string, string[]>
  lastUpdated: number
}

let cache: LinkCache | null = null
const TTL_MS = 60000

export function getOrBuildCache(db: Database): LinkCache {
  if (cache && (Date.now() - cache.lastUpdated) < TTL_MS) {
    return cache
  }
  return rebuildCache(db)
}

export function invalidateCache() {
  cache = null
}
```

**Acceptance Criteria**:
- [ ] Cache reduces database queries
- [ ] Cache invalidates on write
- [ ] TTL prevents stale data
- [ ] Performance measurably improved

---

### 5.2 Add Query Result Pagination

**Status**: `PENDING`
**Priority**: P2
**Effort**: Low
**Dependencies**: None

**Specification**:
- Add LIMIT to GROUP_CONCAT operations
- Paginate large result sets
- Default page size of 100
- Prevent memory issues

**Files to Modify**:
- `local-agent/lib/mcp/src/db/database.ts`

**Acceptance Criteria**:
- [ ] GROUP_CONCAT has explicit LIMIT
- [ ] Large queries paginated
- [ ] Memory usage bounded
- [ ] API supports offset/limit

---

### 5.3 Optimize Orphan Detection Query

**Status**: `PENDING`
**Priority**: P2
**Effort**: Low
**Dependencies**: None

**Specification**:
- Ensure orphan detection uses index
- Add composite index if needed
- Verify query plan is optimal

**Files to Modify**:
- `local-agent/lib/mcp/src/db/schema.ts`

**SQL to Add**:
```sql
CREATE INDEX IF NOT EXISTS idx_links_target_source
ON links(target, source);
```

**Acceptance Criteria**:
- [ ] Query uses index (verify with EXPLAIN)
- [ ] Orphan detection < 100ms for 1K articles
- [ ] No full table scans

---

### 5.4 Add Database Connection Pooling

**Status**: `PENDING`
**Priority**: P3
**Effort**: Medium
**Dependencies**: None

**Specification**:
- Implement connection pool for SQLite
- Prevent connection exhaustion
- Handle concurrent access gracefully
- Configure pool size via environment

**Files to Modify**:
- `local-agent/lib/mcp/src/db/database.ts`

**Acceptance Criteria**:
- [ ] Pool manages connections
- [ ] Concurrent requests handled
- [ ] No connection leaks
- [ ] Pool size configurable

---

### 5.5 Implement File Watcher for Cache Invalidation

**Status**: `PENDING`
**Priority**: P3
**Effort**: Medium
**Dependencies**: 5.1

**Specification**:
- Watch wiki-content/wiki/ for changes
- Invalidate cache on file add/change/delete
- Use chokidar for cross-platform support

**Files to Create**:
- `local-agent/lib/mcp/src/cache/watcher.ts`

**Acceptance Criteria**:
- [ ] File changes trigger cache invalidation
- [ ] Watcher handles rapid changes (debounce)
- [ ] Works across platforms
- [ ] Minimal CPU overhead

---

## Phase 6: Documentation & Polish

### 6.1 Update README with New Features

**Status**: `PENDING`
**Priority**: P2
**Effort**: Low
**Dependencies**: 3.3, 3.4, 3.5

**Specification**:
- Document new CLI flags
- Add troubleshooting section
- Update command examples
- Add contribution guidelines

**Files to Modify**:
- `README.md`

**Acceptance Criteria**:
- [ ] All CLI flags documented
- [ ] Examples are accurate
- [ ] Troubleshooting covers common issues
- [ ] Setup instructions complete

---

### 6.2 Add CONTRIBUTING.md for the Project

**Status**: `PENDING`
**Priority**: P3
**Effort**: Low
**Dependencies**: None

**Specification**:
- Document development workflow
- Explain testing requirements
- Describe PR process
- List code style guidelines

**Files to Create**:
- `CONTRIBUTING.md` (project root, different from agent's CONTRIBUTING.md)

**Acceptance Criteria**:
- [ ] Development setup documented
- [ ] Testing requirements clear
- [ ] PR checklist included
- [ ] Code style documented

---

### 6.3 Add Architecture Diagram

**Status**: `PENDING`
**Priority**: P3
**Effort**: Low
**Dependencies**: None

**Specification**:
- Create ASCII or Mermaid diagram
- Show component relationships
- Include data flow
- Add to README or separate doc

**Files to Modify**:
- `README.md` or create `docs/ARCHITECTURE.md`

**Acceptance Criteria**:
- [ ] Diagram shows all components
- [ ] Data flow is clear
- [ ] Renders in GitHub markdown
- [ ] Accurate to current state

---

### 6.4 Document Database Schema

**Status**: `PENDING`
**Priority**: P3
**Effort**: Low
**Dependencies**: None

**Specification**:
- Document all tables and columns
- Explain relationships
- Note indexes and constraints
- Add to docs/

**Files to Create**:
- `local-agent/docs/DATABASE.md`

**Acceptance Criteria**:
- [ ] All tables documented
- [ ] Relationships explained
- [ ] Index strategy documented
- [ ] Migration notes included

---

## Dependency Graph

```
Phase 1 (Testing) ─────────────────────────────────────────────────────────────
    │
    ├── 1.1 Add Vitest ────┬── 1.2 Tests: next-task
    │                      ├── 1.3 Tests: create-article
    │                      ├── 1.4 Tests: edit-article
    │                      ├── 1.5 Tests: discover
    │                      ├── 1.6 Tests: git-publish
    │                      └── 1.8 GitHub Actions CI
    │
    └── 1.7 Integration Tests (needs 1.2, 1.3)

Phase 2 (Error Handling) ──────────────────────────────────────────────────────
    │
    ├── 2.1 Fix DB errors (needs 1.3)
    ├── 2.2 Git retry (needs 1.6)
    ├── 2.3 HTML validation (needs 1.4)
    ├── 2.4 Fix race condition (needs 1.2)
    └── 2.5 Zod schemas (independent)

Phase 3 (DX) ──────────────────────────────────────────────────────────────────
    │
    ├── 3.1 .env.example (independent)
    ├── 3.2 Load .env (needs 3.1)
    ├── 3.3 --dry-run (independent)
    ├── 3.4 --health-check (independent)
    ├── 3.5 --single (independent)
    ├── 3.6 setup.sh (independent)
    ├── 3.7 MCP CLI (independent)
    └── 3.8 NPM scripts (independent)

Phase 4 (Observability) ───────────────────────────────────────────────────────
    │
    ├── 4.1 Logger module (independent)
    ├── 4.2 Replace console (needs 4.1)
    ├── 4.3 Performance timing (independent)
    ├── 4.4 WebSocket dashboard (independent)
    └── 4.5 Error tracking (needs 4.1)

Phase 5 (Performance) ─────────────────────────────────────────────────────────
    │
    ├── 5.1 Link cache (independent)
    ├── 5.2 Pagination (independent)
    ├── 5.3 Optimize orphan query (independent)
    ├── 5.4 Connection pooling (independent)
    └── 5.5 File watcher (needs 5.1)

Phase 6 (Documentation) ───────────────────────────────────────────────────────
    │
    ├── 6.1 Update README (needs 3.3, 3.4, 3.5)
    ├── 6.2 CONTRIBUTING.md (independent)
    ├── 6.3 Architecture diagram (independent)
    └── 6.4 Database schema docs (independent)
```

---

## Quick Reference: High Priority Tasks

| ID | Task | Phase | Status |
|----|------|-------|--------|
| 1.1 | Add Vitest | Testing | `PENDING` |
| 1.2 | Tests: wiki-next-task | Testing | `PENDING` |
| 1.3 | Tests: wiki-create-article | Testing | `PENDING` |
| 2.1 | Fix silent DB errors | Error Handling | `PENDING` |
| 2.2 | Git push retry | Error Handling | `PENDING` |
| 3.1 | .env.example | DX | `PENDING` |
| 3.2 | Load .env in ralph.sh | DX | `PENDING` |
| 3.3 | --dry-run flag | DX | `PENDING` |
| 4.1 | Structured logging | Observability | `PENDING` |

---

## Agent Execution Notes

When picking up tasks from this roadmap:

1. **Check dependencies first** - Don't start a task if its dependencies aren't `DONE`
2. **Update status** - Mark task as `IN_PROGRESS` when starting
3. **Run tests** - If tests exist, run them before and after changes
4. **Mark complete** - Only mark `DONE` when acceptance criteria met
5. **Update this file** - Increment completed count in header

**Recommended execution order for maximum parallelism**:
- Start with: 1.1, 3.1, 3.3, 3.4, 3.5, 3.6, 4.1, 4.3
- These have no dependencies and can run in parallel
