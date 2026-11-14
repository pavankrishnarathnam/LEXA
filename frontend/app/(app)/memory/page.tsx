"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Brain, Download, Pencil, Pin, PinOff, Plus, Search, Trash2 } from "lucide-react";
import { useApi } from "@/hooks/use-api";
import { useConfirm } from "@/components/voice/confirm-provider";
import { api, del, post } from "@/services/api";
import { cn, timeAgo } from "@/lib/utils";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { useAuth } from "@/components/layout/auth";
import type { Memory } from "@/types";

const LABELS: Record<string, string> = { profile: "Profile", education: "Education", employment: "Employment", skills: "Skills", preferences: "Preferences",
  projects: "Projects", contacts: "Contacts", decisions: "Decisions", ongoing_tasks: "Ongoing", documents: "Documents", conversation_summaries: "Summaries", general: "General" };

function ProfileCard() {
  const { user, setUser } = useAuth();
  const p = user?.profile;
  const [saving, setSaving] = useState(false);
  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
    setSaving(true);
    try {
      const u = await api<typeof user>("/api/auth/me/profile", { method: "PATCH", json: {
        full_name: f.full_name, headline: f.headline, location: f.location, timezone: f.timezone, bio: f.bio,
        skills: f.skills.split(",").map((s) => s.trim()).filter(Boolean),
        career_preferences: { remote: f.remote || undefined, salary_min: f.salary_min ? Number(f.salary_min) : undefined,
          locations: f.locations ? f.locations.split(",").map((s) => s.trim()) : undefined, titles: f.titles ? f.titles.split(",").map((s) => s.trim()) : undefined } } });
      if (u) setUser(u);
      toast.success("Profile saved");
    } catch (err) { toast.error((err as Error).message); } finally { setSaving(false); }
  };
  const cp = p?.career_preferences || {};
  return (
    <Card><CardHeader><CardTitle>Personal & professional profile</CardTitle></CardHeader><CardContent>
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name"><Input name="full_name" defaultValue={user?.full_name} /></Field>
        <Field label="Headline"><Input name="headline" defaultValue={p?.headline} placeholder="Senior Backend Engineer" /></Field>
        <Field label="Location"><Input name="location" defaultValue={p?.location} /></Field>
        <Field label="Timezone"><Input name="timezone" defaultValue={p?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone} /></Field>
        <div className="sm:col-span-2"><Field label="Skills" hint="Comma separated — used for honest job matching"><Input name="skills" defaultValue={p?.skills?.join(", ")} /></Field></div>
        <div className="sm:col-span-2"><Field label="Bio"><Textarea name="bio" rows={3} defaultValue={p?.bio} /></Field></div>
        <Field label="Target titles"><Input name="titles" defaultValue={(cp.titles || []).join(", ")} /></Field>
        <Field label="Preferred locations"><Input name="locations" defaultValue={(cp.locations || []).join(", ")} /></Field>
        <Field label="Work mode"><Select name="remote" defaultValue={cp.remote || ""}><option value="">Any</option><option>remote</option><option>hybrid</option><option>onsite</option></Select></Field>
        <Field label="Minimum salary"><Input name="salary_min" type="number" defaultValue={cp.salary_min} /></Field>
        <div className="sm:col-span-2"><Button type="submit" variant="secondary" loading={saving}>Save profile</Button></div>
      </form></CardContent></Card>
  );
}

