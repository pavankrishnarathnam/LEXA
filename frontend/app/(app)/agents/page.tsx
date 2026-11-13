"use client";
import Link from "next/link";
import { toast } from "sonner";
import { Bot, Plus } from "lucide-react";
import { useApi } from "@/hooks/use-api";
import { api } from "@/services/api";
import { compact, usd } from "@/lib/utils";
import { PageHeader, Skeleton } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { AgentIcon } from "@/components/layout/agent-icon";
import type { Agent } from "@/types";

export default function AgentsPage() {
  const { data, loading, setData } = useApi<Agent[]>("/api/agents");
  const toggle = async (a: Agent) => {
    try {
      await api(`/api/agents/${a.slug}`, { method: "PATCH", json: { enabled: !a.enabled } });
      setData(data?.map((x) => (x.slug === a.slug ? { ...x, enabled: !a.enabled } : x)));
    } catch (e) { toast.error((e as Error).message); }
  };
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader icon={Bot} title="Agents" description="LEXA CORE delegates to these specialists. Each has its own prompt, model, tools and permissions."
        actions={<Button variant="gradient" asChild><Link href="/agents/new"><Plus />Create agent</Link></Button>} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {loading && !data && [0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-44" />)}
        {data?.map((a) => (
          <div key={a.slug} className="group flex flex-col rounded-xl border border-border bg-surface p-4 transition hover:border-border-strong">
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-grad/10 ring-1 ring-primary/20"><AgentIcon name={a.icon} className="size-5 text-primary" /></span>
              <div className="min-w-0 flex-1">
                <Link href={`/agents/${a.slug}`} className="block truncate text-sm font-semibold hover:underline">{a.name}</Link>
                <p className="truncate text-xs text-subtle">{a.role}</p>
              </div>
              <Switch checked={a.enabled} onCheckedChange={() => void toggle(a)} aria-label={`${a.enabled ? "Disable" : "Enable"} ${a.name}`} />
            </div>
            <p className="mt-3 line-clamp-2 text-xs text-muted">{a.description}</p>
            <div className="mt-3 flex flex-wrap gap-1">
              {a.is_custom ? <Badge tone="accent">custom</Badge> : <Badge>built-in</Badge>}
              {a.web_search && <Badge tone="primary">web search</Badge>}
              <Badge>{a.tools.length} tools</Badge>
              {a.permission_mode && <Badge tone="warning">{a.permission_mode.replace("_", " ")}</Badge>}
            </div>
            <div className="mt-auto grid grid-cols-3 gap-2 border-t border-border pt-3 text-center text-[11px] text-subtle">
              <span><span className="block text-sm font-semibold text-foreground tabular-nums">{a.stats?.runs ?? 0}</span>runs</span>
              <span><span className="block text-sm font-semibold text-foreground tabular-nums">{compact(a.stats?.tokens)}</span>tokens</span>
              <span><span className="block text-sm font-semibold text-foreground tabular-nums">{usd(a.stats?.cost_usd)}</span>cost</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
