"""WhatsApp Business Cloud API, Twilio and Exotel clients."""
from __future__ import annotations

from typing import Any

import httpx

GRAPH = "https://graph.facebook.com/v21.0"


async def whatsapp_send_text(creds: dict[str, Any], to: str, body: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(f"{GRAPH}/{creds['phone_number_id']}/messages",
                         headers={"Authorization": f"Bearer {creds['access_token']}"},
                         json={"messaging_product": "whatsapp", "to": to.lstrip("+"), "type": "text",
                               "text": {"preview_url": False, "body": body}})
    if r.status_code >= 400:
        raise RuntimeError(f"WhatsApp API {r.status_code}: {r.text[:300]}")
    return r.json()


async def whatsapp_verify(creds: dict[str, Any]) -> str:
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.get(f"{GRAPH}/{creds['phone_number_id']}",
                        headers={"Authorization": f"Bearer {creds['access_token']}"})
    if r.status_code >= 400:
        raise RuntimeError(f"WhatsApp verification failed ({r.status_code})")
    return r.json().get("display_phone_number", creds["phone_number_id"])


async def twilio_send_sms(creds: dict[str, Any], to: str, body: str) -> dict[str, Any]:
    sid = creds["account_sid"]
    async with httpx.AsyncClient(timeout=20, auth=(sid, creds["auth_token"])) as c:
        r = await c.post(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
                         data={"To": to, "From": creds["from_number"], "Body": body})
    if r.status_code >= 400:
        raise RuntimeError(f"Twilio API {r.status_code}: {r.text[:300]}")
    d = r.json()
    return {"sid": d.get("sid"), "status": d.get("status")}


async def twilio_verify(creds: dict[str, Any]) -> str:
    sid = creds["account_sid"]
    async with httpx.AsyncClient(timeout=20, auth=(sid, creds["auth_token"])) as c:
        r = await c.get(f"https://api.twilio.com/2010-04-01/Accounts/{sid}.json")
    if r.status_code >= 400:
        raise RuntimeError(f"Twilio verification failed ({r.status_code})")
    return r.json().get("friendly_name", sid)


async def exotel_send_sms(creds: dict[str, Any], to: str, body: str) -> dict[str, Any]:
    sub = creds.get("subdomain") or "api.exotel.com"
    url = f"https://{sub}/v1/Accounts/{creds['account_sid']}/Sms/send.json"
    async with httpx.AsyncClient(timeout=20, auth=(creds["api_key"], creds["api_token"])) as c:
        r = await c.post(url, data={"From": creds["caller_id"], "To": to, "Body": body})
    if r.status_code >= 400:
        raise RuntimeError(f"Exotel API {r.status_code}: {r.text[:300]}")
    return r.json()


async def exotel_verify(creds: dict[str, Any]) -> str:
    sub = creds.get("subdomain") or "api.exotel.com"
    async with httpx.AsyncClient(timeout=20, auth=(creds["api_key"], creds["api_token"])) as c:
        r = await c.get(f"https://{sub}/v1/Accounts/{creds['account_sid']}.json")
    if r.status_code >= 400:
        raise RuntimeError(f"Exotel verification failed ({r.status_code})")
    return creds["account_sid"]
