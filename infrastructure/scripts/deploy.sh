#!/usr/bin/env bash
# Deploys a versioned release of LEXA on the VPS with health checks and automatic rollback.
#   infrastructure/scripts/deploy.sh <version>      e.g. v1.2.0 or a git sha tag
# Steps: verified pre-deploy backup → pull images → migrate → start → health checks →
#        frontend↔backend check → record status → roll back on failure.
set -euo pipefail
cd "$(dirname "$0")/../.."
VERSION="${1:?usage: deploy.sh <version>}"
# shellcheck disable=SC1091
set -a; . ./.env; set +a
DC="docker compose"
STATE_FILE=".deploy-state"
PREVIOUS="$(cat "$STATE_FILE" 2>/dev/null || echo "")"
GIT_SHA="${GIT_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"
log() { printf '\033[1;35m[deploy]\033[0m %s\n' "$*"; }

record() {  # record <status> <json-details>
  $DC exec -T backend python -m workers.record_deployment "$VERSION" "$GIT_SHA" "$1" "$2" >/dev/null 2>&1 || true
  echo "$(date -u +%FT%TZ) $VERSION $GIT_SHA $1 $2" >> deployments.log
}

health() {
  for _ in $(seq 1 30); do
    if curl -fsS -k --max-time 5 "https://127.0.0.1/api/health/ready" -H "Host: $LEXA_DOMAIN" | grep -q '"database":{"ok":true' \
       && curl -fsS -k --max-time 5 -o /dev/null "https://127.0.0.1/login" -H "Host: $LEXA_DOMAIN"; then
      return 0
    fi
    sleep 5
  done
  return 1
}

rollback() {
  log "Deployment of $VERSION FAILED"
  if [ -n "$PREVIOUS" ]; then
    log "Rolling back to $PREVIOUS"
    LEXA_VERSION="$PREVIOUS" $DC up -d --no-build backend worker frontend nginx
    $DC exec -T nginx nginx -s reload >/dev/null 2>&1 || true
    if health; then
      record rolled_back "{\"to\":\"$PREVIOUS\"}"
      log "Rollback to $PREVIOUS healthy. If the failed release ran a migration, see docs/DEPLOYMENT.md#rollback."
    else
      record failed "{\"rollback\":\"unhealthy\"}"
      log "Rollback also unhealthy — restore the pre-deploy backup (docs/BACKUP.md)."
    fi
  else
    record failed "{\"rollback\":\"none-available\"}"
  fi
  exit 1
}

log "Deploying $VERSION (previous: ${PREVIOUS:-none})"
if [ -n "$PREVIOUS" ]; then
  log "Pre-deploy verified backup"
  infrastructure/scripts/backup.sh || { log "Backup failed — aborting deploy"; exit 1; }
fi

export LEXA_VERSION="$VERSION"
if [ "${SKIP_PULL:-0}" != "1" ]; then
  log "Pulling images"
  $DC pull backend worker frontend migrate
else
  log "SKIP_PULL=1: using locally available images"
fi

log "Running migrations"
$DC up -d postgres redis
$DC run --rm migrate || rollback

log "Starting services"
$DC up -d --no-build --remove-orphans backend worker frontend nginx || rollback

$DC exec -T nginx nginx -s reload >/dev/null 2>&1 || true
log "Health checks (database, redis, worker, frontend → backend through nginx)"
health || rollback

echo "$VERSION" > "$STATE_FILE"
record success "{\"previous\":\"$PREVIOUS\"}"
docker image prune -f >/dev/null 2>&1 || true
log "Deployed $VERSION successfully"
