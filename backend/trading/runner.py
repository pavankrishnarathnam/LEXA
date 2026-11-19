"""Safe execution of the vendored Day Trader scripts (analysis only).

The scripts in ``trading/vendor`` are third-party code. They are never imported into the LEXA process. Every
call goes through :func:`run_script`, which

* runs exactly one allow-listed script with ``python -I`` in a child process of its own (new session, so the
  whole process group can be killed),
* gives it a minimal environment: no database URL, API key, JWT secret or encryption key,
* runs it inside a per-user workspace, so the scripts' relative ``trader/*.json`` files are isolated per user,
* builds the command line only from :data:`SPECS` (flag names and value shapes, never a path or a URL),
* applies CPU, memory and file-size limits, a wall-clock timeout and an output cap.

No script that can send an order (``trader-broker``) is vendored, and none can be added here by accident:
:data:`SPECS` is the complete list of what may run.
"""
from __future__ import annotations

import asyncio
import contextlib
import math
import os
import re
import signal
import sys
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

from core.config import settings

VENDOR_DIR = Path(__file__).resolve().parent / "vendor"

DEFAULT_TIMEOUT = 90.0          # seconds of wall clock per script run (callers pass more for market-wide scans)
MAX_STDOUT = 1_000_000          # bytes kept from stdout; a script that prints more is killed
MAX_STDERR = 100_000
MAX_PARALLEL = 4                # scripts running at the same time in this process (all users)
MEMORY_LIMIT = 2 * 1024**3      # address space per script (bytes)
FILE_LIMIT = 64 * 1024**2       # largest single file a script may write (bytes)

# Environment variables that are passed through to the child. Nothing else is: LEXA's own settings
# (DATABASE_URL, OPENAI_API_KEY, JWT_SECRET, ENCRYPTION_KEY, ...) never reach the scripts.
_PASSTHROUGH_ENV = ("PATH", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
                    "SSL_CERT_FILE", "SSL_CERT_DIR")
_SEC_PLACEHOLDER = "you@example.com"


class TraderError(Exception):
    """A problem the user can act on (the message is safe to show)."""


class ArgError(TraderError):
    """An argument that is not on the allow-list."""


# ---------------------------------------------------------------- value checks

Check = Callable[[Any], str]


def _text(v: Any, what: str) -> str:
    if isinstance(v, bool) or not isinstance(v, (str, int, float)):
        raise ArgError(f"{what}: expected a plain value")
    s = str(v).strip()
    if not s or len(s) > 200 or any(ord(c) < 32 or ord(c) == 127 for c in s):
        raise ArgError(f"{what}: unexpected value")
    return s


def _rx(what: str, pattern: str, *, upper: bool = False) -> Check:
    rx = re.compile(pattern)

    def check(v: Any) -> str:
        s = _text(v, what)
        if upper:
            s = s.upper()
        if not rx.fullmatch(s):
            raise ArgError(f"{what}: {s[:40]!r} is not an accepted value")
        return s

    return check


def _number(what: str, lo: float, hi: float, *, integer: bool = False) -> Check:
    def check(v: Any) -> str:
        if isinstance(v, bool):
            raise ArgError(f"{what}: expected a number")
        try:
            x = float(v)
        except (TypeError, ValueError):
            raise ArgError(f"{what}: expected a number") from None
        if not math.isfinite(x) or not lo <= x <= hi:
            raise ArgError(f"{what}: must be between {lo:g} and {hi:g}")
        if integer:
            if x != int(x):
                raise ArgError(f"{what}: must be a whole number")
            return str(int(x))
        return format(x, ".10g")

    return check


def _choice(what: str, *options: str) -> Check:
    def check(v: Any) -> str:
        s = _text(v, what)
        if s not in options:
            raise ArgError(f"{what}: must be one of {', '.join(options)}")
        return s

    return check


_TICKER_RX = re.compile(r"[A-Z]{1,5}([.\-][A-Z]{1,2})?")


def ticker(v: Any) -> str:
    """One US ticker, upper-cased: TSLA, BRK.B or BRK-B."""
    s = _text(v, "ticker").upper()
    if not _TICKER_RX.fullmatch(s):
        raise ArgError(f"ticker: {s[:20]!r} is not a US stock ticker")
    return s


def tickers_csv(limit: int) -> Check:
    """A comma-separated list (or a list) of tickers: TSLA,NVDA."""

    def check(v: Any) -> str:
        items = [p for p in (v.split(",") if isinstance(v, str) else list(v)) if str(p).strip()]
        if not items or len(items) > limit:
            raise ArgError(f"tickers: give between 1 and {limit}")
        seen: list[str] = []
        for item in items:
            t = ticker(item)
            if t not in seen:
                seen.append(t)
        return ",".join(seen)

    return check


