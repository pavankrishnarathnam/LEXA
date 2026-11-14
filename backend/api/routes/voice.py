"""Voice endpoints: speech-to-text, text-to-speech and capabilities (OpenAI)."""
from __future__ import annotations

import re
import struct

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from api.deps import CurrentUser
from api.errors import CodedHTTPException
from core.config import settings
from core.llm import openai_provider
from core.llm.types import ProviderNotConfigured, Usage
from core.llm.usage import ensure_budget, record_usage
from core.redis import rate_limit

router = APIRouter(prefix="/api/voice", tags=["voice"])

VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"]
MAX_AUDIO_BYTES = 12 * 1024 * 1024
MIN_AUDIO_MS = 200
MAX_UTTERANCE_SECONDS = 40
TTS_PER_MINUTE = 90
# Audio is priced per minute; usage is recorded as synthetic tokens (see core/llm/pricing.py).
AUDIO_TOKENS_PER_SECOND = 16
SPEECH_CHARS_PER_SECOND = 15

_TYPE_EXT = {
    "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/webm": "webm", "video/webm": "webm",
    "audio/ogg": "ogg", "audio/mp4": "mp4", "audio/m4a": "m4a", "audio/x-m4a": "m4a", "audio/mpeg": "mp3",
    "audio/mp3": "mp3", "audio/flac": "flac",
}
_NAME_EXT = {"wav", "webm", "ogg", "oga", "mp4", "m4a", "mp3", "mpeg", "mpga", "flac"}


def voice_available() -> bool:
    return bool(settings.openai_api_key)


def wav_duration_ms(data: bytes) -> int | None:
    """Duration of a PCM WAV from its header, or None if this is not a readable WAV."""
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return None
    pos, byte_rate = 12, 0
    while pos + 8 <= len(data):
        chunk_id = data[pos:pos + 4]
        (size,) = struct.unpack_from("<I", data, pos + 4)
        if chunk_id == b"fmt " and pos + 20 <= len(data):
            byte_rate = struct.unpack_from("<I", data, pos + 16)[0]
        elif chunk_id == b"data":
            if not byte_rate:
                return None
            size = min(size, len(data) - pos - 8)  # streamed WAVs may declare an unknown/huge size
            return int(size / byte_rate * 1000)
        pos += 8 + size + (size & 1)
    return None


def audio_extension(content_type: str | None, filename: str | None, data: bytes) -> str | None:
    """File extension OpenAI needs. Trusts the bytes over the declared type (browsers mislabel Ogg as WebM)."""
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "wav"
    if data[:4] == b"OggS":
        return "ogg"
    if data[:4] == b"\x1a\x45\xdf\xa3":
        return "webm"
    if data[4:8] == b"ftyp":
        return "mp4"
    if data[:4] == b"fLaC":
        return "flac"
    if data[:3] == b"ID3" or data[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return "mp3"
    declared = (content_type or "").split(";")[0].strip().lower()
    if declared in _TYPE_EXT:
        return _TYPE_EXT[declared]
    ext = (filename or "").rsplit(".", 1)[-1].lower()
    return ext if ext in _NAME_EXT else None


def normalize_language(value: str | None) -> str | None:
    """'en-IN' / 'en_US' / 'EN' -> 'en'. OpenAI wants a two-letter ISO-639-1 code; anything else -> auto-detect."""
    if not value:
        return None
    m = re.fullmatch(r"([A-Za-z]{2})(?:[-_][A-Za-z0-9]+)*", value.strip())
    return m.group(1).lower() if m else None


async def _limit(key: str, per_minute: int, message: str) -> None:
    allowed, retry = await rate_limit(key, per_minute, 60)
    if not allowed:
        raise HTTPException(429, message, headers={"Retry-After": str(retry)})


@router.post("/transcribe")
async def transcribe(user: CurrentUser, audio: UploadFile = File(...), language: str | None = Form(default=None),
                     duration_ms: int | None = Form(default=None)) -> dict:
    await _limit(f"voice-stt:{user.id}", settings.voice_stt_per_minute,
                 "Too much speech to process at once. Pause for a moment and try again.")
    data = await audio.read(MAX_AUDIO_BYTES + 1)
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "Audio too large")
    ext = audio_extension(audio.content_type, audio.filename, data)
    if ext is None:
        raise HTTPException(415, "Unsupported audio format (use wav, webm, ogg, mp3 or mp4)")
    ms = wav_duration_ms(data) if ext == "wav" else None
    if ms is None:
        ms = max(0, min(int(duration_ms or 0), MAX_UTTERANCE_SECONDS * 3000))
    if ms and ms < MIN_AUDIO_MS:
        return {"text": "", "duration_ms": ms, "skipped": "too_short"}
    await ensure_budget(user.id)
    try:
        text, model = await openai_provider.transcribe(data, f"speech.{ext}", normalize_language(language))
    except ProviderNotConfigured as exc:
        raise CodedHTTPException(503, "Speech recognition needs an OpenAI API key (OPENAI_API_KEY).",
                                 "not_configured") from exc
    # Any other ProviderError (no credits, bad key, outage) is turned into a coded response by the app-wide handler.
    seconds = ms / 1000 if ms else len(data) / 32000
    await record_usage(user_id=user.id, provider="openai", model=model,
                       usage=Usage(input_tokens=int(seconds * AUDIO_TOKENS_PER_SECOND)), purpose="stt")
    return {"text": text.strip(), "duration_ms": ms, "model": model}


class SpeakIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    voice: str | None = Field(default=None, max_length=40)


@router.post("/speak")
async def speak(body: SpeakIn, user: CurrentUser) -> Response:
    await _limit(f"voice-tts:{user.id}", TTS_PER_MINUTE, "LEXA is speaking too often. Try again in a moment.")
    voice = body.voice or (user.settings or {}).get("voice") or "nova"
    if voice not in VOICES:
        voice = "nova"
    await ensure_budget(user.id)
    try:
        audio, model = await openai_provider.synthesize(body.text, voice)
    except ProviderNotConfigured as exc:
        raise CodedHTTPException(503, "Server text-to-speech needs an OpenAI API key; the browser voice is used "
                                      "instead.", "not_configured") from exc
    seconds = len(body.text) / SPEECH_CHARS_PER_SECOND
    await record_usage(user_id=user.id, provider="openai", model=model, purpose="tts",
                       usage=Usage(input_tokens=len(body.text) // 4 if model.startswith("gpt-4o")
                                   else len(body.text),
                                   output_tokens=int(seconds * AUDIO_TOKENS_PER_SECOND)
                                   if model.startswith("gpt-4o") else 0))
    media = "audio/wav" if audio[:4] == b"RIFF" else "audio/mpeg"
    return Response(content=audio, media_type=media)


@router.get("/capabilities")
async def capabilities(user: CurrentUser) -> dict:
    ok = voice_available()
    return {"server_stt": ok, "server_tts": ok, "stt_model": settings.stt_model, "tts_model": settings.tts_model,
            "voices": VOICES, "max_utterance_seconds": MAX_UTTERANCE_SECONDS}
