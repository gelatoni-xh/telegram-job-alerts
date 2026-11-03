# Source and product limits

Source: [Jobicy API documentation](https://jobicy.com/jobs-rss-feed), checked 2026-11-04. Public API integration needs no key or separate approval for ordinary commercial use. Keep Jobicy attribution and original source links. Recheck terms before changing how data is used.

The public feed returns at most 100 jobs per page from the last seven days, with a three-hour publication delay. Follow the opaque cursor sequentially without changing filters; its lifetime is 24 hours from traversal start. Start no more than one automated traversal per hour. Disappearing from this window does not establish closure.

Stored job IDs are checked in batches of at most 100 using `/api/jobs/status`. Only explicit `closed` is confirmed closed; `unknown` is hidden and revisited. Routine status checks are hourly or less frequent per ID. HTTP 429 defers tasks using Retry-After. Upsert by source ID, not title.

All ISO countries and all stored category labels remain selectable. Any country bypasses the country group. Explicit country labels, worldwide labels, Europe and a small set of literal residency/exclusion patterns are supported. APAC/EMEA/LATAM and other ambiguous labels are retained as source text and are not expanded speculatively. This can miss eligible jobs; location matching is not a visa, tax or work-authorization determination. The original listing remains authoritative. Natural language restrictions are not exhaustively parsed.

Search matches OR within countries/categories, AND between groups; the optional phrase searches title/description literally, ignoring case. New subscriptions begin at the committed discovery boundary and do not send the existing inventory. Pausing/resuming or editing moves that boundary and revision. The user can still search existing jobs.

A user receives one digest per local date when there are new matches. DST gaps move to the first valid minute; overlaps use the first occurrence. Jobs matching several subscriptions appear once with multiple match explanations. Membership is stored in PostgreSQL; pages do not depend on a mutable search query. Outstanding unsent days combine into one recovery digest. Before sending, invalid subscription revisions and closed/unknown jobs are removed; unknown candidates are deferred.

Inbox updates and tasks are durable; network delivery can have an uncertain outcome. A lost send response may cause a duplicate when retried. No payment or advertising system is included in this MVP.
