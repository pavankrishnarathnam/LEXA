# Run LEXA on GitHub (Codespaces)

LEXA runs entirely on GitHub, with no VPS, using **GitHub Codespaces**. The repository's dev container starts
PostgreSQL + pgvector, Redis, the API, the background worker and the web app.

## 1. Add your API key (once)
GitHub → **Settings** (your profile) → **Codespaces** → **Secrets** → *New secret*:
- `ANTHROPIC_API_KEY`: your Claude key (required for agents). Under *Repository access* select `LEXA`.
- `OPENAI_API_KEY`: optional (fallback model, semantic memory search, server voice).

## 2. Start LEXA
On the repository page: **Code → Codespaces → Create codespace on main**.

The first start takes about 3–5 minutes (it installs dependencies and builds the app). When the terminal prints
`LEXA is running → https://<name>-3000.app.github.dev`, the **LEXA** tab opens automatically. You can also open
it from the **Ports** tab, under port 3000. Register your account; the first account becomes the owner.

The URL is **private by default**: only your signed-in GitHub account can open it. Leave the port visibility
as *Private*.

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
bash .devcontainer/start.sh      # restart all LEXA processes
```
If the app says *No AI provider is configured*, the secret was added after the codespace was created. Rebuild
the container.

## 5. Data safety
Data lives inside the codespace. **Deleting the codespace deletes the data.** Before deleting it, export
everything from **Memory → Export all data**: a JSON file of your memories, tasks, conversations, contacts,
jobs, finance entries and settings (credentials are never exported).
