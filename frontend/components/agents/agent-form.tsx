"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Save } from "lucide-react";
import { useApi } from "@/hooks/use-api";
import { api, post } from "@/services/api";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { AGENT_ICON_NAMES, AgentIcon } from "@/components/layout/agent-icon";
import { cn } from "@/lib/utils";
import type { Agent, ToolInfo } from "@/types";

const MODELS = ["", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2", "gpt-5.1", "gpt-5-mini"];
const RISK_TONE: Record<string, "success" | "neutral" | "warning" | "danger"> = { read: "success", internal: "neutral", external: "warning", sensitive: "danger" };

export function AgentForm({ agent }: { agent?: Agent }) {
  const router = useRouter();
  const isNew = !agent;
  const { data: tools } = useApi<ToolInfo[]>("/api/agents/tools");
  const [f, setF] = useState({
    slug: agent?.slug || "", name: agent?.name || "", description: agent?.description || "", role: agent?.role || "",
    icon: agent?.icon || "bot", system_prompt: agent?.system_prompt || "", model: agent?.model || "", effort: agent?.effort || "",
    tools: new Set<string>([...(agent?.tools || []), ...(agent?.web_search ? ["web_search"] : [])]),
    permission_mode: agent?.permission_mode || "", memory_access: agent?.memory_access || "read",
    max_tool_iterations: agent?.max_tool_iterations ?? 8, max_cost_usd_per_run: agent?.max_cost_usd_per_run ?? 1,
    autonomy_rules: JSON.stringify(agent?.autonomy_rules || [], null, 2), enabled: agent?.enabled ?? true,
  });
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  const grouped = useMemo(() => {
    const g: Record<string, ToolInfo[]> = {};
    tools?.forEach((t) => (g[t.category] ||= []).push(t));
    return g;
  }, [tools]);

  const save = async () => {
    let rules: unknown;
    try { rules = JSON.parse(f.autonomy_rules || "[]"); if (!Array.isArray(rules)) throw new Error(); }
    catch { toast.error("Autonomy rules must be a JSON array"); return; }
    setSaving(true);
    const body = {
      name: f.name, description: f.description, system_prompt: f.system_prompt, model: f.model || null,
      effort: f.effort || null, tools: [...f.tools], permission_mode: f.permission_mode || null, memory_access: f.memory_access,
      max_tool_iterations: Number(f.max_tool_iterations), max_cost_usd_per_run: Number(f.max_cost_usd_per_run),
      autonomy_rules: rules, enabled: f.enabled,
    };
    try {
      if (isNew) {
        const a = await post<Agent>("/api/agents", { ...body, slug: f.slug || undefined, role: f.role, icon: f.icon });
        toast.success("Agent created");
        router.push(`/agents/${a.slug}`);
      } else {
        await api(`/api/agents/${agent.slug}`, { method: "PATCH", json: body });
        toast.success("Agent saved");
        router.refresh();
      }
    } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card><CardHeader><CardTitle>Identity & instructions</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="a-name"><Input id="a-name" value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
              {isNew ? <Field label="Slug" htmlFor="a-slug" hint="lowercase, used for routing"><Input id="a-slug" value={f.slug} placeholder="e.g. travel-planner"
                onChange={(e) => set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "-"))} /></Field>
                : <Field label="Slug"><Input value={f.slug} disabled /></Field>}
            </div>
            {isNew && <Field label="Role" htmlFor="a-role"><Input id="a-role" value={f.role} onChange={(e) => set("role", e.target.value)} placeholder="e.g. Travel Planner" /></Field>}
            <Field label="Description" htmlFor="a-desc" hint="LEXA CORE reads this to decide when to delegate to this agent.">
              <Textarea id="a-desc" value={f.description} onChange={(e) => set("description", e.target.value)} rows={2} /></Field>
            <Field label="System prompt" htmlFor="a-prompt" hint="Saved as a new version; global safety policies are always appended.">
              <Textarea id="a-prompt" value={f.system_prompt} onChange={(e) => set("system_prompt", e.target.value)} rows={12} className="font-mono text-xs" /></Field>
            {isNew && (
              <div><p className="mb-1.5 text-xs font-medium text-muted">Icon</p>
                <div className="flex flex-wrap gap-1.5">{AGENT_ICON_NAMES.map((n) => (
                  <button key={n} type="button" onClick={() => set("icon", n)} aria-label={n} aria-pressed={f.icon === n}
                    className={cn("grid size-9 place-items-center rounded-lg border", f.icon === n ? "border-primary bg-primary/10" : "border-border")}>
                    <AgentIcon name={n} className="size-4" /></button>))}</div></div>
            )}
          </CardContent></Card>

        <Card><CardHeader><div><CardTitle>Tools</CardTitle><CardDescription>Agents can only use the tools you assign. External and sensitive tools are governed by permission mode and approvals.</CardDescription></div></CardHeader>
          <CardContent className="space-y-4">
            {Object.entries(grouped).map(([cat, list]) => (
              <fieldset key={cat}><legend className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-subtle">{cat}</legend>
                <div className="grid gap-1.5 sm:grid-cols-2">{list.map((t) => {
                  const on = f.tools.has(t.name);
                  return (
                    <label key={t.name} className={cn("flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-xs", on ? "border-primary/40 bg-primary/5" : "border-border")}>
                      <input type="checkbox" className="mt-0.5 accent-[var(--primary)]" checked={on} onChange={() => {
                        const s = new Set(f.tools); if (on) s.delete(t.name); else s.add(t.name); set("tools", s); }} />
                      <span className="min-w-0"><span className="flex items-center gap-1.5 font-mono text-[11px] text-foreground">{t.name}
                        <Badge tone={RISK_TONE[t.risk]}>{t.risk}</Badge>{t.integration && <Badge>{t.integration}</Badge>}</span>
                        <span className="mt-0.5 line-clamp-2 block text-muted">{t.description}</span></span>
                    </label>);
                })}</div></fieldset>
            ))}
          </CardContent></Card>
      </div>

      <div className="space-y-4">
        <Card><CardHeader><CardTitle>Configuration</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <label className="flex items-center justify-between text-sm">Enabled<Switch checked={f.enabled} onCheckedChange={(v) => set("enabled", v)} /></label>
            <Field label="Model" htmlFor="a-model" hint="Empty = system default with automatic fallback.">
              <Select id="a-model" value={f.model} onChange={(e) => set("model", e.target.value)}>
                {MODELS.map((m) => <option key={m} value={m}>{m || "Default"}</option>)}</Select></Field>
            <Field label="Effort" htmlFor="a-effort"><Select id="a-effort" value={f.effort} onChange={(e) => set("effort", e.target.value)}>
              {["", "low", "medium", "high", "xhigh", "max"].map((m) => <option key={m} value={m}>{m || "Default"}</option>)}</Select></Field>
            <Field label="Permission mode" htmlFor="a-perm" hint="Can only restrict your account-level mode, never widen it.">
              <Select id="a-perm" value={f.permission_mode} onChange={(e) => set("permission_mode", e.target.value)}>
                <option value="">Inherit account setting</option><option value="read_analyze">Read & analyze</option>
                <option value="prepare_approve">Prepare & approve</option><option value="rule_autonomy">Rule-based autonomy</option></Select></Field>
            <Field label="Memory access" htmlFor="a-mem"><Select id="a-mem" value={f.memory_access} onChange={(e) => set("memory_access", e.target.value)}>
              <option value="none">None</option><option value="read">Read</option><option value="read_write">Read & write</option></Select></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Max tool iterations" htmlFor="a-it"><Input id="a-it" type="number" min={1} max={25} value={f.max_tool_iterations} onChange={(e) => set("max_tool_iterations", Number(e.target.value))} /></Field>
              <Field label="Max $ / run" htmlFor="a-cost"><Input id="a-cost" type="number" step="0.1" min={0.01} value={f.max_cost_usd_per_run} onChange={(e) => set("max_cost_usd_per_run", Number(e.target.value))} /></Field>
            </div>
            <Field label="Autonomy rules (JSON)" htmlFor="a-rules" hint={'Used only in rule-based autonomy, e.g. [{"tool":"gmail_create_draft"},{"tool":"gmail_send","recipient_patterns":["*@mycompany.com"],"max_per_day":5}]'}>
              <Textarea id="a-rules" value={f.autonomy_rules} onChange={(e) => set("autonomy_rules", e.target.value)} rows={5} className="font-mono text-[11px]" /></Field>
          </CardContent></Card>
        <Button variant="gradient" className="w-full" onClick={() => void save()} loading={saving}><Save />{isNew ? "Create agent" : "Save changes"}</Button>
      </div>
    </div>
  );
}
