"use client";
import Link from "next/link";
import { use } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, RotateCcw, Trash2 } from "lucide-react";
import { useApi } from "@/hooks/use-api";
import { del } from "@/services/api";
import { timeAgo, usd } from "@/lib/utils";
import { PageHeader, Skeleton, StatusBadge } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentForm } from "@/components/agents/agent-form";
import { AgentIcon } from "@/components/layout/agent-icon";
import { useConfirm } from "@/components/voice/confirm-provider";
import type { Agent, Execution } from "@/types";

export default function AgentDetail({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const router = useRouter();
  const { confirm } = useConfirm();
  const { data } = useApi<Agent & { executions: (Execution & { task_id?: string })[]; prompt_versions: { version: number; active: boolean; created_at: string }[] }>(`/api/agents/${slug}`);
  if (!data) return <div className="mx-auto max-w-6xl space-y-3"><Skeleton className="h-10 w-72" /><Skeleton className="h-96" /></div>;
  const remove = async () => {
    const ok = await confirm({ title: data.is_custom ? `Delete ${data.name}?` : `Reset ${data.name}?`,
      description: data.is_custom ? "This agent and its history settings will be removed." : "Its prompt, tools and limits go back to the built-in defaults.",
      confirmLabel: data.is_custom ? "Delete agent" : "Reset to default", destructive: true });
    if (!ok) return;
    try { await del(`/api/agents/${slug}`); toast.success(data.is_custom ? "Agent deleted" : "Reset to defaults"); router.push("/agents"); }
    catch (e) { toast.error((e as Error).message); }
  };
  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/agents" className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"><ArrowLeft className="size-3" />Agents</Link>
      <PageHeader title={data.name} description={data.role} icon={() => <AgentIcon name={data.icon} className="size-5 text-primary" />}
        actions={(data.is_custom || data.id) && <Button variant="secondary" size="sm" data-voice-confirms onClick={() => void remove()}>
          {data.is_custom ? <><Trash2 />Delete</> : <><RotateCcw />Reset to default</>}</Button>} />
      <Tabs defaultValue="config">
        <TabsList><TabsTrigger value="config">Configuration</TabsTrigger><TabsTrigger value="history">Execution history ({data.executions.length})</TabsTrigger></TabsList>
        <TabsContent value="config"><AgentForm agent={data} /></TabsContent>
        <TabsContent value="history">
          <Card><CardHeader><CardTitle>Recent executions</CardTitle></CardHeader><CardContent>
            {data.executions.length ? <ul className="divide-y divide-border">{data.executions.map((e) => (
              <li key={e.id} className="flex items-center gap-3 py-2.5 text-sm"><StatusBadge status={e.status} />
                <span className="min-w-0 flex-1 truncate">{e.instruction}</span>
                <span className="text-xs text-subtle">{e.tool_calls.length} tools · {usd(e.cost_usd, 4)} · {timeAgo(e.started_at)}</span></li>))}</ul>
              : <p className="py-6 text-center text-sm text-muted">This agent hasn’t run yet.</p>}
          </CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
