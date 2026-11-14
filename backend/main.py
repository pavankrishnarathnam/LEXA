"""LEXA API entrypoint."""
from __future__ import annotations

import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import agents.tools  # noqa: F401  (register tools)
from agents.registry import seed_builtin_agents
from api.routes import (
    agents as agents_routes,
)
from api.routes import (
    auth,
    automations,
    career,
    chat,
    documents,
    integrations,
    memory,
    records,
    system,
    tasks,
    voice,
)
from core.config import settings
from core.llm.types import ProviderNotConfigured
from core.llm.usage import BudgetExceeded
from core.logging import configure_logging, get_logger
from database.session import SessionLocal

log = get_logger("lexa.api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    problems = settings.validate_production()
    if problems:
        raise RuntimeError("Unsafe production configuration: " + "; ".join(problems))
    async with SessionLocal() as db:
        await seed_builtin_agents(db)
        await db.commit()
    log.info("LEXA API ready (env=%s)", settings.environment)
    yield


app = FastAPI(title="LEXA API", version="0.1.0", lifespan=lifespan,
              docs_url=None if settings.is_production else "/api/docs", openapi_url="/api/openapi.json")
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
                   allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
                   allow_headers=["Content-Type", "X-CSRF-Token", "Authorization", "X-Lexa-Secret"])

MAX_BODY = (settings.max_upload_mb + 1) * 1024 * 1024


@app.middleware("http")
async def security_middleware(request: Request, call_next):
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
    cl = request.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > MAX_BODY:
        return JSONResponse({"detail": "Request body too large"}, status_code=413)
    started = time.monotonic()
    response = await call_next(request)
    response.headers["X-Request-ID"] = rid
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    if "cache-control" not in response.headers:
        response.headers["Cache-Control"] = "no-store"
    if request.url.path not in ("/api/health", "/api/events"):
        log.info("%s %s %s %dms rid=%s", request.method, request.url.path, response.status_code,
                 int((time.monotonic() - started) * 1000), rid)
    return response


@app.exception_handler(BudgetExceeded)
async def budget_handler(_: Request, exc: BudgetExceeded) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=402)


@app.exception_handler(ProviderNotConfigured)
async def provider_handler(_: Request, exc: ProviderNotConfigured) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=503)


for r in (auth, chat, documents, agents_routes, tasks, memory, integrations, automations, career, records, system, voice):
    app.include_router(r.router)
