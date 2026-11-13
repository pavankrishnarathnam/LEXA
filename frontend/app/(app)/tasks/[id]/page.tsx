"use client";
import Link from "next/link";
import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, ChevronDown, MessageSquareText, RotateCcw, Square, Wrench } from "lucide-react";
import { useApi } from "@/hooks/use-api";
import { useEvents } from "@/hooks/use-events";
import { post } from "@/services/api";
import { cn, compact, timeAgo, usd } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Md, Skeleton, StatusBadge } from "@/components/ui/misc";
import { ApprovalCard } from "@/components/assistant/approval-card";
import { TaskLive } from "@/components/assistant/task-live";
import type { Execution, Task } from "@/types";

function ExecutionRow({ e }: { e: Execution }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-border">
      <button className="flex w-full items-center gap-3 px-3 py-2.5 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Badge tone="primary">{e.step_id}</Badge>
        <span className="text-sm font-medium capitalize">{e.agent}</span>
        <StatusBadge status={e.status} />
        <span className="ml-auto hidden text-xs text-subtle sm:inline">{e.model} · {compact(e.input_tokens)}↑ {compact(e.output_tokens)}↓ · {usd(e.cost_usd, 4)}</span>
        <ChevronDown className={cn("size-4 text-subtle transition", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-border px-3 py-3 text-sm">
          <p className="text-xs text-muted"><span className="font-medium text-foreground">Instruction:</span> {e.instruction}</p>
          {e.tool_calls.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium">Tool calls</p>
              <ul className="space-y-1">
                {e.tool_calls.map((c, i) => (
                  <li key={i} className="rounded-md bg-surface-2 px-2 py-1.5 font-mono text-[11px]">
                    <span className="inline-flex items-center gap-1 text-foreground"><Wrench className="size-3" />{c.tool}</span>
                    <span className={cn("ml-2", c.outcome === "ok" ? "text-success" : c.outcome?.startsWith("queued") ? "text-warning" : "text-danger")}>{c.outcome}</span>
                    <span className="ml-2 text-subtle">{JSON.stringify(c.args).slice(0, 220)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {e.error && <p className="text-xs text-danger">Error: {e.error}</p>}
          {e.output && <div className="rounded-lg border border-border p-3"><Md>{e.output}</Md></div>}
        </div>
      )}
    </li>
  );
}

export default function TaskDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: t, reload } = useApi<Task>(`/api/tasks/${id}`);
  useEvents((e) => { if (e.data?.task_id === id || e.event.startsWith("approval")) void reload(); });
  if (!t) return <div className="mx-auto max-w-5xl space-y-3"><Skeleton className="h-8 w-64" /><Skeleton className="h-40" /></div>;
  const running = ["PENDING", "PLANNING", "IN_PROGRESS"].includes(t.status);

  const cancel = async () => { try { await post(`/api/tasks/${id}/cancel`); void reload(); } catch (e) { toast.error((e as Error).message); } };
  const retry = async () => {
    try { const n = await post<Task>(`/api/tasks/${id}/retry`); router.push(`/tasks/${n.id}`); } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <Link href="/tasks" className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"><ArrowLeft className="size-3" />Task Center</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><StatusBadge status={t.status} />{t.workflow_id && <Badge tone="accent">automation</Badge>}</div>
          <h1 className="mt-2 text-xl font-semibold tracking-tight">{t.title}</h1>
          <p className="mt-1 font-mono text-[11px] text-subtle">{t.id} · created {timeAgo(t.created_at)} · {t.attempts} attempt(s) · {usd(t.cost_usd, 4)}</p>
        </div>
        <div className="flex gap-2">
          {t.conversation_id && <Button variant="secondary" size="sm" asChild><Link href={`/assistant/${t.conversation_id}`}><MessageSquareText />Conversation</Link></Button>}
          {(running || t.status === "WAITING_FOR_APPROVAL") && <Button variant="secondary" size="sm" onClick={() => void cancel()}><Square />Cancel</Button>}
          {(t.status === "FAILED" || t.status === "CANCELLED") && <Button size="sm" onClick={() => void retry()}><RotateCcw />Retry</Button>}
        </div>
      </div>

      <Card><CardHeader><CardTitle>Request</CardTitle></CardHeader><CardContent><p className="whitespace-pre-wrap text-sm text-muted">{t.request.slice(0, 3000)}</p></CardContent></Card>

      {running && <TaskLive taskId={id} onFinished={() => void reload()} />}

      {t.approvals && t.approvals.length > 0 && (
        <section className="space-y-2"><h2 className="text-sm font-semibold">Approvals</h2>
          {t.approvals.map((a) => <ApprovalCard key={a.id} approval={a} onDecided={() => void reload()} />)}</section>
      )}

      {t.plan.length > 0 && (
        <Card><CardHeader><CardTitle>Execution plan & agent steps</CardTitle></CardHeader>
          <CardContent><ul className="space-y-2">{t.executions?.map((e) => <ExecutionRow key={e.id} e={e} />)}</ul>
            {!t.executions?.length && <p className="text-sm text-muted">No steps executed yet.</p>}</CardContent></Card>
      )}

      {(t.output || t.error) && (
        <Card><CardHeader><CardTitle>{t.error && !t.output ? "Error" : "Result"}</CardTitle></CardHeader>
          <CardContent>{t.output ? <Md>{t.output}</Md> : null}{t.error && <p className="mt-2 text-sm text-danger">{t.error}</p>}</CardContent></Card>
      )}

      <Card><CardHeader><CardTitle>Execution log</CardTitle></CardHeader>
        <CardContent>
          <ol className="space-y-1 font-mono text-[11px]">
            {(t.logs || []).map((l, i) => (
              <li key={i} className="flex gap-2">
                <span className="shrink-0 text-subtle">{new Date(l.at).toLocaleTimeString()}</span>
                <span className={cn("shrink-0 w-20 truncate", l.level === "error" ? "text-danger" : l.level === "warning" ? "text-warning" : "text-accent")}>{l.agent || "core"}</span>
                <span className="text-muted">{l.message}</span>
              </li>
            ))}
            {!t.logs?.length && <li className="text-subtle">No log entries.</li>}
          </ol>
        </CardContent></Card>
    </div>
  );
}
