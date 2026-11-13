"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowUp, AudioLines, Copy, FileText, Mic, MicOff, Paperclip, Plus, Trash2, Volume2, VolumeX, X } from "lucide-react";
import { api, del, post, upload } from "@/services/api";
import { useApi } from "@/hooks/use-api";
import { useVoice } from "@/hooks/use-voice";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Md } from "@/components/ui/misc";
import { LexaOrb } from "@/components/layout/orb";
import { useAuth } from "@/components/layout/auth";
import { TaskLive } from "./task-live";
import type { Agent, Conversation, Doc, Message, TaskStatus } from "@/types";

const SUGGESTIONS = [
  "Give me a briefing of my day: calendar, important emails and pending approvals",
  "Find 5 remote senior backend roles that match my profile and score them",
  "Research the top 3 competitors of Linear and summarize with sources",
  "Summarize my unread emails from the last 2 days and draft replies for the urgent ones",
];

export function Chat({ conversationId }: { conversationId?: string }) {
  const router = useRouter();
  const { user, setUser } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<Doc[]>([]);
  const [agent, setAgent] = useState<string>("");
  const [activeTasks, setActiveTasks] = useState<Set<string>>(new Set());
  const speakOn = !!user?.settings?.speak_responses;
  const { data: convs, reload: reloadConvs } = useApi<Conversation[]>("/api/conversations");
  const { data: agents } = useApi<Agent[]>("/api/agents");
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    api<{ messages: Message[] }>(`/api/conversations/${conversationId}`)
      .then((c) => {
        if (cancelled) return;
        setMessages(c.messages);
        const answered = new Set(c.messages.filter((m) => m.role === "assistant" && m.task_id).map((m) => m.task_id));
        setActiveTasks(new Set(c.messages.filter((m) => m.role === "user" && m.task_id && !answered.has(m.task_id)).map((m) => m.task_id!)));
      })
      .catch(() => {
        if (cancelled) return;
        toast.error("Conversation not found");
        router.replace("/assistant");
      });
    return () => { cancelled = true; };
  }, [conversationId, router]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages.length, activeTasks.size]);

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || sending) return;
    setSending(true);
    try {
      let cid = conversationId;
      if (!cid) cid = (await post<Conversation>("/api/conversations")).id;
      const r = await post<{ message: Message; task_id: string }>(`/api/conversations/${cid}/messages`,
        { content, document_ids: attachments.map((a) => a.id), agent: agent || undefined });
      setInput("");
      setAttachments([]);
      if (!conversationId) { router.push(`/assistant/${cid}`); void reloadConvs(); return; }
      setMessages((m) => [...m, r.message]);
      setActiveTasks((s) => new Set(s).add(r.task_id));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
      taRef.current?.focus();
    }
  };

  const voice = useVoice((t) => void send(t));

  const onFinished = async (taskId: string, status: TaskStatus) => {
    setActiveTasks((s) => { const n = new Set(s); n.delete(taskId); return n; });
    const c = await api<{ messages: Message[] }>(`/api/conversations/${conversationId}`);
    setMessages(c.messages);
    void reloadConvs();
    const reply = [...c.messages].reverse().find((m) => m.role === "assistant" && m.task_id === taskId);
    if (speakOn && reply && status !== "CANCELLED") void voice.speak(reply.content);
  };

  const onFiles = async (files: FileList | null) => {
    for (const f of Array.from(files || [])) {
      const fd = new FormData();
      fd.append("file", f);
      try {
        const d = await upload<Doc>("/api/documents", fd);
        setAttachments((a) => [...a, d]);
      } catch (e) { toast.error(`${f.name}: ${(e as Error).message}`); }
    }
  };

  const toggleSpeak = async () => {
    try {
      const u = await api<typeof user>("/api/auth/me/settings", { method: "PATCH", json: { speak_responses: !speakOn } });
      if (u) setUser(u);
      if (speakOn) voice.stopSpeaking();
    } catch (e) { toast.error((e as Error).message); }
  };

  const removeConv = async (id: string) => {
    await del(`/api/conversations/${id}`);
    void reloadConvs();
    if (id === conversationId) router.push("/assistant");
  };

  const orbState = voice.state !== "idle" ? voice.state : activeTasks.size ? "thinking" : "idle";

  return (
    <div className="mx-auto flex h-[calc(100dvh-7.5rem)] max-w-6xl gap-5">
      <aside className="hidden w-60 shrink-0 flex-col lg:flex">
        <Button variant="secondary" className="mb-3 justify-start" onClick={() => router.push("/assistant")}><Plus />New conversation</Button>
        <ul className="-mx-1 flex-1 space-y-0.5 overflow-y-auto px-1 scrollbar-thin" aria-label="Conversation history">
          {convs?.map((c) => (
            <li key={c.id} className="group relative">
              <Link href={`/assistant/${c.id}`} className={cn("block rounded-lg px-2.5 py-2 pr-8 text-[13px] hover:bg-surface-2",
                c.id === conversationId ? "bg-surface-2 text-foreground" : "text-muted")}>
                <span className="block truncate">{c.title}</span>
                <span className="text-[10px] text-subtle">{timeAgo(c.updated_at)}</span>
              </Link>
              <button onClick={() => void removeConv(c.id)} aria-label={`Delete ${c.title}`}
                className="absolute right-1.5 top-2.5 hidden rounded p-1 text-subtle hover:text-danger group-hover:block focus:block">
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto pr-1 scrollbar-thin" aria-live="polite">
          {!conversationId && messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <LexaOrb state={orbState} level={voice.level} size={112} />
              <h1 className="mt-6 text-2xl font-semibold tracking-tight">How can I help{user?.full_name ? `, ${user.full_name.split(" ")[0]}` : ""}?</h1>
              <p className="mt-1 text-sm text-muted">I plan, delegate to specialist agents and ask before acting.</p>
              <div className="mt-8 grid w-full max-w-2xl gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => void send(s)} className="rounded-xl border border-border bg-surface p-3 text-left text-[13px] text-muted transition hover:border-border-strong hover:text-foreground">{s}</button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-6 pb-4">
              {messages.map((m) => (
                <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                  {m.role === "user" ? (
                    <div className="max-w-[85%] space-y-1.5">
                      <div className="rounded-2xl rounded-br-md bg-primary/12 border border-primary/20 px-4 py-2.5 text-sm whitespace-pre-wrap">{m.content}</div>
                      {m.attachments?.length > 0 && <div className="flex flex-wrap justify-end gap-1">{m.attachments.map((a) => (
                        <span key={a.id} className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted"><FileText className="size-3" />{a.filename}</span>))}</div>}
                    </div>
                  ) : (
                    <div className="group w-full">
                      <div className="mb-1.5 flex items-center gap-2 text-[11px] text-subtle">
                        <LexaOrb size={18} /> LEXA
                        {m.meta?.status && m.meta.status !== "COMPLETED" && <span className="text-warning">· {String(m.meta.status).toLowerCase().replaceAll("_", " ")}</span>}
                        {m.task_id && <Link href={`/tasks/${m.task_id}`} className="hover:text-accent">· details</Link>}
                        <button className="opacity-0 transition group-hover:opacity-100" aria-label="Copy" onClick={() => { void navigator.clipboard.writeText(m.content); toast("Copied"); }}><Copy className="size-3" /></button>
                        <button className="opacity-0 transition group-hover:opacity-100" aria-label="Read aloud" onClick={() => void voice.speak(m.content)}><Volume2 className="size-3" /></button>
                      </div>
                      <Md>{m.content}</Md>
                      {m.task_id && m.meta?.status === "WAITING_FOR_APPROVAL" && (
                        <div className="mt-3"><TaskLive taskId={m.task_id} compact /></div>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {[...activeTasks].map((t) => (
                <div key={t} className="flex gap-3"><LexaOrb size={24} state="thinking" className="mt-1 shrink-0" />
                  <div className="min-w-0 flex-1"><TaskLive taskId={t} onFinished={(s) => void onFinished(t, s)} /></div>
                </div>
              ))}
              <div ref={endRef} />
            </div>
          )}
        </div>

        <div className="mx-auto w-full max-w-3xl pt-3">
          {(voice.state === "listening" || voice.interim) && (
            <div className="mb-2 flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2">
              <LexaOrb size={28} state="listening" level={voice.level} />
              <span className="flex-1 truncate text-sm text-muted">{voice.interim || "Listening…"}</span>
              <Button size="sm" variant="ghost" onClick={voice.stop}>Done</Button>
            </div>
          )}
          {voice.error && <p role="alert" className="mb-2 text-xs text-danger">{voice.error}</p>}
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {attachments.map((a) => (
                <span key={a.id} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-xs">
                  <FileText className="size-3.5 text-primary" />{a.filename}
                  <button aria-label={`Remove ${a.filename}`} onClick={() => setAttachments((x) => x.filter((y) => y.id !== a.id))}><X className="size-3" /></button>
                </span>
              ))}
            </div>
          )}
          <div className="rounded-2xl border border-border-strong bg-surface shadow-[var(--shadow)] focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-[var(--ring)]">
            <label htmlFor="lexa-input" className="sr-only">Message LEXA</label>
            <textarea id="lexa-input" ref={taRef} value={input} onChange={(e) => setInput(e.target.value)} rows={1}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              placeholder="Ask LEXA to plan, research, draft, schedule…"
              className="max-h-48 min-h-12 w-full resize-none bg-transparent px-4 pt-3.5 text-sm outline-none placeholder:text-subtle field-sizing-content" />
            <div className="flex items-center gap-1 px-2 pb-2">
              <input ref={fileRef} type="file" multiple hidden onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }}
                accept=".pdf,.txt,.md,.docx,.csv,.json,.html" />
              <Button size="icon" variant="ghost" aria-label="Attach files" onClick={() => fileRef.current?.click()}><Paperclip /></Button>
              <Button size="icon" variant="ghost" aria-label={voice.state === "listening" ? "Stop listening" : "Voice input"}
                onClick={() => (voice.state === "listening" ? voice.stop() : void voice.start())}
                className={cn(voice.state === "listening" && "text-primary")}>
                {voice.state === "listening" ? <MicOff /> : <Mic />}
              </Button>
              <Button size="icon" variant="ghost" aria-label={speakOn ? "Disable spoken responses" : "Enable spoken responses"} aria-pressed={speakOn} onClick={() => void toggleSpeak()}>
                {speakOn ? <AudioLines className="text-primary" /> : <VolumeX />}
              </Button>
              {voice.state === "speaking" && <Button size="sm" variant="ghost" onClick={voice.stopSpeaking}>Stop speaking</Button>}
              <label htmlFor="agent-select" className="sr-only">Route to agent</label>
              <select id="agent-select" value={agent} onChange={(e) => setAgent(e.target.value)}
                className="ml-1 h-8 max-w-40 rounded-lg border border-border bg-surface-2/60 px-2 text-xs text-muted outline-none">
                <option value="">Auto (LEXA CORE)</option>
                {agents?.filter((a) => a.enabled).map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
              </select>
              <Button size="icon" variant="gradient" className="ml-auto rounded-xl" aria-label="Send" onClick={() => void send()} disabled={!input.trim()} loading={sending}>
                {!sending && <ArrowUp />}
              </Button>
            </div>
          </div>
          <p className="mt-1.5 text-center text-[10px] text-subtle">External actions wait for your approval unless you configured autonomy rules.</p>
        </div>
      </section>
    </div>
  );
}
