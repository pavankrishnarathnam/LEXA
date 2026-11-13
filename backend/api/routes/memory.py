from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from sqlalchemy import delete, func, select

from api.deps import DB, CurrentUser
from api.schemas import MemoryIn, MemoryPatch
from api.serializers import iso
from core.audit import audit
from database.models import Memory
from memory.store import CATEGORIES, MemoryRejected, save_memory, search_memories, update_memory

router = APIRouter(prefix="/api/memory", tags=["memory"])


def mem_out(m: Memory) -> dict:
    return {"id": str(m.id), "category": m.category, "content": m.content, "source": m.source,
            "source_ref": m.source_ref, "importance": m.importance, "confidence": m.confidence, "pinned": m.pinned,
            "embedding_model": m.embedding_model, "created_at": iso(m.created_at), "updated_at": iso(m.updated_at),
            "last_accessed_at": iso(m.last_accessed_at), "expires_at": iso(m.expires_at)}


@router.get("")
async def list_memories(user: CurrentUser, db: DB, category: str | None = None, q: str | None = None,
                        include_documents: bool = False, limit: int = 100, offset: int = 0) -> dict:
    if q:
        return {"items": await search_memories(db, user.id, q, k=25, categories=[category] if category else None),
                "search": True}
    query = select(Memory).where(Memory.user_id == user.id)
    if category:
        query = query.where(Memory.category == category)
    elif not include_documents:
        query = query.where(Memory.source != "document")
    rows = (await db.execute(query.order_by(Memory.pinned.desc(), Memory.updated_at.desc())
                             .limit(min(limit, 500)).offset(offset))).scalars()
    counts = dict((await db.execute(select(Memory.category, func.count()).where(Memory.user_id == user.id)
                                    .group_by(Memory.category))).all())
    return {"items": [mem_out(m) for m in rows], "counts": counts, "categories": CATEGORIES}


@router.post("", status_code=201)
async def create_memory(body: MemoryIn, user: CurrentUser, db: DB) -> dict:
    try:
        res = await save_memory(db, user.id, body.content, category=body.category, source="user",
                                importance=body.importance, pinned=body.pinned)
    except MemoryRejected as exc:
        raise HTTPException(422, str(exc)) from exc
    await audit(db, user_id=user.id, action="memory.create", category="memory", target_type="memory",
                target_id=res.memory.id)
    return {**mem_out(res.memory), "created": res.created, "duplicate_of": str(res.duplicate_of)
            if res.duplicate_of else None}


async def _get(db: DB, user_id: uuid.UUID, mid: uuid.UUID) -> Memory:
    m = await db.scalar(select(Memory).where(Memory.id == mid, Memory.user_id == user_id))
    if not m:
        raise HTTPException(404, "Memory not found")
    return m


@router.patch("/{mid}")
async def patch_memory(mid: uuid.UUID, body: MemoryPatch, user: CurrentUser, db: DB) -> dict:
    m = await _get(db, user.id, mid)
    if body.category and body.category not in CATEGORIES:
        raise HTTPException(422, "Unknown category")
    try:
        await update_memory(db, m, body.content, category=body.category, importance=body.importance,
                            pinned=body.pinned)
    except MemoryRejected as exc:
        raise HTTPException(422, str(exc)) from exc
    await audit(db, user_id=user.id, action="memory.update", category="memory", target_type="memory", target_id=mid)
    return mem_out(m)


@router.delete("/{mid}", status_code=204)
async def delete_memory(mid: uuid.UUID, user: CurrentUser, db: DB) -> Response:
    m = await _get(db, user.id, mid)
    await db.delete(m)
    await audit(db, user_id=user.id, action="memory.delete", category="memory", target_type="memory", target_id=mid)
    return Response(status_code=204)


@router.post("/retention")
async def apply_retention(body: dict, user: CurrentUser, db: DB) -> dict:
    """Delete non-pinned memories older than N days (optionally only extracted ones)."""
    days = int(body.get("older_than_days", 0))
    if days < 1:
        raise HTTPException(422, "older_than_days must be >= 1")
    q = delete(Memory).where(Memory.user_id == user.id, Memory.pinned.is_(False),
                             Memory.updated_at < datetime.now(UTC) - timedelta(days=days))
    if body.get("only_extracted"):
        q = q.where(Memory.source == "extracted")
    res = await db.execute(q)
    await audit(db, user_id=user.id, action="memory.retention", category="memory",
                details={"days": days, "deleted": res.rowcount})
    return {"deleted": res.rowcount}


@router.delete("", status_code=200)
async def delete_all(user: CurrentUser, db: DB, confirm: str = "") -> dict:
    if confirm != "DELETE":
        raise HTTPException(422, "Pass confirm=DELETE to erase all memories")
    res = await db.execute(delete(Memory).where(Memory.user_id == user.id))
    await audit(db, user_id=user.id, action="memory.delete_all", category="memory", details={"deleted": res.rowcount})
    return {"deleted": res.rowcount}
