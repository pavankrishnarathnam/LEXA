from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Response
from sqlalchemy import Date, cast, func, select, text, update

from agents.registry import list_agents
from api.deps import DB, CurrentUser
from api.serializers import approval_out, iso, task_out
from core.audit import audit
from core.config import settings
from core.llm.usage import budget_for, month_spend
from core.redis import get_redis
from database.models import (
    Approval,
    ApprovalStatus,
    AuditLog,
    AutomationWorkflow,
    Contact,
    Conversation,
    DeploymentRecord,
    Document,
    FinanceEntry,
    Integration,
    JobApplication,
    JobOpportunity,
    Memory,
    Message,
    Notification,
    Project,
    Task,
    TaskStatus,
    UsageRecord,
    UserProfile,
)
from database.session import SessionLocal
from integrations.service import IntegrationError, get_credentials

router = APIRouter(tags=["system"])
VERSION = __import__("os").environ.get("APP_VERSION", "0.1.0")


@router.get("/api/health")
async def live() -> dict:
    return {"status": "ok", "version": VERSION, "time": datetime.now(UTC).isoformat()}


@router.get("/api/health/ready")
async def ready(response: Response) -> dict:
    checks: dict[str, dict] = {}
    try:
        async with SessionLocal() as db:
            await db.execute(text("SELECT 1"))
            ver = await db.scalar(text("SELECT version_num FROM alembic_version"))
        checks["database"] = {"ok": True, "migration": ver}
    except Exception as exc:  # noqa: BLE001
        checks["database"] = {"ok": False, "error": type(exc).__name__}
    try:
        r = get_redis()
        await r.ping()
        hb = await r.get("lexa:worker:heartbeat")
        checks["redis"] = {"ok": True}
        age = (datetime.now(UTC) - datetime.fromisoformat(str(hb))).total_seconds() if hb else None
        checks["worker"] = {"ok": age is not None and age < 90, "last_heartbeat_seconds": age}
    except Exception as exc:  # noqa: BLE001
        checks["redis"] = {"ok": False, "error": type(exc).__name__}
        checks["worker"] = {"ok": False}
    checks["ai_provider"] = {"ok": bool(settings.anthropic_api_key or settings.openai_api_key),
                             "anthropic": bool(settings.anthropic_api_key), "openai": bool(settings.openai_api_key)}
    core_ok = checks["database"]["ok"] and checks["redis"]["ok"]
    if not core_ok:
        response.status_code = 503
    return {"status": "ok" if core_ok and checks["worker"]["ok"] else ("degraded" if core_ok else "down"),
            "version": VERSION, "checks": checks}


@router.get("/api/dashboard")
async def dashboard(user: CurrentUser, db: DB) -> dict:
    active = (await db.execute(select(Task).where(Task.user_id == user.id, Task.status.in_([
        TaskStatus.PENDING, TaskStatus.PLANNING, TaskStatus.IN_PROGRESS, TaskStatus.WAITING_FOR_APPROVAL]))
        .order_by(Task.created_at.desc()).limit(8))).scalars().all()
    recent = (await db.execute(select(Task).where(Task.user_id == user.id).order_by(Task.updated_at.desc())
                               .limit(8))).scalars().all()
    approvals = (await db.execute(select(Approval).where(Approval.user_id == user.id,
                                                         Approval.status == ApprovalStatus.PENDING)
                                  .order_by(Approval.created_at.desc()).limit(5))).scalars().all()
    notes = (await db.execute(select(Notification).where(Notification.user_id == user.id)
                              .order_by(Notification.created_at.desc()).limit(8))).scalars().all()
    unread = await db.scalar(select(func.count()).where(Notification.user_id == user.id,
                                                        Notification.read.is_(False)))
    agents = await list_agents(db, user.id)
    busy = {a for t in active for a in (t.assigned_agents or [])}
    schedule: dict = {"connected": False, "events": []}
    try:
        from integrations.providers.google import GoogleClient
        creds = await get_credentials(db, user.id, "google_calendar", actor="dashboard")
        profile = await db.scalar(select(UserProfile).where(UserProfile.user_id == user.id))
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(profile.timezone if profile else "UTC")
        start = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
        events = await GoogleClient(creds["access_token"]).calendar_events(start.isoformat(),
                                                                           (start + timedelta(days=1)).isoformat())
        schedule = {"connected": True, "events": events}
    except IntegrationError:
        pass
    except Exception as exc:  # noqa: BLE001
        schedule = {"connected": True, "events": [], "error": str(exc)[:200]}
    spent, budget = await month_spend(user.id), await budget_for(user.id)
    return {
        "active_tasks": [task_out(t) for t in active], "recent_tasks": [task_out(t) for t in recent],
        "pending_approvals": [approval_out(a) for a in approvals],
        "notifications": [notif_out(n) for n in notes], "unread_notifications": unread or 0,
        "agents": [{"slug": a.slug, "name": a.name, "icon": a.icon, "enabled": a.enabled,
                    "status": "busy" if a.slug in busy else ("ready" if a.enabled else "disabled")} for a in agents],
        "schedule": schedule, "usage": {"month_spend_usd": round(spent, 4), "budget_usd": budget},
        "memory_count": await db.scalar(select(func.count()).where(Memory.user_id == user.id,
                                                                   Memory.source != "document")),
        "providers": {"anthropic": bool(settings.anthropic_api_key), "openai": bool(settings.openai_api_key)},
    }


