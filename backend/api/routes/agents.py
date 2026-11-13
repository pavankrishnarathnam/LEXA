from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from sqlalchemy import func, select

from agents.definitions import BUILTIN_BY_SLUG
from agents.registry import WEB_SEARCH, get_agent, list_agents, user_agent_row
from agents.tools import TOOLS
from api.deps import DB, CurrentUser
from api.schemas import AgentIn, AgentPatch
from api.serializers import execution_out
from core.audit import audit
from database.models import Agent, AgentPrompt, AgentTool, PermissionMode, TaskExecution, UsageRecord

router = APIRouter(prefix="/api/agents", tags=["agents"])


def _validate_tools(tools: list[str]) -> list[str]:
    bad = [t for t in tools if t not in TOOLS and t != WEB_SEARCH]
    if bad:
        raise HTTPException(422, f"Unknown tools: {', '.join(bad)}")
    return tools


@router.get("/tools")
async def tool_catalog(user: CurrentUser) -> list[dict]:
    items = [{"name": t.name, "description": t.description, "risk": t.risk.value, "category": t.category,
              "integration": t.integration} for t in TOOLS.values()]
    return sorted(items, key=lambda x: (x["category"], x["name"]))


@router.get("")
async def agents(user: CurrentUser, db: DB) -> list[dict]:
    stats = {r.agent_slug: r for r in (await db.execute(
        select(UsageRecord.agent_slug, func.count().label("calls"), func.sum(UsageRecord.cost_usd).label("cost"),
               func.sum(UsageRecord.input_tokens + UsageRecord.output_tokens).label("tokens"))
        .where(UsageRecord.user_id == user.id).group_by(UsageRecord.agent_slug))).all()}
    runs = dict((await db.execute(select(TaskExecution.agent_slug, func.count()).where(
        TaskExecution.user_id == user.id).group_by(TaskExecution.agent_slug))).all())
    out = []
    for a in await list_agents(db, user.id):
        s = stats.get(a.slug)
        out.append({**a.public(), "stats": {"runs": runs.get(a.slug, 0), "llm_calls": s.calls if s else 0,
                                            "cost_usd": float(s.cost or 0) if s else 0.0,
                                            "tokens": int(s.tokens or 0) if s else 0}})
    return out


@router.get("/{slug}")
async def agent_detail(slug: str, user: CurrentUser, db: DB) -> dict:
    a = await get_agent(db, user.id, slug)
    if not a:
        raise HTTPException(404, "Agent not found")
    execs = (await db.execute(select(TaskExecution).where(TaskExecution.user_id == user.id,
                                                          TaskExecution.agent_slug == slug)
                              .order_by(TaskExecution.created_at.desc()).limit(25))).scalars().all()
    row = await user_agent_row(db, user.id, slug)
    versions = [{"version": p.version, "active": p.is_active, "created_at": p.created_at.isoformat()}
                for p in (row.prompts if row else [])]
    return {**a.public(), "executions": [execution_out(e) for e in execs], "prompt_versions": versions}


@router.post("", status_code=201)
async def create_agent(body: AgentIn, user: CurrentUser, db: DB) -> dict:
    slug = body.slug or body.name.lower().replace(" ", "-")[:40]
    if slug in BUILTIN_BY_SLUG or await user_agent_row(db, user.id, slug):
        raise HTTPException(409, "An agent with this slug already exists")
    agent = Agent(user_id=user.id, slug=slug, name=body.name, description=body.description, role=body.role,
                  icon=body.icon, model=body.model, effort=body.effort, enabled=body.enabled,
                  permission_mode=PermissionMode(body.permission_mode) if body.permission_mode else None,
                  memory_access=body.memory_access, max_tool_iterations=body.max_tool_iterations,
                  max_cost_usd_per_run=body.max_cost_usd_per_run, autonomy_rules=body.autonomy_rules,
                  prompts=[AgentPrompt(version=1, system_prompt=body.system_prompt)],
                  tools=[AgentTool(tool_name=t) for t in _validate_tools(body.tools)])
    db.add(agent)
    await db.flush()
    await audit(db, user_id=user.id, action="agent.create", category="agents", target_type="agent", target_id=slug,
                details={"tools": body.tools})
    a = await get_agent(db, user.id, slug)
    assert a
    return a.public()


@router.patch("/{slug}")
async def update_agent(slug: str, body: AgentPatch, user: CurrentUser, db: DB) -> dict:
    current = await get_agent(db, user.id, slug)
    if not current:
        raise HTTPException(404, "Agent not found")
    row = await user_agent_row(db, user.id, slug)
    if row is None:  # first customization of a built-in: create a per-user override row
        b = BUILTIN_BY_SLUG[slug]
        row = Agent(user_id=user.id, slug=slug, name=b.name, description=b.description, role=b.role, icon=b.icon,
                    effort=b.effort, is_builtin=True, memory_access=b.memory_access,
                    prompts=[AgentPrompt(version=1, system_prompt=b.prompt)],
                    tools=[AgentTool(tool_name=t) for t in b.tools] +
                    ([AgentTool(tool_name=WEB_SEARCH)] if b.web_search else []))
        db.add(row)
        await db.flush()
    data = body.model_dump(exclude_unset=True)
    if "system_prompt" in data and data["system_prompt"]:
        for p in row.prompts:
            p.is_active = False
        row.prompts.append(AgentPrompt(version=len(row.prompts) + 1, system_prompt=data.pop("system_prompt")))
    if "tools" in data and data["tools"] is not None:
        names = _validate_tools(data.pop("tools"))
        row.tools = [t for t in row.tools if t.tool_name in names]
        have = {t.tool_name for t in row.tools}
        row.tools += [AgentTool(tool_name=n) for n in names if n not in have]
    if "permission_mode" in data:
        pm = data.pop("permission_mode")
        row.permission_mode = PermissionMode(pm) if pm else None
    for k, v in data.items():
        if v is not None or k == "model":
            setattr(row, k, v)
    await db.flush()
    await audit(db, user_id=user.id, action="agent.update", category="agents", target_type="agent", target_id=slug,
                details={"fields": list(body.model_dump(exclude_unset=True))})
    a = await get_agent(db, user.id, slug)
    assert a
    return a.public()


@router.delete("/{slug}", status_code=204)
async def delete_agent(slug: str, user: CurrentUser, db: DB) -> Response:
    """Deletes a custom agent, or resets a built-in agent to its defaults."""
    row = await user_agent_row(db, user.id, slug)
    if not row:
        raise HTTPException(404, "No custom agent or override with this slug")
    await db.delete(row)
    await audit(db, user_id=user.id, action="agent.delete" if slug not in BUILTIN_BY_SLUG else "agent.reset",
                category="agents", target_type="agent", target_id=slug)
    return Response(status_code=204)
