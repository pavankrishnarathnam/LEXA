"""Redis client, pub/sub event bus and sliding-window rate limiter."""
from __future__ import annotations

import json
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

import redis.asyncio as aioredis

from core.config import settings
from core.logging import get_logger

log = get_logger(__name__)
_client: aioredis.Redis | None = None


def get_redis() -> aioredis.Redis:
    global _client
    if _client is None:
        _client = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _client


def user_channel(user_id: uuid.UUID | str) -> str:
    return f"lexa:events:{user_id}"


async def publish_event(user_id: uuid.UUID | str, event: str, data: dict[str, Any]) -> None:
    """Best-effort realtime event. Durable state always lives in Postgres."""
    try:
        await get_redis().publish(user_channel(user_id), json.dumps({"event": event, "data": data}, default=str))
    except Exception as exc:  # pragma: no cover - redis outage must not break execution
        log.warning("event publish failed: %s", exc)


async def subscribe(user_id: uuid.UUID | str) -> AsyncIterator[dict[str, Any]]:
    pubsub = get_redis().pubsub()
    await pubsub.subscribe(user_channel(user_id))
    try:
        while True:
            msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=15.0)
            if msg is None:
                yield {"event": "ping", "data": {}}
                continue
            yield json.loads(msg["data"])
    finally:
        await pubsub.unsubscribe(user_channel(user_id))
        await pubsub.aclose()


async def rate_limit(key: str, limit: int, window_seconds: int = 60) -> tuple[bool, int]:
    """Sliding-window limiter. Returns (allowed, retry_after_seconds). Fails open if Redis is down."""
    try:
        r = get_redis()
        now = time.time()
        bucket = f"lexa:rl:{key}"
        async with r.pipeline(transaction=True) as pipe:
            pipe.zremrangebyscore(bucket, 0, now - window_seconds)
            pipe.zadd(bucket, {f"{now}:{uuid.uuid4().hex[:6]}": now})
            pipe.zcard(bucket)
            pipe.expire(bucket, window_seconds)
            _, _, count, _ = await pipe.execute()
        if count > limit:
            return False, window_seconds
        return True, 0
    except Exception as exc:  # pragma: no cover
        log.warning("rate limiter unavailable: %s", exc)
        return True, 0
