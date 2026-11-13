"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Plus, Trash2, Wallet } from "lucide-react";
import { useApi } from "@/hooks/use-api";
import { del, post } from "@/services/api";
import { PageHeader, Stat } from "@/components/ui/misc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input, Select } from "@/components/ui/input";
import { AgentActions } from "@/components/workspace/agent-actions";

interface Entry { id: string; kind: string; amount: number; currency: string; category: string; description: string; occurred_on: string | null; due_on: string | null; recurrence: string | null }
const COLORS = ["#7c5cff", "#4d8dff", "#22c55e", "#f59e0b", "#ef4444", "#14b8a6", "#a855f7", "#64748b"];

export default function FinancePage() {
  const entries = useApi<Entry[]>("/api/finance/entries");
  const summary = useApi<{ income: number; expense: number; by_category: Record<string, number>; monthly_subscriptions: number }>("/api/finance/summary");
  const [busy, setBusy] = useState(false);
  const add = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
    setBusy(true);
    try {
      await post("/api/finance/entries", { ...f, amount: Number(f.amount), recurrence: f.recurrence || null, due_on: f.due_on || null, occurred_on: f.occurred_on || null });
      form.reset(); void entries.reload(); void summary.reload();
    } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  const pie = Object.entries(summary.data?.by_category || {}).map(([name, value]) => ({ name, value }));
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader icon={Wallet} title="Finance" description="Track spending, bills and subscriptions. LEXA analyzes and reminds — it never moves money." />
      <AgentActions agent="finance" placeholder="e.g. Build me a monthly budget for ₹1.2L income with 25% savings"
        actions={[{ label: "Spending analysis", prompt: "Analyze my spending for the last 30 days and suggest three concrete savings." },
          { label: "Subscription audit", prompt: "Audit my active subscriptions and flag overlaps or ones I may not need." },
          { label: "Bill reminders", prompt: "Create reminders 2 days before each upcoming bill is due." }]} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Income (30d)" value={(summary.data?.income ?? 0).toFixed(2)} />
        <Stat label="Spending (30d)" value={(summary.data?.expense ?? 0).toFixed(2)} />
        <Stat label="Net" value={((summary.data?.income ?? 0) - (summary.data?.expense ?? 0)).toFixed(2)} />
        <Stat label="Subscriptions / mo" value={(summary.data?.monthly_subscriptions ?? 0).toFixed(2)} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2"><CardHeader><CardTitle>Ledger</CardTitle></CardHeader><CardContent>
          <form onSubmit={add} className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-6">
            <Field label="Type"><Select name="kind">{["expense", "income", "bill", "subscription"].map((k) => <option key={k}>{k}</option>)}</Select></Field>
            <Field label="Amount"><Input name="amount" type="number" step="0.01" min="0.01" required /></Field>
            <Field label="Currency"><Input name="currency" defaultValue="USD" /></Field>
            <Field label="Category"><Input name="category" placeholder="food" /></Field>
            <Field label="Description"><Input name="description" /></Field>
            <Field label="Repeats"><Select name="recurrence"><option value="">—</option><option>monthly</option><option>yearly</option><option>weekly</option></Select></Field>
            <Field label="Date"><Input name="occurred_on" type="date" /></Field>
            <Field label="Due (bills)"><Input name="due_on" type="date" /></Field>
            <div className="col-span-2 flex items-end sm:col-span-4"><Button type="submit" variant="secondary" loading={busy}><Plus />Add entry</Button></div>
          </form>
          <ul className="divide-y divide-border text-sm">{entries.data?.map((e) => (
            <li key={e.id} className="flex items-center gap-3 py-2"><Badge tone={e.kind === "income" ? "success" : e.kind === "subscription" ? "accent" : e.kind === "bill" ? "warning" : "neutral"}>{e.kind}</Badge>
              <span className="min-w-0 flex-1 truncate">{e.description || e.category}</span><span className="text-xs text-subtle">{e.category}</span>
              <span className="w-28 text-right tabular-nums">{e.kind === "income" ? "+" : "−"}{e.amount.toFixed(2)} {e.currency}</span>
              <button aria-label="Delete entry" className="text-subtle hover:text-danger" onClick={() => void del(`/api/finance/entries/${e.id}`).then(() => { void entries.reload(); void summary.reload(); })}><Trash2 className="size-3.5" /></button></li>))}</ul>
          {!entries.data?.length && <p className="py-6 text-center text-sm text-muted">No entries yet.</p>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Spending by category</CardTitle></CardHeader><CardContent className="h-72">
          {pie.length ? <ResponsiveContainer><PieChart><Pie data={pie} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}>
            {pie.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} stroke="none" />)}</Pie>
            <Tooltip contentStyle={{ background: "var(--elevated)", border: "1px solid var(--border-strong)", borderRadius: 8, fontSize: 12 }} /></PieChart></ResponsiveContainer>
            : <p className="pt-24 text-center text-sm text-muted">No spending recorded in the last 30 days.</p>}
        </CardContent></Card>
      </div>
    </div>
  );
}
