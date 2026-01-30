# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Not-Wikipedia is an autonomous article generation system that creates a fictional encyclopedia. The system uses Claude Code agents (orchestrated by `ralph.sh`) to generate Wikipedia-style HTML articles driven by human seed passages (literary quotes).

**Live site**: https://not-wikipedia.org

## Repository Structure

```
not-wikipedia-project/
├── local-agent/                    # Orchestration and tooling
│   └── lib/
│       ├── agent/
│       │   ├── ralph.sh            # Main orchestration script (parallel workers)
│       │   ├── PROMPT.md           # Auto-generated per task
│       │   └── CONTRIBUTING.md     # Article template reference
│       ├── mcp/                    # MCP tools (TypeScript)
│       │   └── src/tools/          # All wiki-* tools
│       ├── meta/                   # SQLite database (ralph.db)
│       └── dashboard/              # Local browsing UI
└── wiki-content/                   # Content repo (deploys to Vercel)
    ├── wiki/*.html                 # Article HTML files
    ├── api/search-index.json       # Pre-built search index
    ├── fragments/                  # Article preview fragments
    └── categories/                 # Category pages
```

## Development Commands

### From Project Root (Recommended)
```bash
npm run ralph                       # Run agent loop (3 workers, 100 loops each)
npm run build                       # Build MCP tools
npm run publish                     # Manual git commit/push to wiki-content
npm run health                      # Check ecosystem health
```

### Running the Agent Loop (with options)
```bash
cd local-agent/lib/agent
./ralph.sh                          # Run with defaults
PARALLEL_WORKERS=5 ./ralph.sh       # Override worker count
AUTO_PUBLISH=false ./ralph.sh       # Disable auto git push
USE_LIVE_CRAWL=true ./ralph.sh      # Use live 404 detection
```

### Building MCP Tools
```bash
cd local-agent/lib/mcp
npm run build                       # Compile TypeScript
npm run dev                         # Build and run server
```

### Running Individual MCP Tools
```bash
cd local-agent/lib/agent
node -e "require('../mcp/dist/tools/wiki-next-task.js').tool.handler({}).then(r=>console.log(r.content[0].text))"
node -e "require('../mcp/dist/tools/wiki-ecosystem.js').tool.handler({}).then(r=>console.log(r.content[0].text))"
node -e "require('../mcp/dist/tools/wiki-build-index.js').tool.handler({}).then(r=>console.log(r.content[0].text))"
```

## Architecture

### Agent Flow (ralph.sh)
1. **Fetch task** via `wiki_next_task` MCP tool (returns human seed + task type)
2. **Generate PROMPT.md** with seed quote and MCP tool example
3. **Run Claude** with `--allowedTools "Bash"` only (no file reading)
4. **Agent calls MCP tools** via node one-liners to create articles
5. **Post-process**: run `wiki_discover` (queue broken links), `wiki_git_publish`

### Key Design Principle
The agent receives **minimal context** to maximize creative variance:
- Human seed passage (the sole creative input)
- Task type and target path
- MCP tool invocation example
- **NO existing articles, interpretation hints, or writing guidance**

### MCP Tools (local-agent/lib/mcp/src/tools/)

| Tool | Purpose |
|------|---------|
| `wiki_next_task` | Get next task (create_new, repair_broken_link, etc.) |
| `wiki_create_article` | Create article with proper HTML structure |
| `wiki_edit_article` | Modify existing articles |
| `wiki_add_link` | Cross-reference articles |
| `wiki_get_article` | Parse article metadata |
| `wiki_discover` | Queue broken links for future generation |
| `wiki_git_publish` | Commit and push to wiki-content |
| `wiki_build_index` | Regenerate search index and fragments |
| `wiki_crawl_404s` | Find broken links on live site via HTTP |
| `wiki_human_seed` | Get random human seed passage |

### Database Schema (local-agent/lib/meta/ralph.db)
- `articles` - Article metadata (filename, title, category, link counts)
- `researchers` - Fictional researcher entities
- `links` - Article cross-references
- `discovery_queue` - Content Fractal: queued concepts for generation

### Task Types (Priority Order)
1. `create_from_live_404` - Fix 404s on live site
2. `repair_broken_link` - Create referenced but missing pages
3. `resolve_placeholder` - Replace NEXT_PAGE_PLACEHOLDER markers
4. `fix_orphan` - Add incoming links to isolated articles
5. `create_new` - Generate new content from human seed

## Adding New MCP Tools

1. Create `src/tools/my-tool.ts` with exported `tool` object
2. Add import to `src/tools/index.ts`
3. Add to `toolModules` array
4. Rebuild: `npm run build`

Tool structure:
```typescript
export const tool: ToolModule = {
  definition: {
    name: "my_tool",
    description: "What it does",
    inputSchema: { type: "object", properties: {...} }
  },
  handler: async (args) => ({
    content: [{ type: "text", text: "result" }]
  })
};
```
