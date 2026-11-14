/**
 * Microphone capture → voice-activity detection → utterances (16 kHz mono WAV).
 *
 * Audio only leaves the device as a finished utterance, and only while voice mode is on. Echo cancellation,
 * noise suppression and auto gain are requested from the browser; while LEXA itself is speaking the detector's
 * threshold is raised and segments are flagged so they can be treated as possible interruptions only.
 */
import { DEFAULT_VAD, Vad, type VadConfig } from "./vad";
import { chunksToWav, rms } from "./wav";

export type MicErrorCode = "denied" | "no-device" | "busy" | "unsupported" | "lost" | "failed";

export class MicError extends Error {
  constructor(public code: MicErrorCode, message: string) {
    super(message);
  }
}

export interface Utterance {
  wav: Uint8Array;
  durationMs: number;
  speechMs: number;
  /** LEXA was speaking at some point while this was being said. */
  duringSpeech: boolean;
}

export interface MicHandlers {
  onUtterance: (u: Utterance) => void;
  /** Live partial text (only the browser recognizer provides it). */
  onInterim?: (text: string) => void;
  onLevel?: (level: number) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onError?: (e: MicError) => void;
  isSpeaking?: () => boolean;
}

export interface MicLike {
  start(): Promise<void>;
  stop(): void;
  readonly running: boolean;
  setEndSilence(ms: number): void;
  /** Ignore the microphone briefly (used while an audio cue plays so it is not mistaken for speech). */
  ignoreFor(ms: number): void;
}

const PRE_ROLL_MS = 320;
const SPEAKING_BOOST = 2.4;

function mapError(e: unknown): MicError {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError")
    return new MicError("denied", "Microphone access is blocked for this site.");
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError")
    return new MicError("no-device", "No microphone was found.");
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError")
    return new MicError("busy", "The microphone is in use by another app.");
  return new MicError("failed", (e as Error)?.message || "The microphone could not be started.");
}

export class Mic implements MicLike {
  running = false;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private vad: Vad;
  private cur: Float32Array[] | null = null;
  private pre: Float32Array[] = [];
  private preSamples = 0;
  private duringSpeech = false;
  private ignoreUntil = 0;
  private lastLevelAt = 0;

  constructor(private h: MicHandlers, vad: Partial<VadConfig> = {}) {
    this.vad = new Vad({ ...DEFAULT_VAD, ...vad });
  }

  setEndSilence(ms: number): void {
    this.vad.cfg = { ...this.vad.cfg, endSilenceMs: ms };
  }

  ignoreFor(ms: number): void {
    this.ignoreUntil = performance.now() + ms;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const AC: typeof AudioContext | undefined = typeof AudioContext !== "undefined" ? AudioContext
      : (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC || !navigator.mediaDevices?.getUserMedia) {
      throw new MicError("unsupported", "This browser cannot record audio on this page. Voice needs HTTPS and a current browser.");
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (e) {
      throw mapError(e);
    }
    try {
      const ctx = new AC({ latencyHint: "interactive" });
      if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
      const source = ctx.createMediaStreamSource(stream);
      const sink = ctx.createGain();
      sink.gain.value = 0; // keeps the graph alive without playing the microphone back
      sink.connect(ctx.destination);
      let capture: AudioNode;
      try {
        await ctx.audioWorklet.addModule("/lexa-capture.worklet.js");
        const w = new AudioWorkletNode(ctx, "lexa-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        w.port.onmessage = (ev: MessageEvent<Float32Array>) => this.onFrame(ev.data);
        capture = w;
      } catch {
        // Older browsers, or the worklet file was blocked: the (deprecated but universal) script processor.
        const sp = ctx.createScriptProcessor(2048, 1, 1);
        sp.onaudioprocess = (ev) => this.onFrame(new Float32Array(ev.inputBuffer.getChannelData(0)));
        capture = sp;
      }
      source.connect(capture);
      capture.connect(sink);
      this.nodes = [source, capture, sink];
      this.ctx = ctx;
      this.stream = stream;
      stream.getAudioTracks()[0]?.addEventListener("ended", () => {
        if (!this.running) return;
        this.h.onError?.(new MicError("lost", "The microphone disconnected."));
        this.stop();
      });
      this.vad = new Vad(this.vad.cfg);
      this.cur = null;
      this.pre = [];
      this.preSamples = 0;
      this.running = true;
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      throw mapError(e);
    }
  }

  stop(): void {
    const wasRunning = this.running;
    this.running = false;
    this.nodes.forEach((n) => { try { n.disconnect(); } catch { /* already disconnected */ } });
    this.nodes = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.cur = null;
    this.pre = [];
    this.h.onLevel?.(0);
    if (wasRunning) this.h.onSpeechEnd?.();
  }

  private onFrame(frame: Float32Array): void {
    if (!this.running || !this.ctx) return;
    const rate = this.ctx.sampleRate;
    const now = performance.now();
    if (now < this.ignoreUntil) {
      this.vad.reset();
      this.cur = null;
      this.pre = [];
      this.preSamples = 0;
      return;
    }
    const speaking = this.h.isSpeaking?.() ?? false;
    this.vad.boost = speaking ? SPEAKING_BOOST : 1;
    const level = rms(frame);
    if (now - this.lastLevelAt > 66) {
      this.lastLevelAt = now;
      this.h.onLevel?.(Math.min(1, level * 9));
    }
    const copy = frame.slice();
    if (this.cur) {
      this.cur.push(copy);
      this.duringSpeech ||= speaking;
    }
    let started = false;
    for (const ev of this.vad.push(level, (frame.length / rate) * 1000)) {
      if (ev.type === "start") {
        this.cur = [...this.pre, copy];
        this.pre = [];
        this.preSamples = 0;
        this.duringSpeech = speaking;
        started = true;
        this.h.onSpeechStart?.();
      } else if (ev.type === "end") {
        if (this.cur) {
          const { bytes, durationMs } = chunksToWav(this.cur, rate);
          this.cur = null;
          this.h.onSpeechEnd?.();
          this.h.onUtterance({ wav: bytes, durationMs, speechMs: ev.speechMs, duringSpeech: this.duringSpeech });
        }
      } else {
        this.cur = null;
        this.h.onSpeechEnd?.();
      }
    }
    if (!this.cur && !started) {
      this.pre.push(copy);
      this.preSamples += copy.length;
      const maxSamples = (rate * PRE_ROLL_MS) / 1000;
      while (this.pre.length > 1 && this.preSamples - this.pre[0].length >= maxSamples) {
        this.preSamples -= this.pre.shift()!.length;
      }
    }
  }
}
