"""Provider abstraction: per-agent model selection, cross-provider fallback, usage logging, budgets."""
from __future__ import annotations

import time
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from core.config import settings
from core.llm import anthropic_provider, openai_provider
from core.llm.pricing import provider_for_model
from core.llm.types import (
    LLMResponse,
    NeutralTurn,
    ProviderError,
    ProviderNotConfigured,
    ServerTool,
    ToolSpec,
    Usage,
)
from core.llm.usage import ensure_budget, record_usage
from core.logging import get_logger

log = get_logger(__name__)


class Session(Protocol):
    provider: str
    def load(self, turns: list[NeutralTurn]) -> None: ...
    def add_user(self, text: str | list[dict[str, Any]]) -> None: ...
    def add_tool_results(self, results: list[tuple[str, str, bool]]) -> None: ...
    async def step(self) -> LLMResponse: ...


SessionFactory = Callable[..., Session]
StreamFn = Callable[..., AsyncIterator[tuple[str, Any]]]

_SESSION_FACTORIES: dict[str, SessionFactory] = {
    "anthropic": anthropic_provider.AnthropicSession,
    "openai": openai_provider.OpenAISession,
}
_STREAMERS: dict[str, StreamFn] = {
    "anthropic": anthropic_provider.stream_text,
    "openai": openai_provider.stream_text,
}
# model-prefix -> provider overrides (used by tests to register a scripted provider)
_PREFIX_PROVIDERS: dict[str, str] = {}


def register_provider(name: str, prefix: str, factory: SessionFactory, streamer: StreamFn) -> None:
    _SESSION_FACTORIES[name] = factory
    _STREAMERS[name] = streamer
    _PREFIX_PROVIDERS[prefix] = name


def resolve_provider(model: str) -> str:
    for prefix, name in _PREFIX_PROVIDERS.items():
        if model.startswith(prefix):
            return name
    return provider_for_model(model)


def provider_configured(provider: str) -> bool:
    if provider == "anthropic":
        return bool(settings.anthropic_api_key)
    if provider == "openai":
        return bool(settings.openai_api_key)
    return provider in _SESSION_FACTORIES


def model_chain(model: str | None) -> list[str]:
    primary = model or settings.default_model
    chain = [primary]
    if settings.fallback_model and settings.fallback_model != primary:
        chain.append(settings.fallback_model)
    if settings.default_model not in chain:
        chain.append(settings.default_model)
    return chain


@dataclass
class CallContext:
    user_id: uuid.UUID | None
    purpose: str
    task_id: uuid.UUID | None = None
    agent_slug: str | None = None


class RoutedSession:
    """Session that tracks a neutral transcript so it can fail over to another provider mid-run."""

    def __init__(self, ctx: CallContext, model: str | None, system: str, tools: list[ToolSpec],
                 server_tools: list[ServerTool] | None = None, effort: str | None = None,
                 max_tokens: int = 16000) -> None:
        self.ctx = ctx
        self.system = system
        self.tools = tools
        self.server_tools = server_tools or []
        self.effort = effort
        self.max_tokens = max_tokens
        self.chain = [m for m in model_chain(model) if provider_configured(resolve_provider(m))]
        if not self.chain:
            raise ProviderNotConfigured(
                "No AI provider is configured. Set ANTHROPIC_API_KEY (primary) or OPENAI_API_KEY in the backend "
                "environment.")
        self.turns: list[NeutralTurn] = []
        self._idx = 0
        self._session = self._make(self.chain[0])
        self.total_cost = 0.0
        self.models_used: list[str] = []

    def _make(self, model: str) -> Session:
        provider = resolve_provider(model)
        s = _SESSION_FACTORIES[provider](model=model, system=self.system, tools=self.tools,
                                         server_tools=self.server_tools, effort=self.effort,
                                         max_tokens=self.max_tokens)
        s.load(self.turns)
        return s

    @property
    def model(self) -> str:
        return self.chain[self._idx]

    def add_user(self, text: str) -> None:
        self.turns.append(NeutralTurn(role="user", text=text))
        self._session.add_user(text)

    def add_tool_results(self, results: list[tuple[str, str, bool]]) -> None:
        self.turns.append(NeutralTurn(role="tool_results", tool_results=results))
        self._session.add_tool_results(results)

    async def step(self) -> LLMResponse:
        await ensure_budget(self.ctx.user_id)
        last_exc: ProviderError | None = None
        while self._idx < len(self.chain):
            model = self.chain[self._idx]
            started = time.monotonic()
            try:
                resp = await self._session.step()
            except ProviderError as exc:
                latency = int((time.monotonic() - started) * 1000)
                await record_usage(user_id=self.ctx.user_id, provider=resolve_provider(model), model=model,
                                   usage=Usage(),
                                   purpose=self.ctx.purpose, task_id=self.ctx.task_id,
                                   agent_slug=self.ctx.agent_slug, latency_ms=latency, success=False,
                                   error=str(exc))
                last_exc = exc
                log.warning("provider %s failed (%s); trying fallback", model, exc)
                if exc.status in (400, 413, 422) and not isinstance(exc, ProviderNotConfigured):
                    raise
                self._idx += 1
                if self._idx < len(self.chain):
                    self._session = self._make(self.chain[self._idx])
                continue
            latency = int((time.monotonic() - started) * 1000)
            resp.fallback_used = resp.fallback_used or self._idx > 0
            self.total_cost += await record_usage(
                user_id=self.ctx.user_id, provider=resp.provider, model=resp.model, usage=resp.usage,
                purpose=self.ctx.purpose, task_id=self.ctx.task_id, agent_slug=self.ctx.agent_slug,
                latency_ms=latency, request_id=resp.request_id, fallback_used=resp.fallback_used)
            self.models_used.append(resp.model)
            self.turns.append(NeutralTurn(role="assistant", text=resp.text, tool_calls=resp.tool_calls))
            return resp
        assert last_exc is not None
        raise last_exc


async def complete(ctx: CallContext, prompt: str, *, system: str, model: str | None = None,
                   effort: str | None = "low", max_tokens: int = 8000) -> LLMResponse:
    s = RoutedSession(ctx, model, system, [], effort=effort, max_tokens=max_tokens)
    s.add_user(prompt)
    return await s.step()


async def stream_chat(ctx: CallContext, system: str, messages: list[dict[str, Any]], model: str | None = None,
                      effort: str | None = None) -> AsyncIterator[tuple[str, Any]]:
    """Streams a plain conversational reply with fallback before the first token."""
    await ensure_budget(ctx.user_id)
    chain = [m for m in model_chain(model) if provider_configured(resolve_provider(m))]
    if not chain:
        raise ProviderNotConfigured("No AI provider is configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.")
    last: ProviderError | None = None
    for i, m in enumerate(chain):
        provider = resolve_provider(m)
        started = time.monotonic()
        emitted = False
        try:
            async for kind, payload in _STREAMERS[provider](m, system, messages, effort=effort):
                if kind == "delta":
                    emitted = True
                    yield kind, payload
                else:
                    resp: LLMResponse = payload
                    resp.fallback_used = i > 0
                    await record_usage(user_id=ctx.user_id, provider=resp.provider, model=resp.model,
                                       usage=resp.usage, purpose=ctx.purpose, task_id=ctx.task_id,
                                       agent_slug=ctx.agent_slug,
                                       latency_ms=int((time.monotonic() - started) * 1000),
                                       request_id=resp.request_id, fallback_used=i > 0)
                    yield kind, resp
            return
        except ProviderError as exc:
            last = exc
            if emitted:
                raise
            log.warning("stream provider %s failed: %s", m, exc)
    assert last is not None
    raise last
