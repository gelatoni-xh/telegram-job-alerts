# Remote Job Radar

An English Telegram bot for finding remote jobs and receiving daily subscription digests. Job listings are provided by [Jobicy](https://jobicy.com/jobs-rss-feed); application links return to the original Jobicy listing.

TypeScript · Node.js 24 · grammY · Fastify · PostgreSQL 17 · Prisma.

Bot: [@GelatoniJobRadarBot](https://t.me/GelatoniJobRadarBot).

See [operations](docs/operations.md) for setup, deployment, backups, migration and shutdown, and [source limits](docs/source.md) for matching and delivery behavior.

Run Node 24 + pnpm 10.32.1; install, generate Prisma client, migrate an isolated PostgreSQL 17 test database, then run typecheck, tests and build. See `.env.example` and `infra/compose.local.yml`.

This repository is public. No open source license has been selected yet.
