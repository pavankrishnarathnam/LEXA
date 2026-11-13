"""SQLAlchemy ORM models. Every user-owned row carries user_id for strict tenant isolation."""
from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from core.config import settings
from database.base import Base, IdMixin, TimestampMixin


def _enum(cls: type[enum.Enum], name: str) -> Enum:
    return Enum(cls, name=name, values_callable=lambda e: [m.value for m in e], native_enum=False, length=32)


class UserRole(str, enum.Enum):
    OWNER = "owner"
    ADMIN = "admin"
    MEMBER = "member"


class PermissionMode(str, enum.Enum):
    READ_ANALYZE = "read_analyze"
    PREPARE_APPROVE = "prepare_approve"
    RULE_AUTONOMY = "rule_autonomy"


class TaskStatus(str, enum.Enum):
    PENDING = "PENDING"
    PLANNING = "PLANNING"
    IN_PROGRESS = "IN_PROGRESS"
    WAITING_FOR_APPROVAL = "WAITING_FOR_APPROVAL"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


TERMINAL_STATUSES = {TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED}


class ApprovalStatus(str, enum.Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXECUTED = "executed"
    FAILED = "failed"
    EXPIRED = "expired"


class JobStatus(str, enum.Enum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


# ---------------------------------------------------------------- users
class User(IdMixin, TimestampMixin, Base):
    __tablename__ = "users"
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    full_name: Mapped[str] = mapped_column(String(200), default="")
    role: Mapped[UserRole] = mapped_column(_enum(UserRole, "user_role"), default=UserRole.MEMBER)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    token_version: Mapped[int] = mapped_column(Integer, default=0)
    permission_mode: Mapped[PermissionMode] = mapped_column(
        _enum(PermissionMode, "permission_mode"), default=PermissionMode.PREPARE_APPROVE
    )
    settings: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    profile: Mapped[UserProfile | None] = relationship(back_populates="user", uselist=False, cascade="all, delete")


class UserProfile(IdMixin, TimestampMixin, Base):
    __tablename__ = "user_profiles"
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), unique=True)
    headline: Mapped[str] = mapped_column(String(300), default="")
    location: Mapped[str] = mapped_column(String(200), default="")
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    bio: Mapped[str] = mapped_column(Text, default="")
    skills: Mapped[list[str]] = mapped_column(JSONB, default=list)
    education: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    employment: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    career_preferences: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    user: Mapped[User] = relationship(back_populates="profile")


# ---------------------------------------------------------------- agents
class Agent(IdMixin, TimestampMixin, Base):
    """Agent definition. Built-in agents have user_id NULL and is_builtin=True; overrides are per user."""

    __tablename__ = "agents"
    __table_args__ = (UniqueConstraint("user_id", "slug", name="uq_agents_user_slug"),)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    slug: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    role: Mapped[str] = mapped_column(String(200), default="")
    icon: Mapped[str] = mapped_column(String(48), default="bot")
    model: Mapped[str | None] = mapped_column(String(100))
    effort: Mapped[str | None] = mapped_column(String(16))
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    permission_mode: Mapped[PermissionMode | None] = mapped_column(_enum(PermissionMode, "agent_permission_mode"))
    memory_access: Mapped[str] = mapped_column(String(16), default="read")  # none | read | read_write
    max_tool_iterations: Mapped[int] = mapped_column(Integer, default=8)
    max_cost_usd_per_run: Mapped[float] = mapped_column(Float, default=1.0)
    autonomy_rules: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)

    prompts: Mapped[list[AgentPrompt]] = relationship(cascade="all, delete-orphan", order_by="AgentPrompt.version")
    tools: Mapped[list[AgentTool]] = relationship(cascade="all, delete-orphan")


class AgentPrompt(IdMixin, TimestampMixin, Base):
    __tablename__ = "agent_prompts"
    agent_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    system_prompt: Mapped[str] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class AgentTool(IdMixin, TimestampMixin, Base):
    __tablename__ = "agent_tools"
    __table_args__ = (UniqueConstraint("agent_id", "tool_name", name="uq_agent_tools_agent_tool"),)
    agent_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"), index=True)
    tool_name: Mapped[str] = mapped_column(String(100))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    config: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)


