"use client";
import { Suspense, useRef, useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AudioLines, Download, Eye, FileCheck2, Settings as SettingsIcon, ShieldCheck, Zap } from "lucide-react";
import { useApi } from "@/hooks/use-api";
import { api, post } from "@/services/api";
import { cn, compact, timeAgo, usd } from "@/lib/utils";
import { PageHeader, Stat } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Field, Input, Select } from "@/components/ui/input";
import { useAuth } from "@/components/layout/auth";
import { useVoice } from "@/components/voice/voice-provider";
import { browserRecognitionSupported, isFirefox } from "@/lib/voice/browser-stt";
import type { PermissionMode, User } from "@/types";

const MODES: { id: PermissionMode; title: string; icon: React.ElementType; desc: string }[] = [
  { id: "read_analyze", title: "Read & analyze", icon: Eye, desc: "Agents read authorized data and produce analysis. No external actions at all." },
  { id: "prepare_approve", title: "Prepare & approve", icon: FileCheck2, desc: "Agents prepare actions (emails, events, PRs) and wait for your approval. Recommended." },
  { id: "rule_autonomy", title: "Rule-based autonomy", icon: Zap, desc: "Routine actions matching an agent's autonomy rules run automatically within limits. Sensitive actions still need approval." },
];

function useSaveSettings() {
  const { setUser } = useAuth();
  return async (body: Record<string, unknown>) => {
    try { const u = await api<User>("/api/auth/me/settings", { method: "PATCH", json: body }); setUser(u); toast.success("Saved"); }
    catch (e) { toast.error((e as Error).message); }
  };
}

function Permissions() {
  const { user } = useAuth();
  const save = useSaveSettings();
  const { data: info } = useApi<Record<string, any>>("/api/system/info");
  const [budget, setBudget] = useState<string>(String(user?.settings?.monthly_budget_usd ?? ""));
  return (
    <div className="space-y-4">
      <Card><CardHeader><div><CardTitle>Permission mode</CardTitle><CardDescription>Payments, transfers, contract signing, accepting offers, confidential sends and irreversible deletions ALWAYS require explicit approval.</CardDescription></div></CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-3" role="radiogroup" aria-label="Permission mode">
          {MODES.map((m) => {
            const on = user?.permission_mode === m.id;
            return (
              <button key={m.id} role="radio" aria-checked={on} onClick={() => void save({ permission_mode: m.id })}
                className={cn("rounded-xl border p-4 text-left transition", on ? "border-primary bg-primary/5" : "border-border hover:border-border-strong")}>
                <m.icon className={cn("size-5", on ? "text-primary" : "text-muted")} />
                <p className="mt-2 text-sm font-medium">{m.title}</p><p className="mt-1 text-xs text-muted">{m.desc}</p>
              </button>);
          })}
        </CardContent></Card>
      <Card><CardHeader><CardTitle>AI usage controls</CardTitle></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2">
        <Field label="Monthly AI budget (USD)" hint="When reached, new AI calls are blocked until next month or until you raise it.">
          <div className="flex gap-2"><Input type="number" min={0} step="1" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="50" />
            <Button variant="secondary" onClick={() => void save({ monthly_budget_usd: Number(budget) })}>Save</Button></div></Field>
        <label className="flex items-center justify-between gap-4 rounded-lg border border-border p-3 text-sm">
          <span><span className="block font-medium">Automatic memory</span><span className="text-xs text-muted">Extract durable facts you state in conversations.</span></span>
          <Switch checked={user?.settings?.auto_memory !== false} onCheckedChange={(v) => void save({ auto_memory: v })} /></label>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>AI providers & models</CardTitle></CardHeader><CardContent className="grid gap-2 text-sm sm:grid-cols-2">
        {info && Object.entries({ "Primary model": info.default_model, "Fast model (memory, extraction)": info.fast_model, "Fallback model": info.fallback_model,
          "Default effort": info.default_effort, "Web search": info.web_search_model, "Embeddings": info.embedding_model }).map(([k, v]) => (
          <div key={k} className="flex justify-between rounded-lg bg-surface-2/60 px-3 py-2"><span className="text-muted">{k}</span><span className="font-mono text-xs">{String(v)}</span></div>))}
        <p className="text-xs text-subtle sm:col-span-2">Server-level defaults come from environment variables. Per-agent models are set in Agents.</p>
      </CardContent></Card>
    </div>
  );
}

