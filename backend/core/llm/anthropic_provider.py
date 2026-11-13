"""Anthropic Claude provider (primary)."""
from __future__ import annotations

import time
from collections.abc import AsyncIterator
from typing import Any

import anthropic
from anthropic import AsyncAnthropic

from core.config import settings
from core.llm.types import (
    LLMResponse,
    NeutralTurn,
    ProviderError,
    ProviderNotConfigured,
    ServerTool,
    ToolCall,
    ToolSpec,
    Usage,
)

# Models that accept the server-side refusal-fallback parameter.
_SERVER_FALLBACK_MODELS = ("claude-fable-5", "claude-opus-5", "claude-sonnet-5-5")
_FALLBACK_BETA = "server-side-fallback-2026-07-01"
_EFFORT_MODELS = ("claude-fable", "claude-opus", "claude-sonnet", "claude-haiku-5")

_client: AsyncAnthropic | None = None


def get_client() -> AsyncAnthropic:
    global _client
    if not settings.anthropic_api_key:
        raise ProviderNotConfigured("ANTHROPIC_API_KEY is not configured", provider="anthropic")
    if _client is None:
        _client = AsyncAnthropic(api_key=settings.anthropic_api_key, max_retries=2, timeout=300.0)
    return _client


def _map_error(exc: Exception) -> ProviderError:
    retryable = isinstance(
        exc,
        anthropic.RateLimitError
        | anthropic.InternalServerError
        | anthropic.APIConnectionError
        | anthropic.APITimeoutError
        | anthropic.OverloadedError
        | anthropic.ServiceUnavailableError,
    )
    status = getattr(exc, "status_code", None)
    msg = getattr(exc, "message", None) or str(exc)
    return ProviderError(f"Anthropic: {msg}", retryable=retryable, provider="anthropic", status=status)


def _usage(u: Any) -> Usage:
    if u is None:
        return Usage()
    return Usage(
        input_tokens=getattr(u, "input_tokens", 0) or 0,
        output_tokens=getattr(u, "output_tokens", 0) or 0,
        cache_read_tokens=getattr(u, "cache_read_input_tokens", 0) or 0,
        cache_write_tokens=getattr(u, "cache_creation_input_tokens", 0) or 0,
    )


