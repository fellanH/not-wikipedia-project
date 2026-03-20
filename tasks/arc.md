# Not-Wikipedia

Zero dead links. The encyclopedia grows outward from existing pages, filling in referenced topics before inventing new ones. New articles only link to pages that already exist. The graph stays fully connected at every commit.

## Decisions
- Homepage see-also is now dynamic (10 latest articles from api/articles.json)
- Latest article block removed from homepage
- Gemma loop priority: homepage dead links first, then broken links from DB, then new content
- New articles must only include see_also links to files that already exist in wiki/
- Enrichment pass (adding links to newly created pages in older articles) is a separate, lower-priority task type

## Blocked
- Nothing

## Notes
- ~130 articles published, 0 broken links in DB (but homepage has /wiki/* style 404 links)
- Homepage has ~8 dead links using `/wiki/Topic` format (not `wiki/topic.html`). These need to be converted to real articles or removed.
- RAM saturates at 99% when Ollama + Claude run simultaneously on 16GB machine
