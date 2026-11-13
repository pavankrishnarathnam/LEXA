# Automation (n8n ↔ LEXA)

LEXA and n8n integrate in both directions:

| Direction | How |
|---|---|
| **n8n → LEXA** | Create an automation in LEXA with trigger **Webhook**. LEXA shows a URL path and a one-time secret. n8n calls `POST https://<domain>/api/automations/<id>/webhook` with header `X-Lexa-Secret: <secret>` and a JSON body. Optional conditions (e.g. `[{"field":"kind","op":"eq","value":"lead"}]`) filter which payloads start a run. The payload reaches the agents as *untrusted data*. |
| **LEXA → n8n** | Connect n8n in **Integrations** (base URL + optional API key). The Operations Agent can call `n8n_trigger_workflow` for webhooks on that instance. This is an external action, so it goes through your permission mode / approvals. |

`n8n/lexa-inbound-lead.json` is an importable example workflow: an n8n Webhook receives a form submission and
forwards it to a LEXA webhook automation that asks the Communication Agent to draft a reply (the draft waits for
approval in LEXA). Set two n8n credentials/variables after import: `LEXA_WEBHOOK_URL` and `LEXA_SECRET`.

Running n8n next to LEXA (optional) — add to `docker-compose.override.yml`:

```yaml
services:
  n8n:
    image: n8nio/n8n:1.80.0
    environment: [N8N_HOST=n8n.example.com, N8N_PROTOCOL=https, WEBHOOK_URL=https://n8n.example.com/]
    volumes: [n8ndata:/home/node/.n8n]
    networks: [internal]
volumes: { n8ndata: {} }
```

and add a matching `server` block to Nginx for the n8n domain.
