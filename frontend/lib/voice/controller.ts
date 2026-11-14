/**
 * The voice brain: listens (mic → VAD → transcription), decides what was meant (command grammar first, LEXA CORE
 * otherwise), operates the UI, reads results aloud and runs the approval conversation.
 *
 * Rules it enforces (see docs/VOICE.md):
 *  - An approval can only be approved by voice after the whole action has been read to the user; high-risk actions
 *    need a second, explicit "approve". "Never mind" / "cancel" leave things pending, only "reject" rejects.
 *  - Words picked up while LEXA is speaking can interrupt it but can never approve, confirm, click or type.
 *  - LEXA's own voice coming back through the microphone is recognised and discarded.
 *  - Destructive controls (delete, disconnect, sign out…) need a spoken yes. Password-like fields are never dictated.
 *  - Command handling never waits for speech to finish, so "stop" always works.
 */
import type { Approval, Task } from "@/types";
import { HELP_SPOKEN, parseCommand, stripWake, type Command } from "./commands";
import * as dom from "./dom-actions";
import type { Cue } from "./earcons";
import type { MicHandlers, MicLike, Utterance } from "./mic";
import { isEcho, isLikelyHallucination, speakableApproval, speakableSummary, takeSpoken, toSpeakable } from "./speech-text";
import type { SpeakEnd, SpeakerLike } from "./speaker";

export type Phase = "off" | "starting" | "listening" | "hearing" | "transcribing" | "thinking" | "speaking" | "sleeping";

export interface HistoryLine { id: number; role: "you" | "lexa"; text: string; at: number }
export type Awaiting = { kind: "approval" | "confirm" | "choice"; prompt: string } | null;

export interface VoiceSnapshot {
  active: boolean;
  /** Something is listening. False in "text-only" voice mode (no speech recognition available). */
  listening: boolean;
  /** Who is turning speech into text right now: OpenAI (server), the browser's own recogniser (free), or nobody. */
  recognition: "server" | "browser" | "none";
  phase: Phase;
  heard: string;
  /** Live partial text while you are still speaking (browser recognition only). */
  interim: string;
  said: string;
  error: string | null;
  notice: string | null;
  awaiting: Awaiting;
  micProblem: string | null;
  history: HistoryLine[];
}

export interface DashboardLite {
  active_tasks: Pick<Task, "id" | "title" | "status">[];
  pending_approvals: Approval[];
  unread_notifications: number;
  schedule: { connected: boolean; events: { summary: string; start: { dateTime?: string; date?: string } }[] };
  usage: { month_spend_usd: number; budget_usd: number };
}
export interface NotificationLite { id: string; title: string; body: string; read: boolean; kind: string; severity: string }
export interface TaskLite { id: string; status: string; title?: string; error?: string | null; output?: string | null; output_preview?: string }

export interface VoiceApi {
  transcribe(wav: Uint8Array, durationMs: number, language: string): Promise<{ text: string; skipped?: string }>;
  approvals(): Promise<Approval[]>;
  decide(id: string, approve: boolean): Promise<void>;
  dashboard(): Promise<DashboardLite>;
  notifications(): Promise<NotificationLite[]>;
  markNotificationsRead(): Promise<void>;
  task(id: string): Promise<TaskLite>;
  cancelTask(id: string): Promise<void>;
}

export interface VoiceHost {
  navigate(path: string): void;
  back(): void;
  forward(): void;
  pathname(): string;
  /** Sends a request to LEXA CORE; resolves with the task so its result can be read aloud. */
  ask(text: string, opts: { voice: boolean }): Promise<{ taskId: string; conversationId?: string } | null>;
}

export type Recognition = "server" | "browser" | "none";

export interface VoiceConfig {
  speed: number;
  language: string;
  /** auto: OpenAI when it works, otherwise the browser's own (free) recogniser. */
  recognition: "auto" | "server" | "browser";
  patience: "quick" | "normal" | "patient";
  wakePhrase: boolean;
  cues: boolean;
  speakResponses: boolean;
}

export interface ControllerDeps {
  api: VoiceApi;
  host: VoiceHost;
  speaker: SpeakerLike;
  createMic: (h: MicHandlers) => MicLike;
  /** The browser's own speech recogniser (Chrome, Edge, Safari); null where there is none (Firefox). */
  createRecognizer?: (h: MicHandlers & { onTranscript: (text: string, meta: { duringSpeech: boolean }) => void }) => MicLike | null;
  /** OpenAI speech recognition is configured on the server (default true until the server says otherwise). */
  serverStt?: () => boolean;
  config: () => VoiceConfig;
  setSpeed: (speed: number) => void;
  playCue: (c: Cue) => void;
  cueDuration?: (c: Cue) => number;
  openHelp?: () => void;
  now?: () => number;
}

/** The few fields of LEXA's realtime events that voice cares about. */
export interface EventData { task_id?: string; status?: string; kind?: string; title?: string; severity?: string }

export interface HearMeta {
  /** Typed into the voice box instead of spoken: exempt from the "wait until it was read" rule. */
  typed?: boolean;
  /** Spoken while LEXA was talking. */
  duringSpeech?: boolean;
}

export const PATIENCE_MS = { quick: 600, normal: 1000, patient: 1800 } as const;
export const IDLE_SLEEP_MS = 5 * 60_000;
const HIGH_CONFIRM_WINDOW_MS = 45_000;
const CHOICE_WINDOW_MS = 30_000;
const MIN_DURING_SPEECH_MS = 350;
/** The microphone can still pick up LEXA's voice (reverb, echo-canceller lag) for a moment after it stops. */
const ECHO_TAIL_MS = 800;

/** Why server (OpenAI) recognition cannot be used, as a clause that reads well after "…, so I'm switching…". */
const SERVER_DOWN_REASON: Record<string, string> = {
  no_credits: "Your OpenAI account has no credits left",
  not_configured: "Speech recognition isn't set up on the server (it needs an OpenAI API key)",
  invalid_key: "OpenAI rejected the API key",
  budget: "Your monthly AI budget is used up",
};
const SERVER_DOWN_KEY = "lexa.voice.server-down";
const SERVER_DOWN_MS = 10 * 60_000;
const NO_BROWSER_STT = "This browser has no built-in speech recognition (Chrome, Edge and Safari have it; Firefox does not)";
const NO_CREDITS_HELP = "Add credits at platform.openai.com, or open LEXA in Chrome or Edge for free voice.";