export default function MemoryPage() {
  const { prompt } = useConfirm();
  const [cat, setCat] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const { data, reload } = useApi<{ items: Memory[]; counts?: Record<string, number>; categories?: string[] }>(
    `/api/memory?limit=300${cat ? `&category=${cat}` : ""}${search ? `&q=${encodeURIComponent(search)}` : ""}`);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const add = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget; // currentTarget is null after the first await
    const f = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
    try {
      const r = await post<{ created: boolean }>("/api/memory", { content: f.content, category: f.category, pinned: f.pinned === "on" });
      toast.success(r.created ? "Remembered" : "Already known — merged");
      form.reset(); setAdding(false); void reload();
    } catch (err) { toast.error((err as Error).message); }
  };
  const update = async (m: Memory, body: Record<string, unknown>) => {
    try { await api(`/api/memory/${m.id}`, { method: "PATCH", json: body }); setEditing(null); void reload(); } catch (e) { toast.error((e as Error).message); }
  };
  const retention = async () => {
    const answer = await prompt({ title: "Delete old memories", label: "Delete unpinned memories not updated in how many days?",
      description: "Pinned memories are always kept.", defaultValue: "365", type: "number", confirmLabel: "Delete", destructive: true });
    const days = Number(answer);
    if (!answer || !days) return;
    const r = await post<{ deleted: number }>("/api/memory/retention", { older_than_days: days });
    toast.success(`Deleted ${r.deleted} memories`); void reload();
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader icon={Brain} title="Memory Center" description="What LEXA knows about you. Everything is editable, deletable and exportable. Secrets are never stored."
        actions={<>
          <Button variant="secondary" asChild><a href="/api/export"><Download />Export all data</a></Button>
          <Button variant="ghost" data-voice-confirms onClick={() => void retention()}>Retention…</Button>
          <Dialog open={adding} onOpenChange={setAdding}><DialogTrigger asChild><Button variant="gradient"><Plus />Add memory</Button></DialogTrigger>
            <DialogContent title="Teach LEXA something"><form onSubmit={add} className="grid gap-3">
              <Field label="Fact"><Textarea name="content" required rows={3} placeholder="I prefer meetings after 11am" /></Field>
              <Field label="Category"><Select name="category" defaultValue="preferences">{Object.entries(LABELS).filter(([k]) => k !== "documents").map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="pinned" className="accent-[var(--primary)]" />Pin (always included in context)</label>
              <Button type="submit" variant="gradient">Save</Button></form></DialogContent></Dialog></>} />
      <ProfileCard />
      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={(e) => { e.preventDefault(); setSearch(q); }} className="relative">
          <Search className="absolute left-2.5 top-2.5 size-4 text-subtle" />
          <Input aria-label="Semantic search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Semantic search…" className="w-64 pl-8" />
        </form>
        <button onClick={() => { setCat(""); setSearch(""); setQ(""); }} className={cn("rounded-md px-2.5 py-1 text-xs", !cat ? "bg-surface-2 text-foreground" : "text-muted")}>All</button>
        {Object.entries(LABELS).map(([k, v]) => (
          <button key={k} onClick={() => setCat(k)} className={cn("rounded-md px-2.5 py-1 text-xs", cat === k ? "bg-surface-2 text-foreground" : "text-muted hover:text-foreground")}>
            {v}{data?.counts?.[k] ? <span className="ml-1 text-subtle">{data.counts[k]}</span> : null}</button>))}
      </div>
      {!data?.items.length ? <EmptyState icon={Brain} title="No memories here" description="LEXA learns from what you tell it (when auto-memory is on) and from what you add." /> : (
        <ul className="grid gap-2 md:grid-cols-2">{data.items.map((m) => (
          <li key={m.id} className="group rounded-xl border border-border bg-surface p-3">
            {editing === m.id ? (
              <div className="space-y-2"><Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} />
                <div className="flex gap-2"><Button size="sm" onClick={() => void update(m, { content: draft })}>Save</Button><Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div></div>
            ) : (<>
              <p className="text-sm">{m.content}</p>
              <div className="mt-2 flex items-center gap-1.5 text-[11px] text-subtle">
                <Badge>{LABELS[m.category] || m.category}</Badge><Badge tone={m.source === "user" ? "primary" : "neutral"}>{m.source}</Badge>
                {m.score != null && <span>relevance {m.score}</span>}<span>{timeAgo(m.updated_at)}</span>
                <span className="ml-auto flex gap-1.5 opacity-70 focus-within:opacity-100 group-hover:opacity-100">
                  <button aria-label={`Edit memory: ${m.content.slice(0, 40)}`} onClick={() => { setEditing(m.id); setDraft(m.content); }}><Pencil className="size-3.5" /></button>
                  <button aria-label={`${m.pinned ? "Unpin" : "Pin"} memory: ${m.content.slice(0, 40)}`} onClick={() => void update(m, { pinned: !m.pinned })}>{m.pinned ? <PinOff className="size-3.5 text-primary" /> : <Pin className="size-3.5" />}</button>
                  <button aria-label={`Delete memory: ${m.content.slice(0, 40)}`} className="hover:text-danger" onClick={() => void del(`/api/memory/${m.id}`).then(() => reload())}><Trash2 className="size-3.5" /></button></span>
              </div></>)}
          </li>))}</ul>)}
    </div>
  );
}
