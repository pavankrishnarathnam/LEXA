"""Password hashing, JWT tokens and credential encryption."""
from __future__ import annotations

import base64
import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from cryptography.fernet import Fernet, InvalidToken

from core.config import settings

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    try:
        return _hasher.verify(hashed, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def create_token(user_id: uuid.UUID, kind: str, ttl: timedelta, extra: dict[str, Any] | None = None) -> str:
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "type": kind,
        "iat": int(now.timestamp()),
        "exp": int((now + ttl).timestamp()),
        "jti": secrets.token_hex(8),
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def create_access_token(user_id: uuid.UUID, role: str) -> str:
    return create_token(user_id, "access", timedelta(minutes=settings.jwt_access_ttl_minutes), {"role": role})


def create_refresh_token(user_id: uuid.UUID, version: int) -> str:
    return create_token(user_id, "refresh", timedelta(days=settings.jwt_refresh_ttl_days), {"ver": version})


def decode_token(token: str, expected_kind: str) -> dict[str, Any]:
    payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    if payload.get("type") != expected_kind:
        raise jwt.InvalidTokenError("wrong token type")
    return payload


def _fernet() -> Fernet:
    key = settings.encryption_key
    if not key:
        if settings.is_production:
            raise RuntimeError("ENCRYPTION_KEY is required in production")
        # Development only: derive a stable key from the JWT secret.
        key = base64.urlsafe_b64encode(hashlib.sha256(settings.jwt_secret.encode()).digest()).decode()
    return Fernet(key.encode() if isinstance(key, str) else key)


def encrypt_secret(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt_secret(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken as exc:  # pragma: no cover - indicates key rotation problem
        raise RuntimeError("Unable to decrypt stored credential; check ENCRYPTION_KEY") from exc


def new_csrf_token() -> str:
    return secrets.token_urlsafe(24)