def notif_out(n: Notification) -> dict:
    return {"id": str(n.id), "kind": n.kind, "title": n.title, "body": n.body, "link": n.link,
            "severity": n.severity, "read": n.read, "created_at": iso(n.created_at)}


@router.get("/api/notifications")
async def notifications(user: CurrentUser, db: DB, unread_only: bool = False) -> list[dict]:
    q = select(Notification).where(Notification.user_id == user.id)
    if unread_only:
        q = q.where(Notification.read.is_(False))
    return [notif_out(n) for n in (await db.execute(q.order_by(Notification.created_at.desc()).limit(100))).scalars()]


@router.post("/api/notifications/read")
async def mark_read(body: dict, user: CurrentUser, db: DB) -> dict:
    q = update(Notification).where(Notification.user_id == user.id)
    if body.get("ids"):
        import uuid
        q = q.where(Notification.id.in_([uuid.UUID(i) for i in body["ids"]]))
    res = await db.execute(q.values(read=True))
    return {"updated": getattr(res, "rowcount", 0)}


@router.get("/api/usage")
async def usage(user: CurrentUser, db: DB, days: int = 30) -> dict:
    since = datetime.now(UTC) - timedelta(days=min(days, 365))
    base = [UsageRecord.user_id == user.id, UsageRecord.created_at >= since]
    day = cast(UsageRecord.created_at, Date)
    by_day = (await db.execute(select(day, func.sum(UsageRecord.cost_usd), func.sum(UsageRecord.input_tokens),
                                      func.sum(UsageRecord.output_tokens), func.count())
                               .where(*base).group_by(day).order_by(day))).all()
    by_model = (await db.execute(select(UsageRecord.provider, UsageRecord.model, func.count(),
                                        func.sum(UsageRecord.cost_usd), func.sum(UsageRecord.input_tokens),
                                        func.sum(UsageRecord.output_tokens),
                                        func.avg(UsageRecord.latency_ms),
                                        func.sum(func.cast(~UsageRecord.success, type_=__import__("sqlalchemy").Integer)))
                                 .where(*base).group_by(UsageRecord.provider, UsageRecord.model))).all()
    by_agent = (await db.execute(select(UsageRecord.agent_slug, func.count(), func.sum(UsageRecord.cost_usd))
                                 .where(*base).group_by(UsageRecord.agent_slug))).all()
    by_purpose = (await db.execute(select(UsageRecord.purpose, func.sum(UsageRecord.cost_usd))
                                   .where(*base).group_by(UsageRecord.purpose))).all()
    fallbacks = await db.scalar(select(func.count()).where(*base, UsageRecord.fallback_used.is_(True)))
    spent, budget = await month_spend(user.id), await budget_for(user.id)
    return {
        "month_spend_usd": round(spent, 4), "budget_usd": budget,
        "budget_used_pct": round(spent / budget * 100, 1) if budget else None, "fallback_calls": fallbacks or 0,
        "by_day": [{"date": str(d), "cost_usd": float(c or 0), "input_tokens": int(i or 0),
                    "output_tokens": int(o or 0), "calls": n} for d, c, i, o, n in by_day],
        "by_model": [{"provider": p, "model": m, "calls": n, "cost_usd": float(c or 0), "input_tokens": int(i or 0),
                      "output_tokens": int(o or 0), "avg_latency_ms": int(lat or 0), "errors": int(e or 0)}
                     for p, m, n, c, i, o, lat, e in by_model],
        "by_agent": [{"agent": a or "system", "calls": n, "cost_usd": float(c or 0)} for a, n, c in by_agent],
        "by_purpose": [{"purpose": p, "cost_usd": float(c or 0)} for p, c in by_purpose],
    }


