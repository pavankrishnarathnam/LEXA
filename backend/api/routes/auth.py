from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import jwt
from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import func, select

from api.deps import ACCESS_COOKIE, CSRF_COOKIE, DB, REFRESH_COOKIE, CurrentUser, client_ip
from api.schemas import LoginIn, PasswordChangeIn, ProfileIn, RegisterIn, SettingsIn
from core.audit import audit
from core.config import settings
from core.redis import rate_limit
from core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    new_csrf_token,
    verify_password,
)
from database.models import PermissionMode, User, UserProfile, UserRole

router = APIRouter(prefix="/api/auth", tags=["auth"])
MAX_FAILED = 5
LOCK_MINUTES = 15


def _set_session(response: Response, user: User) -> str:
    access = create_access_token(user.id, user.role.value)
    refresh = create_refresh_token(user.id, user.token_version)
    csrf = new_csrf_token()
    common = {"secure": settings.cookie_secure, "samesite": "lax", "domain": settings.cookie_domain}
    response.set_cookie(ACCESS_COOKIE, access, httponly=True, max_age=settings.jwt_access_ttl_minutes * 60,
                        path="/", **common)
    response.set_cookie(REFRESH_COOKIE, refresh, httponly=True, max_age=settings.jwt_refresh_ttl_days * 86400,
                        path="/api/auth", **common)
    response.set_cookie(CSRF_COOKIE, csrf, httponly=False, max_age=settings.jwt_refresh_ttl_days * 86400,
                        path="/", **common)
    return access


def user_out(user: User, profile: UserProfile | None = None) -> dict:
    return {
        "id": str(user.id), "email": user.email, "full_name": user.full_name, "role": user.role.value,
        "permission_mode": user.permission_mode.value, "settings": user.settings or {},
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "profile": None if profile is None else {
            "headline": profile.headline, "location": profile.location, "timezone": profile.timezone,
            "bio": profile.bio, "skills": profile.skills, "education": profile.education,
            "employment": profile.employment, "career_preferences": profile.career_preferences},
    }


async def _limit(request: Request, key: str, limit: int = 10) -> None:
    allowed, retry = await rate_limit(f"auth:{key}:{client_ip(request)}", limit, 300)
    if not allowed:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many attempts, try later",
                            headers={"Retry-After": str(retry)})


