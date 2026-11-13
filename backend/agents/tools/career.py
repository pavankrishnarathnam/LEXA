"""Career tools: job tracking, matching, applications. No fabrication; submission requires approval."""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select

from agents.tools.base import Risk, S, ToolContext, ToolResult, array, number, string, tool
from database.models import JobApplication, JobOpportunity, UserProfile


def job_fingerprint(title: str, company: str, url: str | None) -> str:
    base = (url or "").split("?")[0].lower().rstrip("/") or f"{title}|{company}"
    base = re.sub(r"\s+", " ", base.lower()).strip()
    return hashlib.sha256(f"{base}|{company.lower().strip()}|{title.lower().strip()}".encode()).hexdigest()


def compute_match(profile: UserProfile | None, job: JobOpportunity) -> dict[str, Any]:
    """Deterministic, explainable baseline match score (agents may add qualitative analysis on top)."""
    skills = {s.lower().strip() for s in (profile.skills if profile else []) if s}
    required = {s.lower().strip() for s in job.required_skills if s}
    desc = job.description.lower()
    if not required:
        required = {s for s in skills if s and s in desc}
    matched = sorted(s for s in required if s in skills or any(s in k or k in s for k in skills))
    missing = sorted(required - set(matched))
    skill_score = len(matched) / len(required) if required else 0.5
    prefs = (profile.career_preferences if profile else {}) or {}
    pref_score, notes = 1.0, []
    if prefs.get("remote") and job.remote_type not in ("unknown", prefs["remote"]):
        pref_score -= 0.25
        notes.append(f"Work mode {job.remote_type} differs from preferred {prefs['remote']}")
    if prefs.get("salary_min") and job.salary_max and job.salary_max < float(prefs["salary_min"]):
        pref_score -= 0.35
        notes.append("Salary below preferred minimum")
    if prefs.get("locations") and job.location and job.remote_type != "remote" and not any(
            loc.lower() in job.location.lower() for loc in prefs["locations"]):
        pref_score -= 0.2
        notes.append("Location outside preferred locations")
    score = round(max(0.0, min(1.0, 0.7 * skill_score + 0.3 * pref_score)) * 100, 1)
    return {"score": score, "matched_skills": matched, "missing_skills": missing, "preference_notes": notes,
            "method": "skills overlap (70%) + preferences fit (30%)"}


@tool("job_save", "Save a job opportunity the user or an agent found (deduplicated). Only use details that "
      "actually appear in the posting.",
      S(title=string("Job title"), company=string("Company"), url=string("Posting URL"),
        location=string("Location"), remote_type=string("remote, hybrid, onsite, unknown",
                                                         enum=["remote", "hybrid", "onsite", "unknown"]),
        employment_type=string("full-time, contract..."), description=string("Job description text"),
        required_skills=array("Skills explicitly required by the posting"), salary_min=number("Min salary"),
        salary_max=number("Max salary"), salary_currency=string("Currency code"), source=string("Where found")) |
      {"required": ["title", "company"]}, risk=Risk.INTERNAL, category="career")
