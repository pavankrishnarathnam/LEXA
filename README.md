# LEXA — Your Personal AI Operating System

LEXA is a self-hosted, multi-agent personal assistant. You talk to one assistant — **LEXA CORE** — which plans
your request, delegates to specialist agents (in parallel where possible), uses only the tools each agent is
allowed, asks for your approval before acting on the outside world, remembers what matters, and reports
honestly what was done, what is pending and what failed.

- **Claude-first** (Anthropic Claude API as primary model provider), OpenAI as secondary/fallback, embeddings
  and voice.
- **9 built-in specialist agents** + custom agents you define in the dashboard (no code changes).
- **Durable execution**: tasks run in a background worker from a Postgres job queue; the LangGraph state is
  checkpointed in Postgres, so a crashed run resumes where it stopped.
- **Human-in-the-loop**: three permission modes; sensitive actions always need approval; approved actions run
  with exactly the parameters you saw.
- **Persistent memory** in PostgreSQL + pgvector, user-editable, secret-rejecting, exportable.

![stack](https://img.shields.io/badge/stack-Next.js%2016%20·%20FastAPI%20·%20LangGraph%20·%20Postgres%2Fpgvector%20·%20Redis-7c5cff)

## Contents

| Path | What |
|---|---|
| `backend/` | FastAPI API, LangGraph orchestration, agents & tools, memory, integrations, worker, Alembic migrations, tests |
| `frontend/` | Next.js App Router UI (React 19, Tailwind v4, shadcn-style Radix components, Framer Motion, Recharts) |
| `tests/e2e/` | Playwright end-to-end suite (desktop + mobile) |
| `infrastructure/` | Nginx (HTTPS) config, VPS install / TLS / deploy / backup / restore scripts |
| `automation/` | n8n integration notes and example workflow |
| `.github/workflows/` | `ci.yml`, `deploy.yml`, `security.yml` |
| `docs/` | Architecture, security, deployment, backup, testing and deployment reports |

## Agents

| Agent | Role | Highlights |
|---|---|---|
| **LEXA CORE** | Chief AI Assistant | Plans, delegates (parallel/sequential), synthesizes, never claims unverified success |
| Career | Personal Career Manager | Web job search, deduplicated job tracking, explainable match scores, tailored (never fabricated) applications; submission needs approval |
| Communication | Communication Manager | Gmail read/triage/summarize, drafts, sends (approval), WhatsApp Business, SMS (Twilio/Exotel), contacts, follow-ups |
| Research | Research Analyst | Claude web search + page fetch (robots.txt respected), cited reports; facts vs estimates vs assumptions |
| Developer | Software Engineer | GitHub repos, PR diffs/reviews, issues, CI status; branches/issues/PRs via approval; never deploys or deletes |
| Finance | Finance Assistant | Ledger, budgets, subscriptions, bill reminders — **cannot** move money |
| Personal Secretary | Productivity Manager | Calendar, scheduling, meeting prep, reminders, daily plans, Drive |
| Operations | Digital Operations | Recurring automations, n8n workflows, MCP tools, reports |
| Security | Security Assistant | Activity review, API usage, verified backup status, credential scanning |
| Knowledge | Memory Manager | Profile, preferences, project knowledge, documents |

## Quick start (development)

Requirements: Python 3.13, Node 22, Docker (for Postgres+pgvector and Redis).

```bash
docker run -d --name lexa-pg -p 5432:5432 -e POSTGRES_USER=lexa -e POSTGRES_PASSWORD=lexa -e POSTGRES_DB=lexa pgvector/pgvector:pg16
```

```bash
docker run -d --name lexa-redis -p 6379:6379 redis:7-alpine
```

```bash
cd backend && python -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.lock
```

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # required for real agent work
python -m alembic upgrade head
uvicorn main:app --reload --port 8000      # API  (docs at http://localhost:8000/api/docs)
```

```bash
cd backend && . .venv/bin/activate && python -m workers.main   # background worker (second terminal)
```

```bash
cd frontend && npm ci && npm run dev       # http://localhost:3000 (proxies /api to :8000)
```

The first account you register becomes the **owner**. Set `ALLOW_REGISTRATION=false` afterwards.

## Production

One command per step on a fresh Ubuntu/Debian VPS (Hostinger KVM or any Linux VPS) — full guide in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md):

```bash
sudo infrastructure/scripts/install-vps.sh lexa.example.com you@example.com
```

```bash
infrastructure/scripts/init-letsencrypt.sh
```

```bash
infrastructure/scripts/deploy.sh v0.1.0
```

Or publish a GitHub release and let `deploy.yml` build, publish and deploy it (with approval).

## Testing

```bash
cd backend && pytest -q                       # 32 tests: API, isolation, policy, orchestration, durability
cd frontend && npm run lint && npm run typecheck && npm test && npm run build
cd tests/e2e && npx playwright test           # needs backend/tests/e2e_server.py + `next start` running
```

See [`docs/TESTING.md`](docs/TESTING.md) for the latest results and what is (and isn't) covered.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) · [Security](docs/SECURITY.md) · [Deployment](docs/DEPLOYMENT.md) ·
  [Backup & restore](docs/BACKUP.md) · [Testing report](docs/TESTING.md) · [Deployment report](docs/DEPLOYMENT_REPORT.md)

## License

MIT — see [LICENSE](LICENSE).
