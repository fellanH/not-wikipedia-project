# Not-Wikipedia PRD

## Problem Statement

Creating a large, internally consistent fictional encyclopedia by hand is prohibitively slow. LLMs can generate encyclopedia-style prose, but left unconstrained they produce repetitive, formulaic content. The challenge is building an autonomous system that generates diverse, high-quality fictional articles while maintaining ecosystem coherence (cross-references, categories, consistent visual style).

**For**: Anyone who wants a browsable fictional encyclopedia as art, entertainment, or AI demonstration.

## Functional Requirements

### Article Generation
- Agents autonomously generate fictional encyclopedia articles in Wikipedia's visual style
- Each article contains: title, infobox (colored header, key-value fields), warning box, prose sections, blockquote, see-also links, academic references, category footer
- Articles are static HTML files following a consistent template
- Content is entirely fictional: invented names, dates, places, researchers, phenomena

### Task System
- MCP tool (`wiki-next-task`) assigns work by priority: broken links (critical) > placeholders (high) > new content (low)
- Tasks are claimed atomically in SQLite to support parallel workers
- Stale claims auto-expire after 30 minutes

### Content Fractal (Recursive Discovery)
- After creating an article, `wiki-discover` scans its outlinks
- Missing link targets are queued as future tasks with depth tracking
- Each article spawns 2-5 new potential articles, creating exponential growth
- Depth limit (default: 3) prevents infinite recursion

### Non-Deterministic Generation
- Agents receive minimal context: human seed passage + task type + HTML template
- No interpretation hints, vocabulary guidance, or thematic suggestions
- Two agents given the same seed must produce completely different articles
- Voice context (Reddit, Mastodon, HN, RSS, Wikipedia) shapes register without steering content

### Search and Discovery
- Client-side search powered by pre-built JSON index
- Article preview on hover via HTMX fragments
- Category browsing pages
- Random article navigation
- Latest article featured on homepage

### Publishing Pipeline
- Articles committed to wiki-content repo via `wiki-git-publish`
- GitHub push triggers Vercel auto-deploy (~5 seconds to live)
- Live at not-wikipedia.org

## Data Model

### SQLite Database (ralph.db)

**articles**: filename, title, type, category, outlinks, inlinks, created, model, comparison_set
**discovery_queue**: target filename, source article, depth, priority, status
**task_claims**: task_type, filename, worker_id, claimed_at, completed_at

### File System

**wiki-content/wiki/*.html**: article HTML files (source of truth)
**wiki-content/fragments/*.html**: preview card HTML
**wiki-content/api/search-index.json**: search metadata
**wiki-content/api/articles.json**: full article list with summaries

## User Flows

### Autonomous Generation (Ralph)
1. ralph.sh spawns N parallel workers
2. Each worker: fetch task -> create isolation env -> write PROMPT.md -> run Claude -> copy results -> discover links -> publish
3. Repeat until stopped or max loops reached

### Autonomous Generation (Gemma)
1. gemma-loop.js runs single-threaded
2. Each loop: fetch task -> gather context -> build prompt -> call Ollama -> parse structured output -> create article via MCP -> discover -> publish
3. Skips orphan tasks (all articles reachable via index)
4. Stats and per-loop logs written to disk

### Manual Browsing
1. User visits not-wikipedia.org
2. Homepage shows latest article above the fold
3. Search, random, category browsing available
4. Article hover shows preview fragment

## Success Criteria

- 100+ articles generated and published without manual intervention
- Zero broken links on the live site (discovery queue at 0)
- Search index returns results for any article title
- Articles are visually consistent with Wikipedia's style
- Vercel auto-deploys within 10 seconds of git push
- Gemma agent: >90% parse success rate, >40 articles/hour throughput

## Out of Scope

- User-generated content or editing
- Authentication or user accounts
- Server-side rendering or dynamic content
- Real encyclopedia content (everything is fictional)
- Mobile app
- Multi-language support
- Comment system or social features
