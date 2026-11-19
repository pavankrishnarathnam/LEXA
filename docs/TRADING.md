# Trading with LEXA (US stocks, analysis only)

LEXA can look for, plan and check day trades in **US stocks**. It scans charts, reads news, earnings and congress
filings, times an entry, sets the stop and target *before* you get in, replays the plan 10,000 times against the
stock's own history, sizes it to **your** limits and checks it against **your** rules. There are two ways in:

- **The Trading desk** (sidebar, *Trading*): buttons and forms. **It needs no AI key.** Nothing on that page calls an AI
  model, so it costs nothing and works with no OpenAI credits.
- **The Trader agent** (ask in the Assistant, in plain words or by voice): the same tools, driven by an AI model, so it
  needs a working AI key.

**LEXA never places an order.** There is no broker connection, no order tool and no broker script in the code. You
make every trade yourself, at your own broker. This is education and analysis, not financial advice, and most people
who day trade lose money; a scan, a setup or a simulation does not change that.

## What it covers, and what it does not

| | |
|---|---|
| Covered | US common stocks and ADRs listed on NYSE or Nasdaq, long side only, New York market hours (NYSE calendar for 2026 and 2027 with holidays and early closes) |
| Not covered | India (NSE/BSE) and every other market, options, futures, crypto, forex, short selling, margin, order placement |
| Data | Free and unofficial: Yahoo Finance charts and headlines (can lag by minutes), Nasdaq Trader symbol lists, SEC EDGAR, the House Clerk's public disclosures. The broker's price is the one that fills |

## Using it

### The Trading desk (no AI key needed)

Open **Trading** in the sidebar. It has four tabs, each analysis a form with a button:

| Tab | What is there |
|---|---|
| Find setups | Scan for setups (daily closes or opening-range breakouts; a list of tickers is fast, an empty list scans the whole US market in minutes) · Quotes |
| Research | News and SEC filings · Earnings check · Congress trades |
| Plan a trade | Six steps in order: has it triggered, stop and target, replay the odds, how many shares, check against my rules, alerts |
| My rules | Your limits and your SEC contact |

Results are plain text you can copy, with links only to Yahoo Finance, SEC and House Clerk pages. A long scan runs in
the background: you can leave the page, the last result of each analysis is still there when you come back (for 24
hours), and **Stop** ends one that is running. The market state at the top works from the built-in NYSE calendar, so
it needs no network.

### Asking the Trader agent

Ask LEXA in plain words; the planner hands trading requests to the Trader agent (this needs an AI key).

- *"Is the market open?"* · *"Scan TSLA, NVDA and AMD for opening-range breakouts"* · *"Scan the whole market for
  oversold stocks"* (takes several minutes)
- *"Any news on TSLA? Why is it moving?"* · *"How did Apple's earnings look?"* · *"What has Pelosi filed this year?"*
- *"Has TSLA broken its opening range?"* → *"Set my stop and target"* → *"Run the time machine on it"* →
  *"How many shares fit my limits?"* → *"Check it against my rules"* → *"Alert me at the stop and the target"*

### Your rules

The budget and the most you accept to lose on one trade are **your** decisions, so sizing and the risk check refuse
until you have set them; there is no silent default. On the desk, fill them in under **My rules**: that saves
directly, because you are the one acting (it is written to the audit log). If you ask the Trader agent instead, say for
example *"My budget is $5,000 and I can lose $50 on one trade"*: it calls `trader_set_rules`, which always waits for
your approval (and is refused in the Read & analyze permission mode). That is what stops a headline, a filing or a web
page from ever loosening a limit.

| Rule | Default if you do not set it |
|---|---|
| `budget`, `max_loss_per_trade_usd` | none: you must set both |
| `max_daily_loss_usd` | 150 |
| `max_position_pct` / `cash_buffer_pct` | 75 / 10 |
| `max_order_usd` / `min_order_usd` | 4000 / 5 |
| `max_trades_per_day` / `max_orders_per_day` | 3 / 10 |
| `min_reward_risk` | 1.0 |
| `no_entries_before` / `no_entries_after` / `flat_by` | 09:45 / 15:30 / 15:55 (New York) |
| `blocked` (tickers) · `pdt_guard` | none · off |

The defaults are read from the vendored risk checker, so they cannot drift from what it applies. Fixed and not
changeable through LEXA: paper mode on, no options, no margin, no short selling. Ask *"show my trading rules"* to
see every value and whether you set it.

### Tools

Each tool is one analysis on the desk and one tool for the agent; `trader_set_rules` is the only one the desk does not
start (it has its own form).

| Tool | Does |
|---|---|
| `trader_market_status` | Is NYSE open, today's session, next open |
| `trader_quote` | Delayed quotes for up to 20 tickers |
| `trader_scan` | `daily` setups from daily closes, or `orb` opening-range breakouts; a list of tickers is fast, no list scans the whole US universe (about 5,900 stocks, 2 to 6 minutes) |
| `trader_news` | Headlines and SEC 8-K filings, tagged, with each stock's move from yesterday's close |
| `trader_earnings` | Reported revenue, margins and EPS by quarter from SEC EDGAR |
| `trader_congress_trades` | House periodic transaction reports (public, up to 45 days late, amounts are ranges) |
| `trader_entry` | Opening-range breakout (or a level) timed bar by bar: waiting, triggered, expired |
| `trader_exit_plan` | Stop (opening-range midpoint by default) and target (2R by default), set before the entry |
| `trader_simulate` | 10,000 replays plus the real history of the same rule; one honest verdict; it is not a prediction |
| `trader_size` | Whole shares that fit your limits, which limit decided, a *proposed* bracket order |
| `trader_risk_check` | PASS or BLOCK against your rules, with the reason |
| `trader_alerts` | Stop, target, price, percent-move and time alerts; ring once each |
| `trader_get_rules` / `trader_set_rules` | Show your rules / change them (needs your approval) |

