import * as React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { Badge } from "./badge";
import type { TaskStatus } from "@/types";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-surface-2", className)} aria-hidden />;
}

export function EmptyState({ icon: Icon, title, description, action }:
  { icon: React.ElementType; title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border-strong px-6 py-12 text-center">
      <div className="mb-3 grid size-10 place-items-center rounded-xl bg-surface-2 text-muted"><Icon className="size-5" /></div>
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="mt-1 max-w-sm text-xs text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions, icon: Icon }:
  { title: string; description?: string; actions?: React.ReactNode; icon?: React.ElementType }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          {Icon && <Icon className="size-5 text-primary" />}{title}
        </h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const STATUS: Record<TaskStatus, { tone: "neutral" | "primary" | "accent" | "success" | "warning" | "danger"; label: string }> = {
  PENDING: { tone: "neutral", label: "Pending" },
  PLANNING: { tone: "accent", label: "Planning" },
  IN_PROGRESS: { tone: "primary", label: "In progress" },
  WAITING_FOR_APPROVAL: { tone: "warning", label: "Needs approval" },
  COMPLETED: { tone: "success", label: "Completed" },
  FAILED: { tone: "danger", label: "Failed" },
  CANCELLED: { tone: "neutral", label: "Cancelled" },
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const s = STATUS[status] ?? STATUS.PENDING;
  const live = status === "PLANNING" || status === "IN_PROGRESS";
  return (
    <Badge tone={s.tone}>
      {live && <span className="size-1.5 rounded-full bg-current animate-pulse" aria-hidden />}
      {s.label}
    </Badge>
  );
}

export function Md({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("prose-lexa text-sm", className)}>
      <Markdown remarkPlugins={[remarkGfm]} components={{
        a: ({ href, children: c }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow">{c}</a>,
      }}>{children}</Markdown>
    </div>
  );
}

export function Stat({ label, value, sub, icon: Icon }: { label: string; value: React.ReactNode; sub?: React.ReactNode; icon?: React.ElementType }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between text-xs text-muted">{label}{Icon && <Icon className="size-4" />}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {sub && <div className="mt-1 text-xs text-subtle">{sub}</div>}
    </div>
  );
}
