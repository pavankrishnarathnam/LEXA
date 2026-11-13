#!/usr/bin/env bash
# Runs once when the codespace is created: installs dependencies, generates secrets, builds the frontend.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${LEXA_STATE_DIR:-$HOME/lexa-data}"
mkdir -p "$STATE/uploads"

echo "[lexa] Installing backend dependencies"
python -m venv "$STATE/venv"
"$STATE/venv/bin/pip" install --quiet --upgrade pip
"$STATE/venv/bin/pip" install --quiet -r "$ROOT/backend/requirements.lock"

if [ ! -f "$STATE/secrets.env" ]; then
  echo "[lexa] Generating instance secrets (kept outside the repository)"
  {
    echo "JWT_SECRET=$(openssl rand -hex 32)"
    echo "ENCRYPTION_KEY=$("$STATE/venv/bin/python" -c 'from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())')"
  } > "$STATE/secrets.env"
  chmod 600 "$STATE/secrets.env"
fi

echo "[lexa] Installing and building the frontend"
cd "$ROOT/frontend"
npm ci --no-audit --no-fund
NEXT_TELEMETRY_DISABLED=1 BACKEND_URL=http://127.0.0.1:8000 npm run build
# The build output is a standalone server (same as the Docker image); it needs its static assets beside it.
rm -rf .next/standalone/.next/static .next/standalone/public
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
echo "[lexa] Setup complete"
