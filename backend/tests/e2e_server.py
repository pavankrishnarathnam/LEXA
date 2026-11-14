"""TEST HARNESS ONLY — runs the real LEXA API and worker with the deterministic scripted provider so the
browser end-to-end suite can exercise chat → plan → delegation → approval → execution without a paid API key.
Never used in production images (the Dockerfile does not copy tests/)."""
from __future__ import annotations

import asyncio
import os
import re

os.environ.setdefault("DEFAULT_MODEL", "test-model")
os.environ.setdefault("FALLBACK_MODEL", "test-fallback")
os.environ.setdefault("FAST_MODEL", "test-fast")
os.environ.setdefault("AUTH_RATE_LIMIT", "10000")  # e2e logs in many times from one IP
os.environ.setdefault("RATE_LIMIT_PER_MINUTE", "100000")  # the suite polls and navigates far faster than a person
os.environ.setdefault("VOICE_STT_PER_MINUTE", "100000")
os.environ.setdefault("MODEL_PRICING_JSON", '{"test-model": [4.0, 20.0], "test-fallback": [2.0, 10.0], "test-fast": [0.1, 0.5]}')

import uvicorn  # noqa: E402

from core.llm.router import register_provider  # noqa: E402
from tests.scripted_provider import STATE, ScriptedSession, plan_json, resp, scripted_stream  # noqa: E402

register_provider("scripted", "test-", ScriptedSession, scripted_stream)


# "Set up a <name> every Friday" becomes an automation called <name>. LEXA refuses to run an identical external action
# twice ("duplicate prevented"), so tests that need a fresh approval simply ask for a differently named automation.
_AUTOMATION_REQUEST = re.compile(r"set up an? (?P<name>[a-z0-9][a-z0-9 ]{2,40}?) every friday", re.I)
_AUTOMATION_STEP = re.compile(r"create the (?P<name>.+) automation", re.I)


def script(system, messages, tools):
    user = next((m["content"] for m in reversed(messages) if m["role"] == "user" and isinstance(m["content"], str)), "")
    if "planning module" in system:
        if "email" in user.lower():
            return resp(plan_json([{"id": "s1", "agent": "communication", "instruction": "Draft and send the email",
                                    "depends_on": []},
                                   {"id": "s2", "agent": "research", "instruction": "Research the topic", "depends_on": []}],
                                  title="Email and research"))
        wanted = _AUTOMATION_REQUEST.search(user)
        if wanted:
            name = wanted["name"].strip()
            return resp(plan_json([{"id": "s1", "agent": "operations", "instruction": f"Create the {name} automation",
                                    "depends_on": []}], title=f"{name.capitalize()} automation"))
        if "durable" in user.lower():
            return resp('{"title":"Memory","mode":"delegate","steps":[{"id":"s1","agent":"knowledge",'
                        '"instruction":"Remember the preference"}]}')
        return resp(plan_json(direct=f"**Hello!** I'm LEXA. You said: _{user.split('USER REQUEST:')[-1].strip()}_",
                              title="Conversation"))
    if "Write LEXA's final reply" in system and _AUTOMATION_STEP.search(str(messages)):
        name = _AUTOMATION_STEP.search(str(messages))["name"].strip().capitalize()  # type: ignore[index]
        return resp(f"I prepared the **{name}** automation. It is waiting for your approval.")
    if "Write LEXA's final reply" in system:
        return resp("I researched the topic and prepared the email. **The email is waiting for your approval** — it "
                    "has not been sent yet.")
    if any(m["role"] == "tool" for m in messages):
        return resp("Done: " + [m for m in messages if m["role"] == "tool"][-1]["content"][0][1][:200])
    if "automation_create" in tools:
        step = _AUTOMATION_STEP.search(user)
        return resp("", [("automation_create", {"name": step["name"].strip().capitalize() if step else "Weekly review",
                                                "cron": "0 17 * * 5", "timezone": "UTC",
                                                "instruction": "Summarize my week"})])
    if "gmail_send" in tools:
        return resp("", [("gmail_send", {"to": "alex@example.com", "subject": "Project update",
                                         "body": "Hi Alex, the project is on track for Friday."})])
    if "memory_save" in tools:
        return resp("", [("memory_save", {"content": "User prefers concise answers", "category": "preferences"})])
    return resp("Research summary: three key findings with sources (https://example.com).")


