"""The user's trading rules, kept per user as ``trader/config.json`` for the vendored scripts.

Only values the user gave are stored. The scripts apply their own documented defaults to everything else
(:func:`upstream_defaults` reads them from the vendored code, so they cannot drift). Four safety flags are fixed
and cannot be changed through LEXA: paper mode on, and no options, margin or short selling. ``sec_user_agent`` is
never written here; it comes from the ``TRADER_SEC_USER_AGENT`` setting.
"""
from __future__ import annotations

import ast
import contextlib
import json
import math
import os
import re
import tempfile
from collections.abc import Callable, Iterable, Mapping
from functools import lru_cache
from pathlib import Path
from typing import Any

from trading.runner import VENDOR_DIR, ArgError, TraderError, ticker

FIXED: dict[str, Any] = {"paper": True, "allow_options": False, "allow_margin": False, "allow_short": False}
# Without these two LEXA will not size a trade or run the risk check: they are the user's decisions, and a
# silent default (the scripts' example is $5,000 and $50) would be someone else's.
REQUIRED_FOR_SIZING = ("budget", "max_loss_per_trade_usd")


class RuleError(TraderError):
    """A rule value the user can fix."""


def _num(name: str, lo: float, hi: float, *, integer: bool = False) -> Callable[[Any], Any]:
    def parse(v: Any) -> Any:
        if isinstance(v, bool) or not isinstance(v, (int, float, str)):
            raise RuleError(f"{name}: expected a number")
        try:
            x = float(v)
        except ValueError:
            raise RuleError(f"{name}: expected a number") from None
        if not math.isfinite(x) or not lo <= x <= hi:
            raise RuleError(f"{name}: must be between {lo:g} and {hi:g}")
        if integer:
            if x != int(x):
                raise RuleError(f"{name}: must be a whole number")
            return int(x)
        return round(x, 4)

    return parse


def _bool(name: str) -> Callable[[Any], Any]:
    def parse(v: Any) -> Any:
        if isinstance(v, bool):
            return v
        if isinstance(v, str) and v.strip().lower() in ("true", "false"):
            return v.strip().lower() == "true"
        raise RuleError(f"{name}: must be true or false")

    return parse


def _time(name: str) -> Callable[[Any], Any]:
    def parse(v: Any) -> Any:
        s = str(v).strip()
        m = re.fullmatch(r"([01]?\d|2[0-3]):([0-5]\d)", s)
        if not m:
            raise RuleError(f"{name}: use HH:MM, New York time")
        minutes = int(m.group(1)) * 60 + int(m.group(2))
        if not 9 * 60 + 30 <= minutes <= 16 * 60:
            raise RuleError(f"{name}: must be inside market hours (09:30 to 16:00 New York time)")
        return f"{minutes // 60:02d}:{minutes % 60:02d}"

    return parse


def _tickers(name: str) -> Callable[[Any], Any]:
    def parse(v: Any) -> Any:
        items = v.split(",") if isinstance(v, str) else v
        if not isinstance(items, (list, tuple)) or len(items) > 100:
            raise RuleError(f"{name}: give up to 100 tickers")
        out: list[str] = []
        for item in items:
            if not str(item).strip():
                continue
            try:
                t = ticker(item)
            except ArgError as exc:
                raise RuleError(f"{name}: {exc}") from None
            if t not in out:
                out.append(t)
        return out

    return parse


# name -> (parser, meaning). The meaning is shown to the model and the user.
RULES: dict[str, tuple[Callable[[Any], Any], str]] = {
    "budget": (_num("budget", 1, 1e9), "money set aside for trading, in dollars"),
    "max_loss_per_trade_usd": (_num("max_loss_per_trade_usd", 1, 1e8),
                               "the most you accept to lose on one trade if the stop is hit, in dollars"),
    "max_daily_loss_usd": (_num("max_daily_loss_usd", 1, 1e8), "the most you accept to lose in one day, in dollars"),
    "max_position_pct": (_num("max_position_pct", 1, 100), "largest share of the account in one stock, in percent"),
    "cash_buffer_pct": (_num("cash_buffer_pct", 0, 90), "share of the account always kept in cash, in percent"),
    "max_order_usd": (_num("max_order_usd", 1, 1e9), "largest single order, in dollars"),
    "min_order_usd": (_num("min_order_usd", 0, 1e6), "smallest single order, in dollars"),
    "max_trades_per_day": (_num("max_trades_per_day", 1, 50, integer=True), "new trades allowed per day"),
    "max_orders_per_day": (_num("max_orders_per_day", 1, 200, integer=True), "orders allowed per day"),
    "min_reward_risk": (_num("min_reward_risk", 0, 20), "smallest reward-to-risk ratio (1 = target as far as the stop)"),
    "no_entries_before": (_time("no_entries_before"), "no new entries before this New York time (HH:MM)"),
    "no_entries_after": (_time("no_entries_after"), "no new entries after this New York time (HH:MM)"),
    "flat_by": (_time("flat_by"), "plan to be out of the trade by this New York time (HH:MM)"),
    "blocked": (_tickers("blocked"), "tickers you never want to trade"),
    "pdt_guard": (_bool("pdt_guard"), "apply the old pattern day trader limit (3 day trades in 5 business days)"),
}


