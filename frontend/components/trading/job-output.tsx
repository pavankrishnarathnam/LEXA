"use client";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Job } from "./use-job";

/** Only public market-data sites are turned into links; any other text, even a URL, stays plain text. */
const LINK_HOSTS = ["finance.yahoo.com", "www.sec.gov", "sec.gov", "data.sec.gov", "disclosures-clerk.house.gov"];
const URL_RE = /(https:\/\/[^\s<>"')\]]+)/g;

export function isSafeLink(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && LINK_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

export function Linked({ text }: { text: string }) {
  return (
    <>
      {text.split(URL_RE).map((part, i) => (i % 2 === 1 && isSafeLink(part)
        ? <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline underline-offset-2">{part}</a>
        : <span key={i}>{part}</span>))}
    </>
  );
}

const STATUS = {
  running: { tone: "primary", label: "Running" },
  done: { tone: "success", label: "Done" },
  error: { tone: "danger", label: "Failed" },
  cancelled: { tone: "neutral", label: "Stopped" },
} as const;

export function JobOutput({ job, title }: { job: Job; title: string }) {
  const [copied, setCopied] = useState(false);
  const s = STATUS[job.status] ?? STATUS.error;
  const at = job.finished_at ?? job.started_at;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(job.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked: the text is still selectable */ }
  };
  return (
    <section aria-label={`${title}: result`} className="mt-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge tone={s.tone}>{s.label}</Badge>
        <span>{new Date(at * 1000).toLocaleTimeString()}</span>
        {job.seconds != null && <span>· {job.seconds}s</span>}
        {job.untrusted && <span>· from public market data</span>}
        {job.content && (
          <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => void copy()}>
            {copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}
          </Button>
        )}
      </div>
      {job.content && (
        <div role="region" aria-label={`${title}: output`} tabIndex={0}
          className="max-h-[28rem] overflow-auto rounded-lg border border-border bg-surface-2/60 p-3">
          <pre className="font-mono text-xs leading-5 whitespace-pre"><Linked text={job.content} /></pre>
        </div>
      )}
    </section>
  );
}
