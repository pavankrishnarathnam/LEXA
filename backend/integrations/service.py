"""Credential storage, OAuth flows, token refresh and access logging for integrations."""
from __future__ import annotations

import json
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit import audit
from core.config import settings
from core.security import decrypt_secret, encrypt_secret
from database.models import Integration
from integrations.base import GOOGLE_AUTH, GOOGLE_REVOKE, GOOGLE_TOKEN, PROVIDERS, ProviderSpec


class IntegrationError(Exception):
    pass


class IntegrationNotConnected(IntegrationError):
    def __init__(self, provider: str):
        spec = PROVIDERS.get(provider)
        super().__init__(f"{spec.name if spec else provider} is not connected. Connect it in Integrations.")
        self.provider = provider


def redirect_uri(provider: str) -> str:
    return f"{settings.api_url.rstrip('/')}/api/integrations/{provider}/callback"


def oauth_configured(spec: ProviderSpec) -> bool:
    if spec.oauth_family == "google":
        return bool(settings.google_client_id and settings.google_client_secret)
    if spec.oauth_family == "github":
        return bool(settings.github_client_id and settings.github_client_secret)
    return False


def build_authorize_url(spec: ProviderSpec, user_id: uuid.UUID) -> str:
    if not oauth_configured(spec):
        raise IntegrationError(f"OAuth client for {spec.name} is not configured on the server "
                               f"({'GOOGLE' if spec.oauth_family == 'google' else 'GITHUB'}_CLIENT_ID/SECRET).")
    state = jwt.encode({"sub": str(user_id), "p": spec.key, "n": secrets.token_hex(8),
                        "exp": int((datetime.now(UTC) + timedelta(minutes=10)).timestamp())},
                       settings.jwt_secret, algorithm="HS256")
    if spec.oauth_family == "google":
        q = {"client_id": settings.google_client_id, "redirect_uri": redirect_uri(spec.key), "response_type": "code",
             "scope": " ".join(("openid", "email", *spec.scopes)), "access_type": "offline", "prompt": "consent",
             "include_granted_scopes": "true", "state": state}
        return f"{GOOGLE_AUTH}?{urlencode(q)}"
    q = {"client_id": settings.github_client_id, "redirect_uri": redirect_uri(spec.key),
         "scope": " ".join(spec.scopes), "state": state, "allow_signup": "false"}
    return f"https://github.com/login/oauth/authorize?{urlencode(q)}"


def verify_state(state: str, provider: str) -> uuid.UUID:
    payload = jwt.decode(state, settings.jwt_secret, algorithms=["HS256"])
    if payload.get("p") != provider:
        raise IntegrationError("OAuth state mismatch")
    return uuid.UUID(payload["sub"])


async def exchange_code(spec: ProviderSpec, code: str) -> tuple[dict[str, Any], datetime | None, str | None]:
    async with httpx.AsyncClient(timeout=20) as client:
        if spec.oauth_family == "google":
            r = await client.post(GOOGLE_TOKEN, data={
                "code": code, "client_id": settings.google_client_id, "client_secret": settings.google_client_secret,
                "redirect_uri": redirect_uri(spec.key), "grant_type": "authorization_code"})
            r.raise_for_status()
            tok = r.json()
            exp = datetime.now(UTC) + timedelta(seconds=int(tok.get("expires_in", 3600)))
            label = None
            info = await client.get("https://openidconnect.googleapis.com/v1/userinfo",
                                    headers={"Authorization": f"Bearer {tok['access_token']}"})
            if info.is_success:
                label = info.json().get("email")
            return tok, exp, label
        r = await client.post("https://github.com/login/oauth/access_token", headers={"Accept": "application/json"},
                              data={"code": code, "client_id": settings.github_client_id,
                                    "client_secret": settings.github_client_secret,
                                    "redirect_uri": redirect_uri(spec.key)})
        r.raise_for_status()
        tok = r.json()
        if "access_token" not in tok:
            raise IntegrationError(tok.get("error_description", "GitHub OAuth failed"))
        me = await client.get("https://api.github.com/user", headers={"Authorization": f"Bearer {tok['access_token']}"})
        return {"token": tok["access_token"], "scope": tok.get("scope", "")}, None, (
            me.json().get("login") if me.is_success else None)


