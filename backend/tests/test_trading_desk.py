"""The trading desk (/api/trading): the same analyses as the Trader agent, started from buttons, with no AI model."""
from __future__ import annotations

import asyncio
import uuid
from typing import Any

import httpx
from sqlalchemy import func, select

from agents.tools import TOOLS
from agents.tools.base import Risk
from core.config import settings
from database.models import AuditLog
from database.session import SessionLocal
from tests.conftest import make_client
from tests.scripted_provider import STATE
from tests.test_trading import fake_vendor, offline, trader_env, wait_dead  # noqa: F401  (fixtures)
from trading import jobs, runner


async def finish(client, job_id: str, seconds: float = 30) -> dict[str, Any]:
    for _ in range(int(seconds / 0.05)):
        job = (await client.get(f"/api/trading/jobs/{job_id}")).json()
        if job["status"] != "running":
            return job
        await asyncio.sleep(0.05)
    raise AssertionError("the job did not finish")


async def start(client, tool: str, **args: Any) -> httpx.Response:
    return await client.post("/api/trading/jobs", json={"tool": tool, "args": args})


async def run_job(client, tool: str, **args: Any) -> dict[str, Any]:
    r = await start(client, tool, **args)
    assert r.status_code == 202, r.text
    return await finish(client, r.json()["id"])


async def my_id(client) -> str:
    return (await client.get("/api/auth/me")).json()["id"]


async def test_the_desk_needs_a_signed_in_user():
    from main import app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as anon:
        for method, url in [("GET", "/api/trading/status"), ("GET", "/api/trading/rules"),
                            ("GET", "/api/trading/jobs"), ("GET", "/api/trading/jobs/latest?tool=trader_scan")]:
            assert (await anon.request(method, url)).status_code == 401, url


async def test_status_shows_the_market_and_says_no_ai_is_needed(client, offline):  # noqa: F811
    body = (await client.get("/api/trading/status")).json()
    assert body["llm_required"] is False
    assert body["market"]["open"] is True and "NYSE OPEN" in body["market"]["text"]
    assert body["missing"] == ["budget", "max_loss_per_trade_usd"]
    assert {r["rule"] for r in body["rules"]} >= {"budget", "max_loss_per_trade_usd", "flat_by"}
    assert "trader_scan" in body["tools"] and "trader_set_rules" not in body["tools"]
    assert any("never places an order" in line for line in body["fixed"])
    assert body["sec_contact"] == {"value": None, "source": "server", "configured": True}
    assert isinstance(body["pdftotext"], bool)


async def test_a_trade_is_planned_from_the_desk_without_calling_any_model(client, offline):  # noqa: F811
    assert settings.openai_api_key == "" and settings.anthropic_api_key == ""  # no key exists in this process at all
    saved = await client.put("/api/trading/rules", json={"values": {"budget": 5000, "max_loss_per_trade_usd": 50}})
    assert saved.status_code == 200 and saved.json()["missing"] == []
    steps = [("trader_market_status", {}, "NYSE OPEN"),
             ("trader_quote", {"symbols": ["tsla", "aapl"]}, "TSLA   $366.48"),
             ("trader_scan", {"mode": "daily", "symbols": ["BAC", "XOM", "KO"]}, "20-day closing-high breakout"),
             ("trader_news", {"tickers": ["TSLA"], "hours": 24}, "MOVING"),
             ("trader_earnings", {"tickers": ["AAPL"]}, "Apple Inc. (AAPL)"),
             ("trader_congress_trades", {"members": ["pelosi"], "year": 2026}, "doc 20035143"),
             ("trader_entry", {"symbol": "tsla"}, "TRIGGERED 10:15 AM at $364.18"),
             ("trader_exit_plan", {}, "Wrote trader/plan.json"),
             ("trader_simulate", {"replays": 500}, "seed 19"),
             ("trader_size", {}, "Size: 8 shares of TSLA"),
             ("trader_risk_check", {}, "PASS"),
             ("trader_alerts", {"action": "add", "from_plan": True}, "tsla-plan-stop"),
             ("trader_alerts", {"action": "list"}, "tsla-plan-target"),
             ("trader_alerts", {"action": "check"}, "Nothing hit")]
    for tool, args, expected in steps:
        job = await run_job(client, tool, **args)
        assert job["status"] == "done" and not job["is_error"], (tool, job["content"])
        assert expected in job["content"], (tool, job["content"])
        assert job["seconds"] is not None and job["finished_at"] >= job["started_at"]
    assert STATE["calls"] == []  # the scripted model was never asked anything


async def test_sizing_and_the_risk_check_refuse_until_the_user_sets_their_own_numbers(client, offline):  # noqa: F811
    for tool in ("trader_size", "trader_risk_check"):
        job = await run_job(client, tool)
        assert job["status"] == "error" and job["is_error"]
        assert "budget" in job["content"] and "max_loss_per_trade_usd" in job["content"]


