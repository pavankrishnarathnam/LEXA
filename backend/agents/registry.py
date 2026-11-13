"""Registry-driven agent resolution: built-ins + per-user overrides + custom agents."""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from agents.definitions import BUILTIN_AGENTS, BUILTIN_BY_SLUG
from agents.tools import TOOLS
from database.models import Agent, AgentPrompt, AgentTool, PermissionMode

# Pseudo-tool name that enables the provider's hosted web search for an agent.
WEB_SEARCH = "web_search"


@dataclass
class AgentConfig:
    id: uuid.UUID | None
    slug: str
    name: str
    role: str
    description: str
    icon: str
    system_prompt: str
    tools: list[str]
    model: str | None = None
    effort: str | None = None
    enabled: bool = True
    is_builtin: bool = False
    is_custom: bool = False
    permission_mode: PermissionMode | None = None
    memory_access: str = "read"
    max_tool_iterations: int = 8
    max_cost_usd_per_run: float = 1.0
    autonomy_rules: list[dict[str, Any]] = field(default_factory=list)
    web_search: bool = False
    capabilities: list[str] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        d = self.__dict__.copy()
        d["id"] = str(self.id) if self.id else None
        d["permission_mode"] = self.permission_mode.value if self.permission_mode else None
        return d


async def seed_builtin_agents(db: AsyncSession) -> None:
    """Idempotently store built-in definitions (user_id NULL) so they are visible/auditable in the DB."""
    for b in BUILTIN_AGENTS:
        row = await db.scalar(select(Agent).options(selectinload(Agent.prompts), selectinload(Agent.tools))
                              .where(Agent.user_id.is_(None), Agent.slug == b.slug))
        if row is None:
            row = Agent(user_id=None, slug=b.slug, is_builtin=True, prompts=[], tools=[])
            db.add(row)
        row.name, row.role, row.description, row.icon, row.effort = b.name, b.role, b.description, b.icon, b.effort
        row.memory_access = b.memory_access
        active = next((p for p in row.prompts if p.is_active), None)
        if active is None or active.system_prompt != b.prompt:
            for p in row.prompts:
                p.is_active = False
            row.prompts.append(AgentPrompt(version=len(row.prompts) + 1, system_prompt=b.prompt, is_active=True))
        existing = {t.tool_name for t in row.tools}
        for t in b.tools:
            if t not in existing:
                row.tools.append(AgentTool(tool_name=t))
        row.tools = [t for t in row.tools if t.tool_name in b.tools]
    await db.flush()


def _from_row(row: Agent, base: AgentConfig | None) -> AgentConfig:
    prompt = next((p.system_prompt for p in reversed(row.prompts) if p.is_active), None)
    tools = [t.tool_name for t in row.tools if t.enabled and t.tool_name in TOOLS]
    if base is None:
        return AgentConfig(id=row.id, slug=row.slug, name=row.name, role=row.role, description=row.description,
                           icon=row.icon, system_prompt=prompt or "", tools=tools, model=row.model, effort=row.effort,
                           enabled=row.enabled, is_custom=True, permission_mode=row.permission_mode,
                           memory_access=row.memory_access, max_tool_iterations=row.max_tool_iterations,
                           max_cost_usd_per_run=row.max_cost_usd_per_run, autonomy_rules=row.autonomy_rules or [],
                           web_search=any(t.tool_name == WEB_SEARCH and t.enabled for t in row.tools))
    # Per-user override of a built-in
    base.id = row.id
    base.name = row.name or base.name
    base.description = row.description or base.description
    base.system_prompt = prompt or base.system_prompt
    base.tools = tools if row.tools else base.tools
    if row.tools:
        base.web_search = any(t.tool_name == WEB_SEARCH and t.enabled for t in row.tools)
    base.model = row.model or base.model
    base.effort = row.effort or base.effort
    base.enabled = row.enabled
    base.permission_mode = row.permission_mode
    base.memory_access = row.memory_access or base.memory_access
    base.max_tool_iterations = row.max_tool_iterations
    base.max_cost_usd_per_run = row.max_cost_usd_per_run
    base.autonomy_rules = row.autonomy_rules or []
    return base


def builtin_config(slug: str) -> AgentConfig:
    b = BUILTIN_BY_SLUG[slug]
    return AgentConfig(id=None, slug=b.slug, name=b.name, role=b.role, description=b.description, icon=b.icon,
                       system_prompt=b.prompt, tools=list(b.tools), effort=b.effort, is_builtin=True,
                       memory_access=b.memory_access, web_search=b.web_search, capabilities=list(b.capabilities))


async def list_agents(db: AsyncSession, user_id: uuid.UUID) -> list[AgentConfig]:
    rows = (await db.execute(select(Agent).options(selectinload(Agent.prompts), selectinload(Agent.tools))
                             .where(Agent.user_id == user_id))).scalars().all()
    by_slug = {r.slug: r for r in rows}
    out: list[AgentConfig] = []
    for b in BUILTIN_AGENTS:
        cfg = builtin_config(b.slug)
        if b.slug in by_slug:
            cfg = _from_row(by_slug.pop(b.slug), cfg)
        out.append(cfg)
    for row in by_slug.values():
        out.append(_from_row(row, None))
    return out


async def get_agent(db: AsyncSession, user_id: uuid.UUID, slug: str) -> AgentConfig | None:
    return next((a for a in await list_agents(db, user_id) if a.slug == slug), None)


async def user_agent_row(db: AsyncSession, user_id: uuid.UUID, slug: str) -> Agent | None:
    return await db.scalar(select(Agent).options(selectinload(Agent.prompts), selectinload(Agent.tools))
                           .where(Agent.user_id == user_id, Agent.slug == slug))

