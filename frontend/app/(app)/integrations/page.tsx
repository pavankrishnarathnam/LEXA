"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { toast } from "sonner";
import { ExternalLink, History, Plug, ShieldCheck, Unplug } from "lucide-react";
import { useApi } from "@/hooks/use-api";
import { useConfirm } from "@/components/voice/confirm-provider";
import { del, post } from "@/services/api";
import { timeAgo } from "@/lib/utils";
import { PageHeader, Skeleton } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import type { Integration } from "@/types";

function ConnectDialog({ integ, onClose, onDone }: { integ: Integration; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    try {
      await post(`/api/integrations/${integ.key}/connect`, { credentials: Object.fromEntries(new FormData(e.currentTarget).entries()) });
      toast.success(`${integ.name} connected and verified`); onDone();
    } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent title={`Connect ${integ.name}`} description="Credentials are verified against the provider, encrypted at rest and never shown again.">
        <form onSubmit={submit} className="grid gap-3">
          {integ.fields.map((f) => <Field key={f.name} label={f.label + (f.required ? "" : " (optional)")}>
            <Input name={f.name} type={f.secret ? "password" : "text"} required={f.required} placeholder={f.placeholder} autoComplete="off" /></Field>)}
          {integ.docs_url && <a href={integ.docs_url} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:underline">Provider documentation <ExternalLink className="inline size-3" /></a>}
          <Button type="submit" variant="gradient" loading={busy}>Verify & connect</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Logs({ integ, onClose }: { integ: Integration; onClose: () => void }) {
  const { data } = useApi<{ at: string; actor: string; action: string; success: boolean }[]>(`/api/integrations/${integ.key}/logs`);
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}><DialogContent title={`${integ.name} access log`} className="max-w-xl">
      <ul className="space-y-1 font-mono text-[11px]">{data?.map((l, i) => (
        <li key={i} className="flex gap-2"><span className="text-subtle">{new Date(l.at).toLocaleString()}</span><span className={l.success ? "text-muted" : "text-danger"}>{l.action}</span><span className="ml-auto text-subtle">{l.actor}</span></li>))}
        {!data?.length && <li className="text-subtle">No access recorded.</li>}</ul>
    </DialogContent></Dialog>
  );
}

function IntegrationsInner() {
  const { data, loading, reload } = useApi<Integration[]>("/api/integrations");
  const { confirm } = useConfirm();
  const params = useSearchParams();
  const [connecting, setConnecting] = useState<Integration | null>(null);
  const [logs, setLogs] = useState<Integration | null>(null);
  useEffect(() => {
    if (params.get("connected")) toast.success(`${params.get("connected")} connected`);
    if (params.get("error")) toast.error(`Connection failed: ${params.get("error")}`);
  }, [params]);

  const connect = async (i: Integration) => {
    if (i.auth_type === "oauth2" && (i.oauth_available || !i.fields.length)) {
      try { const r = await post<{ authorize_url: string }>(`/api/integrations/${i.key}/connect`, { credentials: {} }); window.location.assign(r.authorize_url); }
      catch (e) { if (i.fields.length) setConnecting(i); else toast.error((e as Error).message); }
    } else setConnecting(i);
  };
  const check = async (i: Integration) => {
    const r = await post<{ ok: boolean; message: string }>(`/api/integrations/${i.key}/check`);
    (r.ok ? toast.success : toast.error)(`${i.name}: ${r.ok ? "reachable" : r.message}`);
  };
  const disconnect = async (i: Integration) => {
    const ok = await confirm({ title: `Disconnect ${i.name}?`, confirmLabel: "Disconnect", destructive: true,
      description: `Stored tokens are deleted${i.auth_type === "oauth2" ? " and revoked where supported" : ""}.` });
    if (!ok) return;
    try { await del(`/api/integrations/${i.key}`); toast.success("Disconnected"); void reload(); } catch (e) { toast.error((e as Error).message); }
  };
  const groups = Object.entries((data || []).reduce<Record<string, Integration[]>>((g, i) => ((g[i.category] ||= []).push(i), g), {}));

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader icon={Plug} title="Integrations" description="Authorized connections only. Each shows its scopes, status and an access log; disconnect any time." />
      {loading && !data && <div className="grid gap-3 md:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-36" />)}</div>}
      <div className="space-y-6">{groups.map(([cat, items]) => (
        <section key={cat}><h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-subtle">{cat}</h2>
          <div className="grid gap-3 md:grid-cols-2">{items.map((i) => {
            const connected = i.status === "connected";
            return (
              <div key={i.key} className="flex flex-col rounded-xl border border-border bg-surface p-4">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1"><p className="text-sm font-semibold">{i.name}</p><p className="text-xs text-muted">{i.description}</p></div>
                  <Badge tone={connected ? "success" : i.status === "error" ? "danger" : "neutral"}>{i.status.replace("_", " ")}</Badge>
                </div>
                {i.scope_descriptions.length > 0 && <ul className="mt-2 space-y-0.5 text-[11px] text-subtle">{i.scope_descriptions.map((s) => <li key={s} className="flex items-center gap-1"><ShieldCheck className="size-3" />{s}</li>)}</ul>}
                {i.account_label && <p className="mt-2 text-xs text-muted">Account: <span className="text-foreground">{i.account_label}</span></p>}
                {i.last_error && <p className="mt-1 text-xs text-danger">{i.last_error}</p>}
                {i.last_used_at && <p className="mt-1 text-[11px] text-subtle">Last used {timeAgo(i.last_used_at)}</p>}
                {i.auth_type === "oauth2" && i.oauth_available === false && !connected && (
                  <p className="mt-2 text-[11px] text-warning">OAuth client not configured on the server{i.fields.length ? " — you can use a token instead." : "."}</p>)}
                <div className="mt-auto flex gap-2 pt-3">
                  {i.auth_type === "config" ? <Button size="sm" variant="secondary" onClick={() => void check(i)}>Check connection</Button>
                    : connected ? <><Button size="sm" variant="secondary" data-voice-confirms aria-label={`Disconnect ${i.name}`} onClick={() => void disconnect(i)}><Unplug />Disconnect</Button>
                      <Button size="sm" variant="ghost" onClick={() => setLogs(i)}><History />Access log</Button></>
                    : <Button size="sm" variant="gradient" onClick={() => void connect(i)}><Plug />Connect</Button>}
                </div>
              </div>);
          })}</div></section>))}</div>
      {connecting && <ConnectDialog integ={connecting} onClose={() => setConnecting(null)} onDone={() => { setConnecting(null); void reload(); }} />}
      {logs && <Logs integ={logs} onClose={() => setLogs(null)} />}
    </div>
  );
}

export default function IntegrationsPage() {
  return <Suspense><IntegrationsInner /></Suspense>;
}
