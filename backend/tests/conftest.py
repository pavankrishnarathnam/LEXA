from __future__ import annotations

import os
import tempfile

_TMP = tempfile.mkdtemp(prefix="lexa-test-")
os.environ.update({
    "DATABASE_URL": os.environ.get("TEST_DATABASE_URL", "postgresql+asyncpg://lexa:lexa@127.0.0.1:5432/lexa_test"),
    "REDIS_URL": os.environ.get("TEST_REDIS_URL", "redis://127.0.0.1:6379/15"),
    "ENVIRONMENT": "test", "ANTHROPIC_API_KEY": "", "OPENAI_API_KEY": "",
    "DEFAULT_MODEL": "test-model", "FAST_MODEL": "test-fast", "FALLBACK_MODEL": "test-fallback",
    "JWT_SECRET": "test-secret-0123456789-0123456789-0123456789", "RATE_LIMIT_PER_MINUTE": "10000", "AUTH_RATE_LIMIT": "10000",
    "UPLOAD_DIR": os.path.join(_TMP, "uploads"), "TRADER_DATA_DIR": os.path.join(_TMP, "trader"),
    "MODEL_PRICING_JSON": '{"test-model": [1.0, 5.0], "test-fallback": [1.0, 5.0], "test-fast": [0.1, 0.5]}', "BACKUP_STATUS_FILE": os.path.join(_TMP, "backup.json"),
})

import asyncio  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import uuid  # noqa: E402
from typing import Any  # noqa: E402

import httpx  # noqa: E402
import psycopg  # noqa: E402
import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402

from core.llm.router import register_provider  # noqa: E402
from tests.scripted_provider import STATE, ScriptedSession, scripted_stream  # noqa: E402

register_provider("scripted", "test-", ScriptedSession, scripted_stream)


def _reset_db() -> None:
    admin = os.environ["DATABASE_URL"].replace("+asyncpg", "").rsplit("/", 1)[0] + "/postgres"
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute("DROP DATABASE IF EXISTS lexa_test WITH (FORCE)")
        conn.execute("CREATE DATABASE lexa_test")
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], check=True, cwd=os.path.dirname(os.path.dirname(__file__)),
                   env=os.environ.copy(), capture_output=True)


@pytest.fixture(scope="session", autouse=True)
def database() -> None:
    _reset_db()


@pytest_asyncio.fixture(scope="session", autouse=True)
async def app_ready(database):
    from agents.registry import seed_builtin_agents
    from core.redis import get_redis
    from database.session import SessionLocal
    from orchestration.graph import setup_checkpointer
    await get_redis().flushdb()
    async with SessionLocal() as db:
        await seed_builtin_agents(db)
        await db.commit()
    await setup_checkpointer()
    yield


@pytest.fixture(autouse=True)
def reset_script():
    STATE["script"] = None
    STATE["fail_models"] = set()
    STATE["no_credit_models"] = set()
    STATE["calls"] = []
    yield


class Client:
    """Test client that behaves like the browser: cookies + CSRF header."""

    def __init__(self, http: httpx.AsyncClient):
        self.http = http

    def _h(self) -> dict[str, str]:
        tok = self.http.cookies.get("lexa_csrf")
        return {"X-CSRF-Token": tok} if tok else {}

    async def get(self, url: str, **kw: Any) -> httpx.Response:
        return await self.http.get(url, **kw)

    async def post(self, url: str, **kw: Any) -> httpx.Response:
        return await self.http.post(url, headers=self._h(), **kw)

    async def patch(self, url: str, **kw: Any) -> httpx.Response:
        return await self.http.patch(url, headers=self._h(), **kw)

    async def put(self, url: str, **kw: Any) -> httpx.Response:
        return await self.http.put(url, headers=self._h(), **kw)

    async def delete(self, url: str, **kw: Any) -> httpx.Response:
        return await self.http.delete(url, headers=self._h(), **kw)


async def make_client(email: str | None = None) -> Client:
    from main import app
    http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")
    c = Client(http)
    r = await c.post("/api/auth/register", json={"email": email or f"u{uuid.uuid4().hex[:8]}@example.com",
                                                 "password": "correct-horse-battery", "full_name": "Test User"})
    assert r.status_code == 201, r.text
    return c


@pytest_asyncio.fixture
async def client() -> Client:
    return await make_client()


async def drain_jobs(max_jobs: int = 50) -> int:
    """Run queued jobs inline (what the worker process does)."""
    from database.session import SessionLocal
    from workers import queue
    from workers.main import process
    n = 0
    for _ in range(max_jobs):
        async with SessionLocal() as db:
            await db.execute(__import__("sqlalchemy").text("UPDATE jobs SET run_at = now() WHERE status='queued'"))
            await db.commit()
            job = await queue.claim(db, "test-worker")
        if not job:
            break
        try:
            await process(job)
            async with SessionLocal() as db:
                await queue.complete(db, job["id"])
        except Exception as exc:  # noqa: BLE001
            async with SessionLocal() as db:
                await queue.fail(db, job["id"], str(exc), job["attempts"], job["max_attempts"])
        n += 1
        await asyncio.sleep(0)
    return n
