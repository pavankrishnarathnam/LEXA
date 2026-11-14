#!/usr/bin/env bash
# Prints LEXA's address and whether it is healthy. Runs each time you open the codespace.
STATE="${LEXA_STATE_DIR:-$HOME/lexa-data}"
API_PORT="${LEXA_API_PORT:-8000}"

if [ -f "$STATE/url.txt" ]; then
  echo "LEXA address: $(cat "$STATE/url.txt")"
else
  echo "LEXA has not been started yet. Run: bash .devcontainer/start.sh"
  exit 0
fi

if curl -fsS "http://127.0.0.1:${API_PORT}/api/health" >/dev/null 2>&1; then
  echo "Status: running"
else
  echo "Status: NOT running. Start it with: bash .devcontainer/start.sh"
fi