const MIC_MESSAGES: Record<string, string> = {
  denied: "Microphone access is blocked. Allow the microphone for this site in your browser's address bar, then turn voice on again.",
  "no-device": "No microphone was found. Plug one in, then turn voice on again.",
  busy: "The microphone is being used by another app.",
  unsupported: "This browser can't record audio here. Voice needs a secure HTTPS page and a current browser.",
  lost: "The microphone disconnected.",
  failed: "The microphone could not be started.",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const short = (s: string | null | undefined, n = 200) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

type ApprovalFlow = { list: Approval[]; i: number; readDone: boolean; highAskedAt: number | null };
type PendingChoice = { items: dom.Item[]; pick: (item: dom.Item) => void; at: number };
type PendingConfirm = { label: string; run: () => void; at: number };
type WatchedTask = { startedAt: number; timers: ReturnType<typeof setTimeout>[]; heard: boolean };

export class VoiceController {
  private snap: VoiceSnapshot = {
    active: false, listening: false, recognition: "none", phase: "off", heard: "", interim: "", said: "", error: null,
    notice: null, awaiting: null, micProblem: null, history: [],
  };
  private level = 0;
  private listeners = new Set<() => void>();
  private levelListeners = new Set<() => void>();
  private mic: MicLike;
  private serverMic: MicLike;
  private browserMic: MicLike | null;
  private serverDownCode: string | null = null;

  private active = false;
  private sleeping = false;
  private hearing = false;
  private pendingStt = 0;
  private speakingNow = false;

  private queue: Utterance[] = [];
  private pumping = false;
  private uploads: number[] = [];
  private lastActivity = 0;
  private lastLexaEnd = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private lastSttErrorAt = 0;
  private historyId = 0;

  private flow: ApprovalFlow | null = null;
  private pendingChoice: PendingChoice | null = null;
  private pendingConfirm: PendingConfirm | null = null;
  private declined = new Set<string>();
  private autoReviewTimer: ReturnType<typeof setTimeout> | null = null;
  private routeTimer: ReturnType<typeof setTimeout> | null = null;

  private tasks = new Map<string, WatchedTask>();
  private lastReply = "";
  private more = "";
  private lastConversation: string | null = null;

  constructor(private d: ControllerDeps) {
    const common: MicHandlers = {
      onUtterance: (u) => this.onUtterance(u),
      onLevel: (l) => { this.level = l; this.levelListeners.forEach((f) => f()); },
      onSpeechStart: () => { this.hearing = true; this.recompute(); },
      onSpeechEnd: () => { this.hearing = false; this.recompute(); },
      onInterim: (t) => { if (t !== this.snap.interim) this.patch({ interim: t }); },
      onError: (e) => { this.patch({ micProblem: MIC_MESSAGES[e.code] ?? e.message }); void this.stop("mic"); },
      isSpeaking: () => this.d.speaker.speaking || this.now() - this.lastLexaEnd < ECHO_TAIL_MS,
    };
    this.serverMic = d.createMic(common);
    this.browserMic = d.createRecognizer?.({ ...common, onTranscript: (t, meta) => this.onBrowserTranscript(t, meta) }) ?? null;
    this.mic = this.serverMic;
  }

  // -------------------------------------------------------------------------------------------------- store API

  subscribe = (f: () => void): (() => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
  getSnapshot = (): VoiceSnapshot => this.snap;
  subscribeLevel = (f: () => void): (() => void) => { this.levelListeners.add(f); return () => { this.levelListeners.delete(f); }; };
  getLevel = (): number => this.level;

  private now(): number { return this.d.now ? this.d.now() : Date.now(); }
  private cfg(): VoiceConfig { return this.d.config(); }
  private cue(c: Cue): void {
    if (!this.cfg().cues) return;
    this.mic.ignoreFor((this.d.cueDuration?.(c) ?? 300));
    this.d.playCue(c);
  }
  private patch(p: Partial<VoiceSnapshot>): void {
    this.snap = { ...this.snap, ...p };
    this.listeners.forEach((f) => f());
  }
  private recompute(): void {
    let phase: Phase;
    if (!this.active) phase = this.snap.phase === "starting" ? "starting" : "off";
    else if (this.speakingNow) phase = "speaking";
    else if (this.hearing) phase = "hearing";
    else if (this.pendingStt > 0) phase = "transcribing";
    else if (this.sleeping) phase = "sleeping";
    else if (this.tasks.size > 0) phase = "thinking";
    else phase = "listening";
    if (phase !== this.snap.phase) this.patch({ phase });
  }
  private log(role: "you" | "lexa", text: string): void {
    const line: HistoryLine = { id: ++this.historyId, role, text: short(text, 600), at: this.now() };
    this.patch({ history: [...this.snap.history, line].slice(-40), ...(role === "you" ? { heard: line.text } : { said: line.text }) });
  }
  private setAwaiting(a: Awaiting): void { if (a?.prompt !== this.snap.awaiting?.prompt || a?.kind !== this.snap.awaiting?.kind) this.patch({ awaiting: a }); }

  // ------------------------------------------------------------------------------------------------ lifecycle

  // ---------------------------------------------------------------------------------- which engine listens

  /** OpenAI recognition was found unusable a short while ago (no credits, bad key…): do not try it again at once. */
  private serverDown(): string | null {
    if (this.serverDownCode) return this.serverDownCode;
    try {
      const raw = sessionStorage.getItem(SERVER_DOWN_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw) as { code: string; at: number };
      if (this.now() - v.at < SERVER_DOWN_MS) return v.code;
      sessionStorage.removeItem(SERVER_DOWN_KEY);
    } catch { /* no storage */ }
    return null;
  }

  private markServerDown(code: string): void {
    this.serverDownCode = code;
    try { sessionStorage.setItem(SERVER_DOWN_KEY, JSON.stringify({ code, at: this.now() })); } catch { /* no storage */ }
  }

  private serverUsable(): boolean { return (this.d.serverStt?.() ?? true) && !this.serverDown(); }

  private chooseRecognition(): Recognition {
    const pref = this.cfg().recognition;
    const server = this.serverUsable();
    const browser = this.browserMic !== null;
    if (pref === "server") return server ? "server" : "none";
    if (pref === "browser") return browser ? "browser" : "none";
    return server ? "server" : browser ? "browser" : "none";
  }

  /** Why nothing can listen, in words that also say what to do about it. */
  private whyNoRecognition(): string {
    const pref = this.cfg().recognition;
    const code = this.serverDown() ?? (this.d.serverStt?.() === false ? "not_configured" : null);
    if (pref === "browser") return `${NO_BROWSER_STT}. Pick OpenAI recognition in Settings, Voice, or use Chrome or Edge.`;
    const server = code ? SERVER_DOWN_REASON[code] ?? "OpenAI speech recognition isn't available" : "Speech recognition isn't available";
    if (pref === "server") return `${server}. ${code === "no_credits" ? NO_CREDITS_HELP : "Check the server's OpenAI key."}`;
    return `${server}, and ${NO_BROWSER_STT.charAt(0).toLowerCase()}${NO_BROWSER_STT.slice(1)}. ${code === "no_credits" ? NO_CREDITS_HELP : "Open LEXA in Chrome or Edge for free voice, or set up the OpenAI key."}`;
  }

  private async startListening(engine: Exclude<Recognition, "none">): Promise<{ ok: true } | { ok: false; error: unknown }> {
    const mic = engine === "server" ? this.serverMic : this.browserMic!;
    try {
      mic.setEndSilence(PATIENCE_MS[this.cfg().patience]);
      await mic.start();
      this.mic = mic;
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  // ------------------------------------------------------------------------------------------------ lifecycle

  /** Must be called from a user gesture (button, hotkey) so the browser allows microphone and audio. */
  async start(opts: { quiet?: boolean; listen?: boolean } = {}): Promise<boolean> {
    if (this.active) return true;
    this.d.speaker.unlock();
    this.patch({ phase: "starting", error: null, micProblem: null });
    const engine: Recognition = opts.listen === false ? "none" : this.chooseRecognition();
    if (engine !== "none") {
      const r = await this.startListening(engine);
      if (!r.ok) {
        const code = (r.error as { code?: string }).code ?? "failed";
        this.patch({ phase: "off", micProblem: MIC_MESSAGES[code] ?? (r.error as Error).message });
        this.cue("error");
        void this.d.speaker.speak(MIC_MESSAGES[code] ?? "The microphone could not be started.");
        return false;
      }
    }
    this.active = true;
    this.sleeping = false;
    this.lastActivity = this.now();
    this.patch({ active: true, listening: engine !== "none", recognition: engine, error: null, notice: null, interim: "" });
    this.recompute();
    this.cue("start");
    this.idleTimer = setInterval(() => this.checkIdle(), 15_000);
    if (engine === "none") {
      const why = this.whyNoRecognition();
      this.patch({ notice: `${why} You can type commands in the box below; I will still speak.` });
      void this.say(`Voice mode is on, but I can't hear you. ${why} Type commands in the box below and I will answer out loud.`, { remember: false });
    } else if (!opts.quiet) void this.intro();
    return true;
  }

  async stop(why: "user" | "mic" | "fatal" = "user"): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    this.serverMic.stop();
    this.browserMic?.stop();
    this.d.speaker.stop();
    this.active = false;
    this.sleeping = false;
    this.hearing = false;
    this.pendingStt = 0;
    this.queue = [];
    this.flow = null;
    this.pendingChoice = null;
    this.pendingConfirm = null;
    this.clearTasks();
    if (this.autoReviewTimer) clearTimeout(this.autoReviewTimer);
    this.setAwaiting(null);
    this.patch({ active: false, listening: false, recognition: "none", interim: "", phase: "off", ...(why === "user" ? { notice: "Voice mode is off." } : {}) });
    if (why === "user") this.cue("sleep");
  }

  toggle(): Promise<boolean | void> { return this.active ? this.stop() : this.start(); }

  /** Buttons in the voice bar. */
  goToSleep(): void { if (this.active && !this.sleeping) this.sleep("user"); }
  wakeUp(): void { if (this.active && this.sleeping) this.wake(); }

  dispose(): void {
    void this.stop("fatal");
    this.listeners.clear();
    this.levelListeners.clear();
    if (this.routeTimer) clearTimeout(this.routeTimer);
  }

  stopSpeaking(): void { this.d.speaker.stop(); }

  /** Called by the speaker callbacks. */
  onSpeakStart = (): void => { this.speakingNow = true; this.recompute(); };
  onSpeakEnd = (): void => {
    this.speakingNow = false;
    this.lastLexaEnd = this.now();
    this.recompute();
  };

  private async intro(): Promise<void> {
    let extra = "";
    try {
      const dash = await this.d.api.dashboard();
      const n = dash.pending_approvals.length;
      if (n) extra = ` You have ${plural(n, "approval")} waiting. Say review approvals when you're ready.`;
    } catch { /* offline: skip */ }
    let seen = false;
    try { seen = localStorage.getItem("lexa.voice.intro") === "1"; localStorage.setItem("lexa.voice.intro", "1"); } catch { /* private mode */ }
    void this.say(seen ? `I'm listening.${extra}` : `Voice mode is on. Just tell me what you need, or say help to hear what I can do.${extra}`);
  }

  private checkIdle(): void {
    if (!this.active || this.sleeping) return;
    if (this.flow || this.tasks.size || this.d.speaker.speaking || this.pendingChoice || this.pendingConfirm) return;
    if (this.now() - this.lastActivity > IDLE_SLEEP_MS) this.sleep("idle");
  }

  private sleep(why: "idle" | "user"): void {
    this.sleeping = true;
    this.cue("sleep");
    this.patch({ notice: why === "idle" ? "Sleeping after a quiet few minutes. Say “Hey LEXA” to wake me." : "Sleeping. Say “Hey LEXA” to wake me." });
    this.recompute();
  }

  private wake(): void {
    this.sleeping = false;
    this.lastActivity = this.now();
    this.patch({ notice: null });
    this.cue("wake");
    this.recompute();
  }

  // ------------------------------------------------------------------------------------------------ listening

  private allowUpload(): boolean {
    const t = this.now();
    this.uploads = this.uploads.filter((x) => t - x < 60_000);
    const limit = this.sleeping ? 8 : 30;
    if (this.uploads.length >= limit) return false;
    this.uploads.push(t);
    return true;
  }

  private onUtterance(u: Utterance): void {
    if (!this.active) return;
    if (u.duringSpeech && u.speechMs < MIN_DURING_SPEECH_MS) return; // clicks / echo bursts while LEXA talks
    if (!this.allowUpload()) {
      this.patch({ notice: "It's noisy, so I'm pausing speech recognition for a moment." });
      return;
    }
    this.queue.push(u);
    if (this.queue.length > 3) this.queue.shift();
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && this.active) {
        const u = this.queue.shift()!;
        await this.transcribeAndHandle(u);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async transcribeAndHandle(u: Utterance): Promise<void> {
    this.pendingStt++;
    this.recompute();
    let text = "";
    try {
      const r = await this.d.api.transcribe(u.wav, u.durationMs, this.cfg().language);
      text = (r.text || "").trim();
    } catch (e) {
      this.onSttError(e);
    } finally {
      this.pendingStt--;
      this.recompute();
    }
    await this.afterTranscript(text, { duringSpeech: u.duringSpeech, durationMs: u.durationMs });
  }

  /** The browser's recogniser delivered a finished sentence (no upload, no cost). */
  private onBrowserTranscript(text: string, meta: { duringSpeech: boolean }): void {
    void this.afterTranscript(text.trim(), { duringSpeech: meta.duringSpeech, durationMs: 1500 });
  }

  /** Common to both engines: drop noise and LEXA's own voice, then treat it as something the user said. */
  private async afterTranscript(text: string, o: { duringSpeech: boolean; durationMs: number }): Promise<void> {
    if (!text || !this.active) return;
    if (isLikelyHallucination(text, o.durationMs)) return;
    // Echo can only exist while LEXA is audible. Someone repeating a suggestion ("say review approvals") after LEXA
    // has finished is not an echo.
    if (o.duringSpeech) {
      const recent = this.d.speaker.recent();
      if (recent && isEcho(text, recent)) return;
    }
    await this.hear(text, { duringSpeech: o.duringSpeech });
  }

  private onSttError(e: unknown): void {
    const status = (e as { status?: number })?.status;
    const code = (e as { code?: string })?.code ?? (status === 503 ? "not_configured" : undefined);
    const msg = (e as Error)?.message || "";
    if (code && SERVER_DOWN_REASON[code]) {
      // OpenAI cannot transcribe for this account right now. Retrying is pointless: use the browser's recogniser if
      // there is one (and allowed), otherwise carry on in text-only mode and say exactly why.
      this.markServerDown(code);
      void this.fallBackFromServer(code);
      return;
    }
    if (status === 429) { this.patch({ notice: "Too much speech at once. Pausing for a moment." }); return; }
    if (this.now() - this.lastSttErrorAt > 10_000) {
      this.lastSttErrorAt = this.now();
      this.cue("error");
      this.patch({ error: `I couldn't hear that${msg ? `: ${short(msg, 120)}` : ""}.` });
    }
  }

  private async fallBackFromServer(code: string): Promise<void> {
    if (this.recognition() !== "server") return; // already handled by an earlier failing sentence
    this.serverMic.stop();
    this.queue = [];
    this.cue("error");
    if (this.cfg().recognition === "auto" && this.browserMic) {
      const r = await this.startListening("browser");
      if (r.ok) {
        this.patch({ recognition: "browser", listening: true, error: null, notice: "Using your browser's free speech recognition." });
        void this.say(`${SERVER_DOWN_REASON[code]}, so I'm switching to your browser's free speech recognition. Please say that again.`, { remember: false });
        return;
      }
    }
    this.patch({ recognition: "none", listening: false, interim: "" });
    const why = this.whyNoRecognition();
    this.patch({ error: why, notice: "Voice is now text-only: type commands in the box below." });
    void this.say(`${why} You can keep typing commands in the box below.`, { remember: false });
  }

  private recognition(): Recognition { return this.snap.recognition; }

  // ----------------------------------------------------------------------------------------------- speaking

  /** Speak without waiting for it to finish. Resolves with how it ended. */
  private say(text: string, o: { interrupt?: boolean; remember?: boolean } = {}): Promise<SpeakEnd> {
    const spoken = text.replace(/\s+/g, " ").trim();
    if (!spoken) return Promise.resolve("done");
    if (o.remember !== false) this.lastReply = spoken;
    this.log("lexa", spoken);
    return this.d.speaker.speak(spoken, { interrupt: o.interrupt });
  }

  /** A typed command (the voice box): same grammar, but nothing waits for speech and the text is already visible. */
  hearTyped(text: string): Promise<void> { return this.hear(text, { typed: true }); }

  /** Reads long text (a chat reply) aloud: plain speech, the first part now, "read more" for the rest. */
  readAloud(markdown: string): void {
    const spoken = toSpeakable(markdown);
    if (!spoken) return;
    const { head, rest } = takeSpoken(spoken, 900);
    this.more = rest;
    void this.say(head + (rest ? " Say read more for the rest." : ""));
  }

  setNotice(text: string | null): void { this.patch({ notice: text }); }

  /** Voice cannot work (e.g. no speech recognition on the server): say so instead of opening a useless microphone. */
  unavailable(message: string): void {
    this.patch({ error: message });
    this.cue("error");
    void this.say(message, { remember: false });
  }

  /** For other parts of the UI (e.g. confirmation dialogs) that want LEXA to read something. */
  announce(text: string): void {
    if (this.active || this.cfg().speakResponses) void this.say(text, { remember: false });
  }

  // ----------------------------------------------------------------------------------------------- commands

  /** Entry point for every utterance: spoken (after transcription) or typed in the voice box. */
  async hear(raw: string, meta: HearMeta = {}): Promise<void> {
    const { text, woke } = stripWake(raw);
    if (!meta.typed) this.lastActivity = this.now();
    if (this.sleeping && !meta.typed) {
      if (!woke) return;
      this.wake();
      if (!text) { void this.say("Yes?", { remember: false }); return; }
    }
    if (!meta.typed && this.cfg().wakePhrase && !woke && !this.inConversation()) return;
    if (!text) { void this.say("Yes?", { remember: false }); return; }
    this.log("you", raw.trim());
    await this.dispatch(parseCommand(text), text, meta);
  }

  /** True while a reply is being discussed, so wake-phrase mode does not demand "Hey LEXA" mid-conversation. */
  private inConversation(): boolean {
    return !!(this.flow || this.pendingChoice || this.pendingConfirm) || this.d.speaker.speaking
      || this.now() - this.lastLexaEnd < 12_000;
  }

  private async dispatch(cmd: Command, raw: string, meta: HearMeta): Promise<void> {
    if (meta.duringSpeech) {
      const allowedWhileSpeaking: Command["type"][] = [
        "stopSpeaking", "cancelTask", "exit", "standby", "speed", "negate", "dismiss", "skip", "help", "repeat", "readMore",
        "readPage", "where", "listActions", "status", "notifications", "approvals", "navigate", "back", "forward",
        "newConversation", "scroll", "close", "ask",
      ];
      if (!allowedWhileSpeaking.includes(cmd.type)) return; // could be an echo: never act on it
      if (cmd.type !== "stopSpeaking") this.d.speaker.stop(); // a real interruption
    }
    // Anything but an answer cancels a pending question.
    if (!["affirm", "negate", "dismiss", "choice", "skip", "ack", "greet", "stopSpeaking", "repeat"].includes(cmd.type)) {
      this.pendingChoice = null;
      this.pendingConfirm = null;
    }
    switch (cmd.type) {
      case "stopSpeaking": return this.onStopWord();
      case "ack": return; // "thanks", "ok": nothing to do, and no AI call
      case "greet": void this.say("I'm listening. What do you need?", { remember: false }); return;
      case "exit": void this.say("Okay, voice mode off.", { remember: false }).then(() => this.stop("user")); return;
      case "standby": void this.say("Going to sleep. Say Hey LEXA when you need me.", { remember: false }).then(() => this.sleep("user")); return;
      case "help": this.d.openHelp?.(); void this.say(HELP_SPOKEN); return;
      case "repeat": return this.onRepeat();
      case "readMore": return this.onReadMore();
      case "readPage": return this.onReadPage();
      case "where": return this.onWhere();
      case "listActions": return this.onListActions();
      case "status": return void this.onStatus();
      case "notifications": return void this.onNotifications();
      case "approvals": return void this.reviewApprovals({ auto: false });
      case "affirm": return void this.onAffirm(cmd.explicit, meta);
      case "negate": return void this.onNegate(meta);
      case "dismiss": return this.onDismiss();
      case "skip": return this.onSkip();
      case "choice": return this.onChoice(cmd.index);
      case "navigate": return this.onNavigate(cmd.path, cmd.label);
      case "readLast": return this.onReadLast();
      case "openConversation": this.cue("ok"); this.d.host.navigate(this.lastConversation ? `/assistant/${this.lastConversation}` : "/assistant"); return;
      case "back": this.cue("ok"); this.d.host.back(); return;
      case "forward": this.cue("ok"); this.d.host.forward(); return;
      case "newConversation": this.cue("ok"); this.d.host.navigate("/assistant"); return;
      case "scroll": return this.onScroll(cmd.dir);
      case "close": return this.onClose();
      case "cancelTask": return void this.onCancelTask();
      case "speed": return this.onSpeed(cmd.direction);
      case "click": return void this.doClick(cmd, raw, meta);
      case "toggle": return void this.doToggle(cmd, raw, meta);
      case "fill": return void this.doFill(cmd, raw, meta);
      case "dictate": return void this.doDictate(cmd.text, raw, meta);
      case "focus": return this.doFocus(cmd.target);
      case "submit": return this.doSubmit();
      case "ask": return void this.ask(cmd.text, meta);
    }
  }

  private onStopWord(): void {
    this.d.speaker.stop();
    // The approval stays pending but counts as not fully read: voice approval is blocked until it has been heard.
    if (this.flow) this.flow.readDone = false;
  }

  private onRepeat(): void {
    if (this.flow) { this.narrateApproval(); return; }
    if (this.lastReply) void this.say(this.lastReply);
    else void this.say("There's nothing to repeat yet.", { remember: false });
  }

  /** Reads the newest reply on screen (chat answers are marked data-voice-reply). */
  private onReadLast(): void {
    const replies = Array.from(document.querySelectorAll<HTMLElement>("[data-voice-reply]")).filter((n) => dom.isVisible(n));
    const last = replies[replies.length - 1];
    if (!last) { void this.say("There's no reply on this page to read. Say repeat to hear what I last said.", { remember: false }); return; }
    this.readAloud(last.innerText || last.textContent || "");
  }

  private onReadMore(): void {
    if (!this.more) { void this.say("There's nothing more to read.", { remember: false }); return; }
    const { head, rest } = takeSpoken(this.more, 900);
    this.more = rest;
    void this.say(head + (rest ? " Say read more to continue." : " That's everything."));
  }

  // --------------------------------------------------------------------------------------------- reading the UI

  private onWhere(): void {
    const scope = dom.activeScope();
    const modal = scope !== document.body && dom.isModalScope(scope) ? ` A dialog is open. ${dom.describeDialog(scope)}` : "";
    void this.say(`You are on ${dom.pageHeading()}.${modal}`);
  }

  private onReadPage(): void {
    const s = dom.pageSummary();
    const names = new Set(s.sections);
    const body = s.lines.filter((l) => !names.has(l)).slice(0, 60).map((l) => l.replace(/[.!?;:,]+$/, "")).join(". ");
    const sections = s.sections.length ? `Sections: ${s.sections.join(", ")}. ` : "";
    const counts = `${plural(s.counts.buttons, "button")}, ${plural(s.counts.links, "link")} and ${plural(s.counts.fields, "field")}. `;
    const full = `${s.heading}. ${sections}${body ? `${body}. ` : ""}${counts}Say what can I click to hear them.`;
    const { head, rest } = takeSpoken(full, 900);
    this.more = rest;
    void this.say(head + (rest ? " Say read more to continue." : ""));
  }

  private onListActions(): void {
    const items = dom.collectItems(dom.activeScope());
    void this.say(dom.describeActions(items).text);
  }

  private onScroll(dir: "up" | "down" | "top" | "bottom"): void {
    const msg = dom.scrollPage(dir);
    if (/^(At the|There is nothing)/.test(msg)) void this.say(msg, { remember: false });
    else this.cue("ok");
  }

  private onClose(): void {
    if (dom.closeTopmost()) this.cue("ok");
    else void this.say("Nothing is open to close.", { remember: false });
  }

  private onNavigate(path: string, label: string): void {
    const here = this.d.host.pathname();
    const [dest] = path.split("?");
    if (here === dest && !path.includes("?")) { void this.say(`You're already on ${label}.`, { remember: false }); return; }
    this.cue("ok");
    this.d.host.navigate(path);
  }

  /** Reads the page title once a route change has rendered (called by the provider on every route change). */
  routeChanged(): void {
    if (!this.active) return;
    if (this.routeTimer) clearTimeout(this.routeTimer);
    this.routeTimer = setTimeout(() => {
      if (!this.active || this.d.speaker.speaking) return;
      void this.say(dom.pageHeading(), { remember: false, interrupt: false });
    }, 800);
  }

  private onSpeed(direction: "slower" | "faster"): void {
    const cur = this.cfg().speed;
    const next = Math.round(Math.max(0.6, Math.min(1.8, cur + (direction === "slower" ? -0.15 : 0.15))) * 100) / 100;
    if (next === cur) { void this.say(direction === "slower" ? "That's already as slow as I go." : "That's already as fast as I go.", { remember: false }); return; }
    this.d.setSpeed(next);
    this.d.speaker.refreshRate();
    void this.say(direction === "slower" ? "Okay, a bit slower." : "Okay, a bit faster.", { remember: false });
  }

  // ------------------------------------------------------------------------------------------ status & inbox

  private async onStatus(): Promise<void> {
    try {
      const d = await this.d.api.dashboard();
      const bits: string[] = [];
      if (d.active_tasks.length) bits.push(`${plural(d.active_tasks.length, "task")} running`);
      if (d.pending_approvals.length) bits.push(`${plural(d.pending_approvals.length, "approval")} waiting for you`);
      if (d.unread_notifications) bits.push(`${plural(d.unread_notifications, "unread notification")}`);
      let text = bits.length ? `You have ${bits.join(", ")}.` : "Nothing needs your attention.";
      const next = d.schedule?.events?.[0];
      if (d.schedule?.connected && next) {
        const when = next.start?.dateTime
          ? new Date(next.start.dateTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "today";
        text += ` Next on your calendar: ${next.summary || "an event"}, ${when === "today" ? "all day" : `at ${when}`}.`;
      }
      if (d.usage?.budget_usd && d.usage.month_spend_usd / d.usage.budget_usd >= 0.8) {
        text += ` You've used ${Math.round((d.usage.month_spend_usd / d.usage.budget_usd) * 100)} percent of your monthly AI budget.`;
      }
      if (d.pending_approvals.length) text += " Say review approvals to go through them.";
      void this.say(text);
    } catch (e) {
      void this.say(`I couldn't check your status: ${short((e as Error).message, 100)}`, { remember: false });
    }
  }

  private async onNotifications(): Promise<void> {
    try {
      const list = (await this.d.api.notifications()).filter((n) => !n.read).slice(0, 5);
      if (!list.length) { void this.say("You're all caught up. No unread notifications."); return; }
      const lines = list.map((n, i) => `${i + 1}. ${speakableSummary(n.title)}${n.body ? `. ${short(speakableSummary(n.body), 140)}` : ""}`);
      void this.say(`You have ${plural(list.length, "unread notification")}. ${lines.join(" ")}`);
      void this.d.api.markNotificationsRead().catch(() => undefined);
    } catch (e) {
      void this.say(`I couldn't read your notifications: ${short((e as Error).message, 100)}`, { remember: false });
    }
  }

  // ------------------------------------------------------------------------------------------ the approvals

  /** Reads pending approvals one by one and takes the spoken decision. */
  async reviewApprovals(o: { auto: boolean }): Promise<void> {
    let list: Approval[];
    try { list = await this.d.api.approvals(); }
    catch (e) { if (!o.auto) void this.say(`I couldn't load your approvals: ${short((e as Error).message, 100)}`, { remember: false }); return; }
    list = [...list].reverse(); // oldest first
    if (o.auto) list = list.filter((a) => !this.declined.has(a.id));
    if (!list.length) { if (!o.auto) void this.say("You have no approvals waiting.", { remember: false }); return; }
    this.flow = { list, i: 0, readDone: false, highAskedAt: null };
    this.narrateApproval(o.auto ? "You have an approval waiting. " : "");
  }

  private narrateApproval(lead = ""): void {
    const f = this.flow;
    if (!f) return;
    const a = f.list[f.i];
    f.readDone = false;
    f.highAskedAt = null;
    const prefix = f.list.length > 1 ? `Approval ${f.i + 1} of ${f.list.length}. ` : "";
    this.setAwaiting({ kind: "approval", prompt: `${a.agent}: ${short(a.summary, 80)}` });
    void this.say(`${lead}${prefix}${speakableApproval(a)} Say approve, reject, or skip.`).then((r) => {
      if (r === "done" && this.flow === f && f.list[f.i]?.id === a.id) f.readDone = true;
    });
  }

  private async decide(approve: boolean, meta: HearMeta, explicit = true): Promise<void> {
    const f = this.flow;
    if (!f) return;
    const a = f.list[f.i];
    if (approve && !meta.typed && !f.readDone) {
      void this.say("I haven't finished reading it to you. Say read it again, or reject.", { remember: false });
      return;
    }
    if (approve && a.risk_level === "high" && !meta.typed) {
      const t = this.now();
      if (!f.highAskedAt || t - f.highAskedAt > HIGH_CONFIRM_WINDOW_MS) {
        f.highAskedAt = t;
        void this.say("This one is high risk. To go ahead, say approve once more. Or say reject.", { remember: false });
        return;
      }
      if (!explicit) {
        void this.say("Please say the word approve to confirm, or say reject.", { remember: false });
        return;
      }
    }
    try {
      await this.d.api.decide(a.id, approve);
    } catch (e) {
      this.cue("error");
      void this.say(`That didn't go through: ${short((e as Error).message, 140)}`, { remember: false });
      return;
    }
    this.cue("ok");
    f.list.splice(f.i, 1);
    const verdict = approve ? "Approved. Running it now." : "Rejected.";
    if (f.list.length) {
      if (f.i >= f.list.length) f.i = 0;
      void this.say(verdict, { remember: false }).then(() => { if (this.flow === f) this.narrateApproval(); });
    } else {
      this.flow = null;
      this.setAwaiting(null);
      void this.say(`${verdict} That was the last one.`, { remember: false });
    }
  }

  /** The approve/reject buttons on screen, clicked by voice, follow exactly the same rules. */
  private async decideFromUi(approvalId: string, approve: boolean, meta: HearMeta): Promise<void> {
    if (!this.flow || this.flow.list[this.flow.i]?.id !== approvalId) {
      try {
        const all = await this.d.api.approvals();
        const idx = all.findIndex((a) => a.id === approvalId);
        if (idx < 0) { void this.say("That approval is no longer pending.", { remember: false }); return; }
        this.flow = { list: all, i: idx, readDone: false, highAskedAt: null };
      } catch { void this.say("I couldn't load that approval.", { remember: false }); return; }
      if (approve && !meta.typed) { this.narrateApproval(); return; } // read it first, then they say approve
    }
    await this.decide(approve, meta);
  }

  private onSkip(): void {
    const f = this.flow;
    if (!f) { this.cue("ok"); return; }
    this.declined.add(f.list[f.i].id);
    f.i += 1;
    if (f.i >= f.list.length) {
      this.flow = null;
      this.setAwaiting(null);
      void this.say("Okay. I'll leave the rest pending.", { remember: false });
      return;
    }
    this.narrateApproval();
  }

  private onDismiss(): void {
    if (this.pendingChoice || this.pendingConfirm) {
      this.pendingChoice = null;
      this.pendingConfirm = null;
      this.cue("ok");
      return;
    }
    if (this.flow) {
      for (const a of this.flow.list) this.declined.add(a.id);
      this.flow = null;
      this.setAwaiting(null);
      void this.say("Okay, I'll leave it pending.", { remember: false });
      return;
    }
    const scope = dom.activeScope();
    if (scope !== document.body) {
      const no = scope.querySelector<HTMLElement>('[data-voice-confirm="no"]');
      if (no) { dom.activate(no); return; }
      this.onClose();
      return;
    }
    this.cue("ok");
  }

  private async onAffirm(explicit: boolean, meta: HearMeta): Promise<void> {
    if (this.pendingConfirm && this.now() - this.pendingConfirm.at < CHOICE_WINDOW_MS) {
      const c = this.pendingConfirm;
      this.pendingConfirm = null;
      c.run();
      return;
    }
    this.pendingConfirm = null;
    const scope = dom.activeScope();
    const yes = scope !== document.body ? scope.querySelector<HTMLElement>('[data-voice-confirm="yes"]') : null;
    if (yes) { dom.activate(yes); return; }
    if (this.flow) { await this.decide(true, meta, explicit); return; }
    if (explicit) void this.say("Nothing is waiting for your approval right now.", { remember: false });
  }

  private async onNegate(meta: HearMeta): Promise<void> {
    if (this.pendingConfirm || this.pendingChoice) { this.pendingConfirm = null; this.pendingChoice = null; this.cue("ok"); return; }
    const scope = dom.activeScope();
    const no = scope !== document.body ? scope.querySelector<HTMLElement>('[data-voice-confirm="no"]') : null;
    if (no) { dom.activate(no); return; }
    if (this.flow) { await this.decide(false, meta); return; }
    this.cue("ok");
  }

  private onChoice(index: number): void {
    const c = this.pendingChoice;
    if (!c || this.now() - c.at > CHOICE_WINDOW_MS) {
      this.pendingChoice = null;
      void this.say("I'm not waiting for a choice.", { remember: false });
      return;
    }
    const item = c.items[index - 1];
    if (!item) { void this.say(`Choose a number from 1 to ${c.items.length}.`, { remember: false }); return; }
    this.pendingChoice = null;
    c.pick(item);
  }

  private offerChoice(items: dom.Item[], what: string, pick: (item: dom.Item) => void): void {
    const shown = items.slice(0, 5);
    this.pendingChoice = { items: shown, pick, at: this.now() };
    this.setAwaiting({ kind: "choice", prompt: `Which ${what}?` });
    const list = shown.map((it, i) => `${i + 1}, ${dom.describeItem(it, true)}`).join(". ");
    void this.say(`I found ${shown.length} matches for ${what}. ${list}. Say a number, or say cancel.`, { remember: false });
  }

  private confirmThen(label: string, run: () => void): void {
    this.pendingConfirm = { label, run, at: this.now() };
    void this.say(`Are you sure you want to ${label}? Say yes or no.`, { remember: false });
  }

  // ------------------------------------------------------------------------------------ operating the page

  private settle(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

  private async doClick(cmd: Extract<Command, { type: "click" }>, raw: string, meta: HearMeta): Promise<void> {
    const items = dom.collectItems(dom.activeScope());
    const m = dom.matchTarget(items, cmd.target, { kind: cmd.kind });
    if (m.type === "none") {
      if (cmd.soft) return this.ask(raw, meta);
      void this.say(`I can't find anything called ${cmd.target}. Say what can I click to hear the options.`, { remember: false });
      return;
    }
    if (m.type === "many") { this.offerChoice(m.items, cmd.target, (item) => void this.runClick(item, meta)); return; }
    await this.runClick(m.item, meta);
  }

  private async runClick(item: dom.Item, meta: HearMeta): Promise<void> {
    if (item.kind === "file") {
      void this.say("I can't open the file picker by voice. Use the keyboard for that one.", { remember: false });
      return;
    }
    const approvalId = dom.approvalIdOf(item.el);
    if (approvalId && /\b(approve|reject)\b/i.test(item.name)) {
      await this.decideFromUi(approvalId, !/reject/i.test(item.name), meta);
      return;
    }
    if (!meta.typed && dom.isDestructive(item.name) && !item.el.hasAttribute("data-voice-confirms")) {
      this.confirmThen(`${item.name.toLowerCase()}${item.context ? `, in ${item.context}` : ""}`, () => void this.performClick(item));
      return;
    }
    await this.performClick(item);
  }

  private async performClick(item: dom.Item): Promise<void> {
    const beforePath = this.d.host.pathname();
    const beforeScope = dom.activeScope();
    const before = dom.buildItem(item.el);
    dom.activate(item.el);
    this.cue("ok");
    await this.settle(350);
    if (this.d.host.pathname() !== beforePath || item.kind === "link") return; // the route announcement speaks
    const scope = dom.activeScope();
    // Confirmation dialogs read their own question aloud; describing them here would cut that off.
    if (scope !== beforeScope && scope.getAttribute("role") === "alertdialog") return;
    if (scope !== beforeScope && scope !== document.body) {
      void this.say(scope.getAttribute("role") === "menu"
        ? `Menu open. ${dom.describeActions(dom.collectItems(scope)).text}` : dom.describeDialog(scope), { remember: false });
      return;
    }
    const after = item.el.isConnected ? dom.buildItem(item.el) : null;
    if (after && after.checked !== undefined && after.checked !== before.checked) void this.say(`${item.name} is now ${after.checked ? "on" : "off"}.`, { remember: false });
    else if (after && after.expanded !== undefined && after.expanded !== before.expanded) void this.say(`${item.name} ${after.expanded ? "expanded" : "collapsed"}.`, { remember: false });
    else if (after && after.selected && !before.selected) void this.say(`${item.name} selected.`, { remember: false });
    else void this.say(`Clicked ${item.name || "it"}.`, { remember: false });
  }

  private async doToggle(cmd: Extract<Command, { type: "toggle" }>, raw: string, meta: HearMeta): Promise<void> {
    const items = dom.collectItems(dom.activeScope()).filter((i) => ["switch", "checkbox", "radio", "button"].includes(i.kind));
    const toggles = items.filter((i) => i.checked !== undefined);
    const m = dom.matchTarget(toggles, cmd.target);
    if (m.type === "none") return this.ask(raw, meta); // "turn off the lights" is a request, not a switch on this page
    if (m.type === "many") { this.offerChoice(m.items, cmd.target, (item) => void this.applyToggle(item, cmd.on)); return; }
    await this.applyToggle(m.item, cmd.on);
  }

  private async applyToggle(item: dom.Item, on: boolean | null): Promise<void> {
    const r = dom.setChecked(item, on);
    this.cue("ok");
    await this.settle(250);
    const now = dom.isChecked(item);
    void this.say(r.changed ? `${item.name} is now ${now ? "on" : "off"}.` : `${item.name} is already ${now ? "on" : "off"}.`, { remember: false });
  }

  private async doFill(cmd: Extract<Command, { type: "fill" }>, raw: string, meta: HearMeta): Promise<void> {
    const fields = dom.collectItems(dom.activeScope()).filter((i) => ["field", "select", "checkbox", "switch", "radio"].includes(i.kind));
    const m = dom.matchTarget(fields, cmd.field);
    if (m.type === "none") return this.ask(raw, meta); // "set a reminder for 5 pm to call mom" is a request
    if (m.type === "many") { this.offerChoice(m.items, cmd.field, (item) => this.fillItem(item, cmd.value)); return; }
    this.fillItem(m.item, cmd.value);
  }

  private fillItem(item: dom.Item, value: string): void {
    if (dom.isSecretField(item)) {
      void this.say("For your security I don't fill password or key fields by voice. Type it, or use your password manager.", { remember: false });
      return;
    }
    if (item.kind === "select") {
      const r = dom.chooseOption(item.el as HTMLSelectElement, value);
      this.cue(r.ok ? "ok" : "error");
      void this.say(r.ok ? `${item.name} set to ${r.label}.` : `I couldn't find ${value} in ${item.name}. Options are ${r.options.slice(0, 6).join(", ")}.`, { remember: false });
      return;
    }
    if (item.kind === "field") {
      const v = dom.normalizeSpokenValue(value, item.inputType);
      dom.setValue(item.el as HTMLInputElement | HTMLTextAreaElement, v);
      this.cue("ok");
      void this.say(`${item.name} set to ${v}.`, { remember: false });
      return;
    }
    const yes = /^(yes|on|true|enable[d]?|check(ed)?)$/i.test(value.trim());
    const no = /^(no|off|false|disable[d]?|uncheck(ed)?)$/i.test(value.trim());
    if (!yes && !no) { void this.say(`Say on or off for ${item.name}.`, { remember: false }); return; }
    void this.applyToggle(item, yes);
  }

  private async doDictate(text: string, raw: string, meta: HearMeta): Promise<void> {
    const active = document.activeElement as HTMLElement | null;
    let target: HTMLInputElement | HTMLTextAreaElement | null = null;
    if (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && dom.buildItem(active).kind === "field")) target = active;
    if (!target) {
      const fields = dom.collectItems(dom.activeScope()).filter((i) => i.kind === "field" && !dom.isSecretField(i));
      const areas = fields.filter((i) => i.el instanceof HTMLTextAreaElement);
      const pick = areas.length === 1 ? areas[0] : fields.length === 1 ? fields[0] : null;
      if (!pick) {
        if (!fields.length) return this.ask(raw, meta);
        void this.say("Which field? Say focus on, and the field's name.", { remember: false });
        return;
      }
      target = pick.el as HTMLInputElement | HTMLTextAreaElement;
    }
    if (target instanceof HTMLInputElement && target.type === "password") { void this.say("I don't type into password fields.", { remember: false }); return; }
    dom.setValue(target, text, true);
    this.cue("ok");
  }

  private doFocus(targetName: string): void {
    const fields = dom.collectItems(dom.activeScope()).filter((i) => ["field", "select"].includes(i.kind));
    const m = dom.matchTarget(fields, targetName);
    if (m.type === "none") { void this.say(`I can't find a field called ${targetName}.`, { remember: false }); return; }
    if (m.type === "many") { this.offerChoice(m.items, targetName, (item) => this.focusItem(item)); return; }
    this.focusItem(m.item);
  }

  private focusItem(item: dom.Item): void {
    item.el.scrollIntoView?.({ block: "center" });
    item.el.focus({ preventScroll: true });
    const value = dom.isSecretField(item) ? "" : dom.fieldValue(item.el);
    void this.say(`${item.name}, ${dom.KIND_LABEL[item.kind]}. ${value ? `It contains ${short(value, 120)}.` : "It is empty."} Say type, then what to enter.`, { remember: false });
  }

  private doSubmit(): void {
    const r = dom.submitNearest();
    if (r.ok) this.cue("ok");
    else void this.say("I can't see an obvious submit button. Say click, then the button's name.", { remember: false });
  }

  // ------------------------------------------------------------------------------------------- asking LEXA

  private async ask(text: string, meta: HearMeta): Promise<void> {
    this.cue("heard");
    try {
      const r = await this.d.host.ask(text, { voice: !meta.typed });
      if (!r) { void this.say("I couldn't send that just now. Please say it again.", { remember: false }); return; }
      if (r.conversationId) this.lastConversation = r.conversationId;
      if (r.taskId) this.watch(r.taskId);
    } catch (e) {
      this.cue("error");
      void this.say(`I couldn't send that: ${short((e as Error).message, 140)}`, { remember: false });
    }
  }

  private watch(taskId: string): void {
    if (this.tasks.has(taskId)) return;
    const timers = [
      setTimeout(() => {
        if (this.active && this.tasks.has(taskId) && !this.flow && !this.d.speaker.speaking) void this.say("Still working on it.", { remember: false });
      }, 12_000),
      setTimeout(() => {
        if (this.active && this.tasks.has(taskId) && !this.flow && !this.d.speaker.speaking) void this.say("This is taking a while. I'll tell you as soon as it's done.", { remember: false });
      }, 60_000),
    ];
    this.tasks.set(taskId, { startedAt: this.now(), timers, heard: false });
    this.recompute();
  }

  private clearTasks(): void {
    this.tasks.forEach((t) => t.timers.forEach(clearTimeout));
    this.tasks.clear();
  }

  private async onCancelTask(): Promise<void> {
    try {
      const id = [...this.tasks.keys()].pop() ?? (await this.d.api.dashboard()).active_tasks[0]?.id;
      if (!id) { void this.say("Nothing is running right now.", { remember: false }); return; }
      await this.d.api.cancelTask(id);
      void this.say("Okay, I'm stopping that.", { remember: false });
    } catch (e) {
      void this.say(`I couldn't cancel it: ${short((e as Error).message, 100)}`, { remember: false });
    }
  }

  // ------------------------------------------------------------------------------------- server events

  /** Feed LEXA's realtime events (task finished, approval needed, notification…). */
  handleEvent(e: { event: string; data: EventData }): void {
    const voiceOn = this.active && !this.sleeping;
    switch (e.event) {
      case "task.created":
        // A request typed in the chat is read aloud too when "Speak responses" is on.
        if (this.cfg().speakResponses && e.data.task_id) this.watch(e.data.task_id);
        break;
      case "task.completed":
      case "task.status": {
        const id = e.data.task_id;
        const status = e.data.status;
        if (id && this.tasks.has(id) && (e.event === "task.completed" || ["COMPLETED", "FAILED", "CANCELLED", "WAITING_FOR_APPROVAL"].includes(status ?? ""))) void this.finishTask(id);
        break;
      }
      case "notification": {
        const { kind, title, severity } = e.data;
        if (!voiceOn) break;
        if (kind === "approval" && /^approval needed/i.test(title ?? "")) this.scheduleAutoReview();
        else if (kind === "approval" || kind === "reminder" || severity === "error" || severity === "warning") {
          void this.say(speakableSummary(title ?? ""), { remember: false, interrupt: false });
        }
        break;
      }
      default: break;
    }
  }

  private scheduleAutoReview(): void {
    if (this.autoReviewTimer) clearTimeout(this.autoReviewTimer);
    this.autoReviewTimer = setTimeout(() => {
      if (!this.active || this.sleeping || this.flow || this.hearing || this.pendingStt) return;
      void this.reviewApprovals({ auto: true });
    }, 1500);
  }

  private async finishTask(taskId: string): Promise<void> {
    const w = this.tasks.get(taskId);
    if (!w || w.heard) return;
    w.heard = true;
    w.timers.forEach(clearTimeout);
    let t: TaskLite;
    try { t = await this.d.api.task(taskId); } catch { this.tasks.delete(taskId); this.recompute(); return; }
    this.tasks.delete(taskId);
    this.recompute();
    if (t.status === "WAITING_FOR_APPROVAL") { this.scheduleAutoReview(); return; }
    if (t.status === "FAILED") { this.cue("error"); void this.say(`That didn't work. ${short(t.error, 160) || "Something went wrong."}`); return; }
    if (t.status === "CANCELLED") { void this.say("Cancelled.", { remember: false }); return; }
    if (t.status !== "COMPLETED") return;
    this.cue("done");
    const reply = toSpeakable(t.output ?? t.output_preview ?? "");
    if (!reply) { void this.say("Done."); return; }
    const { head, rest } = takeSpoken(reply, 900);
    this.more = rest;
    void this.say(head + (rest ? " Say read more for the rest." : ""));
  }
}