@router.post("/register", status_code=201)
async def register(body: RegisterIn, request: Request, response: Response, db: DB) -> dict:
    await _limit(request, "register", max(1, settings.auth_rate_limit // 2))
    count = await db.scalar(select(func.count(User.id)))
    if count and not settings.allow_registration:
        raise HTTPException(403, "Registration is disabled on this instance")
    email = body.email.lower()
    if await db.scalar(select(User).where(User.email == email)):
        raise HTTPException(409, "An account with this email already exists")
    user = User(email=email, password_hash=hash_password(body.password), full_name=body.full_name,
                role=UserRole.OWNER if not count else UserRole.MEMBER,
                permission_mode=PermissionMode.PREPARE_APPROVE, settings={"theme": "dark", "auto_memory": True})
    db.add(user)
    await db.flush()
    profile = UserProfile(user_id=user.id)
    db.add(profile)
    await audit(db, user_id=user.id, action="auth.register", category="auth", ip=client_ip(request))
    _set_session(response, user)
    return user_out(user, profile)


@router.post("/login")
async def login(body: LoginIn, request: Request, response: Response, db: DB) -> dict:
    await _limit(request, "login", settings.auth_rate_limit)
    user = await db.scalar(select(User).where(User.email == body.email.lower()))
    now = datetime.now(UTC)
    if user and user.locked_until and user.locked_until > now:
        raise HTTPException(423, "Account temporarily locked after repeated failed logins")
    if not user or not verify_password(body.password, user.password_hash) or not user.is_active:
        if user:
            user.failed_logins += 1
            if user.failed_logins >= MAX_FAILED:
                user.locked_until, user.failed_logins = now + timedelta(minutes=LOCK_MINUTES), 0
            await audit(db, user_id=user.id, action="auth.login", category="auth", success=False,
                        ip=client_ip(request), user_agent=request.headers.get("user-agent"))
            await db.commit()
        raise HTTPException(401, "Invalid email or password")
    user.failed_logins, user.locked_until, user.last_login_at = 0, None, now
    await audit(db, user_id=user.id, action="auth.login", category="auth", ip=client_ip(request),
                user_agent=request.headers.get("user-agent"))
    profile = await db.scalar(select(UserProfile).where(UserProfile.user_id == user.id))
    _set_session(response, user)
    return user_out(user, profile)


@router.post("/refresh")
async def refresh(request: Request, response: Response, db: DB) -> dict:
    token = request.cookies.get(REFRESH_COOKIE)
    if not token:
        raise HTTPException(401, "No refresh session")
    try:
        payload = decode_token(token, "refresh")
    except jwt.PyJWTError as exc:
        raise HTTPException(401, "Session expired") from exc
    user = await db.get(User, uuid.UUID(payload["sub"]))
    if not user or not user.is_active or payload.get("ver") != user.token_version:
        raise HTTPException(401, "Session revoked")
    _set_session(response, user)
    return {"ok": True}


@router.post("/logout")
async def logout(response: Response, request: Request, db: DB) -> dict:
    token = request.cookies.get(REFRESH_COOKIE)
    if token:
        try:
            payload = decode_token(token, "refresh")
            user = await db.get(User, uuid.UUID(payload["sub"]))
            if user:
                user.token_version += 1  # revoke all refresh tokens
                await audit(db, user_id=user.id, action="auth.logout", category="auth", ip=client_ip(request))
        except jwt.PyJWTError:
            pass
    for name, path in ((ACCESS_COOKIE, "/"), (REFRESH_COOKIE, "/api/auth"), (CSRF_COOKIE, "/")):
        response.delete_cookie(name, path=path, domain=settings.cookie_domain)
    return {"ok": True}


@router.get("/me")
async def me(user: CurrentUser, db: DB) -> dict:
    profile = await db.scalar(select(UserProfile).where(UserProfile.user_id == user.id))
    return user_out(user, profile)


@router.patch("/me/profile")
async def update_profile(body: ProfileIn, user: CurrentUser, db: DB) -> dict:
    profile = await db.scalar(select(UserProfile).where(UserProfile.user_id == user.id))
    if profile is None:
        profile = UserProfile(user_id=user.id)
        db.add(profile)
    data = body.model_dump(exclude_none=True)
    if "full_name" in data:
        user.full_name = data.pop("full_name")
    if "timezone" in data:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
        try:
            ZoneInfo(data["timezone"])
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise HTTPException(422, "Unknown timezone") from exc
    for k, v in data.items():
        setattr(profile, k, v)
    await audit(db, user_id=user.id, action="profile.update", category="account", details={"fields": list(data)})
    return user_out(user, profile)


@router.patch("/me/settings")
async def update_settings(body: SettingsIn, user: CurrentUser, db: DB) -> dict:
    data = body.model_dump(exclude_none=True)
    if "permission_mode" in data:
        user.permission_mode = PermissionMode(data.pop("permission_mode"))
        await audit(db, user_id=user.id, action="settings.permission_mode", category="security",
                    details={"mode": user.permission_mode.value})
    user.settings = {**(user.settings or {}), **data}
    profile = await db.scalar(select(UserProfile).where(UserProfile.user_id == user.id))
    return user_out(user, profile)


@router.post("/me/password")
async def change_password(body: PasswordChangeIn, user: CurrentUser, db: DB, response: Response) -> dict:
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(400, "Current password is incorrect")
    user.password_hash = hash_password(body.new_password)
    user.token_version += 1
    await audit(db, user_id=user.id, action="auth.password_change", category="security")
    _set_session(response, user)
    return {"ok": True}
