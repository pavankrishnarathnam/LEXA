from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from database.models import AuditLog, Notification


async def audit(
    db: AsyncSession,
    *,
    user_id: uuid.UUID | None,
    action: str,
    actor: str = "user",
    category: str = "general",
    target_type: str | None = None,
    target_id: str | uuid.UUID | None = None,
    success: bool = True,
    details: dict[str, Any] | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
) -> None:
    db.add(
        AuditLog(
            user_id=user_id,
            actor=actor,
            action=action,
            category=category,
            target_type=target_type,
            target_id=str(target_id) if target_id else None,
            success=success,
            details=details or {},
            ip_address=ip,
            user_agent=(user_agent or "")[:300] or None,
        )
    )


async def notify(
    db: AsyncSession,
    user_id: uuid.UUID,
    kind: str,
    title: str,
    body: str = "",
    link: str | None = None,
    severity: str = "info",
) -> Notification:
    from core.redis import publish_event

    n = Notification(user_id=user_id, kind=kind, title=title[:300], body=body, link=link, severity=severity)
    db.add(n)
    await db.flush()
    await publish_event(user_id, "notification", {"id": str(n.id), "title": n.title, "kind": kind, "severity": severity})
    return n
