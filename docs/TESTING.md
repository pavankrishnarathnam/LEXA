# Testing report

Run date: 2026-11-14 (voice and accessibility added on top of the 2026-11-13 run). Environment: cloud dev container (Python 3.13, Node 22, Docker 29, PostgreSQL 16 +
pgvector 0.8, Redis 7). Results below are from actual runs on the final commit.

## Summary

| Suite | Result |
|---|---|
| Backend lint (`ruff`, incl. bandit-style `S` rules) | ✅ 0 issues |
| Backend types (`mypy`, 79 files) | ✅ 0 issues |
| Backend tests (`pytest`, real Postgres + Redis) | ✅ **53 passed** (16 of them voice) |
| Migrations: upgrade → downgrade → upgrade, `alembic check` | ✅ |
| Frontend lint (`eslint`, React Compiler rules) | ✅ 0 errors (27 warnings: `any` on loosely-typed JSON) |
| Frontend types (`tsc --noEmit`) | ✅ |
| Frontend unit tests (`vitest`, jsdom, real Radix components) | ✅ **167 passed** (161 voice) |
| Frontend production build (`next build`, 20 routes) | ✅ |
| End-to-end (`playwright`, Chromium: desktop, Pixel 7, voice with fake microphone, accessibility) | ✅ **25 passed** |
| Accessibility (`axe-core` 4.14, WCAG 2.1 A/AA; 20 screens × dark/light + dialogs + voice bar + sign-in) | ✅ **0 violations** |
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

## Voice and accessibility suites
See [`VOICE.md`](VOICE.md) for the full list. In brief:
- **Voice unit tests** (`frontend/tests/voice`): the command grammar (positive and negative cases, and every phrase LEXA
  itself suggests), operating real Radix tabs / dialog / dropdown / switch / controlled inputs by accessible name, the
  controller with a fake microphone, speaker and API (approval rules, echo, wake/sleep, destructive confirmation,
  password fields, task results, notifications), speech-text conversion, audio encoding and the detector, and a regression
  test for the confirm dialog.
- **Voice backend tests** (`backend/tests/test_voice.py`): OpenAI speech endpoints against the SDK's own error types.
- **Voice end-to-end** (`tests/e2e/voice.spec.ts`, Chromium with `--use-fake-device-for-media-stream`): the fake microphone
  plays a synthetic speech-like recording; the harness (`backend/tests/e2e_server.py`) stubs only the two OpenAI speech
  calls. Verified: Alt+V toggle; a spoken sentence navigating the app; approval read in full then approved by a spoken
  word; “never mind”/“reject”; filling a form and clicking by command; answering the app's dialog by spoken yes/no;
  requests spoken on any page answered and read back; chat integration; text-only mode without a key.
- **Accessibility** (`tests/e2e/a11y.spec.ts`): axe-core on every screen in both themes, with the voice bar open, in the
  conversation view and in every dialog.

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

## Not verified here (needs credentials you hold, other browsers or real people)
- **Real speech recognition and voices.** The voice end-to-end tests stub OpenAI transcription and speech, so recognition
  accuracy, OpenAI's actual voices and their latency are unverified. **Firefox and Safari** were not run (Chromium only),
  nor were **screen readers** (NVDA, JAWS, VoiceOver, Orca): axe checks only what a machine can check.
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
- **Found by the voice end-to-end and accessibility runs:**
  - The “echo” filter dropped a sentence you repeat after LEXA suggested it (“say *review approvals*”). Echo can only
    exist while LEXA is audible, so the filter now applies only to speech that overlapped its voice.
  - “review approvals”, the phrase LEXA itself suggests, was not a command. Every phrase LEXA tells you to say is now
    under test word for word.
  - The confirmation dialog read itself aloud in an endless loop (a context function changed identity on every update of
    the voice bar → React “maximum update depth”). Fixed, with a regression test that fails fast.
  - A second spoken description of a dialog cut off the dialog's own “say yes or no”.
  - The high-risk approval accepted a casual “yes” as its second confirmation (found by the unit tests): it now needs an
    explicit “approve”.
  - The Command Center (and other pages) were wider than a phone screen because a bare CSS `grid` has an auto-sized
    column; the page zoomed out and fixed bars slid off-screen. All 20 screens now fit at 412 px.
  - Axe: low-contrast “subtle” text in both themes, light-theme badge and link colours, white text on the (light red) danger button in
    the dark theme, an unnamed progress bar, a button whose accessible name did not contain its visible text, status dots
    with `aria-label` but no role.
  - The e2e harness exceeded the per-user rate limit (300 requests/min) with its own polling and was logged out: the
    harness now raises the limit (production defaults are unchanged).
