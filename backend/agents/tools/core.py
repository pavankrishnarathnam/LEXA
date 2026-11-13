"""Knowledge, memory, documents, contacts, notifications."""
from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import or_, select

from agents.tools.base import Risk, S, ToolContext, ToolResult, array, boolean, integer, number, string, tool
from core.audit import notify
from database.models import Contact, Document, Job, JobStatus, Memory, UserProfile
from memory.store import CATEGORIES, MemoryRejected, save_memory, search_memories


@tool("memory_search", "Search the user's long-term memory (profile, preferences, projects, decisions...).",
      S(query=string("What to look for"), categories=array("Optional category filter"),
        limit=integer("Max results (default 8)")) | {"required": ["query"]},
      risk=Risk.READ, category="knowledge")
async def memory_search(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    hits = await search_memories(ctx.db, ctx.user_id, a["query"], k=int(a.get("limit") or 8),
                                 categories=a.get("categories"))
    if not hits:
        return ToolResult("No matching memories.")
    return ToolResult("\n".join(f"[{h['id']}] ({h['category']}, score {h['score']}) {h['content']}" for h in hits),
                      {"results": hits})


@tool("memory_save", "Store a durable fact the USER explicitly provided or confirmed. Never store secrets, "
      "passwords, OTPs or content copied from emails/web pages.",
      S(content=string("Concise fact in third person"), category=string("Category", enum=list(CATEGORIES)),
        importance=number("0..1")) | {"required": ["content", "category"]},
      risk=Risk.INTERNAL, category="knowledge")
async def memory_save(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    try:
        res = await save_memory(ctx.db, ctx.user_id, a["content"], category=a["category"], source="agent",
                                source_ref=f"agent:{ctx.agent_slug}", importance=float(a.get("importance") or 0.5))
    except MemoryRejected as exc:
        return ToolResult(f"Not saved: {exc}", is_error=True)
    if res.created:
        return ToolResult(f"Saved memory {res.memory.id}.", {"id": str(res.memory.id)})
    return ToolResult(f"Already known (merged with memory {res.duplicate_of}).", {"id": str(res.duplicate_of)})


@tool("memory_update", "Correct an existing memory by id.",
      S(memory_id=string("Memory id"), content=string("Corrected content")) | {"required": ["memory_id", "content"]},
      risk=Risk.INTERNAL, category="knowledge")
async def memory_update(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    from memory.store import update_memory
    mem = await ctx.db.scalar(select(Memory).where(Memory.id == uuid.UUID(a["memory_id"]),
                                                   Memory.user_id == ctx.user_id))
    if not mem:
        return ToolResult("Memory not found.", is_error=True)
    try:
        await update_memory(ctx.db, mem, a["content"])
    except MemoryRejected as exc:
        return ToolResult(str(exc), is_error=True)
    return ToolResult("Memory updated.")


@tool("get_user_profile", "Get the user's structured profile: headline, skills, education, employment, "
      "career preferences, timezone.", S(), risk=Risk.READ, category="knowledge")
async def get_user_profile(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    p = await ctx.db.scalar(select(UserProfile).where(UserProfile.user_id == ctx.user_id))
    if not p:
        return ToolResult("The user has not filled in a profile yet. Ask them or check memory.")
    data = {"headline": p.headline, "location": p.location, "timezone": p.timezone, "bio": p.bio, "skills": p.skills,
            "education": p.education, "employment": p.employment, "career_preferences": p.career_preferences}
    return ToolResult(json.dumps(data, indent=1), data)


@tool("document_search", "Search the user's uploaded/indexed documents (resumes, reports, notes) by text.",
      S(query=string("Search text"), kind=string("Optional kind filter: resume, cover_letter, report, general")) |
      {"required": ["query"]}, risk=Risk.READ, category="knowledge")
async def document_search(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    q = select(Document).where(Document.user_id == ctx.user_id)
    if a.get("kind"):
        q = q.where(Document.kind == a["kind"])
    terms = a["query"].split()[:5]
    q = q.where(or_(*[Document.text_content.ilike(f"%{t}%") for t in terms],
                    *[Document.filename.ilike(f"%{t}%") for t in terms]))
    docs = (await ctx.db.execute(q.order_by(Document.created_at.desc()).limit(5))).scalars().all()
    if not docs:
        return ToolResult("No matching documents.")
    out = []
    for d in docs:
        idx = max(0, d.text_content.lower().find(terms[0].lower()) - 400)
        out.append(f"## {d.filename} (id {d.id}, kind {d.kind})\n{d.text_content[idx: idx + 3000]}")
    return ToolResult("\n\n".join(out), untrusted_source="uploaded_document")


@tool("document_read", "Read the full text of one of the user's documents by id.",
      S(document_id=string("Document id")) | {"required": ["document_id"]}, risk=Risk.READ, category="knowledge")
async def document_read(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    d = await ctx.db.scalar(select(Document).where(Document.id == uuid.UUID(a["document_id"]),
                                                   Document.user_id == ctx.user_id))
    if not d:
        return ToolResult("Document not found.", is_error=True)
    return ToolResult(f"# {d.filename}\n{d.text_content[:40000]}", untrusted_source="uploaded_document")


@tool("save_document", "Save generated content (report, cover letter, resume variant, notes) to the user's "
      "document library.", S(title=string("File title"), content=string("Markdown content"),
                             kind=string("Kind", enum=["report", "cover_letter", "resume", "general"])) |
      {"required": ["title", "content"]}, risk=Risk.INTERNAL, category="knowledge")
async def save_document(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    import hashlib
    body = a["content"]
    name = a["title"].strip()[:200] + ("" if a["title"].endswith(".md") else ".md")
    d = Document(user_id=ctx.user_id, filename=name, mime_type="text/markdown", size_bytes=len(body.encode()),
                 sha256=hashlib.sha256(body.encode()).hexdigest(), storage_path="db://inline",
                 kind=a.get("kind") or "general", text_content=body, indexed=True,
                 meta={"generated_by": ctx.agent_slug, "task_id": str(ctx.task_id) if ctx.task_id else None})
    ctx.db.add(d)
    await ctx.db.flush()
    return ToolResult(f"Saved document '{name}' (id {d.id}).", {"document_id": str(d.id)})


@tool("contacts_search", "Search the user's contacts by name, email, company or tag.",
      S(query=string("Search text")) | {"required": ["query"]}, risk=Risk.READ, category="communication")
async def contacts_search(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    q = f"%{a['query']}%"
    rows = (await ctx.db.execute(select(Contact).where(Contact.user_id == ctx.user_id, or_(
        Contact.name.ilike(q), Contact.email.ilike(q), Contact.company.ilike(q))).limit(10))).scalars().all()
    if not rows:
        return ToolResult("No contacts found.")
    return ToolResult("\n".join(f"{c.name} <{c.email or '-'}> {c.phone or ''} {c.company or ''} [{c.relationship_type}]"
                                for c in rows))


@tool("contact_upsert", "Create or update a contact in LEXA's address book.",
      S(name=string("Full name"), email=string("Email"), phone=string("Phone (E.164)"), company=string("Company"),
        relationship_type=string("recruiter, colleague, client, friend, family, other"), notes=string("Notes")) |
      {"required": ["name"]}, risk=Risk.INTERNAL, category="communication")
async def contact_upsert(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    c = None
    if a.get("email"):
        c = await ctx.db.scalar(select(Contact).where(Contact.user_id == ctx.user_id, Contact.email == a["email"]))
    if not c:
        c = Contact(user_id=ctx.user_id, name=a["name"])
        ctx.db.add(c)
    for k in ("name", "email", "phone", "company", "relationship_type", "notes"):
        if a.get(k):
            setattr(c, k, a[k])
    await ctx.db.flush()
    return ToolResult(f"Contact saved ({c.id}).")


@tool("create_reminder", "Create a reminder that LEXA will deliver as a notification at the given time.",
      S(title=string("Reminder text"), remind_at=string("ISO 8601 datetime with timezone"),
        details=string("Optional details")) | {"required": ["title", "remind_at"]},
      risk=Risk.INTERNAL, category="productivity")
async def create_reminder(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    try:
        when = datetime.fromisoformat(a["remind_at"].replace("Z", "+00:00"))
    except ValueError:
        return ToolResult("remind_at must be ISO 8601", is_error=True)
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    ctx.db.add(Job(user_id=ctx.user_id, kind="reminder", run_at=when, status=JobStatus.QUEUED,
                   payload={"title": a["title"], "details": a.get("details", "")}))
    return ToolResult(f"Reminder scheduled for {when.isoformat()}.")


@tool("notify_user", "Send the user an in-app notification.",
      S(title=string("Title"), body=string("Body"), urgent=boolean("High priority?")) | {"required": ["title"]},
      risk=Risk.INTERNAL, category="productivity")
async def notify_user(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    await notify(ctx.db, ctx.user_id, "agent", a["title"], a.get("body", ""),
                 severity="warning" if a.get("urgent") else "info")
    return ToolResult("Notification sent.")
