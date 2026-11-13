from __future__ import annotations

from typing import Any

from sqlalchemy import select

from agents.tools.base import Risk, S, ToolContext, ToolResult, string, tool
from database.models import Approval, Task, UsageRecord
from database.session import SessionLocal
from tests.conftest import drain_jobs
from tests.scripted_provider import STATE, plan_json, resp

EXECUTED: list[dict[str, Any]] = []


@tool("test_external_ping", "Test-only external action.", S(target=string("target")) | {"required": ["target"]},
      risk=Risk.EXTERNAL, category="test", summarize=lambda a: f"Ping {a.get('target')}")
async def _ping(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    EXECUTED.append(a)
    return ToolResult(f"pinged {a['target']}")


def last_user(messages: list[dict[str, Any]]) -> str:
    return next((m["content"] for m in reversed(messages) if m["role"] == "user" and isinstance(m["content"], str)),
                "")


def make_script(plan: str, agent_behaviour=None, synth: str = "All done."):
    def script(system: str, messages: list[dict[str, Any]], tools: list[str]):
        if "planning module" in system:
            return resp(plan)
        if "Write LEXA's final reply" in system:
            return resp(synth)
        if agent_behaviour:
            return agent_behaviour(system, messages, tools)
        return resp("agent output")
    return script


async def send(client, text: str) -> tuple[str, str]:
    conv = (await client.post("/api/conversations")).json()
    r = await client.post(f"/api/conversations/{conv['id']}/messages", json={"content": text})
    assert r.status_code == 202, r.text
    return conv["id"], r.json()["task_id"]


async def test_direct_answer_flow(client):
    STATE["script"] = make_script(plan_json(direct="Hello! I'm LEXA.", title="Greeting"))
    conv_id, task_id = await send(client, "hi there")
    await drain_jobs()
    t = (await client.get(f"/api/tasks/{task_id}")).json()
    assert t["status"] == "COMPLETED" and t["output"] == "Hello! I'm LEXA." and t["title"] == "Greeting"
    msgs = (await client.get(f"/api/conversations/{conv_id}")).json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    async with SessionLocal() as db:
        rec = (await db.execute(select(UsageRecord).where(UsageRecord.task_id == t["id"]))).scalars().all()
    assert rec and all(r.model == "test-model" for r in rec)


async def test_parallel_delegation_and_dependencies(client):
    steps = [{"id": "s1", "agent": "research", "instruction": "research A", "depends_on": []},
             {"id": "s2", "agent": "finance", "instruction": "budget B", "depends_on": []},
             {"id": "s3", "agent": "knowledge", "instruction": "combine", "depends_on": ["s1", "s2"]}]
    seen_context: list[str] = []

    def agent(system, messages, tools):
        if "Results from other agents" in system:
            seen_context.append(system)
        return resp(f"output for: {last_user(messages)}")

    STATE["script"] = make_script(plan_json(steps), agent, synth="Combined summary")
    _, task_id = await send(client, "research and budget then combine")
    await drain_jobs()
    t = (await client.get(f"/api/tasks/{task_id}")).json()
    assert t["status"] == "COMPLETED", t
    assert [e["step_id"] for e in t["executions"]][-1] == "s3"
    assert {e["agent"] for e in t["executions"]} == {"research", "finance", "knowledge"}
    assert seen_context and "output for: research A" in seen_context[0] and "budget B" in seen_context[0]
    assert t["output"].strip() == "Combined summary"
    assert sorted(t["assigned_agents"]) == ["finance", "knowledge", "research"]


async def _custom_ping_agent(client, slug="pinger"):
    r = await client.post("/api/agents", json={"slug": slug, "name": "Pinger", "system_prompt": "You ping things.",
                                               "tools": ["test_external_ping"], "role": "Pings"})
    assert r.status_code == 201, r.text


def ping_agent(system, messages, tools):
    if any(m["role"] == "tool" for m in messages):
        result = [m for m in messages if m["role"] == "tool"][-1]["content"][0][1]
        return resp(f"Result: {result}")
    return resp("", [("test_external_ping", {"target": "server-1"})])


async def test_approval_flow_executes_exact_action_once(client):
    EXECUTED.clear()
    await _custom_ping_agent(client)
    STATE["script"] = make_script(plan_json([{"id": "s1", "agent": "pinger", "instruction": "ping server-1"}]),
                                  ping_agent, synth="Ping is waiting for your approval.")
    _, task_id = await send(client, "ping server-1")
    await drain_jobs()
    t = (await client.get(f"/api/tasks/{task_id}")).json()
    assert t["status"] == "WAITING_FOR_APPROVAL", t
    assert EXECUTED == []  # nothing executed before approval
    appr = t["approvals"][0]
    assert appr["status"] == "pending" and appr["arguments"] == {"target": "server-1"}
    tool_result = t["executions"][0]["tool_calls"][0]
    assert tool_result["outcome"].startswith("queued_for_approval")
    r = await client.post(f"/api/approvals/{appr['id']}/decision", json={"approve": True})
    assert r.status_code == 200
    # Second decision is rejected (no double execution)
    assert (await client.post(f"/api/approvals/{appr['id']}/decision", json={"approve": True})).status_code == 409
    await drain_jobs()
    assert EXECUTED == [{"target": "server-1"}]
    t = (await client.get(f"/api/tasks/{task_id}")).json()
    assert t["status"] == "COMPLETED"
    assert t["approvals"][0]["status"] == "executed"
    assert "Approval outcomes" in t["output"] and "pinged server-1" in t["output"]

    # Same action requested again is detected as a duplicate, not re-queued.
    _, task2 = await send(client, "ping server-1 again")
    await drain_jobs()
    t2 = (await client.get(f"/api/tasks/{task2}")).json()
    assert t2["approvals"] == [] and t2["executions"][0]["tool_calls"][0]["outcome"].startswith("duplicate_of")


async def test_rejection_and_read_only_mode(client):
    EXECUTED.clear()
    await _custom_ping_agent(client, "pinger2")
    STATE["script"] = make_script(plan_json([{"id": "s1", "agent": "pinger2", "instruction": "ping"}]),
                                  lambda s, m, t: ping_agent(s, m, t) if True else None)
    _, task_id = await send(client, "ping please")
    await drain_jobs()
    appr = (await client.get(f"/api/tasks/{task_id}")).json()["approvals"][0]
    await client.post(f"/api/approvals/{appr['id']}/decision", json={"approve": False, "note": "no"})
    await drain_jobs()
    t = (await client.get(f"/api/tasks/{task_id}")).json()
    assert t["status"] == "COMPLETED" and "Rejected" in t["output"] and EXECUTED == []

    await client.patch("/api/auth/me/settings", json={"permission_mode": "read_analyze"})

    def agent(system, messages, tools):
        if any(m["role"] == "tool" for m in messages):
            return resp("Could not ping: " + [m for m in messages if m["role"] == "tool"][-1]["content"][0][1])
        return resp("", [("test_external_ping", {"target": "server-9"})])
    STATE["script"] = make_script(plan_json([{"id": "s1", "agent": "pinger2", "instruction": "ping 9"}]), agent)
    _, task_id = await send(client, "ping server-9")
    await drain_jobs()
    t = (await client.get(f"/api/tasks/{task_id}")).json()
    assert t["approvals"] == [] and EXECUTED == []
    assert t["executions"][0]["tool_calls"][0]["outcome"] == "denied"


async def test_tools_not_assigned_are_refused(client):
    STATE["script"] = make_script(
        plan_json([{"id": "s1", "agent": "finance", "instruction": "send an email"}]),
        lambda s, m, t: resp("refused") if any(x["role"] == "tool" for x in m)
        else resp("", [("gmail_send", {"to": "a@b.com", "subject": "x", "body": "y"})]))
    _, task_id = await send(client, "finance agent send email")
    await drain_jobs()
    t = (await client.get(f"/api/tasks/{task_id}")).json()
    assert t["executions"][0]["tool_calls"][0]["outcome"] == "denied:not_assigned"
    assert t["approvals"] == []


async def test_provider_fallback(client):
    STATE["fail_models"] = {"test-model"}
    STATE["script"] = make_script(plan_json(direct="Answer from fallback"))
    _, task_id = await send(client, "question")
    await drain_jobs()
    t = (await client.get(f"/api/tasks/{task_id}")).json()
    assert t["status"] == "COMPLETED" and t["output"] == "Answer from fallback"
    async with SessionLocal() as db:
        recs = (await db.execute(select(UsageRecord).where(UsageRecord.task_id == t["id"]))).scalars().all()
    assert any(not r.success and r.model == "test-model" for r in recs)
    assert any(r.success and r.fallback_used and r.model == "test-fallback" for r in recs)


async def test_all_providers_down_fails_task_transparently(client):
    STATE["fail_models"] = {"test-model", "test-fallback"}
    STATE["script"] = make_script(plan_json(direct="never"))
    conv_id, task_id = await send(client, "question")
    await drain_jobs()
    t = (await client.get(f"/api/tasks/{task_id}")).json()
    assert t["status"] == "FAILED" and "unavailable" in (t["error"] or "")
    msgs = (await client.get(f"/api/conversations/{conv_id}")).json()["messages"]
    assert "couldn't complete" in msgs[-1]["content"]
    r = await client.post(f"/api/tasks/{task_id}/retry")
    assert r.status_code == 202


async def test_cancel_pending_task(client):
    STATE["script"] = make_script(plan_json(direct="x"))
    _, task_id = await send(client, "cancel me")
    r = await client.post(f"/api/tasks/{task_id}/cancel")
    assert r.status_code == 200 and r.json()["status"] == "CANCELLED"
    await drain_jobs()
    t = (await client.get(f"/api/tasks/{task_id}")).json()
    assert t["status"] == "CANCELLED" and t["executions"] == []


async def test_checkpoint_resume_skips_completed_steps(client):
    """A run that crashes mid-graph is retried by the queue and resumes from the Postgres checkpoint:
    completed steps are NOT re-executed."""
    from core.llm.types import ProviderError
    calls: list[str] = []
    crashes = {"left": 6}  # 3 node attempts x 2 models in the chain -> the whole job fails once

    def agent(system, messages, tools):
        instr = last_user(messages)
        calls.append(instr)
        if instr == "second" and crashes["left"] > 0:
            crashes["left"] -= 1
            raise ProviderError("overloaded", retryable=True, provider="scripted", status=529)
        return resp(f"ok {instr}")

    steps = [{"id": "s1", "agent": "research", "instruction": "first"},
             {"id": "s2", "agent": "knowledge", "instruction": "second", "depends_on": ["s1"]}]
    STATE["script"] = make_script(plan_json(steps), agent, synth="resumed fine")
    _, task_id = await send(client, "two step")
    await drain_jobs()
    t = (await client.get(f"/api/tasks/{task_id}")).json()
    assert t["status"] == "COMPLETED", t
    assert calls.count("first") == 1, calls  # s1 ran exactly once despite the crash
    assert t["attempts"] == 2
    assert any("Resuming from checkpoint" in log["message"] for log in t["logs"])
    assert t["output"].strip() == "resumed fine"


async def test_agents_crud_and_override(client):
    agents = (await client.get("/api/agents")).json()
    assert {a["slug"] for a in agents} >= {"career", "communication", "research", "developer", "finance",
                                            "secretary", "operations", "security", "knowledge"}
    r = await client.patch("/api/agents/research", json={"effort": "low", "enabled": False})
    assert r.status_code == 200 and r.json()["effort"] == "low" and r.json()["enabled"] is False
    assert (await client.post("/api/agents", json={"slug": "bad", "name": "Bad", "system_prompt": "x" * 20,
                                                   "tools": ["rm_rf"]})).status_code == 422
    assert (await client.delete("/api/agents/research")).status_code == 204  # reset to default
    r = (await client.get("/api/agents/research")).json()
    assert r["enabled"] is True and r["effort"] == "high"
    tools = (await client.get("/api/agents/tools")).json()
    assert any(t["name"] == "gmail_send" and t["risk"] == "external" for t in tools)


async def test_approval_isolation(client):
    from tests.conftest import make_client
    other = await make_client()
    async with SessionLocal() as db:
        a = (await db.execute(select(Approval).limit(1))).scalars().first()
    if a:
        r = await other.post(f"/api/approvals/{a.id}/decision", json={"approve": True})
        assert r.status_code == 409 and "not found" in r.text.lower()
    tasks = (await other.get("/api/tasks")).json()
    assert tasks["items"] == []
    async with SessionLocal() as db:
        any_task = (await db.execute(select(Task).limit(1))).scalars().first()
    assert (await other.get(f"/api/tasks/{any_task.id}")).status_code == 404
