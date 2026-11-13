"""Security monitoring tools (read-only)."""
from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import func, select

from agents.tools.base import Risk, S, ToolContext, ToolResult, integer, string, tool
from database.models import AuditLog, Integration, UsageRecord

SECRET_RULES = {
    "Anthropic API key": r"sk-ant-[A-Za-z0-9_\-]{20,}",
    "OpenAI API key": r"sk-(proj-)?[A-Za-z0-9_\-]{20,}",
    "AWS access key": r"AKIA[0-9A-Z]{16}",
    "GitHub token": r"gh[pousr]_[A-Za-z0-9]{30,}",
    "Slack token": r"xox[abpr]-[A-Za-z0-9-]{10,}",
    "Private key": r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "Google API key": r"AIza[0-9A-Za-z_\-]{35}",
    "Generic secret assignment": r"(?i)(secret|password|token|api_key)\s*[:=]\s*['\"][^'\"]{8,}['\"]",
}


def scan_for_secrets(text: str) -> list[dict[str, Any]]:
    findings = []
    for name, pattern in SECRET_RULES.items():
        for m in re.finditer(pattern, text):
            val = m.group(0)
            findings.append({"type": name, "preview": val[:6] + "…" + val[-2:], "offset": m.start()})
    return findings


@tool("security_scan_text", "Scan text/code/config for exposed credentials. Returns masked findings only.",
      S(text=string("Text to scan")) | {"required": ["text"]}, risk=Risk.READ, category="security")
async def security_scan_text(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    f = scan_for_secrets(a["text"])
    if not f:
        return ToolResult("No credential patterns detected.")
    return ToolResult(f"{len(f)} potential secret(s):\n" + "\n".join(
        f"- {x['type']} at offset {x['offset']}: {x['preview']}" for x in f), {"findings": f})


@tool("security_activity_review", "Review recent account activity: failed logins, denied actions, integration "
      "errors and unusual API usage.", S(hours=integer("Lookback window (default 48)")),
      risk=Risk.READ, category="security")
async def security_activity_review(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    since = datetime.now(UTC) - timedelta(hours=int(a.get("hours") or 48))
    failures = (await ctx.db.execute(select(AuditLog).where(
        AuditLog.user_id == ctx.user_id, AuditLog.created_at >= since, AuditLog.success.is_(False))
        .order_by(AuditLog.created_at.desc()).limit(25))).scalars().all()
    logins = (await ctx.db.execute(select(AuditLog.ip_address, func.count()).where(
        AuditLog.user_id == ctx.user_id, AuditLog.action == "auth.login", AuditLog.created_at >= since)
        .group_by(AuditLog.ip_address))).all()
    usage = (await ctx.db.execute(select(UsageRecord.model, func.count(), func.sum(UsageRecord.cost_usd)).where(
        UsageRecord.user_id == ctx.user_id, UsageRecord.created_at >= since).group_by(UsageRecord.model))).all()
    integ = (await ctx.db.execute(select(Integration).where(Integration.user_id == ctx.user_id))).scalars().all()
    out = {"failed_events": [{"at": f.created_at.isoformat(), "action": f.action, "details": f.details}
                             for f in failures],
           "logins_by_ip": {str(ip): n for ip, n in logins},
           "api_usage": [{"model": m, "calls": n, "cost_usd": float(c or 0)} for m, n, c in usage],
           "integrations": [{"provider": i.provider, "status": i.status, "last_error": i.last_error,
                             "last_used": i.last_used_at.isoformat() if i.last_used_at else None} for i in integ]}
    return ToolResult(json.dumps(out, indent=1, default=str), out)


@tool("security_backup_status", "Report the verified status of the most recent database backup.", S(),
      risk=Risk.READ, category="security")
async def security_backup_status(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    path = os.environ.get("BACKUP_STATUS_FILE", "/backups/last_backup.json")
    try:
        data = json.loads(await asyncio.to_thread(Path(path).read_text))
    except FileNotFoundError:
        return ToolResult("No backup status record found. A verified backup cannot be confirmed.")
    except (OSError, json.JSONDecodeError) as exc:
        return ToolResult(f"Backup status unreadable: {exc}. A verified backup cannot be confirmed.", is_error=True)
    verified = data.get("verified") is True
    return ToolResult(f"Last backup: {data.get('file')} at {data.get('finished_at')} — "
                      f"{'VERIFIED (restore test passed)' if verified else 'NOT VERIFIED'}; "
                      f"size {data.get('size_bytes')} bytes, tables {data.get('tables')}.", data)
