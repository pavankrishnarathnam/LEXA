"""OpenAI provider (secondary): chat fallback, embeddings, speech-to-text and text-to-speech."""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import openai
from openai import AsyncOpenAI

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

_client: AsyncOpenAI | None = None


def get_client() -> AsyncOpenAI:
    global _client
    if not settings.openai_api_key:
        raise ProviderNotConfigured("OPENAI_API_KEY is not configured", provider="openai")
    if _client is None:
        _client = AsyncOpenAI(api_key=settings.openai_api_key, max_retries=2, timeout=300.0)
    return _client


def _map_error(exc: Exception) -> ProviderError:
    retryable = isinstance(
        exc, openai.RateLimitError | openai.InternalServerError | openai.APIConnectionError | openai.APITimeoutError
    )
    return ProviderError(f"OpenAI: {exc}", retryable=retryable, provider="openai",
                         status=getattr(exc, "status_code", None))


def _usage(u: Any) -> Usage:
    if not u:
        return Usage()
    cached = getattr(getattr(u, "prompt_tokens_details", None), "cached_tokens", 0) or 0
    return Usage(input_tokens=(u.prompt_tokens or 0) - cached, output_tokens=u.completion_tokens or 0,
                 cache_read_tokens=cached)


class OpenAISession:
    provider = "openai"

    def __init__(self, model: str, system: str, tools: list[ToolSpec], server_tools: list[ServerTool] | None = None,
                 effort: str | None = None, max_tokens: int = 16000) -> None:
        self.model = model
        self.tools = tools
        self.max_tokens = max_tokens
        self.effort = effort
        # Server tools (Claude web search) are not available here; agents fall back to http tools.
        self.messages: list[dict[str, Any]] = [{"role": "system", "content": system}]

    def load(self, turns: list[NeutralTurn]) -> None:
        for t in turns:
            if t.role == "user":
                self.add_user(t.text)
            elif t.role == "assistant":
                msg: dict[str, Any] = {"role": "assistant", "content": t.text or None}
                if t.tool_calls:
                    msg["tool_calls"] = [
                        {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": json.dumps(c.input)}}
                        for c in t.tool_calls
                    ]
                self.messages.append(msg)
            else:
                self.add_tool_results(t.tool_results)

    def add_user(self, text: str | list[dict[str, Any]]) -> None:
        if not isinstance(text, str):
            text = "\n".join(b.get("text", "") for b in text if b.get("type") == "text")
        self.messages.append({"role": "user", "content": text})

    def add_tool_results(self, results: list[tuple[str, str, bool]]) -> None:
        for tid, content, is_err in results:
            self.messages.append({"role": "tool", "tool_call_id": tid, "content": ("ERROR: " if is_err else "") + content})

    async def step(self) -> LLMResponse:
        client = get_client()
        params: dict[str, Any] = {"model": self.model, "messages": self.messages,
                                  "max_completion_tokens": self.max_tokens}
        if self.tools:
            params["tools"] = [
                {"type": "function", "function": {"name": t.name, "description": t.description,
                                                  "parameters": t.input_schema}}
                for t in self.tools
            ]
        try:
            resp = await client.chat.completions.create(**params)
        except openai.APIError as exc:
            raise _map_error(exc) from exc
        choice = resp.choices[0]
        msg = choice.message
        calls: list[ToolCall] = []
        for tc in msg.tool_calls or []:
            try:
                args = json.loads(tc.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {"_invalid_json": tc.function.arguments}
            calls.append(ToolCall(id=tc.id, name=tc.function.name, input=args))
        self.messages.append(msg.model_dump(exclude_none=True))
        stop = {"tool_calls": "tool_use", "length": "max_tokens", "content_filter": "refusal"}.get(
            choice.finish_reason or "", "end_turn")
        return LLMResponse(text=(msg.content or "").strip(), tool_calls=calls, stop_reason=stop,
                           usage=_usage(resp.usage), model=resp.model, provider="openai",
                           request_id=resp.id, refusal=stop == "refusal")


async def stream_text(model: str, system: str, messages: list[dict[str, Any]], effort: str | None = None,
                      max_tokens: int = 16000) -> AsyncIterator[tuple[str, Any]]:
    client = get_client()
    oa_messages = [{"role": "system", "content": system}] + [
        {"role": m["role"], "content": m["content"] if isinstance(m["content"], str)
         else "\n".join(b.get("text", "") for b in m["content"] if b.get("type") == "text")}
        for m in messages
    ]
    parts: list[str] = []
    usage = Usage()
    model_used = model
    try:
        stream = await client.chat.completions.create(model=model, messages=oa_messages, stream=True,
                                                      max_completion_tokens=max_tokens,
                                                      stream_options={"include_usage": True})
        async for chunk in stream:
            model_used = chunk.model or model_used
            if chunk.usage:
                usage = _usage(chunk.usage)
            if chunk.choices and chunk.choices[0].delta.content:
                parts.append(chunk.choices[0].delta.content)
                yield "delta", chunk.choices[0].delta.content
    except openai.APIError as exc:
        raise _map_error(exc) from exc
    yield "final", LLMResponse(text="".join(parts), tool_calls=[], stop_reason="end_turn", usage=usage,
                               model=model_used, provider="openai")


async def embed(texts: list[str]) -> tuple[list[list[float]], int]:
    client = get_client()
    try:
        resp = await client.embeddings.create(model=settings.embedding_model, input=texts,
                                              dimensions=settings.embedding_dim)
    except openai.APIError as exc:
        raise _map_error(exc) from exc
    return [d.embedding for d in resp.data], resp.usage.total_tokens if resp.usage else 0


async def transcribe(audio: bytes, filename: str, model: str = "gpt-4o-mini-transcribe") -> str:
    client = get_client()
    try:
        resp = await client.audio.transcriptions.create(file=(filename, audio), model=model)
    except openai.APIError as exc:
        raise _map_error(exc) from exc
    return resp.text


async def synthesize(text: str, voice: str = "nova", model: str = "gpt-4o-mini-tts") -> bytes:
    client = get_client()
    try:
        resp = await client.audio.speech.create(
            model=model, voice=voice, input=text[:4000], response_format="mp3",
            instructions="Warm, calm, confident and concise. You are LEXA, a personal AI operating system.")
    except openai.APIError as exc:
        raise _map_error(exc) from exc
    return resp.content


async def check_available() -> tuple[bool, str]:
    try:
        await get_client().models.list()
        return True, "ok"
    except ProviderNotConfigured as exc:
        return False, str(exc)
    except openai.APIError as exc:
        return False, f"{type(exc).__name__}: {exc}"
