/**
 * Text-to-speech playback. Prefers the server voice (OpenAI) with the next chunk prefetched while the current one
 * plays, and falls back to the browser's own voice if the server voice is unavailable or the user chose it.
 */
import { encodeWav } from "./wav";
import { splitForTts } from "./speech-text";

export type SpeakEnd = "done" | "stopped";

export interface SpeakerLike {
  /** Speaks `text`. Resolves when it has finished, or was stopped. By default a new call interrupts the previous. */
  speak(text: string, opts?: { interrupt?: boolean }): Promise<SpeakEnd>;
  stop(): void;
  /** Call from a user gesture so browsers allow audio later. */
  unlock(): void;
  /** Re-applies the speaking speed to what is playing now. */
  refreshRate(): void;
  readonly speaking: boolean;
  /** What LEXA said in the last few seconds (to recognise its own voice in the microphone). */
  recent(): string;
}

export interface SpeakerOptions {
  synth: (text: string, voice: string, signal: AbortSignal) => Promise<Blob>;
  engine: () => "server" | "browser";
  voice: () => string;
  rate: () => number;
  language: () => string;
  onStart?: () => void;
  onEnd?: (reason: SpeakEnd) => void;
  onFallback?: (why: string) => void;
  onBlocked?: () => void;
}

interface Current {
  gen: number;
  text: string;
  abort: AbortController;
  resolve: (r: SpeakEnd) => void;
  done: Promise<SpeakEnd>;
}

const ECHO_WINDOW_MS = 8000;
const SERVER_BACKOFF_MS = 60_000;

export class Speaker implements SpeakerLike {
  private gen = 0;
  private audio: HTMLAudioElement | null = null;
  private current: Current | null = null;
  private stopHook: (() => void) | null = null;
  private log: { text: string; at: number }[] = [];
  private serverDownUntil = 0;
  private started = false;
  private unlocked = false;

  constructor(private o: SpeakerOptions) {}

  get speaking(): boolean {
    return this.current !== null;
  }

  recent(): string {
    const cutoff = Date.now() - ECHO_WINDOW_MS;
    const parts = this.log.filter((l) => l.at >= cutoff).map((l) => l.text);
    if (this.current) parts.push(this.current.text);
    return parts.join(" ");
  }

  refreshRate(): void {
    if (this.audio) this.audio.playbackRate = this.o.rate();
  }

  unlock(): void {
    if (typeof window === "undefined" || this.unlocked || this.current) return; // never cut speech off
    try {
      const a = this.ensureAudio();
      const silent = URL.createObjectURL(new Blob([encodeWav(new Float32Array(400), 8000) as BlobPart], { type: "audio/wav" }));
      a.src = silent;
      void a.play().then(() => { this.unlocked = true; }).catch(() => undefined).finally(() => setTimeout(() => URL.revokeObjectURL(silent), 1000));
      if ("speechSynthesis" in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
    } catch {
      /* best effort */
    }
  }

  async speak(text: string, opts: { interrupt?: boolean } = {}): Promise<SpeakEnd> {
    const clean = text.trim();
    if (!clean) return "done";
    if (opts.interrupt === false && this.current) await this.current.done;
    else this.stop();
    const gen = ++this.gen;
    const abort = new AbortController();
    let resolve!: (r: SpeakEnd) => void;
    const done = new Promise<SpeakEnd>((r) => { resolve = r; });
    this.current = { gen, text: clean, abort, resolve, done };
    this.started = false;
    void this.run(gen, clean, abort.signal).then((r) => this.finish(gen, r));
    return done;
  }

  stop(): void {
    const cur = this.current;
    if (!cur) return;
    this.gen++;
    this.current = null;
    cur.abort.abort();
    const hook = this.stopHook;
    this.stopHook = null;
    hook?.();
    cur.resolve("stopped");
    this.o.onEnd?.("stopped");
  }

  dispose(): void {
    this.stop();
    this.audio = null;
  }

  // ------------------------------------------------------------------------------------------------- internals

  private finish(gen: number, reason: SpeakEnd): void {
    const cur = this.current;
    if (!cur || cur.gen !== gen) return;
    this.current = null;
    this.stopHook = null;
    this.log.push({ text: cur.text, at: Date.now() });
    this.log = this.log.slice(-6);
    cur.resolve(reason);
    this.o.onEnd?.(reason);
  }

  private ensureAudio(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = "auto";
    }
    return this.audio;
  }

