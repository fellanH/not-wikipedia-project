# Not-Wikipedia

An autonomous Claude Code loop that builds a fictional encyclopedia — **Not-Wikipedia**.

**Live Site**: [not-wikipedia.vercel.app](https://not-wikipedia.vercel.app)

## What It Does

Ralph continuously runs Claude Code to generate and maintain a fictional Wikipedia-style encyclopedia. Each article mimics Wikipedia's visual style while containing entirely fabricated content.

The system:
- Fetches tasks via MCP tools (create articles, repair broken links, resolve placeholders, fix orphans)
- Injects human seed passages as the **sole creative driver**
- Runs Claude to create HTML articles following Wikipedia's aesthetic
- Validates ecosystem health (broken links, orphans, unresolved placeholders)
- **Auto-deploys** new articles to Vercel via GitHub
- Provides **HTMX-powered search** and article previews

---

## Meta Rules: Non-Deterministic Generation

> **Core Principle**: Maximum variance across agent iterations. The agent receives minimal context and must derive everything from the human seed alone.

### Agent Context (STRICT)

The agent receives ONLY:

| Input | Purpose |
|-------|---------|
| **Human seed** | The sole creative input — a passage, quote, or text |
| **Task type** | What action to take (`create_new`, `repair_broken_link`, etc.) |
| **Target path** | Where to write the file |
| **HTML template** | Structural skeleton only — no example content |
| **CSS reference** | Visual styling (colors, fonts, layout) |

**Nothing else.** No interpretation hints. No vocabulary guidance. No thematic suggestions.

### Forbidden in Context Files

These create deterministic patterns and MUST NOT appear:

| Forbidden | Why |
|-----------|-----|
| Interpretation instructions | "Derive the topic from..." steers inference |
| Vocabulary guidance | "Avoid these words..." or "Use varied..." biases output |
| Thematic hints | "Connection can be metaphorical..." primes specific modes |
| Category examples | Lists of topics constrain imagination |
| Numeric requirements | "3-6 sections" creates formulas |
| Writing style rules | "Read distinctly" is subjective instruction |

### Allowed in Context Files

| Allowed | Why |
|---------|-----|
| HTML skeleton | `<h1>`, `<table class="infobox">` — pure structure |
| CSS styling | Colors, fonts, layout — visual only |
| File conventions | `.html`, kebab-case — technical |
| Link validation | "Must point to existing files" — ecosystem integrity |
| Structural checklist | "Has infobox, has references" — binary checks |

### File Responsibilities

**PROMPT.md** — Generated per task, contains:
- Task type and priority
- Human seed (quoted, with attribution)
- Infobox color
- Link to CONTRIBUTING.md
- **NOTHING ELSE**

**CONTRIBUTING.md** — Static reference, contains:
- HTML template (empty structure)
- CSS specifications
- File naming rules
- Quality checklist (structural items only)
- **NO interpretation guidance**
- **NO writing style instructions**

**ralph.sh** — Orchestration, must:
- Generate minimal PROMPT.md
- NOT inject guidance text
- NOT add vocabulary reminders
- NOT explain how to interpret the seed

### Why This Matters

Two agents given the same human seed should produce **completely different** articles. If they produce similar content, the prompt is too deterministic.

The human seed is raw material. The agent's interpretation is unconstrained. The output is unpredictable.

```
Human Seed ─────► Agent (minimal context) ─────► Unique Article
                        │
                        └── No steering, no hints, no patterns
```

## Project Structure

```
not-wikipedia/                    # Orchestration repository
├── lib/
│   ├── agent/
│   │   ├── ralph.sh              # Main orchestration script
│   │   ├── PROMPT.md             # Current task (auto-generated)
│   │   ├── CONTRIBUTING.md       # Article template and guidelines
│   │   └── logs/                 # Run logs (JSON)
│   ├── mcp/                      # MCP tools (TypeScript)
│   │   └── src/tools/
│   │       ├── wiki-next-task.ts
│   │       ├── wiki-discover.ts
│   │       ├── wiki-git-publish.ts  # Git commit/push tool
│   │       ├── wiki-build-index.ts  # Search index generator
│   │       └── ...
│   └── meta/                     # Metadata (ralph.db)
└── docs/                         # Documentation

wiki-content/                     # Content repository (SOURCE OF TRUTH)
├── index.html                    # Homepage with search
├── styles.css
├── htmx.min.js                   # HTMX library
├── wiki.js                       # Client-side search & previews
├── api/search-index.json         # Pre-built search index
├── fragments/                    # Article preview fragments
├── categories/                   # Category pages
├── wiki/*.html                   # Article HTML files
└── vercel.json
    ↓
    GitHub → Vercel (auto-deploy on push)
```

## Auto-Deploy Architecture

The **wiki-content** repository is the source of truth. Ralph writes directly to it:

```
┌────────────────────────────────────────────────────────────────┐
│                     RALPH AGENT LOOP                            │
│  1. Fetch task (wiki-next-task)                                 │
│  2. Create article in isolation                                 │
│  3. Copy to wiki-content/wiki/                                  │
│  4. Run discovery (queue broken links)                          │
│  5. Commit and push (wiki-git-publish)                          │
└────────────────────────────────┬───────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────┐
│              wiki-content (GitHub)                              │
│              github.com/fellanH/wiki-content                    │
│              (SOURCE OF TRUTH)                                  │
└────────────────────────────────┬───────────────────────────────┘
                                 │
                          (webhook on push)
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────┐
│                    Vercel (auto-deploy)                         │
│              not-wikipedia.vercel.app                           │
└────────────────────────────────────────────────────────────────┘
```

Every article created by Ralph is automatically:
1. Committed to the content repository
2. Pushed to GitHub
3. Deployed to Vercel (~5 seconds)

## Website Features

The live site includes HTMX-powered interactivity:

| Feature | Description |
|---------|-------------|
| **Instant Search** | Client-side search with pre-built index |
| **Article Previews** | Hover over links to see article summaries |
| **Categories** | Browse articles by category |
| **Random Article** | Discover random entries |

### Building the Search Index

The search index and fragments are pre-generated:

```bash
cd lib/mcp && node -e "
const { tool } = require('./dist/tools/wiki-build-index.js');
tool.handler({}).then(r => console.log(r.content[0].text));
"
```

## Usage

```bash
cd lib/agent
./ralph.sh
```

The script runs indefinitely (or until `MAX_LOOPS_PER_WORKER` is reached), creating one article per loop. Press `Ctrl+C` to stop gracefully.

### Configuration

Edit variables at the top of `ralph.sh`:

| Variable | Default | Description |
|----------|---------|-------------|
| `PARALLEL_WORKERS` | 3 | Number of parallel agent workers |
| `MAX_LOOPS_PER_WORKER` | 100 | Maximum iterations per worker (0 = unlimited) |
| `MAX_LOGS` | 100 | Log files to keep |
| `MAX_DISCOVERY_DEPTH` | 3 | Maximum recursion depth for Content Fractal |
| `HEALTH_CHECK_INTERVAL` | 10 | Full health check every N total loops |
| `AUTO_PUBLISH` | true | Auto-publish to content repo after article creation |
| `VERCEL_DEPLOY` | false | Trigger manual Vercel deploy (not needed with GitHub auto-deploy) |

### Environment Variables

```bash
# Override defaults via environment
PARALLEL_WORKERS=5 AUTO_PUBLISH=true ./ralph.sh
```

## Task Types

| Task | Description |
|------|-------------|
| `create_new` | Create new content from a human seed passage |
| `repair_broken_link` | Create missing article that other pages link to |
| `resolve_placeholder` | Replace `NEXT_PAGE_PLACEHOLDER` with real links |
| `fix_orphan` | Add incoming links to isolated articles |

## Requirements

- [Claude Code CLI](https://github.com/anthropics/claude-code)
- Node.js (for MCP tools)
- Bash

## How It Works

1. **Coordinator Starts** — Spawns N parallel worker processes
2. **Worker Fetches Task** — Gets next task from MCP tool (prioritizes broken links → placeholders → orphans → new content)
3. **Setup Isolation** — Creates temporary workspace with symlinks to existing articles
4. **Generate Prompt** — Writes task details to `PROMPT.md`
5. **Run Claude** — Executes `claude -p` in isolated environment
6. **Teardown** — Copies new articles back to `wiki-content/wiki/`
7. **Discovery** — Scans new article for broken links, queues them for future generation
8. **Auto-Publish** — Commits and pushes to content repo → triggers Vercel deploy
9. **Repeat**

---

## Recursive Discovery (Content Fractal)

Ralph uses **Recursive Discovery** to transform from a reactive system (fixing broken links one at a time) into an **explosive growth engine** (each article spawns multiple new concepts).

### How It Works

```
Article A is created
       ↓
Discovery scans A, finds links to [B, C, D]
       ↓
B, C, D are queued at depth 1
       ↓
Article B is created (from queue)
       ↓
Discovery scans B, finds links to [E, F]
       ↓
E, F are queued at depth 2
       ↓
... continues until max depth reached
```

### Priority System

The discovery queue uses intelligent prioritization:

| Factor | Effect |
|--------|--------|
| Lower depth | Higher priority (closer to root concepts) |
| Multiple references | Higher priority (more demanded) |
| Queue order | FIFO within same priority |

### Configuration

Edit `ralph.sh` to adjust:

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_DISCOVERY_DEPTH` | 3 | Maximum recursion layers |

### Relevance Filtering

To prevent topic drift (e.g., starting at "Linguistics" and ending at "Quantum Mechanics"), the discovery tool supports optional filters:

```javascript
// Example: Stay focused on linguistics topics
{
  relevance_filter: {
    required_keywords: ["linguistic", "language", "semantic"],
    excluded_keywords: ["quantum", "physics"],
    min_filename_length: 8
  }
}
```

### Safeguards

- **Depth Limit**: Prevents infinite recursion (default: 3 layers)
- **Duplicate Detection**: Already-queued concepts are skipped
- **Article Existence Check**: Existing articles are not re-queued
- **Priority Decay**: Deeper concepts have lower priority

Each generated article includes:
- Wikipedia-style warning box (unique per article)
- Infobox with themed color
- Content sections
- Internal links to other Not-Wikipedia articles
- Academic-style references
- Category footer

## Manual Publishing

To manually commit and push changes to the content repo:

```bash
cd lib/mcp

# Commit and push all changes
node -e "require('./dist/tools/wiki-git-publish.js').tool.handler({}).then(r=>console.log(r.content[0].text))"

# Commit without pushing (local commit only)
node -e "require('./dist/tools/wiki-git-publish.js').tool.handler({push:false}).then(r=>console.log(r.content[0].text))"

# Commit with custom message
node -e "require('./dist/tools/wiki-git-publish.js').tool.handler({commit_message:'Add new article'}).then(r=>console.log(r.content[0].text))"
```

### Check Deployment Status

```bash
cd ../wiki-content && vercel ls
```

## Dashboard

Open `dashboard/index.html` in a browser to browse the encyclopedia with search and filtering.

## License

This project generates fictional content. All "facts" in Not-Wikipedia are fabricated.