STATE["script"] = script


# ── Voice test doubles ─────────────────────────────────────────────────────────────────────────────────────────
# There is no OpenAI key in tests. Speech-to-text answers with the next text queued by the browser test (through the
# test-only endpoint below) and text-to-speech returns a short silent WAV, so the REAL browser pipeline
# (microphone → voice-activity detection → WAV upload → command → spoken reply → playback) runs end to end.
import io  # noqa: E402
import struct  # noqa: E402
import wave  # noqa: E402

from fastapi import APIRouter  # noqa: E402

import main as app_module  # noqa: E402
from api.routes import voice as voice_routes  # noqa: E402
from core.llm import openai_provider  # noqa: E402

VOICE_TEXTS: list[str] = []


def silent_wav(seconds: float, rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(struct.pack("<h", 0) * int(rate * seconds))
    return buf.getvalue()


NO_CREDITS_ON = {"on": False}  # simulate an OpenAI account with an empty balance (HTTP 429 insufficient_quota)


def _maybe_no_credits() -> None:
    if NO_CREDITS_ON["on"]:
        from core.llm.openai_provider import NO_CREDITS_MESSAGE
        from core.llm.types import NO_CREDITS, ProviderError
        raise ProviderError(NO_CREDITS_MESSAGE, retryable=False, provider="openai", status=402, code=NO_CREDITS)


async def fake_transcribe(audio: bytes, filename: str, language: str | None = None) -> tuple[str, str]:
    _maybe_no_credits()
    return (VOICE_TEXTS.pop(0) if VOICE_TEXTS else ""), "test-stt"


async def fake_synthesize(text: str, voice: str) -> tuple[bytes, str]:
    _maybe_no_credits()
    return silent_wav(0.4), "test-tts"


openai_provider.transcribe = fake_transcribe  # type: ignore[assignment]
openai_provider.synthesize = fake_synthesize  # type: ignore[assignment]
voice_routes.voice_available = lambda: True  # type: ignore[assignment]
voice_routes.TTS_PER_MINUTE = 100_000

control = APIRouter(prefix="/api/test", tags=["test-harness-only"])


@control.get("/voice-script")
async def set_voice_script(texts: str = "") -> dict:
    """Queues what the next spoken utterances will be 'transcribed' as: ?texts=open automations|approve"""
    VOICE_TEXTS[:] = [t for t in texts.split("|") if t]
    return {"queued": len(VOICE_TEXTS)}


@control.get("/voice-available")
async def set_voice_available(on: int = 1) -> dict:
    """Pretends the server has (1) or lacks (0) an OpenAI key, to test voice mode without speech recognition."""
    voice_routes.voice_available = (lambda: True) if on else (lambda: False)  # type: ignore[assignment]
    return {"available": bool(on)}


@control.get("/voice-credits")
async def set_voice_credits(on: int = 1) -> dict:
    """on=0 makes OpenAI answer 'no credits remaining' to speech-to-text and text-to-speech."""
    NO_CREDITS_ON["on"] = not on
    return {"credits": bool(on)}


app_module.app.include_router(control)


async def main() -> None:
    from workers.main import maintenance_loop, worker_loop
    stop = asyncio.Event()
    config = uvicorn.Config("main:app", host="127.0.0.1", port=int(os.environ.get("PORT", "8000")), log_level="warning")
    server = uvicorn.Server(config)
    await asyncio.gather(server.serve(), maintenance_loop(stop), worker_loop(stop, 0), worker_loop(stop, 1))


if __name__ == "__main__":
    asyncio.run(main())
