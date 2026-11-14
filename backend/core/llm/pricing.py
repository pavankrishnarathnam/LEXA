"""Model pricing (USD per 1M tokens). Override or extend with MODEL_PRICING_JSON."""
from __future__ import annotations

import json
import os

from core.llm.types import Usage

# (input, output, cache_read, cache_write)
_DEFAULT: dict[str, tuple[float, float, float, float]] = {
    "claude-fable-5-2": (8.0, 40.0, 0.20, 10.0),
    "claude-opus-5-5": (4.0, 20.0, 0.20, 5.0),
    "claude-opus-5": (5.0, 25.0, 0.50, 6.25),
    "claude-sonnet-5-5": (2.0, 10.0, 0.10, 2.5),
    "claude-sonnet-5": (2.0, 10.0, 0.20, 2.5),
    "claude-haiku-5-5": (0.10, 0.50, 0.01, 0.125),
    # OpenAI list prices change frequently: verify and override via MODEL_PRICING_JSON.
    "gpt-5.1": (1.25, 10.0, 0.125, 0.0),
    "gpt-5-mini": (0.25, 2.0, 0.025, 0.0),
    "text-embedding-3-small": (0.02, 0.0, 0.0, 0.0),
    # Audio is billed per minute, not per token. Usage is recorded as synthetic tokens (16 per second of audio,
    # 960 per minute) and priced so the table reproduces the list price per minute. These are ESTIMATES:
    # gpt-4o-mini-transcribe $0.003/min, whisper-1 $0.006/min, gpt-4o-mini-tts about $0.015/min of speech,
    # tts-1 $15 per 1M characters. Override with MODEL_PRICING_JSON when OpenAI's prices change.
    "gpt-4o-mini-transcribe": (3.125, 0.0, 0.0, 0.0),
    "whisper-1": (6.25, 0.0, 0.0, 0.0),
    "gpt-4o-mini-tts": (0.60, 15.625, 0.0, 0.0),
    "tts-1": (15.0, 0.0, 0.0, 0.0),
}


def _load() -> dict[str, tuple[float, float, float, float]]:
    table = dict(_DEFAULT)
    raw = os.environ.get("MODEL_PRICING_JSON")
    if raw:
        for model, vals in json.loads(raw).items():
            v = list(vals) + [0.0] * (4 - len(vals))
            table[model] = (float(v[0]), float(v[1]), float(v[2]), float(v[3]))
    return table


PRICING = _load()


def price_for(model: str) -> tuple[float, float, float, float]:
    if model in PRICING:
        return PRICING[model]
    # Match dated/variant ids by longest known prefix.
    best = max((m for m in PRICING if model.startswith(m)), key=len, default=None)
    return PRICING[best] if best else (0.0, 0.0, 0.0, 0.0)


def cost_usd(model: str, usage: Usage) -> float:
    i, o, cr, cw = price_for(model)
    return round(
        (usage.input_tokens * i + usage.output_tokens * o + usage.cache_read_tokens * cr + usage.cache_write_tokens * cw)
        / 1_000_000,
        6,
    )


def provider_for_model(model: str) -> str:
    if model.startswith("claude"):
        return "anthropic"
    if model.startswith(("gpt", "o1", "o3", "o4", "text-embedding")):
        return "openai"
    return "unknown"
