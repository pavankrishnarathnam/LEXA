"""Durable task state helpers. Each write uses its own short transaction so progress survives crashes."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, update

from core.redis import publish_event
from database.models import TERMINAL_STATUSES, Task, TaskStatus
from database.session import SessionLocal


async def task_log(task_id: uuid.UUID, user_id: uuid.UUID, message: str, *, level: str = "info",
                   agent: str | None = None, data: dict[str, Any] | None = None) -> None:
    entry = {"at": datetime.now(UTC).isoformat(), "level": level, "message": message[:2000], "agent": agent,
             **({"data": data} if data else {})}
    async with SessionLocal() as db:
        await db.execute(update(Task).where(Task.id == task_id).values(logs=Task.logs.op("||")([entry]),
                                                                       updated_at=datetime.now(UTC)))
        await db.commit()
    await publish_event(user_id, "task.log", {"task_id": str(task_id), **entry})


async def set_status(task_id: uuid.UUID, user_id: uuid.UUID, status: TaskStatus, **fields: Any) -> None:
    now = datetime.now(UTC)
    values: dict[str, Any] = {"status": status, "updated_at": now, **fields}
    if status == TaskStatus.IN_PROGRESS:
        values.setdefault("started_at", now)
    if status in TERMINAL_STATUSES or status == TaskStatus.WAITING_FOR_APPROVAL:
        values.setdefault("finished_at", now)
    async with SessionLocal() as db:
        await db.execute(update(Task).where(Task.id == task_id).values(**values))
        await db.commit()
    await publish_event(user_id, "task.status", {"task_id": str(task_id), "status": status.value,
                                                 **{k: v for k, v in fields.items() if k in ("title", "error")}})


async def is_cancelled(task_id: uuid.UUID) -> bool:
    async with SessionLocal() as db:
        return bool(await db.scalar(select(Task.cancel_requested).where(Task.id == task_id)))


class TaskCancelled(Exception):
    pass
