"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Briefcase, ExternalLink, FileText, Plus, Upload, X } from "lucide-react";
import { useApi } from "@/hooks/use-api";
import { api, del, post, upload } from "@/services/api";
import { cn, timeAgo } from "@/lib/utils";
import { EmptyState, PageHeader, Stat } from "@/components/ui/misc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { AgentActions, AgentTasks } from "@/components/workspace/agent-actions";
import type { Application, Doc, Job } from "@/types";

function ScoreRing({ score }: { score: number | null }) {
  const s = score ?? 0;
  const color = s >= 75 ? "var(--success)" : s >= 50 ? "var(--warning)" : "var(--danger)";
  return (
    <div className="relative grid size-12 shrink-0 place-items-center" aria-label={`Match score ${s}%`}>
      <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90"><circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--border-strong)" strokeWidth="3" />
        <circle cx="18" cy="18" r="15.5" fill="none" stroke={color} strokeWidth="3" strokeDasharray={`${(s / 100) * 97.4} 97.4`} strokeLinecap="round" /></svg>
      <span className="text-xs font-semibold tabular-nums">{score == null ? "–" : Math.round(s)}</span>
    </div>
  );
}

function AddJob({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
    setBusy(true);
    try {
      await post("/api/career/jobs", { ...f, required_skills: f.required_skills.split(",").map((s) => s.trim()).filter(Boolean),
        salary_min: f.salary_min ? Number(f.salary_min) : null, salary_max: f.salary_max ? Number(f.salary_max) : null });
      toast.success("Job saved and scored"); setOpen(false); onAdded();
    } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="secondary"><Plus />Add job</Button></DialogTrigger>
      <DialogContent title="Track a job" description="Paste details from a posting. LEXA scores the fit against your profile.">
        <form onSubmit={submit} className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2"><Field label="Title"><Input name="title" required /></Field><Field label="Company"><Input name="company" required /></Field></div>
          <Field label="URL"><Input name="url" type="url" /></Field>
          <div className="grid gap-3 sm:grid-cols-2"><Field label="Location"><Input name="location" /></Field>
            <Field label="Work mode"><Select name="remote_type" defaultValue="unknown">{["remote", "hybrid", "onsite", "unknown"].map((r) => <option key={r}>{r}</option>)}</Select></Field></div>
          <Field label="Required skills" hint="Comma separated"><Input name="required_skills" /></Field>
          <div className="grid grid-cols-3 gap-3"><Field label="Salary min"><Input name="salary_min" type="number" /></Field><Field label="Salary max"><Input name="salary_max" type="number" /></Field><Field label="Currency"><Input name="salary_currency" placeholder="USD" /></Field></div>
          <Field label="Description"><Textarea name="description" rows={5} /></Field>
          <Button type="submit" variant="gradient" loading={busy}>Save job</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function CareerPage() {
  const jobs = useApi<Job[]>("/api/career/jobs");
  const apps = useApi<Application[]>("/api/career/applications");
  const stats = useApi<{ jobs_tracked: number; applications: number; funnel: Record<string, number>; response_rate: number | null; avg_match_score: number | null; top_missing_skills: [string, number][] }>("/api/career/analytics");
  const docs = useApi<Doc[]>("/api/documents");
  const [selected, setSelected] = useState<Job | null>(null);

  const setStatus = async (j: Job, status: string) => {
    await api(`/api/career/jobs/${j.id}`, { method: "PATCH", json: { status } });
    void jobs.reload(); void stats.reload();
  };
  const appStatus = async (a: Application, status: string) => {
    try { await api(`/api/career/applications/${a.id}`, { method: "PATCH", json: { status } }); void apps.reload(); void stats.reload(); }
    catch (e) { toast.error((e as Error).message); }
  };
  const uploadResume = async (files: FileList | null) => {
    const f = files?.[0]; if (!f) return;
    const fd = new FormData(); fd.append("file", f); fd.append("kind", "resume");
    try { await upload("/api/documents", fd); toast.success("Resume uploaded and indexed"); void docs.reload(); } catch (e) { toast.error((e as Error).message); }
  };
  const resumes = (docs.data || []).filter((d) => d.kind === "resume" || d.kind === "cover_letter");
  const funnel = Object.entries(stats.data?.funnel || {}).map(([k, v]) => ({ stage: k, count: v }));

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader icon={Briefcase} title="Career Center" description="Opportunities, honest match scores, tailored applications and tracking. Submissions always need your approval."
        actions={<AddJob onAdded={() => { void jobs.reload(); void stats.reload(); }} />} />
      <AgentActions agent="career" placeholder="e.g. Find senior React roles in Berlin or remote EU, €80k+"
        actions={[{ label: "Find matching jobs", prompt: "Search company career pages and job boards for roles matching my profile and preferences. Save the best 5 with match scores." },
          { label: "Tailor my resume", prompt: "Tailor my latest resume for my highest-scoring saved job without inventing anything, and save it as a resume document." },
          { label: "Prepare an interview", prompt: "Prepare me for an interview for my top saved job: likely questions, my best stories from my profile, and questions to ask." },
          { label: "Check recruiter replies", prompt: "Check my email for recruiter replies in the last 7 days and update my application statuses accordingly." }]} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Jobs tracked" value={stats.data?.jobs_tracked ?? "–"} />
        <Stat label="Applications" value={stats.data?.applications ?? "–"} />
        <Stat label="Response rate" value={stats.data?.response_rate != null ? `${stats.data.response_rate}%` : "–"} sub="interviews + offers / submitted" />
        <Stat label="Avg. match" value={stats.data?.avg_match_score != null ? `${stats.data.avg_match_score}%` : "–"} />
      </div>
      <Tabs defaultValue="jobs">
        <TabsList><TabsTrigger value="jobs">Opportunities</TabsTrigger><TabsTrigger value="apps">Applications</TabsTrigger><TabsTrigger value="docs">Resume library</TabsTrigger><TabsTrigger value="analytics">Analytics</TabsTrigger><TabsTrigger value="activity">Activity</TabsTrigger></TabsList>
        <TabsContent value="jobs">
          {!jobs.data?.length ? <EmptyState icon={Briefcase} title="No opportunities yet" description="Ask the Career Agent to search, or add a job manually." /> : (
            <div className="grid gap-4 lg:grid-cols-5">
              <ul className="space-y-2 lg:col-span-2">{jobs.data.filter((j) => j.status !== "dismissed").map((j) => (
                <li key={j.id}><button onClick={() => setSelected(j)} className={cn("flex w-full items-center gap-3 rounded-xl border bg-surface p-3 text-left transition",
                  selected?.id === j.id ? "border-primary/50" : "border-border hover:border-border-strong")}>
                  <ScoreRing score={j.match_score} />
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{j.title}</span>
                    <span className="block truncate text-xs text-muted">{j.company} · {j.location || j.remote_type}</span></span>
                  <Badge tone={j.status === "applied" ? "success" : j.status === "saved" ? "primary" : "neutral"}>{j.status}</Badge>
                </button></li>))}</ul>
              <Card className="lg:col-span-3">{selected ? (<>
                <CardHeader><div className="min-w-0"><CardTitle className="text-base">{selected.title}</CardTitle><p className="text-sm text-muted">{selected.company} · {selected.location} · {selected.remote_type}</p></div>
                  <button onClick={() => setSelected(null)} aria-label="Close"><X className="size-4 text-subtle" /></button></CardHeader>
                <CardContent className="space-y-4 text-sm">
                  <div className="flex flex-wrap gap-2">{selected.url && <Button size="sm" variant="secondary" asChild><a href={selected.url} target="_blank" rel="noopener noreferrer"><ExternalLink />Posting</a></Button>}
                    <Button size="sm" variant="secondary" onClick={() => void setStatus(selected, "saved")}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => void setStatus(selected, "dismissed")}>Dismiss</Button></div>
                  <div><p className="mb-1 text-xs font-medium">Match analysis · {selected.match_score ?? "–"}%</p>
                    <div className="flex flex-wrap gap-1">{selected.match_analysis.matched_skills?.map((s) => <Badge key={s} tone="success">✓ {s}</Badge>)}
                      {selected.match_analysis.missing_skills?.map((s) => <Badge key={s} tone="danger">✗ {s}</Badge>)}</div>
                    {selected.match_analysis.preference_notes?.map((n) => <p key={n} className="mt-1 text-xs text-warning">{n}</p>)}</div>
                  {selected.salary_max && <p className="text-xs text-muted">Salary: {selected.salary_min}–{selected.salary_max} {selected.salary_currency}</p>}
                  <p className="max-h-72 overflow-y-auto whitespace-pre-wrap text-xs text-muted scrollbar-thin">{selected.description || "No description saved."}</p>
                </CardContent></>) : <CardContent className="py-16 text-center text-sm text-muted">Select a job to see the analysis.</CardContent>}</Card>
            </div>)}
        </TabsContent>
        <TabsContent value="apps">
          {!apps.data?.length ? <EmptyState icon={FileText} title="No applications" description="Ask the Career Agent to prepare an application for a saved job." /> : (
            <ul className="space-y-2">{apps.data.map((a) => (
              <li key={a.id} className="rounded-xl border border-border bg-surface p-4">
                <div className="flex flex-wrap items-center gap-3"><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{a.job?.title}</span><span className="text-xs text-muted">{a.job?.company}</span></span>
                  <Select aria-label="Application status" value={a.status} onChange={(e) => void appStatus(a, e.target.value)} className="h-8 w-40 text-xs">
                    {["draft", "ready", "submitted", "interviewing", "offer", "rejected", "withdrawn"].map((s) => <option key={s}>{s}</option>)}</Select>
                  {a.job?.url && <Button size="sm" variant="secondary" asChild><a href={a.job.url} target="_blank" rel="noopener noreferrer"><ExternalLink />Apply on site</a></Button>}</div>
                {a.cover_letter && <details className="mt-2"><summary className="cursor-pointer text-xs text-accent">Cover letter</summary><p className="mt-2 whitespace-pre-wrap text-xs text-muted">{a.cover_letter}</p></details>}
                <p className="mt-2 text-[11px] text-subtle">{a.timeline.map((t) => `${t.event} ${timeAgo(t.at)}`).join(" → ")}</p>
              </li>))}</ul>)}
        </TabsContent>
        <TabsContent value="docs">
          <div className="mb-3"><label className="inline-flex cursor-pointer"><input type="file" hidden accept=".pdf,.docx,.md,.txt" onChange={(e) => void uploadResume(e.target.files)} />
            <span className="inline-flex h-9 items-center gap-2 rounded-lg border border-border-strong px-4 text-sm hover:bg-surface-2"><Upload className="size-4" />Upload resume</span></label></div>
          {resumes.length ? <ul className="divide-y divide-border rounded-xl border border-border bg-surface">{resumes.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-4 py-2.5 text-sm"><FileText className="size-4 text-primary" /><span className="flex-1 truncate">{d.filename}</span><Badge>{d.kind}</Badge>
              <a className="text-xs text-accent hover:underline" href={`/api/documents/${d.id}/download`}>Download</a>
              <button className="text-xs text-subtle hover:text-danger" onClick={() => void del(`/api/documents/${d.id}`).then(() => docs.reload())}>Delete</button></li>))}</ul>
            : <EmptyState icon={FileText} title="No resumes yet" description="Upload your resume so agents can tailor applications from real experience." />}
        </TabsContent>
        <TabsContent value="analytics">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card><CardHeader><CardTitle>Application funnel</CardTitle></CardHeader><CardContent className="h-64">
              {funnel.length ? <ResponsiveContainer><BarChart data={funnel}><XAxis dataKey="stage" stroke="var(--subtle)" fontSize={11} /><YAxis allowDecimals={false} stroke="var(--subtle)" fontSize={11} />
                <Tooltip contentStyle={{ background: "var(--elevated)", border: "1px solid var(--border-strong)", borderRadius: 8, fontSize: 12 }} /><Bar dataKey="count" fill="var(--primary)" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer>
                : <p className="pt-20 text-center text-sm text-muted">No applications yet.</p>}</CardContent></Card>
            <Card><CardHeader><CardTitle>Most requested skills you’re missing</CardTitle></CardHeader><CardContent>
              {stats.data?.top_missing_skills.length ? <ul className="space-y-2">{stats.data.top_missing_skills.map(([s, n]) => (
                <li key={s} className="flex items-center gap-3 text-sm"><span className="w-32 truncate">{s}</span><div className="h-1.5 flex-1 rounded-full bg-surface-2"><div className="h-full rounded-full bg-grad" style={{ width: `${Math.min(100, n * 20)}%` }} /></div><span className="text-xs text-subtle">{n}</span></li>))}</ul>
                : <p className="py-10 text-center text-sm text-muted">Save some jobs to see skill gaps.</p>}</CardContent></Card>
          </div>
        </TabsContent>
        <TabsContent value="activity"><AgentTasks agent="career" /></TabsContent>
      </Tabs>
    </div>
  );
}
