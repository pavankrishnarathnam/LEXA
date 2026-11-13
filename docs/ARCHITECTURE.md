# LEXA Architecture

```
Browser (Next.js UI) ──HTTPS──► Nginx ──/api──► FastAPI (backend) ──► PostgreSQL + pgvector
        ▲   SSE /api/events            └──/───► Next.js (frontend)        ▲
        │                                                                 │
        └────────────── Redis pub/sub ◄──────── Worker (LangGraph) ───────┘
                                                   │  tools (permission-checked)
                                                   ▼
                     OpenAI · (optional) Claude · Gmail · Calendar · Drive · GitHub · WhatsApp · Twilio · Exotel · n8n · MCP · Web
```

## Request lifecycle

1. **Message** — `POST /api/conversations/{id}/messages` stores the message, creates a `tasks` row
   (`PENDING`) and a durable `jobs` row, and returns immediately (202). Optional memory extraction is queued.
2. **Worker** claims the job with `FOR UPDATE SKIP LOCKED` and runs the **LangGraph master graph**:

   ```
   plan ──► schedule ──(Send per ready step, parallel)──► run_step ──► schedule … ──► synthesize ──► END
   ```

   - `plan` (LEXA CORE) returns a JSON plan: `direct` answer or `delegate` steps with `depends_on`.
     Unknown agents are dropped; cycles fall through to synthesis.
   - `schedule` fans out every step whose dependencies are satisfied via `Send` → steps run **in parallel**;
     dependent steps receive prior outputs (as data) in their context.
   - `run_step` runs one specialist (`agents/runner.py`) and persists a `task_executions` row.
   - `synthesize` streams the final reply (token deltas over SSE), stating completed / pending-approval / failed.
   - Nodes have `RetryPolicy` for transient provider errors. State is checkpointed in Postgres
     (`AsyncPostgresSaver`, `thread_id = task id`): if the job crashes, the queue retries it and the graph
     **resumes from the last checkpoint** without re-running completed steps (tested).
3. **Progress** — status, plan, agent/tool activity, logs and deltas are published to Redis and streamed to the
   browser over SSE. Postgres remains the source of truth (`tasks.logs`, `task_executions`).
4. **Statuses** — `PENDING → PLANNING → IN_PROGRESS → (WAITING_FOR_APPROVAL) → COMPLETED | FAILED | CANCELLED`.
   Cancellation is cooperative (checked between graph nodes and tool iterations). Timeouts are enforced per task.

## Agents (registry-driven)

- Built-in definitions live in `agents/definitions.py` and are mirrored to the `agents`, `agent_prompts`
  (versioned) and `agent_tools` tables at startup.
- Users override any built-in per account (prompt version, model, effort, tools, permission mode, memory access,
  limits, autonomy rules, enabled) or create **custom agents** — all via API/UI. `agents/registry.py` merges
  them; LEXA CORE's planner sees the live list, so new agents are delegated to without code changes.
- Each agent gets **only its assigned tools**; tools whose integration isn't connected are hidden and the agent is
  told which integrations are missing.

## Tools & permission policy

Every tool declares a risk class (`agents/tools/base.py`):

