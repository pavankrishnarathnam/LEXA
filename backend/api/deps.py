"""Shared FastAPI dependencies: auth, CSRF, rate limiting, RBAC."""
from __future__ import annotations

import uuid
from typing import Annotated

import jwt
from fastapi import Cookie, Depends, Header, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from core.redis import rate_limit
from core.security import decode_token
from database.models import User, UserRole
from database.session import get_db

DB = Annotated[AsyncSession, Depends(get_db)]
ACCESS_COOKIE = "lexa_access"
REFRESH_COOKIE = "lexa_refresh"
CSRF_COOKIE = "lexa_csrf"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


async def get_current_user(
    request: Request,
    db: DB,
    lexa_access: Annotated[str | None, Cookie()] = None,
    authorization: Annotated[str | None, Header()] = None,
    x_csrf_token: Annotated[str | None, Header()] = None,
) -> User:
    token = None
    via_cookie = False
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:]
    elif lexa_access:
        token, via_cookie = lexa_access, True
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    try:
        payload = decode_token(token, "access")
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired session") from exc

    # Double-submit CSRF protection for cookie-authenticated state-changing requests.
    if via_cookie and request.method not in SAFE_METHODS:
        csrf_cookie = request.cookies.get(CSRF_COOKIE)
        if not csrf_cookie or csrf_cookie != x_csrf_token:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "CSRF token missing or invalid")

    user = await db.get(User, uuid.UUID(payload["sub"]))
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account unavailable")
    allowed, retry = await rate_limit(f"user:{user.id}", settings.rate_limit_per_minute)
    if not allowed:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Rate limit exceeded", headers={"Retry-After": str(retry)})
    request.state.user_id = user.id
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def require_role(*roles: UserRole):
    async def checker(user: CurrentUser) -> User:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient role")
        return user

    return checker


def client_ip(request: Request) -> str | None:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None
