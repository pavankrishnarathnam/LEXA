"""LEXA background worker: durable job processing, scheduler, reminders, heartbeat."""
from __future__ import annotations

import asyncio
import os
import signal
import socket
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select

from core.audit import notify
from core.config import settings
from core.logging import configure_logging, get_logger
from core.redis import get_redis
from database.models import Message, Task, TaskStatus
from database.session import SessionLocal
from orchestration.tasks import TaskCancelled, set_status, task_log
from workers import queue
from workers.automation import emit_event, run_due_schedules

log = get_logger("lexa.worker")
WORKER_ID = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:6]}"
HEARTBEAT_KEY = "lexa:worker:heartbeat"


async def handle_run_task(payload: dict[str, Any], attempts: int, max_attempts: int) -> None:
    from orchestration.graph import execute_task
    task_id = uuid.UUID(payload["task_id"])
    async with SessionLocal() as db:
        task = await db.get(Task, task_id)
        if task is None or task.status in (TaskStatus.COMPLETED, TaskStatus.CANCELLED,
                                           TaskStatus.WAITING_FOR_APPROVAL):
            return
        if task.cancel_requested:
            await set_status(task_id, task.user_id, TaskStatus.CANCELLED)
            return
        user_id = task.user_id
        task.attempts = attempts
        await db.commit()
    try:
        await asyncio.wait_for(execute_task(task_id), timeout=settings.task_timeout_seconds)
    except TaskCancelled:
        await set_status(task_id, user_id, TaskStatus.CANCELLED)
        await task_log(task_id, user_id, "Task cancelled by user", level="warning", agent="core")
        return
    except TimeoutError:
        await _fail_task(task_id, user_id, f"Timed out after {settings.task_timeout_seconds}s")
        return
    except Exception as exc:
        from core.llm.types import ProviderError
        from core.llm.usage import BudgetExceeded
        permanent = isinstance(exc, BudgetExceeded) or (isinstance(exc, ProviderError) and not exc.retryable)
        if attempts < max_attempts and not permanent:
            await task_log(task_id, user_id, f"Attempt {attempts} failed ({type(exc).__name__}: {exc}); will retry "
                                             "from last checkpoint", level="warning", agent="core")
            raise
        await _fail_task(task_id, user_id, f"{type(exc).__name__}: {exc}")
        return
    async with SessionLocal() as db:
        task = await db.get(Task, task_id)
        if task:
            await emit_event(db, user_id, f"task.{task.status.value.lower()}",
                             {"task_id": str(task_id), "title": task.title, "status": task.status.value,
                              "workflow_id": task.workflow_id})
            if task.status == TaskStatus.FAILED or task.workflow_id:
                await notify(db, user_id, "task", f"Task {task.status.value.lower()}: {task.title}",
                             (task.output or task.error or "")[:400], link=f"/tasks/{task_id}",
                             severity="error" if task.status == TaskStatus.FAILED else "info")
            await db.commit()


async def _fail_task(task_id: uuid.UUID, user_id: uuid.UUID, error: str) -> None:
    async with SessionLocal() as db:
        task = await db.get(Task, task_id)
        if task:
            task.error = error[:4000]
            if task.conversation_id:
                db.add(Message(conversation_id=task.conversation_id, user_id=user_id, role="assistant",
                               content=f"I couldn't complete this task: {error[:1000]}", task_id=task_id,
                               meta={"status": "FAILED"}))
            await notify(db, user_id, "task", f"Task failed: {task.title or task.request[:80]}", error[:400],
                         link=f"/tasks/{task_id}", severity="error")
            await emit_event(db, user_id, "task.failed", {"task_id": str(task_id), "error": error,
                                                          "workflow_id": task.workflow_id})
            await db.commit()
    await set_status(task_id, user_id, TaskStatus.FAILED, error=error[:4000])
    from core.redis import publish_event
    await publish_event(user_id, "task.completed", {"task_id": str(task_id), "status": "FAILED", "error": error})


