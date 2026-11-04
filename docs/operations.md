# Operations

## Boundaries and configuration

This project runs one Node.js 24 process, using grammY, Fastify, Prisma and PostgreSQL 17. It has an independent database (`telegram_job_alerts`), migration owner and runtime role. Reusing an existing PostgreSQL container also creates a lifecycle dependency: keep that container, its network and volume running when retiring the original application. Migration to a dedicated PostgreSQL server uses a logical dump of this database only.

Keep deployment files in a dedicated directory. Examples use `/opt/apps/telegram-job-alerts`; this is a project convention. Never put production environment values, Telegram updates, dumps, deletion journals or SSH keys in Git. `APP_IMAGE` is the full commit SHA tag. Runtime modes default to false.

Files outside Git:

- `.env.production`: runtime DB URL, expected DB, bot token, webhook secret, feature modes.
- `.env.migration`: owner DB URL, expected DB; no runtime superuser.
- `.ops.conf`: `DB_CONTAINER` and `DB_NAME=telegram_job_alerts` addressing only.
- `release.env`: `APP_IMAGE=telegram-job-alerts:<40-character-sha>`.
- `state/deletions.jsonl`: restore suppression records, chmod 600, private directory.

## Local setup and checks

1. Install Node 24 and pnpm 10.32.1.
2. Run `pnpm install --frozen-lockfile` and `pnpm db:generate`.
3. Start the isolated database: `docker compose -f infra/compose.local.yml up -d`.
4. Set `DATABASE_URL` and `TEST_DATABASE_URL` to the local database ending in `_test` (see `infra/compose.local.yml`). Set `EXPECTED_DATABASE=telegram_job_alerts_test` for CLI/app execution.
5. Run `pnpm db:migrate`, then `pnpm typecheck`, `pnpm test`, `pnpm build`.
6. Copy `.env.example` to `.env` and fill local values. `pnpm dev` reads it. Production uses Compose environment files instead.
7. Tests require an isolated `_test` database and truncate its application tables. Never use a production connection for tests.
8. `docker build -t telegram-job-alerts:local .` verifies the production packaging. CI performs the same build on Linux.

## First server setup

1. Inspect available RAM, disk, existing containers, PostgreSQL version, networks, available loopback ports and existing Nginx routes. Do not restart shared infrastructure for setup.
2. Create the project directory and subdirectories `state`, `backups`, `releases`, `scripts`, `infra`. Restrict the parent and backups to the deploy user. `state` must be writable by image UID 1000.
3. As the existing database administrator, create `telegram_job_alerts_owner` and `telegram_job_alerts_app`, both LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, connection limit 5. Generate independent passwords and store only in protected configuration.
4. Create database `telegram_job_alerts` owned by the owner role. Revoke PUBLIC privileges on this new database and its public schema. Grant runtime CONNECT and schema USAGE; schema ownership stays with owner.
5. Set default privileges **for the owner role** to grant runtime table SELECT/INSERT/UPDATE/DELETE and sequence USAGE/SELECT. After migration run `scripts/grant-runtime.sh` to grant existing objects and revoke runtime access to `_prisma_migrations`.
6. Create `.env.production` and `.env.migration`, chmod 600. Set all three modes false initially. Set the expected database exactly. Database hostname is the stable service alias on the shared Docker network; no public database port is necessary.
7. Create `.ops.conf` with database addressing only. Copy `infra/compose.yml` to server `compose.yml`; the external network is configurable with `DATABASE_NETWORK` in release environment.
8. Build images in CI, rather than on the small server. The GitHub deployment workflow is disabled until repository variable `DEPLOY_ENABLED=true`.
9. Configure the GitHub `production` environment and deployment secrets `UBUNTU3_HOST`, `UBUNTU3_USER`, `UBUNTU3_SSH_KEY`, `UBUNTU3_KNOWN_HOSTS`. Use an independently revocable deployment key and an already verified host key.
10. First release uploads image and deployment scripts to `releases/<sha>`. Verify SHA256, load the image, run `scripts/deploy.sh <sha>`.
11. Deployment backs up even an empty database, checks database identity, deploys migrations, grants runtime privileges and starts the app. Poll readiness; on failure inspect project logs. Database migrations are never automatically reversed.
12. Verify runtime can read/write application tables but cannot create tables, access `_prisma_migrations`, or impersonate the owner.
13. With scheduling disabled, run `docker compose --env-file release.env run --rm --no-deps app node dist/src/cli.js sync`. Wait for a complete baseline traversal before accepting subscriptions.
14. Add only the exact HTTPS webhook location from `infra/nginx.conf.example` to the selected domain's TLS server block. Back up the site config, run `sudo nginx -t`, then reload. No public health/debug endpoint is needed.
15. Confirm public POST with an invalid secret returns 403, and existing sites remain healthy. Nginx must preserve `X-Telegram-Bot-Api-Secret-Token`; Cloudflare must not issue an interactive challenge on this path.
16. Set all three modes true, recreate only the project app. Set the webhook with `node dist/src/cli.js webhook` inside the app. Pending Telegram updates are preserved.
17. Use `/start` in the bot to verify real search, subscription, timezone/time, pause/resume and deletion. Verify a scheduled digest on a controlled subscriber separately from simulated send tests.
18. Check container RSS, OOM status, restarts, DB connections and existing applications during a complete source sync and interaction cycle. The app has a 192 MiB limit, 96 MiB V8 heap and 0.5 CPU cap; Prisma migration has its own 192 MiB limit.

