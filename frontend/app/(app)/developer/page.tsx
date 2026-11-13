"use client";
import { Code2, GitBranch, Rocket } from "lucide-react";
import { useApi } from "@/hooks/use-api";
import { timeAgo } from "@/lib/utils";
import { PageHeader } from "@/components/ui/misc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AgentActions, AgentTasks, IntegrationStatus } from "@/components/workspace/agent-actions";

export default function DeveloperPage() {
  const deps = useApi<{ version: string; git_sha: string | null; status: string; at: string }[]>("/api/deployments");
  const info = useApi<{ version: string; environment: string; default_model: string }>("/api/system/info");
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader icon={Code2} title="Developer Center" description="Repository analysis, code review, branches and PRs. Production deploys and destructive operations are never automated." />
      <AgentActions agent="developer" placeholder="e.g. Review the open PRs in acme/api and flag security issues"
        actions={[{ label: "Review open PRs", prompt: "List my repositories with open pull requests and review the most recent PR diff for bugs and security issues." },
          { label: "CI health", prompt: "Check GitHub Actions status for my 5 most recently pushed repositories and summarize failures." },
          { label: "Triage issues", prompt: "Triage open issues in my most active repository: group by theme and propose priorities." },
          { label: "Scan for secrets", prompt: "Read the README and config files of my most recent repository and scan for exposed credentials." }]} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2"><AgentTasks agent="developer" title="Code reviews & dev tasks" />
          <Card><CardHeader><CardTitle className="flex items-center gap-2"><Rocket className="size-4" />LEXA deployment history</CardTitle></CardHeader><CardContent>
            {deps.data?.length ? <ul className="divide-y divide-border">{deps.data.map((d, i) => (
              <li key={i} className="flex items-center gap-3 py-2 text-sm"><Badge tone={d.status === "success" ? "success" : d.status === "rolled_back" ? "warning" : "danger"}>{d.status}</Badge>
                <span className="font-mono text-xs">{d.version}</span><span className="font-mono text-xs text-subtle">{d.git_sha?.slice(0, 7)}</span>
                <span className="ml-auto text-xs text-subtle">{timeAgo(d.at)}</span></li>))}</ul>
              : <p className="py-4 text-center text-sm text-muted">No deployments recorded yet. The CD pipeline records each release here.</p>}
          </CardContent></Card></div>
        <div className="space-y-4"><IntegrationStatus keys={["github"]} />
          <Card><CardHeader><CardTitle className="flex items-center gap-2"><GitBranch className="size-4" />This instance</CardTitle></CardHeader><CardContent className="space-y-1 text-sm">
            <p className="flex justify-between"><span className="text-muted">Version</span><span className="font-mono">{info.data?.version}</span></p>
            <p className="flex justify-between"><span className="text-muted">Environment</span><span>{info.data?.environment}</span></p>
            <p className="flex justify-between"><span className="text-muted">Default model</span><span className="font-mono text-xs">{info.data?.default_model}</span></p></CardContent></Card></div>
      </div>
    </div>
  );
}
