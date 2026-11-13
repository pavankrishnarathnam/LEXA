"""Calendar tools."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from agents.tools.base import Risk, S, ToolContext, ToolResult, array, integer, string, tool
from integrations.providers.google import GoogleClient
from integrations.service import get_credentials


async def _cal(ctx: ToolContext) -> GoogleClient:
    creds = await get_credentials(ctx.db, ctx.user_id, "google_calendar", actor=f"agent:{ctx.agent_slug}")
    return GoogleClient(creds["access_token"])


@tool("calendar_list_events", "List calendar events in a time window (defaults to the next 7 days).",
      S(time_min=string("ISO start"), time_max=string("ISO end"), max_results=integer("Max events")),
      risk=Risk.READ, category="productivity", integration="google_calendar")
async def calendar_list_events(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    now = datetime.now(UTC)
    events = await (await _cal(ctx)).calendar_events(a.get("time_min") or now.isoformat(),
                                                     a.get("time_max") or (now + timedelta(days=7)).isoformat(),
                                                     int(a.get("max_results") or 25))
    if not events:
        return ToolResult("No events in that window.")
    lines = [f"- {(e['start'] or {}).get('dateTime') or (e['start'] or {}).get('date')} → "
             f"{(e['end'] or {}).get('dateTime') or (e['end'] or {}).get('date')}: {e['summary']}"
             f"{' @ ' + e['location'] if e.get('location') else ''} (id {e['id']})" for e in events]
    return ToolResult("\n".join(lines), {"events": events}, untrusted_source="google_calendar")


@tool("calendar_create_event", "Create a calendar event. Invites are sent to attendees if provided.",
      S(summary=string("Title"), start=string("ISO start datetime"), end=string("ISO end datetime"),
        timezone=string("IANA timezone"), description=string("Description"), location=string("Location"),
        attendees=array("Attendee emails")) | {"required": ["summary", "start", "end"]},
      risk=Risk.EXTERNAL, category="productivity", integration="google_calendar",
      summarize=lambda a: f"Calendar event “{a.get('summary')}” {a.get('start')} → {a.get('end')}"
                          + (f", inviting {', '.join(a.get('attendees') or [])}" if a.get("attendees") else ""))
async def calendar_create_event(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    e = await (await _cal(ctx)).calendar_create(a["summary"], a["start"], a["end"], a.get("timezone") or "UTC",
                                                a.get("description", ""), a.get("attendees"), a.get("location"))
    return ToolResult(f"Event created: {e['link']}", e)


@tool("drive_search", "Search the user's Google Drive files by text.",
      S(query=string("Search text")) | {"required": ["query"]}, risk=Risk.READ, category="productivity",
      integration="google_drive")
async def drive_search(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    creds = await get_credentials(ctx.db, ctx.user_id, "google_drive", actor=f"agent:{ctx.agent_slug}")
    files = await GoogleClient(creds["access_token"]).drive_search(a["query"])
    if not files:
        return ToolResult("No files found.")
    return ToolResult("\n".join(f"- {f['name']} ({f['mimeType']}, id {f['id']}) {f.get('webViewLink', '')}"
                                for f in files), untrusted_source="google_drive")


@tool("drive_read_file", "Read a Google Drive file's text content.",
      S(file_id=string("Drive file id")) | {"required": ["file_id"]}, risk=Risk.READ, category="productivity",
      integration="google_drive")
async def drive_read_file(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    creds = await get_credentials(ctx.db, ctx.user_id, "google_drive", actor=f"agent:{ctx.agent_slug}")
    f = await GoogleClient(creds["access_token"]).drive_read(a["file_id"])
    return ToolResult(f"# {f['name']}\n{f['content']}", untrusted_source="google_drive")
