#!/usr/bin/env bash
# Runs every time the codespace starts: migrations, then API, worker and frontend in the background.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${LEXA_STATE_DIR:-$HOME/lexa-data}"
PY="$STATE/venv/bin/python"
LOGS="$STATE/logs"
mkdir -p "$LOGS"

set -a
# shellcheck disable=SC1091
. "$STATE/secrets.env"
set +a
export ENVIRONMENT=development ALLOW_REGISTRATION="${ALLOW_REGISTRATION:-true}"

# Codespaces serves the app at https://<codespace>-3000.app.github.dev (same origin for UI and /api).
if [ -n "${CODESPACE_NAME:-}" ]; then
  DOMAIN="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  export PUBLIC_URL="https://${CODESPACE_NAME}-3000.${DOMAIN}"
  export API_URL="$PUBLIC_URL" CORS_ORIGINS="$PUBLIC_URL" COOKIE_SECURE=true
fi

echo "[lexa] Waiting for Postgres"
for _ in $(seq 1 60); do
  "$PY" -c "import asyncio,asyncpg,os;asyncio.run(asyncpg.connect(os.environ['DATABASE_URL'].replace('+asyncpg','')))" \
    >/dev/null 2>&1 && break
  sleep 2
done

cd "$ROOT/backend"
"$PY" -m alembic upgrade head

pkill -f "uvicorn main:app" 2>/dev/null || true
pkill -f "workers.main" 2>/dev/null || true
pkill -f "next start" 2>/dev/null || true
pkill -f "next-server" 2>/dev/null || true

setsid nohup "$PY" -m uvicorn main:app --host 0.0.0.0 --port 8000 > "$LOGS/api.log" 2>&1 &
setsid nohup "$PY" -m workers.main > "$LOGS/worker.log" 2>&1 &
cd "$ROOT/frontend"
BACKEND_URL=http://127.0.0.1:8000 NEXT_TELEMETRY_DISABLED=1 setsid nohup npx next start -p 3000 > "$LOGS/web.log" 2>&1 &

for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1 && curl -fsS -o /dev/null http://127.0.0.1:3000/login && break
  sleep 2
done
echo "[lexa] LEXA is running → ${PUBLIC_URL:-http://localhost:3000}"
[ -z "${OPENAI_API_KEY:-}" ] && echo "[lexa] NOTE: OPENAI_API_KEY is not set — add it as a Codespaces secret, then rebuild." || true
echo "[lexa] Logs: $LOGS"
