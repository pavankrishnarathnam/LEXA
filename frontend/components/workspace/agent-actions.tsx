"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowUp, Sparkles } from "lucide-react";
import { runInstruction } from "@/services/api";
import { useApi } from "@/hooks/use-api";
import { timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/misc";
import type { Integration, Task } from "@/types";

/** Prompt box + quick actions routed to one specialist agent through LEXA CORE. */
export function AgentActions({ agent, placeholder, actions }: { agent: string; placeholder: string; actions: { label: string; prompt: string }[] }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (prompt: string) => {
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      const { conversationId } = await runInstruction(prompt.trim(), agent);
      router.push(`/assistant/${conversationId}`);
    } catch (e) { toast.error((e as Error).message); setBusy(false); }
  };
  return (
    <Card>
      <CardContent className="pt-5">
        <form onSubmit={(e) => { e.preventDefault(); void run(text); }} className="flex items-center gap-2 rounded-xl border border-border-strong bg-background/50 p-1.5 pl-3 focus-within:border-primary/60">
          <Sparkles className="size-4 shrink-0 text-primary" />
          <label className="sr-only" htmlFor={`ask-${agent}`}>{placeholder}</label>
          <input id={`ask-${agent}`} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle" />
          <Button type="submit" size="icon" variant="gradient" aria-label="Run" loading={busy}>{!busy && <ArrowUp />}</Button>
        </form>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {actions.map((a) => (
            <button key={a.label} disabled={busy} onClick={() => void run(a.prompt)}
              className="rounded-lg border border-border px-2.5 py-1 text-xs text-muted transition hover:border-primary/40 hover:text-foreground">{a.label}</button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function AgentTasks({ agent, title = "Recent work" }: { agent: string; title?: string }) {
  const { data } = useApi<{ items: Task[] }>("/api/tasks?limit=100");
  const items = (data?.items || []).filter((t) => t.assigned_agents.includes(agent)).slice(0, 8);
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>
        {items.length ? <ul className="divide-y divide-border">{items.map((t) => (
          <li key={t.id}><Link href={`/tasks/${t.id}`} className="flex items-center gap-3 py-2 text-sm hover:opacity-80">
            <StatusBadge status={t.status} /><span className="min-w-0 flex-1 truncate">{t.title}</span>
            <span className="text-xs text-subtle">{timeAgo(t.created_at)}</span></Link></li>))}</ul>
          : <p className="py-4 text-center text-sm text-muted">No {agent} tasks yet.</p>}
      </CardContent>
    </Card>
  );
}

export function IntegrationStatus({ keys }: { keys: string[] }) {
  const { data } = useApi<Integration[]>("/api/integrations");
  const items = (data || []).filter((i) => keys.includes(i.key));
  return (
    <Card>
      <CardHeader><CardTitle>Connections</CardTitle><Link href="/integrations" className="text-xs text-accent hover:underline">Manage</Link></CardHeader>
      <CardContent>
        <ul className="space-y-2">{items.map((i) => (
          <li key={i.key} className="flex items-center gap-2 text-sm">
            <span className={`size-2 rounded-full ${i.status === "connected" ? "bg-success" : i.status === "error" ? "bg-danger" : "bg-subtle"}`} />
            <span className="flex-1">{i.name}</span><span className="text-xs text-subtle">{i.account_label || i.status.replace("_", " ")}</span>
          </li>))}</ul>
      </CardContent>
    </Card>
  );
}
