"""Contacts, projects and finance ledger CRUD."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from sqlalchemy import select

from agents.tools.base import ToolContext
from agents.tools.finance import finance_summary
from api.deps import DB, CurrentUser
from api.schemas import ContactIn, FinanceIn
from api.serializers import iso
from database.models import Contact, FinanceEntry, Project

router = APIRouter(prefix="/api", tags=["records"])


def contact_out(c: Contact) -> dict:
    return {"id": str(c.id), "name": c.name, "email": c.email, "phone": c.phone, "company": c.company,
            "relationship_type": c.relationship_type, "notes": c.notes, "tags": c.tags,
            "last_contacted_at": iso(c.last_contacted_at)}


@router.get("/contacts")
async def contacts(user: CurrentUser, db: DB) -> list[dict]:
    return [contact_out(c) for c in (await db.execute(select(Contact).where(Contact.user_id == user.id)
                                                      .order_by(Contact.name))).scalars()]


@router.post("/contacts", status_code=201)
async def add_contact(body: ContactIn, user: CurrentUser, db: DB) -> dict:
    c = Contact(user_id=user.id, **body.model_dump())
    db.add(c)
    await db.flush()
    return contact_out(c)


@router.put("/contacts/{cid}")
async def edit_contact(cid: uuid.UUID, body: ContactIn, user: CurrentUser, db: DB) -> dict:
    c = await db.scalar(select(Contact).where(Contact.id == cid, Contact.user_id == user.id))
    if not c:
        raise HTTPException(404, "Contact not found")
    for k, v in body.model_dump().items():
        setattr(c, k, v)
    return contact_out(c)


@router.delete("/contacts/{cid}", status_code=204)
async def del_contact(cid: uuid.UUID, user: CurrentUser, db: DB) -> Response:
    c = await db.scalar(select(Contact).where(Contact.id == cid, Contact.user_id == user.id))
    if not c:
        raise HTTPException(404, "Contact not found")
    await db.delete(c)
    return Response(status_code=204)


@router.get("/projects")
async def projects(user: CurrentUser, db: DB) -> list[dict]:
    rows = (await db.execute(select(Project).where(Project.user_id == user.id).order_by(Project.updated_at.desc())))
    return [{"id": str(p.id), "name": p.name, "description": p.description, "status": p.status,
             "repository": p.repository, "updated_at": iso(p.updated_at)} for p in rows.scalars()]


@router.post("/projects", status_code=201)
async def add_project(body: dict, user: CurrentUser, db: DB) -> dict:
    if not str(body.get("name", "")).strip():
        raise HTTPException(422, "name required")
    p = Project(user_id=user.id, name=str(body["name"])[:200], description=str(body.get("description", ""))[:5000],
                repository=(str(body["repository"])[:300] if body.get("repository") else None))
    db.add(p)
    await db.flush()
    return {"id": str(p.id), "name": p.name}


@router.delete("/projects/{pid}", status_code=204)
async def del_project(pid: uuid.UUID, user: CurrentUser, db: DB) -> Response:
    p = await db.scalar(select(Project).where(Project.id == pid, Project.user_id == user.id))
    if not p:
        raise HTTPException(404, "Project not found")
    await db.delete(p)
    return Response(status_code=204)


def fin_out(e: FinanceEntry) -> dict:
    return {"id": str(e.id), "kind": e.kind, "amount": e.amount, "currency": e.currency, "category": e.category,
            "description": e.description, "occurred_on": iso(e.occurred_on), "due_on": iso(e.due_on),
            "recurrence": e.recurrence, "active": e.active}


def _d(v: str | None) -> datetime | None:
    if not v:
        return None
    d = datetime.fromisoformat(v.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=UTC)


@router.get("/finance/entries")
async def finance_entries(user: CurrentUser, db: DB) -> list[dict]:
    rows = (await db.execute(select(FinanceEntry).where(FinanceEntry.user_id == user.id)
                             .order_by(FinanceEntry.occurred_on.desc().nulls_last()).limit(500))).scalars()
    return [fin_out(e) for e in rows]


@router.post("/finance/entries", status_code=201)
async def add_finance(body: FinanceIn, user: CurrentUser, db: DB) -> dict:
    data = body.model_dump()
    e = FinanceEntry(user_id=user.id, **{**data, "occurred_on": _d(data["occurred_on"]) or datetime.now(UTC),
                                         "due_on": _d(data["due_on"])})
    db.add(e)
    await db.flush()
    return fin_out(e)


@router.delete("/finance/entries/{eid}", status_code=204)
async def del_finance(eid: uuid.UUID, user: CurrentUser, db: DB) -> Response:
    e = await db.scalar(select(FinanceEntry).where(FinanceEntry.id == eid, FinanceEntry.user_id == user.id))
    if not e:
        raise HTTPException(404, "Entry not found")
    await db.delete(e)
    return Response(status_code=204)


@router.get("/finance/summary")
async def fin_summary(user: CurrentUser, db: DB, days: int = 30) -> dict:
    res = await finance_summary(ToolContext(db=db, user_id=user.id, agent_slug="api"), {"days": days})
    return {"text": res.content, **res.data}
