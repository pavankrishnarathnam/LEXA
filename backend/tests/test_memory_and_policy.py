from __future__ import annotations

import uuid

import pytest

from agents.policy import decide, effective_mode
from agents.tools import TOOLS, ToolContext
from database.models import PermissionMode
from database.session import SessionLocal
from memory.store import MemoryRejected, contains_secret, save_memory, search_memories


async def test_memory_crud_dedupe_and_secret_rejection(client):
    r = await client.post("/api/memory", json={"content": "User works as a backend engineer at Acme",
                                               "category": "employment"})
    assert r.status_code == 201 and r.json()["created"] is True
    r2 = await client.post("/api/memory", json={"content": "user works as a backend engineer at acme ",
                                                "category": "employment"})
    assert r2.json()["created"] is False and r2.json()["duplicate_of"] == r.json()["id"]
    bad = await client.post("/api/memory", json={"content": "My password is hunter22", "category": "general"})
    assert bad.status_code == 422
    found = (await client.get("/api/memory", params={"q": "backend engineer"})).json()["items"]
    assert found and "Acme" in found[0]["content"]
    mid = r.json()["id"]
    assert (await client.patch(f"/api/memory/{mid}", json={"content": "User works as a staff engineer at Acme",
                                                           "pinned": True})).status_code == 200
    assert (await client.delete(f"/api/memory/{mid}")).status_code == 204


def test_secret_detection():
    for s in ["sk-ant-api03-abcdefghijklmnopqrstuv", "my otp is 123456", "AKIAABCDEFGHIJKLMNOP",
              "4111 1111 1111 1111", "password: hunter2"]:
        assert contains_secret(s), s
    assert not contains_secret("User prefers remote jobs in Bangalore")


async def test_semantic_near_duplicate_and_search_isolation():
    from database.models import User
    async with SessionLocal() as db:
        u = User(email=f"m{uuid.uuid4().hex[:6]}@x.com", password_hash="x")
        db.add(u)
        await db.flush()
        a = await save_memory(db, u.id, "User prefers remote roles in fintech", category="preferences")
        b = await save_memory(db, u.id, "User prefers remote roles in fintech companies", category="preferences")
        assert a.created and not b.created
        with pytest.raises(MemoryRejected):
            await save_memory(db, u.id, "api_key = sk-proj-123456789012345678901234", category="general")
        hits = await search_memories(db, u.id, "fintech remote")
        assert hits and hits[0]["category"] == "preferences"
        await db.rollback()


async def _ctx():
    from database.models import User
    db = SessionLocal()
    u = User(email=f"p{uuid.uuid4().hex[:6]}@x.com", password_hash="x")
    db.add(u)
    await db.flush()
    return db, ToolContext(db=db, user_id=u.id, agent_slug="test")


async def test_permission_modes():
    db, ctx = await _ctx()
    try:
        send, draft, read = TOOLS["gmail_send"], TOOLS["gmail_create_draft"], TOOLS["gmail_search"]
        args = {"to": "bob@example.com", "subject": "Hi", "body": "Lunch tomorrow?"}
        r = await decide(ctx, read, {"query": "x"}, user_mode=PermissionMode.READ_ANALYZE, agent_mode=None,
                         autonomy_rules=[])
        assert r.decision == "allow"
        r = await decide(ctx, send, args, user_mode=PermissionMode.READ_ANALYZE, agent_mode=None, autonomy_rules=[])
        assert r.decision == "deny"
        r = await decide(ctx, send, args, user_mode=PermissionMode.PREPARE_APPROVE, agent_mode=None,
                         autonomy_rules=[])
        assert r.decision == "approve"
        rules = [{"tool": "gmail_create_draft"}, {"tool": "gmail_send", "recipient_patterns": ["*@example.com"]}]
        r = await decide(ctx, draft, args, user_mode=PermissionMode.RULE_AUTONOMY, agent_mode=None,
                         autonomy_rules=rules)
        assert r.decision == "allow"
        r = await decide(ctx, send, {**args, "to": "eve@other.com"}, user_mode=PermissionMode.RULE_AUTONOMY,
                         agent_mode=None, autonomy_rules=rules)
        assert r.decision == "approve"
        # Sensitive content always needs approval, even when a rule matches.
        r = await decide(ctx, send, {**args, "body": "Here is the confidential NDA"},
                         user_mode=PermissionMode.RULE_AUTONOMY, agent_mode=None, autonomy_rules=rules)
        assert r.decision == "approve" and r.risk_level == "high"
        # Agent mode can only restrict, never widen, the user's mode.
        assert effective_mode(PermissionMode.PREPARE_APPROVE, PermissionMode.RULE_AUTONOMY) == \
            PermissionMode.PREPARE_APPROVE
        assert effective_mode(PermissionMode.RULE_AUTONOMY, PermissionMode.READ_ANALYZE) == \
            PermissionMode.READ_ANALYZE
        r = await decide(ctx, TOOLS["application_submit_email"], {"application_id": "x", "to": "a@b.c",
                                                                  "subject": "s", "body": "b"},
                         user_mode=PermissionMode.RULE_AUTONOMY, agent_mode=None,
                         autonomy_rules=[{"tool": "*"}])
        assert r.decision == "approve"
    finally:
        await db.rollback()
        await db.close()


def test_finance_agent_cannot_pay():
    from agents.definitions import BUILTIN_BY_SLUG
    tools = BUILTIN_BY_SLUG["finance"].tools
    assert not any(k in t for t in tools for k in ("pay", "transfer", "invest"))
