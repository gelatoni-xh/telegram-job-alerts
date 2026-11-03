# Remote Job Radar

An English-language Telegram bot for discovering remote roles and receiving a daily digest matched to your preferences. Listings come from [Jobicy](https://jobicy.com/jobs-rss-feed), and every application link points to the original listing.

[Open the bot](https://t.me/GelatoniJobRadarBot) · [Operations guide](docs/operations.md) · [Data source and matching](docs/source.md)

## What it does

- Browse remote roles by keyword, category, and location.
- Save subscription preferences and receive a daily digest.
- Deduplicate listings and retain delivery state so digests remain useful and consistent.
- Link back to Jobicy for the full listing and application details.

## Built with

TypeScript · Node.js 24 · grammY · Fastify · PostgreSQL 17 · Prisma

## Run locally

Use Node.js 24 and pnpm 10.32.1. Copy `.env.example`, start the isolated PostgreSQL service in `infra/compose.local.yml`, then install dependencies and prepare the database:

```sh
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm typecheck
pnpm test
pnpm build
```

See the [operations guide](docs/operations.md) for configuration, deployment, backups, migrations, and shutdown. The repository does not currently declare an open-source license.
