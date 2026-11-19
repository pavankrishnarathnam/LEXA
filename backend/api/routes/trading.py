"""Trading desk: US-stock analysis from buttons and forms, with no AI model involved.

The Trader agent (chat) and this desk use the very same tools, but the desk calls them directly: no planner, no
agent, no OpenAI request, so it works without an API key or credits. Long analyses run as background jobs that the
page polls. Nothing here can place an order. See docs/TRADING.md.
"""
from __future__ import annotations

import shutil
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from api.deps import DB, CurrentUser
from core.audit import audit
from core.config import settings
from trading import config as rules
from trading import jobs
from trading.output import clean_output
from trading.runner import TraderError, run_script, sec_identity_ok, workspace

router = APIRouter(prefix="/api/trading", tags=["trading"])

FIXED = ["Paper trading only", "Long side only", "No options, margin or short selling",
         "LEXA never places an order: you make every trade yourself, at your own broker"]


class JobIn(BaseModel):
    tool: str = Field(max_length=60)
    args: dict[str, Any] = Field(default_factory=dict)


class RulesIn(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict)
    reset: list[str] = Field(default_factory=list, max_length=30)


class ContactIn(BaseModel):
    value: str | None = Field(default=None, max_length=200)


def _work(user_id: uuid.UUID) -> Path:
    try:
        return workspace(user_id)
    except TraderError as exc:
        raise HTTPException(503, str(exc)) from exc


def _contact_state(user_id: uuid.UUID) -> dict[str, Any]:
    own = rules.load_sec_contact(_work(user_id))
    server = sec_identity_ok(settings.trader_sec_user_agent)
    return {"value": own, "source": "you" if own else "server" if server else None, "configured": bool(own) or server}


def _rules_state(user_id: uuid.UUID) -> dict[str, Any]:
    try:
        stored = rules.load_rules(_work(user_id))
    except TraderError as exc:
        raise HTTPException(503, str(exc)) from exc
    return {"rules": rules.describe(stored), "missing": rules.missing_for_sizing(stored), "fixed": FIXED}


@router.get("/status")
async def status(user: CurrentUser) -> dict[str, Any]:
    """What the desk needs to draw itself: market state, the user's rules, SEC contact and what is installed."""
    market: dict[str, Any] = {"text": None, "open": None}
    try:
        res = await run_script(user.id, "alerts.py", "clock", time_limit=30)
        text = clean_output(res.stdout).strip()
        if text and not res.crashed:
            market = {"text": text, "open": True if "NYSE OPEN" in text else False if "NYSE closed" in text else None}
    except TraderError:
        pass
    return {"llm_required": False, "market": market, **_rules_state(user.id),
            "sec_contact": _contact_state(user.id), "pdftotext": shutil.which("pdftotext") is not None,
            "tools": jobs.allowed_tools()}


@router.get("/rules")
async def get_rules(user: CurrentUser) -> dict[str, Any]:
    return _rules_state(user.id)


@router.put("/rules")
async def put_rules(body: RulesIn, request: Request, user: CurrentUser, db: DB) -> dict[str, Any]:
    """Save the user's own limits. This is the user acting in their own settings, so unlike the agent's
    ``trader_set_rules`` (always approved by the user first) it saves directly."""
    try:
        rules.save_rules(_work(user.id), body.values, body.reset)
    except rules.RuleError as exc:
        raise HTTPException(422, str(exc)) from exc
    except TraderError as exc:
        raise HTTPException(503, str(exc)) from exc
    await audit(db, user_id=user.id, action="trading.rules.update", category="trading", ip=_ip(request),
                details={"values": body.values, "reset": body.reset})
    return _rules_state(user.id)


@router.put("/sec-contact")
async def put_sec_contact(body: ContactIn, request: Request, user: CurrentUser, db: DB) -> dict[str, Any]:
    try:
        rules.save_sec_contact(_work(user.id), body.value)
    except rules.RuleError as exc:
        raise HTTPException(422, str(exc)) from exc
    await audit(db, user_id=user.id, action="trading.sec_contact.update", category="trading", ip=_ip(request),
                details={"set": bool(body.value and body.value.strip())})
    return _contact_state(user.id)


@router.post("/jobs", status_code=202)
async def start_job(body: JobIn, user: CurrentUser) -> dict[str, Any]:
    try:
        rec = await jobs.start_job(user.id, body.tool, body.args)
    except jobs.JobError as exc:
        raise HTTPException(exc.status, exc.message) from exc
    return jobs.public(rec)


@router.get("/jobs")
async def list_jobs(user: CurrentUser, limit: int = Query(20, ge=1, le=30)) -> list[dict[str, Any]]:
    return await jobs.list_jobs(user.id, limit)


# `latest` is declared before `{job_id}` so it is not read as a job id.
@router.get("/jobs/latest")
async def latest_job(user: CurrentUser, tool: str = Query(max_length=60)) -> dict[str, Any]:
    rec = await jobs.latest_job(user.id, tool)
    if rec is None:
        raise HTTPException(404, "No earlier result")
    return jobs.public(rec)


@router.get("/jobs/{job_id}")
async def get_job(job_id: str, user: CurrentUser) -> dict[str, Any]:
    rec = await jobs.get_job(user.id, job_id) if len(job_id) <= 64 else None
    if rec is None:
        raise HTTPException(404, "Result not found (results are kept for 24 hours)")
    return jobs.public(rec)


@router.delete("/jobs/{job_id}", status_code=204)
async def stop_job(job_id: str, user: CurrentUser) -> Response:
    if len(job_id) > 64 or not await jobs.stop_job(user.id, job_id):
        raise HTTPException(404, "Result not found")
    return Response(status_code=204)


def _ip(request: Request) -> str | None:
    return request.client.host if request.client else None