| Risk | Examples | Policy |
|---|---|---|
| `read` | gmail_search, calendar_list_events, web_fetch | always allowed |
| `internal` | memory_save, job_save, save_document, create_reminder | allowed (LEXA's own data) |
| `external` | gmail_send, calendar_create_event, github_create_pull_request, n8n_trigger_workflow | by permission mode |
| `sensitive` | application_submit_email | always approval |

`agents/policy.py` combines the user's mode with the agent's mode (an agent can only **restrict**):

- **Read & analyze** — external actions denied.
- **Prepare & approve** — external actions become approval requests.
- **Rule-based autonomy** — external actions matching the agent's `autonomy_rules`
  (`tool` glob, `recipient_patterns`, `max_per_day`) run automatically and are logged as executed approvals.

Calls mentioning payments, transfers, contract signing, accepting offers, confidential content or
irreversible deletion are escalated to **sensitive** regardless of mode. The Finance agent has no
money-moving tools at all.

**Approvals** store the exact arguments and an action hash. Identical actions within 7 days are detected as
duplicates. On approval, `execute_approval` runs the tool with exactly those arguments (idempotent; double
decisions are rejected), records the result, notifies the user and finalizes the task.

**Untrusted content** (emails, web pages, documents, MCP/n8n output, other agents' results) is wrapped in
`<untrusted_content>` with an instruction not to follow embedded instructions; the global policy in every system
prompt repeats this.

## AI provider layer (`core/llm`)

- `RoutedSession` keeps a provider-native transcript (so Claude's thinking/tool blocks are replayed unchanged)
  **and** a neutral transcript, so it can fail over mid-run to the next model in the chain
  (`agent model → FALLBACK_MODEL → DEFAULT_MODEL`), skipping providers without keys.
- **OpenAI (default)**: Chat Completions with function calling for every agent (`gpt-5.1`; `gpt-5-mini` for
  memory extraction and as fallback), `reasoning_effort` mapped from each agent's effort level, live web search
  as a `web_search` tool backed by the Responses API's hosted search (`WEB_SEARCH_MODEL`), embeddings
  (`text-embedding-3-small`) and voice (transcription + TTS).
- **Claude (optional)**: set `ANTHROPIC_API_KEY` and choose a `claude-*` model for any agent. Agents on Claude
  use Anthropic's hosted web search instead of the `web_search` tool.
- Every call (success or failure) writes a `usage_records` row with tokens, cache tokens, cost (pricing table,
  overridable with `MODEL_PRICING_JSON`), latency, request id and whether fallback was used. A per-user monthly
  budget blocks new calls once reached.

## Memory (`memory/`)

- Categories: profile, education, employment, skills, preferences, projects, contacts, decisions, ongoing tasks,
  documents, conversation summaries, general.
- Writes reject secrets (passwords, OTPs, API keys, private keys, card numbers), dedupe by normalized hash and by
  semantic near-duplicates (cosine distance < 0.12 within a category).
- Retrieval = pgvector cosine (HNSW index) + keyword match, boosted by pinning/importance; pinned memories are
  always included in agent context.
- Embeddings: OpenAI `text-embedding-3-small` when `OPENAI_API_KEY` is set; otherwise a local feature-hashing
  embedder (`lexa-hash-v1`, lexical similarity only). Rows record their embedding model and searches never mix
  models.
- Extraction: after each user message (if auto-memory is on) a fast model extracts user-stated facts, which go
  through the same validation.

## Data model

`users, user_profiles, agents, agent_prompts, agent_tools, conversations, messages, memories, documents, tasks,
task_executions, approvals, integrations, automation_workflows, notifications, audit_logs, usage_records,
job_opportunities, job_applications, contacts, projects` + `finance_entries`, `jobs` (queue),
`deployment_records`, and LangGraph's `checkpoint*` tables (managed by LangGraph, excluded from Alembic
autogenerate). Every user-owned row has `user_id`; every query filters by it (isolation is tested).

## Integrations (`integrations/`)

Provider registry with auth type, scopes and credential fields. OAuth (Google: Gmail/Calendar/Drive; GitHub)
uses signed state, offline access and automatic token refresh; API-key providers are verified against the real
API before saving. Credentials are Fernet-encrypted at rest, every access is audit-logged, disconnect deletes
tokens (and revokes them at Google).

## Automations (`workers/automation.py`)

Schedule (cron + timezone), webhook (per-workflow secret, optional conditions), LEXA event
(`task.completed/failed/...` with conditions, loop-protected) and manual triggers. Each run is an ordinary task,
so it gets the same planning, permissions, approvals and audit trail.

## Voice

Browser SpeechRecognition (or server transcription via OpenAI when unavailable), server TTS via OpenAI
(`gpt-4o-mini-tts`) with browser speech synthesis fallback, barge-in (speaking stops playback), animated orb
driven by live mic level. The browser never listens in the background; always-on wake words require a separate
desktop/mobile companion (not included).
