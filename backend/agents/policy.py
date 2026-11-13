"""Permission policy: decides whether a tool call is allowed, needs approval, or is denied."""
from __future__ import annotations

import fnmatch
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from sqlalchemy import func, select

from agents.tools.base import Risk, ToolContext, ToolDef
from database.models import Approval, ApprovalStatus, PermissionMode

Decision = Literal["allow", "approve", "deny"]
_ORDER = {PermissionMode.READ_ANALYZE: 0, PermissionMode.PREPARE_APPROVE: 1, PermissionMode.RULE_AUTONOMY: 2}

# Actions that ALWAYS need explicit approval regardless of mode or rules (spec: section "permission modes").
ALWAYS_APPROVE_KEYWORDS = (
    "payment", "transfer", "invoice pay", "sign contract", "accept offer", "accept the offer", "wire",
    "delete permanently", "confidential", "password", "bank account",
)


@dataclass
class PolicyResult:
    decision: Decision
    reason: str
    risk_level: str = "low"


def effective_mode(user_mode: PermissionMode, agent_mode: PermissionMode | None) -> PermissionMode:
    if agent_mode is None:
        return user_mode
    return user_mode if _ORDER[user_mode] <= _ORDER[agent_mode] else agent_mode


def _text_of(args: dict[str, Any]) -> str:
    return " ".join(str(v) for v in args.values()).lower()


async def _rule_allows(ctx: ToolContext, tool: ToolDef, args: dict[str, Any], rules: list[dict[str, Any]]) -> str | None:
    """Autonomy rules, e.g. {"tool": "gmail_create_draft"} or
    {"tool": "gmail_send", "recipient_patterns": ["*@mycompany.com"], "max_per_day": 5}."""
    for rule in rules:
        if not fnmatch.fnmatch(tool.name, rule.get("tool", "")):
            continue
        patterns = rule.get("recipient_patterns")
        if patterns:
            recipient = str(args.get("to") or args.get("recipient") or "")
            if not recipient or not any(fnmatch.fnmatch(r.strip().lower(), p.lower())
                                        for r in recipient.split(",") for p in patterns):
                continue
        limit = rule.get("max_per_day")
        if limit is not None:
            since = datetime.now(UTC) - timedelta(days=1)
            used = await ctx.db.scalar(select(func.count(Approval.id)).where(
                Approval.user_id == ctx.user_id, Approval.tool_name == tool.name,
                Approval.status == ApprovalStatus.EXECUTED, Approval.created_at >= since,
                Approval.reason.like("auto:%")))
            if (used or 0) >= int(limit):
                continue
        return f"auto: matched autonomy rule for {rule.get('tool')}"
    return None


async def decide(ctx: ToolContext, tool: ToolDef, args: dict[str, Any], *, user_mode: PermissionMode,
                 agent_mode: PermissionMode | None, autonomy_rules: list[dict[str, Any]]) -> PolicyResult:
    if tool.risk in (Risk.READ, Risk.INTERNAL):
        return PolicyResult("allow", "read/internal operation")
    mode = effective_mode(user_mode, agent_mode)

    sensitive_reason = None
    if tool.risk == Risk.SENSITIVE:
        sensitive_reason = "classified as sensitive"
    elif tool.sensitivity:
        sensitive_reason = tool.sensitivity(args)
    if not sensitive_reason:
        text = _text_of(args)
        hit = next((k for k in ALWAYS_APPROVE_KEYWORDS if k in text), None)
        if hit:
            sensitive_reason = f"mentions '{hit}'"

    if mode == PermissionMode.READ_ANALYZE:
        return PolicyResult("deny", "Permission mode is READ & ANALYZE: external actions are disabled. "
                                    "Prepare the content in your answer instead.", "medium")
    if sensitive_reason:
        return PolicyResult("approve", f"Sensitive action ({sensitive_reason}) always requires approval", "high")
    if mode == PermissionMode.RULE_AUTONOMY:
        why = await _rule_allows(ctx, tool, args, autonomy_rules)
        if why:
            return PolicyResult("allow", why, "low")
    return PolicyResult("approve", "External action requires approval in the current permission mode", "medium")
