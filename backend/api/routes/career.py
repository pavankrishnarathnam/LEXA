from __future__ import annotations

import uuid
from collections import Counter

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from sqlalchemy import select

from agents.tools.career import compute_match, job_fingerprint
from api.deps import DB, CurrentUser
from api.schemas import ApplicationPatch, JobIn
from api.serializers import iso
from database.models import JobApplication, JobOpportunity, UserProfile

router = APIRouter(prefix="/api/career", tags=["career"])


def job_out(j: JobOpportunity) -> dict:
    return {"id": str(j.id), "title": j.title, "company": j.company, "location": j.location,
            "remote_type": j.remote_type, "employment_type": j.employment_type, "salary_min": j.salary_min,
            "salary_max": j.salary_max, "salary_currency": j.salary_currency, "url": j.url, "source": j.source,
            "description": j.description, "required_skills": j.required_skills, "match_score": j.match_score,
            "match_analysis": j.match_analysis, "saved": j.saved, "status": j.status, "created_at": iso(j.created_at)}


def app_out(a: JobApplication) -> dict:
    return {"id": str(a.id), "job_id": str(a.job_id), "status": a.status, "cover_letter": a.cover_letter,
            "answers": a.answers, "notes": a.notes, "timeline": a.timeline, "submitted_at": iso(a.submitted_at),
            "submission_method": a.submission_method, "created_at": iso(a.created_at),
            "job": {"title": a.job.title, "company": a.job.company, "url": a.job.url} if a.job else None}


@router.get("/jobs")
async def jobs(user: CurrentUser, db: DB, status: str | None = None) -> list[dict]:
    q = select(JobOpportunity).where(JobOpportunity.user_id == user.id)
    if status:
        q = q.where(JobOpportunity.status == status)
    rows = (await db.execute(q.order_by(JobOpportunity.match_score.desc().nulls_last(),
                                        JobOpportunity.created_at.desc()).limit(200))).scalars()
    return [job_out(j) for j in rows]


@router.post("/jobs", status_code=201)
async def add_job(body: JobIn, user: CurrentUser, db: DB) -> dict:
    fp = job_fingerprint(body.title, body.company, body.url)
    if await db.scalar(select(JobOpportunity).where(JobOpportunity.user_id == user.id,
                                                    JobOpportunity.fingerprint == fp)):
        raise HTTPException(409, "This job is already saved")
    j = JobOpportunity(user_id=user.id, fingerprint=fp, source="manual", saved=True, status="saved",
                       **body.model_dump())
    profile = await db.scalar(select(UserProfile).where(UserProfile.user_id == user.id))
    j.match_analysis = compute_match(profile, j)
    j.match_score = j.match_analysis["score"]
    db.add(j)
    await db.flush()
    return job_out(j)


@router.patch("/jobs/{jid}")
async def update_job(jid: uuid.UUID, body: dict, user: CurrentUser, db: DB) -> dict:
    j = await db.scalar(select(JobOpportunity).where(JobOpportunity.id == jid, JobOpportunity.user_id == user.id))
    if not j:
        raise HTTPException(404, "Job not found")
    if body.get("status") in ("new", "saved", "dismissed", "applied"):
        j.status = body["status"]
        j.saved = body["status"] == "saved"
    if body.get("rescore"):
        profile = await db.scalar(select(UserProfile).where(UserProfile.user_id == user.id))
        j.match_analysis = compute_match(profile, j)
        j.match_score = j.match_analysis["score"]
    return job_out(j)


@router.delete("/jobs/{jid}", status_code=204)
async def delete_job(jid: uuid.UUID, user: CurrentUser, db: DB) -> Response:
    j = await db.scalar(select(JobOpportunity).where(JobOpportunity.id == jid, JobOpportunity.user_id == user.id))
    if not j:
        raise HTTPException(404, "Job not found")
    await db.delete(j)
    return Response(status_code=204)


@router.get("/applications")
async def applications(user: CurrentUser, db: DB) -> list[dict]:
    from sqlalchemy.orm import selectinload
    rows = (await db.execute(select(JobApplication).options(selectinload(JobApplication.job))
                             .where(JobApplication.user_id == user.id)
                             .order_by(JobApplication.updated_at.desc()))).scalars()
    return [app_out(a) for a in rows]


@router.patch("/applications/{aid}")
async def update_application(aid: uuid.UUID, body: ApplicationPatch, user: CurrentUser, db: DB) -> dict:
    from datetime import UTC, datetime

    from sqlalchemy.orm import selectinload
    a = await db.scalar(select(JobApplication).options(selectinload(JobApplication.job))
                        .where(JobApplication.id == aid, JobApplication.user_id == user.id))
    if not a:
        raise HTTPException(404, "Application not found")
    data = body.model_dump(exclude_none=True)
    if "status" in data and data["status"] != a.status:
        a.timeline = [*a.timeline, {"at": datetime.now(UTC).isoformat(), "event": data["status"], "by": "user"}]
        if data["status"] == "submitted" and not a.submitted_at:
            a.submitted_at, a.submission_method = datetime.now(UTC), "manual"
            a.job.status = "applied"
    for k, v in data.items():
        setattr(a, k, v)
    return app_out(a)


@router.get("/analytics")
async def analytics(user: CurrentUser, db: DB) -> dict:
    apps = (await db.execute(select(JobApplication).where(JobApplication.user_id == user.id))).scalars().all()
    jobs_ = (await db.execute(select(JobOpportunity).where(JobOpportunity.user_id == user.id))).scalars().all()
    funnel = Counter(a.status for a in apps)
    submitted = sum(funnel[s] for s in ("submitted", "interviewing", "offer", "rejected"))
    scores = [j.match_score for j in jobs_ if j.match_score is not None]
    skills_gap = Counter(s for j in jobs_ for s in (j.match_analysis or {}).get("missing_skills", []))
    return {"jobs_tracked": len(jobs_), "applications": len(apps), "funnel": dict(funnel),
            "response_rate": round((funnel["interviewing"] + funnel["offer"]) / submitted * 100, 1) if submitted else None,
            "avg_match_score": round(sum(scores) / len(scores), 1) if scores else None,
            "top_missing_skills": skills_gap.most_common(8)}
