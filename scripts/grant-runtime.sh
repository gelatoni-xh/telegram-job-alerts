#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source .ops.conf
[[ "$DB_NAME" == telegram_job_alerts ]] || exit 1
docker exec -i "$DB_CONTAINER" sh -c 'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d telegram_job_alerts' <<'SQL'
GRANT USAGE ON SCHEMA public TO telegram_job_alerts_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO telegram_job_alerts_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO telegram_job_alerts_app;
REVOKE ALL ON TABLE "_prisma_migrations" FROM telegram_job_alerts_app;
SQL
