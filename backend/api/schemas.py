"""Shared Pydantic request schemas."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10, max_length=200)
    full_name: str = Field(default="", max_length=200)


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(max_length=200)


class PasswordChangeIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=10, max_length=200)


class ProfileIn(BaseModel):
    full_name: str | None = Field(default=None, max_length=200)
    headline: str | None = Field(default=None, max_length=300)
    location: str | None = Field(default=None, max_length=200)
    timezone: str | None = Field(default=None, max_length=64)
    bio: str | None = Field(default=None, max_length=5000)
    skills: list[str] | None = None
    education: list[dict[str, Any]] | None = None
    employment: list[dict[str, Any]] | None = None
    career_preferences: dict[str, Any] | None = None


class SettingsIn(BaseModel):
    permission_mode: Literal["read_analyze", "prepare_approve", "rule_autonomy"] | None = None
    monthly_budget_usd: float | None = Field(default=None, ge=0, le=100000)
    theme: Literal["dark", "light", "system"] | None = None
    voice: str | None = Field(default=None, max_length=40)
    speak_responses: bool | None = None
    notifications: dict[str, bool] | None = None
    auto_memory: bool | None = None
    # Voice preferences
    voice_speed: float | None = Field(default=None, ge=0.6, le=1.8)
    voice_language: str | None = Field(default=None, max_length=3, pattern=r"^([a-z]{2,3})?$")  # "" = auto-detect
    voice_patience: Literal["quick", "normal", "patient"] | None = None
    voice_auto_start: bool | None = None
    voice_wake_phrase: bool | None = None
    voice_cues: bool | None = None
    voice_engine: Literal["server", "browser"] | None = None  # who SPEAKS: OpenAI voice or the browser voice (free)
    voice_recognition: Literal["auto", "server", "browser"] | None = None  # who LISTENS: OpenAI, the browser (free) or auto


class MessageIn(BaseModel):
    content: str = Field(min_length=1, max_length=20000)
    document_ids: list[str] = Field(default_factory=list, max_length=10)
    agent: str | None = Field(default=None, max_length=64)
    voice: bool = False  # the user is listening (text-to-speech): LEXA answers in short spoken sentences


class AgentIn(BaseModel):
    slug: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9_-]{1,40}$")
    name: str = Field(min_length=2, max_length=120)
    description: str = Field(default="", max_length=2000)
    role: str = Field(default="", max_length=200)
    icon: str = Field(default="bot", max_length=48)
    system_prompt: str = Field(min_length=10, max_length=20000)
    model: str | None = Field(default=None, max_length=100)
    effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None
    tools: list[str] = Field(default_factory=list)
    permission_mode: Literal["read_analyze", "prepare_approve", "rule_autonomy"] | None = None
    memory_access: Literal["none", "read", "read_write"] = "read"
    max_tool_iterations: int = Field(default=8, ge=1, le=25)
    max_cost_usd_per_run: float = Field(default=1.0, ge=0.01, le=50)
    autonomy_rules: list[dict[str, Any]] = Field(default_factory=list)
    enabled: bool = True


class AgentPatch(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    system_prompt: str | None = Field(default=None, max_length=20000)
    model: str | None = Field(default=None, max_length=100)
    effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None
    tools: list[str] | None = None
    permission_mode: Literal["read_analyze", "prepare_approve", "rule_autonomy"] | None = None
    memory_access: Literal["none", "read", "read_write"] | None = None
    max_tool_iterations: int | None = Field(default=None, ge=1, le=25)
    max_cost_usd_per_run: float | None = Field(default=None, ge=0.01, le=50)
    autonomy_rules: list[dict[str, Any]] | None = None
    enabled: bool | None = None


class MemoryIn(BaseModel):
    content: str = Field(min_length=3, max_length=4000)
    category: str = "general"
    importance: float = Field(default=0.5, ge=0, le=1)
    pinned: bool = False


class MemoryPatch(BaseModel):
    content: str | None = Field(default=None, max_length=4000)
    category: str | None = None
    importance: float | None = Field(default=None, ge=0, le=1)
    pinned: bool | None = None


class ApprovalDecisionIn(BaseModel):
    approve: bool
    note: str | None = Field(default=None, max_length=1000)


class AutomationIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    description: str = Field(default="", max_length=2000)
    trigger_type: Literal["schedule", "webhook", "event", "manual"]
    cron: str | None = Field(default=None, max_length=100)
    timezone: str = "UTC"
    event_name: str | None = Field(default=None, max_length=100)
    conditions: list[dict[str, Any]] = Field(default_factory=list)
    instruction: str = Field(min_length=3, max_length=8000)
    agent_slug: str | None = None
    enabled: bool = True


class IntegrationConnectIn(BaseModel):
    credentials: dict[str, str] = Field(default_factory=dict)


class JobIn(BaseModel):
    title: str = Field(max_length=300)
    company: str = Field(max_length=200)
    url: str | None = Field(default=None, max_length=1000)
    location: str = ""
    remote_type: Literal["remote", "hybrid", "onsite", "unknown"] = "unknown"
    employment_type: str = ""
    description: str = Field(default="", max_length=50000)
    required_skills: list[str] = Field(default_factory=list)
    salary_min: float | None = None
    salary_max: float | None = None
    salary_currency: str | None = None


class ApplicationPatch(BaseModel):
    status: Literal["draft", "ready", "submitted", "interviewing", "offer", "rejected", "withdrawn"] | None = None
    cover_letter: str | None = Field(default=None, max_length=20000)
    notes: str | None = Field(default=None, max_length=10000)


class ContactIn(BaseModel):
    name: str = Field(max_length=200)
    email: str | None = Field(default=None, max_length=320)
    phone: str | None = Field(default=None, max_length=40)
    company: str | None = Field(default=None, max_length=200)
    relationship_type: str = "other"
    notes: str = ""
    tags: list[str] = Field(default_factory=list)


class FinanceIn(BaseModel):
    kind: Literal["expense", "income", "bill", "subscription"]
    amount: float = Field(gt=0)
    currency: str = "USD"
    category: str = "other"
    description: str = ""
    occurred_on: str | None = None
    due_on: str | None = None
    recurrence: Literal["monthly", "yearly", "weekly"] | None = None
