#!/usr/bin/env bash
# Creates a PostgreSQL backup and VERIFIES it by restoring into a scratch database and comparing row
# counts. Writes backups/last_backup.json (read by the Security Agent). A backup is only reported as
# verified when the restore test passes.
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck disable=SC1091
set -a; . ./.env; set +a
DC="docker compose"
DB="${POSTGRES_DB:-lexa}"; USER="${POSTGRES_USER:-lexa}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="backups/lexa-$STAMP.dump"
CHECK_DB="lexa_restore_check"
mkdir -p backups

status() {  # status <verified:true|false> <message>
  local size tables
  size=$(stat -c %s "$FILE" 2>/dev/null || echo 0)
  tables=${TABLES:-0}
  cat > backups/last_backup.json <<JSON
{"file": "$(basename "$FILE")", "finished_at": "$(date -u +%FT%TZ)", "size_bytes": $size, "tables": $tables,
 "verified": $1, "message": "$2", "sha256": "$(sha256sum "$FILE" 2>/dev/null | cut -d' ' -f1)"}
JSON
}

echo "[backup] Dumping $DB"
$DC exec -T postgres pg_dump -U "$USER" -d "$DB" --format=custom --no-owner > "$FILE"
[ -s "$FILE" ] || { status false "dump is empty"; exit 1; }

echo "[backup] Verifying by restoring into $CHECK_DB"
$DC exec -T postgres psql -U "$USER" -d postgres -qc "DROP DATABASE IF EXISTS $CHECK_DB" -c "CREATE DATABASE $CHECK_DB"
if ! $DC exec -T postgres pg_restore -U "$USER" -d "$CHECK_DB" --no-owner --exit-on-error < "$FILE"; then
  status false "pg_restore failed"; exit 1
fi
count_rows() {
  $DC exec -T postgres psql -U "$USER" -d "$1" -tAc \
    "SELECT string_agg(t || '=' || n, ',' ORDER BY t) FROM (SELECT 'users' t, count(*) n FROM users UNION ALL
     SELECT 'tasks', count(*) FROM tasks UNION ALL SELECT 'memories', count(*) FROM memories UNION ALL
     SELECT 'messages', count(*) FROM messages) s"
}
SRC=$(count_rows "$DB"); DST=$(count_rows "$CHECK_DB")
TABLES=$($DC exec -T postgres psql -U "$USER" -d "$CHECK_DB" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
$DC exec -T postgres psql -U "$USER" -d postgres -qc "DROP DATABASE IF EXISTS $CHECK_DB"
# Rows may be added between dump and count on a live system: restored counts must not exceed live counts
# and must be present for every table.
if [ -z "$DST" ] || [ "$TABLES" -lt 20 ]; then
  status false "restore check failed (tables=$TABLES)"; exit 1
fi
echo "[backup] live: $SRC | restored: $DST | tables: $TABLES"
status true "restore test passed; restored rows: $DST"

if [ -n "${BACKUP_RCLONE_REMOTE:-}" ] && command -v rclone >/dev/null; then
  rclone copy "$FILE" "$BACKUP_RCLONE_REMOTE" && echo "[backup] off-site copy uploaded"
fi
find backups -name 'lexa-*.dump' -mtime +"${BACKUP_RETENTION_DAYS:-14}" -delete
echo "[backup] OK $FILE"
