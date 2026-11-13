from __future__ import annotations

from tests.conftest import make_client


async def test_register_me_and_profile(client):
    r = await client.get("/api/auth/me")
    assert r.status_code == 200
    me = r.json()
    assert me["permission_mode"] == "prepare_approve"
    r = await client.patch("/api/auth/me/profile", json={"headline": "Engineer", "skills": ["Python", "SQL"],
                                                         "timezone": "Asia/Kolkata"})
    assert r.status_code == 200 and r.json()["profile"]["skills"] == ["Python", "SQL"]
    r = await client.patch("/api/auth/me/profile", json={"timezone": "Not/AZone"})
    assert r.status_code == 422


async def test_csrf_required_for_cookie_writes(client):
    r = await client.http.post("/api/conversations")  # no CSRF header
    assert r.status_code == 403
    r = await client.post("/api/conversations")
    assert r.status_code == 201


async def test_unauthenticated_rejected():
    import httpx

    from main import app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        assert (await c.get("/api/tasks")).status_code == 401
        assert (await c.get("/api/auth/me", headers={"Authorization": "Bearer nope"})).status_code == 401


async def test_login_lockout_and_logout_revokes_refresh():
    c = await make_client("lock@example.com")
    for _ in range(5):
        r = await c.post("/api/auth/login", json={"email": "lock@example.com", "password": "wrong-password"})
        assert r.status_code == 401
    r = await c.post("/api/auth/login", json={"email": "lock@example.com", "password": "correct-horse-battery"})
    assert r.status_code == 423
    c2 = await make_client("logout@example.com")
    refresh = c2.http.cookies.get("lexa_refresh")
    assert (await c2.post("/api/auth/refresh")).status_code == 200
    assert (await c2.post("/api/auth/logout")).status_code == 200
    c2.http.cookies.set("lexa_refresh", refresh, path="/api/auth")
    assert (await c2.post("/api/auth/refresh")).status_code == 401


async def test_duplicate_registration(client):
    me = (await client.get("/api/auth/me")).json()
    r = await client.post("/api/auth/register", json={"email": me["email"], "password": "another-password-1"})
    assert r.status_code == 409


async def test_strict_account_isolation():
    a, b = await make_client(), await make_client()
    conv = (await a.post("/api/conversations")).json()
    mem = (await a.post("/api/memory", json={"content": "User prefers dark roast coffee", "category":
                                             "preferences"})).json()
    contact = (await a.post("/api/contacts", json={"name": "Alice Recruiter", "email": "alice@corp.com"})).json()
    assert (await b.get(f"/api/conversations/{conv['id']}")).status_code == 404
    assert (await b.delete(f"/api/memory/{mem['id']}")).status_code == 404
    assert (await b.delete(f"/api/contacts/{contact['id']}")).status_code == 404
    assert (await b.get("/api/memory")).json()["items"] == []
    assert (await b.get("/api/memory", params={"q": "coffee"})).json()["items"] == []
    assert (await b.get("/api/contacts")).json() == []
