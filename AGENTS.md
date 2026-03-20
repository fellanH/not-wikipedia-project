# not-wikipedia-project

Autonomous fictional encyclopedia generator. Produces Wikipedia-style articles about things that don't exist, deployed live at [not-wikipedia.org](https://not-wikipedia.org).

## Stack

| Layer | Technology |
|-------|-----------|
| Agent orchestration | Bash (ralph.sh), Node.js (gemma-loop.js) |
| MCP tools | TypeScript (compiled to JS), SQLite |
| Content | Static HTML, CSS, HTMX |
| Hosting | Vercel (auto-deploy from GitHub) |
| AI | Claude Code CLI (ralph), Ollama/Gemma 3 4B (gemma) |

## Commands

```bash
# Agent loops
npm run ralph              # Run Claude-powered agent (3 parallel workers)
npm run gemma              # Run local Gemma agent (free, ~46 articles/hr)
npm run gemma:one          # Single Gemma article for testing
npm run gemma:stats        # View Gemma performance stats
npm run gemma:logs         # List recent Gemma run logs
npm run gemma:log          # Detailed view of latest Gemma log

# Operations
npm run build              # Compile MCP tools (TypeScript -> JS)
npm run publish            # Manual git commit+push to wiki-content
npm run health             # Ecosystem health check

# Dashboard
npm run dashboard          # Agent monitoring dashboard
```

## Architecture

Three components, two git repos:

```
not-wikipedia-project/           (this repo)
  local-agent/lib/agent/         ralph.sh, gemma-loop.js
  local-agent/lib/mcp/           MCP tools (TypeScript)
  local-agent/lib/meta/          ralph.db (SQLite), stats
  wiki-content/                  (submodule, source of truth)
    wiki/*.html                  article files
    fragments/                   preview cards
    api/                         search index
    -> GitHub push -> Vercel auto-deploy (~5s)
```

## Conventions

- **Task tracking**: `tasks/arc.md` for current focus. Standard omni task conventions.
- **Non-deterministic generation**: Agents receive minimal context (human seed + task type only). No interpretation hints, vocabulary guidance, or thematic suggestions. Two agents given the same seed should produce completely different articles.
- **Content Fractal**: Each article's outlinks are discovered and queued as future tasks, creating recursive growth.
- **MCP tools as subprocess**: Both ralph and gemma call MCP tools via `node -e "require(...).tool.handler(...)"` in subprocesses. Tools must be compiled first (`npm run build`).

## Agent Reading Order

1. This file (identity, stack, commands)
2. `specs/PRD.md` (what we're building and why)
3. `specs/architecture.md` (how it works, key decisions)
4. `tasks/arc.md` (current focus)

## Context Vault

Scoped to `bucket:not-wikipedia-project`. Load at session start:

```
get_context(tags: ["not-wikipedia-project"])
```