def _tool_payload(tools: list[ToolSpec], server_tools: list[ServerTool]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = [
        {"name": t.name, "description": t.description, "input_schema": t.input_schema} for t in tools
    ]
    for st in server_tools:
        if st.kind == "web_search":
            out.append({"type": "web_search_20260209", "name": "web_search", "max_uses": st.max_uses})
    return out


def _block_to_param(block: Any) -> dict[str, Any]:
    return block.model_dump(exclude_none=True, mode="json") if hasattr(block, "model_dump") else dict(block)


class AnthropicSession:
    """Holds a provider-native transcript so thinking/tool blocks are replayed unchanged."""

    provider = "anthropic"

    def __init__(
        self,
        model: str,
        system: str,
        tools: list[ToolSpec],
        server_tools: list[ServerTool] | None = None,
        effort: str | None = None,
        max_tokens: int = 16000,
    ) -> None:
        self.model = model
        self.system = system
        self.tools = tools
        self.server_tools = server_tools or []
        self.effort = effort or settings.default_effort
        self.max_tokens = max_tokens
        self.messages: list[dict[str, Any]] = []

    def load(self, turns: list[NeutralTurn]) -> None:
        for t in turns:
            if t.role == "user":
                self.add_user(t.text)
            elif t.role == "assistant":
                content: list[dict[str, Any]] = []
                if t.text:
                    content.append({"type": "text", "text": t.text})
                content += [{"type": "tool_use", "id": c.id, "name": c.name, "input": c.input} for c in t.tool_calls]
                self.messages.append({"role": "assistant", "content": content or [{"type": "text", "text": "…"}]})
            else:
                self.add_tool_results(t.tool_results)

    def add_user(self, text: str | list[dict[str, Any]]) -> None:
        content = [{"type": "text", "text": text}] if isinstance(text, str) else text
        self.messages.append({"role": "user", "content": content})

    def add_tool_results(self, results: list[tuple[str, str, bool]]) -> None:
        # All tool results for one assistant turn go in a single user message.
        self.messages.append(
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": tid, "content": content, "is_error": is_err}
                    for tid, content, is_err in results
                ],
            }
        )

    def _params(self) -> dict[str, Any]:
        params: dict[str, Any] = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "system": [{"type": "text", "text": self.system, "cache_control": {"type": "ephemeral"}}],
            "messages": self.messages,
        }
        tools = _tool_payload(self.tools, self.server_tools)
        if tools:
            params["tools"] = tools
            params["tool_choice"] = {"type": "auto"}
        if self.model.startswith(_EFFORT_MODELS):
            params["output_config"] = {"effort": self.effort}
        return params

    async def step(self) -> LLMResponse:
        client = get_client()
        usage = Usage()
        started = time.monotonic()
        use_fallback = settings.anthropic_server_fallback and self.model.startswith(_SERVER_FALLBACK_MODELS)
        for _ in range(4):  # resume pause_turn from server tools
            try:
                if use_fallback:
                    resp = await client.beta.messages.create(
                        **self._params(), betas=[_FALLBACK_BETA], fallbacks="default"
                    )
                else:
                    resp = await client.messages.create(**self._params())
            except anthropic.APIError as exc:
                raise _map_error(exc) from exc
            usage.add(_usage(resp.usage))
            self.messages.append({"role": "assistant", "content": [_block_to_param(b) for b in resp.content]})
            if resp.stop_reason != "pause_turn":
                break
        text_parts: list[str] = []
        calls: list[ToolCall] = []
        citations: list[dict[str, Any]] = []
        fallback_used = False
        for b in resp.content:
            if b.type == "text":
                text_parts.append(b.text)
                for c in getattr(b, "citations", None) or []:
                    url = getattr(c, "url", None)
                    if url:
                        citations.append({"url": url, "title": getattr(c, "title", None)})
            elif b.type == "tool_use":
                calls.append(ToolCall(id=b.id, name=b.name, input=dict(b.input or {})))
            elif b.type == "fallback":
                fallback_used = True
        _ = started
        return LLMResponse(
            text="".join(text_parts).strip(),
            tool_calls=calls,
            stop_reason=resp.stop_reason or "end_turn",
            usage=usage,
            model=resp.model,
            provider="anthropic",
            request_id=getattr(resp, "_request_id", None),
            citations=citations,
            refusal=resp.stop_reason == "refusal",
            fallback_used=fallback_used,
        )


async def stream_text(
    model: str, system: str, messages: list[dict[str, Any]], effort: str | None = None, max_tokens: int = 32000
) -> AsyncIterator[tuple[str, Any]]:
    """Yields ("delta", text) chunks then ("final", LLMResponse)."""
    client = get_client()
    params: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        "messages": messages,
    }
    if model.startswith(_EFFORT_MODELS):
        params["output_config"] = {"effort": effort or settings.default_effort}
    try:
        async with client.messages.stream(**params) as stream:
            async for text in stream.text_stream:
                yield "delta", text
            final = await stream.get_final_message()
    except anthropic.APIError as exc:
        raise _map_error(exc) from exc
    text = "".join(b.text for b in final.content if b.type == "text")
    yield "final", LLMResponse(
        text=text,
        tool_calls=[],
        stop_reason=final.stop_reason or "end_turn",
        usage=_usage(final.usage),
        model=final.model,
        provider="anthropic",
        request_id=getattr(final, "_request_id", None),
        refusal=final.stop_reason == "refusal",
    )


async def check_available() -> tuple[bool, str]:
    try:
        client = get_client()
        await client.models.retrieve(settings.default_model)
        return True, "ok"
    except ProviderNotConfigured as exc:
        return False, str(exc)
    except anthropic.APIError as exc:
        return False, f"{type(exc).__name__}: {getattr(exc, 'message', exc)}"
