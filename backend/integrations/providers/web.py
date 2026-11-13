"""Authorized web access: HTTP fetch with robots.txt compliance and optional Playwright rendering."""
from __future__ import annotations

from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

import httpx
from bs4 import BeautifulSoup

from integrations.providers.automation import assert_public_url

UA = "LEXA-Assistant/0.1 (+personal assistant; respects robots.txt)"


async def robots_allowed(url: str) -> bool:
    p = urlparse(url)
    robots_url = f"{p.scheme}://{p.netloc}/robots.txt"
    try:
        async with httpx.AsyncClient(timeout=10, headers={"User-Agent": UA}, follow_redirects=True) as c:
            r = await c.get(robots_url)
        if r.status_code >= 400:
            return True
        rp = RobotFileParser()
        rp.parse(r.text.splitlines())
        return rp.can_fetch(UA, url)
    except httpx.HTTPError:
        return True


def html_to_text(html: str, base_url: str = "") -> tuple[str, str, list[dict[str, str]]]:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg", "iframe"]):
        tag.decompose()
    title = (soup.title.string or "").strip() if soup.title and soup.title.string else ""
    links = [{"text": a.get_text(" ", strip=True)[:120], "href": urljoin(base_url, a["href"])}
             for a in soup.find_all("a", href=True)][:60]
    text = "\n".join(line.strip() for line in soup.get_text("\n").splitlines() if line.strip())
    return title, text, links


async def fetch_page(url: str, max_chars: int = 20000) -> dict[str, object]:
    assert_public_url(url)
    if not await robots_allowed(url):
        raise PermissionError(f"robots.txt disallows automated access to {url}")
    async with httpx.AsyncClient(timeout=25, headers={"User-Agent": UA}, follow_redirects=True) as c:
        r = await c.get(url)
    r.raise_for_status()
    ctype = r.headers.get("content-type", "")
    if "html" in ctype:
        title, text, links = html_to_text(r.text, str(r.url))
    else:
        title, text, links = "", r.text, []
    return {"url": str(r.url), "title": title, "text": text[:max_chars], "links": links,
            "truncated": len(text) > max_chars}


async def render_page(url: str, max_chars: int = 20000) -> dict[str, object]:
    """Render JavaScript-heavy pages with Playwright (read-only, no form submission, no CAPTCHA handling)."""
    assert_public_url(url)
    if not await robots_allowed(url):
        raise PermissionError(f"robots.txt disallows automated access to {url}")
    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        try:
            page = await browser.new_page(user_agent=UA)
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(1500)
            html = await page.content()
            final = page.url
        finally:
            await browser.close()
    title, text, links = html_to_text(html, final)
    lowered = text.lower()
    if "captcha" in lowered and len(text) < 2000:
        raise PermissionError("Page is protected by a CAPTCHA; LEXA does not bypass CAPTCHAs.")
    return {"url": final, "title": title, "text": text[:max_chars], "links": links,
            "truncated": len(text) > max_chars}