async def test_rules_are_validated_saved_directly_and_audited(client, trader_env):  # noqa: F811
    for bad in ({"budget": -1}, {"allow_margin": True}, {"paper": False}, {"budget": 1000, "max_loss_per_trade_usd": 5000},
                {"no_entries_after": "17:00"}, {"blocked": ["TSLA; rm -rf /"]}):
        r = await client.put("/api/trading/rules", json={"values": bad})
        assert r.status_code == 422, bad
    assert (await client.get("/api/trading/rules")).json()["missing"] == ["budget", "max_loss_per_trade_usd"]

    ok = await client.put("/api/trading/rules", json={"values": {"budget": "5000", "max_loss_per_trade_usd": 40,
                                                                  "blocked": "tsla, gme"}})
    assert ok.status_code == 200
    rows = {r["rule"]: r for r in ok.json()["rules"]}
    assert rows["budget"]["value"] == 5000 and rows["budget"]["source"] == "set by you"
    assert rows["blocked"]["value"] == ["TSLA", "GME"] and rows["max_daily_loss_usd"]["source"] == "default"
    assert ok.json()["missing"] == [] and any("Paper trading" in f for f in ok.json()["fixed"])

    back = await client.put("/api/trading/rules", json={"values": {}, "reset": ["blocked"]})
    assert {r["rule"]: r for r in back.json()["rules"]}["blocked"]["source"] == "default"
    assert (await client.put("/api/trading/rules", json={"reset": ["nonsense"]})).status_code == 422

    async with SessionLocal() as db:
        count = await db.scalar(select(func.count(AuditLog.id)).where(
            AuditLog.user_id == uuid.UUID(await my_id(client)), AuditLog.action == "trading.rules.update"))
    assert count == 2  # the two changes that were saved; refused ones leave nothing behind


async def test_the_users_own_sec_contact_unlocks_filings_and_earnings(client, offline, monkeypatch):  # noqa: F811
    monkeypatch.setattr(settings, "trader_sec_user_agent", "")  # the server has no contact of its own
    assert (await client.get("/api/trading/status")).json()["sec_contact"] == {"value": None, "source": None,
                                                                               "configured": False}
    skipped = await run_job(client, "trader_news", tickers=["AAPL"], hours=400)
    assert skipped["content"].startswith("(SEC filings were skipped")
    refused = await run_job(client, "trader_earnings", tickers=["AAPL"])
    assert refused["status"] == "error" and "SEC contact" in refused["content"]

    for bad in ("Your Name you@example.com", "no at sign", "x@y.z", "Jane Doe jane@example.org\r\nX-Evil: 1", "",
                "Jane " + "Doe" * 80 + " jane@example.org"):
        r = await client.put("/api/trading/sec-contact", json={"value": bad})
        if bad:
            assert r.status_code == 422, bad

    ok = await client.put("/api/trading/sec-contact", json={"value": "  Jane   Doe  jane@example.org "})
    assert ok.status_code == 200
    assert ok.json() == {"value": "Jane Doe jane@example.org", "source": "you", "configured": True}
    with_sec = await run_job(client, "trader_news", tickers=["AAPL"], hours=400)
    assert not with_sec["content"].startswith("(SEC filings were skipped")
    earnings = await run_job(client, "trader_earnings", tickers=["AAPL"])
    assert earnings["status"] == "done" and "Apple Inc. (AAPL)" in earnings["content"]

    other = await make_client()  # someone else's contact is not shared
    assert (await other.get("/api/trading/status")).json()["sec_contact"]["configured"] is False

    cleared = await client.put("/api/trading/sec-contact", json={"value": None})
    assert cleared.json() == {"value": None, "source": None, "configured": False}


async def test_results_belong_to_the_user_who_ran_them(client, offline):  # noqa: F811
    job = await run_job(client, "trader_quote", symbols=["TSLA"])
    other = await make_client()
    assert (await other.get(f"/api/trading/jobs/{job['id']}")).status_code == 404
    assert (await other.get("/api/trading/jobs/latest?tool=trader_quote")).status_code == 404
    assert (await other.delete(f"/api/trading/jobs/{job['id']}")).status_code == 404
    assert (await other.get("/api/trading/jobs")).json() == []
    assert (await client.get(f"/api/trading/jobs/{job['id']}")).json()["id"] == job["id"]
    assert (await client.get("/api/trading/jobs/" + "x" * 200)).status_code == 404


async def test_only_read_only_analyses_can_be_started_from_the_desk(client, offline):  # noqa: F811
    for name in ("trader_set_rules", "trader_get_rules", "gmail_send", "nope", "../etc/passwd"):
        assert (await start(client, name)).status_code == 404, name
    assert (await start(client, "trader_quote")).status_code == 422                       # a required argument is missing
    assert (await start(client, "trader_quote", symbols=["TSLA"], path="/etc/passwd")).status_code == 422
    assert (await start(client, "trader_scan", mode="weekly")).status_code == 422
    allowed = jobs.allowed_tools()
    assert len(allowed) == 12 and "trader_set_rules" not in allowed
    assert all(TOOLS[n].risk in (Risk.READ, Risk.INTERNAL) for n in allowed)  # nothing external, nothing sensitive