function Usage() {
  const [days, setDays] = useState(30);
  const { data } = useApi<any>(`/api/usage?days=${days}`);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2"><Select aria-label="Range" value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-36">
        {[7, 30, 90].map((d) => <option key={d} value={d}>Last {d} days</option>)}</Select></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="This month" value={usd(data?.month_spend_usd)} sub={`of ${usd(data?.budget_usd)} budget`} />
        <Stat label="Budget used" value={data?.budget_used_pct != null ? `${data.budget_used_pct}%` : "–"} />
        <Stat label="Calls in range" value={compact(data?.by_model?.reduce((a: number, m: any) => a + m.calls, 0))} />
        <Stat label="Fallback calls" value={data?.fallback_calls ?? 0} sub="served by the secondary provider" />
      </div>
      <Card><CardHeader><CardTitle>Daily cost</CardTitle></CardHeader><CardContent className="h-64">
        <ResponsiveContainer><AreaChart data={data?.by_day || []}>
          <defs><linearGradient id="c" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--primary)" stopOpacity={0.4} /><stop offset="100%" stopColor="var(--primary)" stopOpacity={0} /></linearGradient></defs>
          <CartesianGrid stroke="var(--border)" vertical={false} /><XAxis dataKey="date" stroke="var(--subtle)" fontSize={11} /><YAxis stroke="var(--subtle)" fontSize={11} tickFormatter={(v) => `$${v}`} />
          <Tooltip contentStyle={{ background: "var(--elevated)", border: "1px solid var(--border-strong)", borderRadius: 8, fontSize: 12 }} formatter={(v) => usd(Number(v), 4)} />
          <Area type="monotone" dataKey="cost_usd" stroke="var(--primary)" fill="url(#c)" strokeWidth={2} /></AreaChart></ResponsiveContainer></CardContent></Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>By model</CardTitle></CardHeader><CardContent className="overflow-x-auto">
          <table className="w-full text-sm"><thead className="text-left text-xs text-subtle"><tr><th className="py-1">Model</th><th>Calls</th><th>Tokens in/out</th><th>Latency</th><th>Errors</th><th className="text-right">Cost</th></tr></thead>
            <tbody>{data?.by_model?.map((m: any) => (<tr key={m.model} className="border-t border-border"><td className="py-1.5 font-mono text-xs">{m.model}</td><td>{m.calls}</td>
              <td className="text-xs">{compact(m.input_tokens)}/{compact(m.output_tokens)}</td><td className="text-xs">{m.avg_latency_ms}ms</td><td>{m.errors}</td><td className="text-right tabular-nums">{usd(m.cost_usd, 4)}</td></tr>))}</tbody></table>
          {!data?.by_model?.length && <p className="py-4 text-center text-sm text-muted">No AI usage recorded yet.</p>}</CardContent></Card>
        <Card><CardHeader><CardTitle>By agent</CardTitle></CardHeader><CardContent>
          <ul className="space-y-2">{data?.by_agent?.sort((a: any, b: any) => b.cost_usd - a.cost_usd).map((a: any) => (
            <li key={a.agent} className="flex items-center gap-3 text-sm"><span className="w-28 truncate capitalize">{a.agent}</span>
              <div className="h-1.5 flex-1 rounded-full bg-surface-2"><div className="h-full rounded-full bg-grad" style={{ width: `${Math.min(100, (a.cost_usd / Math.max(...data.by_agent.map((x: any) => x.cost_usd), 1e-9)) * 100)}%` }} /></div>
              <span className="w-20 text-right text-xs tabular-nums">{usd(a.cost_usd, 4)}</span></li>))}</ul></CardContent></Card>
      </div>
    </div>
  );
}

