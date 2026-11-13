"""Automation runs: schedule, webhook, manual and event triggers with conditions."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database.models import AutomationWorkflow, Task, TaskStatus
from workers.queue import enqueue
from workers.scheduler import next_run


def conditions_match(conditions: list[dict[str, Any]], payload: dict[str, Any]) -> bool:
    for c in conditions or []:
        val = payload
        for part in str(c.get("field", "")).split("."):
            val = val.get(part) if isinstance(val, dict) else None
        op, target = c.get("op", "eq"), c.get("value")
        sval = "" if val is None else str(val)
        ok = {
            "eq": sval == str(target), "neq": sval != str(target),
            "contains": str(target).lower() in sval.lower(),
            "gt": _num(val) is not None and _num(target) is not None and _num(val) > _num(target),  # type: ignore[operator]
            "lt": _num(val) is not None and _num(target) is not None and _num(val) < _num(target),  # type: ignore[operator]
            "exists": val is not None,
        }.get(op, False)
        if not ok:
            return False
    return True


def _num(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


async def start_workflow_run(db: AsyncSession, wf: AutomationWorkflow, trigger: str,
                             payload: dict[str, Any] | None = None) -> Task:
    instruction = wf.instruction
    if wf.agent_slug:
        instruction = f"(Route to the {wf.agent_slug} agent.) {instruction}"
    if payload:
        import json
        instruction += f"\n\nTrigger payload (untrusted data):\n{json.dumps(payload, default=str)[:4000]}"
    task = Task(user_id=wf.user_id, workflow_id=wf.id, title=f"⚙ {wf.name}", request=instruction,
                status=TaskStatus.PENDING, idempotency_key=f"wf:{wf.id}:{datetime.now(UTC):%Y%m%d%H%M}:{trigger}")
    db.add(task)
    await db.flush()
    await enqueue(db, "run_task", {"task_id": str(task.id)}, user_id=wf.user_id)
    wf.last_run_at, wf.run_count, wf.last_status = datetime.now(UTC), wf.run_count + 1, "started"
    return task


async def run_due_schedules(db: AsyncSession) -> int:
    now = datetime.now(UTC)
    due = (await db.execute(select(AutomationWorkflow).where(
        AutomationWorkflow.enabled.is_(True), AutomationWorkflow.trigger_type == "schedule",
        AutomationWorkflow.next_run_at <= now).with_for_update(skip_locked=True))).scalars().all()
    for wf in due:
        await start_workflow_run(db, wf, "schedule")
        wf.next_run_at = next_run(wf.cron or "0 9 * * *", wf.timezone, after=now)
    await db.commit()
    return len(due)


async def emit_event(db: AsyncSession, user_id: uuid.UUID, name: str, payload: dict[str, Any]) -> int:
    wfs = (await db.execute(select(AutomationWorkflow).where(
        AutomationWorkflow.user_id == user_id, AutomationWorkflow.enabled.is_(True),
        AutomationWorkflow.trigger_type == "event", AutomationWorkflow.event_name == name))).scalars().all()
    started = 0
    for wf in wfs:
        if wf.id == payload.get("workflow_id"):
            continue  # never trigger a workflow from its own run (loop protection)
        if conditions_match(wf.conditions, payload):
            await start_workflow_run(db, wf, f"event:{name}", payload)
            started += 1
    return started