@router.get("/api/audit")
async def audit_logs(user: CurrentUser, db: DB, category: str | None = None, limit: int = 100,
                     offset: int = 0) -> list[dict]:
    q = select(AuditLog).where(AuditLog.user_id == user.id)
    if category:
        q = q.where(AuditLog.category == category)
    rows = (await db.execute(q.order_by(AuditLog.created_at.desc()).limit(min(limit, 500)).offset(offset))).scalars()
    return [{"id": str(r.id), "at": iso(r.created_at), "actor": r.actor, "action": r.action, "category": r.category,
             "target_type": r.target_type, "target_id": r.target_id, "success": r.success, "ip": r.ip_address,
             "details": r.details} for r in rows]


@router.get("/api/export")
async def export_data(user: CurrentUser, db: DB) -> Response:
    """Full export of the user's data (credentials are never exported)."""
    def rows(model, *cols_excluded: str):
        return select(model).where(model.user_id == user.id)

    def dump(objs, exclude: tuple[str, ...] = ()) -> list[dict]:
        out = []
        for o in objs:
            d = {c.key: getattr(o, c.key) for c in o.__table__.columns if c.key not in exclude}
            out.append(d)
        return out

    data: dict[str, Any] = {"exported_at": datetime.now(UTC).isoformat(), "user": {"email": user.email, "full_name": user.full_name,
                                                                    "settings": user.settings}}
    for name, model, excl in [
        ("profile", UserProfile, ()), ("memories", Memory, ("embedding",)), ("conversations", Conversation, ()),
        ("messages", Message, ()), ("tasks", Task, ()), ("approvals", Approval, ()),
        ("documents", Document, ("storage_path",)), ("automations", AutomationWorkflow, ("webhook_secret_hash",)),
        ("jobs", JobOpportunity, ()), ("applications", JobApplication, ()), ("contacts", Contact, ()),
        ("projects", Project, ()), ("finance", FinanceEntry, ()),
        ("integrations", Integration, ("encrypted_credentials",)),
    ]:
        data[name] = dump((await db.execute(rows(model))).scalars().all(), excl)
    await audit(db, user_id=user.id, action="data.export", category="data")
    return Response(json.dumps(data, default=str, indent=1), media_type="application/json",
                    headers={"Content-Disposition": 'attachment; filename="lexa-export.json"'})


@router.get("/api/deployments")
async def deployments(user: CurrentUser, db: DB) -> list[dict]:
    rows = (await db.execute(select(DeploymentRecord).order_by(DeploymentRecord.created_at.desc()).limit(30))).scalars()
    return [{"version": r.version, "git_sha": r.git_sha, "status": r.status, "details": r.details,
             "at": iso(r.created_at)} for r in rows]


@router.get("/api/system/info")
async def system_info(user: CurrentUser) -> dict:
    return {"version": VERSION, "environment": settings.environment, "default_model": settings.default_model,
            "fast_model": settings.fast_model, "fallback_model": settings.fallback_model,
            "default_effort": settings.default_effort, "embedding_model": settings.embedding_model
            if settings.openai_api_key else "lexa-hash-v1 (local lexical fallback)",
            "server_side_refusal_fallback": settings.anthropic_server_fallback,
            "registration_open": settings.allow_registration}
