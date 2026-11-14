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


def reasoning_effort(model: str, effort: str | None) -> str | None:
    """Map LEXA effort levels onto OpenAI reasoning_effort for reasoning models (gpt-5*, o-series)."""
    if not effort or not model.startswith(("gpt-5", "o1", "o3", "o4")):
        return None
    return {"low": "low", "medium": "medium", "high": "high", "xhigh": "high", "max": "high"}.get(effort)


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
        effort = reasoning_effort(self.model, self.effort)
        if effort:
            params["reasoning_effort"] = effort
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
        assistant: dict[str, Any] = {"role": "assistant", "content": msg.content or ""}
        if msg.tool_calls:
            assistant["tool_calls"] = [
                {"id": tc.id, "type": "function",
                 "function": {"name": tc.function.name, "arguments": tc.function.arguments or "{}"}}
                for tc in msg.tool_calls
            ]
        self.messages.append(assistant)
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
        extra: dict[str, Any] = {}
        eff = reasoning_effort(model, effort)
        if eff:
            extra["reasoning_effort"] = eff
        stream = await client.chat.completions.create(model=model, messages=oa_messages, stream=True,
                                                      max_completion_tokens=max_tokens,
                                                      stream_options={"include_usage": True}, **extra)
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


async def web_search(query: str, model: str | None = None) -> tuple[str, list[dict[str, str]], Usage, str]:
    """Live web search through the Responses API's hosted web_search tool. Returns (answer, citations, usage, model)."""
    client = get_client()
    model = model or settings.web_search_model
    try:
        resp = await client.responses.create(
            model=model, tools=[{"type": "web_search"}], max_output_tokens=4000,
            instructions="Search the web and answer factually and concisely. Include concrete details (names, "
                         "dates, numbers) and cite sources. Say so if results are inconclusive.",
            input=query)
    except openai.APIError as exc:
        raise _map_error(exc) from exc
    citations: dict[str, dict[str, str]] = {}
    for item in resp.output or []:
        for part in getattr(item, "content", None) or []:
            for ann in getattr(part, "annotations", None) or []:
                url = getattr(ann, "url", None)
                if url:
                    citations[url] = {"url": url, "title": getattr(ann, "title", "") or url}
    u = resp.usage
    usage = Usage(input_tokens=getattr(u, "input_tokens", 0) or 0, output_tokens=getattr(u, "output_tokens", 0) or 0)
    return resp.output_text or "", list(citations.values()), usage, resp.model or model


async def embed(texts: list[str]) -> tuple[list[list[float]], int]:
    client = get_client()
    try:
        resp = await client.embeddings.create(model=settings.embedding_model, input=texts,
                                              dimensions=settings.embedding_dim)
    except openai.APIError as exc:
        raise _map_error(exc) from exc
    return [d.embedding for d in resp.data], resp.usage.total_tokens if resp.usage else 0


# A 403/404 on a model means this account cannot use it (not enabled / unknown name): try the fallback model.
_NO_MODEL_ACCESS = (403, 404)


async def transcribe(audio: bytes, filename: str, language: str | None = None) -> tuple[str, str]:
    """Speech to text. Returns (text, model_used); falls back to STT_FALLBACK_MODEL if the primary is unavailable."""
    client = get_client()
    models = [settings.stt_model]
    if settings.stt_fallback_model and settings.stt_fallback_model != settings.stt_model:
        models.append(settings.stt_fallback_model)
    last: ProviderError | None = None
    for model in models:
        params: dict[str, Any] = {"file": (filename, audio), "model": model}
        if language:
            params["language"] = language
        try:
            resp = await client.audio.transcriptions.create(**params)
        except openai.APIError as exc:
            last = _map_error(exc)
            if last.status in _NO_MODEL_ACCESS:
                continue
            raise last from exc
        return resp.text or "", model
    assert last is not None
    raise last


async def synthesize(text: str, voice: str = "nova") -> tuple[bytes, str]:
    """Text to speech (mp3). Returns (audio, model_used); falls back to TTS_FALLBACK_MODEL if needed."""
    client = get_client()
    models = [settings.tts_model]
    if settings.tts_fallback_model and settings.tts_fallback_model != settings.tts_model:
        models.append(settings.tts_fallback_model)
    last: ProviderError | None = None
    for model in models:
        params: dict[str, Any] = {"model": model, "voice": voice, "input": text[:4000], "response_format": "mp3"}
        if model.startswith("gpt-4o"):  # only the gpt-4o TTS models accept style instructions
            params["instructions"] = "Warm, calm, clear and natural. You are LEXA, a personal AI assistant."
        try:
            resp = await client.audio.speech.create(**params)
        except openai.APIError as exc:
            last = _map_error(exc)
            if last.status in _NO_MODEL_ACCESS:
                continue
            raise last from exc
        return resp.content, model
    assert last is not None
    raise last


async def check_available() -> tuple[bool, str]:
    try:
        await get_client().models.list()
        return True, "ok"
    except ProviderNotConfigured as exc:
        return False, str(exc)
    except openai.APIError as exc:
        return False, f"{type(exc).__name__}: {exc}"
