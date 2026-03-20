# Not-Wikipedia Architecture

## Stack

| Component | Technology | Notes |
|-----------|-----------|-------|
| Agent (expensive) | Bash + Claude Code CLI | ralph.sh, 3 parallel workers |
| Agent (free) | Node.js + Ollama (Gemma 3 4B) | gemma-loop.js, single-threaded |
| MCP tools | TypeScript (ESM, compiled to JS) | wiki-next-task, wiki-create-article, wiki-discover, wiki-git-publish, wiki-build-index |
| Database | SQLite (ralph.db) | Articles, discovery queue, task claims |
| Frontend | Static HTML + CSS + HTMX + vanilla JS | Wikipedia visual clone |
| Search | Pre-built JSON index, client-side | No server needed |
| Hosting | Vercel (static) | Auto-deploy from GitHub |
| Domain | not-wikipedia.org | Vercel custom domain |

## Directory Structure

```
not-wikipedia-project/
  AGENTS.md                          # Agent identity and commands
  workspace.yaml                     # Omni workspace manifest
  package.json                       # npm scripts (ralph, gemma, build, publish)
  ROADMAP.md                         # Task backlog (non-standard, replaces tasks/active/)
  specs/
    PRD.md                           # This document
    architecture.md                  # You are here
  tasks/
    arc.md                           # Current focus
  local-agent/
    lib/
      agent/
        ralph.sh                     # Claude agent orchestrator (bash)
        gemma-loop.js                # Gemma agent loop (node)
        CONTRIBUTING.md              # Article template for Claude
        PROMPT.md                    # Current task (auto-generated per loop)
        logs/                        # Per-loop JSON logs (gemma-*.json, run-*.json)
      mcp/
        src/tools/                   # TypeScript source
        dist/tools/                  # Compiled JS (what agents call)
        dist/config.js               # Path resolution (cwd-sensitive)
        dist/db/database.js          # SQLite operations
      meta/
        ralph.db                     # SQLite database
        agent-status.json            # Dashboard status (ralph + gemma)
        gemma-stats.json             # Gemma aggregate stats
      dashboard/
        server.js                    # Agent monitoring UI
    docs/
      DEPLOYMENT.md                  # Deployment guide
  wiki-content/                      # Submodule (source of truth for content)
    index.html                       # Homepage with latest article + search
    styles.css                       # Wikipedia-clone stylesheet
    wiki.js                          # Client-side search, previews, latest article
    vercel.json                      # Vercel routing config
    wiki/*.html                      # Article files (~130 articles)
    fragments/*.html                 # Preview card HTML
    categories/*.html                # Category browse pages
    api/
      search-index.json              # Search metadata
      articles.json                  # Full article list
      random.json                    # Random article data
```

## Integrations

| External Service | Purpose | Connection |
|-----------------|---------|-----------|
| GitHub (fellanH/wiki-content) | Content repository, deployment trigger | git push |
| Vercel | Static hosting, auto-deploy | GitHub webhook |
| Ollama (localhost:11434) | Local LLM inference for gemma-loop | HTTP API |
| Anthropic API | Claude Code CLI for ralph.sh | CLI auth |
| Quotable API | Human seed quotes | HTTP (with fallback corpus) |
| Reddit/Mastodon/HN/RSS/Wikipedia | Voice context for register variety | HTTP (all optional, fallback to offline) |

## Constraints

- **Local-first**: ralph.db and all article files are local. No cloud database.
- **Static hosting**: No server-side rendering. Everything is pre-built HTML/JSON.
- **MCP path resolution**: config.js resolves paths from cwd. Tools must be called from `local-agent/lib/agent/` or `local-agent/lib/mcp/` for correct DB/wiki paths.
- **ESM + CJS bridge**: MCP tools are ESM (`"type": "module"` in mcp/package.json). Called via `require()` from CJS subprocesses, which works on Node 25+ natively.
- **Memory**: Gemma 3 4B via Ollama uses ~4GB VRAM/RAM. Running alongside Claude sessions saturates 16GB machines (99% RAM observed).

## Key Decisions

- **Subprocess tool calls over in-process imports**: Both ralph and gemma call MCP tools via `node -e "require(...).tool.handler(...)"` in child processes. This isolates each tool invocation (own DB connection, own cwd resolution) at the cost of ~200ms overhead per call. [2026-01]
- **Non-deterministic generation principle**: Agents receive only human seed + task type. No steering context. This maximizes article diversity but means some articles are lower quality. Accepted tradeoff. [2026-01]
- **wiki-content as source of truth**: Articles live in the content repo, not the orchestration repo. Ralph writes directly to wiki-content/wiki/. This allows Vercel auto-deploy via GitHub webhook. [2026-01]
- **SQLite for task coordination**: Task claims, discovery queue, and article registry in ralph.db. Supports atomic claiming for parallel workers. No external DB needed. [2026-01]
- **Gemma for bulk generation**: Claude ($$$) produces higher quality but costs money. Gemma 3 4B runs locally for free at ~46 articles/hour with 100% parse success after structured output format tuning. Used for bulk generation; Claude reserved for quality-sensitive work. [2026-03]
- **Orphan tasks skipped in gemma-loop**: All articles are reachable via the "All Articles" index page and homepage "Latest Article" section. Orphan detection counts only inter-article links, making orphans a misleading metric. Gemma skips them and goes straight to create_new. [2026-03]
- **Homepage latest article**: wiki.js fetches api/articles.json, sorts by created date, and displays the newest article's fragment card above the fold. Ensures every new article gets immediate visibility. [2026-03]
- **Adopted omni task conventions**: Migrated from custom ROADMAP.md system to standard `tasks/arc.md` + `specs/` structure. Roadmap system (ROADMAP.md, roadmap-agent.sh, roadmap-dashboard) removed. [2026-03]
