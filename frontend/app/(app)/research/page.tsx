"use client";
import { useState } from "react";
import { FileText, Search, Upload } from "lucide-react";
import { toast } from "sonner";
import { useApi } from "@/hooks/use-api";
import { api, upload } from "@/services/api";
import { timeAgo } from "@/lib/utils";
import { EmptyState, Md, PageHeader } from "@/components/ui/misc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AgentActions, AgentTasks } from "@/components/workspace/agent-actions";
import type { Doc } from "@/types";

export default function ResearchPage() {
  const docs = useApi<Doc[]>("/api/documents");
  const [open, setOpen] = useState<{ doc: Doc; text: string } | null>(null);
  const reports = (docs.data || []).filter((d) => d.kind === "report");
  const sources = (docs.data || []).filter((d) => d.kind === "general");
  const view = async (d: Doc) => setOpen({ doc: d, text: (await api<{ text_content: string }>(`/api/documents/${d.id}`)).text_content });
  const onUpload = async (files: FileList | null) => {
    for (const f of Array.from(files || [])) {
      const fd = new FormData(); fd.append("file", f);
      try { await upload("/api/documents", fd); } catch (e) { toast.error((e as Error).message); }
    }
    void docs.reload();
  };
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader icon={Search} title="Research Center" description="Multi-source research with citations. Facts, estimates and assumptions are labelled separately." />
      <AgentActions agent="research" placeholder="What should I research? e.g. Market size of AI note-taking apps in India"
        actions={[{ label: "Competitor analysis", prompt: "Do a competitor analysis for my current project: main competitors, positioning, pricing, strengths/weaknesses. Cite sources and save a report." },
          { label: "Technical deep-dive", prompt: "Research current best practices for running PostgreSQL with pgvector at scale. Cite sources and save a report." },
          { label: "Weekly industry news", prompt: "Summarize this week's most important news in my industry with sources." },
          { label: "Analyze a document", prompt: "Analyze my most recently uploaded document: key points, risks, and open questions." }]} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2"><CardHeader><CardTitle>Research reports</CardTitle></CardHeader><CardContent>
          {reports.length ? <ul className="divide-y divide-border">{reports.map((d) => (
            <li key={d.id}><button onClick={() => void view(d)} className="flex w-full items-center gap-3 py-2.5 text-left text-sm hover:opacity-80">
              <FileText className="size-4 text-primary" /><span className="flex-1 truncate">{d.filename}</span><span className="text-xs text-subtle">{timeAgo(d.created_at)}</span></button></li>))}</ul>
            : <EmptyState icon={FileText} title="No reports yet" description="Reports saved by the Research Agent appear here." />}
          {open && <div className="mt-4 rounded-xl border border-border p-4"><div className="mb-2 flex items-center justify-between"><p className="font-medium">{open.doc.filename}</p>
            <button className="text-xs text-subtle" onClick={() => setOpen(null)}>Close</button></div><Md>{open.text}</Md></div>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Sources & documents</CardTitle>
          <label className="cursor-pointer text-xs text-accent hover:underline"><input type="file" hidden multiple onChange={(e) => void onUpload(e.target.files)} /><Upload className="mr-1 inline size-3" />Upload</label></CardHeader>
          <CardContent>{sources.length ? <ul className="space-y-2">{sources.map((d) => (
            <li key={d.id} className="flex items-center gap-2 text-sm"><FileText className="size-3.5 text-subtle" /><span className="flex-1 truncate">{d.filename}</span>
              <Badge tone={d.indexed ? "success" : "neutral"}>{d.indexed ? "indexed" : "pending"}</Badge></li>))}</ul>
            : <p className="py-6 text-center text-sm text-muted">Upload PDFs, docs or notes for document analysis.</p>}</CardContent></Card>
      </div>
      <AgentTasks agent="research" title="Research history" />
    </div>
  );
}
