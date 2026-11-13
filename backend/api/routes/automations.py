from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy import select

from api.deps import DB, CurrentUser
from api.schemas import AutomationIn
from api.serializers import iso, task_out
from core.audit import audit
from core.redis import rate_limit
from database.models import AutomationWorkflow, Task
from workers.automation import start_workflow_run
from workers.scheduler import next_run

router = APIRouter(prefix="/api/automations", tags=["automations"])


def wf_out(w: AutomationWorkflow) -> dict:
    return {"id": str(w.id), "name": w.name, "description": w.description, "trigger_type": w.trigger_type,
            "cron": w.cron, "timezone": w.timezone, "event_name": w.event_name, "conditions": w.conditions,
            "instruction": w.instruction, "agent_slug": w.agent_slug, "enabled": w.enabled,
            "next_run_at": iso(w.next_run_at), "last_run_at": iso(w.last_run_at), "last_status": w.last_status,
            "run_count": w.run_count, "created_at": iso(w.created_at),
            "webhook_path": f"/api/automations/{w.id}/webhook" if w.trigger_type == "webhook" else None}


def _validate(body: AutomationIn) -> None:
    if body.trigger_type == "schedule":
        if not body.cron:
            raise HTTPException(422, "cron is required for schedule triggers")
        try:
            next_run(body.cron, body.timezone)
        except (ValueError, KeyError) as exc:
            raise HTTPException(422, str(exc)) from exc
    if body.trigger_type == "event" and not body.event_name:
        raise HTTPException(422, "event_name is required for event triggers")


@router.get("")
async def list_workflows(user: CurrentUser, db: DB) -> list[dict]:
    rows = (await db.execute(select(AutomationWorkflow).where(AutomationWorkflow.user_id == user.id)
                             .order_by(AutomationWorkflow.created_at.desc()))).scalars()
    return [wf_out(w) for w in rows]


@router.post("", status_code=201)
async def create_workflow(body: AutomationIn, user: CurrentUser, db: DB) -> dict:
    _validate(body)
    wf = AutomationWorkflow(user_id=user.id, **body.model_dump())
    secret = None
    if body.trigger_type == "schedule":
        wf.next_run_at = next_run(body.cron or "", body.timezone)
    if body.trigger_type == "webhook":
        secret = secrets.token_urlsafe(24)
        wf.webhook_secret_hash = hashlib.sha256(secret.encode()).hexdigest()
    db.add(wf)
    await db.flush()
    await audit(db, user_id=user.id, action="automation.create", category="automation", target_id=wf.id)
    return {**wf_out(wf), "webhook_secret": secret}


async def _wf(db: DB, user_id: uuid.UUID, wid: uuid.UUID) -> AutomationWorkflow:
    w = await db.scalar(select(AutomationWorkflow).where(AutomationWorkflow.id == wid,
                                                         AutomationWorkflow.user_id == user_id))
    if not w:
        raise HTTPException(404, "Automation not found")
    return w


@router.put("/{wid}")
async def update_workflow(wid: uuid.UUID, body: AutomationIn, user: CurrentUser, db: DB) -> dict:
    _validate(body)
    w = await _wf(db, user.id, wid)
    for k, v in body.model_dump().items():
        setattr(w, k, v)
    w.next_run_at = next_run(body.cron or "", body.timezone) if body.trigger_type == "schedule" else None
    return wf_out(w)


@router.post("/{wid}/toggle")
async def toggle(wid: uuid.UUID, user: CurrentUser, db: DB) -> dict:
    w = await _wf(db, user.id, wid)
    w.enabled = not w.enabled
    if w.enabled and w.trigger_type == "schedule" and w.cron:
        w.next_run_at = next_run(w.cron, w.timezone)
    await audit(db, user_id=user.id, action=f"automation.{'resume' if w.enabled else 'pause'}",
                category="automation", target_id=wid)
    return wf_out(w)


@router.post("/{wid}/run", status_code=202)
async def run_now(wid: uuid.UUID, user: CurrentUser, db: DB) -> dict:
    w = await _wf(db, user.id, wid)
    task = await start_workflow_run(db, w, "manual")
    return task_out(task)


@router.get("/{wid}/runs")
async def runs(wid: uuid.UUID, user: CurrentUser, db: DB) -> list[dict]:
    await _wf(db, user.id, wid)
    rows = (await db.execute(select(Task).where(Task.workflow_id == wid).order_by(Task.created_at.desc())
                             .limit(50))).scalars()
    return [task_out(t) for t in rows]


@router.delete("/{wid}", status_code=204)
async def delete_workflow(wid: uuid.UUID, user: CurrentUser, db: DB) -> Response:
    w = await _wf(db, user.id, wid)
    await db.delete(w)
    await audit(db, user_id=user.id, action="automation.delete", category="automation", target_id=wid)
    return Response(status_code=204)


@router.post("/{wid}/webhook", status_code=202)
async def webhook(wid: uuid.UUID, request: Request, db: DB, x_lexa_secret: str | None = Header(None)) -> dict:
    """Inbound trigger (e.g. from n8n). Authenticated by the per-workflow secret."""
    allowed, _ = await rate_limit(f"webhook:{wid}", 30)
    if not allowed:
        raise HTTPException(429, "Too many webhook calls")
    w = await db.get(AutomationWorkflow, wid)
    if not w or w.trigger_type != "webhook" or not w.enabled or not w.webhook_secret_hash or not x_lexa_secret:
        raise HTTPException(404, "Not found")
    if not hmac.compare_digest(hashlib.sha256(x_lexa_secret.encode()).hexdigest(), w.webhook_secret_hash):
        raise HTTPException(404, "Not found")
    try:
        payload = await request.json()
    except ValueError:
        payload = {}
    from workers.automation import conditions_match
    if not conditions_match(w.conditions, payload if isinstance(payload, dict) else {}):
        return {"started": False, "reason": "conditions not met"}
    task = await start_workflow_run(db, w, "webhook", payload if isinstance(payload, dict) else {"body": payload})
    await audit(db, user_id=w.user_id, actor="system", action="automation.webhook", category="automation",
                target_id=wid)
    return {"started": True, "task_id": str(task.id)}
