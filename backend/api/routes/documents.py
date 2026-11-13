from __future__ import annotations

import asyncio
import hashlib
import os
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from sqlalchemy import delete, select

from api.deps import DB, CurrentUser
from api.serializers import iso
from core.audit import audit
from core.config import settings
from database.models import Document, Memory
from workers.documents import extract_text
from workers.queue import enqueue

router = APIRouter(prefix="/api/documents", tags=["documents"])
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", "/data/uploads"))
ALLOWED = (".pdf", ".txt", ".md", ".docx", ".csv", ".json", ".html", ".py", ".ts", ".js")


def doc_out(d: Document) -> dict:
    return {"id": str(d.id), "filename": d.filename, "mime_type": d.mime_type, "size_bytes": d.size_bytes,
            "kind": d.kind, "indexed": d.indexed, "created_at": iso(d.created_at),
            "chars": len(d.text_content), "meta": d.meta}


@router.get("")
async def list_documents(user: CurrentUser, db: DB, kind: str | None = None) -> list[dict]:
    q = select(Document).where(Document.user_id == user.id)
    if kind:
        q = q.where(Document.kind == kind)
    return [doc_out(d) for d in (await db.execute(q.order_by(Document.created_at.desc()).limit(200))).scalars()]


@router.post("", status_code=201)
async def upload(user: CurrentUser, db: DB, file: UploadFile = File(...), kind: str = Form("general")) -> dict:
    name = Path(file.filename or "upload").name[:200]
    if not name.lower().endswith(ALLOWED):
        raise HTTPException(415, f"Unsupported file type. Allowed: {', '.join(ALLOWED)}")
    data = await file.read()
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f"File exceeds {settings.max_upload_mb}MB")
    sha = hashlib.sha256(data).hexdigest()
    dup = await db.scalar(select(Document).where(Document.user_id == user.id, Document.sha256 == sha))
    if dup:
        return {**doc_out(dup), "duplicate": True}
    try:
        text = await asyncio.to_thread(extract_text, data, file.content_type or "", name)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(422, f"Could not read file: {exc}") from exc
    did = uuid.uuid4()
    folder = UPLOAD_DIR / str(user.id)
    await asyncio.to_thread(folder.mkdir, parents=True, exist_ok=True)
    path = folder / f"{did}{Path(name).suffix.lower()}"
    await asyncio.to_thread(path.write_bytes, data)
    doc = Document(id=did, user_id=user.id, filename=name, mime_type=file.content_type or "application/octet-stream",
                   size_bytes=len(data), sha256=sha, storage_path=str(path),
                   kind=kind if kind in ("general", "resume", "cover_letter", "report") else "general",
                   text_content=text[:500000])
    db.add(doc)
    await db.flush()
    if text.strip():
        await enqueue(db, "index_document", {"document_id": str(doc.id)}, user_id=user.id)
    await audit(db, user_id=user.id, action="document.upload", category="data", target_type="document",
                target_id=doc.id, details={"filename": name, "size": len(data)})
    return {**doc_out(doc), "duplicate": False}


async def _get(db: DB, user_id: uuid.UUID, did: uuid.UUID) -> Document:
    d = await db.scalar(select(Document).where(Document.id == did, Document.user_id == user_id))
    if not d:
        raise HTTPException(404, "Document not found")
    return d


@router.get("/{did}")
async def get_document(did: uuid.UUID, user: CurrentUser, db: DB) -> dict:
    d = await _get(db, user.id, did)
    return {**doc_out(d), "text_content": d.text_content[:200000]}


@router.get("/{did}/download")
async def download(did: uuid.UUID, user: CurrentUser, db: DB) -> Response:
    d = await _get(db, user.id, did)
    if d.storage_path.startswith("db://"):
        return Response(d.text_content, media_type=d.mime_type,
                        headers={"Content-Disposition": f'attachment; filename="{d.filename}"'})
    return FileResponse(d.storage_path, filename=d.filename, media_type=d.mime_type)


@router.delete("/{did}", status_code=204)
async def delete_document(did: uuid.UUID, user: CurrentUser, db: DB) -> Response:
    d = await _get(db, user.id, did)
    await db.execute(delete(Memory).where(Memory.user_id == user.id, Memory.source == "document",
                                          Memory.source_ref == str(d.id)))
    if not d.storage_path.startswith("db://"):
        await asyncio.to_thread(Path(d.storage_path).unlink, missing_ok=True)
    await db.delete(d)
    await audit(db, user_id=user.id, action="document.delete", category="data", target_type="document", target_id=did)
    return Response(status_code=204)
