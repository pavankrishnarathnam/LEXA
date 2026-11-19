"""Turns the vendored scripts' console output into text that is right for LEXA.

The scripts were written for a Claude Code skill pack that also contains a broker script. Their messages point
at slash commands ("/trader-exit") and at that broker ("trader-broker asks you yes or no"). LEXA has its own
tool names and no broker at all, so the hints are rewritten or dropped here. Everything else is passed through
untouched: numbers, tables and warnings are never edited.
"""
from __future__ import annotations

import re

# Upstream skill name -> LEXA tool name.
_TOOL_NAMES = {
    "trader-scanner": "trader_scan", "trader-news": "trader_news", "trader-analyst": "trader_earnings",
    "trader-pelosi": "trader_congress_trades", "trader-entry": "trader_entry", "trader-exit": "trader_exit_plan",
    "trader-timemachine": "trader_simulate", "trader-budget": "trader_size", "trader-risk": "trader_risk_check",
    "trader-alerts": "trader_alerts",
}
_SKILL = re.compile(r"/?\b(trader-(?:scanner|news|analyst|pelosi|entry|exit|timemachine|budget|risk|alerts))\b")
# A navigation hint ("Next: ... /trader-news TICKER ...") at the end of a line. Only lines whose hint names a
# skill or a script are cut, so a headline that happens to contain "Next:" is never touched.
_NEXT_HINT = re.compile(r"\s*\bNext:[^\n]*(?:trader-|\.py\b)[^\n]*$")
_BROKER_ASIDE = re.compile(r"\s*\([^()]*trader-broker[^()]*\)")
_TICKET_ASIDE = re.compile(r"\s*\(ticket\.py[^)]*\)")
_FLATTEN = re.compile(r"close it: trader-broker flatten --symbol \S+ builds the sell ticket, then trader-risk and "
                      r"your yes\.")
_SEC_ENV = re.compile(r"(?<![A-Z_])SEC_USER_AGENT")
_ALERT_LOOP = re.compile(r"Run alerts\.py check every few minutes while the trade is open \(a scheduled task or /loop\)\.")

_NO_BROKER = "LEXA does not place or close trades: that is always your own decision, made at your broker."


def clean_output(text: str) -> str:
    out: list[str] = []
    for line in text.splitlines():
        if line.startswith("An alert is information, not an order."):
            out.append(f"An alert is information, not an order. {_NO_BROKER}")
            continue
        if line.startswith("Every order passed.") and "trader-broker" in line:
            out.append("Every order passed the rules check. A PASS is not a recommendation, and LEXA places no orders.")
            continue
        line = _NEXT_HINT.sub("", line)
        line = _ALERT_LOOP.sub("Run trader_alerts (action check) every few minutes while the trade is open, for "
                               "example from a LEXA automation.", line)
        line = _FLATTEN.sub("close it at your broker.", line)
        line = _BROKER_ASIDE.sub("", line)
        line = _TICKET_ASIDE.sub("", line)
        line = line.replace("(place_stock_order arguments, nothing has been placed)",
                            "(nothing has been placed; LEXA never places orders)")
        if "trader-broker" in line or "ticket.py" in line:
            continue
        line = _SKILL.sub(lambda m: _TOOL_NAMES[m.group(1)], line)
        line = _SEC_ENV.sub("TRADER_SEC_USER_AGENT", line)
        if line.strip() or (out and out[-1].strip()):  # no runs of blank lines left behind by dropped hints
            out.append(line)
    return "\n".join(out).strip("\n")


def tail(text: str, lines: int = 6, width: int = 300) -> str:
    """The last few non-empty lines (for a failure message)."""
    keep = [ln.strip()[:width] for ln in text.splitlines() if ln.strip()]
    return " | ".join(keep[-lines:])


def trim(text: str, limit: int = 16000) -> str:
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + f"\n[... {len(text) - limit} more characters not shown]"