def _iso_date(v: Any) -> str:
    s = _text(v, "date")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        raise ArgError("date: use YYYY-MM-DD")
    try:
        d = date.fromisoformat(s)
    except ValueError:
        raise ArgError("date: not a real date") from None
    if not 2000 <= d.year <= 2100:
        raise ArgError("date: year out of range")
    return s


HHMM = _rx("time", r"([01]\d|2[0-3]):[0-5]\d")
CLOCK_AMPM = _rx("time", r"(1[0-2]|0?[1-9]):[0-5]\d ?[AaPp][Mm]")
INTERVAL = _choice("interval", "5m", "1m")
SETUP = _choice("setup", "orb", "level")
SOURCE = _choice("source", "yahoo", "stooq")
STOP_RULE = _choice("stop rule", "auto", "or_mid", "or_low", "or_high", "pct")
STOP_SPEC = _rx("stop", r"(or-mid|or-low|price:\d{1,7}(\.\d{1,4})?|pct:\d{1,2}(\.\d{1,3})?|atr:\d{1,2}(\.\d{1,3})?)")
TARGET_SPEC = _rx("target", r"(\d{1,2}(\.\d{1,2})?R|price:\d{1,7}(\.\d{1,4})?)")
MEMBER = _rx("member", r"[A-Za-z][A-Za-z .,'\-]{1,59}")
DOC_ID = _rx("document id", r"\d{6,10}")
ALERT_ID = _rx("alert id", r"[A-Za-z0-9][A-Za-z0-9_\-]{0,39}")
SHORT_TEXT = _rx("text", r"[A-Za-z0-9][A-Za-z0-9 .,:;!?()'%$+\-]{0,79}")
SEC_FORMS = _rx("forms", r"[0-9A-Za-z][0-9A-Za-z\-]{0,9}(,[0-9A-Za-z][0-9A-Za-z\-]{0,9}){0,5}")
PRICE = _number("price", 0.0001, 10_000_000)
PERCENT = _number("percent", 0.01, 100)


# ---------------------------------------------------------------- allow-list

@dataclass(frozen=True)
class FlagSpec:
    check: Check | None = None   # None: a switch that takes no value
    multi: bool = False          # one flag followed by several values (--tickers A B C)
    repeat: bool = False         # the flag may be given several times (--member X --member Y)


@dataclass(frozen=True)
class CmdSpec:
    positionals: tuple[Check, ...] = ()
    variadic: Check | None = None
    max_variadic: int = 0
    flags: Mapping[str, FlagSpec] = field(default_factory=dict)


SWITCH = FlagSpec()


def _value(check: Check) -> FlagSpec:
    return FlagSpec(check)


def _many(check: Check) -> FlagSpec:
    return FlagSpec(check, multi=True)


def _repeat(check: Check) -> FlagSpec:
    return FlagSpec(check, repeat=True)


_JSON = {"--json": SWITCH}
_SCAN_COMMON: dict[str, FlagSpec] = {
    "--symbols": _value(tickers_csv(300)),
    "--min-price": _value(_number("min price", 0, 1_000_000)),
    "--min-volume": _value(_number("min volume", 0, 10**11, integer=True)),
    "--show": _value(_number("show", 1, 200, integer=True)),
    "--no-write": SWITCH, "--quiet": SWITCH, **_JSON,
}
_ENTRY_COMMON: dict[str, FlagSpec] = {
    "--setup": _value(SETUP),
    "--or-minutes": _value(_number("opening range minutes", 5, 60, integer=True)),
    "--interval": _value(INTERVAL),
    "--level": _value(PRICE),
    "--min-volume-x": _value(_number("volume multiple", 0.1, 100)),
    **_JSON,
}
_TIMEMACHINE_FLAGS: dict[str, FlagSpec] = {
    "--symbol": _value(ticker), "--date": _value(_iso_date),
    "--entry": _value(PRICE), "--stop": _value(PRICE), "--target": _value(PRICE),
    "--entry-time": _value(CLOCK_AMPM), "--setup": _value(_choice("setup", "orb", "level")),
    "--or-minutes": _value(_number("opening range minutes", 5, 60, integer=True)),
    "--stop-rule": _value(STOP_RULE),
    "--replays": _value(_number("replays", 100, 20_000, integer=True)),
    "--seed": _value(_number("seed", 0, 2**31 - 1, integer=True)),
    "--window": _value(_number("window", 0, 10, integer=True)),
    "--until": _value(HHMM), "--write": SWITCH, **_JSON,
}
_PTR_COMMON: dict[str, FlagSpec] = {
    "--year": _value(_number("year", 2012, 2100, integer=True)),
    "--member": _repeat(MEMBER), "--since": _value(_iso_date), **_JSON,
}

