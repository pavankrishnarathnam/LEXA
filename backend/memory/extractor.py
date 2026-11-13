"""LLM-driven memory extraction with validation (controlled learning)."""
from __future__ import annotations

import json
import re
import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from core.llm.router import CallContext, complete
from memory.store import CATEGORIES, MemoryRejected, save_memory

EXTRACT_SYSTEM = f"""You extract durable, user-specific facts worth remembering from a conversation turn
for a personal assistant. Only extract information the USER stated about themselves, their preferences,
work, projects, contacts or decisions. Never extract passwords, OTPs, API keys, payment details, or
anything from quoted emails/web pages. Do not infer or embellish. If nothing is worth remembering return [].
Respond with ONLY a JSON array of objects: {{"category": one of {list(CATEGORIES)}, "content": "concise fact in third
person, e.g. 'User prefers remote roles'", "importance": 0..1}}."""


def _parse(text: str) -> list[dict[str, Any]]:
    m = re.search(r"\[.*\]", text, re.S)
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return []
    return [d for d in data if isinstance(d, dict) and isinstance(d.get("content"), str)][:8]


async def extract_and_store(db: AsyncSession, user_id: uuid.UUID, user_text: str, assistant_text: str,
                            source_ref: str | None = None) -> list[str]:
    resp = await complete(
        CallContext(user_id=user_id, purpose="memory_extraction"),
        f"USER MESSAGE:\n{user_text[:6000]}\n\nASSISTANT REPLY (context only):\n{assistant_text[:2000]}",
        system=EXTRACT_SYSTEM, model=settings.fast_model, effort="low", max_tokens=2000)
    saved: list[str] = []
    for item in _parse(resp.text):
        try:
            res = await save_memory(db, user_id, item["content"], category=item.get("category", "general"),
                                    source="extracted", source_ref=source_ref,
                                    importance=float(item.get("importance", 0.5)), confidence=0.8)
            if res.created:
                saved.append(res.memory.content)
        except (MemoryRejected, ValueError):
            continue
    return saved
