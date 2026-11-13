"""GitHub REST client."""
from __future__ import annotations

from typing import Any

import httpx

API = "https://api.github.com"


class GitHubClient:
    def __init__(self, token: str):
        self._h = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                   "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "LEXA"}

    async def _req(self, method: str, path: str, **kw: Any) -> Any:
        async with httpx.AsyncClient(timeout=30, headers=self._h) as c:
            r = await c.request(method, f"{API}{path}", **kw)
        if r.status_code >= 400:
            raise RuntimeError(f"GitHub API {r.status_code}: {r.text[:300]}")
        return r.json() if r.content else {}

    async def me(self) -> dict[str, Any]:
        return await self._req("GET", "/user")

    async def list_repos(self, limit: int = 30) -> list[dict[str, Any]]:
        data = await self._req("GET", "/user/repos", params={"per_page": min(limit, 100), "sort": "pushed"})
        return [{"full_name": r["full_name"], "private": r["private"], "default_branch": r["default_branch"],
                 "pushed_at": r["pushed_at"], "open_issues": r["open_issues_count"], "url": r["html_url"],
                 "language": r.get("language"), "description": r.get("description")} for r in data]

    async def repo(self, full_name: str) -> dict[str, Any]:
        return await self._req("GET", f"/repos/{full_name}")

    async def pulls(self, full_name: str, state: str = "open") -> list[dict[str, Any]]:
        data = await self._req("GET", f"/repos/{full_name}/pulls", params={"state": state, "per_page": 30})
        return [{"number": p["number"], "title": p["title"], "user": p["user"]["login"], "state": p["state"],
                 "draft": p.get("draft"), "url": p["html_url"], "head": p["head"]["ref"], "base": p["base"]["ref"],
                 "updated_at": p["updated_at"]} for p in data]

    async def pull_diff(self, full_name: str, number: int) -> str:
        async with httpx.AsyncClient(timeout=30, headers={**self._h, "Accept": "application/vnd.github.diff"}) as c:
            r = await c.get(f"{API}/repos/{full_name}/pulls/{number}")
        r.raise_for_status()
        return r.text[:60000]

    async def issues(self, full_name: str, state: str = "open") -> list[dict[str, Any]]:
        data = await self._req("GET", f"/repos/{full_name}/issues", params={"state": state, "per_page": 30})
        return [{"number": i["number"], "title": i["title"], "state": i["state"], "url": i["html_url"],
                 "labels": [label["name"] for label in i.get("labels", [])]} for i in data if "pull_request" not in i]

    async def file(self, full_name: str, path: str, ref: str | None = None) -> str:
        import base64
        data = await self._req("GET", f"/repos/{full_name}/contents/{path}", params={"ref": ref} if ref else None)
        if isinstance(data, list):
            return "\n".join(f"{d['type']}: {d['path']}" for d in data)
        return base64.b64decode(data.get("content", "")).decode("utf-8", errors="replace")[:60000]

    async def create_branch(self, full_name: str, branch: str, from_branch: str | None = None) -> dict[str, Any]:
        repo = await self.repo(full_name)
        base = from_branch or repo["default_branch"]
        ref = await self._req("GET", f"/repos/{full_name}/git/ref/heads/{base}")
        return await self._req("POST", f"/repos/{full_name}/git/refs",
                               json={"ref": f"refs/heads/{branch}", "sha": ref["object"]["sha"]})

    async def create_issue(self, full_name: str, title: str, body: str) -> dict[str, Any]:
        i = await self._req("POST", f"/repos/{full_name}/issues", json={"title": title, "body": body})
        return {"number": i["number"], "url": i["html_url"]}

    async def create_pull(self, full_name: str, title: str, head: str, base: str, body: str,
                          draft: bool = True) -> dict[str, Any]:
        p = await self._req("POST", f"/repos/{full_name}/pulls",
                            json={"title": title, "head": head, "base": base, "body": body, "draft": draft})
        return {"number": p["number"], "url": p["html_url"]}

    async def workflow_runs(self, full_name: str) -> list[dict[str, Any]]:
        data = await self._req("GET", f"/repos/{full_name}/actions/runs", params={"per_page": 10})
        return [{"name": r["name"], "status": r["status"], "conclusion": r["conclusion"], "branch": r["head_branch"],
                 "url": r["html_url"], "created_at": r["created_at"]} for r in data.get("workflow_runs", [])]