# ---------------------------------------------------------------- conversations
class Conversation(IdMixin, TimestampMixin, Base):
    __tablename__ = "conversations"
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(300), default="New conversation")
    summary: Mapped[str] = mapped_column(Text, default="")
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    messages: Mapped[list[Message]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan", order_by="Message.created_at"
    )


class Message(IdMixin, TimestampMixin, Base):
    __tablename__ = "messages"
    __table_args__ = (Index("ix_messages_conversation_created", "conversation_id", "created_at"),)
    conversation_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16))  # user | assistant | system
    content: Mapped[str] = mapped_column(Text, default="")
    task_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("tasks.id", ondelete="SET NULL"))
    attachments: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    meta: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    conversation: Mapped[Conversation] = relationship(back_populates="messages")


# ---------------------------------------------------------------- memory & documents
class Memory(IdMixin, TimestampMixin, Base):
    __tablename__ = "memories"
    __table_args__ = (
        Index("ix_memories_user_category", "user_id", "category"),
        Index(
            "ix_memories_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_with={"m": 16, "ef_construction": 64},
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    category: Mapped[str] = mapped_column(String(40))
    content: Mapped[str] = mapped_column(Text)
    content_hash: Mapped[str] = mapped_column(String(64), index=True)
    source: Mapped[str] = mapped_column(String(40), default="user")  # user | extracted | document | agent
    source_ref: Mapped[str | None] = mapped_column(String(200))
    importance: Mapped[float] = mapped_column(Float, default=0.5)
    confidence: Mapped[float] = mapped_column(Float, default=1.0)
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(settings.embedding_dim))
    embedding_model: Mapped[str | None] = mapped_column(String(80))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_accessed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    meta: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)


class Document(IdMixin, TimestampMixin, Base):
    __tablename__ = "documents"
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    filename: Mapped[str] = mapped_column(String(300))
    mime_type: Mapped[str] = mapped_column(String(120))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64))
    storage_path: Mapped[str] = mapped_column(String(500))
    kind: Mapped[str] = mapped_column(String(40), default="general")  # general | resume | cover_letter | report
    text_content: Mapped[str] = mapped_column(Text, default="")
    indexed: Mapped[bool] = mapped_column(Boolean, default=False)
    meta: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)


# ---------------------------------------------------------------- tasks
class Task(IdMixin, TimestampMixin, Base):
    __tablename__ = "tasks"
    __table_args__ = (Index("ix_tasks_user_status", "user_id", "status"),)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("conversations.id", ondelete="SET NULL"))
    parent_task_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("tasks.id", ondelete="SET NULL"))
    workflow_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("automation_workflows.id", ondelete="SET NULL"))
    title: Mapped[str] = mapped_column(String(300), default="")
    request: Mapped[str] = mapped_column(Text)
    status: Mapped[TaskStatus] = mapped_column(_enum(TaskStatus, "task_status"), default=TaskStatus.PENDING)
    plan: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    assigned_agents: Mapped[list[str]] = mapped_column(JSONB, default=list)
    logs: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    output: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=2)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(128), index=True)
    cost_usd: Mapped[float] = mapped_column(Numeric(12, 6, asdecimal=False), default=0.0)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    executions: Mapped[list[TaskExecution]] = relationship(
        cascade="all, delete-orphan", order_by="TaskExecution.created_at"
    )


