# Vendored: Day Trader skill pack (analysis scripts only)

These ten scripts are copied **unmodified** from the open-source Day Trader skill pack:

- Source: https://github.com/Jakeschincariol/day-trader-skill
- Commit: `3d0f4ef6986f4984b7c6bd46f7ff4f87744c3abd`
- Commit date: 2026-10-20
- Licence: MIT (see `LICENSE` in this folder; copyright Jake Schincariol)

| Vendored file | Upstream path | What it does |
| --- | --- | --- |
| `scan.py` | `trader-scanner/scan.py` | Scans US charts for setups (daily and opening-range breakout) |
| `news.py` | `trader-news/news.py` | Yahoo headlines and SEC 8-K filings per ticker |
| `facts.py` | `trader-analyst/facts.py` | Reported numbers from SEC EDGAR (10-Q / 10-K / earnings 8-K) |
| `ptr.py` | `trader-pelosi/ptr.py` | Congress periodic transaction reports (House Clerk) |
| `entry.py` | `trader-entry/entry.py` | Opening-range entry timing, bar by bar |
| `exit.py` | `trader-exit/exit.py` | Stop and target planning |
| `timemachine.py` | `trader-timemachine/timemachine.py` | 10,000-replay simulation and history of a plan |
| `size.py` | `trader-budget/size.py` | Position sizing against the user's rules (writes an order *proposal* file only) |
| `check.py` | `trader-risk/check.py` | Risk check of a proposed order against the user's rules |
| `alerts.py` | `trader-alerts/alerts.py` | Price alerts, quotes and NYSE market hours |

## What is deliberately NOT vendored

`trader-broker/ticket.py` (the order executor) is **not** included. LEXA analyses and plans; it never sends an
order to a broker. `tests/test_trading.py` fails if a broker script ever appears in this folder.

## Rules for this folder

1. **Do not edit these files.** `SHA256SUMS` pins every file, and a test verifies it. To update, re-copy from a
   newer upstream commit, update this file and regenerate `SHA256SUMS` (`sha256sum *.py LICENSE > SHA256SUMS`).
2. The scripts are only ever run through `trading/runner.py`, which fixes the working directory, the environment,
   the arguments and the time limit. They are never imported into the LEXA process.
3. They are excluded from LEXA's ruff and mypy runs because they are third-party code.
