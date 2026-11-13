# Deployment (Hostinger VPS or any Linux VPS)

Target: Ubuntu 22.04/24.04 or Debian 12, ≥ 2 vCPU / 4 GB RAM (KVM 2 or larger on Hostinger), a domain you
control, and a GitHub repository containing this code.

## 1. DNS and VPS IP
1. In the Hostinger panel (VPS → Overview) note the server's **public IPv4** (and IPv6 if assigned).
2. At your DNS provider create:
   - `A` record: `lexa.example.com → <VPS IPv4>` (TTL 300)
   - optionally `AAAA` record → `<VPS IPv6>`
3. Wait until `dig +short lexa.example.com` returns the IP.

## 2. Bootstrap the server
```bash
ssh root@<VPS IPv4>
adduser deploy && usermod -aG sudo deploy          # optional dedicated user
git clone https://github.com/<you>/LEXA.git /opt/lexa && cd /opt/lexa
sudo DEPLOY_USER=deploy infrastructure/scripts/install-vps.sh lexa.example.com you@example.com
```
This installs Docker, enables the firewall (SSH/80/443) and fail2ban, creates `.env` with generated secrets
(`JWT_SECRET`, `ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`), and installs cron jobs for the nightly
verified backup and Nginx certificate reloads.

## 3. Production environment variables
Edit `/opt/lexa/.env` (it is `chmod 600` and git-ignored):

| Variable | Required | Notes |
|---|---|---|
| `OPENAI_API_KEY` | yes | models, web search, embeddings, voice |
| `ANTHROPIC_API_KEY` | optional | only if you assign Claude models to agents |
| `LEXA_DOMAIN`, `PUBLIC_URL`, `API_URL`, `CORS_ORIGINS` | yes | set by the installer |
| `COOKIE_SECURE=true` | yes | required behind HTTPS (startup fails otherwise) |
| `ALLOW_REGISTRATION` | | set to `false` after creating your account |
| `GOOGLE_CLIENT_ID/SECRET` | for Gmail/Calendar/Drive | redirect URI `https://<domain>/api/integrations/{gmail,google_calendar,google_drive}/callback` |
| `GITHUB_CLIENT_ID/SECRET` | optional | OAuth app; or connect GitHub with a fine-grained token |
| `MONTHLY_BUDGET_USD` | | default AI budget per user |

Secure cookies: the session cookies are `HttpOnly; Secure; SameSite=Lax`. Leave `COOKIE_DOMAIN` unset unless
you serve the API from a different subdomain.

## 4. HTTPS (Let's Encrypt)
```bash
cd /opt/lexa
STAGING=1 infrastructure/scripts/init-letsencrypt.sh   # optional dry run against the staging CA
infrastructure/scripts/init-letsencrypt.sh
```
Creates a temporary self-signed certificate so Nginx can start, obtains the real certificate via the HTTP-01
webroot challenge, reloads Nginx and starts the `certbot` renewal container (`--profile tls`). Renewals are picked
up by the daily `nginx -s reload` cron job.

## 5. Nginx
`infrastructure/nginx/templates/default.conf.template` (rendered with `LEXA_DOMAIN`):
- `:80` serves ACME challenges and redirects everything else to HTTPS.
- `:443` proxies `/api/*` to the backend and everything else to the frontend; `/api/events` (SSE) has buffering
  and compression disabled; auth endpoints and the API are rate limited; HSTS and security headers are set.
- Upstreams are resolved through Docker DNS at request time so redeployed containers are picked up.

## 6. GitHub Actions (automated deploys)
Repository **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `VPS_HOST` | VPS IP or hostname |
| `VPS_USER` | `deploy` (must be in the `docker` group) |
| `VPS_SSH_KEY` | private key whose public key is in `~deploy/.ssh/authorized_keys` (use a dedicated key) |
| `DEPLOY_PATH` | `/opt/lexa` |
| `GHCR_TOKEN` | only if images are private: a token with `read:packages`; on the VPS run `echo $TOKEN \| docker login ghcr.io -u <user> --password-stdin` once |

Variables: `LEXA_DOMAIN` (used for the post-deploy HTTPS check).
**Settings → Environments → production**: add required reviewers so every deploy needs approval.

Release flow: merge to `main` (CI must pass) → publish a GitHub Release `vX.Y.Z` → `deploy.yml` verifies the tag
is on `main`, re-runs CI, builds and pushes `ghcr.io/<owner>/lexa-{backend,frontend}:vX.Y.Z`, waits for
environment approval, then SSHes to the VPS and runs `deploy.sh vX.Y.Z`.

## 7. What `deploy.sh` does
1. Verified pre-deploy backup (`backup.sh`) when a previous version exists.
2. Pull versioned images.
3. Run migrations (`migrate` one-shot service, `alembic upgrade head`).
4. Start backend, worker, frontend and Nginx.
5. Health checks through Nginx over HTTPS: database (with migration revision), Redis, worker heartbeat, and the
   frontend page — proving frontend ↔ backend routing.
6. Record the result in `deployment_records` (visible in Developer Center) and `deployments.log`.
7. On failure: automatic rollback to the previous image version + health check.

## Rollback
- **Automatic**: failed health checks roll back to the previous version.
- **Manual**: `infrastructure/scripts/deploy.sh <previous-tag>`.
- **Migrations** are forward-only. If a release applied a migration the previous code cannot work with, restore
  the pre-deploy backup taken in step 1 (`infrastructure/scripts/restore.sh backups/<file>.dump`) and then deploy
  the previous tag.

## Monitoring
- `GET /api/health` (liveness) and `GET /api/health/ready` (DB + migration, Redis, worker heartbeat, AI provider).
- Docker health checks on every service; `docker compose ps`.
- Structured JSON logs: `docker compose logs -f backend worker`.
- AI usage, cost and fallback rates: **Settings → Usage & cost**; audit trail: **Settings → Security & audit**.
- Resource usage: `docker stats` (memory limits are set per service in `docker-compose.yml`).
