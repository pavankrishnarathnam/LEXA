# Backup & restore

## What is backed up
The PostgreSQL database (all application data, memories with embeddings, tasks, audit logs, LangGraph
checkpoints). Uploaded files live in the `uploads` Docker volume — back it up with your VPS snapshot feature or
`docker run --rm -v lexa_uploads:/d -v $PWD/backups:/b alpine tar czf /b/uploads-$(date +%F).tgz -C /d .`
The Trader agent's per-user workspaces (trading rules, plans, alerts; a few small JSON files each) live in the
`trader` volume and are not in the database backup. They are quick to recreate; to keep them, archive the volume the
same way (`-v lexa_trader:/d`).

## Automatic backups
`install-vps.sh` installs `/etc/cron.d/lexa`, running `infrastructure/scripts/backup.sh` nightly at 03:15 and
before every deployment. Each run:

1. `pg_dump --format=custom` → `backups/lexa-<timestamp>.dump`
2. **Verification**: restores the dump into a scratch database (`lexa_restore_check`), counts tables and rows in
   key tables, then drops the scratch database.
3. Writes `backups/last_backup.json` with `verified: true` **only if the restore test passed**, plus size, table
   count and SHA-256. The Security Agent reads this file and never reports an unverified backup as valid.
4. Optional off-site copy with rclone (`BACKUP_RCLONE_REMOTE`), and retention (`BACKUP_RETENTION_DAYS`, default 14).

Logs: `/var/log/lexa-backup.log`.

Check manually:
```bash
cat /opt/lexa/backups/last_backup.json
```

## Restore
```bash
cd /opt/lexa
infrastructure/scripts/restore.sh backups/lexa-20260101T031500Z.dump
```
The script asks you to type the database name, takes a safety backup, stops the app containers, restores into a
new database, swaps it in (the old one is kept as `lexa_before_restore_<ts>`), runs migrations and restarts the
app. Drop the kept database once you have verified the restore:
```bash
docker compose exec postgres psql -U lexa -d postgres -c "DROP DATABASE lexa_before_restore_<ts>"
```

## Disaster recovery (new server)
1. Provision a VPS and run `install-vps.sh`.
2. Copy the latest `.dump` (and the uploads archive) to `/opt/lexa/backups/`.
3. Copy your old `.env` — **`ENCRYPTION_KEY` must be the same** or stored integration credentials cannot be
   decrypted (you would need to reconnect integrations).
4. `docker compose up -d postgres redis`, then `restore.sh <dump>`, then `init-letsencrypt.sh` and `deploy.sh <tag>`.