async def handle_reminder(payload: dict[str, Any], user_id: uuid.UUID | None) -> None:
    if user_id is None:
        return
    async with SessionLocal() as db:
        await notify(db, user_id, "reminder", f"⏰ {payload.get('title', 'Reminder')}", payload.get("details", ""),
                     severity="warning")
        await db.commit()


async def handle_memory_extract(payload: dict[str, Any], user_id: uuid.UUID | None) -> None:
    from memory.extractor import extract_and_store
    if user_id is None:
        return
    async with SessionLocal() as db:
        saved = await extract_and_store(db, user_id, payload["user_text"], payload.get("assistant_text", ""),
                                        payload.get("source_ref"))
        await db.commit()
    if saved:
        log.info("extracted %d memories", len(saved))


async def process(job: dict[str, Any]) -> None:
    kind, payload, user_id = job["kind"], job["payload"], job["user_id"]
    if kind == "run_task":
        await handle_run_task(payload, job["attempts"], job["max_attempts"])
    elif kind == "execute_approval":
        from orchestration.approvals import execute_approval
        await execute_approval(uuid.UUID(payload["approval_id"]))
    elif kind == "reminder":
        await handle_reminder(payload, user_id)
    elif kind == "memory_extract":
        await handle_memory_extract(payload, user_id)
    elif kind == "index_document":
        from workers.documents import index_document
        await index_document(uuid.UUID(payload["document_id"]))
    else:
        raise ValueError(f"Unknown job kind {kind}")


async def worker_loop(stop: asyncio.Event, slot: int) -> None:
    while not stop.is_set():
        async with SessionLocal() as db:
            job = await queue.claim(db, f"{WORKER_ID}#{slot}")
        if not job:
            try:
                await asyncio.wait_for(stop.wait(), timeout=settings.worker_poll_interval)
            except TimeoutError:
                pass
            continue
        log.info("job %s %s (attempt %s)", job["kind"], job["id"], job["attempts"])
        try:
            await process(job)
            async with SessionLocal() as db:
                await queue.complete(db, job["id"])
        except Exception as exc:  # noqa: BLE001
            log.exception("job %s failed", job["id"])
            async with SessionLocal() as db:
                await queue.fail(db, job["id"], f"{type(exc).__name__}: {exc}", job["attempts"], job["max_attempts"])


async def maintenance_loop(stop: asyncio.Event) -> None:
    from orchestration.graph import setup_checkpointer
    await setup_checkpointer()
    while not stop.is_set():
        try:
            await get_redis().set(HEARTBEAT_KEY, datetime.now(UTC).isoformat(), ex=90)
            async with SessionLocal() as db:
                started = await run_due_schedules(db)
                if started:
                    log.info("started %d scheduled automations", started)
            async with SessionLocal() as db:
                recovered = await queue.recover_stale(db, settings.task_timeout_seconds + 120)
                if recovered:
                    log.warning("requeued %d stale jobs", recovered)
            async with SessionLocal() as db:
                # Expire stale approvals
                from database.models import Approval, ApprovalStatus
                rows = (await db.execute(select(Approval).where(Approval.status == ApprovalStatus.PENDING,
                                                                Approval.expires_at < datetime.now(UTC)))).scalars().all()
                for a in rows:
                    a.status = ApprovalStatus.EXPIRED
                await db.commit()
        except Exception:  # noqa: BLE001
            log.exception("maintenance iteration failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=20)
        except TimeoutError:
            pass


async def main() -> None:
    configure_logging()
    import agents.tools  # noqa: F401  - register tools
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    log.info("LEXA worker %s starting with %d slots", WORKER_ID, settings.worker_concurrency)
    await asyncio.gather(maintenance_loop(stop), *[worker_loop(stop, i) for i in range(settings.worker_concurrency)])
    log.info("worker stopped")


if __name__ == "__main__":
    asyncio.run(main())
