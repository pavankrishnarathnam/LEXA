# Deployment report

Date: 2026-11-13

## Status

| Item | Status |
|---|---|
| Production Docker images (backend, worker, frontend) | ✅ Built from the final code |
| Full stack via `docker compose` (Nginx HTTPS, frontend, backend, worker, Postgres+pgvector, Redis) | ✅ Running and healthy in the build environment |
| Migrations via one-shot `migrate` service | ✅ Applied (`0002`) |
| HTTPS, HTTP→HTTPS redirect, HSTS / security headers | ✅ Verified with a self-signed certificate for `localhost` |
| SSE through Nginx (with gzip negotiated) | ✅ |
| `deploy.sh`: release, pre-deploy verified backup, health checks, deployment history | ✅ (`local1`, `local2`, `local4`) |
| `deploy.sh`: broken release → automatic rollback | ✅ (`local3` rolled back to `local2`, recorded `rolled_back`) |
| `backup.sh` restore-verified backup / `restore.sh` | ✅ |
| **GitHub repository** | ✅ pushed |
| **GitHub Actions CI / CD runs** | ❌ Not run — no repository |
| **Production deployment to a VPS with a real domain + Let's Encrypt** | ❌ Not performed — no VPS/domain credentials |
| **Live Claude / OpenAI calls** | ❌ Not performed — no API keys in this environment |

No repository URL or deployment URL exists yet, so none is listed here.

## Blocked items and the exact actions required

1. **GitHub repository** — done: https://github.com/pavankrishnarathnam/LEXA. LEXA runs on GitHub Codespaces
   (`docs/CODESPACES.md`); the VPS release workflow is optional.
2. **AI provider keys** — add `OPENAI_API_KEY` to the Codespaces secrets (or the server `.env`).
   Until then the UI shows a clear warning and tasks fail fast with an actionable message.
3. **VPS + domain** — provision the VPS, create the DNS `A` record, then run `install-vps.sh`,
   `init-letsencrypt.sh` and either `deploy.sh <tag>` or publish a GitHub release.
4. **OAuth clients** (optional) — Google Cloud OAuth client (Gmail, Calendar, Drive scopes) and/or a GitHub OAuth
   app with the redirect URIs in `docs/DEPLOYMENT.md` §3.

## Post-deployment checklist
- `curl https://<domain>/api/health/ready` → `status: ok`, database/redis/worker `ok`, `ai_provider.openai: true`
- Register the owner account, then set `ALLOW_REGISTRATION=false` and redeploy.
- Settings → AI & permissions → *Check connection* on Anthropic.
- Ask the assistant a question; confirm a task completes and appears in Task Center with usage in Settings.
- Connect one integration and verify its access log.
- `cat backups/last_backup.json` after the first nightly run shows `"verified": true`.
