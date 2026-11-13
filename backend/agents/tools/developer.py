"""GitHub tools. Destructive operations are not exposed; writes require approval by default."""
from __future__ import annotations

from typing import Any

from agents.tools.base import Risk, S, ToolContext, ToolResult, boolean, integer, string, tool
from integrations.providers.github import GitHubClient
from integrations.service import get_credentials

REPO = string("Repository as owner/name")


async def _gh(ctx: ToolContext) -> GitHubClient:
    creds = await get_credentials(ctx.db, ctx.user_id, "github", actor=f"agent:{ctx.agent_slug}")
    return GitHubClient(creds["token"])


@tool("github_list_repos", "List the user's GitHub repositories (most recently pushed first).", S(),
      risk=Risk.READ, category="developer", integration="github")
async def github_list_repos(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    repos = await (await _gh(ctx)).list_repos()
    return ToolResult("\n".join(f"- {r['full_name']} ({'private' if r['private'] else 'public'}, "
                                f"{r['language']}) pushed {r['pushed_at']}" for r in repos), {"repos": repos})


@tool("github_list_pull_requests", "List pull requests of a repository.",
      S(repo=REPO, state=string("open, closed, all")) | {"required": ["repo"]},
      risk=Risk.READ, category="developer", integration="github")
async def github_list_pull_requests(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    prs = await (await _gh(ctx)).pulls(a["repo"], a.get("state") or "open")
    return ToolResult("\n".join(f"#{p['number']} {p['title']} by {p['user']} ({p['head']}→{p['base']}) {p['url']}"
                                for p in prs) or "No pull requests.", untrusted_source="github")


@tool("github_get_pull_request_diff", "Get the unified diff of a pull request for code review.",
      S(repo=REPO, number=integer("PR number")) | {"required": ["repo", "number"]},
      risk=Risk.READ, category="developer", integration="github")
async def github_get_pull_request_diff(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    return ToolResult(await (await _gh(ctx)).pull_diff(a["repo"], int(a["number"])), untrusted_source="github")


@tool("github_list_issues", "List open issues of a repository.", S(repo=REPO) | {"required": ["repo"]},
      risk=Risk.READ, category="developer", integration="github")
async def github_list_issues(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    issues = await (await _gh(ctx)).issues(a["repo"])
    return ToolResult("\n".join(f"#{i['number']} {i['title']} {i['labels']}" for i in issues) or "No open issues.",
                      untrusted_source="github")


@tool("github_read_file", "Read a file (or list a directory) from a repository.",
      S(repo=REPO, path=string("Path in repo ('' for root)"), ref=string("Branch/sha")) | {"required": ["repo", "path"]},
      risk=Risk.READ, category="developer", integration="github")
async def github_read_file(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    return ToolResult(await (await _gh(ctx)).file(a["repo"], a["path"], a.get("ref")), untrusted_source="github")


@tool("github_workflow_runs", "Show recent GitHub Actions runs (CI / deployment health).",
      S(repo=REPO) | {"required": ["repo"]}, risk=Risk.READ, category="developer", integration="github")
async def github_workflow_runs(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    runs = await (await _gh(ctx)).workflow_runs(a["repo"])
    return ToolResult("\n".join(f"- {r['name']} [{r['branch']}] {r['status']}/{r['conclusion']} {r['url']}"
                                for r in runs) or "No workflow runs.")


@tool("github_create_branch", "Create a new branch from the default (or given) branch.",
      S(repo=REPO, branch=string("New branch name"), from_branch=string("Base branch")) |
      {"required": ["repo", "branch"]}, risk=Risk.EXTERNAL, category="developer", integration="github",
      summarize=lambda a: f"Create branch {a.get('branch')} in {a.get('repo')} from {a.get('from_branch') or 'default'}")
async def github_create_branch(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    r = await (await _gh(ctx)).create_branch(a["repo"], a["branch"], a.get("from_branch"))
    return ToolResult(f"Branch created: {r.get('ref')}")


@tool("github_create_issue", "Open an issue.", S(repo=REPO, title=string("Title"), body=string("Markdown body")) |
      {"required": ["repo", "title", "body"]}, risk=Risk.EXTERNAL, category="developer", integration="github",
      summarize=lambda a: f"Open issue in {a.get('repo')}: {a.get('title')}")
async def github_create_issue(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    r = await (await _gh(ctx)).create_issue(a["repo"], a["title"], a["body"])
    return ToolResult(f"Issue #{r['number']} created: {r['url']}", r)


@tool("github_create_pull_request", "Open a (draft by default) pull request from an existing branch.",
      S(repo=REPO, title=string("Title"), head=string("Head branch"), base=string("Base branch"),
        body=string("Description"), draft=boolean("Draft PR (default true)")) |
      {"required": ["repo", "title", "head", "base", "body"]}, risk=Risk.EXTERNAL, category="developer",
      integration="github", summarize=lambda a: f"Open PR in {a.get('repo')}: {a.get('head')} → {a.get('base')} "
                                                f"“{a.get('title')}”")
async def github_create_pull_request(ctx: ToolContext, a: dict[str, Any]) -> ToolResult:
    r = await (await _gh(ctx)).create_pull(a["repo"], a["title"], a["head"], a["base"], a["body"],
                                           a.get("draft", True))
    return ToolResult(f"Pull request #{r['number']} opened: {r['url']}", r)
