"""Document text extraction and memory indexing."""
from __future__ import annotations

import io
import uuid

from sqlalchemy import delete

from database.models import Document, Memory
from database.session import SessionLocal
from memory.embeddings import embed_texts
from memory.store import content_hash


def extract_text(data: bytes, mime: str, filename: str) -> str:
    name = filename.lower()
    if mime == "application/pdf" or name.endswith(".pdf"):
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        return "\n\n".join((p.extract_text() or "") for p in reader.pages)
    if name.endswith(".docx"):
        import re
        import zipfile
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            xml = z.read("word/document.xml").decode("utf-8", errors="replace")
        return re.sub(r"<[^>]+>", " ", xml.replace("</w:p>", "\n"))
    if mime.startswith("text/") or name.endswith((".md", ".txt", ".csv", ".json", ".py", ".ts", ".js", ".html")):
        return data.decode("utf-8", errors="replace")
    return ""


def chunk(text: str, size: int = 1500, overlap: int = 200) -> list[str]:
    text = text.strip()
    out, i = [], 0
    while i < len(text):
        out.append(text[i:i + size])
        i += size - overlap
    return [c for c in out if c.strip()]


async def index_document(document_id: uuid.UUID) -> int:
    async with SessionLocal() as db:
        doc = await db.get(Document, document_id)
        if not doc:
            return 0
        await db.execute(delete(Memory).where(Memory.user_id == doc.user_id, Memory.source == "document",
                                              Memory.source_ref == str(doc.id)))
        chunks = chunk(doc.text_content)[:200]
        if chunks:
            vectors, model = await embed_texts(chunks, doc.user_id)
            for i, (c, v) in enumerate(zip(chunks, vectors, strict=True)):
                db.add(Memory(user_id=doc.user_id, category="documents", content=c[:4000],
                              content_hash=content_hash(f"{doc.id}:{i}:{c}"), source="document",
                              source_ref=str(doc.id), importance=0.3, embedding=v, embedding_model=model,
                              meta={"filename": doc.filename, "chunk": i}))
        doc.indexed = True
        await db.commit()
        return len(chunks)
