"use client";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, CircleDashed, Loader2, Square, Wrench, XCircle, Clock } from "lucide-react";
import { toast } from "sonner";
import { api, post } from "@/services/api";
import { useEvents } from "@/hooks/use-events";
import { cn } from "@/lib/utils";
import { Md, StatusBadge } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { ApprovalCard } from "./approval-card";
import type { Approval, PlanStep, Task, TaskStatus } from "@/types";

const TERMINAL: TaskStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

type Live = { status: TaskStatus; title: string; plan: PlanStep[]; steps: Record<string, string>; tools: { agent: string; tool: string }[];
  delta: string; approvals: Approval[] };

/** Live view of a task: plan, per-agent progress, tool activity, streaming output and inline approvals. */
export function TaskLive({ taskId, onFinished, compact }: { taskId: string; onFinished?: (status: TaskStatus) => void; compact?: boolean }) {
  const [live, setLive] = useState<Live | null>(null);

  const apply = (t: Task) => {
    const steps: Record<string, string> = {};
    t.executions?.forEach((e) => (steps[e.step_id] = e.status === "COMPLETED" ? "completed" : e.status === "FAILED" ? "failed"
      : e.status === "WAITING_FOR_APPROVAL" ? "waiting_for_approval" : "running"));
    setLive((p) => ({ status: t.status, title: t.title, plan: t.plan || [], steps, tools: p?.tools || [], delta: p?.delta || "",
      approvals: t.approvals || [] }));
    return t;
  };
  const load = async () => apply(await api<Task>(`/api/tasks/${taskId}`));

  useEffect(() => {
    let cancelled = false;
    api<Task>(`/api/tasks/${taskId}`).then((t) => {
      if (cancelled) return;
      apply(t);
      // The task may have finished before this component subscribed to events.
      if (TERMINAL.includes(t.status)) onFinished?.(t.status);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [taskId]);

  useEvents((e) => {
    if (e.data?.task_id !== taskId) {
      if (e.event.startsWith("approval.")) void load();
      return;
    }
    setLive((p) => {
      if (!p) return p;
      switch (e.event) {
        case "task.status": return { ...p, status: e.data.status, title: e.data.title || p.title };
        case "task.plan": return { ...p, plan: e.data.plan, title: e.data.title };
        case "agent.status": return { ...p, steps: { ...p.steps, [e.data.step_id]: e.data.status } };
        case "agent.tool": return { ...p, tools: [...p.tools.slice(-6), { agent: e.data.agent, tool: e.data.tool }] };
        case "task.delta": return { ...p, delta: p.delta + e.data.text };
        default: return p;
      }
    });
    if (e.event === "task.log" && e.data.data?.approval_id) void load();
    if (e.event === "task.completed" || (e.event === "task.status" && TERMINAL.includes(e.data.status))) {
      void load().then((t) => onFinished?.(t.status));
    }
  });

  if (!live) return <div className="flex items-center gap-2 text-xs text-muted"><Loader2 className="size-3.5 animate-spin" />Connecting…</div>;
  const running = !TERMINAL.includes(live.status) && live.status !== "WAITING_FOR_APPROVAL";
  const pendingApprovals = live.approvals.filter((a) => a.status === "pending");

  const stop = async () => {
    try {
      await post(`/api/tasks/${taskId}/cancel`);
      toast("Stopping…");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-3">
      {(running || !compact) && (
        <div className="rounded-xl border border-border bg-surface/80 p-3">
          <div className="flex items-center gap-2">
            <StatusBadge status={live.status} />
            <span className="truncate text-xs text-muted">{live.status === "PLANNING" ? "LEXA CORE is planning…" : live.title}</span>
            {running && <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={() => void stop()}><Square className="size-3" />Stop</Button>}
          </div>
          {live.plan.length > 0 && (
            <ol className="mt-3 space-y-1.5">
              {live.plan.map((s) => {
                const st = live.steps[s.id];
                return (
                  <li key={s.id} className="flex items-start gap-2 text-xs">
                    {st === "completed" ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                      : st === "failed" ? <XCircle className="mt-0.5 size-3.5 shrink-0 text-danger" />
                      : st === "waiting_for_approval" ? <Clock className="mt-0.5 size-3.5 shrink-0 text-warning" />
                      : st === "running" ? <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" />
                      : <CircleDashed className="mt-0.5 size-3.5 shrink-0 text-subtle" />}
                    <span className="font-medium capitalize text-foreground">{s.agent}</span>
                    <span className={cn("line-clamp-2 text-muted", st === "completed" && "line-through decoration-subtle/40")}>{s.instruction}</span>
                  </li>
                );
              })}
            </ol>
          )}
          <AnimatePresence>
            {running && live.tools.length > 0 && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-2 flex flex-wrap gap-1">
                {live.tools.slice(-4).map((t, i) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-muted">
                    <Wrench className="size-2.5" />{t.agent}·{t.tool}
                  </span>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
      {running && live.delta && <Md className="opacity-90">{live.delta}</Md>}
      {pendingApprovals.map((a) => <ApprovalCard key={a.id} approval={a} onDecided={() => void load()} />)}
    </div>
  );
}