async def get_integration(db: AsyncSession, user_id: uuid.UUID, provider: str) -> Integration | None:
    return await db.scalar(select(Integration).where(Integration.user_id == user_id, Integration.provider == provider))


async def save_connection(db: AsyncSession, user_id: uuid.UUID, provider: str, creds: dict[str, Any], *,
                          scopes: list[str] | None = None, expires_at: datetime | None = None,
                          label: str | None = None, config: dict[str, Any] | None = None) -> Integration:
    integ = await get_integration(db, user_id, provider)
    if integ is None:
        integ = Integration(user_id=user_id, provider=provider)
        db.add(integ)
    integ.encrypted_credentials = encrypt_secret(json.dumps(creds))
    integ.status = "connected"
    integ.scopes = scopes or list(PROVIDERS[provider].scopes)
    integ.token_expires_at = expires_at
    integ.account_label = label
    integ.config = config or {}
    integ.last_error = None
    integ.connected_at = datetime.now(UTC)
    await db.flush()
    await audit(db, user_id=user_id, action="integration.connected", category="integration",
                target_type="integration", target_id=provider, details={"scopes": integ.scopes})
    return integ


async def disconnect(db: AsyncSession, user_id: uuid.UUID, provider: str) -> bool:
    integ = await get_integration(db, user_id, provider)
    if not integ:
        return False
    spec = PROVIDERS[provider]
    revoked = False
    if spec.supports_disconnect_revoke and integ.encrypted_credentials:
        creds = json.loads(decrypt_secret(integ.encrypted_credentials))
        token = creds.get("refresh_token") or creds.get("access_token")
        if token:
            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    r = await client.post(GOOGLE_REVOKE, data={"token": token})
                    revoked = r.is_success
            except httpx.HTTPError:
                revoked = False
    integ.encrypted_credentials = None
    integ.status = "disconnected"
    integ.token_expires_at = None
    await audit(db, user_id=user_id, action="integration.disconnected", category="integration",
                target_type="integration", target_id=provider, details={"remote_revoked": revoked})
    return True


async def _refresh_google(integ: Integration, creds: dict[str, Any]) -> dict[str, Any]:
    if not creds.get("refresh_token"):
        raise IntegrationError("Google token expired and no refresh token stored; reconnect the integration.")
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(GOOGLE_TOKEN, data={
            "client_id": settings.google_client_id, "client_secret": settings.google_client_secret,
            "refresh_token": creds["refresh_token"], "grant_type": "refresh_token"})
    if not r.is_success:
        raise IntegrationError(f"Google token refresh failed ({r.status_code}); reconnect the integration.")
    tok = r.json()
    creds["access_token"] = tok["access_token"]
    integ.token_expires_at = datetime.now(UTC) + timedelta(seconds=int(tok.get("expires_in", 3600)))
    integ.encrypted_credentials = encrypt_secret(json.dumps(creds))
    return creds


async def get_credentials(db: AsyncSession, user_id: uuid.UUID, provider: str, *, actor: str = "agent") -> dict[str, Any]:
    """Returns decrypted credentials, refreshing OAuth tokens when needed, and logs the access."""
    integ = await get_integration(db, user_id, provider)
    if not integ or integ.status != "connected" or not integ.encrypted_credentials:
        raise IntegrationNotConnected(provider)
    creds = json.loads(decrypt_secret(integ.encrypted_credentials))
    spec = PROVIDERS[provider]
    if spec.oauth_family == "google" and integ.token_expires_at and \
            integ.token_expires_at - datetime.now(UTC) < timedelta(minutes=2):
        try:
            creds = await _refresh_google(integ, creds)
        except IntegrationError as exc:
            integ.status = "error"
            integ.last_error = str(exc)
            raise
    integ.last_used_at = datetime.now(UTC)
    await audit(db, user_id=user_id, actor=actor, action="integration.access", category="integration",
                target_type="integration", target_id=provider)
    return creds


async def mark_error(db: AsyncSession, user_id: uuid.UUID, provider: str, error: str) -> None:
    integ = await get_integration(db, user_id, provider)
    if integ:
        integ.last_error = error[:1000]
