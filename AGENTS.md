# Development rules

- Node.js 24, TypeScript, pnpm. PostgreSQL 17; one process and one pool.
- Never commit credentials, real environment files, database dumps, or chat payloads.
- All user-facing messages are English. Keep source attribution and original Jobicy links.
- Preserve durable subscription boundaries, inbox deduplication, digest membership and delivery state.
- Run typecheck, tests against an isolated database, and build before publishing changes.
- Production migrations use a dedicated owner role; the application must not use a superuser.
- Never remove shared PostgreSQL containers, volumes or networks. No global Docker prune.
- Update public design and runbooks to describe final behavior; omit development history and private infrastructure values.