# Flags that take a file or folder path, a URL, a user agent or a pretend-clock (--config, --offline, --state,
# --plan, --out, --from, --now, ...) are deliberately absent: model-supplied text must never choose a path
# or an identity. A test pins that list.
SPECS: dict[str, dict[str | None, CmdSpec]] = {
    "scan.py": {
        "universe": CmdSpec(flags=dict(_JSON)),
        "daily": CmdSpec(flags=dict(_SCAN_COMMON)),
        "orb": CmdSpec(flags={
            **_SCAN_COMMON,
            "--or-minutes": _value(_number("opening range minutes", 5, 60, integer=True)),
            "--max-confirm": _value(_number("max confirm", 0, 1000, integer=True)),
            "--at": _value(HHMM), "--until": _value(HHMM)}),
    },
    "news.py": {None: CmdSpec(flags={
        "--tickers": _many(ticker), "--hours": _value(_number("hours", 1, 720)), "--all": SWITCH,
        "--forms": _value(SEC_FORMS), "--no-sec": SWITCH, "--no-moves": SWITCH,
        "--move-pct": _value(_number("move percent", 0.1, 100)), "--dry-run": SWITCH, **_JSON})},
    "facts.py": {None: CmdSpec(variadic=ticker, max_variadic=5, flags={
        "--quarters": _value(_number("quarters", 1, 12, integer=True)), "--no-filings": SWITCH, **_JSON})},
    "ptr.py": {
        "index": CmdSpec(flags={**_PTR_COMMON, "--limit": _value(_number("limit", 1, 200, integer=True))}),
        "new": CmdSpec(flags={**_PTR_COMMON, "--dry-run": SWITCH, "--read": SWITCH, "--tickers": _many(ticker)}),
        "fetch": CmdSpec(positionals=(DOC_ID,), flags={
            "--year": _value(_number("year", 2012, 2100, integer=True)), "--filed": _value(_iso_date),
            "--tickers": _many(ticker), **_JSON}),
    },
    "entry.py": {
        "check": CmdSpec(positionals=(ticker,), flags={**_ENTRY_COMMON, "--write": SWITCH}),
        "watchlist": CmdSpec(flags=dict(_ENTRY_COMMON)),
    },
    "exit.py": {
        "plan": CmdSpec(flags={
            "--symbol": _value(ticker), "--entry": _value(PRICE), "--or-high": _value(PRICE),
            "--or-low": _value(PRICE),
            "--or-minutes": _value(_number("opening range minutes", 5, 60, integer=True)),
            "--setup": _value(SETUP), "--date": _value(_iso_date), "--time": _value(CLOCK_AMPM),
            "--entry-bar": _value(_number("entry bar", 0, 400, integer=True)), "--interval": _value(INTERVAL),
            "--stop": _value(STOP_SPEC), "--target": _value(TARGET_SPEC), "--flat-by": _value(HHMM),
            "--write": SWITCH, **_JSON}),
        "show": CmdSpec(flags=dict(_JSON)),
    },
    "timemachine.py": {"run": CmdSpec(flags=dict(_TIMEMACHINE_FLAGS))},
    "size.py": {None: CmdSpec(flags={"--budget": _value(_number("budget", 1, 10**9)), "--write": SWITCH, **_JSON})},
    "check.py": {None: CmdSpec(flags={"--no-write": SWITCH, **_JSON})},
    "alerts.py": {
        "clock": CmdSpec(flags=dict(_JSON)),
        "quote": CmdSpec(variadic=ticker, max_variadic=20, flags={
            "--source": _value(SOURCE), "--holdings": SWITCH, "--write": SWITCH, **_JSON}),
        "check": CmdSpec(flags={"--source": _value(SOURCE), "--no-write": SWITCH, **_JSON}),
        "add": CmdSpec(flags={
            "--symbol": _value(ticker), "--above": _value(PRICE), "--below": _value(PRICE),
            "--stop": _value(PRICE), "--target": _value(PRICE), "--pct": _value(PERCENT),
            "--opening-bell": SWITCH, "--at": _value(HHMM), "--from-plan": SWITCH,
            "--label": _value(SHORT_TEXT), "--before-close": SWITCH, "--date": _value(_iso_date),
            "--direction": _value(_choice("direction", "up", "down")), "--rearm": SWITCH,
            "--note": _value(SHORT_TEXT), "--id": _value(ALERT_ID)}),
        "list": CmdSpec(),
    },
}


