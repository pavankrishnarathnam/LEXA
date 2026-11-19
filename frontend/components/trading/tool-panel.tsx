"use client";
import { Play, Square } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { JobOutput } from "./job-output";
import { useJob } from "./use-job";

export type FieldDef =
  | { kind: "list"; name: string; label: string; placeholder?: string; hint?: string; upper?: boolean; split?: "comma"; required?: boolean }
  | { kind: "text" | "number"; name: string; label: string; placeholder?: string; hint?: string; step?: string; min?: number; required?: boolean; upper?: boolean; type?: "date" }
  | { kind: "select"; name: string; label: string; hint?: string; options: { value: string; label: string }[] }
  | { kind: "check"; name: string; label: string; hint?: string; invert?: boolean };

/** Turns the form into the tool's arguments. Empty fields are left out so the tool's own defaults apply. */
export function buildArgs(fields: FieldDef[], form: FormData, fixed: Record<string, unknown> = {}): Record<string, unknown> {
  const args: Record<string, unknown> = { ...fixed };
  for (const f of fields) {
    const raw = String(form.get(f.name) ?? "");
    if (f.kind === "check") {
      if (form.get(f.name) === "on") args[f.name] = !f.invert; // `invert`: ticking the box turns an on-by-default option off
    } else if (f.kind === "number") {
      const t = raw.trim();
      if (t !== "" && Number.isFinite(Number(t))) args[f.name] = Number(t);
    } else if (f.kind === "list") {
      const items = raw.split(f.split === "comma" ? /,/ : /[\s,]+/).map((s) => s.trim()).filter(Boolean)
        .map((s) => (f.upper ? s.toUpperCase() : s));
      if (items.length) args[f.name] = items;
    } else if (raw.trim()) {
      args[f.name] = f.kind === "text" && f.upper ? raw.trim().toUpperCase() : raw.trim();
    }
  }
  return args;
}

function FieldInput({ f }: { f: FieldDef }) {
  if (f.kind === "select") {
    return <Field label={f.label} hint={f.hint}><Select name={f.name}>{f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>;
  }
  if (f.kind === "check") {
    return (
      <div className="grid content-end gap-1">
        <label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" name={f.name} className="size-4 accent-[var(--primary)]" />{f.label}</label>
        {f.hint && <p className="text-[11px] text-subtle">{f.hint}</p>}
      </div>
    );
  }
  const upper = (f.kind === "list" || f.kind === "text") && f.upper;
  return (
    <Field label={f.label} hint={f.hint}>
      <Input name={f.name} type={f.kind === "number" ? "number" : f.kind === "text" && f.type ? f.type : "text"} placeholder={f.placeholder} required={f.required}
        step={f.kind === "number" ? f.step ?? "any" : undefined} min={f.kind === "number" ? f.min : undefined}
        autoComplete="off" spellCheck={false} className={upper ? "uppercase placeholder:normal-case" : undefined} />
    </Field>
  );
}

export function ToolPanel({ tool, title, description, fields = [], fixed, runLabel = "Run", slow, needsRules, rulesReady = true, onNeedRules }: {
  tool: string; title: string; description?: string; fields?: FieldDef[]; fixed?: Record<string, unknown>; runLabel?: string;
  slow?: boolean; needsRules?: boolean; rulesReady?: boolean; onNeedRules?: () => void;
}) {
  const { job, run, stop, starting, running, elapsed, error } = useJob(tool);
  const blocked = !!needsRules && !rulesReady;
  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription className="mt-1">{description}</CardDescription>}
        </div>
        {slow && <Badge tone="warning">can take minutes</Badge>}
      </CardHeader>
      <CardContent>
        <form aria-label={title} onSubmit={(e) => { e.preventDefault(); if (!blocked) void run(buildArgs(fields, new FormData(e.currentTarget), fixed)); }}>
          {fields.length > 0 && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{fields.map((f) => <FieldInput key={f.name} f={f} />)}</div>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="submit" variant="secondary" loading={starting || running} disabled={blocked}><Play />{runLabel}</Button>
            {running && <Button type="button" variant="outline" onClick={() => void stop()}><Square />Stop</Button>}
            <p role="status" aria-live="polite" className="text-xs text-muted">
              {starting ? "Starting…" : running ? `Running… ${elapsed}s${slow ? " (a market-wide scan can take several minutes)" : ""}` : ""}
            </p>
          </div>
          {blocked && (
            <p className="mt-2 text-xs text-warning">
              This needs your budget and max loss per trade first: nothing is guessed for you.{" "}
              {onNeedRules && <button type="button" className="underline underline-offset-2" onClick={onNeedRules}>Set my rules</button>}
            </p>
          )}
        </form>
        {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
        {job && <JobOutput job={job} title={title} />}
      </CardContent>
    </Card>
  );
}