  private serverUsable(): boolean {
    return this.o.engine() === "server" && Date.now() >= this.serverDownUntil;
  }

  private markStarted(): void {
    if (this.started) return;
    this.started = true;
    this.o.onStart?.();
  }

  private async run(gen: number, text: string, signal: AbortSignal): Promise<SpeakEnd> {
    const server = this.serverUsable();
    const chunks = splitForTts(text, server ? 240 : 180, server ? 700 : 220);
    const voice = this.o.voice();
    const fetched = new Map<number, Promise<Blob | null>>();
    const fetchChunk = (i: number): Promise<Blob | null> => {
      let p = fetched.get(i);
      if (!p) {
        p = this.o.synth(chunks[i], voice, signal).catch((e: unknown) => {
          if (signal.aborted) return null;
          this.serverDownUntil = Date.now() + SERVER_BACKOFF_MS;
          this.o.onFallback?.((e as Error)?.message || "server voice unavailable");
          return null;
        });
        fetched.set(i, p);
      }
      return p;
    };
    if (server) {
      void fetchChunk(0);
      if (chunks.length > 1) void fetchChunk(1);
    }
    for (let i = 0; i < chunks.length; i++) {
      if (gen !== this.gen) return "stopped";
      let played = false;
      if (this.serverUsable()) {
        const blob = await fetchChunk(i);
        if (gen !== this.gen) return "stopped";
        if (blob) {
          if (i + 2 < chunks.length) void fetchChunk(i + 2);
          const r = await this.playBlob(blob, gen);
          if (r === "stopped" || gen !== this.gen) return "stopped";
          played = true;
        }
      }
      if (!played) {
        const r = await this.speakBrowser(chunks[i], gen);
        if (r === "stopped" || gen !== this.gen) return "stopped";
      }
    }
    return "done";
  }

  private playBlob(blob: Blob, gen: number): Promise<SpeakEnd> {
    const audio = this.ensureAudio();
    const url = URL.createObjectURL(blob);
    return new Promise<SpeakEnd>((resolve) => {
      let settled = false;
      const settle = (r: SpeakEnd) => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        URL.revokeObjectURL(url);
        resolve(r);
      };
      this.stopHook = () => { audio.pause(); settle("stopped"); };
      audio.onended = () => settle("done");
      audio.onerror = () => settle(gen === this.gen ? "done" : "stopped");
      audio.src = url;
      audio.playbackRate = this.o.rate();
      audio.preservesPitch = true;
      audio.play().then(() => this.markStarted()).catch((e: unknown) => {
        if ((e as { name?: string })?.name === "NotAllowedError") { this.unlocked = false; this.o.onBlocked?.(); }
        settle(gen === this.gen ? "done" : "stopped");
      });
    });
  }

  private speakBrowser(text: string, gen: number): Promise<SpeakEnd> {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (!synth) {
      this.o.onFallback?.("this browser has no speech output");
      return Promise.resolve("done");
    }
    return new Promise<SpeakEnd>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = Math.max(0.5, Math.min(2, this.o.rate()));
      const lang = this.o.language() || document.documentElement.lang || navigator.language;
      if (lang) u.lang = lang;
      let settled = false;
      const settle = (r: SpeakEnd) => { if (!settled) { settled = true; resolve(r); } };
      this.stopHook = () => { synth.cancel(); settle("stopped"); };
      u.onstart = () => this.markStarted();
      u.onend = () => settle("done");
      u.onerror = (e) => settle(e.error === "interrupted" || e.error === "canceled" || gen !== this.gen ? "stopped" : "done");
      synth.speak(u);
    });
  }
}