def build_argv(script: str, cmd: str | None = None, positionals: Sequence[Any] = (),
               flags: Mapping[str, Any] | None = None) -> list[str]:
    """Validate a call against :data:`SPECS` and return the script's arguments (without the script itself).

    ``flags`` maps a long option (``"--at"``) to its value: a string or number for a value flag, ``True`` for a
    switch, a list for a flag that takes several values. ``None`` and ``False`` mean "not given".
    """
    cmds = SPECS.get(script)
    if cmds is None:
        raise ArgError(f"{script!r} is not an allowed trading script")
    spec = cmds.get(cmd)
    if spec is None:
        raise ArgError(f"{script} has no allowed command {cmd!r}")
    label = f"{script} {cmd}" if cmd else script
    positionals = list(positionals)
    if len(positionals) < len(spec.positionals) or len(positionals) > len(spec.positionals) + spec.max_variadic:
        raise ArgError(f"{label}: wrong number of arguments")
    argv: list[str] = [cmd] if cmd else []
    for check, value in zip(spec.positionals, positionals, strict=False):
        argv.append(check(value))
    extra = positionals[len(spec.positionals):]
    if extra:
        assert spec.variadic is not None  # noqa: S101 - guarded by the count check above
        argv.extend(spec.variadic(v) for v in extra)
    for name, value in (flags or {}).items():
        fs = spec.flags.get(name)
        if fs is None:
            raise ArgError(f"{name} is not an allowed option for {label}")
        if value is None or value is False:
            continue
        if fs.check is None:
            if value is not True:
                raise ArgError(f"{name} takes no value")
            argv.append(name)
        elif fs.multi or fs.repeat:
            items = [value] if isinstance(value, (str, int, float)) and not isinstance(value, bool) else list(value)
            if not items:
                continue
            if len(items) > 50:
                raise ArgError(f"{name}: too many values")
            if fs.multi:
                argv.append(name)
                argv.extend(fs.check(i) for i in items)
            else:
                for i in items:
                    argv.extend((name, fs.check(i)))
        else:
            argv.extend((name, fs.check(value)))
    return argv


# Test hook. Always empty in production: tests add ("--offline", fixture, "--now", ...) here so the scripts run
# on saved data without a network. No tool or request can reach it.
_TRUSTED_EXTRA_ARGS: dict[str, tuple[str, ...]] = {}


# ---------------------------------------------------------------- workspace and environment

def workspace(user_id: uuid.UUID | str, data_dir: str | os.PathLike[str] | None = None) -> Path:
    """The user's private folder; the scripts run inside it and keep their state under ``trader/``."""
    try:
        uid = str(uuid.UUID(str(user_id)))
    except ValueError:
        raise TraderError("invalid user id") from None
    base = Path(data_dir or settings.trader_data_dir).expanduser()
    root = base / uid
    try:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)  # private to the server's user
        for sub in ("trader", "trader/state"):  # one level at a time: `parents=True` ignores `mode` for parents
            (root / sub).mkdir(exist_ok=True, mode=0o700)
    except OSError as exc:
        raise TraderError(f"Cannot create the trading workspace in {base} ({exc.strerror}). "
                          "Set TRADER_DATA_DIR to a writable folder.") from exc
    return root.resolve()


def sec_identity_ok(value: str | None) -> bool:
    """SEC EDGAR asks every client to identify itself ("Name name@example.org"); it must be a real one."""
    if not value or "@" not in value or _SEC_PLACEHOLDER in value or len(value) > 200:
        return False
    return not any(ord(c) < 32 or ord(c) == 127 for c in value)


def build_env(workdir: Path, sec_user_agent: str | None = None) -> dict[str, str]:
    env = {k: os.environ[k] for k in _PASSTHROUGH_ENV if k in os.environ}
    env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    env.update({"HOME": str(workdir), "LANG": "C.UTF-8", "TZ": "UTC"})
    if sec_identity_ok(sec_user_agent):
        env["SEC_USER_AGENT"] = str(sec_user_agent).strip()
    return env


# ---------------------------------------------------------------- running

# Runs inside the child before the vendored script: limits first, then the script exactly as `python script.py`.
# Arguments: cpu seconds, address space, largest file, script path, then the script's own arguments.
_BOOTSTRAP = """
import runpy, sys
try:
    import resource
except ImportError:
    resource = None
cpu, mem, fsize, script = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
if resource is not None:
    for which, value in ((resource.RLIMIT_CPU, cpu), (resource.RLIMIT_AS, mem), (resource.RLIMIT_FSIZE, fsize),
                         (resource.RLIMIT_NOFILE, 256), (resource.RLIMIT_CORE, 0)):
        try:
            resource.setrlimit(which, (value, value))
        except (ValueError, OSError):
            pass
sys.argv = sys.argv[4:]
runpy.run_path(script, run_name="__main__")
"""