Alerts only *report* when `check` runs. For automatic checks during market hours, ask the Operations agent for a
scheduled automation that runs `trader_alerts` with `check` and notifies you.

## Limits you should know about

- **LEXA cannot see trades you place elsewhere.** The risk check's daily counters (trades today, loss today) start at
  zero and it assumes no other positions. Count what you already did today yourself; the agent reminds you.
- Scans say a chart *matched a rule*, never "a buy". A setup is not a prediction.
- Simulations come from the stock's own last 60 days of 5-minute bars. Earnings, news and halts can do things those
  days never did.
- Congress filings are public disclosures made up to 45 days after the trade. They carry no inside information.
- Reading a filing's PDF rows needs `pdftotext` (the `poppler-utils` package) on the server. Without it you still get
  the list of filings and the PDF links.
- The NYSE holiday calendar in the scripts covers 2026 and 2027. Update the vendored scripts for later years.

## Setup

Nothing to install: the scripts are part of the image. Two optional settings (`.env`):

| Variable | What |
|---|---|
| `TRADER_SEC_USER_AGENT` | `"Your Name you@example.org"`. SEC EDGAR asks every client to identify itself. Set it to turn on SEC filings in `trader_news` and `trader_earnings` for everyone on the server; without it those parts are skipped and say so. Each user can instead enter their own name and email under **My rules**, which takes precedence. It is sent to sec.gov only. |
| `TRADER_DATA_DIR` | Where each user's workspace lives. Default `/data/trader` (a Docker volume in `docker-compose.yml`); `/home/vscode/lexa-data/trader` in a Codespace. |

In a Codespace, add `TRADER_SEC_USER_AGENT` as a Codespaces secret next to `OPENAI_API_KEY` (or put the line in
`~/lexa-data/secrets.env`) and restart LEXA with `bash .devcontainer/start.sh`; the workspace folder is
`~/lexa-data/trader` and survives a stopped codespace.

Each user's rules, plans, watchlist and alerts are small JSON files in `TRADER_DATA_DIR/<user-id>/trader/`. Deleting
that folder resets the user's trading state. Nothing else about you is sent anywhere: the requests go to Yahoo Finance,
Nasdaq Trader, SEC EDGAR and the House Clerk and carry tickers and dates, never your budget, rules or name (the SEC
contact identity above goes to sec.gov only).

## How it stays safe

| Risk | Control |
|---|---|
| An order being sent | There is no broker code at all. The upstream broker script is not vendored, a test fails if one appears, and no tool is `external`. |
| A prompt-injected argument (a headline telling the agent to run something, read a path, change a limit) | The model never writes a command line. `trading/runner.py` builds arguments only from an allow-list of flags and value shapes (a ticker, `HH:MM`, a bounded number); path, URL, identity and clock flags (`--config`, `--offline`, `--out`, `--now`, `--user-agent` ...) are not offered. Tests pin both lists. |
| Third-party code reaching LEXA's data or secrets | Each script runs in its own child process (`python -I`, new session, killed with its whole process group on timeout, cancellation or runaway output) with a stripped environment: no database URL, API key, JWT secret or encryption key. CPU, memory and file-size limits apply. It runs in the user's own folder, mode 0700. |
| One user seeing another's state | One workspace per user id; one run per user and script at a time. |
| Tampered or swapped scripts | `backend/trading/vendor/SHA256SUMS` pins every file; a test checks it, audits the code (standard library only, GET-only requests to a fixed list of public hosts, no `eval`/`exec`/`pickle`/sockets) and fails if a script is added. |
| Loosened limits | `trader_set_rules` is a `sensitive` tool: always an approval, never auto-approved by an autonomy rule, denied in Read & analyze mode. |
| Untrusted text steering the agent | Output from news, filings, scans and congress data is wrapped as `<untrusted_content>`, like emails and web pages. |
| A runaway scan | A per-tool time limit (up to 8 minutes for a market-wide scan), an output cap and at most four scripts at a time. |
| The desk being used to do more than analyse | `POST /api/trading/jobs` starts only the twelve read-only analyses (never `trader_set_rules`), validates their arguments, keeps three running per user and stores results in Redis under the user's own id, so another user's job id is simply "not found". Rules and the SEC contact have their own validated, audited endpoints; every write needs the session's CSRF token. |

## Updating the vendored scripts

The ten analysis scripts come from the open-source Day Trader skill pack (MIT) and are used unmodified; the source,
commit and licence are in `backend/trading/vendor/UPSTREAM.md`. To update: copy the new scripts over, update
`UPSTREAM.md`, regenerate the manifest (`cd backend/trading/vendor && sha256sum *.py LICENSE > SHA256SUMS`) and run
`pytest tests/test_trading.py`. The audit test fails on a non-standard-library or risky import, a request body or a new host, and the
`--help` test fails if an allow-listed flag was renamed upstream, so review a failure before changing a test.

## Not built

Placing orders, even on a paper account. If you want that later it would be a separate, explicit opt-in: a broker
connector behind a `sensitive` tool that is always approved one order at a time, paper only by default, with the risk
check as a hard gate. It is not part of this feature.
