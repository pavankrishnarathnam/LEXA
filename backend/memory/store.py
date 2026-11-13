"""User-scoped persistent memory: validation, de-duplication, semantic + keyword retrieval."""
from __future__ import annotations

import hashlib
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from database.models import Memory
from memory.embeddings import active_model, embed_texts

CATEGORIES = (
    "profile", "education", "employment", "skills", "preferences", "projects", "contacts",
    "decisions", "ongoing_tasks", "documents", "conversation_summaries", "general",
)

_SECRET_PATTERNS = [
    re.compile(r"\b(password|passwd|passcode|pin)\b\s*(is|:|=)", re.I),
    re.compile(r"\b(otp|one[- ]time (pass)?code|verification code|2fa code)\b", re.I),
    re.compile(r"\b(sk-(ant-)?[A-Za-z0-9_\-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abpr]-[A-Za-z0-9-]{10,})"),
    re.compile(r"\b(api[_ -]?key|secret[_ -]?key|access[_ -]?token|bearer)\b\s*(is|:|=)\s*\S{8,}", re.I),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\b(?:\d[ -]?){13,19}\b"),  # payment card-like numbers
]
DUPLICATE_DISTANCE = 0.12


class MemoryRejected(ValueError):
    pass


def contains_secret(text: str) -> bool:
    return any(p.search(text) for p in _SECRET_PATTERNS)


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip())


def content_hash(text: str) -> str:
    return hashlib.sha256(normalize(text).lower().encode()).hexdigest()


@dataclass
class SaveResult:
    memory: Memory
    created: bool
    duplicate_of: uuid.UUID | None = None


async def save_memory(db: AsyncSession, user_id: uuid.UUID, content: str, *, category: str = "general",
                      source: str = "user", source_ref: str | None = None, importance: float = 0.5,
                      confidence: float = 1.0, pinned: bool = False, expires_at: datetime | None = None,
                      meta: dict[str, Any] | None = None) -> SaveResult:
    content = normalize(content)
    if not content or len(content) < 3:
        raise MemoryRejected("Memory content is empty")
    if len(content) > 4000:
        raise MemoryRejected("Memory content too long (max 4000 characters); store it as a document instead")
    if contains_secret(content):
        raise MemoryRejected("Refusing to store credentials, passwords, OTPs or payment numbers in memory")
    if category not in CATEGORIES:
        category = "general"
    h = content_hash(content)
    existing = await db.scalar(select(Memory).where(Memory.user_id == user_id, Memory.content_hash == h))
    if existing:
        existing.importance = max(existing.importance, importance)
        existing.updated_at = datetime.now(UTC)
        return SaveResult(existing, created=False, duplicate_of=existing.id)

    [vec], model = await embed_texts([content], user_id)
    near = (await db.execute(
        select(Memory, Memory.embedding.cosine_distance(vec).label("d"))
        .where(Memory.user_id == user_id, Memory.category == category, Memory.embedding_model == model)
        .order_by("d").limit(1)
    )).first()
    if near and near.d is not None and near.d < DUPLICATE_DISTANCE:
        mem: Memory = near.Memory
        # Newer information supersedes older phrasing of the same fact.
        if source != "extracted" or mem.source == "extracted":
            mem.content, mem.content_hash, mem.embedding = content, h, vec
        mem.importance = max(mem.importance, importance)
        return SaveResult(mem, created=False, duplicate_of=mem.id)

    mem = Memory(user_id=user_id, category=category, content=content, content_hash=h, source=source,
                 source_ref=source_ref, importance=importance, confidence=confidence, pinned=pinned,
                 embedding=vec, embedding_model=model, expires_at=expires_at, meta=meta or {})
    db.add(mem)
    await db.flush()
    return SaveResult(mem, created=True)


async def update_memory(db: AsyncSession, mem: Memory, content: str | None = None, **fields: Any) -> Memory:
    if content is not None:
        content = normalize(content)
        if contains_secret(content):
            raise MemoryRejected("Refusing to store credentials, passwords, OTPs or payment numbers in memory")
        [vec], model = await embed_texts([content], mem.user_id)
        mem.content, mem.content_hash, mem.embedding, mem.embedding_model = content, content_hash(content), vec, model
    for k, v in fields.items():
        if v is not None and hasattr(mem, k):
            setattr(mem, k, v)
    return mem


async def search_memories(db: AsyncSession, user_id: uuid.UUID, query: str, *, k: int = 8,
                          categories: list[str] | None = None, min_score: float = 0.15) -> list[dict[str, Any]]:
    now = datetime.now(UTC)
    base = [Memory.user_id == user_id, or_(Memory.expires_at.is_(None), Memory.expires_at > now)]
    if categories:
        base.append(Memory.category.in_(categories))
    results: dict[uuid.UUID, dict[str, Any]] = {}
    model = active_model()
    try:
        [vec], model = await embed_texts([query], user_id)
        rows = (await db.execute(
            select(Memory, Memory.embedding.cosine_distance(vec).label("d"))
            .where(*base, Memory.embedding_model == model).order_by("d").limit(k * 2)
        )).all()
        for m, d in rows:
            score = 1 - float(d) + (0.05 if m.pinned else 0) + 0.05 * m.importance
            if score >= min_score:
                results[m.id] = _row(m, score)
    except Exception:  # noqa: BLE001,S110 - semantic search is best effort; keyword search below still runs
        pass
    terms = [t for t in re.findall(r"\w{3,}", query.lower())][:6]
    if terms:
        kw = (await db.execute(
            select(Memory).where(*base, or_(*[Memory.content.ilike(f"%{t}%") for t in terms])).limit(k)
        )).scalars().all()
        for m in kw:
            hits = sum(t in m.content.lower() for t in terms) / len(terms)
            if m.id not in results:
                results[m.id] = _row(m, 0.3 + 0.4 * hits)
            else:
                results[m.id]["score"] += 0.1 * hits
    ranked = sorted(results.values(), key=lambda r: r["score"], reverse=True)[:k]
    if ranked:
        await db.execute(update(Memory).where(Memory.id.in_([uuid.UUID(r["id"]) for r in ranked]))
                         .values(last_accessed_at=now))
    return ranked


def _row(m: Memory, score: float) -> dict[str, Any]:
    return {"id": str(m.id), "category": m.category, "content": m.content, "score": round(score, 3),
            "source": m.source, "pinned": m.pinned, "updated_at": m.updated_at.isoformat() if m.updated_at else None}


async def context_block(db: AsyncSession, user_id: uuid.UUID, query: str, k: int = 8) -> str:
    """Relevant memories formatted for injection into an agent's prompt."""
    pinned = (await db.execute(select(Memory).where(Memory.user_id == user_id, Memory.pinned.is_(True))
                               .order_by(Memory.importance.desc()).limit(6))).scalars().all()
    hits = await search_memories(db, user_id, query, k=k)
    seen: set[str] = set()
    lines: list[str] = []
    for m in [_row(p, 1.0) for p in pinned] + hits:
        if m["id"] in seen:
            continue
        seen.add(m["id"])
        lines.append(f"- [{m['category']}] {m['content']}")
    return "\n".join(lines)
