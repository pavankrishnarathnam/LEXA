"""Application configuration loaded from environment variables."""
from __future__ import annotations

from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    environment: Literal["development", "test", "production"] = "development"
    app_name: str = "LEXA"
    public_url: str = "http://localhost:3000"  # Browser-facing origin (frontend)
    api_url: str = "http://localhost:8000"  # Backend origin (OAuth redirect base)
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=lambda: ["http://localhost:3000"])

    database_url: str = "postgresql+asyncpg://lexa:lexa@localhost:5432/lexa"
    redis_url: str = "redis://localhost:6379/0"

    jwt_secret: str = "dev-insecure-jwt-secret-change-me-0123456789"  # noqa: S105 - rejected in production
    jwt_access_ttl_minutes: int = 30
    jwt_refresh_ttl_days: int = 14
    encryption_key: str = ""  # Fernet key (urlsafe base64, 32 bytes)
    cookie_secure: bool = False
    cookie_domain: str | None = None
    allow_registration: bool = True

    # AI providers
    anthropic_api_key: str = ""
    openai_api_key: str = ""
    # OpenAI is the default provider; Claude models remain available per agent or as fallback.
    default_model: str = "gpt-5.1"
    fast_model: str = "gpt-5-mini"
    fallback_model: str = "gpt-5-mini"
    web_search_model: str = "gpt-5-mini"
    default_effort: Literal["low", "medium", "high", "xhigh", "max"] = "high"
    anthropic_server_fallback: bool = True
    embedding_model: str = "text-embedding-3-small"
    embedding_dim: int = 1536
    # Voice (OpenAI). The fallback models are used when the account has no access to the primary one.
    stt_model: str = "gpt-4o-mini-transcribe"
    stt_fallback_model: str = "whisper-1"
    tts_model: str = "gpt-4o-mini-tts"
    tts_fallback_model: str = "tts-1"
    voice_stt_per_minute: int = 40  # speech segments per user per minute (cost guard)

    # Limits
    monthly_budget_usd: float = 50.0
    rate_limit_per_minute: int = 300  # per-user API requests per minute
    auth_rate_limit: int = 20  # login attempts per IP per 5 minutes (registration: half)
    max_upload_mb: int = 20
    task_timeout_seconds: int = 900
    agent_max_tool_iterations: int = 12

    # Integrations (OAuth clients)
    google_client_id: str = ""
    google_client_secret: str = ""
    github_client_id: str = ""
    github_client_secret: str = ""

    # Worker
    worker_poll_interval: float = 1.0
    worker_concurrency: int = 4

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, v: object) -> object:
        if isinstance(v, str):
            if v.strip().startswith("["):
                import json
                return json.loads(v)
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def sync_database_url(self) -> str:
        """psycopg (sync/async) URL used by LangGraph checkpointer and Alembic."""
        return self.database_url.replace("+asyncpg", "")

    def validate_production(self) -> list[str]:
        problems: list[str] = []
        if self.is_production:
            if "dev-insecure" in self.jwt_secret or len(self.jwt_secret) < 32:
                problems.append("JWT_SECRET must be a random value of at least 32 characters")
            if not self.encryption_key:
                problems.append("ENCRYPTION_KEY must be set (Fernet key)")
            if not self.cookie_secure:
                problems.append("COOKIE_SECURE must be true behind HTTPS")
        return problems


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
