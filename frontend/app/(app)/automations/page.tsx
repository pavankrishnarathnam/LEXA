"use client";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Copy, Pause, Play, Plus, Trash2, Workflow as WfIcon, Zap } from "lucide-react";
import { useApi } from "@/hooks/use-api";
import { useConfirm } from "@/components/voice/confirm-provider";
import { del, post } from "@/services/api";
import { timeAgo } from "@/lib/utils";
import { EmptyState, PageHeader, StatusBadge } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import type { Agent, Task, Workflow } from "@/types";

const PRESETS = [
  { name: "Morning briefing", cron: "30 7 * * 1-5", instruction: "Prepare my morning briefing: today's calendar, important unread emails, pending approvals and top 3 priorities. Notify me." },
  { name: "Weekly job scan", cron: "0 9 * * 1", instruction: "Search for new jobs matching my profile, save the top 5 with match scores and notify me.", agent_slug: "career" },
  { name: "Security review", cron: "0 20 * * 0", instruction: "Review account activity, API usage and backup status for the week and report anything unusual.", agent_slug: "security" },
];

function CreateDialog({ onCreated }: { onCreated: () => void }) {
  const { data: agents } = useApi<Agent[]>("/api/agents");
  const [open, setOpen] = useState(false);
  const [trigger, setTrigger] = useState("schedule");
  const [preset, setPreset] = useState<(typeof PRESETS)[number] | null>(null);
  const [secret, setSecret] = useState<{ path: string; secret: string } | null>(null);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
    let conditions: unknown = [];
    try { conditions = f.conditions ? JSON.parse(f.conditions) : []; } catch { toast.error("Conditions must be JSON"); return; }
    try {
      const w = await post<Workflow>("/api/automations", { name: f.name, description: f.description, trigger_type: trigger, cron: f.cron || null,
        timezone: f.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone, event_name: f.event_name || null, conditions,
        instruction: f.instruction, agent_slug: f.agent_slug || null });
      onCreated();
      if (w.webhook_secret && w.webhook_path) setSecret({ path: w.webhook_path, secret: w.webhook_secret });
      else setOpen(false);
      toast.success("Automation created");
    } catch (err) { toast.error((err as Error).message); }
  };
  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setSecret(null); setPreset(null); } }}>
      <DialogTrigger asChild><Button variant="gradient"><Plus />New automation</Button></DialogTrigger>
      <DialogContent title="New automation" description="LEXA runs the instruction through the normal agent pipeline, with the same permissions and approvals." className="max-w-xl">
        {secret ? (
          <div className="space-y-3 text-sm">
            <p>Webhook created. Copy the secret now — it won’t be shown again.</p>
            <Field label="URL path"><Input readOnly value={secret.path} /></Field>
            <Field label="Header X-Lexa-Secret"><Input readOnly value={secret.secret} /></Field>
            <Button variant="secondary" onClick={() => { void navigator.clipboard.writeText(secret.secret); toast("Copied"); }}><Copy />Copy secret</Button>
          </div>
        ) : (
          <form key={preset?.name || "blank"} onSubmit={submit} className="grid gap-3">
            <div className="flex flex-wrap gap-1.5">{PRESETS.map((p) => <button type="button" key={p.name} onClick={() => { setPreset(p); setTrigger("schedule"); }}
              className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:text-foreground">{p.name}</button>)}</div>
            <Field label="Name"><Input name="name" required defaultValue={preset?.name} /></Field>
            <Field label="Trigger"><Select value={trigger} onChange={(e) => setTrigger(e.target.value)}>
              <option value="schedule">Schedule (cron)</option><option value="event">LEXA event</option><option value="webhook">Webhook (e.g. from n8n)</option><option value="manual">Manual</option></Select></Field>
            {trigger === "schedule" && <div className="grid grid-cols-2 gap-3">
              <Field label="Cron" hint="min hour day month weekday"><Input name="cron" required defaultValue={preset?.cron || "0 9 * * 1-5"} className="font-mono" /></Field>
              <Field label="Timezone"><Input name="timezone" defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone} /></Field></div>}
            {trigger === "event" && <Field label="Event"><Select name="event_name">{["task.completed", "task.failed", "task.waiting_for_approval"].map((e) => <option key={e}>{e}</option>)}</Select></Field>}
            {(trigger === "event" || trigger === "webhook") && <Field label="Conditions (JSON, optional)" hint='e.g. [{"field":"title","op":"contains","value":"invoice"}]'><Textarea name="conditions" rows={2} className="font-mono text-xs" /></Field>}
            <Field label="Instruction"><Textarea name="instruction" required rows={4} defaultValue={preset?.instruction} /></Field>
            <Field label="Route to agent (optional)"><Select name="agent_slug" defaultValue={preset?.agent_slug || ""}><option value="">LEXA CORE decides</option>
              {agents?.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}</Select></Field>
            <Button type="submit" variant="gradient">Create</Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Runs({ id }: { id: string }) {
  const { data } = useApi<Task[]>(`/api/automations/${id}/runs`);
  if (!data?.length) return <p className="text-xs text-subtle">No runs yet.</p>;
  return <ul className="space-y-1">{data.slice(0, 5).map((t) => <li key={t.id}><Link href={`/tasks/${t.id}`} className="flex items-center gap-2 text-xs hover:opacity-80"><StatusBadge status={t.status} /><span className="text-subtle">{timeAgo(t.created_at)}</span></Link></li>)}</ul>;
}

export default function AutomationsPage() {
  const { data, reload } = useApi<Workflow[]>("/api/automations");
  const { confirm } = useConfirm();
  const [expanded, setExpanded] = useState<string | null>(null);
  const remove = async (w: Workflow) => {
    const ok = await confirm({ title: `Delete ${w.name}?`, description: "The automation and its schedule are removed. Past runs stay in the task history.",
      confirmLabel: "Delete automation", destructive: true });
    if (ok) void act(() => del(`/api/automations/${w.id}`), "Deleted");
  };
  const act = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); toast.success(msg); void reload(); } catch (e) { toast.error((e as Error).message); } };
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader icon={WfIcon} title="Automations" description="Recurring, scheduled, event-driven and webhook workflows — executed durably by the background worker."
        actions={<CreateDialog onCreated={() => void reload()} />} />
      {!data?.length ? <EmptyState icon={Zap} title="No automations yet" description="Start with a morning briefing or a weekly job scan." /> : (
        <div className="space-y-2">{data.map((w) => (
          <Card key={w.id}><CardContent className="pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <span role="img" className={`size-2 rounded-full ${w.enabled ? "bg-success" : "bg-subtle"}`} aria-label={w.enabled ? "enabled" : "paused"} />
              <button className="min-w-0 flex-1 text-left" onClick={() => setExpanded(expanded === w.id ? null : w.id)}>
                <p className="truncate text-sm font-medium">{w.name}</p>
                <p className="truncate text-xs text-subtle">{w.instruction}</p>
              </button>
              <Badge tone="accent">{w.trigger_type}</Badge>
              {w.cron && <Badge className="font-mono">{w.cron}</Badge>}
              {w.agent_slug && <Badge>{w.agent_slug}</Badge>}
              <span className="text-xs text-subtle">{w.next_run_at ? `next ${new Date(w.next_run_at).toLocaleString()}` : `${w.run_count} runs`}</span>
              <div className="flex gap-1">
                <Button size="icon" variant="ghost" aria-label={`Run ${w.name} now`} onClick={() => void act(() => post(`/api/automations/${w.id}/run`), "Started")}><Zap /></Button>
                <Button size="icon" variant="ghost" aria-label={`${w.enabled ? "Pause" : "Resume"} ${w.name}`} onClick={() => void act(() => post(`/api/automations/${w.id}/toggle`), w.enabled ? "Paused" : "Resumed")}>{w.enabled ? <Pause /> : <Play />}</Button>
                <Button size="icon" variant="ghost" aria-label={`Delete ${w.name}`} data-voice-confirms onClick={() => void remove(w)}><Trash2 /></Button>
              </div>
            </div>
            {expanded === w.id && <div className="mt-3 border-t border-border pt-3"><p className="mb-2 text-xs font-medium">Execution history</p><Runs id={w.id} />
              {w.webhook_path && <p className="mt-2 font-mono text-[11px] text-subtle">POST {w.webhook_path} with header X-Lexa-Secret</p>}</div>}
          </CardContent></Card>))}</div>)}
      <p className="mt-6 text-xs text-subtle">Tip: n8n workflows can trigger LEXA via webhook automations, and agents can trigger n8n workflows once n8n is connected in <Link href="/integrations" className="text-accent">Integrations</Link>.</p>
    </div>
  );
}
