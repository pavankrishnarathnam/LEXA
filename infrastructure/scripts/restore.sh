#!/usr/bin/env bash
# Restores a LEXA database backup. DESTRUCTIVE: replaces the current database.
#   infrastructure/scripts/restore.sh backups/lexa-20260101T031500Z.dump
set -euo pipefail
cd "$(dirname "$0")/../.."
FILE="${1:?usage: restore.sh <backup-file>}"
[ -s "$FILE" ] || { echo "Backup file not found or empty: $FILE"; exit 1; }
# shellcheck disable=SC1091
set -a; . ./.env; set +a
DC="docker compose"
DB="${POSTGRES_DB:-lexa}"; USER="${POSTGRES_USER:-lexa}"

echo "This will REPLACE database '$DB' with $FILE."
read -r -p "Type the database name to confirm: " CONFIRM
[ "$CONFIRM" = "$DB" ] || { echo "Aborted."; exit 1; }

echo "[restore] Taking a safety backup of the current database first"
infrastructure/scripts/backup.sh || echo "[restore] WARNING: safety backup failed; continuing at your request"

echo "[restore] Stopping application services"
$DC stop backend worker frontend
$DC exec -T postgres psql -U "$USER" -d postgres -qc "DROP DATABASE IF EXISTS ${DB}_restoring" -c "CREATE DATABASE ${DB}_restoring"
$DC exec -T postgres pg_restore -U "$USER" -d "${DB}_restoring" --no-owner --exit-on-error < "$FILE"
$DC exec -T postgres psql -U "$USER" -d postgres -qc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB'" \
  -c "ALTER DATABASE $DB RENAME TO ${DB}_before_restore_$(date +%s)" -c "ALTER DATABASE ${DB}_restoring RENAME TO $DB"

echo "[restore] Applying migrations (if the backup predates the current schema) and starting services"
$DC run --rm migrate
$DC up -d backend worker frontend
echo "[restore] Done. The previous database was kept as ${DB}_before_restore_* — drop it once verified."