async def job_save(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    fp = job_fingerprint(a["title"], a["company"], a.get("url"))
    job = await ctx.db.scalar(select(JobOpportunity).where(JobOpportunity.user_id == ctx.user_id,
                                                           JobOpportunity.fingerprint == fp))
    created = job is None
    if created:
        job = JobOpportunity(user_id=ctx.user_id, fingerprint=fp, title=a["title"], company=a["company"])
        ctx.db.add(job)
    for k in ("url", "location", "remote_type", "employment_type", "description", "required_skills", "salary_min",
              "salary_max", "salary_currency", "source"):
        if a.get(k) not in (None, ""):
            setattr(job, k, a[k])
    profile = await ctx.db.scalar(select(UserProfile).where(UserProfile.user_id == ctx.user_id))
    job.match_analysis = compute_match(profile, job)
    job.match_score = job.match_analysis["score"]
    await ctx.db.flush()
    return ToolResult(f"{'Saved new' if created else 'Updated existing'} job {job.id}: {job.title} at {job.company} "
                      f"— match {job.match_score}%. {json.dumps(job.match_analysis)}",
                      {"job_id": str(job.id), "created": created})


@tool("jobs_list", "List saved job opportunities with match scores.",
      S(status=string("new, saved, applied, dismissed"), min_score=number("Minimum match score")),
      risk=Risk.READ, category="career")
async def jobs_list(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    q = select(JobOpportunity).where(JobOpportunity.user_id == ctx.user_id)
    if a.get("status"):
        q = q.where(JobOpportunity.status == a["status"])
    if a.get("min_score") is not None:
        q = q.where(JobOpportunity.match_score >= float(a["min_score"]))
    jobs = (await ctx.db.execute(q.order_by(JobOpportunity.match_score.desc().nulls_last()).limit(30))).scalars().all()
    if not jobs:
        return ToolResult("No saved jobs.")
    return ToolResult("\n".join(f"[{j.id}] {j.title} @ {j.company} ({j.location or j.remote_type}) "
                                f"score={j.match_score} status={j.status} {j.url or ''}" for j in jobs))


@tool("application_prepare", "Create or update an application draft for a saved job with a tailored cover "
      "letter and answers. Never invent experience, qualifications or certificates.",
      S(job_id=string("Saved job id"), cover_letter=string("Cover letter text"),
        answers=string("JSON object of application question -> answer"), notes=string("Notes"),
        resume_document_id=string("Resume document id to use")) | {"required": ["job_id"]},
      risk=Risk.INTERNAL, category="career")
async def application_prepare(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    job = await ctx.db.scalar(select(JobOpportunity).where(JobOpportunity.id == uuid.UUID(a["job_id"]),
                                                           JobOpportunity.user_id == ctx.user_id))
    if not job:
        return ToolResult("Job not found.", is_error=True)
    app = await ctx.db.scalar(select(JobApplication).where(JobApplication.user_id == ctx.user_id,
                                                           JobApplication.job_id == job.id))
    if app and app.status not in ("draft", "ready"):
        return ToolResult(f"Duplicate prevented: an application for this job already exists with status "
                          f"'{app.status}' (id {app.id}).", is_error=True)
    if not app:
        app = JobApplication(user_id=ctx.user_id, job_id=job.id, timeline=[])
        ctx.db.add(app)
    if a.get("cover_letter"):
        app.cover_letter = a["cover_letter"]
    if a.get("answers"):
        try:
            app.answers = json.loads(a["answers"])
        except json.JSONDecodeError:
            app.answers = {"notes": a["answers"]}
    if a.get("resume_document_id"):
        app.resume_document_id = uuid.UUID(a["resume_document_id"])
    if a.get("notes"):
        app.notes = a["notes"]
    app.status = "ready"
    app.timeline = [*app.timeline, {"at": datetime.now(UTC).isoformat(), "event": "prepared",
                                    "by": ctx.agent_slug}]
    job.status = "saved"
    await ctx.db.flush()
    return ToolResult(f"Application {app.id} prepared and ready for the user's review.",
                      {"application_id": str(app.id)})


@tool("application_submit_email", "Submit a prepared application by emailing the recruiter/hiring address "
      "from the user's Gmail (only when the posting asks for email applications). Requires approval.",
      S(application_id=string("Prepared application id"), to=string("Application email address"),
        subject=string("Subject"), body=string("Email body")) |
      {"required": ["application_id", "to", "subject", "body"]},
      risk=Risk.SENSITIVE, category="career", integration="gmail",
      summarize=lambda a: f"Submit job application by email to {a.get('to')} — “{a.get('subject')}”\n\n"
                          f"{a.get('body', '')[:1200]}")
async def application_submit_email(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    from integrations.providers.google import GoogleClient
    from integrations.service import get_credentials
    app = await ctx.db.scalar(select(JobApplication).where(JobApplication.id == uuid.UUID(a["application_id"]),
                                                           JobApplication.user_id == ctx.user_id))
    if not app:
        return ToolResult("Application not found.", is_error=True)
    if app.status == "submitted":
        return ToolResult("Duplicate prevented: application already submitted.", is_error=True)
    creds = await get_credentials(ctx.db, ctx.user_id, "gmail", actor=f"agent:{ctx.agent_slug}")
    r = await GoogleClient(creds["access_token"]).gmail_send(a["to"], a["subject"], a["body"])
    app.status, app.submitted_at, app.submission_method = "submitted", datetime.now(UTC), "email"
    app.timeline = [*app.timeline, {"at": datetime.now(UTC).isoformat(), "event": "submitted",
                                    "gmail_id": r.get("id")}]
    return ToolResult(f"Application emailed (Gmail id {r.get('id')}) and marked submitted.")


@tool("application_update_status", "Record an application status change reported by the user or a recruiter "
      "email (e.g. interviewing, rejected, offer).",
      S(application_id=string("Application id"), status=string("Status", enum=[
          "submitted", "interviewing", "offer", "rejected", "withdrawn"]), note=string("Note")) |
      {"required": ["application_id", "status"]}, risk=Risk.INTERNAL, category="career")
async def application_update_status(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    app = await ctx.db.scalar(select(JobApplication).where(JobApplication.id == uuid.UUID(a["application_id"]),
                                                           JobApplication.user_id == ctx.user_id))
    if not app:
        return ToolResult("Application not found.", is_error=True)
    app.status = a["status"]
    if a["status"] == "submitted" and not app.submitted_at:
        app.submitted_at, app.submission_method = datetime.now(UTC), "manual"
    app.timeline = [*app.timeline, {"at": datetime.now(UTC).isoformat(), "event": a["status"],
                                    "note": a.get("note", "")}]
    return ToolResult("Status updated.")
