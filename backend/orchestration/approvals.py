"""Human-in-the-loop approvals: decision, exact-argument execution, task finalization."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import select

from agents.tools import TOOLS, ToolContext
from agents.tools.base import validate_args
from core.audit import audit, notify
from core.redis import publish_event
from database.models import Approval, ApprovalStatus, Message, Task, TaskStatus
from database.session import SessionLocal
from orchestration.tasks import set_status, task_log
from workers.queue import enqueue


class ApprovalError(Exception):
    pass


async def decide(user_id: uuid.UUID, approval_id: uuid.UUID, approve: bool, note: str | None = None) -> Approval:
    async with SessionLocal() as db:
        appr = await db.scalar(select(Approval).where(Approval.id == approval_id, Approval.user_id == user_id)
                               .with_for_update())
        if not appr:
            raise ApprovalError("Approval not found")
        if appr.status != ApprovalStatus.PENDING:
            raise ApprovalError(f"Approval already {appr.status.value}")
        if appr.expires_at and appr.expires_at < datetime.now(UTC):
            appr.status = ApprovalStatus.EXPIRED
            await db.commit()
            raise ApprovalError("Approval expired")
        appr.status = ApprovalStatus.APPROVED if approve else ApprovalStatus.REJECTED
        appr.decided_at, appr.decision_note = datetime.now(UTC), note
        await audit(db, user_id=user_id, action=f"approval.{'approved' if approve else 'rejected'}",
                    category="approval", target_type="approval", target_id=appr.id,
                    details={"tool": appr.tool_name, "summary": appr.action_summary[:300]})
        if approve:
            await enqueue(db, "execute_approval", {"approval_id": str(appr.id)}, user_id=user_id)
        await db.commit()
        task_id = appr.task_id
    await publish_event(user_id, "approval.decided", {"approval_id": str(approval_id), "approved": approve})
    if task_id:
        await task_log(task_id, user_id, f"Approval {'granted' if approve else 'rejected'}: {appr.tool_name}",
                       agent="user")
        if not approve:
            await maybe_finalize(task_id, user_id)
    return appr


async def execute_approval(approval_id: uuid.UUID) -> None:
    async with SessionLocal() as db:
        appr = await db.scalar(select(Approval).where(Approval.id == approval_id).with_for_update())
        if not appr or appr.status != ApprovalStatus.APPROVED:
            return  # idempotent: already executed, rejected or missing
        tool = TOOLS.get(appr.tool_name)
        user_id, task_id = appr.user_id, appr.task_id
        if tool is None or validate_args(tool, appr.arguments):
            appr.status, appr.result = ApprovalStatus.FAILED, {"error": "tool unavailable or arguments invalid"}
            await db.commit()
        else:
            ctx = ToolContext(db=db, user_id=user_id, agent_slug=appr.agent_slug, task_id=task_id)
            try:
                out = await tool.handler(ctx, appr.arguments)
                appr.status = ApprovalStatus.FAILED if out.is_error else ApprovalStatus.EXECUTED
                appr.result = {"content": out.content[:4000], **({"data": out.data} if out.data else {})}
            except Exception as exc:  # noqa: BLE001
                await db.rollback()
                appr = await db.get(Approval, approval_id)
                assert appr is not None
                appr.status, appr.result = ApprovalStatus.FAILED, {"error": f"{type(exc).__name__}: {exc}"[:2000]}
            await audit(db, user_id=user_id, actor=f"agent:{appr.agent_slug}", action=f"action.{appr.tool_name}",
                        category="action", target_type="approval", target_id=appr.id,
                        success=appr.status == ApprovalStatus.EXECUTED, details=appr.result)
            ok = appr.status == ApprovalStatus.EXECUTED
            await notify(db, user_id, "approval", f"{'Done' if ok else 'Failed'}: {appr.action_summary.splitlines()[0][:150]}",
                         (appr.result or {}).get("content") or (appr.result or {}).get("error", ""),
                         severity="success" if ok else "error")
            await db.commit()
    await publish_event(user_id, "approval.executed", {"approval_id": str(approval_id),
                                                       "status": appr.status.value})
    if task_id:
        await task_log(task_id, user_id, f"Approved action {appr.tool_name}: {appr.status.value}",
                       level="info" if appr.status == ApprovalStatus.EXECUTED else "error", agent=appr.agent_slug)
        await maybe_finalize(task_id, user_id)


async def maybe_finalize(task_id: uuid.UUID, user_id: uuid.UUID) -> None:
    """When a task has no pending approvals left, record outcomes and complete it."""
    async with SessionLocal() as db:
        task = await db.get(Task, task_id)
        if not task or task.status != TaskStatus.WAITING_FOR_APPROVAL:
            return
        approvals = (await db.execute(select(Approval).where(Approval.task_id == task_id))).scalars().all()
        if any(a.status in (ApprovalStatus.PENDING, ApprovalStatus.APPROVED) for a in approvals):
            return
        lines = []
        for a in approvals:
            label = {ApprovalStatus.EXECUTED: "✅ Done", ApprovalStatus.REJECTED: "⏹ Rejected",
                     ApprovalStatus.FAILED: "❌ Failed", ApprovalStatus.EXPIRED: "⌛ Expired"}.get(a.status, a.status.value)
            detail = (a.result or {}).get("content") or (a.result or {}).get("error") or ""
            lines.append(f"- {label}: {a.action_summary.splitlines()[0]}" + (f" — {detail[:300]}" if detail else ""))
        summary = "**Approval outcomes**\n" + "\n".join(lines)
        task.output = f"{task.output or ''}\n\n{summary}".strip()
        executed = [a for a in approvals if a.status == ApprovalStatus.EXECUTED]
        failed = [a for a in approvals if a.status == ApprovalStatus.FAILED]
        new_status = TaskStatus.FAILED if failed and not executed else TaskStatus.COMPLETED
        if task.conversation_id:
            db.add(Message(conversation_id=task.conversation_id, user_id=user_id, role="assistant", content=summary,
                           task_id=task_id, meta={"kind": "approval_outcomes"}))
        await db.commit()
    await set_status(task_id, user_id, new_status, finished_at=datetime.now(UTC))