function Security() {
  const [cat, setCat] = useState("");
  const { data } = useApi<any[]>(`/api/audit?limit=200${cat ? `&category=${cat}` : ""}`);
  const [pw, setPw] = useState({ current_password: "", new_password: "" });
  const change = async () => {
    try { await post("/api/auth/me/password", pw); toast.success("Password changed; other sessions were signed out"); setPw({ current_password: "", new_password: "" }); }
    catch (e) { toast.error((e as Error).message); }
  };
  return (
    <div className="space-y-4">
      <Card><CardHeader><CardTitle>Change password</CardTitle></CardHeader><CardContent className="grid gap-3 sm:grid-cols-3">
        <Field label="Current password"><Input type="password" autoComplete="current-password" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} /></Field>
        <Field label="New password" hint="10+ characters"><Input type="password" autoComplete="new-password" value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} /></Field>
        <div className="flex items-end"><Button variant="secondary" onClick={() => void change()} disabled={pw.new_password.length < 10}>Update</Button></div></CardContent></Card>
      <Card><CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4" />Audit log</CardTitle>
        <Select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)} className="h-8 w-40 text-xs">
          {["", "auth", "security", "approval", "action", "integration", "agents", "memory", "data", "automation", "tasks"].map((c) => <option key={c} value={c}>{c || "All categories"}</option>)}</Select></CardHeader>
        <CardContent className="overflow-x-auto"><table className="w-full text-xs"><thead className="text-left text-subtle"><tr><th className="py-1">When</th><th>Actor</th><th>Action</th><th>Target</th><th>IP</th><th>Result</th></tr></thead>
          <tbody>{data?.map((a) => <tr key={a.id} className="border-t border-border"><td className="py-1.5 whitespace-nowrap">{timeAgo(a.at)}</td><td>{a.actor}</td>
            <td className="font-mono">{a.action}</td><td className="max-w-40 truncate">{a.target_id}</td><td>{a.ip}</td><td>{a.success ? <Badge tone="success">ok</Badge> : <Badge tone="danger">failed</Badge>}</td></tr>)}</tbody></table></CardContent></Card>
    </div>
  );
}

function Preferences() {
  const save = useSaveSettings();
  const { theme, setTheme } = useTheme();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card><CardHeader><CardTitle>Appearance</CardTitle></CardHeader><CardContent>
        <div className="flex gap-2" role="radiogroup" aria-label="Theme">{["dark", "light", "system"].map((t) => (
          <button key={t} role="radio" aria-checked={theme === t} onClick={() => { setTheme(t); void save({ theme: t }); }}
            className={cn("flex-1 rounded-lg border px-3 py-2 text-sm capitalize", theme === t ? "border-primary bg-primary/5" : "border-border")}>{t}</button>))}</div></CardContent></Card>
      <Card><CardHeader><CardTitle>Voice</CardTitle></CardHeader><CardContent className="grid gap-3 text-sm text-muted">
        <p>LEXA can be used completely by voice: speak requests, navigate, fill forms, hear replies and approve actions.</p>
        <Button variant="secondary" asChild><a href="/settings?tab=voice"><AudioLines />Voice settings</a></Button></CardContent></Card>
      <Card className="lg:col-span-2"><CardHeader><CardTitle>Data & backup</CardTitle></CardHeader><CardContent className="flex flex-wrap items-center gap-3 text-sm text-muted">
        <Button variant="secondary" asChild><a href="/api/export"><Download />Export my data (JSON)</a></Button>
        Server backups are run and verified by the VPS backup job (see docs/BACKUP.md). Ask the Security Agent for the verified backup status.</CardContent></Card>
    </div>
  );
}


const LANGUAGES: [string, string][] = [["", "Detect automatically"], ["en", "English"], ["hi", "Hindi"], ["ta", "Tamil"], ["te", "Telugu"],
  ["kn", "Kannada"], ["ml", "Malayalam"], ["mr", "Marathi"], ["bn", "Bengali"], ["gu", "Gujarati"], ["ur", "Urdu"], ["es", "Spanish"],
  ["fr", "French"], ["de", "German"], ["pt", "Portuguese"], ["it", "Italian"], ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"],
  ["ar", "Arabic"], ["ru", "Russian"]];

