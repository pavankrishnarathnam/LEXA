# Run LEXA on GitHub (Codespaces)

LEXA runs entirely on GitHub, with no VPS, using **GitHub Codespaces**. The repository's dev container starts
PostgreSQL + pgvector, Redis, the API, the background worker and the web app.

## 1. Add your API key (once)
GitHub → **Settings** (your profile) → **Codespaces** → **Secrets** → *New secret*:
- `OPENAI_API_KEY`: your OpenAI API key from platform.openai.com (required). Under *Repository access* select
  `LEXA`. The API is billed per use, separately from a ChatGPT subscription; set a monthly limit in LEXA under
  Settings → AI & permissions, and in your OpenAI billing settings.
- Optional: `DEFAULT_MODEL` (default `gpt-5.1`), or `gpt-5-mini` for a cheaper setup.

## 2. Start LEXA
On the repository page: **Code → Codespaces → Create codespace on main**.

The first start takes about 3–5 minutes (it installs dependencies and builds the app). When it finishes, the
terminal prints a framed message:

```
 LEXA is ready and the address below was verified:
   https://<name>-3100.app.github.dev
```

That address has been **tested through GitHub's port forwarding before it is shown**, so it is the one to use.
Open it in a normal browser tab (not inside the editor's preview pane). Register your account; the first account
becomes the owner. To see the address again at any time: `bash .devcontainer/url.sh` (it also runs each time you
open the codespace).

The address is **private**: only your signed-in GitHub account can open it. Leave the port visibility as
*Private*.

> **Why the port may not be 3000:** GitHub's forwarding can answer `502 Bad Gateway` for one particular port even
> though the app is healthy. `start.sh` therefore tests the real forwarded address and, if it fails, moves LEXA to
> another port (3100 → 3101 → 3102 → 3000) until one works, then remembers it for the next start.

## "You have no credits remaining" (HTTP 429)
That message comes from OpenAI: the key works but the account balance is empty. The OpenAI API is prepaid and **billed
separately from a ChatGPT subscription** (a ChatGPT Plus plan does not include API credit). Add credits at
<https://platform.openai.com/settings/organization/billing> (a few dollars last a long time with `gpt-5-mini`; set
`DEFAULT_MODEL=gpt-5-mini` as a Codespaces secret to stretch them). Until then agents cannot answer, but voice commands
that only operate LEXA keep working, and in Chrome or Edge speech recognition is free (see [`VOICE.md`](VOICE.md)).

## Using LEXA by voice
Press **Alt + V** (or use the *Voice* button in the header) in the LEXA tab. The browser asks for microphone
permission once: allow it. Codespaces addresses are HTTPS, which browsers require for microphone access. Speech
recognition uses the same `OPENAI_API_KEY`; without it LEXA starts in a text-only voice mode and tells you why.
Everything voice can do, the safety rules for approvals, costs and troubleshooting: [`VOICE.md`](VOICE.md).

## 3. Day to day
- Your codespace **stops when idle** (30 minutes by default; up to 4 hours under GitHub → Settings → Codespaces →
  *Default idle timeout*). All data (database, memory, uploads) is kept. Reopen the codespace from
  github.com/codespaces and LEXA starts again automatically.
- While the codespace is stopped, nothing runs: scheduled automations and reminders run when you next open it.
- Free usage: personal GitHub accounts include a monthly allowance of Codespaces hours and storage. See
  GitHub → Settings → Billing for your current usage.
- After you push new code, rebuild to pick it up: Command Palette → *Codespaces: Rebuild Container*.
  Data is kept.

## 4. Logs and troubleshooting
In the codespace terminal:
```bash
tail -f ~/lexa-data/logs/api.log ~/lexa-data/logs/worker.log ~/lexa-data/logs/web.log
```
```bash
bash .devcontainer/start.sh      # restart all LEXA processes and re-verify the address
```
If the start-up message says *the public address could not be verified*, or the browser shows **502**: in the
**Ports** tab right-click the LEXA port → **Stop Forwarding Port**, then run `bash .devcontainer/start.sh` again.
If the app says *No AI provider is configured*, the secret was added after the codespace was created. Rebuild
the container.

## 5. Data safety
Data lives inside the codespace. **Deleting the codespace deletes the data.** Before deleting it, export
everything from **Memory → Export all data**: a JSON file of your memories, tasks, conversations, contacts,
jobs, finance entries and settings (credentials are never exported).
