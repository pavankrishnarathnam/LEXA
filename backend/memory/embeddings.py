"""Embedding generation.

Uses OpenAI embeddings when OPENAI_API_KEY is set. Otherwise falls back to a deterministic local
feature-hashing embedder ("lexa-hash-v1") that captures lexical overlap only. Retrieval always filters on
embedding_model so vectors from different models are never compared.
"""
from __future__ import annotations

import hashlib
import math
import re
import uuid

from core.config import settings
from core.llm import openai_provider
from core.llm.types import ProviderError, Usage
from core.llm.usage import record_usage

LOCAL_MODEL = "lexa-hash-v1"
_WORD = re.compile(r"[a-z0-9][a-z0-9+#.\-]*")


def active_model() -> str:
    return settings.embedding_model if settings.openai_api_key else LOCAL_MODEL


def _local_embed(text: str) -> list[float]:
    dim = settings.embedding_dim
    vec = [0.0] * dim
    words = _WORD.findall(text.lower())
    feats = words + [f"{a}_{b}" for a, b in zip(words, words[1:], strict=False)]
    for f in feats:
        h = int.from_bytes(hashlib.blake2b(f.encode(), digest_size=8).digest(), "big")
        vec[h % dim] += 1.0 if (h >> 63) & 1 else -1.0
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


async def embed_texts(texts: list[str], user_id: uuid.UUID | None = None) -> tuple[list[list[float]], str]:
    if settings.openai_api_key:
        try:
            vectors, tokens = await openai_provider.embed([t[:8000] for t in texts])
            await record_usage(user_id=user_id, provider="openai", model=settings.embedding_model,
                               usage=Usage(input_tokens=tokens), purpose="embedding")
            return vectors, settings.embedding_model
        except ProviderError:
            # Do not silently mix models: surface the failure to callers that require semantic embeddings.
            raise
    return [_local_embed(t) for t in texts], LOCAL_MODEL
