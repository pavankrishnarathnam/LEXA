"use client";
import { Save } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { put } from "@/services/api";
import type { RuleRow, TradingStatus } from "./types";

type Kind = "number" | "time" | "list" | "check";
const META: [string, string, Kind, string?][] = [
  ["budget", "Budget ($)", "number"],
  ["max_loss_per_trade_usd", "Most you accept to lose on one trade ($)", "number"],
  ["max_daily_loss_usd", "Most you accept to lose in a day ($)", "number"],
  ["max_position_pct", "Largest position (% of account)", "number"],
  ["cash_buffer_pct", "Cash to always keep (%)", "number"],
  ["max_order_usd", "Largest single order ($)", "number"],
  ["min_order_usd", "Smallest single order ($)", "number"],
  ["max_trades_per_day", "New trades allowed per day", "number", "1"],
  ["max_orders_per_day", "Orders allowed per day", "number", "1"],
  ["min_reward_risk", "Smallest reward-to-risk (1 = target as far as stop)", "number"],
  ["no_entries_before", "No new entries before (New York time)", "time"],
  ["no_entries_after", "No new entries after (New York time)", "time"],
  ["flat_by", "Be out of the trade by (New York time)", "time"],
  ["blocked", "Tickers you never trade", "list"],
  ["pdt_guard", "Apply the old pattern-day-trader limit (3 day trades in 5 days)", "check"],
];

const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") || "none" : v == null ? "" : String(v));

/** What the form sends: values that were filled in, and rules the user emptied (they go back to the default). */
export function rulesPayload(rows: RuleRow[], form: FormData) {
  const values: Record<string, unknown> = {};
  const reset: string[] = [];
  for (const [name, , kind] of META) {
    const row = rows.find((r) => r.rule === name);
    const wasSet = row?.source === "set by you";
    if (kind === "check") {
      if (form.get(name) === "on") values[name] = true;
      else if (wasSet) reset.push(name);
      continue;
    }
    const text = String(form.get(name) ?? "").trim();
    if (text === "") { if (wasSet) reset.push(name); continue; }
    values[name] = kind === "number" ? Number(text) : text;
  }
  return { values, reset };
}

export function RulesPanel({ status, onChanged }: { status: TradingStatus; onChanged: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contactError, setContactError] = useState<string | null>(null);
  const rows = status.rules;
  const version = JSON.stringify(rows.map((r) => [r.rule, r.source, r.value]));

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await put("/api/trading/rules", rulesPayload(rows, new FormData(e.currentTarget)));
      toast.success("Your trading rules are saved");
      onChanged();
    } catch (err) { setError((err as Error).message); } finally { setSaving(false); }
  };

  const saveContact = async (value: string | null) => {
    setContactError(null);
    try {
      await put("/api/trading/sec-contact", { value });
      toast.success(value ? "SEC contact saved" : "SEC contact removed");
      onChanged();
    } catch (err) { setContactError((err as Error).message); }
  };

  const c = status.sec_contact;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>My trading rules</CardTitle>
            <CardDescription className="mt-1">
              These are your limits, not mine: sizing a trade and the risk check refuse until you have set your budget and the most you accept to lose on one trade.
              Leave any other box empty to use its default.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form key={version} aria-label="My trading rules" onSubmit={save}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {META.map(([name, label, kind, step]) => {
                const row = rows.find((r) => r.rule === name);
                const own = row?.source === "set by you";
                const required = name === "budget" || name === "max_loss_per_trade_usd";
                const hint = own ? "Set by you" : required ? "Required to size trades" : `Default: ${show(row?.value) || "none"}`;
                if (kind === "check") {
                  return (
                    <div key={name} className="grid content-end gap-1">
                      <label className="flex min-h-9 items-center gap-2 text-sm">
                        <input type="checkbox" name={name} defaultChecked={own && row?.value === true} className="size-4 accent-[var(--primary)]" />{label}
                      </label>
                      <p className="text-[11px] text-subtle">{hint}</p>
                    </div>
                  );
                }
                return (
                  <Field key={name} label={label} hint={hint}>
                    <Input name={name} type={kind === "number" ? "number" : "text"} step={kind === "number" ? step ?? "any" : undefined}
                      min={kind === "number" ? 0 : undefined} defaultValue={own ? show(row?.value) : ""}
                      placeholder={own ? undefined : show(row?.value) || (kind === "time" ? "HH:MM" : kind === "list" ? "TSLA, GME" : "")}
                      autoComplete="off" spellCheck={false} className={kind === "list" ? "uppercase placeholder:normal-case" : undefined} />
                  </Field>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button type="submit" variant="gradient" loading={saving}><Save />Save my rules</Button>
              <p className="text-xs text-muted">{status.missing.length ? `Still needed: ${status.missing.join(", ").replaceAll("_", " ")}.` : "Ready to size trades and check risk."}</p>
            </div>
            {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
            <ul className="mt-3 list-disc space-y-0.5 pl-5 text-[11px] text-subtle">{status.fixed.map((f) => <li key={f}>{f}</li>)}</ul>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>SEC contact (optional)</CardTitle>
            <CardDescription className="mt-1">
              SEC EDGAR asks every program that reads its data to say who is asking. Give your name and email to switch on company filings in the news and the earnings check.
              It is sent to sec.gov only.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form key={c.value ?? "none"} aria-label="SEC contact" onSubmit={(e) => { e.preventDefault(); void saveContact(String(new FormData(e.currentTarget).get("value") ?? "").trim() || null); }}>
            <div className="grid gap-3 sm:max-w-md">
              <Field label="Your name and email" hint="For example: Jane Doe jane@example.org">
                <Input name="value" defaultValue={c.value ?? ""} autoComplete="off" spellCheck={false} />
              </Field>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button type="submit" variant="secondary"><Save />Save contact</Button>
              {c.value && <Button type="button" variant="outline" onClick={() => void saveContact(null)}>Remove</Button>}
              <p role="status" className="text-xs text-muted">
                {c.source === "you" ? "Using your contact." : c.source === "server" ? "Using the contact set on the server." : "Not set: SEC filings and earnings are skipped."}
              </p>
            </div>
            {contactError && <p role="alert" className="mt-2 text-xs text-danger">{contactError}</p>}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
