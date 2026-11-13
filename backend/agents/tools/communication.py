"""Email (Gmail) and messaging (WhatsApp, Twilio, Exotel) tools."""
from __future__ import annotations

import re
from typing import Any

from agents.tools.base import Risk, S, ToolContext, ToolResult, integer, string, tool
from integrations.providers import messaging
from integrations.providers.google import GoogleClient
from integrations.service import get_credentials


async def _gmail(ctx: ToolContext) -> GoogleClient:
    creds = await get_credentials(ctx.db, ctx.user_id, "gmail", actor=f"agent:{ctx.agent_slug}")
    return GoogleClient(creds["access_token"])


def _confidential(a: dict[str, Any]) -> str | None:
    text = f"{a.get('subject', '')} {a.get('body', '')}".lower()
    if re.search(r"\b(confidential|nda|salary|ssn|aadhaar|passport|bank|medical|private)\b", text):
        return "message appears to contain confidential information"
    return None


@tool("gmail_search", "Search the user's Gmail with Gmail query syntax (e.g. 'is:unread newer_than:2d').",
      S(query=string("Gmail search query"), max_results=integer("1-25")) | {"required": ["query"]},
      risk=Risk.READ, category="communication", integration="gmail")
async def gmail_search(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    msgs = await (await _gmail(ctx)).gmail_search(a["query"], min(int(a.get("max_results") or 10), 25))
    if not msgs:
        return ToolResult("No messages matched.")
    lines = [f"- [{m['id']} / thread {m['thread_id']}] {m.get('date', '')} | From: {m.get('from', '')} | "
             f"Subject: {m.get('subject', '')} | {m['snippet']}" for m in msgs]
    return ToolResult("\n".join(lines), {"messages": msgs}, untrusted_source="gmail")


@tool("gmail_read_thread", "Read a full Gmail thread by thread id.",
      S(thread_id=string("Thread id")) | {"required": ["thread_id"]},
      risk=Risk.READ, category="communication", integration="gmail")
async def gmail_read_thread(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    t = await (await _gmail(ctx)).gmail_thread(a["thread_id"])
    body = "\n\n---\n\n".join(f"From: {m['from']}\nTo: {m['to']}\nDate: {m['date']}\nSubject: {m['subject']}\n"
                              f"Message-ID: {m['message_id']}\n\n{m['body']}" for m in t["messages"])
    return ToolResult(body, untrusted_source="gmail")


def _email_summary(a: dict[str, Any]) -> str:
    return f"Email to {a.get('to')} — “{a.get('subject', '')}”\n\n{a.get('body', '')[:1500]}"


EMAIL_SCHEMA = S(to=string("Recipient email(s), comma separated"), subject=string("Subject"),
                 body=string("Plain-text body"), cc=string("CC"), thread_id=string("Reply in thread"),
                 in_reply_to=string("Message-ID being replied to")) | {"required": ["to", "subject", "body"]}


@tool("gmail_create_draft", "Create a Gmail draft (not sent). Preferred way to prepare emails.", EMAIL_SCHEMA,
      risk=Risk.EXTERNAL, category="communication", integration="gmail", summarize=_email_summary)
async def gmail_create_draft(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    d = await (await _gmail(ctx)).gmail_create_draft(a["to"], a["subject"], a["body"], a.get("cc"),
                                                     a.get("thread_id"), a.get("in_reply_to"))
    return ToolResult(f"Draft created in Gmail (draft id {d.get('id')}).", {"draft_id": d.get("id")})


@tool("gmail_send", "Send an email from the user's Gmail account.", EMAIL_SCHEMA, risk=Risk.EXTERNAL,
      category="communication", integration="gmail", summarize=_email_summary, sensitivity=_confidential)
async def gmail_send(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    r = await (await _gmail(ctx)).gmail_send(a["to"], a["subject"], a["body"], a.get("cc"), a.get("thread_id"),
                                             a.get("in_reply_to"))
    if not r.get("id"):
        return ToolResult("Gmail did not confirm the send.", is_error=True)
    return ToolResult(f"Email sent (Gmail message id {r['id']}).", {"message_id": r["id"]})


MSG_SCHEMA = S(to=string("Recipient phone number in E.164 format"), body=string("Message text")) | {
    "required": ["to", "body"]}


def _msg_summary(channel: str):
    return lambda a: f"{channel} message to {a.get('to')}:\n{a.get('body', '')[:1000]}"


@tool("whatsapp_send", "Send a WhatsApp Business text message (only within an open 24h customer-service window "
      "unless using an approved template).", MSG_SCHEMA, risk=Risk.EXTERNAL, category="communication",
      integration="whatsapp", summarize=_msg_summary("WhatsApp"), sensitivity=_confidential)
async def whatsapp_send(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    creds = await get_credentials(ctx.db, ctx.user_id, "whatsapp", actor=f"agent:{ctx.agent_slug}")
    r = await messaging.whatsapp_send_text(creds, a["to"], a["body"])
    mid = (r.get("messages") or [{}])[0].get("id")
    return ToolResult(f"WhatsApp message accepted (id {mid}).", {"message_id": mid})


@tool("sms_send", "Send an SMS via the connected telephony provider (Twilio or Exotel).",
      MSG_SCHEMA | {"properties": {**MSG_SCHEMA["properties"],
                                   "provider": string("twilio or exotel", enum=["twilio", "exotel"])}},
      risk=Risk.EXTERNAL, category="communication", summarize=_msg_summary("SMS"), sensitivity=_confidential)
async def sms_send(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    provider = a.get("provider") or "twilio"
    creds = await get_credentials(ctx.db, ctx.user_id, provider, actor=f"agent:{ctx.agent_slug}")
    fn = messaging.twilio_send_sms if provider == "twilio" else messaging.exotel_send_sms
    r = await fn(creds, a["to"], a["body"])
    return ToolResult(f"SMS submitted via {provider}: {r}", r)
