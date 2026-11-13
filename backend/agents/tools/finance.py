"""Finance tools: tracking and analysis only. No payments, transfers or investments are possible."""
from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select

from agents.tools.base import Risk, S, ToolContext, ToolResult, integer, number, string, tool
from database.models import FinanceEntry


def _date(v: str | None) -> datetime | None:
    if not v:
        return None
    d = datetime.fromisoformat(v.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=UTC)


@tool("finance_add_entry", "Record an expense, income, bill or subscription in the user's ledger.",
      S(kind=string("Entry kind", enum=["expense", "income", "bill", "subscription"]), amount=number("Amount"),
        currency=string("ISO currency code"), category=string("e.g. food, rent, travel, software"),
        description=string("Description"), occurred_on=string("ISO date"), due_on=string("Due date for bills"),
        recurrence=string("monthly, yearly, weekly", enum=["monthly", "yearly", "weekly"])) |
      {"required": ["kind", "amount"]}, risk=Risk.INTERNAL, category="finance")
async def finance_add_entry(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    e = FinanceEntry(user_id=ctx.user_id, kind=a["kind"], amount=float(a["amount"]), currency=a.get("currency") or "USD",
                     category=a.get("category") or "other", description=a.get("description", ""),
                     occurred_on=_date(a.get("occurred_on")) or datetime.now(UTC), due_on=_date(a.get("due_on")),
                     recurrence=a.get("recurrence"))
    ctx.db.add(e)
    await ctx.db.flush()
    return ToolResult(f"Recorded {e.kind} {e.amount} {e.currency} ({e.category}).", {"id": str(e.id)})


@tool("finance_summary", "Summarize spending by category, income, upcoming bills and active subscriptions.",
      S(days=integer("Lookback window in days (default 30)")), risk=Risk.READ, category="finance")
async def finance_summary(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    days = int(a.get("days") or 30)
    since = datetime.now(UTC) - timedelta(days=days)
    rows = (await ctx.db.execute(select(FinanceEntry).where(FinanceEntry.user_id == ctx.user_id))).scalars().all()
    by_cat: dict[str, float] = defaultdict(float)
    income = expense = 0.0
    for e in rows:
        if e.occurred_on and e.occurred_on >= since:
            if e.kind == "income":
                income += e.amount
            elif e.kind in ("expense", "bill"):
                expense += e.amount
                by_cat[e.category] += e.amount
    subs = [e for e in rows if e.kind == "subscription" and e.active]
    monthly_subs = sum(e.amount * {"yearly": 1 / 12, "weekly": 4.33}.get(e.recurrence or "monthly", 1) for e in subs)
    upcoming = sorted([e for e in rows if e.kind == "bill" and e.due_on and e.due_on >= datetime.now(UTC)],
                      key=lambda e: e.due_on)[:10]
    lines = [f"Window: last {days} days", f"Income: {income:.2f}", f"Spending: {expense:.2f}",
             f"Net: {income - expense:.2f}", "By category:"]
    lines += [f"  - {c}: {v:.2f}" for c, v in sorted(by_cat.items(), key=lambda x: -x[1])]
    lines.append(f"Active subscriptions: {len(subs)} (~{monthly_subs:.2f}/month)")
    lines += [f"  - {s.description or s.category}: {s.amount} {s.currency} {s.recurrence or 'monthly'}" for s in subs]
    lines.append("Upcoming bills:")
    lines += [f"  - {b.due_on.date()}: {b.description} {b.amount} {b.currency}" for b in upcoming]
    if not rows:
        lines.append("(Ledger is empty — the user needs to add entries or import statements.)")
    return ToolResult("\n".join(lines), {"income": income, "expense": expense, "by_category": dict(by_cat),
                                         "monthly_subscriptions": monthly_subs})