class TaskExecution(IdMixin, TimestampMixin, Base):
    """One agent step within a task."""

    __tablename__ = "task_executions"
    task_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    step_id: Mapped[str] = mapped_column(String(32))
    agent_slug: Mapped[str] = mapped_column(String(64))
    instruction: Mapped[str] = mapped_column(Text)
    status: Mapped[TaskStatus] = mapped_column(_enum(TaskStatus, "execution_status"), default=TaskStatus.PENDING)
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    output: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    tool_calls: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    model: Mapped[str | None] = mapped_column(String(100))
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Numeric(12, 6, asdecimal=False), default=0.0)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Approval(IdMixin, TimestampMixin, Base):
    __tablename__ = "approvals"
    __table_args__ = (Index("ix_approvals_user_status", "user_id", "status"),)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    task_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
    agent_slug: Mapped[str] = mapped_column(String(64))
    tool_name: Mapped[str] = mapped_column(String(100))
    action_summary: Mapped[str] = mapped_column(Text)
    arguments: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    risk_level: Mapped[str] = mapped_column(String(16), default="medium")
    reason: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[ApprovalStatus] = mapped_column(_enum(ApprovalStatus, "approval_status"), default=ApprovalStatus.PENDING)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_note: Mapped[str | None] = mapped_column(Text)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    action_hash: Mapped[str] = mapped_column(String(64), index=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# ---------------------------------------------------------------- integrations
class Integration(IdMixin, TimestampMixin, Base):
    __tablename__ = "integrations"
    __table_args__ = (UniqueConstraint("user_id", "provider", name="uq_integrations_user_provider"),)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(String(48))
    status: Mapped[str] = mapped_column(String(24), default="disconnected")  # connected | error | disconnected | pending
    scopes: Mapped[list[str]] = mapped_column(JSONB, default=list)
    account_label: Mapped[str | None] = mapped_column(String(200))
    encrypted_credentials: Mapped[str | None] = mapped_column(Text)
    config: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    token_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    connected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# ---------------------------------------------------------------- automations
class AutomationWorkflow(IdMixin, TimestampMixin, Base):
    __tablename__ = "automation_workflows"
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    trigger_type: Mapped[str] = mapped_column(String(24))  # schedule | webhook | event | manual
    cron: Mapped[str | None] = mapped_column(String(100))
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    event_name: Mapped[str | None] = mapped_column(String(100))
    conditions: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    instruction: Mapped[str] = mapped_column(Text)
    agent_slug: Mapped[str | None] = mapped_column(String(64))
    n8n_webhook_url: Mapped[str | None] = mapped_column(String(500))
    webhook_secret_hash: Mapped[str | None] = mapped_column(String(128))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_status: Mapped[str | None] = mapped_column(String(24))
    run_count: Mapped[int] = mapped_column(Integer, default=0)


# ---------------------------------------------------------------- notifications / audit / usage
class Notification(IdMixin, TimestampMixin, Base):
    __tablename__ = "notifications"
    __table_args__ = (Index("ix_notifications_user_read", "user_id", "read"),)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(32))  # task | approval | security | integration | system
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text, default="")
    link: Mapped[str | None] = mapped_column(String(300))
    severity: Mapped[str] = mapped_column(String(16), default="info")
    read: Mapped[bool] = mapped_column(Boolean, default=False)


class AuditLog(IdMixin, TimestampMixin, Base):
    __tablename__ = "audit_logs"
    __table_args__ = (Index("ix_audit_user_created", "user_id", "created_at"),)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    actor: Mapped[str] = mapped_column(String(64))  # user | agent:<slug> | system | worker
    action: Mapped[str] = mapped_column(String(100), index=True)
    category: Mapped[str] = mapped_column(String(32), default="general")
    target_type: Mapped[str | None] = mapped_column(String(48))
    target_id: Mapped[str | None] = mapped_column(String(64))
    ip_address: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(300))
    success: Mapped[bool] = mapped_column(Boolean, default=True)
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)


class UsageRecord(IdMixin, TimestampMixin, Base):
    __tablename__ = "usage_records"
    __table_args__ = (Index("ix_usage_user_created", "user_id", "created_at"),)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    task_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("tasks.id", ondelete="SET NULL"))
    agent_slug: Mapped[str | None] = mapped_column(String(64))
    provider: Mapped[str] = mapped_column(String(24))
    model: Mapped[str] = mapped_column(String(100))
    purpose: Mapped[str] = mapped_column(String(48), default="chat")
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_read_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_write_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Numeric(12, 6, asdecimal=False), default=0.0)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    success: Mapped[bool] = mapped_column(Boolean, default=True)
    error: Mapped[str | None] = mapped_column(Text)
    request_id: Mapped[str | None] = mapped_column(String(100))
    fallback_used: Mapped[bool] = mapped_column(Boolean, default=False)


