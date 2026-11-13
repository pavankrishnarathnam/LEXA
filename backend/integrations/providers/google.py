"""Gmail, Google Calendar and Google Drive REST clients."""
from __future__ import annotations

import base64
from email.message import EmailMessage
from typing import Any

import httpx

GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me"
CAL = "https://www.googleapis.com/calendar/v3"
DRIVE = "https://www.googleapis.com/drive/v3"


class GoogleClient:
    def __init__(self, access_token: str):
        self._h = {"Authorization": f"Bearer {access_token}"}

    async def _req(self, method: str, url: str, **kw: Any) -> Any:
        async with httpx.AsyncClient(timeout=30, headers=self._h) as c:
            r = await c.request(method, url, **kw)
        if r.status_code >= 400:
            raise RuntimeError(f"Google API {r.status_code}: {r.text[:300]}")
        return r.json() if r.content else {}

    # ---------------- Gmail
    async def gmail_search(self, query: str, max_results: int = 10) -> list[dict[str, Any]]:
        data = await self._req("GET", f"{GMAIL}/messages", params={"q": query, "maxResults": max_results})
        out = []
        for m in data.get("messages", [])[:max_results]:
            msg = await self._req("GET", f"{GMAIL}/messages/{m['id']}", params={
                "format": "metadata", "metadataHeaders": ["From", "To", "Subject", "Date"]})
            headers = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}
            out.append({"id": msg["id"], "thread_id": msg["threadId"], "snippet": msg.get("snippet", ""),
                        "labels": msg.get("labelIds", []), **{k.lower(): v for k, v in headers.items()}})
        return out

    async def gmail_thread(self, thread_id: str) -> dict[str, Any]:
        data = await self._req("GET", f"{GMAIL}/threads/{thread_id}", params={"format": "full"})
        msgs = []
        for m in data.get("messages", []):
            headers = {h["name"].lower(): h["value"] for h in m.get("payload", {}).get("headers", [])}
            msgs.append({"id": m["id"], "from": headers.get("from"), "to": headers.get("to"),
                         "subject": headers.get("subject"), "date": headers.get("date"),
                         "message_id": headers.get("message-id"), "body": _extract_body(m.get("payload", {}))[:8000]})
        return {"thread_id": thread_id, "messages": msgs}

    @staticmethod
    def _raw(to: str, subject: str, body: str, cc: str | None = None, in_reply_to: str | None = None) -> str:
        msg = EmailMessage()
        msg["To"] = to
        msg["Subject"] = subject
        if cc:
            msg["Cc"] = cc
        if in_reply_to:
            msg["In-Reply-To"] = in_reply_to
            msg["References"] = in_reply_to
        msg.set_content(body)
        return base64.urlsafe_b64encode(msg.as_bytes()).decode()

    async def gmail_create_draft(self, to: str, subject: str, body: str, cc: str | None = None,
                                 thread_id: str | None = None, in_reply_to: str | None = None) -> dict[str, Any]:
        message: dict[str, Any] = {"raw": self._raw(to, subject, body, cc, in_reply_to)}
        if thread_id:
            message["threadId"] = thread_id
        return await self._req("POST", f"{GMAIL}/drafts", json={"message": message})

    async def gmail_send(self, to: str, subject: str, body: str, cc: str | None = None,
                         thread_id: str | None = None, in_reply_to: str | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"raw": self._raw(to, subject, body, cc, in_reply_to)}
        if thread_id:
            payload["threadId"] = thread_id
        return await self._req("POST", f"{GMAIL}/messages/send", json=payload)

    async def gmail_list_drafts(self, max_results: int = 20) -> list[dict[str, Any]]:
        data = await self._req("GET", f"{GMAIL}/drafts", params={"maxResults": max_results})
        return data.get("drafts", [])

    # ---------------- Calendar
    async def calendar_events(self, time_min: str, time_max: str, max_results: int = 25) -> list[dict[str, Any]]:
        data = await self._req("GET", f"{CAL}/calendars/primary/events", params={
            "timeMin": time_min, "timeMax": time_max, "singleEvents": "true", "orderBy": "startTime",
            "maxResults": max_results})
        return [{"id": e["id"], "summary": e.get("summary", "(no title)"), "start": e.get("start"),
                 "end": e.get("end"), "location": e.get("location"), "attendees": [
                     a.get("email") for a in e.get("attendees", [])], "link": e.get("htmlLink"),
                 "description": (e.get("description") or "")[:1000]} for e in data.get("items", [])]

    async def calendar_create(self, summary: str, start: str, end: str, timezone: str = "UTC",
                              description: str = "", attendees: list[str] | None = None,
                              location: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"summary": summary, "description": description,
                                "start": {"dateTime": start, "timeZone": timezone},
                                "end": {"dateTime": end, "timeZone": timezone}}
        if attendees:
            body["attendees"] = [{"email": a} for a in attendees]
        if location:
            body["location"] = location
        e = await self._req("POST", f"{CAL}/calendars/primary/events", json=body,
                            params={"sendUpdates": "all" if attendees else "none"})
        return {"id": e["id"], "link": e.get("htmlLink"), "status": e.get("status")}

    # ---------------- Drive
    async def drive_search(self, query: str, max_results: int = 15) -> list[dict[str, Any]]:
        safe = query.replace("\\", "\\\\").replace("'", "\\'")
        data = await self._req("GET", f"{DRIVE}/files", params={
            "q": f"fullText contains '{safe}' and trashed = false", "pageSize": max_results,
            "fields": "files(id,name,mimeType,modifiedTime,webViewLink,size)"})
        return data.get("files", [])

    async def drive_read(self, file_id: str) -> dict[str, Any]:
        meta = await self._req("GET", f"{DRIVE}/files/{file_id}", params={"fields": "id,name,mimeType"})
        mime = meta.get("mimeType", "")
        async with httpx.AsyncClient(timeout=60, headers=self._h) as c:
            if mime.startswith("application/vnd.google-apps."):
                r = await c.get(f"{DRIVE}/files/{file_id}/export", params={"mimeType": "text/plain"})
            else:
                r = await c.get(f"{DRIVE}/files/{file_id}", params={"alt": "media"})
        if r.status_code >= 400:
            raise RuntimeError(f"Drive download failed {r.status_code}")
        text = r.content.decode("utf-8", errors="replace") if (mime.startswith("text") or "google-apps" in mime) \
            else f"[binary file of type {mime}, {len(r.content)} bytes]"
        return {**meta, "content": text[:30000]}


def _extract_body(payload: dict[str, Any]) -> str:
    if payload.get("mimeType", "").startswith("text/plain") and payload.get("body", {}).get("data"):
        return base64.urlsafe_b64decode(payload["body"]["data"] + "==").decode("utf-8", errors="replace")
    for part in payload.get("parts", []) or []:
        text = _extract_body(part)
        if text:
            return text
    if payload.get("body", {}).get("data"):
        from bs4 import BeautifulSoup
        html = base64.urlsafe_b64decode(payload["body"]["data"] + "==").decode("utf-8", errors="replace")
        return BeautifulSoup(html, "html.parser").get_text("\n")
    return ""
