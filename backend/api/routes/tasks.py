from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select

from api.deps import DB, CurrentUser
from api.schemas import ApprovalDecisionIn
from api.serializers import approval_out, execution_out, task_out
from core.audit import audit
from core.redis import publish_event
from database.models import TERMINAL_STATUSES, Approval, ApprovalStatus, Task, TaskExecution, TaskStatus
from orchestration.approvals import ApprovalError, decide
from workers.queue import enqueue

router = APIRouter(prefix="/api", tags=["tasks"])


@router.get("/tasks")
async def list_tasks(user: CurrentUser, db: DB, status: str | None = None, view: str | None = None,
                     limit: int = 50, offset: int = 0) -> dict:
    q = select(Task).where(Task.user_id == user.id)
    if status:
        q = q.where(Task.status == TaskStatus(status))
    elif view == "active":
        q = q.where(Task.status.in_([TaskStatus.PENDING, TaskStatus.PLANNING, TaskStatus.IN_PROGRESS,
                                     TaskStatus.WAITING_FOR_APPROVAL]))
    total = await db.scalar(select(func.count()).select_from(q.subquery()))
    rows = (await db.execute(q.order_by(Task.created_at.desc()).limit(min(limit, 200)).offset(offset))).scalars()
    counts = dict((await db.execute(select(Task.status, func.count()).where(Task.user_id == user.id)
                                    .group_by(Task.status))).all())
    return {"items": [task_out(t) for t in rows], "total": total,
            "counts": {s.value: counts.get(s, 0) for s in TaskStatus}}


async def _task(db: DB, user_id: uuid.UUID, tid: uuid.UUID) -> Task:
    t = await db.scalar(select(Task).where(Task.id == tid, Task.user_id == user_id))
    if not t:
        raise HTTPException(404, "Task not found")
    return t


@router.get("/tasks/{tid}")
async def task_detail(tid: uuid.UUID, user: CurrentUser, db: DB) -> dict:
    t = await _task(db, user.id, tid)
    execs = (await db.execute(select(TaskExecution).where(TaskExecution.task_id == t.id)
                              .order_by(TaskExecution.created_at))).scalars().all()
    apprs = (await db.execute(select(Approval).where(Approval.task_id == t.id)
                              .order_by(Approval.created_at))).scalars().all()
    return {**task_out(t, full=True), "executions": [execution_out(e) for e in execs],
            "approvals": [approval_out(a) for a in apprs]}


@router.post("/tasks/{tid}/cancel")
async def cancel_task(tid: uuid.UUID, user: CurrentUser, db: DB) -> dict:
    t = await _task(db, user.id, tid)
    if t.status in TERMINAL_STATUSES:
        raise HTTPException(409, f"Task already {t.status.value}")
    t.cancel_requested = True
    if t.status in (TaskStatus.PENDING, TaskStatus.WAITING_FOR_APPROVAL):
        t.status = TaskStatus.CANCELLED
        for a in (await db.execute(select(Approval).where(Approval.task_id == t.id,
                                                          Approval.status == ApprovalStatus.PENDING))).scalars():
            a.status = ApprovalStatus.REJECTED
            a.decision_note = "Task cancelled"
    await audit(db, user_id=user.id, action="task.cancel", category="tasks", target_type="task", target_id=t.id)
    await publish_event(user.id, "task.status", {"task_id": str(t.id), "status": t.status.value,
                                                 "cancel_requested": True})
    return task_out(t)


@router.post("/tasks/{tid}/retry", status_code=202)
async def retry_task(tid: uuid.UUID, user: CurrentUser, db: DB) -> dict:
    t = await _task(db, user.id, tid)
    if t.status not in (TaskStatus.FAILED, TaskStatus.CANCELLED):
        raise HTTPException(409, "Only failed or cancelled tasks can be retried")
    new = Task(user_id=user.id, conversation_id=t.conversation_id, parent_task_id=t.id, request=t.request,
               title=t.title, workflow_id=t.workflow_id)
    db.add(new)
    await db.flush()
    await enqueue(db, "run_task", {"task_id": str(new.id)}, user_id=user.id)
    await audit(db, user_id=user.id, action="task.retry", category="tasks", target_type="task", target_id=t.id)
    return task_out(new)


@router.get("/approvals")
async def list_approvals(user: CurrentUser, db: DB, status: str = "pending") -> list[dict]:
    q = select(Approval).where(Approval.user_id == user.id)
    if status != "all":
        q = q.where(Approval.status == ApprovalStatus(status))
    rows = (await db.execute(q.order_by(Approval.created_at.desc()).limit(100))).scalars()
    return [approval_out(a) for a in rows]


@router.post("/approvals/{aid}/decision")
async def decide_approval(aid: uuid.UUID, body: ApprovalDecisionIn, user: CurrentUser) -> dict:
    try:
        a = await decide(user.id, aid, body.approve, body.note)
    except ApprovalError as exc:
        raise HTTPException(409, str(exc)) from exc
    return approval_out(a)