@dataclass
class ScriptResult:
    exit_code: int | None
    stdout: str
    stderr: str
    timed_out: bool
    truncated: bool
    seconds: float
    argv: list[str]

    @property
    def crashed(self) -> bool:
        """The script did not finish normally. Exit code 1 is NOT a crash by itself: several scripts use it for
        a normal answer ("market closed", "nothing found", "nothing new"). A crash is a timeout, a kill, a usage
        error (2 or more) or an uncaught Python exception."""
        return (self.timed_out or self.exit_code is None or self.exit_code < 0 or self.exit_code >= 2
                or "Traceback (most recent call last)" in self.stderr)


class _Capture:
    def __init__(self, cap: int) -> None:
        self.cap, self.size, self.truncated = cap, 0, False
        self.chunks: list[bytes] = []

    def add(self, data: bytes) -> bool:
        room = self.cap - self.size
        if room > 0:
            self.chunks.append(data[:room])
        self.size += len(data)
        if self.size > self.cap:
            self.truncated = True
            return False
        return True

    def text(self) -> str:
        return b"".join(self.chunks).decode("utf-8", errors="replace")


def _kill(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is None:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGKILL)  # pid == pgid: the child leads its own session


async def _pump(stream: asyncio.StreamReader, cap: _Capture, proc: asyncio.subprocess.Process) -> None:
    while chunk := await stream.read(65536):
        if not cap.add(chunk):
            _kill(proc)  # runaway output
            return


_LOCKS: dict[tuple[str, str], asyncio.Lock] = {}
_SEMAPHORE: asyncio.Semaphore | None = None


def _semaphore() -> asyncio.Semaphore:
    global _SEMAPHORE
    if _SEMAPHORE is None:
        _SEMAPHORE = asyncio.Semaphore(MAX_PARALLEL)
    return _SEMAPHORE


async def run_script(user_id: uuid.UUID | str, script: str, cmd: str | None = None,
                     positionals: Sequence[Any] = (), flags: Mapping[str, Any] | None = None, *,
                     time_limit: float = DEFAULT_TIMEOUT, sec_user_agent: str | None = None,
                     data_dir: str | os.PathLike[str] | None = None) -> ScriptResult:
    """Run one allow-listed script for one user and return what it printed. Never raises for a script failure
    (check ``ok``); raises :class:`ArgError` for a disallowed call and :class:`TraderError` for a broken setup."""
    argv = build_argv(script, cmd, positionals, flags)
    argv += _TRUSTED_EXTRA_ARGS.get(f"{script}:{cmd or ''}", ()) + _TRUSTED_EXTRA_ARGS.get(script, ())
    script_path = VENDOR_DIR / script
    if not script_path.is_file():
        raise TraderError("The trading scripts are missing from this install.")
    workdir = workspace(user_id, data_dir)
    ua = settings.trader_sec_user_agent if sec_user_agent is None else sec_user_agent
    env = build_env(workdir, ua)
    cmdline = [sys.executable, "-I", "-B", "-X", "utf8", "-c", _BOOTSTRAP,
               str(int(time_limit) + 15), str(MEMORY_LIMIT), str(FILE_LIMIT), str(script_path), *argv]
    # One run per user and script at a time: the scripts keep their state in plain files.
    lock = _LOCKS.setdefault((str(workdir), script), asyncio.Lock())
    async with lock, _semaphore():
        started = time.monotonic()
        proc = await asyncio.create_subprocess_exec(
            *cmdline, cwd=workdir, env=env, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True)
        assert proc.stdout is not None and proc.stderr is not None  # noqa: S101 - PIPE was requested
        out, err = _Capture(MAX_STDOUT), _Capture(MAX_STDERR)
        timed_out = False
        try:
            await asyncio.wait_for(asyncio.gather(_pump(proc.stdout, out, proc), _pump(proc.stderr, err, proc),
                                                  proc.wait()), time_limit)
        except TimeoutError:
            timed_out = True
        finally:
            _kill(proc)  # also on cancellation: nothing is left running
            with contextlib.suppress(Exception):
                await asyncio.wait_for(proc.wait(), 5)
    return ScriptResult(exit_code=proc.returncode, stdout=out.text(), stderr=err.text(), timed_out=timed_out,
                        truncated=out.truncated or err.truncated, seconds=round(time.monotonic() - started, 2),
                        argv=[script, *argv])
