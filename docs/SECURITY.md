# Security

## Authentication & sessions
- Argon2id password hashing; minimum 10 characters; account lockout after 5 failed logins (15 min).
- Short-lived access JWT (30 min) + refresh JWT (14 days, path-scoped to `/api/auth`) in **httpOnly, SameSite=Lax,
  Secure** cookies. Refresh tokens carry a per-user version; logout and password change revoke all of them.
- **CSRF**: double-submit token (`lexa_csrf` cookie + `X-CSRF-Token` header) required for every cookie-authenticated
  state-changing request.
- Rate limiting: per-user API limit (Redis sliding window), per-IP login/registration limits, Nginx `limit_req`.
- RBAC: `owner`/`admin`/`member` roles (`api/deps.require_role`). The first user is the owner; registration can be
  closed with `ALLOW_REGISTRATION=false`.

## Data protection
- Strict tenant isolation: every user-owned table has `user_id`; all queries filter by the authenticated user
  (covered by `test_strict_account_isolation`, `test_approval_isolation`).
- Integration credentials are encrypted with Fernet (`ENCRYPTION_KEY`) and never returned by the API or export.
- Memory refuses passwords, OTPs, API keys, private keys and card-like numbers.
- API keys for AI providers live only in the backend environment; the browser never sees them.
- Data export (`/api/export`) excludes credentials and webhook secret hashes.

## Agent safety
- Agents only get explicitly assigned tools; unassigned calls are refused and logged.
- Permission modes + autonomy rules + always-approve categories (payments, transfers, contracts, accepting
  offers, confidential information, irreversible deletions, sensitive account changes).
- Approvals execute exactly the stored arguments once; duplicates are detected.
- Prompt-injection defence: all external content is wrapped as untrusted data; system prompts instruct agents to
  ignore embedded instructions and report them.
- Web access respects robots.txt and never bypasses CAPTCHAs; SSRF guard blocks private addresses in production
  for web fetch, n8n and MCP URLs.
- Per-agent cost and iteration limits; per-user monthly budget; per-task timeouts.

## Infrastructure
- Only Nginx is exposed (80/443); Postgres/Redis are on the internal Docker network; Redis requires a password.
- HTTPS via Let's Encrypt, TLS 1.2/1.3, HSTS, `X-Frame-Options: DENY`, `nosniff`, strict CSP from Next.js.
- Containers run as non-root users; images are minimal (`python:3.13-slim`, `node:22-alpine`).
- Firewall (ufw: SSH/80/443) and fail2ban are configured by `install-vps.sh`.
- Production refuses to start with a weak `JWT_SECRET`, missing `ENCRYPTION_KEY` or non-secure cookies.

## Audit
`audit_logs` records logins (success/failure, IP, user agent), permission-mode changes, agent edits, approvals,
executed actions and their results, integration connects/disconnects/accesses, memory and document changes,
exports and automation changes. Visible in **Settings → Security & audit**.

## CI security
`security.yml`: gitleaks secret scanning, pip-audit + npm audit, CodeQL (Python, JS/TS), ruff security rules,
Trivy image scans; weekly schedule.

## Reporting
Please report vulnerabilities privately to the repository owner rather than opening a public issue.