function VoiceSettings() {
  const { user } = useAuth();
  const save = useSaveSettings();
  const voice = useVoice();
  const caps = voice.caps;
  const st = user?.settings ?? {};
  const browserStt = useSyncExternalStore(() => () => undefined, browserRecognitionSupported, () => false);
  const firefox = useSyncExternalStore(() => () => undefined, isFirefox, () => false);
  const [speed, setSpeed] = useState<number>(typeof st.voice_speed === "number" ? st.voice_speed : 1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changeSpeed = (v: number) => {
    setSpeed(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save({ voice_speed: v }), 500);
  };
  const row = "flex items-center justify-between gap-4 rounded-lg border border-border p-3 text-sm";
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="lg:col-span-2"><CardHeader><CardTitle>Voice control</CardTitle>
        <Button variant={voice.snap.active ? "secondary" : "gradient"} onClick={voice.toggle} aria-pressed={voice.snap.active}>
          <AudioLines />{voice.snap.active ? "Turn voice mode off" : "Turn voice mode on"}</Button></CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-2 rounded-lg bg-surface-2/60 px-3 py-2"><span className="text-muted">OpenAI recognition</span>
            <span>{caps ? (caps.server_stt ? <Badge tone="success">ready · {caps.stt_model}</Badge> : <Badge tone="warning">needs OPENAI_API_KEY</Badge>) : "checking…"}</span></div>
          <div className="flex justify-between gap-2 rounded-lg bg-surface-2/60 px-3 py-2"><span className="text-muted">Browser recognition (free)</span>
            <span>{browserStt ? <Badge tone="success">available here</Badge> : <Badge tone="neutral">{firefox ? "not in Firefox" : "not in this browser"}</Badge>}</span></div>
          <div className="flex justify-between gap-2 rounded-lg bg-surface-2/60 px-3 py-2"><span className="text-muted">Spoken replies</span>
            <span>{caps ? (caps.server_tts ? <Badge tone="success">ready · {caps.tts_model}</Badge> : <Badge tone="neutral">browser voice</Badge>) : "checking…"}</span></div>
          <p className="text-xs text-subtle sm:col-span-2">
            Shortcut: <kbd className="rounded border border-border px-1">Alt</kbd> + <kbd className="rounded border border-border px-1">V</kbd> toggles voice from anywhere, <kbd className="rounded border border-border px-1">Esc</kbd> stops LEXA talking.
            The microphone is only open while voice mode is on, and only finished sentences are sent for transcription. Nothing is recorded or stored by LEXA.
            Estimated cost: about $0.003 per minute of your speech and $0.015 per minute of OpenAI voice (the browser voice is free).
          </p>
        </CardContent></Card>

      <Card><CardHeader><CardTitle>Speaking</CardTitle></CardHeader><CardContent className="grid gap-3">
        <label className={row}>Speak responses aloud
          <Switch checked={!!st.speak_responses} onCheckedChange={(v) => void save({ speak_responses: v })} /></label>
        <Field label="Voice engine" hint="The browser voice is free but less natural.">
          <Select value={st.voice_engine === "browser" ? "browser" : "server"} onChange={(e) => void save({ voice_engine: e.target.value })}>
            <option value="server">OpenAI voice (natural)</option><option value="browser">Browser voice (free)</option></Select></Field>
        <Field label="LEXA voice" hint={caps?.server_tts ? "Used by the OpenAI voice engine." : "Needs OPENAI_API_KEY on the server."}>
          <Select disabled={!caps?.server_tts} value={st.voice || "nova"} onChange={(e) => void save({ voice: e.target.value })}>
            {(caps?.voices || ["nova"]).map((v) => <option key={v}>{v}</option>)}</Select></Field>
        <Field label={`Speaking speed (${speed.toFixed(2)}×)`} hint="Say “speak slower” or “speak faster” any time.">
          <input type="range" min={0.6} max={1.8} step={0.05} value={speed} onChange={(e) => changeSpeed(Number(e.target.value))}
            aria-label="Speaking speed" className="w-full accent-[var(--primary)]" /></Field>
      </CardContent></Card>

      <Card><CardHeader><CardTitle>Listening</CardTitle></CardHeader><CardContent className="grid gap-3">
        <Field label="Speech recognition" hint="Automatic uses OpenAI and switches to your browser's free recognition if OpenAI is unavailable (no key or no credits). The browser option sends your audio to the browser's vendor (Google in Chrome, Microsoft in Edge, Apple in Safari) instead of OpenAI; Firefox has none.">
          <Select value={st.voice_recognition ?? "auto"} onChange={(e) => void save({ voice_recognition: e.target.value })}>
            <option value="auto">Automatic (recommended)</option>
            <option value="server">OpenAI only (about $0.003 per minute of speech)</option>
            <option value="browser">Browser only (free: Chrome, Edge, Safari)</option></Select></Field>
        <Field label="Spoken language" hint="Detecting automatically works for most people; pick one if you speak mostly one language.">
          <Select value={st.voice_language ?? ""} onChange={(e) => void save({ voice_language: e.target.value })}>
            {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</Select></Field>
        <Field label="Patience" hint="How long LEXA waits after you stop talking before it answers.">
          <Select value={st.voice_patience ?? "normal"} onChange={(e) => void save({ voice_patience: e.target.value })}>
            <option value="quick">Quick (0.6 s)</option><option value="normal">Normal (1 s)</option><option value="patient">Patient (1.8 s)</option></Select></Field>
        <label className={row}><span><span className="block font-medium">Require “Hey LEXA”</span><span className="text-xs text-muted">Ignore speech that does not start with the wake phrase (useful in shared rooms).</span></span>
          <Switch checked={!!st.voice_wake_phrase} onCheckedChange={(v) => void save({ voice_wake_phrase: v })} aria-label="Require Hey LEXA" /></label>
        <label className={row}><span><span className="block font-medium">Sound cues</span><span className="text-xs text-muted">Short tones when voice starts, understands you or finishes.</span></span>
          <Switch checked={st.voice_cues !== false} onCheckedChange={(v) => void save({ voice_cues: v })} aria-label="Sound cues" /></label>
        <label className={row}><span><span className="block font-medium">Start voice automatically</span><span className="text-xs text-muted">Turns voice on with your first key press or click after you open LEXA (browsers do not allow it sooner).</span></span>
          <Switch checked={!!st.voice_auto_start} onCheckedChange={(v) => void save({ voice_auto_start: v })} aria-label="Start voice automatically" /></label>
      </CardContent></Card>
    </div>
  );
}

function SettingsInner() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = params.get("tab") || "permissions";
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader icon={SettingsIcon} title="Settings" description="Permissions, AI providers, usage and cost, security and preferences." />
      <Tabs value={tab} onValueChange={(v) => router.replace(`/settings?tab=${v}`)}>
        <TabsList><TabsTrigger value="permissions">AI & permissions</TabsTrigger><TabsTrigger value="usage">Usage & cost</TabsTrigger>
          <TabsTrigger value="security">Security & audit</TabsTrigger><TabsTrigger value="voice">Voice</TabsTrigger><TabsTrigger value="preferences">Preferences</TabsTrigger></TabsList>
        <TabsContent value="permissions">{tab === "permissions" && <Permissions />}</TabsContent>
        <TabsContent value="usage">{tab === "usage" && <Usage />}</TabsContent>
        <TabsContent value="security">{tab === "security" && <Security />}</TabsContent>
        <TabsContent value="voice">{tab === "voice" && <VoiceSettings />}</TabsContent>
        <TabsContent value="preferences">{tab === "preferences" && <Preferences />}</TabsContent>
      </Tabs>
    </div>
  );
}

export default function SettingsPage() {
  return <Suspense><SettingsInner /></Suspense>;
}