# ---------------------------------------------------------------- career
class JobOpportunity(IdMixin, TimestampMixin, Base):
    __tablename__ = "job_opportunities"
    __table_args__ = (UniqueConstraint("user_id", "fingerprint", name="uq_job_opportunities_user_fingerprint"),)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    fingerprint: Mapped[str] = mapped_column(String(64))
    title: Mapped[str] = mapped_column(String(300))
    company: Mapped[str] = mapped_column(String(200))
    location: Mapped[str] = mapped_column(String(200), default="")
    remote_type: Mapped[str] = mapped_column(String(24), default="unknown")
    employment_type: Mapped[str] = mapped_column(String(40), default="")
    salary_min: Mapped[float | None] = mapped_column(Float)
    salary_max: Mapped[float | None] = mapped_column(Float)
    salary_currency: Mapped[str | None] = mapped_column(String(8))
    url: Mapped[str | None] = mapped_column(String(1000))
    source: Mapped[str] = mapped_column(String(80), default="manual")
    description: Mapped[str] = mapped_column(Text, default="")
    required_skills: Mapped[list[str]] = mapped_column(JSONB, default=list)
    match_score: Mapped[float | None] = mapped_column(Float)
    match_analysis: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    saved: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(24), default="new")  # new | saved | dismissed | applied


class JobApplication(IdMixin, TimestampMixin, Base):
    __tablename__ = "job_applications"
    __table_args__ = (UniqueConstraint("user_id", "job_id", name="uq_job_applications_user_job"),)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("job_opportunities.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(String(32), default="draft")  # draft|ready|submitted|interviewing|offer|rejected|withdrawn
    resume_document_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("documents.id", ondelete="SET NULL"))
    cover_letter: Mapped[str] = mapped_column(Text, default="")
    answers: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    submission_method: Mapped[str | None] = mapped_column(String(40))
    notes: Mapped[str] = mapped_column(Text, default="")
    timeline: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    job: Mapped[JobOpportunity] = relationship()


# ---------------------------------------------------------------- contacts & projects
class Contact(IdMixin, TimestampMixin, Base):
    __tablename__ = "contacts"
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    email: Mapped[str | None] = mapped_column(String(320))
    phone: Mapped[str | None] = mapped_column(String(40))
    company: Mapped[str | None] = mapped_column(String(200))
    relationship_type: Mapped[str] = mapped_column(String(40), default="other")
    notes: Mapped[str] = mapped_column(Text, default="")
    tags: Mapped[list[str]] = mapped_column(JSONB, default=list)
    last_contacted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Project(IdMixin, TimestampMixin, Base):
    __tablename__ = "projects"
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(24), default="active")
    repository: Mapped[str | None] = mapped_column(String(300))
    meta: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)


# ---------------------------------------------------------------- durable job queue
class Job(IdMixin, TimestampMixin, Base):
    """Durable background job queue (claimed with FOR UPDATE SKIP LOCKED)."""

    __tablename__ = "jobs"
    __table_args__ = (Index("ix_jobs_status_run_at", "status", "run_at"),)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(48))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    status: Mapped[JobStatus] = mapped_column(_enum(JobStatus, "job_status"), default=JobStatus.QUEUED)
    run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    locked_by: Mapped[str | None] = mapped_column(String(100))
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)


class DeploymentRecord(IdMixin, TimestampMixin, Base):
    __tablename__ = "deployment_records"
    version: Mapped[str] = mapped_column(String(100))
    git_sha: Mapped[str | None] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(24))
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)


class FinanceEntry(IdMixin, TimestampMixin, Base):
    """Expense / income / bill / subscription ledger for the Finance agent (no payment execution)."""

    __tablename__ = "finance_entries"
    __table_args__ = (Index("ix_finance_user_date", "user_id", "occurred_on"),)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(16))  # expense | income | bill | subscription
    amount: Mapped[float] = mapped_column(Numeric(14, 2, asdecimal=False))
    currency: Mapped[str] = mapped_column(String(8), default="USD")
    category: Mapped[str] = mapped_column(String(60), default="other")
    description: Mapped[str] = mapped_column(String(300), default="")
    occurred_on: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    due_on: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    recurrence: Mapped[str | None] = mapped_column(String(16))  # monthly | yearly | weekly
    active: Mapped[bool] = mapped_column(Boolean, default=True)
