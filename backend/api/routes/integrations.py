from __future__ import annotations

import jwt
from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy import select

from api.deps import DB, CurrentUser
from api.schemas import IntegrationConnectIn
from api.serializers import iso
from core.audit import audit
from core.config import settings
from core.llm import anthropic_provider, openai_provider
from database.models import AuditLog, Integration
from integrations.base import PROVIDERS
from integrations.providers import automation, messaging
from integrations.providers.github import GitHubClient
from integrations.service import (
    IntegrationError,
    build_authorize_url,
    disconnect,
    exchange_code,
    oauth_configured,
    save_connection,
    verify_state,
)

router = APIRouter(prefix="/api/integrations", tags=["integrations"])


def _out(spec, integ: Integration | None) -> dict:
    if spec.auth_type == "config":
        configured = bool(settings.anthropic_api_key if spec.key == "anthropic" else settings.openai_api_key)
        status = "connected" if configured else "not_configured"
    else:
        status = integ.status if integ else "disconnected"
    return {"key": spec.key, "name": spec.name, "description": spec.description, "category": spec.category,
            "auth_type": spec.auth_type, "scopes": list(spec.scopes), "scope_descriptions": list(spec.scope_descriptions),
            "fields": [f.__dict__ for f in spec.fields], "docs_url": spec.docs_url, "status": status,
            "oauth_available": oauth_configured(spec) if spec.auth_type == "oauth2" else None,
            "account_label": integ.account_label if integ else None,
            "granted_scopes": integ.scopes if integ else [], "last_error": integ.last_error if integ else None,
            "connected_at": iso(integ.connected_at) if integ else None,
            "last_used_at": iso(integ.last_used_at) if integ else None,
            "token_expires_at": iso(integ.token_expires_at) if integ else None}


@router.get("")
async def list_integrations(user: CurrentUser, db: DB) -> list[dict]:
    rows = {i.provider: i for i in (await db.execute(select(Integration).where(Integration.user_id == user.id))).scalars()}
    return [_out(spec, rows.get(key)) for key, spec in PROVIDERS.items()]


@router.post("/{provider}/check")
async def check_provider(provider: str, user: CurrentUser) -> dict:
    if provider == "anthropic":
        ok, msg = await anthropic_provider.check_available()
    elif provider == "openai":
        ok, msg = await openai_provider.check_available()
    else:
        raise HTTPException(404, "Only AI providers support live checks")
    return {"ok": ok, "message": msg}


@router.post("/{provider}/connect")
async def connect(provider: str, body: IntegrationConnectIn, user: CurrentUser, db: DB) -> dict:
    spec = PROVIDERS.get(provider)
    if not spec or spec.auth_type == "config":
        raise HTTPException(404, "Unknown or server-configured provider")
    creds = {k: v.strip() for k, v in body.credentials.items() if isinstance(v, str) and v.strip()}
    if spec.auth_type == "oauth2" and not creds:
        try:
            return {"authorize_url": build_authorize_url(spec, user.id)}
        except IntegrationError as exc:
            raise HTTPException(503, str(exc)) from exc
    allowed = {f.name for f in spec.fields}
    missing = [f.label for f in spec.fields if f.required and f.name not in creds]
    if missing or set(creds) - allowed:
        raise HTTPException(422, f"Missing fields: {', '.join(missing)}" if missing else "Unexpected fields")
    try:  # verify credentials against the real API before saving
        label = None
        config = {}
        if provider == "github":
            me = await GitHubClient(creds["token"]).me()
            label = me.get("login")
        elif provider == "whatsapp":
            label = await messaging.whatsapp_verify(creds)
        elif provider == "twilio":
            label = await messaging.twilio_verify(creds)
        elif provider == "exotel":
            label = await messaging.exotel_verify(creds)
        elif provider == "n8n":
            label = await automation.n8n_verify(creds)
        elif provider == "mcp":
            tools = await automation.MCPClient(creds["url"], creds.get("bearer_token")).list_tools()
            label = f"{creds['url']} ({len(tools)} tools)"
            config = {"read_only": creds.get("read_only", "").lower() == "true",
                      "tools": [t.get("name") for t in tools][:100]}
    except Exception as exc:  # noqa: BLE001
        await audit(db, user_id=user.id, action="integration.connect_failed", category="integration",
                    target_id=provider, success=False, details={"error": str(exc)[:300]})
        raise HTTPException(400, f"Could not verify credentials: {str(exc)[:300]}") from exc
    integ = await save_connection(db, user.id, provider, creds, label=label, config=config)
    return _out(spec, integ)


@router.get("/{provider}/callback")
async def oauth_callback(provider: str, db: DB, code: str | None = None, state: str | None = None,
                         error: str | None = None) -> RedirectResponse:
    spec = PROVIDERS.get(provider)
    target = f"{settings.public_url.rstrip('/')}/integrations"
    if not spec or spec.auth_type != "oauth2":
        return RedirectResponse(f"{target}?error=unknown_provider")
    if error or not code or not state:
        return RedirectResponse(f"{target}?error={error or 'missing_code'}&provider={provider}")
    try:
        user_id = verify_state(state, provider)
        tokens, expires, label = await exchange_code(spec, code)
    except (jwt.PyJWTError, IntegrationError, Exception) as exc:  # noqa: BLE001
        await audit(db, user_id=None, action="integration.oauth_failed", category="integration", success=False,
                    target_id=provider, details={"error": str(exc)[:300]})
        return RedirectResponse(f"{target}?error=oauth_failed&provider={provider}")
    granted = tokens.get("scope", "").replace(",", " ").split() or list(spec.scopes)
    await save_connection(db, user_id, provider, tokens, scopes=granted, expires_at=expires, label=label)
    return RedirectResponse(f"{target}?connected={provider}")


@router.delete("/{provider}")
async def disconnect_integration(provider: str, user: CurrentUser, db: DB) -> dict:
    if provider not in PROVIDERS:
        raise HTTPException(404, "Unknown provider")
    if not await disconnect(db, user.id, provider):
        raise HTTPException(404, "Not connected")
    return {"ok": True}


@router.get("/{provider}/logs")
async def access_logs(provider: str, user: CurrentUser, db: DB) -> list[dict]:
    rows = (await db.execute(select(AuditLog).where(AuditLog.user_id == user.id, AuditLog.category == "integration",
                                                    AuditLog.target_id == provider)
                             .order_by(AuditLog.created_at.desc()).limit(100))).scalars()
    return [{"at": iso(r.created_at), "actor": r.actor, "action": r.action, "success": r.success,
             "details": r.details} for r in rows]
