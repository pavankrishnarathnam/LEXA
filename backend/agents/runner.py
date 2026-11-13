"""Runs one agent on one instruction: tool loop + permission policy + approvals + accounting."""
from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select

from agents.definitions import GLOBAL_POLICY
from agents.policy import decide
from agents.registry import AgentConfig
from agents.tools import TOOLS, ToolContext, ToolResult
from agents.tools.base import validate_args
from core.config import settings
from core.llm.router import CallContext, RoutedSession
from core.llm.types import ServerTool
from core.logging import get_logger
from core.redis import publish_event
from database.models import Approval, ApprovalStatus, Integration, PermissionMode, User, UserProfile
from database.session import SessionLocal
from integrations.service import IntegrationError, IntegrationNotConnected
from memory.store import context_block
from orchestration.tasks import TaskCancelled, is_cancelled, task_log

log = get_logger(__name__)
TOOL_TIMEOUT = 120
MEMORY_WRITE_TOOLS = {"memory_save", "memory_update"}
MEMORY_TOOLS = MEMORY_WRITE_TOOLS | {"memory_search"}


@dataclass
class AgentRunResult:
    output: str
    status: str  # completed | waiting_for_approval | failed | cancelled
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    approvals: list[str] = field(default_factory=list)
    cost_usd: float = 0.0
    model: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    error: str | None = None


def action_hash(user_id: uuid.UUID, tool: str, args: dict[str, Any]) -> str:
    return hashlib.sha256(f"{user_id}|{tool}|{json.dumps(args, sort_keys=True, default=str)}".encode()).hexdigest()


async def _available_tools(user_id: uuid.UUID, cfg: AgentConfig) -> tuple[list[str], list[str]]:
    async with SessionLocal() as db:
        connected = set((await db.execute(select(Integration.provider).where(
            Integration.user_id == user_id, Integration.status == "connected"))).scalars().all())
    names, missing = [], set()
    for n in cfg.tools:
        t = TOOLS.get(n)
        if not t:
            continue
        if cfg.memory_access == "none" and n in MEMORY_TOOLS:
            continue
        if cfg.memory_access == "read" and n in MEMORY_WRITE_TOOLS:
            continue
        if t.integration and t.integration not in connected:
            missing.add(t.integration)
            continue
        if n == "sms_send" and not ({"twilio", "exotel"} & connected):
            missing.add("twilio/exotel")
            continue
        names.append(n)
    return names, sorted(missing)


async def build_system_prompt(cfg: AgentConfig, user: User, instruction: str, missing: list[str],
                              extra_context: str = "") -> str:
    async with SessionLocal() as db:
        profile = await db.scalar(select(UserProfile).where(UserProfile.user_id == user.id))
        memories = await context_block(db, user.id, instruction) if cfg.memory_access != "none" else ""
        await db.commit()
    tz = profile.timezone if profile else "UTC"
    parts = [cfg.system_prompt.strip(), GLOBAL_POLICY,
             f"# Context\nCurrent time (UTC): {datetime.now(UTC).isoformat(timespec='minutes')}. "
             f"User: {user.full_name or user.email}; timezone {tz}; permission mode "
             f"{user.permission_mode.value}."]
    if profile and profile.headline:
        parts.append(f"User headline: {profile.headline}")
    if memories:
        parts.append(f"# Relevant memory (user-provided facts)\n{memories}")
    if missing:
        parts.append(f"# Unavailable integrations\nNot connected: {', '.join(missing)}. Tools needing them are "
                     "disabled; tell the user to connect them in Integrations if required.")
    if extra_context:
        parts.append(f"# Results from other agents in this task\n{extra_context}")
    return "\n\n".join(parts)


async def run_agent(cfg: AgentConfig, user_id: uuid.UUID, instruction: str, *, task_id: uuid.UUID | None,
                    extra_context: str = "", step_id: str = "s1") -> AgentRunResult:
    async with SessionLocal() as db:
        user = await db.get(User, user_id)
    assert user is not None
    tool_names, missing = await _available_tools(user_id, cfg)
    system = await build_system_prompt(cfg, user, instruction, missing, extra_context)
    server_tools = [ServerTool("web_search", max_uses=6)] if cfg.web_search else []
    session = RoutedSession(CallContext(user_id, purpose="agent", task_id=task_id, agent_slug=cfg.slug),
                            cfg.model, system, [TOOLS[n].spec() for n in tool_names], server_tools,
                            effort=cfg.effort, max_tokens=16000)
    session.add_user(instruction)
    result = AgentRunResult(output="", status="completed")
    max_iter = min(cfg.max_tool_iterations, settings.agent_max_tool_iterations)

    for iteration in range(max_iter + 1):
        if task_id and await is_cancelled(task_id):
            raise TaskCancelled()
        resp = await session.step()
        result.model = resp.model
        result.input_tokens += resp.usage.input_tokens + resp.usage.cache_read_tokens
        result.output_tokens += resp.usage.output_tokens
        result.cost_usd = session.total_cost
        if resp.refusal:
            result.status, result.error = "failed", "The model declined this request."
            result.output = resp.text or result.error
            return result
        if resp.citations:
            sources = "\n".join(f"- {c.get('title') or c['url']}: {c['url']}" for c in
                                {c["url"]: c for c in resp.citations}.values())
            resp.text = f"{resp.text}\n\nSources:\n{sources}" if "Sources" not in resp.text else resp.text
        if not resp.tool_calls:
            result.output = resp.text
            break
        if iteration == max_iter:
            result.output = resp.text or "Stopped: reached the maximum number of tool iterations."
            result.error = "max_tool_iterations"
            break
        if session.total_cost > cfg.max_cost_usd_per_run:
            result.output = (resp.text + "\n\n" if resp.text else "") + \
                f"Stopped: per-run cost limit ${cfg.max_cost_usd_per_run:.2f} reached."
            result.error = "cost_limit"
            break
        tool_results: list[tuple[str, str, bool]] = []
        outcomes = await asyncio.gather(*[_execute_call(cfg, user, call.name, call.input, task_id, step_id, result)
                                          for call in resp.tool_calls])
        for call, out in zip(resp.tool_calls, outcomes, strict=True):
            tool_results.append((call.id, out.for_model(), out.is_error))
        session.add_tool_results(tool_results)

    if result.approvals:
        result.status = "waiting_for_approval"
    return result