## Normal releases and failures

The workflow checks isolated PostgreSQL tests and a Docker build, then transfers an image archive over SSH. It does not store production bot or database credentials in GitHub. It checks archive integrity and deploys the exact commit tag. Server `flock` and GitHub deployment concurrency serialize releases. A database advisory lock allows only one active app instance; task leases are not a license to run multiple app replicas.

Run administrative commands in a temporary container with its own memory budget, using `run --rm --no-deps app`; each command also opens its own database pool, so run one at a time.

`docker compose --env-file release.env run --rm --no-deps app node dist/src/cli.js doctor` reports sync freshness, oldest queued work, failed tasks, uncertain deliveries and connection counts. Logs redact URLs and credential patterns. Inspect failed work rather than assuming it was dropped.

Use `node dist/src/cli.js retry-failed <task-id>` for a reviewed failed task. Inspect uncertain delivery outcomes first: Telegram may have accepted a send whose response was lost. Retrying can duplicate a message; there is no exactly-once guarantee across that external API.

Rollback code only when its schema remains compatible: stop app, replace `release.env` with `previous-release.env`, then recreate app and check readiness. Do not restore a stale DB merely to roll back code. Never run migration reset, seed production, or global Docker prune.

Only delete old image/archive resources bearing this project's name after confirming the current and previous image tags. Automatic global cleanup is deliberately absent.

## Backups and restoration

1. A daily server timer runs `scripts/backup.sh`. It uses PostgreSQL 17 `pg_dump --format=custom --no-owner` for this database only. Temporary output must be nonempty and readable by `pg_restore --list` before atomic publication.
2. Each dump has SHA256, a timestamp taken **before** the dump starts and a deletion-journal snapshot when available. Credentials are kept separately. Preserve the current image tag and migrations with deployment records.
3. An owner-machine pull task transfers backups and the newest live deletion journal to a protected directory outside the repository. See `scripts/pull-backups.py`. It validates checksums before allowing retention cleanup.
4. The owner-machine scheduler runs when the computer is awake and connected. If it is offline, server backups continue but off-host copies lag. Inspect `last-success.json` and its age before relying on off-host recovery. Daily logical backups normally mean up to approximately 24 hours of lost state after a server failure; prolonged missed runs can increase that.
5. Both copies retain 14 days after a verified pull. If transfer fails, server retention is postponed so the last recoverable copy is not deleted. Privacy text must account for delayed retention during a backup incident.
6. To rehearse: create a separate scratch database owned by the migration role, restore using `pg_restore --no-owner --no-acl` while assuming that owner, grant runtime access scoped to the scratch DB, and compare table counts, constraints and representative records. Remove only the scratch DB afterward.
7. For production restore, remove/pause the webhook without dropping updates, stop this app, restore to a fresh database, verify identity/schema and grant runtime privileges. Keep all consumers stopped while restoring.
8. Replay `node dist/src/cli.js replay-deletions <backup-start-ISO>` with the **latest** independent deletion journal before accepting traffic or enabling delivery. A journal snapshot contained in an old backup alone is insufficient.
9. Review sending/uncertain deliveries and task leases. A backup can omit sends that occurred later; external Telegram messages cannot be rolled back. Compare user/subscription/job counts and watermarks, then perform a controlled send before reopening scheduling.
10. Retain deletion journal entries while any older restorable backup exists. Journal identifiers are private operational data and must never be published. Cleanup can be performed after verifying all older backups have expired.

## Migration to a separate server

1. Prepare a PostgreSQL 17 instance, identical image and protected config on the new server. All modes remain false and webhook intake remains isolated.
2. Rehearse restoring a recent dump and test runtime permissions there.
3. Remove webhook while preserving pending updates, then stop the old app. Confirm no remaining project consumers/CLI writers.
4. Create a final dump and copy the latest deletion journal, verify checksums, restore into the new isolated database and replay deletion records.
5. Verify counts, discovery watermarks, subscription revisions, migrations, task states and pending digests. Update DB hostname, expected DB, deployment secrets, backup timers and off-host pull target.
6. Keep the same Telegram bot token and public webhook address where possible. Switch only its proxy/DNS target, enable the new app and re-register webhook. Do not run both instances against separate DB copies.
7. Check real receipt and controlled reminder delivery; review pending Telegram errors. Telegram retains pending updates for a limited period, so do not assume unbounded downtime is safe.
8. For rollback after new writes, stop new app and transfer the **new** state back before restarting old app. An unchanged old snapshot is no longer a valid rollback target.

