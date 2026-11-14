"""HTTP errors that carry a machine-readable `code` next to the human-readable message."""
from __future__ import annotations

from fastapi import HTTPException


class CodedHTTPException(HTTPException):
    """`{"detail": "<message for people>", "code": "<short id for clients>"}` (e.g. no_credits, not_configured)."""

    def __init__(self, status_code: int, detail: str, code: str) -> None:
        super().__init__(status_code=status_code, detail=detail)
        self.code = code