async def test_hostile_input_ends_as_a_clear_error_never_a_command(client, offline):  # noqa: F811
    for tool, args in [("trader_quote", {"symbols": ["$(id)"]}), ("trader_quote", {"symbols": ["../../etc/passwd"]}),
                       ("trader_scan", {"mode": "orb", "at": "10:15 --config /etc/passwd"}),
                       ("trader_exit_plan", {"stop": "price:1 --out /tmp/x"}),
                       ("trader_news", {"tickers": ["TSLA", "--user-agent"]})]:
        job = await run_job(client, tool, **args)
        assert job["status"] == "error" and job["is_error"], (tool, args)
        assert "not " in job["content"] or "unexpected" in job["content"] or "accepted" in job["content"], job["content"]


async def test_the_latest_result_is_still_there_after_a_page_reload(client, offline):  # noqa: F811
    first = await run_job(client, "trader_quote", symbols=["TSLA"])
    second = await run_job(client, "trader_quote", symbols=["AAPL"])
    latest = (await client.get("/api/trading/jobs/latest?tool=trader_quote")).json()
    assert latest["id"] == second["id"] and "AAPL" in latest["content"] and latest["args"] == {"symbols": ["AAPL"]}
    listing = (await client.get("/api/trading/jobs")).json()
    assert [j["id"] for j in listing][:2] == [second["id"], first["id"]]
    assert set(listing[0]) == {"id", "tool", "status", "is_error", "started_at", "finished_at"}  # no content in lists
    assert (await client.get("/api/trading/jobs/latest?tool=trader_scan")).status_code == 404


async def test_at_most_three_analyses_run_at_once_per_user(client, fake_vendor):  # noqa: F811
    fake_vendor("alerts.py", "import time\ntime.sleep(0.8)\nprint('open')\n")
    started = [await start(client, "trader_market_status") for _ in range(3)]
    assert [r.status_code for r in started] == [202, 202, 202]
    fourth = await start(client, "trader_market_status")
    assert fourth.status_code == 429 and "already running" in fourth.json()["detail"]
    other = await make_client()  # the limit is per user
    assert (await start(other, "trader_market_status")).status_code == 202
    for r in started:
        assert (await finish(client, r.json()["id"]))["status"] == "done"
    assert (await start(client, "trader_market_status")).status_code == 202  # room again once they are done
    for _ in range(100):
        if not any(j["status"] == "running" for j in await jobs.list_jobs(uuid.UUID(await my_id(client)))):
            break
        await asyncio.sleep(0.1)


async def test_stop_kills_the_running_script(client, fake_vendor):  # noqa: F811
    fake_vendor("alerts.py", """
        import os, time
        open("trader/self.pid", "w").write(str(os.getpid()))
        time.sleep(60)
    """)
    job = (await start(client, "trader_market_status")).json()
    pid_file = runner.workspace(uuid.UUID(await my_id(client))) / "trader" / "self.pid"
    for _ in range(100):
        if pid_file.exists() and pid_file.read_text():
            break
        await asyncio.sleep(0.05)
    assert (await client.delete(f"/api/trading/jobs/{job['id']}")).status_code == 204
    done = await finish(client, job["id"], seconds=15)
    assert done["status"] == "cancelled" and done["content"] == "Stopped." and not done["is_error"]
    assert await wait_dead(int(pid_file.read_text()))


async def test_a_slow_analysis_stops_at_its_tools_time_limit(client, fake_vendor, monkeypatch):  # noqa: F811
    monkeypatch.setattr(TOOLS["trader_market_status"], "timeout", 1)
    fake_vendor("alerts.py", """
        import os, time
        open("trader/self.pid", "w").write(str(os.getpid()))
        time.sleep(60)
    """)
    job = await run_job(client, "trader_market_status")
    assert job["status"] == "error" and job["content"].startswith("Stopped after 1 seconds")
    pid_file = runner.workspace(uuid.UUID(await my_id(client))) / "trader" / "self.pid"
    assert await wait_dead(int(pid_file.read_text()))


async def test_a_job_whose_server_died_is_reported_as_interrupted(client, trader_env):  # noqa: F811
    user = uuid.UUID(await my_id(client))
    rec = {"id": uuid.uuid4().hex, "user_id": str(user), "tool": "trader_scan", "args": {}, "status": "running",
           "content": "", "is_error": False, "untrusted": False, "data": {}, "started_at": 1.0, "finished_at": None,
           "seconds": None}
    await jobs._save(rec)
    job = (await client.get(f"/api/trading/jobs/{rec['id']}")).json()
    assert job["status"] == "error" and "interrupted" in job["content"] and job["is_error"]


async def test_a_crash_inside_a_tool_is_contained(client, trader_env, monkeypatch):  # noqa: F811
    async def broken(ctx, a):
        raise RuntimeError("boom with a secret path /home/x")

    monkeypatch.setattr(TOOLS["trader_market_status"], "handler", broken)
    job = await run_job(client, "trader_market_status")
    assert job["status"] == "error" and "RuntimeError" in job["content"] and "/home/x" not in job["content"]
