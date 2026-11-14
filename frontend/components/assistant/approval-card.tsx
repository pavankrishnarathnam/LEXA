"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Check, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { post } from "@/services/api";
import { timeAgo } from "@/lib/utils";
import type { Approval } from "@/types";

export function ApprovalCard({ approval, onDecided }: { approval: Approval; onDecided?: (a: Approval) => void }) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [showArgs, setShowArgs] = useState(false);
  const decide = async (approve: boolean) => {
    setBusy(approve ? "approve" : "reject");
    try {
      const a = await post<Approval>(`/api/approvals/${approval.id}/decision`, { approve });
      toast.success(approve ? "Approved — executing now" : "Rejected");
      onDecided?.(a);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const pending = approval.status === "pending";
  const tone = approval.risk_level === "high" ? "danger" : approval.risk_level === "medium" ? "warning" : "neutral";
  return (
    <div data-approval-id={approval.id} role="group" aria-label={`Approval: ${approval.agent} wants to run ${approval.tool}`}
      className="rounded-xl border border-warning/30 bg-warning/[0.04] p-3.5">
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-medium">{approval.agent} wants to run <code className="font-mono text-xs">{approval.tool}</code></span>
            <Badge tone={tone}>{approval.risk_level} risk</Badge>
            {!pending && <Badge tone={approval.status === "executed" ? "success" : approval.status === "failed" ? "danger" : "neutral"}>{approval.status}</Badge>}
          </div>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-2/70 p-2.5 font-sans text-[13px] leading-relaxed scrollbar-thin">{approval.summary}</pre>
          <p className="mt-1.5 text-[11px] text-subtle">{approval.reason} · {timeAgo(approval.created_at)}</p>
          <button className="mt-1 text-[11px] text-accent hover:underline" onClick={() => setShowArgs((v) => !v)}>
            {showArgs ? "Hide" : "Show"} exact parameters
          </button>
          {showArgs && <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-surface-2 p-2 font-mono text-[11px] scrollbar-thin">{JSON.stringify(approval.arguments, null, 2)}</pre>}
          {approval.result && <p className="mt-2 text-xs text-muted">Result: {approval.result.content || approval.result.error}</p>}
          {pending && (
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="success" onClick={() => void decide(true)} loading={busy === "approve"} disabled={!!busy}><Check />Approve & run</Button>
              <Button size="sm" variant="secondary" onClick={() => void decide(false)} loading={busy === "reject"} disabled={!!busy}><X />Reject</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
