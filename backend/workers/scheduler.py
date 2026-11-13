"""Cron evaluation for automation workflows."""
from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from croniter import croniter


def next_run(cron: str, tz: str = "UTC", after: datetime | None = None) -> datetime:
    if not croniter.is_valid(cron) or len(cron.split()) != 5:
        raise ValueError(f"'{cron}' is not a valid 5-field cron expression")
    zone = ZoneInfo(tz)
    base = (after or datetime.now(UTC)).astimezone(zone)
    nxt = croniter(cron, base).get_next(datetime)
    return nxt.astimezone(UTC)
