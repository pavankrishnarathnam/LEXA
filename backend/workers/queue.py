"""Durable Postgres job queue (FOR UPDATE SKIP LOCKED)."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from database.models import Job, JobStatus


async def enqueue(db: AsyncSession, kind: str, payload: dict[str, Any], *, user_id: uuid.UUID | None = None,
                  run_at: datetime | None = None, max_attempts: int = 3) -> Job:
    job = Job(kind=kind, payload=payload, user_id=user_id, run_at=run_at or datetime.now(UTC),
              status=JobStatus.QUEUED, max_attempts=max_attempts)
    db.add(job)
    await db.flush()
    return job


CLAIM_SQL = text("""
UPDATE jobs SET status = 'running', locked_by = :worker, locked_at = now(), attempts = attempts + 1,
                updated_at = now()
WHERE id = (
  SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now()
  ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1
)
RETURNING id, kind, payload, user_id, attempts, max_attempts
""")


async def claim(db: AsyncSession, worker_id: str) -> dict[str, Any] | None:
    row = (await db.execute(CLAIM_SQL, {"worker": worker_id})).mappings().first()
    await db.commit()
    return dict(row) if row else None


async def complete(db: AsyncSession, job_id: uuid.UUID) -> None:
    await db.execute(text("UPDATE jobs SET status='done', updated_at=now(), locked_by=NULL WHERE id=:id"),
                     {"id": job_id})
    await db.commit()


async def fail(db: AsyncSession, job_id: uuid.UUID, error: str, attempts: int, max_attempts: int) -> bool:
    """Returns True if the job will be retried."""
    retry = attempts < max_attempts
    await db.execute(text("""UPDATE jobs SET status=:s, last_error=:e, locked_by=NULL, updated_at=now(),
                             run_at=:r WHERE id=:id"""),
                     {"s": "queued" if retry else "failed", "e": error[:4000], "id": job_id,
                      "r": datetime.now(UTC) + timedelta(seconds=min(300, 10 * 2 ** attempts))})
    await db.commit()
    return retry


async def recover_stale(db: AsyncSession, older_than_seconds: int) -> int:
    res = await db.execute(text("""UPDATE jobs SET status='queued', locked_by=NULL, updated_at=now()
                                   WHERE status='running' AND locked_at < now() - make_interval(secs => :s)"""),
                           {"s": older_than_seconds})
    await db.commit()
    return res.rowcount or 0
