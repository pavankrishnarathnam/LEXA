"""Token/cost accounting and budget enforcement."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select

from core.config import settings
from core.llm.pricing import cost_usd
from core.llm.types import Usage
from database.models import UsageRecord, User
from database.session import SessionLocal


async def record_usage(
    *,
    user_id: uuid.UUID | None,
    provider: str,
    model: str,
    usage: Usage,
    purpose: str,
    task_id: uuid.UUID | None = None,
    agent_slug: str | None = None,
    latency_ms: int = 0,
    success: bool = True,
    error: str | None = None,
    request_id: str | None = None,
    fallback_used: bool = False,
) -> float:
    cost = cost_usd(model, usage)
    async with SessionLocal() as db:
        db.add(UsageRecord(
            user_id=user_id, task_id=task_id, agent_slug=agent_slug, provider=provider, model=model,
            purpose=purpose, input_tokens=usage.input_tokens, output_tokens=usage.output_tokens,
            cache_read_tokens=usage.cache_read_tokens, cache_write_tokens=usage.cache_write_tokens,
            cost_usd=cost, latency_ms=latency_ms, success=success, error=(error or "")[:2000] or None,
            request_id=request_id, fallback_used=fallback_used,
        ))
        await db.commit()
    return cost


async def month_spend(user_id: uuid.UUID) -> float:
    start = datetime.now(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    async with SessionLocal() as db:
        val = await db.scalar(
            select(func.coalesce(func.sum(UsageRecord.cost_usd), 0)).where(
                UsageRecord.user_id == user_id, UsageRecord.created_at >= start)
        )
    return float(val or 0)


async def budget_for(user_id: uuid.UUID) -> float:
    async with SessionLocal() as db:
        user = await db.get(User, user_id)
    if user and isinstance(user.settings, dict) and user.settings.get("monthly_budget_usd") is not None:
        return float(user.settings["monthly_budget_usd"])
    return settings.monthly_budget_usd


class BudgetExceeded(Exception):
    pass


async def ensure_budget(user_id: uuid.UUID | None) -> None:
    if user_id is None:
        return
    spent, budget = await month_spend(user_id), await budget_for(user_id)
    if budget > 0 and spent >= budget:
        raise BudgetExceeded(
            f"Monthly AI budget of ${budget:.2f} reached (spent ${spent:.2f}). Raise it in Settings → Usage.")
