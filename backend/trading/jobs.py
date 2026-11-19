"""The trading desk's analyses as background jobs, so they run with no AI model and no request stays open.

The desk (``/api/trading``) runs the same trader tools the Trader agent uses, straight from a button: no planner,
no agent, no OpenAI call, no cost. A scan can take minutes, so a request only *starts* a job; the page polls it.

State lives in Redis, keyed by user id, so every API process sees it and nobody can read another user's jobs:

* ``lexa:trading:job:<user>:<job>``  the job record (24 hours)
* ``lexa:trading:jobs:<user>``       the user's recent job ids, newest last (a sorted set, trimmed)
* ``lexa:trading:stop:<user>:<job>`` a flag set by "Stop"; the process running the job watches it

Only read-only analysis tools can be started here. Changing the user's rules and SEC contact has its own
endpoints, and no tool in this module can place an order (there is no such tool).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import time
import uuid
from typing import Any

from agents.runner import TOOL_TIMEOUT
from agents.tools import TOOLS
from agents.tools.base import ToolContext, validate_args
from core.logging import get_logger
from core.redis import get_redis
from database.session import SessionLocal

log = get_logger(__name__)

JOB_TTL = 24 * 3600          # how long a finished result stays available
KEEP = 30                    # recent jobs remembered per user
MAX_RUNNING = 3              # analyses one user can have running at once
MAX_CONTENT = 60_000         # characters stored per result
STALE_GRACE = 120            # seconds past a tool's time limit before a "running" job is declared interrupted
# Tools the desk must never start: changing rules is a separate, explicit endpoint.
_NOT_FROM_THE_DESK = {"trader_set_rules", "trader_get_rules"}

_TASKS: set[asyncio.Task[None]] = set()  # keeps background jobs alive until they finish


class JobError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status, self.message = status, message


def allowed_tools() -> list[str]:
    return sorted(n for n in TOOLS if n.startswith("trader_") and n not in _NOT_FROM_THE_DESK)


def _job_key(user_id: uuid.UUID, job_id: str) -> str:
    return f"lexa:trading:job:{user_id}:{job_id}"


def _index_key(user_id: uuid.UUID) -> str:
    return f"lexa:trading:jobs:{user_id}"


def _stop_key(user_id: uuid.UUID, job_id: str) -> str:
    return f"lexa:trading:stop:{user_id}:{job_id}"


def _limit_for(tool: str) -> int:
    return TOOLS[tool].timeout or TOOL_TIMEOUT


async def _save(rec: dict[str, Any]) -> None:
    await get_redis().set(_job_key(uuid.UUID(rec["user_id"]), rec["id"]), json.dumps(rec), ex=JOB_TTL)


def public(rec: dict[str, Any]) -> dict[str, Any]:
    """The record as the client sees it (without the owner's id)."""
    return {k: v for k, v in rec.items() if k != "user_id"}


def _settle_if_stale(rec: dict[str, Any]) -> dict[str, Any]:
    """A job whose process died (restart, crash) would say 'running' forever: say what happened instead."""
    if rec["status"] == "running" and time.time() - rec["started_at"] > _limit_for(rec["tool"]) + STALE_GRACE:
        rec.update(status="error", is_error=True, finished_at=time.time(),
                   content="This analysis was interrupted (the server restarted). Run it again.")
    return rec


async def get_job(user_id: uuid.UUID, job_id: str) -> dict[str, Any] | None:
    raw = await get_redis().get(_job_key(user_id, job_id))
    if not raw:
        return None
    rec = json.loads(raw)
    was = rec["status"]
    rec = _settle_if_stale(rec)
    if rec["status"] != was:
        await _save(rec)
    return rec


async def _recent(user_id: uuid.UUID) -> list[dict[str, Any]]:
    """The user's recent jobs, newest first. Ids whose record has expired are dropped from the index."""
    r = get_redis()
    ids = [str(i) for i in await r.zrevrange(_index_key(user_id), 0, KEEP - 1)]
    if not ids:
        return []
    raws = await r.mget([_job_key(user_id, i) for i in ids])
    out: list[dict[str, Any]] = []
    for jid, raw in zip(ids, raws, strict=True):
        if raw is None:
            await r.zrem(_index_key(user_id), jid)
        else:
            out.append(_settle_if_stale(json.loads(raw)))
    return out


async def list_jobs(user_id: uuid.UUID, limit: int = 20) -> list[dict[str, Any]]:
    keep = ("id", "tool", "status", "is_error", "started_at", "finished_at")
    return [{k: j[k] for k in keep} for j in (await _recent(user_id))[:limit]]


async def latest_job(user_id: uuid.UUID, tool: str) -> dict[str, Any] | None:
    for rec in await _recent(user_id):
        if rec["tool"] == tool:
            return rec
    return None


async def start_job(user_id: uuid.UUID, tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
    if tool_name not in allowed_tools():
        raise JobError(404, f"'{tool_name}' is not an analysis the trading desk can run")
    if (problem := validate_args(TOOLS[tool_name], args)) is not None:
        raise JobError(422, problem)
    if sum(1 for j in await _recent(user_id) if j["status"] == "running") >= MAX_RUNNING:
        raise JobError(429, "Several analyses are already running. Wait for one to finish, or stop it.")
    now = time.time()
    rec: dict[str, Any] = {"id": uuid.uuid4().hex, "user_id": str(user_id), "tool": tool_name, "args": args,
                           "status": "running", "content": "", "is_error": False, "untrusted": False, "data": {},
                           "started_at": now, "finished_at": None, "seconds": None}
    r = get_redis()
    await _save(rec)
    await r.zadd(_index_key(user_id), {rec["id"]: now})
    await r.zremrangebyrank(_index_key(user_id), 0, -(KEEP + 1))
    await r.expire(_index_key(user_id), JOB_TTL)
    task = asyncio.create_task(_execute(rec))
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return rec


async def stop_job(user_id: uuid.UUID, job_id: str) -> bool:
    rec = await get_job(user_id, job_id)
    if rec is None:
        return False
    if rec["status"] == "running":
        await get_redis().set(_stop_key(user_id, job_id), "1", ex=3600)
    return True


async def _watch_for_stop(user_id: uuid.UUID, job_id: str, work: asyncio.Future[Any], stopped: list[bool]) -> None:
    r = get_redis()
    while not work.done():
        await asyncio.sleep(1.0)
        if await r.get(_stop_key(user_id, job_id)):
            stopped.append(True)
            work.cancel()
            return


async def _execute(rec: dict[str, Any]) -> None:
    user_id, job_id, tool = uuid.UUID(rec["user_id"]), rec["id"], TOOLS[rec["tool"]]
    limit = _limit_for(rec["tool"])
    stopped: list[bool] = []
    outcome: dict[str, Any]
    try:
        async with SessionLocal() as db:
            ctx = ToolContext(db=db, user_id=user_id, agent_slug="trading-desk")
            work = asyncio.ensure_future(tool.handler(ctx, rec["args"]))
            watcher = asyncio.ensure_future(_watch_for_stop(user_id, job_id, work, stopped))
            try:
                result = await asyncio.wait_for(work, limit)
            finally:
                watcher.cancel()
        outcome = {"status": "error" if result.is_error else "done", "is_error": result.is_error,
                   "content": result.content[:MAX_CONTENT], "untrusted": bool(result.untrusted_source),
                   "data": result.data}
    except asyncio.CancelledError:
        if not stopped:  # the server is shutting down, not the user pressing Stop
            rec.update(status="error", is_error=True, finished_at=time.time(),
                       content="This analysis was interrupted (the server stopped). Run it again.")
            with contextlib.suppress(Exception):
                await asyncio.shield(_save(rec))
            raise
        outcome = {"status": "cancelled", "is_error": False, "content": "Stopped.", "untrusted": False, "data": {}}
    except TimeoutError:
        outcome = {"status": "error", "is_error": True, "untrusted": False, "data": {},
                   "content": f"Stopped after {limit} seconds. Try fewer symbols or a narrower request."}
    except Exception as exc:  # noqa: BLE001 - one failed analysis must never take the server down
        log.exception("trading job %s (%s) failed", job_id, rec["tool"])
        outcome = {"status": "error", "is_error": True, "untrusted": False, "data": {},
                   "content": f"The analysis failed unexpectedly ({type(exc).__name__}). Nothing was changed."}
    now = time.time()
    rec.update(outcome, finished_at=now, seconds=round(now - rec["started_at"], 1))
    await _save(rec)
    with contextlib.suppress(Exception):
        await get_redis().delete(_stop_key(user_id, job_id))
