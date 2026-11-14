"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { ArrowRight, ArrowUp, Briefcase, CalendarDays, Inbox, Mic, Newspaper, Plug, Sparkles, Sunrise, Wallet } from "lucide-react";
import { useApi } from "@/hooks/use-api";
import { useEvents } from "@/hooks/use-events";
import { runInstruction } from "@/services/api";
import { cn, greeting, timeAgo, usd } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton, StatusBadge } from "@/components/ui/misc";
import { LexaOrb } from "@/components/layout/orb";
import { AgentIcon } from "@/components/layout/agent-icon";
import { useAuth } from "@/components/layout/auth";
import { ApprovalCard } from "@/components/assistant/approval-card";
import { useVoice, useVoiceLevel } from "@/components/voice/voice-provider";
import type { Approval, Notification, Task } from "@/types";

interface Dashboard {
  active_tasks: Task[]; recent_tasks: Task[]; pending_approvals: Approval[]; notifications: Notification[];
  agents: { slug: string; name: string; icon: string; status: string }[];
  schedule: { connected: boolean; events: { id: string; summary: string; start: any; location?: string }[]; error?: string };
  usage: { month_spend_usd: number; budget_usd: number }; memory_count: number; providers: { anthropic: boolean; openai: boolean };
}

const QUICK = [
  { icon: Sunrise, label: "Daily briefing", prompt: "Prepare my daily briefing: today's calendar, important unread emails, pending approvals, active tasks, and top 3 priorities." },
  { icon: Inbox, label: "Triage inbox", prompt: "Triage my unread emails from the last 24 hours: categorize, summarize and draft replies for anything urgent." },
  { icon: Briefcase, label: "Find jobs", prompt: "Find new job openings that match my profile and career preferences, save the best ones with match scores." },
  { icon: Newspaper, label: "Industry news", prompt: "Research the most important news in my industry this week and summarize with sources." },
  { icon: Wallet, label: "Spending check", prompt: "Summarize my spending for the last 30 days and flag subscriptions I might cancel." },
  { icon: CalendarDays, label: "Plan my week", prompt: "Look at my calendar for this week and propose a focused plan with time blocks for my priorities." },
];

function eventTime(start: any) {
  const v = start?.dateTime || start?.date;
  if (!v) return "";
  return start?.dateTime ? new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "All day";
}

