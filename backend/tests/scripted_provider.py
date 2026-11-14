"""Deterministic LLM provider used ONLY by the test-suite (registered for model ids starting with 'test-')."""
from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from typing import Any

from core.llm.openai_provider import NO_CREDITS_MESSAGE
from core.llm.types import NO_CREDITS, LLMResponse, NeutralTurn, ProviderError, ToolCall, ToolSpec, Usage

Script = Callable[[str, list[dict[str, Any]], list[str]], LLMResponse]
STATE: dict[str, Any] = {"script": None, "fail_models": set(), "no_credit_models": set(), "calls": []}


def resp(text: str = "", calls: list[tuple[str, dict[str, Any]]] | None = None, model: str = "test-model") -> LLMResponse:
    tc = [ToolCall(id=f"call_{i}_{name}", name=name, input=args) for i, (name, args) in enumerate(calls or [])]
    return LLMResponse(text=text, tool_calls=tc, stop_reason="tool_use" if tc else "end_turn",
                       usage=Usage(input_tokens=100, output_tokens=20), model=model, provider="scripted")


class ScriptedSession:
    provider = "scripted"

    def __init__(self, model: str, system: str, tools: list[ToolSpec], **_: Any) -> None:
        self.model, self.system, self.tools = model, system, [t.name for t in tools]
        self.messages: list[dict[str, Any]] = []

    def load(self, turns: list[NeutralTurn]) -> None:
        for t in turns:
            if t.role == "user":
                self.add_user(t.text)
            elif t.role == "tool_results":
                self.add_tool_results(t.tool_results)

    def add_user(self, text: str) -> None:
        self.messages.append({"role": "user", "content": text})

    def add_tool_results(self, results: list[tuple[str, str, bool]]) -> None:
        self.messages.append({"role": "tool", "content": results})

    async def step(self) -> LLMResponse:
        STATE["calls"].append(self.model)
        if self.model in STATE["no_credit_models"]:
            raise ProviderError(NO_CREDITS_MESSAGE, retryable=False, provider="scripted", status=402, code=NO_CREDITS)
        if self.model in STATE["fail_models"]:
            raise ProviderError(f"{self.model} unavailable", retryable=True, provider="scripted", status=529)
        r = STATE["script"](self.system, self.messages, self.tools)
        r.model = self.model
        if r.tool_calls:
            self.messages.append({"role": "assistant", "calls": [(c.name, c.input) for c in r.tool_calls]})
        return r


async def scripted_stream(model: str, system: str, messages: list[dict[str, Any]], effort: str | None = None,
                          max_tokens: int = 0) -> AsyncIterator[tuple[str, Any]]:
    if model in STATE["fail_models"]:
        raise ProviderError(f"{model} unavailable", retryable=True, provider="scripted", status=529)
    r = STATE["script"](system, messages, [])
    for word in r.text.split(" "):
        yield "delta", word + " "
    r.model = model
    yield "final", r


def plan_json(steps: list[dict[str, Any]] | None = None, direct: str | None = None, title: str = "Test") -> str:
    if direct is not None:
        return json.dumps({"title": title, "mode": "direct", "direct_answer": direct, "steps": []})
    return json.dumps({"title": title, "mode": "delegate", "steps": steps})
