from __future__ import annotations

from datetime import datetime
from typing import Any

from database.models import Approval, Task, TaskExecution


def iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None


def task_out(t: Task, full: bool = False) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": str(t.id), "title": t.title or t.request[:80], "request": t.request, "status": t.status.value,
        "assigned_agents": t.assigned_agents, "plan": t.plan, "cost_usd": t.cost_usd, "attempts": t.attempts,
        "conversation_id": str(t.conversation_id) if t.conversation_id else None,
        "workflow_id": str(t.workflow_id) if t.workflow_id else None,
        "created_at": iso(t.created_at), "updated_at": iso(t.updated_at), "started_at": iso(t.started_at),
        "finished_at": iso(t.finished_at), "error": t.error,
    }
    if full:
        d["output"], d["logs"] = t.output, t.logs
    else:
        d["output_preview"] = (t.output or "")[:280]
    return d


def execution_out(e: TaskExecution) -> dict[str, Any]:
    return {"id": str(e.id), "step_id": e.step_id, "agent": e.agent_slug, "instruction": e.instruction,
            "status": e.status.value, "output": e.output, "error": e.error, "tool_calls": e.tool_calls,
            "model": e.model, "input_tokens": e.input_tokens, "output_tokens": e.output_tokens,
            "cost_usd": e.cost_usd, "started_at": iso(e.started_at), "finished_at": iso(e.finished_at)}


def approval_out(a: Approval) -> dict[str, Any]:
    return {"id": str(a.id), "task_id": str(a.task_id) if a.task_id else None, "agent": a.agent_slug,
            "tool": a.tool_name, "summary": a.action_summary, "arguments": a.arguments, "risk_level": a.risk_level,
            "reason": a.reason, "status": a.status.value, "created_at": iso(a.created_at),
            "decided_at": iso(a.decided_at), "result": a.result, "expires_at": iso(a.expires_at)}
