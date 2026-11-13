"""Structured JSON logging."""
from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime

from core.config import settings

_REDACT_KEYS = ("password", "token", "secret", "api_key", "authorization", "otp")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        data = {
            "ts": datetime.now(UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        extra = getattr(record, "extra_data", None)
        if isinstance(extra, dict):
            data.update({k: ("[redacted]" if any(r in k.lower() for r in _REDACT_KEYS) else v) for k, v in extra.items()})
        if record.exc_info:
            data["exc"] = self.formatException(record.exc_info)
        return json.dumps(data, default=str)


def configure_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter() if settings.is_production else logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.INFO)
    for noisy in ("httpx", "httpcore", "httpx2", "anthropic", "openai"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
