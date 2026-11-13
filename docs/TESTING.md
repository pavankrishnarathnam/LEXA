# Testing report

Run date: 2026-11-13. Environment: cloud dev container (Python 3.13, Node 22, Docker 29, PostgreSQL 16 +
pgvector 0.8, Redis 7). Results below are from actual runs on the final commit.

## Summary

| Suite | Result |
|---|---|
| Backend lint (`ruff`, incl. bandit-style `S` rules) | ✅ 0 issues |
| Backend types (`mypy`, 78 files) | ✅ 0 issues |
| Backend tests (`pytest`, real Postgres + Redis) | ✅ **37 passed** |
| Migrations: upgrade → downgrade → upgrade, `alembic check` | ✅ |
| Frontend lint (`eslint`, React Compiler rules) | ✅ 0 errors (32 warnings: `any` on loosely-typed JSON) |
| Frontend types (`tsc --noEmit`) | ✅ |
| Frontend unit tests (`vitest`) | ✅ **6 passed** |
| Frontend production build (`next build`, 20 routes) | ✅ |
| End-to-end (`playwright`, Chromium desktop + Pixel 7) | ✅ **10 passed** |
| Docker images build (backend 107 MB, frontend 87 MB compressed) | ✅ |
| Full production stack (compose: nginx/HTTPS, frontend, backend, worker, postgres, redis) | ✅ all healthy |
| `deploy.sh` good release / broken release → automatic rollback | ✅ / ✅ |
| `backup.sh` with restore verification, `restore.sh` | ✅ / ✅ |
| `pip-audit` (pinned lock) / `npm audit --omit=dev` | ✅ 0 known vulnerabilities |
| `shellcheck` on all scripts / `check_env.py` | ✅ |

## What the backend tests cover (`backend/tests`)
- **Auth**: register/login/profile, CSRF enforcement on cookie writes, unauthenticated rejection, lockout after
  5 failures, logout revokes refresh tokens, duplicate registration.
- **Isolation**: a second user cannot read/modify another user's conversations, memories, contacts, tasks or
  approvals.
- **Memory**: create, exact and semantic duplicate detection, secret rejection (passwords, OTPs, API keys, card
  numbers), search, update, delete.
- **Permission policy**: read always allowed; read-only mode denies external actions; prepare mode requires
  approval; autonomy rules (tool globs, recipient patterns); sensitive content always escalates; agent mode can
  only restrict; sensitive tools never auto-run; finance agent has no money-moving tools.
- **Orchestration** (through the real API, queue, worker and LangGraph graph):
  direct answers; parallel delegation with dependency context; approval flow (nothing executes before approval,
  exactly-once execution, double decision rejected, duplicate action detected); rejection; read-only denial;
  unassigned tools refused; **provider fallback** (primary fails → fallback model, usage records show both);
  all providers down → transparent failure + retry; cancellation; **crash-resume from Postgres checkpoint
  without re-running completed steps**; agent CRUD/override/reset.
- **Platform**: health/readiness, SKIP LOCKED queue (10 concurrent claimers, 6 jobs, each claimed once) and retry
  backoff, encrypted integration credentials + disconnect + access log, automations (cron, conditions,
  scheduled run, webhook auth/conditions, pause), career dedupe + explainable scoring + analytics, document
  upload/dedupe/type rejection/indexing/deletion, usage/audit/export/finance, budget enforcement, secret scanner,
  untrusted-content wrapping.

## End-to-end suite (`tests/e2e/lexa.spec.ts`)
Real Next.js production build → real FastAPI → real worker → Postgres/Redis, in Chromium:
register → command center; auth redirect; assistant direct answer (SSE streaming); parallel multi-agent task;
**external action waits for approval, is executed only after clicking “Approve & run”, and the automation then
exists**; create custom agent from the dashboard; memory add / secret rejection / delete; permission mode +
integrations pages; command palette navigation on desktop and mobile.

## How LLM calls are tested
No Anthropic/OpenAI API key was available in this environment. Tests register a **test-only scripted provider**
(`backend/tests/scripted_provider.py`, model ids `test-*`) through the provider router's registration seam. It
returns deterministic plans, tool calls and answers, so everything around the model — planning parsing,
delegation, tool execution, policies, approvals, fallback, accounting, persistence, streaming, UI — runs for real.
The scripted provider is not included in production images (`tests/` is excluded by `.dockerignore`).

## Not verified here (needs credentials you hold)
- Live calls to OpenAI (no key available). The OpenAI path is tested against the official `openai` 3.50 SDK's
  own response types with a mocked client (`tests/test_openai_provider.py`: tool calls, transcript replay,
  reasoning effort, Responses-API web search with citations, agents receiving the search tool), but not
  against the live API. Model names `gpt-5.1` / `gpt-5-mini` and their prices in `core/llm/pricing.py` should be
  checked against OpenAI's current list (override with `DEFAULT_MODEL` / `MODEL_PRICING_JSON`).
- Real Gmail / Calendar / Drive / GitHub OAuth, WhatsApp, Twilio, Exotel, n8n and MCP endpoints.
- Let's Encrypt issuance (requires a public domain); HTTPS was verified with a self-signed certificate.
- GitHub Actions execution (no repository access from this environment; workflows were validated locally by
  running their steps).

## Bugs found and fixed by testing
- SSE was buffered by Next.js gzip when proxied → `no-transform` + `compress: false`.
- Nginx kept stale container IPs after redeploys (502s) → request-time Docker DNS resolution.
- `CORS_ORIGINS` comma lists crashed settings parsing in containers → `NoDecode` + validator.
- Alembic autogenerate would have dropped LangGraph's checkpoint tables → excluded via `include_object`.
- Non-retryable errors (missing key, budget) were retried with backoff → fail fast.
- UI race where fast tasks finished before the live view subscribed; form labels not programmatically
  associated (accessibility); memory form reset after `await`; per-user rate limit too low for the dashboard;
  mobile banner layout.