## Independent shutdown

1. Disable GitHub deployment and remove webhook without dropping pending updates.
2. Stop this project's app, backup timer and owner-machine pull schedule. Verify it stays stopped.
3. Remove only this exact webhook Nginx location, validate and reload Nginx. Check other domains.
4. Make a final verified backup and record an explicit retention/deletion date. Revoke this project's CI SSH key.
5. Remove this project's container and optional tagged images/archives. Preserve shared PostgreSQL, its network and volume.
6. Database/role/backup destruction is irreversible and separate from stopping the service. Verify dependencies and retention before a later authorized deletion.

### Telegram command menu

After changing command descriptions, update Telegram’s command picker with an independent management container:

```sh
docker compose --env-file release.env run --rm --no-deps app node dist/src/cli.js commands
```

This updates menu metadata without sending messages to users.

## Private Telegram statistics

Set `ADMIN_TELEGRAM_ID` in the protected runtime environment to the owner's numeric Telegram user ID (not an `@username`). Leave it unset to disable `/stats`. This setting is an identity allowlist, not a password; no additional API secret or analytics service is needed. Keep the real value out of the repository and public documentation. Recreate the application after changing its environment, then run the `commands` management operation in a separate temporary container to add `/stats` to that owner's private-chat command menu. The public command menu remains unchanged. When changing owners, remove the old owner's chat-scoped commands with Telegram `deleteMyCommands`; authorization always follows the current runtime setting.

In the bot's private chat, `/stats` returns yesterday and the day before with absolute and percentage changes, today so far, seven complete days with daily trends and a comparison to the previous seven days, plus current registered users and users with enabled alerts. `/activity` shows instrumented product events by type for today so far and the last seven complete Shanghai days, split into all users, everyone except the administrator, and the administrator. It does not expose per-user or message-level records. These commands are read-only and preserve the current search. Both commands are private and administrator-only; other users receive a generic denial and group commands produce no report. Only Telegram is used to view reports; there is no HTTP statistics endpoint, external database connection, SSH collection job or public report endpoint.

New users are currently retained accounts grouped by registration date. Active users are distinct retained users with at least one completed private-chat inbox update, grouped by receipt time; interactions count those deduplicated updates, including messages/buttons and navigation. Unique update IDs exclude Telegram retries, and pending updates do not count. `/stats` excludes the configured administrator. `/activity` uses the existing event taxonomy (search, result views, job opens and subscription actions), includes administrator events, and splits them from other users. It is an instrumented event breakdown, not a count of every Telegram update. Automatic digests do not count as activity. Enabled-alert users must have at least one unpaused subscription and must not be globally paused or unreachable. Inbox IDs are retained for 30 days, enough for the displayed 14 complete days; events are retained for 90 days and deleting accounts removes their events. These are observed activity counts, not an uptime check or immutable lifetime totals. No per-user identifiers or message contents are returned.


### Daily profile and email integration via Telegram

Enable `STATS_EXPORT_ENABLED=true` to maintain one silent, protected, pinned message in the configured administrator private chat. The scheduler updates this message once per Shanghai calendar day, using a durable per-day task with retries. It publishes a versioned JSON aggregate snapshot for the previous day, fourteen complete daily rows, current account/alert totals and a deduplicated seven-day active count. It does not publish individual identifiers or messages. The message pointer persists in a non-runnable `stats-message` task record (`held` status), which ordinary completed-task cleanup does not remove. Failed pin retries reuse the saved message; a crash between sending and saving can leave an unpinned extra message. No users other than the administrator receive this export. Keep this export pinned; the consumer fails if another message replaces it.

The `gelatoni-xh` profile workflow uses repository Secrets `TELEGRAM_STATS_BOT_TOKEN` and `TELEGRAM_STATS_CHAT_ID` and calls only Telegram `getChat` to read the pinned snapshot. It must not use `getUpdates` (the production webhook remains active). It validates author, schema, dates, generation time and counts, then copies an explicit aggregate allowlist into public JSON, the English/Chinese READMEs and the daily email. It does not read server files or databases. A missing, stale or invalid snapshot fails the workflow before statistics are written; it never substitutes zero. Website analytics remain browser metrics from Cloudflare; bot data has its own seven-day period.

The export is updated after Shanghai midnight; the profile workflow normally reads it at 08:00 Shanghai. It reflects the generation-time snapshot; later account deletions or delayed inbox processing may revise a future snapshot. Disable the export setting to stop edits; remove the existing Telegram message and revoke the profile repository token secret when retiring the integration. `/stats` remains an on-demand private report.
