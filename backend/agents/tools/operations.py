"""Operations tools: tasks, automations, n8n and MCP."""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select

from agents.tools.base import Risk, S, ToolContext, ToolResult, integer, string, tool
from database.models import AutomationWorkflow, Integration, Task
from integrations.providers.automation import MCPClient, n8n_trigger
from integrations.service import get_credentials


@tool("tasks_list", "List the user's recent LEXA tasks and their status.",
      S(status=string("Filter by status"), limit=integer("Max (default 15)")), risk=Risk.READ, category="operations")
async def tasks_list(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    q = select(Task).where(Task.user_id == ctx.user_id)
    if a.get("status"):
        q = q.where(Task.status == a["status"])
    rows = (await ctx.db.execute(q.order_by(Task.created_at.desc()).limit(int(a.get("limit") or 15)))).scalars().all()
    return ToolResult("\n".join(f"[{t.id}] {t.status.value} — {t.title or t.request[:80]} ({t.created_at:%Y-%m-%d %H:%M})"
                                for t in rows) or "No tasks.")


@tool("automation_create", "Create a recurring/scheduled automation that runs an instruction through LEXA.",
      S(name=string("Name"), cron=string("5-field cron expression, e.g. '0 8 * * 1-5'"),
        timezone=string("IANA timezone"), instruction=string("What LEXA should do on each run"),
        agent_slug=string("Optional agent to route to")) | {"required": ["name", "cron", "instruction"]},
      risk=Risk.EXTERNAL, category="operations",
      summarize=lambda a: f"Create automation “{a.get('name')}” on cron `{a.get('cron')}`: {a.get('instruction')}")
async def automation_create(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    from workers.scheduler import next_run
    try:
        nxt = next_run(a["cron"], a.get("timezone") or "UTC")
    except ValueError as exc:
        return ToolResult(f"Invalid cron: {exc}", is_error=True)
    wf = AutomationWorkflow(user_id=ctx.user_id, name=a["name"], trigger_type="schedule", cron=a["cron"],
                            timezone=a.get("timezone") or "UTC", instruction=a["instruction"],
                            agent_slug=a.get("agent_slug"), next_run_at=nxt)
    ctx.db.add(wf)
    await ctx.db.flush()
    return ToolResult(f"Automation {wf.id} created; next run {nxt.isoformat()}.")


@tool("n8n_trigger_workflow", "Trigger an n8n workflow via its webhook URL with a JSON payload.",
      S(webhook_url=string("n8n webhook URL"), payload=string("JSON payload")) | {"required": ["webhook_url"]},
      risk=Risk.EXTERNAL, category="operations", integration="n8n",
      summarize=lambda a: f"Trigger n8n workflow {a.get('webhook_url')} with {str(a.get('payload'))[:300]}")
async def n8n_trigger_workflow(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    creds = await get_credentials(ctx.db, ctx.user_id, "n8n", actor=f"agent:{ctx.agent_slug}")
    base = creds["base_url"].rstrip("/")
    if not a["webhook_url"].startswith(base):
        return ToolResult(f"Webhook must belong to the connected n8n instance ({base}).", is_error=True)
    payload = json.loads(a.get("payload") or "{}")
    r = await n8n_trigger(a["webhook_url"], payload, creds.get("api_key"))
    return ToolResult(f"n8n responded: {json.dumps(r)[:4000]}", r, untrusted_source="n8n")


async def _mcp(ctx: ToolContext) -> tuple[MCPClient, bool]:
    creds = await get_credentials(ctx.db, ctx.user_id, "mcp", actor=f"agent:{ctx.agent_slug}")
    return MCPClient(creds["url"], creds.get("bearer_token")), str(creds.get("read_only", "")).lower() == "true"


@tool("mcp_list_tools", "List the tools exposed by the user's connected MCP server.", S(),
      risk=Risk.READ, category="operations", integration="mcp")
async def mcp_list_tools(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    client, _ = await _mcp(ctx)
    tools = await client.list_tools()
    return ToolResult("\n".join(f"- {t['name']}: {t.get('description', '')[:200]}" for t in tools) or "No tools.",
                      untrusted_source="mcp")


@tool("mcp_call_tool", "Call a tool on the connected MCP server. Treated as an external action unless the "
      "server is registered read-only.", S(name=string("MCP tool name"), arguments=string("JSON arguments")) |
      {"required": ["name"]}, risk=Risk.EXTERNAL, category="operations", integration="mcp",
      summarize=lambda a: f"Call MCP tool {a.get('name')} with {str(a.get('arguments'))[:400]}")
async def mcp_call_tool(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    client, _ = await _mcp(ctx)
    out = await client.call_tool(a["name"], json.loads(a.get("arguments") or "{}"))
    return ToolResult(out, untrusted_source="mcp")


async def mcp_is_read_only(ctx: ToolContext) -> bool:
    integ = await ctx.db.scalar(select(Integration).where(Integration.user_id == ctx.user_id,
                                                          Integration.provider == "mcp"))
    return bool(integ and integ.config.get("read_only"))