async def _execute_call(cfg: AgentConfig, user: User, name: str, args: dict[str, Any], task_id: uuid.UUID | None,
                        step_id: str, result: AgentRunResult) -> ToolResult:
    record: dict[str, Any] = {"tool": name, "args": _redact(args), "at": datetime.now(UTC).isoformat()}
    result.tool_calls.append(record)
    t = TOOLS.get(name)
    if t is None or name not in cfg.tools:
        record["outcome"] = "denied:not_assigned"
        return ToolResult(f"Tool '{name}' is not available to this agent.", is_error=True)
    err = validate_args(t, args)
    if err:
        record["outcome"] = "invalid"
        return ToolResult(f"Invalid arguments: {err}", is_error=True)
    if task_id:
        await publish_event(user.id, "agent.tool", {"task_id": str(task_id), "agent": cfg.slug, "tool": name,
                                                    "step_id": step_id})
    async with SessionLocal() as db:
        ctx = ToolContext(db=db, user_id=user.id, agent_slug=cfg.slug, task_id=task_id)
        decision = await decide(ctx, t, args, user_mode=user.permission_mode,
                                agent_mode=cfg.permission_mode, autonomy_rules=cfg.autonomy_rules)
        record["policy"] = decision.decision
        if decision.decision == "deny":
            record["outcome"] = "denied"
            if task_id:
                await task_log(task_id, user.id, f"{cfg.name}: {name} denied — {decision.reason}", level="warning",
                               agent=cfg.slug)
            return ToolResult(f"Action not permitted: {decision.reason}", is_error=True)
        if decision.decision == "approve":
            ah = action_hash(user.id, name, args)
            dup = await db.scalar(select(Approval).where(
                Approval.user_id == user.id, Approval.action_hash == ah,
                Approval.status.in_([ApprovalStatus.PENDING, ApprovalStatus.APPROVED, ApprovalStatus.EXECUTED]),
                Approval.created_at >= datetime.now(UTC) - timedelta(days=7)))
            if dup:
                record["outcome"] = f"duplicate_of:{dup.id}"
                return ToolResult(f"Duplicate prevented: an identical action already exists (approval {dup.id}, "
                                  f"status {dup.status.value}). Do not repeat it.")
            appr = Approval(user_id=user.id, task_id=task_id, agent_slug=cfg.slug, tool_name=name,
                            action_summary=t.describe_call(args), arguments=args, risk_level=decision.risk_level,
                            reason=decision.reason, action_hash=ah, expires_at=datetime.now(UTC) + timedelta(days=7))
            db.add(appr)
            await db.flush()
            from core.audit import notify
            await notify(db, user.id, "approval", f"Approval needed: {t.describe_call(args).splitlines()[0][:120]}",
                         decision.reason, link="/tasks?tab=approvals", severity="warning")
            await db.commit()
            result.approvals.append(str(appr.id))
            record["outcome"] = f"queued_for_approval:{appr.id}"
            if task_id:
                await task_log(task_id, user.id, f"{cfg.name}: {name} queued for approval", agent=cfg.slug,
                               data={"approval_id": str(appr.id)})
            return ToolResult(f"QUEUED FOR APPROVAL (approval id {appr.id}). This action has NOT been executed; it "
                              "will run only if the user approves it. Report it as pending.")
        try:
            out = await asyncio.wait_for(t.handler(ctx, args), timeout=TOOL_TIMEOUT)
            await db.commit()
        except (IntegrationNotConnected, IntegrationError) as exc:
            await db.rollback()
            out = ToolResult(str(exc), is_error=True)
        except TimeoutError:
            await db.rollback()
            out = ToolResult(f"Tool timed out after {TOOL_TIMEOUT}s", is_error=True)
        except Exception as exc:  # noqa: BLE001 - tool failures are reported back to the model
            await db.rollback()
            log.exception("tool %s failed", name)
            out = ToolResult(f"Tool error: {type(exc).__name__}: {str(exc)[:500]}", is_error=True)
        if decision.reason.startswith("auto:") and not out.is_error:
            async with SessionLocal() as adb:
                adb.add(Approval(user_id=user.id, task_id=task_id, agent_slug=cfg.slug, tool_name=name,
                                 action_summary=t.describe_call(args), arguments=args, risk_level="low",
                                 reason=decision.reason, status=ApprovalStatus.EXECUTED,
                                 decided_at=datetime.now(UTC), action_hash=action_hash(user.id, name, args),
                                 result={"content": out.content[:2000]}))
                await adb.commit()
    record["outcome"] = "error" if out.is_error else "ok"
    if task_id and t.risk.value in ("external", "sensitive"):
        await task_log(task_id, user.id, f"{cfg.name}: executed {name} ({record['outcome']})", agent=cfg.slug)
    return out


def _redact(args: dict[str, Any]) -> dict[str, Any]:
    return {k: ("[redacted]" if any(s in k.lower() for s in ("token", "password", "secret")) else
                (v[:500] + "…" if isinstance(v, str) and len(v) > 500 else v)) for k, v in args.items()}


__all__ = ["AgentRunResult", "PermissionMode", "run_agent"]
