#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
exec 9>.deploy.lock
flock -n 9 || { echo 'Another deployment is active'; exit 1; }
release_sha=${1:?Provide full commit SHA}
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid commit SHA'; exit 1; }
test -f .env.production && test -f .env.migration
new_image="telegram-job-alerts:$release_sha"
docker image inspect "$new_image" >/dev/null
previous_image=""
if test -f release.env; then cp release.env previous-release.env; fi
if test -f previous-release.env; then
  previous_image=$(sed -n 's/^APP_IMAGE=//p' previous-release.env | head -n 1)
fi
# Every deployment backs up its own database before migration. No seed or reset.
./scripts/backup.sh
printf 'APP_IMAGE=%s\n' "$new_image" > next-release.env
# Identity is checked using the migration config before prisma runs.
docker compose --env-file next-release.env run --rm --no-deps migrate node dist/src/cli.js identity >/dev/null
docker compose --env-file next-release.env run --rm --no-deps migrate
# Default object grants are set by bootstrap; migration-table writes stay owner-only.
./scripts/grant-runtime.sh
mv next-release.env release.env
docker compose --env-file release.env up -d --no-deps app
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3050/readyz >/dev/null; then
    echo "Deployment healthy: $release_sha"
    break
  fi
  sleep 2
done

if ! curl -fsS http://127.0.0.1:3050/readyz >/dev/null; then
  echo 'Readiness failed. Inspect project logs; do not reverse database migrations automatically.' >&2
  exit 1
fi

# Keep the running image and one rollback image. A failed cleanup must not
# turn a healthy deployment into a failed deployment.
docker image ls --format '{{.Repository}}:{{.Tag}}' 'telegram-job-alerts:*' |
  while IFS= read -r image; do
    [[ "$image" =~ ^telegram-job-alerts:[0-9a-f]{40}$ ]] || continue
    [[ "$image" == "$new_image" || "$image" == "$previous_image" ]] && continue
    if ! docker image rm "$image"; then
      echo "Warning: could not remove old image $image" >&2
    fi
  done

exit 0
