"""Web research tools (Claude's server-side web search is attached separately by the research agent)."""
from __future__ import annotations

from typing import Any

from agents.tools.base import Risk, S, ToolContext, ToolResult, boolean, string, tool
from core.llm import openai_provider
from core.llm.types import ProviderError
from core.llm.usage import record_usage
from integrations.providers.web import fetch_page, render_page


@tool("web_search", "Search the live web for current information (news, companies, jobs, docs, prices). Returns a "
      "sourced summary with URLs; use web_fetch to read a specific page in full.",
      S(query=string("What to search for, as a specific natural-language query")) | {"required": ["query"]},
      risk=Risk.READ, category="research")
async def web_search(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    try:
        text, citations, usage, model = await openai_provider.web_search(a["query"])
    except ProviderError as exc:
        return ToolResult(f"Web search unavailable: {exc}", is_error=True)
    await record_usage(user_id=ctx.user_id, provider="openai", model=model, usage=usage, purpose="web_search",
                       task_id=ctx.task_id, agent_slug=ctx.agent_slug)
    sources = "\n".join(f"- {c['title']}: {c['url']}" for c in citations) or "(no sources returned)"
    return ToolResult(f"{text}\n\nSOURCES:\n{sources}", {"citations": citations}, untrusted_source="web_search")


@tool("web_fetch", "Fetch a public web page and return its readable text and links. Respects robots.txt. "
      "Use render_js=true for JavaScript-heavy pages (uses a headless browser).",
      S(url=string("http(s) URL"), render_js=boolean("Render with a headless browser")) | {"required": ["url"]},
      risk=Risk.READ, category="research")
async def web_fetch(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    try:
        page = await (render_page(a["url"]) if a.get("render_js") else fetch_page(a["url"]))
    except PermissionError as exc:
        return ToolResult(f"Access not permitted: {exc}", is_error=True)
    except Exception as exc:  # noqa: BLE001
        return ToolResult(f"Fetch failed: {exc}", is_error=True)
    links = "\n".join(f"- {link['text']}: {link['href']}" for link in page["links"][:25])  # type: ignore[index]
    return ToolResult(f"URL: {page['url']}\nTITLE: {page['title']}\n\n{page['text']}\n\nLINKS:\n{links}",
                      {"url": page["url"], "title": page["title"]}, untrusted_source=str(page["url"]))
