"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Activity, ShieldCheck } from "lucide-react";
import { useApi } from "@/hooks/use-api";
import { useEvents } from "@/hooks/use-events";
import { timeAgo, usd } from "@/lib/utils";
import { EmptyState, PageHeader, Skeleton, StatusBadge } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ApprovalCard } from "@/components/assistant/approval-card";
import type { Approval, Task } from "@/types";

const VIEWS: Record<string, string> = { all: "", active: "view=active", completed: "status=COMPLETED", failed: "status=FAILED", cancelled: "status=CANCELLED" };

function TaskTable({ view }: { view: string }) {
  const { data, loading, reload } = useApi<{ items: Task[]; counts: Record<string, number> }>(`/api/tasks?limit=100&${VIEWS[view]}`);
  useEvents((e) => { if (e.event.startsWith("task.status") || e.event === "task.completed" || e.event === "task.created") void reload(); });
  if (loading && !data) return <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</div>;
  if (!data?.items.length) return <EmptyState icon={Activity} title="No tasks here" description="Tasks appear when you ask LEXA to do something or an automation runs." />;
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <ul className="divide-y divide-border">
        {data.items.map((t) => (
          <li key={t.id}>
            <Link href={`/tasks/${t.id}`} className="flex flex-col gap-1.5 px-4 py-3 hover:bg-surface-2/60 sm:flex-row sm:items-center sm:gap-4">
              <div className="w-36 shrink-0"><StatusBadge status={t.status} /></div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{t.title}</p>
                <p className="truncate text-xs text-subtle">{t.output_preview || t.error || t.request}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs text-subtle">
                {t.workflow_id && <Badge tone="accent">automation</Badge>}
                {t.assigned_agents.slice(0, 3).map((a) => <Badge key={a}>{a}</Badge>)}
                <span className="tabular-nums">{usd(t.cost_usd, 4)}</span>
                <span className="w-16 text-right">{timeAgo(t.created_at)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Approvals() {
  const { data, reload, loading } = useApi<Approval[]>("/api/approvals?status=pending");
  const { data: history, reload: reloadHistory } = useApi<Approval[]>("/api/approvals?status=all");
  useEvents((e) => { if (e.event.startsWith("approval") || e.event === "notification") { void reload(); void reloadHistory(); } });
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        {loading && !data ? <Skeleton className="h-28" /> : data?.length ? data.map((a) => <ApprovalCard key={a.id} approval={a} onDecided={() => { void reload(); void reloadHistory(); }} />)
          : <EmptyState icon={ShieldCheck} title="No pending approvals" description="When an agent prepares an external action, it waits here for your decision." />}
      </div>
      {!!history?.filter((a) => a.status !== "pending").length && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">History</h3>
          <ul className="divide-y divide-border rounded-xl border border-border bg-surface text-sm">
            {history.filter((a) => a.status !== "pending").slice(0, 30).map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-4 py-2.5">
                <Badge tone={a.status === "executed" ? "success" : a.status === "failed" ? "danger" : "neutral"}>{a.status}</Badge>
                <span className="min-w-0 flex-1 truncate">{a.summary.split("\n")[0]}</span>
                <span className="text-xs text-subtle">{a.reason.startsWith("auto:") ? "auto-rule" : a.agent}</span>
                <span className="w-16 text-right text-xs text-subtle">{timeAgo(a.decided_at || a.created_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function TasksInner() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = params.get("tab") || "all";
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader icon={Activity} title="Task Center" description="Every request, plan, agent step, approval and result — durable and auditable." />
      <Tabs value={tab} onValueChange={(v) => router.replace(`/tasks?tab=${v}`)}>
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="active">Active</TabsTrigger>
          <TabsTrigger value="approvals">Approval queue</TabsTrigger>
          <TabsTrigger value="completed">Completed</TabsTrigger>
          <TabsTrigger value="failed">Failed</TabsTrigger>
          <TabsTrigger value="cancelled">Cancelled</TabsTrigger>
        </TabsList>
        {Object.keys(VIEWS).map((v) => <TabsContent key={v} value={v}>{tab === v && <TaskTable view={v} />}</TabsContent>)}
        <TabsContent value="approvals">{tab === "approvals" && <Approvals />}</TabsContent>
      </Tabs>
    </div>
  );
}

export default function TasksPage() {
  return <Suspense><TasksInner /></Suspense>;
}
