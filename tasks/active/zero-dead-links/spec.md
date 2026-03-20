# Zero Dead Links

The encyclopedia must have zero broken links at every commit. Articles grow the graph outward by filling in referenced pages, and new articles only link to existing pages.

## Status

- [x] Homepage: remove latest article block, make see-also dynamic
- [x] Fix homepage dead links: created 8 articles, converted all /wiki/Topic hrefs to wiki/topic.html
- [x] Validate see_also in wiki-create-article: filter out filenames that don't exist in wiki/
- [x] Update gemma-loop prompt: pass existing filenames list, instruct Gemma to only use them for SEE_ALSO
- [ ] Update wiki-next-task priority: homepage dead links > DB broken links > new content
- [ ] Add "enrichment" task type: scan older articles and add links to pages created since they were written

## Part 1: No new dead links (outgoing link validation)

**wiki-create-article.ts** currently writes see_also links blindly. Change it to:
1. Before generating the `<ul>` for See also, check each filename against the wiki/ directory
2. Only include links to files that actually exist
3. Log any filtered-out links so we can track what the agent wanted to link to

**gemma-loop.js** prompt update:
1. Pass a list of existing article filenames to Gemma as context
2. Tell Gemma: "Only use filenames from this list in your SEE_ALSO line. Do not invent new filenames."
3. This is a soft constraint (Gemma may still hallucinate filenames), so the hard filter in wiki-create-article is the safety net

## Part 2: Fix existing dead links

**Homepage (index.html)** has links using `/wiki/Topic` format (Wikipedia-style) that 404 on Vercel:
- `/wiki/Mockup`
- `/wiki/HTML`
- `/wiki/User:PromptEngineer`
- `/wiki/Digital_artifact`
- `/wiki/Wikipedia`
- `/wiki/Front-end_web_development`
- `/wiki/Cascading_Style_Sheets`
- `/wiki/Large_language_model`

Options per link:
- Create the article as `wiki/mockup.html` and fix the href
- Or remove the `<a>` tag and leave plain text (for meta-references like "Wikipedia" itself)

**wiki-next-task.ts** priority update:
- Add a new priority level above broken links: "homepage dead links"
- Scan index.html for hrefs pointing to non-existent files
- These get `priority: "critical"` and are filled first

## Part 3: Enrichment pass (future, lower priority)

A new task type `enrich_links` that:
1. Picks an older article
2. Scans its prose for concepts that now have their own pages
3. Adds `<a>` tags linking to those pages
4. This grows the internal link density over time without creating any new dead links

## Success criteria

- `npm run health` reports 0 broken links
- No article's see_also section contains links to non-existent files
- Homepage has zero 404 links
- The gemma loop can run indefinitely without introducing dead links
