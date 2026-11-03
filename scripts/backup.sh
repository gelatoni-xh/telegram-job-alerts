#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
# This configuration contains addressing only, not DB passwords. Local container admin access is used.
source .ops.conf
[[ "$DB_NAME" == telegram_job_alerts ]] || { echo 'Unexpected database'; exit 1; }
mkdir -p backups
backup_stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_started=$(date -u +%FT%TZ)
backup_file="backups/$backup_stamp.dump"
backup_tmp=$(mktemp backups/.backup.XXXXXX)
trap 'rm -f "$backup_tmp"' EXIT
docker exec "$DB_CONTAINER" sh -c 'exec pg_dump -U "$POSTGRES_USER" --format=custom --no-owner --dbname=telegram_job_alerts' > "$backup_tmp"
test -s "$backup_tmp"
docker exec -i "$DB_CONTAINER" pg_restore --list < "$backup_tmp" >/dev/null
mv "$backup_tmp" "$backup_file"
sha256sum "$backup_file" > "$backup_file.sha256"
# Copy journal alongside the backup; off-host sync additionally copies the latest live journal.
if test -f state/deletions.jsonl; then cp state/deletions.jsonl "backups/$backup_stamp.deletions.jsonl"; fi
printf '{"database":"telegram_job_alerts","createdAt":"%s"}\n' "$backup_started" > "backups/$backup_stamp.json"
echo "Backup verified: $backup_file"
# Retention is applied by off-host pull only after successful transfer, never here.
