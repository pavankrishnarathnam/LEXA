"""TEST HARNESS ONLY — runs the real LEXA API and worker with the deterministic scripted provider so the
browser end-to-end suite can exercise chat → plan → delegation → approval → execution without a paid API key.
Never used in production images (the Dockerfile does not copy tests/)."""
from __future__ import annotations

import asyncio
import os

os.environ.setdefault("DEFAULT_MODEL", "test-model")
os.environ.setdefault("FALLBACK_MODEL", "test-fallback")
os.environ.setdefault("FAST_MODEL", "test-fast")
os.environ.setdefault("AUTH_RATE_LIMIT", "10000")  # e2e logs in many times from one IP
os.environ.setdefault("MODEL_PRICING_JSON", '{"test-model": [4.0, 20.0], "test-fallback": [2.0, 10.0], "test-fast": [0.1, 0.5]}')

import uvicorn  # noqa: E402

from core.llm.router import register_provider  # noqa: E402
from tests.scripted_provider import STATE, ScriptedSession, plan_json, resp, scripted_stream  # noqa: E402

register_provider("scripted", "test-", ScriptedSession, scripted_stream)


def script(system, messages, tools):
    user = next((m["content"] for m in reversed(messages) if m["role"] == "user" and isinstance(m["content"], str)), "")
    if "planning module" in system:
        if "email" in user.lower():
            return resp(plan_json([{"id": "s1", "agent": "communication", "instruction": "Draft and send the email",
                                    "depends_on": []},
                                   {"id": "s2", "agent": "research", "instruction": "Research the topic", "depends_on": []}],
                                  title="Email and research"))
        if "weekly review" in user.lower():
            return resp(plan_json([{"id": "s1", "agent": "operations", "instruction": "Create the weekly review automation",
                                    "depends_on": []}], title="Weekly review automation"))
        if "durable" in user.lower():
            return resp('{"title":"Memory","mode":"delegate","steps":[{"id":"s1","agent":"knowledge",'
                        '"instruction":"Remember the preference"}]}')
        return resp(plan_json(direct=f"**Hello!** I'm LEXA. You said: _{user.split('USER REQUEST:')[-1].strip()}_",
                              title="Conversation"))
    if "Write LEXA's final reply" in system and "weekly review" in str(messages).lower():
        return resp("I prepared the **Weekly review** automation. It is waiting for your approval.")
    if "Write LEXA's final reply" in system:
        return resp("I researched the topic and prepared the email. **The email is waiting for your approval** — it "
                    "has not been sent yet.")
    if any(m["role"] == "tool" for m in messages):
        return resp("Done: " + [m for m in messages if m["role"] == "tool"][-1]["content"][0][1][:200])
    if "automation_create" in tools:
        return resp("", [("automation_create", {"name": "Weekly review", "cron": "0 17 * * 5", "timezone": "UTC",
                                                "instruction": "Summarize my week"})])
    if "gmail_send" in tools:
        return resp("", [("gmail_send", {"to": "alex@example.com", "subject": "Project update",
                                         "body": "Hi Alex, the project is on track for Friday."})])
    if "memory_save" in tools:
        return resp("", [("memory_save", {"content": "User prefers concise answers", "category": "preferences"})])
    return resp("Research summary: three key findings with sources (https://example.com).")


STATE["script"] = script


async def main() -> None:
    from workers.main import maintenance_loop, worker_loop
    stop = asyncio.Event()
    config = uvicorn.Config("main:app", host="127.0.0.1", port=int(os.environ.get("PORT", "8000")), log_level="warning")
    server = uvicorn.Server(config)
    await asyncio.gather(server.serve(), maintenance_loop(stop), worker_loop(stop, 0), worker_loop(stop, 1))


if __name__ == "__main__":
    asyncio.run(main())
