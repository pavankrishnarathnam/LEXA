"""Provider-neutral LLM types."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass
class ToolSpec:
    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass
class ServerTool:
    """Provider-hosted tool (e.g. Claude web search). Only honoured by providers that support it."""

    kind: Literal["web_search"]
    max_uses: int = 5


@dataclass
class ToolCall:
    id: str
    name: str
    input: dict[str, Any]


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0

    def add(self, other: Usage) -> None:
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.cache_read_tokens += other.cache_read_tokens
        self.cache_write_tokens += other.cache_write_tokens


@dataclass
class LLMResponse:
    text: str
    tool_calls: list[ToolCall]
    stop_reason: str
    usage: Usage
    model: str
    provider: str
    request_id: str | None = None
    citations: list[dict[str, Any]] = field(default_factory=list)
    refusal: bool = False
    fallback_used: bool = False


@dataclass
class NeutralTurn:
    """Provider-agnostic transcript entry, used to rebuild a session on a fallback provider."""

    role: Literal["user", "assistant", "tool_results"]
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_results: list[tuple[str, str, bool]] = field(default_factory=list)  # (tool_call_id, content, is_error)


NO_CREDITS = "no_credits"  # the provider account has no balance / quota left: retrying cannot help
INVALID_KEY = "invalid_key"  # the API key was rejected


class ProviderError(Exception):
    def __init__(self, message: str, *, retryable: bool = False, provider: str = "", status: int | None = None,
                 code: str | None = None):
        super().__init__(message)
        self.retryable = retryable
        self.provider = provider
        self.status = status
        self.code = code


class ProviderNotConfigured(ProviderError):
    pass
