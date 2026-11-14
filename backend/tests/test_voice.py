"""Voice: speech-to-text / text-to-speech endpoints (OpenAI client mocked with the SDK's own error types),
audio helpers, model fallback, guards, usage accounting, and the voice-style reply plumbing."""
from __future__ import annotations

import io
import struct
import wave
from types import SimpleNamespace
from typing import Any

import httpx
import openai
import pytest
from sqlalchemy import select

from api.routes import voice as voice_routes
from core.config import settings
from core.llm import openai_provider
from database.models import UsageRecord
from database.session import SessionLocal
from tests.conftest import drain_jobs
from tests.scripted_provider import STATE, plan_json, resp


def make_wav(seconds: float, rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(struct.pack("<h", 1200) * int(rate * seconds))
    return buf.getvalue()


def api_error(cls: type[openai.APIStatusError], status: int) -> openai.APIStatusError:
    request = httpx.Request("POST", "https://api.openai.com/v1/x")
    return cls("model problem", response=httpx.Response(status, request=request), body=None)


class FakeOpenAI:
    """Records calls; `fail_models` raises a 404 for those model names (account without access)."""

    def __init__(self, fail_models: set[str] | None = None, text: str = " go to tasks "):
        self.fail_models = fail_models or set()
        self.calls: list[dict[str, Any]] = []
        self.text = text
        self.audio = SimpleNamespace(
            transcriptions=SimpleNamespace(create=self._transcribe), speech=SimpleNamespace(create=self._speak))

    async def _transcribe(self, **params: Any) -> Any:
        self.calls.append({"kind": "stt", **params})
        if params["model"] in self.fail_models:
            raise api_error(openai.NotFoundError, 404)
        return SimpleNamespace(text=self.text)

    async def _speak(self, **params: Any) -> Any:
        self.calls.append({"kind": "tts", **params})
        if params["model"] in self.fail_models:
            raise api_error(openai.NotFoundError, 404)
        return SimpleNamespace(content=b"ID3\x03\x00fake-mp3-bytes")


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeOpenAI:
    f = FakeOpenAI()
    monkeypatch.setattr(openai_provider, "get_client", lambda: f)
    return f


# ------------------------------------------------------------------ pure helpers
def test_wav_duration_and_format_sniffing():
    assert voice_routes.wav_duration_ms(make_wav(1.5)) == 1500
    assert voice_routes.wav_duration_ms(b"not a wav at all, really not" * 5) is None
    assert voice_routes.audio_extension("audio/webm", "speech.webm", make_wav(0.3)) == "wav"  # bytes beat the label
    assert voice_routes.audio_extension("audio/webm", "x.webm", b"OggS" + b"\0" * 40) == "ogg"
    assert voice_routes.audio_extension("audio/webm", "x.webm", b"\x1a\x45\xdf\xa3" + b"\0" * 40) == "webm"
    assert voice_routes.audio_extension(None, "clip.mp3", b"\0" * 40) == "mp3"
    assert voice_routes.audio_extension("text/plain", "notes.txt", b"hello world" * 5) is None


def test_language_normalisation():
    assert voice_routes.normalize_language("en-IN") == "en"
    assert voice_routes.normalize_language("HI") == "hi"
    assert voice_routes.normalize_language("") is None
    assert voice_routes.normalize_language("fil") is None  # three letters would be misread as Finnish: auto-detect
    assert voice_routes.normalize_language("english") is None


# ------------------------------------------------------------------ transcription
async def test_transcribe_returns_text_and_records_usage(client, fake):
    r = await client.post("/api/voice/transcribe", files={"audio": ("speech.webm", make_wav(1.0), "audio/webm")},
                          data={"language": "en-IN"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["text"] == "go to tasks" and body["duration_ms"] == 1000 and body["model"] == "gpt-4o-mini-transcribe"
    call = fake.calls[0]
    assert call["file"][0] == "speech.wav" and call["language"] == "en"  # real format, ISO-639-1 language
    async with SessionLocal() as db:
        rec = (await db.execute(select(UsageRecord).where(UsageRecord.purpose == "stt")
                                .order_by(UsageRecord.created_at.desc()))).scalars().first()
    assert rec is not None and rec.provider == "openai" and rec.input_tokens == 16
    assert 0 < rec.cost_usd < 0.0001  # about $0.003 per minute


async def test_transcribe_skips_clips_that_are_too_short(client, fake):
    r = await client.post("/api/voice/transcribe", files={"audio": ("s.wav", make_wav(0.1), "audio/wav")})
    assert r.json()["text"] == "" and r.json()["skipped"] == "too_short"
    assert fake.calls == []  # never billed


async def test_transcribe_falls_back_when_account_lacks_the_model(client, monkeypatch):
    f = FakeOpenAI(fail_models={"gpt-4o-mini-transcribe"})
    monkeypatch.setattr(openai_provider, "get_client", lambda: f)
    r = await client.post("/api/voice/transcribe", files={"audio": ("s.wav", make_wav(1.0), "audio/wav")})
    assert r.status_code == 200 and r.json()["model"] == "whisper-1"
    assert [c["model"] for c in f.calls] == ["gpt-4o-mini-transcribe", "whisper-1"]


async def test_transcribe_without_api_key_is_a_clear_503(client):
    r = await client.post("/api/voice/transcribe", files={"audio": ("s.wav", make_wav(1.0), "audio/wav")})
    assert r.status_code == 503 and "OPENAI_API_KEY" in r.json()["detail"]


async def test_transcribe_rejects_unknown_formats_and_oversize(client, fake, monkeypatch):
    r = await client.post("/api/voice/transcribe", files={"audio": ("n.txt", b"plain text" * 10, "text/plain")})
    assert r.status_code == 415
    monkeypatch.setattr(voice_routes, "MAX_AUDIO_BYTES", 1000)
    r = await client.post("/api/voice/transcribe", files={"audio": ("s.wav", make_wav(1.0), "audio/wav")})
    assert r.status_code == 413


async def test_transcribe_is_rate_limited(client, fake, monkeypatch):
    monkeypatch.setattr(settings, "voice_stt_per_minute", 2)
    codes = [(await client.post("/api/voice/transcribe", files={"audio": ("s.wav", make_wav(0.5), "audio/wav")})
              ).status_code for _ in range(3)]
    assert codes == [200, 200, 429]


async def test_transcribe_respects_the_monthly_budget(client, fake):
    await client.patch("/api/auth/me/settings", json={"monthly_budget_usd": 0.0000001})
    await client.post("/api/voice/transcribe", files={"audio": ("s.wav", make_wav(5.0), "audio/wav")})
    r = await client.post("/api/voice/transcribe", files={"audio": ("s.wav", make_wav(1.0), "audio/wav")})
    assert r.status_code == 402 and "budget" in r.json()["detail"].lower()


# ------------------------------------------------------------------ speech synthesis
async def test_speak_returns_audio_with_style_instructions(client, fake):
    r = await client.post("/api/voice/speak", json={"text": "Hello there", "voice": "coral"})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg" and r.content.startswith(b"ID3")
    call = fake.calls[0]
    assert call["model"] == "gpt-4o-mini-tts" and call["voice"] == "coral" and "instructions" in call


async def test_speak_unknown_voice_falls_back_and_tts_model_fallback_drops_instructions(client, monkeypatch):
    f = FakeOpenAI(fail_models={"gpt-4o-mini-tts"})
    monkeypatch.setattr(openai_provider, "get_client", lambda: f)
    r = await client.post("/api/voice/speak", json={"text": "Hi", "voice": "not-a-voice"})
    assert r.status_code == 200
    assert [c["model"] for c in f.calls] == ["gpt-4o-mini-tts", "tts-1"]
    assert f.calls[1]["voice"] == "nova" and "instructions" not in f.calls[1]  # tts-1 rejects instructions


async def test_speak_validation(client, fake):
    assert (await client.post("/api/voice/speak", json={"text": ""})).status_code == 422
    assert (await client.post("/api/voice/speak", json={"text": "x" * 4001})).status_code == 422


async def test_capabilities(client, monkeypatch):
    assert (await client.get("/api/voice/capabilities")).json()["server_stt"] is False
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    caps = (await client.get("/api/voice/capabilities")).json()
    assert caps["server_stt"] and caps["server_tts"] and "nova" in caps["voices"]


# ------------------------------------------------------------------ voice settings
async def test_voice_settings_are_validated(client):
    ok = await client.patch("/api/auth/me/settings", json={
        "voice_speed": 1.25, "voice_patience": "patient", "voice_language": "", "voice_auto_start": True,
        "voice_wake_phrase": False, "voice_cues": True, "voice_engine": "browser"})
    assert ok.status_code == 200
    s = ok.json()["settings"]
    assert s["voice_speed"] == 1.25 and s["voice_patience"] == "patient" and s["voice_language"] == ""
    for bad in ({"voice_speed": 3.0}, {"voice_patience": "instant"}, {"voice_language": "english"},
                {"voice_engine": "cloud"}):
        assert (await client.patch("/api/auth/me/settings", json=bad)).status_code == 422, bad


# ------------------------------------------------------------------ voice-style replies
async def _run(client, text: str, voice: bool) -> None:
    conv = (await client.post("/api/conversations")).json()
    r = await client.post(f"/api/conversations/{conv['id']}/messages", json={"content": text, "voice": voice})
    assert r.status_code == 202, r.text
    await drain_jobs()


def recorder(plan: str, seen: dict[str, list[str]]):
    def script(system: str, messages: list[dict[str, Any]], tools: list[str]):
        if "planning module" in system:
            seen["plan"].append(system)
            return resp(plan)
        if "Write LEXA's final reply" in system:
            seen["synth"].append(system)
            return resp("Done.")
        seen["agent"].append(system)
        return resp("agent output")
    return script


async def test_voice_flag_reaches_planner_agents_and_synthesis(client):
    seen: dict[str, list[str]] = {"plan": [], "agent": [], "synth": []}
    steps = [{"id": "s1", "agent": "research", "instruction": "look A"},
             {"id": "s2", "agent": "finance", "instruction": "look B"}]
    STATE["script"] = recorder(plan_json(steps), seen)
    await _run(client, "research and budget", voice=True)
    for stage in ("plan", "agent", "synth"):
        assert seen[stage] and all("# Voice conversation" in s for s in seen[stage]), stage
    assert len(seen["agent"]) == 2


async def test_typed_messages_do_not_get_the_voice_style(client):
    seen: dict[str, list[str]] = {"plan": [], "agent": [], "synth": []}
    steps = [{"id": "s1", "agent": "research", "instruction": "look A"},
             {"id": "s2", "agent": "finance", "instruction": "look B"}]
    STATE["script"] = recorder(plan_json(steps), seen)
    await _run(client, "research and budget", voice=False)
    assert seen["plan"] and not any("# Voice conversation" in s for ss in seen.values() for s in ss)