export default function CommandCenter() {
  const router = useRouter();
  const { user } = useAuth();
  const { data, loading, reload } = useApi<Dashboard>("/api/dashboard");
  const [cmd, setCmd] = useState("");
  const [busy, setBusy] = useState(false);
  useEvents((e) => { if (["task.status", "task.completed", "approval.executed", "notification"].includes(e.event)) void reload(); });

  const run = async (text: string) => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const { conversationId } = await runInstruction(text.trim());
      router.push(`/assistant/${conversationId}`);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  const voice = useVoice();
  const level = useVoiceLevel();
  const phase = voice.snap.phase;
  const orbState = phase === "speaking" ? "speaking" : phase === "hearing" ? "listening" : phase === "transcribing" ? "processing"
    : phase === "thinking" || data?.active_tasks.length ? "thinking" : "idle";
  const budgetPct = data ? Math.min(100, (data.usage.month_spend_usd / Math.max(data.usage.budget_usd, 0.0001)) * 100) : 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <section className="relative overflow-hidden rounded-2xl border border-border bg-surface/70 px-5 py-8 sm:px-10">
        <div className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-grad opacity-[0.07] blur-3xl" />
        <div className="flex flex-col items-center gap-6 text-center md:flex-row md:text-left">
          <button type="button" onClick={voice.toggle} aria-label="Talk to LEXA" aria-pressed={voice.snap.active} aria-keyshortcuts="Alt+V" className="rounded-full">
            <LexaOrb size={104} state={orbState} level={level} />
          </button>
          <div className="w-full min-w-0 flex-1">
            <p className="text-xs uppercase tracking-[0.2em] text-subtle">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">{greeting()}{user?.full_name ? `, ${user.full_name.split(" ")[0]}` : ""}.</h1>
            <p className="mt-1 text-sm text-muted">
              {data ? <>{data.active_tasks.length} active task{data.active_tasks.length === 1 ? "" : "s"} · {data.pending_approvals.length} awaiting approval · {data.memory_count} memories</> : "Loading your workspace…"}
            </p>
            <form className="mt-5 flex items-center gap-2 rounded-xl border border-border-strong bg-background/60 p-1.5 pl-3 focus-within:border-primary/60"
              onSubmit={(e) => { e.preventDefault(); void run(cmd); }}>
              <Sparkles className="size-4 shrink-0 text-primary" />
              <label htmlFor="cmd" className="sr-only">Command</label>
              <input id="cmd" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="Tell LEXA what you need…"
                className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle" />
              <Button type="button" size="icon" variant="ghost" aria-label="Voice mode" aria-pressed={voice.snap.active} onClick={voice.toggle}
                className={cn(voice.snap.active && "text-primary")}><Mic /></Button>
              <Button type="submit" size="icon" variant="gradient" aria-label="Run" loading={busy}>{!busy && <ArrowUp />}</Button>
            </form>
          </div>
        </div>
        {data && !data.providers.anthropic && !data.providers.openai && (
          <div className="mt-6 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <Plug className="mt-0.5 size-3.5 shrink-0" />
            <p className="min-w-0 break-words">No AI provider is configured on the server. Set <code className="font-mono break-all">OPENAI_API_KEY</code> (in Codespaces: a Codespaces secret, then rebuild) to enable agents.</p>
          </div>
        )}
      </section>

      <section aria-label="Quick actions" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {QUICK.map((q, i) => (
          <motion.button key={q.label} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}
            onClick={() => void run(q.prompt)} disabled={busy}
            className="group flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 text-left text-[13px] text-muted transition hover:border-primary/40 hover:text-foreground">
            <q.icon className="size-4 text-primary transition group-hover:scale-110" />{q.label}
          </motion.button>
        ))}
      </section>

      {data?.pending_approvals.length ? (
        <section aria-label="Pending approvals" className="space-y-2">
          <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">Waiting for your approval</h2>
            <Link href="/tasks?tab=approvals" className="text-xs text-accent hover:underline">All approvals</Link></div>
          {data.pending_approvals.slice(0, 3).map((a) => <ApprovalCard key={a.id} approval={a} onDecided={() => void reload()} />)}
        </section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Active tasks</CardTitle><Link href="/tasks" className="text-xs text-accent hover:underline">Task center</Link></CardHeader>
          <CardContent>
            {loading && !data ? <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
              : data?.active_tasks.length ? (
                <ul className="divide-y divide-border">
                  {data.active_tasks.map((t) => (
                    <li key={t.id}><Link href={`/tasks/${t.id}`} className="flex items-center gap-3 py-2.5 hover:opacity-80">
                      <StatusBadge status={t.status} />
                      <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
                      <span className="hidden text-xs text-subtle sm:inline">{t.assigned_agents.join(", ")}</span>
                      <ArrowRight className="size-3.5 text-subtle" />
                    </Link></li>
                  ))}
                </ul>
              ) : <p className="py-6 text-center text-sm text-muted">Nothing running. Ask LEXA for something above.</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Today</CardTitle><CalendarDays className="size-4 text-muted" /></CardHeader>
          <CardContent>
            {!data ? <Skeleton className="h-24" /> : !data.schedule.connected ? (
              <div className="py-4 text-center text-sm text-muted">
                Connect Google Calendar to see your schedule.
                <div className="mt-3"><Button size="sm" variant="secondary" asChild><Link href="/integrations">Connect</Link></Button></div>
              </div>
            ) : data.schedule.events.length ? (
              <ul className="space-y-2.5">{data.schedule.events.map((e) => (
                <li key={e.id} className="flex gap-3 text-sm"><span className="w-14 shrink-0 tabular-nums text-xs text-subtle">{eventTime(e.start)}</span>
                  <span className="min-w-0"><span className="block truncate">{e.summary}</span>{e.location && <span className="block truncate text-xs text-subtle">{e.location}</span>}</span></li>
              ))}</ul>
            ) : <p className="py-4 text-center text-sm text-muted">{data.schedule.error ? `Calendar error: ${data.schedule.error}` : "No events today."}</p>}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Agents</CardTitle><Link href="/agents" className="text-xs text-accent hover:underline">Manage</Link></CardHeader>
          <CardContent>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {(data?.agents || []).map((a) => (
                <li key={a.slug}><Link href={`/agents/${a.slug}`} className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2 hover:border-border-strong">
                  <span className="grid size-7 place-items-center rounded-md bg-surface-2"><AgentIcon name={a.icon} className="size-3.5 text-primary" /></span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">{a.name.replace(" Agent", "")}</span>
                  <span className={cn("size-2 rounded-full", a.status === "busy" ? "bg-primary animate-pulse" : a.status === "ready" ? "bg-success" : "bg-subtle")}
                    role="img" aria-label={a.status} title={a.status} />
                </Link></li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>AI usage this month</CardTitle><Link href="/settings?tab=usage" className="text-xs text-accent hover:underline">Details</Link></CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{usd(data?.usage.month_spend_usd)}</p>
            <p className="text-xs text-subtle">of {usd(data?.usage.budget_usd)} budget</p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label="AI budget used this month" aria-valuenow={Math.round(budgetPct)} aria-valuemin={0} aria-valuemax={100}>
              <div className={cn("h-full rounded-full", budgetPct > 85 ? "bg-danger" : "bg-grad")} style={{ width: `${budgetPct}%` }} />
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Recent activity</CardTitle></CardHeader>
          <CardContent>
            {data?.recent_tasks.length ? (
              <ul className="space-y-2">{data.recent_tasks.map((t) => (
                <li key={t.id}><Link href={`/tasks/${t.id}`} className="flex items-center gap-3 text-sm hover:opacity-80">
                  <StatusBadge status={t.status} /><span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <span className="shrink-0 text-xs text-subtle">{timeAgo(t.updated_at)}</span></Link></li>
              ))}</ul>
            ) : <p className="py-4 text-center text-sm text-muted">No activity yet.</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Notifications</CardTitle></CardHeader>
          <CardContent>
            {data?.notifications.length ? (
              <ul className="space-y-2.5">{data.notifications.slice(0, 5).map((n) => (
                <li key={n.id} className="text-sm"><p className="truncate">{n.title}</p><p className="text-[11px] text-subtle">{timeAgo(n.created_at)}</p></li>
              ))}</ul>
            ) : <p className="py-4 text-center text-sm text-muted">All caught up.</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
