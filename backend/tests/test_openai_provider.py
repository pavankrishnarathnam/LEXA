"""OpenAI provider tests with a mocked client returning real OpenAI SDK response objects."""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from openai.types.chat import ChatCompletion
from openai.types.responses import Response

from core.llm import openai_provider
from core.llm.openai_provider import OpenAISession, reasoning_effort
from core.llm.types import ToolSpec


class FakeCompletions:
    def __init__(self, replies: list[dict[str, Any]]):
        self.replies = replies
        self.calls: list[dict[str, Any]] = []

    async def create(self, **params: Any) -> ChatCompletion:
        self.calls.append(params)
        msg = self.replies.pop(0)
        return ChatCompletion.model_validate({
            "id": "chatcmpl-1", "object": "chat.completion", "created": 0, "model": params["model"],
            "choices": [{"index": 0, "finish_reason": "tool_calls" if msg.get("tool_calls") else "stop",
                         "message": {"role": "assistant", "content": msg.get("content"),
                                     "tool_calls": msg.get("tool_calls")}}],
            "usage": {"prompt_tokens": 120, "completion_tokens": 30, "total_tokens": 150,
                      "prompt_tokens_details": {"cached_tokens": 20}},
        })


def fake_client(replies: list[dict[str, Any]]) -> SimpleNamespace:
    return SimpleNamespace(chat=SimpleNamespace(completions=FakeCompletions(replies)))


def test_reasoning_effort_mapping():
    assert reasoning_effort("gpt-5.1", "high") == "high"
    assert reasoning_effort("gpt-5-mini", "max") == "high"
    assert reasoning_effort("gpt-4o", "high") is None
    assert reasoning_effort("gpt-5.1", None) is None


async def test_tool_call_round_trip(monkeypatch: pytest.MonkeyPatch):
    client = fake_client([
        {"content": None, "tool_calls": [{"id": "call_1", "type": "function",
                                          "function": {"name": "memory_search", "arguments": '{"query": "jobs"}'}}]},
        {"content": "You prefer remote roles."},
    ])
    monkeypatch.setattr(openai_provider, "get_client", lambda: client)
    s = OpenAISession(model="gpt-5.1", system="sys", effort="high",
                      tools=[ToolSpec("memory_search", "Search memory", {"type": "object", "properties": {}})])
    s.add_user("What do I prefer?")
    r1 = await s.step()
    assert r1.stop_reason == "tool_use" and r1.tool_calls[0].name == "memory_search"
    assert r1.tool_calls[0].input == {"query": "jobs"}
    assert r1.usage.input_tokens == 100 and r1.usage.cache_read_tokens == 20
    first = client.chat.completions.calls[0]
    assert first["reasoning_effort"] == "high"
    assert first["tools"][0]["function"]["name"] == "memory_search"
    s.add_tool_results([("call_1", "User prefers remote roles", False)])
    r2 = await s.step()
    assert r2.text == "You prefer remote roles." and r2.stop_reason == "end_turn"
    sent = client.chat.completions.calls[1]["messages"]
    assert [m["role"] for m in sent] == ["system", "user", "assistant", "tool", "assistant"]
    # The replayed assistant turn carries only fields the API accepts.
    assert set(sent[2]) == {"role", "content", "tool_calls"}
    assert sent[3] == {"role": "tool", "tool_call_id": "call_1", "content": "User prefers remote roles"}


async def test_invalid_tool_json_is_surfaced(monkeypatch: pytest.MonkeyPatch):
    client = fake_client([{"content": None, "tool_calls": [
        {"id": "c", "type": "function", "function": {"name": "web_fetch", "arguments": "{not json"}}]}])
    monkeypatch.setattr(openai_provider, "get_client", lambda: client)
    s = OpenAISession(model="gpt-5.1", system="s", tools=[])
    s.add_user("x")
    r = await s.step()
    assert r.tool_calls[0].input == {"_invalid_json": "{not json"}


async def test_web_search_via_responses_api(monkeypatch: pytest.MonkeyPatch):
    captured: dict[str, Any] = {}

    async def create(**params: Any) -> Response:
        captured.update(params)
        return Response.model_validate({
            "id": "resp_1", "object": "response", "created_at": 0, "model": params["model"], "status": "completed",
            "parallel_tool_calls": True, "tool_choice": "auto", "tools": [],
            "output": [{"type": "message", "id": "msg_1", "role": "assistant", "status": "completed", "content": [
                {"type": "output_text", "text": "FastAPI 0.162 was released.", "annotations": [
                    {"type": "url_citation", "url": "https://example.com/release", "title": "Release notes",
                     "start_index": 0, "end_index": 10}]}]}],
            "usage": {"input_tokens": 50, "output_tokens": 20, "total_tokens": 70,
                      "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}},
        })

    monkeypatch.setattr(openai_provider, "get_client", lambda: SimpleNamespace(responses=SimpleNamespace(create=create)))
    text, citations, usage, model = await openai_provider.web_search("latest FastAPI release")
    assert captured["tools"] == [{"type": "web_search"}]
    assert text == "FastAPI 0.162 was released."
    assert citations == [{"url": "https://example.com/release", "title": "Release notes"}]
    assert usage.input_tokens == 50 and model == "gpt-5-mini"


async def test_research_agent_gets_web_search_tool_on_openai(monkeypatch: pytest.MonkeyPatch, client):
    """With an OpenAI primary model, agents that need search receive the web_search function tool."""
    from agents import runner
    from agents.registry import builtin_config
    from core.llm import router
    from tests.scripted_provider import STATE, resp

    seen: dict[str, Any] = {}

    def script(system, messages, tools):
        seen["tools"] = tools
        return resp("done")

    STATE["script"] = script
    monkeypatch.setattr(router, "provider_configured", lambda p: p in ("scripted", "openai"))
    monkeypatch.setattr(runner, "provider_configured", lambda p: p in ("scripted", "openai"))
    me = (await client.get("/api/auth/me")).json()
    import uuid
    await runner.run_agent(builtin_config("research"), uuid.UUID(me["id"]), "find news", task_id=None)
    assert "web_search" in seen["tools"]
