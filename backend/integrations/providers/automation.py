"""n8n and MCP (Streamable HTTP, JSON-RPC) clients."""
from __future__ import annotations

import ipaddress
import json
import socket
from typing import Any
from urllib.parse import urlparse

import httpx

from core.config import settings


def assert_public_url(url: str) -> None:
    """SSRF guard: only http(s) URLs resolving to public addresses (relaxed outside production)."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("Only http(s) URLs are allowed")
    if not settings.is_production:
        return
    for info in socket.getaddrinfo(parsed.hostname, None):
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise ValueError("URL resolves to a private address")


async def n8n_trigger(webhook_url: str, payload: dict[str, Any], api_key: str | None = None) -> dict[str, Any]:
    assert_public_url(webhook_url)
    headers = {"X-N8N-API-KEY": api_key} if api_key else {}
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(webhook_url, json=payload, headers=headers)
    if r.status_code >= 400:
        raise RuntimeError(f"n8n webhook {r.status_code}: {r.text[:300]}")
    try:
        return {"status": r.status_code, "response": r.json()}
    except ValueError:
        return {"status": r.status_code, "response": r.text[:2000]}


async def n8n_verify(creds: dict[str, Any]) -> str:
    base = creds["base_url"].rstrip("/")
    assert_public_url(base)
    if not creds.get("api_key"):
        return base
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(f"{base}/api/v1/workflows", headers={"X-N8N-API-KEY": creds["api_key"]},
                        params={"limit": 1})
    if r.status_code >= 400:
        raise RuntimeError(f"n8n verification failed ({r.status_code})")
    return base


class MCPClient:
    """Minimal MCP Streamable-HTTP client (initialize, tools/list, tools/call)."""

    def __init__(self, url: str, bearer: str | None = None):
        assert_public_url(url)
        self.url = url
        self.headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json",
                        "MCP-Protocol-Version": "2025-06-18"}
        if bearer:
            self.headers["Authorization"] = f"Bearer {bearer}"
        self._id = 0

    async def _rpc(self, client: httpx.AsyncClient, method: str, params: dict[str, Any] | None = None,
                   notify: bool = False) -> Any:
        body: dict[str, Any] = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if not notify:
            self._id += 1
            body["id"] = self._id
        r = await client.post(self.url, json=body, headers=self.headers)
        if "mcp-session-id" in r.headers:
            self.headers["Mcp-Session-Id"] = r.headers["mcp-session-id"]
        if notify:
            return None
        r.raise_for_status()
        if r.headers.get("content-type", "").startswith("text/event-stream"):
            for line in r.text.splitlines():
                if line.startswith("data:"):
                    msg = json.loads(line[5:].strip())
                    if msg.get("id") == body["id"]:
                        return self._result(msg)
            raise RuntimeError("MCP: no response in event stream")
        return self._result(r.json())

    @staticmethod
    def _result(msg: dict[str, Any]) -> Any:
        if "error" in msg:
            raise RuntimeError(f"MCP error: {msg['error'].get('message')}")
        return msg.get("result")

    async def _session(self, client: httpx.AsyncClient) -> None:
        await self._rpc(client, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                               "clientInfo": {"name": "LEXA", "version": "0.1.0"}})
        await self._rpc(client, "notifications/initialized", notify=True)

    async def list_tools(self) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=30) as c:
            await self._session(c)
            res = await self._rpc(c, "tools/list")
        return res.get("tools", [])

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> str:
        async with httpx.AsyncClient(timeout=120) as c:
            await self._session(c)
            res = await self._rpc(c, "tools/call", {"name": name, "arguments": arguments})
        parts = [p.get("text", json.dumps(p)) for p in res.get("content", [])]
        return ("ERROR: " if res.get("isError") else "") + "\n".join(parts)