@lru_cache
def upstream_defaults() -> dict[str, Any]:
    """The defaults the vendored risk checker applies, read from its source (never imported or run)."""
    tree = ast.parse((VENDOR_DIR / "check.py").read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "DEFAULTS" for t in node.targets):
            value = ast.literal_eval(node.value)
            if isinstance(value, dict):
                return value
    raise TraderError("The risk checker's defaults could not be read; the vendored scripts look damaged.")


def _config_path(workdir: Path) -> Path:
    return workdir / "trader" / "config.json"


def load_rules(workdir: Path) -> dict[str, Any] | None:
    """The rules the user has set, or None if they have set none."""
    path = _config_path(workdir)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        raise TraderError("Your trading rules file is unreadable. Set your rules again.") from None
    if not isinstance(raw, dict):
        raise TraderError("Your trading rules file is unreadable. Set your rules again.")
    return {k: raw[k] for k in RULES if k in raw}


def validate_rules(updates: Mapping[str, Any]) -> dict[str, Any]:
    """Parse the given rule values; unknown names are an error, so a typo is never silently dropped."""
    out: dict[str, Any] = {}
    problems: list[str] = []
    for name, value in updates.items():
        if name not in RULES:
            problems.append(f"{name}: not a rule I can set (known rules: {', '.join(RULES)})")
            continue
        try:
            out[name] = RULES[name][0](value)
        except RuleError as exc:
            problems.append(str(exc))
    if problems:
        raise RuleError("; ".join(problems))
    return out


def _check_together(rules: Mapping[str, Any]) -> None:
    eff = {**{k: v for k, v in upstream_defaults().items() if v is not None}, **rules}
    problems: list[str] = []
    def shown(name: str) -> str:
        return f"{name} ({eff[name]:g}{'' if name in rules else ', the default'})"

    if "budget" in rules and "max_loss_per_trade_usd" in rules and rules["max_loss_per_trade_usd"] > rules["budget"]:
        problems.append("max_loss_per_trade_usd cannot be more than the budget")
    if eff["max_daily_loss_usd"] < eff["max_loss_per_trade_usd"]:
        problems.append(f"{shown('max_daily_loss_usd')} cannot be less than {shown('max_loss_per_trade_usd')}: "
                        "no trade could ever pass")
    if eff["min_order_usd"] > eff["max_order_usd"]:
        problems.append(f"{shown('min_order_usd')} cannot be more than {shown('max_order_usd')}")
    if not eff["no_entries_before"] < eff["no_entries_after"] <= eff["flat_by"]:
        problems.append("times must run in order: no_entries_before, then no_entries_after, then flat_by")
    if problems:
        raise RuleError("; ".join(problems))


def _write_json(path: Path, data: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".config-", suffix=".tmp")  # created 0600
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def save_rules(workdir: Path, updates: Mapping[str, Any], reset: Iterable[str] = ()) -> dict[str, Any]:
    """Merge validated ``updates`` into the stored rules, drop the names in ``reset`` (back to the default) and
    write ``trader/config.json``. Returns the rules now stored. Nothing is written if anything is invalid."""
    reset = list(reset)
    unknown = [r for r in reset if r not in RULES]
    if unknown:
        raise RuleError(f"cannot reset unknown rules: {', '.join(unknown)}")
    merged = {**(load_rules(workdir) or {}), **validate_rules(updates)}
    for name in reset:
        merged.pop(name, None)
    _check_together(merged)
    _write_json(_config_path(workdir), {**merged, **FIXED})
    return merged


def describe(rules: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    """Every rule with its effective value and whether the user set it or the default applies."""
    rules = rules or {}
    defaults = upstream_defaults()
    return [{"rule": name, "value": rules[name] if name in rules else defaults.get(name),
             "source": "set by you" if name in rules else "default", "meaning": meaning}
            for name, (_, meaning) in RULES.items()]


def missing_for_sizing(rules: Mapping[str, Any] | None) -> list[str]:
    return [r for r in REQUIRED_FOR_SIZING if r not in (rules or {})]
