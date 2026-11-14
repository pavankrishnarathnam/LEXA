#!/usr/bin/env bash
# Starts LEXA inside a GitHub Codespace (or any dev container): migrations -> web app -> API -> worker.
#
# GitHub's port forwarding can answer "502 Bad Gateway" for ONE port even though the app is healthy
# (the app answers fine inside the container). So this script checks the PUBLIC forwarded address end
# to end and, if it does not answer, moves the web app to another port until a working address is found.
# The verified address is printed and saved to ~/lexa-data/url.txt (show it again with url.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${LEXA_STATE_DIR:-$HOME/lexa-data}"
PY="$STATE/venv/bin/python"
LOGS="$STATE/logs"
API_PORT="${LEXA_API_PORT:-8000}"
LAST_CODE=000
mkdir -p "$LOGS"

log() { printf '[lexa] %s\n' "$*"; }

set -a
# shellcheck disable=SC1091
. "$STATE/secrets.env"
set +a
export ENVIRONMENT=development ALLOW_REGISTRATION="${ALLOW_REGISTRATION:-true}"

# ------------------------------------------------------------------ public address helpers
in_codespace() { [ -n "${CODESPACE_NAME:-}" ] || [ -n "${LEXA_PUBLIC_URL_TEMPLATE:-}" ]; }

public_url() { # public_url <port> -> the address a browser would use
  if [ -n "${LEXA_PUBLIC_URL_TEMPLATE:-}" ]; then
    echo "${LEXA_PUBLIC_URL_TEMPLATE//\{port\}/$1}"
  elif [ -n "${CODESPACE_NAME:-}" ]; then
    echo "https://${CODESPACE_NAME}-$1.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  else
    echo "http://localhost:$1"
  fi
}

public_ok() { # public_ok <port> -> 0 when the forwarded address really serves the app
  in_codespace || return 0
  local url code
  url="$(public_url "$1")/login"
  for _ in 1 2 3 4 5 6; do # the forwarder needs a few seconds to notice a new port
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "X-Github-Token: ${GITHUB_TOKEN:-}" "$url" || true)"
    case "$code" in 200 | 30[0-9]) return 0 ;; esac
    LAST_CODE="${code:-000}"
    sleep "${LEXA_CHECK_INTERVAL:-4}"
  done
  return 1
}

start_web() { # start_web <port> -> 0 when the web app answers locally on that port
  pkill -f "standalone/server.js" 2>/dev/null || true
  sleep 1
  (
    cd "$ROOT/frontend"
    HOSTNAME=0.0.0.0 PORT="$1" KEEP_ALIVE_TIMEOUT=65000 BACKEND_URL="http://127.0.0.1:${API_PORT}" \
      NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production \
      setsid nohup node .next/standalone/server.js >"$LOGS/web.log" 2>&1 &
  )
  for _ in $(seq 1 30); do
    curl -fsS -o /dev/null "http://127.0.0.1:$1/login" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

# ------------------------------------------------------------------ build, database, old processes
cd "$ROOT/frontend"
if [ ! -f .next/standalone/server.js ]; then
  log "Frontend build missing - running setup first"
  bash "$ROOT/.devcontainer/setup.sh"
fi

log "Waiting for Postgres"
for _ in $(seq 1 60); do
  "$PY" -c "import asyncio,asyncpg,os;asyncio.run(asyncpg.connect(os.environ['DATABASE_URL'].replace('+asyncpg','')))" \
    >/dev/null 2>&1 && break
  sleep 2
done
(cd "$ROOT/backend" && "$PY" -m alembic upgrade head)

pkill -f "uvicorn main:app" 2>/dev/null || true
pkill -f "workers.main" 2>/dev/null || true
pkill -f "next start" 2>/dev/null || true
pkill -f "next-server" 2>/dev/null || true

# ------------------------------------------------------------------ choose a web port that really works
candidates=()
add_candidate() {
  [[ "$1" =~ ^[0-9]+$ ]] || return 0
  local c
  for c in "${candidates[@]:-}"; do [ "$c" = "$1" ] && return 0; done
  candidates+=("$1")
}
[ -f "$STATE/web_port" ] && add_candidate "$(cat "$STATE/web_port")"
[ -n "${LEXA_WEB_PORT:-}" ] && add_candidate "$LEXA_WEB_PORT"
for p in 3100 3101 3102 3000; do add_candidate "$p"; done

WEB_PORT=""
for p in "${candidates[@]}"; do
  log "Starting the web app on port $p"
  if ! start_web "$p"; then
    log "  could not start on port $p (see $LOGS/web.log)"
    continue
  fi
  if public_ok "$p"; then
    WEB_PORT="$p"
    break
  fi
  log "  port $p works inside the container, but GitHub's forwarding answered HTTP $LAST_CODE - trying another port"
done

VERIFIED=1
if [ -z "$WEB_PORT" ]; then
  VERIFIED=0
  WEB_PORT="${candidates[0]}"
  log "WARNING: no port could be confirmed through GitHub's forwarding. Running on port $WEB_PORT inside the codespace."
  start_web "$WEB_PORT" || log "ERROR: the web app would not start - see $LOGS/web.log"
fi
echo "$WEB_PORT" >"$STATE/web_port"

export PUBLIC_URL
PUBLIC_URL="$(public_url "$WEB_PORT")"
if in_codespace; then
  export API_URL="$PUBLIC_URL" CORS_ORIGINS="$PUBLIC_URL" COOKIE_SECURE=true
fi

# ------------------------------------------------------------------ API and worker
cd "$ROOT/backend"
setsid nohup "$PY" -m uvicorn main:app --host 0.0.0.0 --port "$API_PORT" --timeout-keep-alive 75 >"$LOGS/api.log" 2>&1 &
setsid nohup "$PY" -m workers.main >"$LOGS/worker.log" 2>&1 &

for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:${API_PORT}/api/health" >/dev/null 2>&1 && break
  sleep 1
done

echo "$PUBLIC_URL" >"$STATE/url.txt"
log "------------------------------------------------------------"
if [ "$VERIFIED" = 1 ]; then
  log " LEXA is ready and the address below was verified:"
else
  log " LEXA is running, but the public address could not be verified:"
fi
log "   $PUBLIC_URL"
log "------------------------------------------------------------"
if [ "$VERIFIED" = 0 ] && in_codespace; then
  log "If that address shows 502: open the PORTS tab, right-click port $WEB_PORT, choose 'Stop Forwarding Port',"
  log "then run: bash .devcontainer/start.sh   (it will try other ports and verify each one)."
fi
[ -z "${OPENAI_API_KEY:-}" ] && log "NOTE: OPENAI_API_KEY is not set - add it as a Codespaces secret, then rebuild the container."
log "Logs: $LOGS   |   Show this address again: bash .devcontainer/url.sh"
exit 0
