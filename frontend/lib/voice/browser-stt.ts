/**
 * Speech recognition by the browser itself (Web Speech API): free, instant, with live partial results.
 * Available in Chrome, Edge and Safari; **not in Firefox**. The audio goes to the browser vendor's speech service
 * (Google in Chrome, Microsoft in Edge, Apple in Safari), not to LEXA or OpenAI.
 *
 * It plays the same role as the OpenAI path (lib/voice/mic.ts) but needs no upload and no API credit: it delivers
 * finished sentences as text straight to the voice controller.
 */
import { MicError, type MicHandlers, type MicLike } from "./mic";

interface RecognitionResult { isFinal: boolean; length: number; [index: number]: { transcript: string; confidence?: number } }
interface RecognitionEvent { resultIndex: number; results: ArrayLike<RecognitionResult> }
interface RecognitionErrorEvent { error: string; message?: string }

export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
  onresult: ((e: RecognitionEvent) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type RecognitionCtor = new () => RecognitionLike;

export function recognitionConstructor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const browserRecognitionSupported = (): boolean => recognitionConstructor() !== null;

export function isFirefox(): boolean {
  return typeof navigator !== "undefined" && /firefox/i.test(navigator.userAgent);
}

export interface RecognizerHandlers extends MicHandlers {
  onTranscript: (text: string, meta: { duringSpeech: boolean }) => void;
  language?: () => string;
}

const MAX_NETWORK_FAILURES = 3;

export class BrowserRecognizer implements MicLike {
  running = false;
  private rec: RecognitionLike | null = null;
  private restart: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private ignoreUntil = 0;
  private hearing = false;
  private duringSpeech = false;
  private generation = 0;

  constructor(private h: RecognizerHandlers, private ctor: RecognitionCtor | null = recognitionConstructor()) {}

  setEndSilence(): void { /* the browser decides when a sentence ends */ }

  ignoreFor(ms: number): void { this.ignoreUntil = Date.now() + ms; }

  /** Resolves once the browser is listening; rejects if the microphone or the speech service is not available. */
  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    if (!this.ctor) return Promise.reject(new MicError("unsupported", "This browser has no built-in speech recognition."));
    this.running = true;
    this.failures = 0;
    return this.begin();
  }

  stop(): void {
    const was = this.running;
    this.running = false;
    this.generation++;
    if (this.restart) clearTimeout(this.restart);
    this.restart = null;
    const rec = this.rec;
    this.rec = null;
    if (rec) {
      rec.onstart = rec.onend = rec.onerror = rec.onresult = null;
      try { rec.abort(); } catch { /* already stopped */ }
    }
    this.hearing = false;
    if (was) this.h.onSpeechEnd?.();
  }

  private begin(): Promise<void> {
    const gen = ++this.generation;
    return new Promise<void>((resolve, reject) => {
      const rec = new this.ctor!();
      let settled = false;
      const done = (err?: MicError) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve();
      };
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.lang = this.h.language?.() || (typeof navigator !== "undefined" ? navigator.language : "") || "en-US";
      rec.onstart = () => done();
      rec.onresult = (e) => { if (gen === this.generation) this.onResult(e); };
      rec.onerror = (e) => {
        if (gen !== this.generation) return;
        const fatal = this.classify(e);
        if (!fatal) return;
        const startedBefore = settled; // a failure while listening is reported; a failure to start rejects start()
        done(fatal);
        this.stop();
        if (startedBefore) this.h.onError?.(fatal);
      };
      rec.onend = () => {
        if (gen !== this.generation) return;
        done(); // ended before reporting a start (e.g. a quick no-speech): not an error for the caller
        if (this.hearing) { this.hearing = false; this.h.onSpeechEnd?.(); }
        if (!this.running) return;
        // Browsers end a session after silence or ~1 minute: listen again, backing off if it keeps failing.
        const delay = Math.min(5000, 250 * 2 ** this.failures);
        this.restart = setTimeout(() => { if (this.running) void this.begin().catch(() => undefined); }, delay);
      };
      this.rec = rec;
      try {
        rec.start();
      } catch (e) {
        done(new MicError("failed", (e as Error).message || "The browser could not start speech recognition."));
      }
    });
  }

  /** Maps the browser's error names; returns a MicError when listening cannot continue. */
  private classify(e: RecognitionErrorEvent): MicError | null {
    switch (e.error) {
      case "no-speech":
      case "aborted":
        return null;
      case "not-allowed":
      case "service-not-allowed":
        return new MicError("denied", "Microphone access is blocked for this site.");
      case "audio-capture":
        return new MicError("no-device", "No microphone was found.");
      case "language-not-supported":
        return new MicError("failed", "The browser's speech recognition does not support the chosen language.");
      case "network":
        if (++this.failures >= MAX_NETWORK_FAILURES) {
          return new MicError("failed", "The browser's speech service could not be reached. It needs an internet connection.");
        }
        return null;
      default:
        if (++this.failures >= MAX_NETWORK_FAILURES) return new MicError("failed", `Speech recognition failed (${e.error}).`);
        return null;
    }
  }

  private onResult(e: RecognitionEvent): void {
    this.failures = 0;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      const text = (result[0]?.transcript ?? "").trim();
      if (!text) continue;
      // Did LEXA's own voice overlap this sentence? Judged while it is being said, not when it is finished.
      this.duringSpeech ||= this.h.isSpeaking?.() ?? false;
      if (!this.hearing) { this.hearing = true; this.h.onSpeechStart?.(); }
      if (!result.isFinal) { this.h.onInterim?.(text); continue; }
      const during = this.duringSpeech;
      this.duringSpeech = false;
      this.hearing = false;
      this.h.onInterim?.("");
      this.h.onSpeechEnd?.();
      if (Date.now() < this.ignoreUntil) continue; // one of LEXA's own sound cues
      this.h.onTranscript(text, { duringSpeech: during });
    }
  }
}
