import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserRecognizer, type RecognitionLike } from "@/lib/voice/browser-stt";
import { MicError } from "@/lib/voice/mic";

/** The browser's SpeechRecognition, driven by the test. */
class FakeRec implements RecognitionLike {
  static all: FakeRec[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onresult: RecognitionLike["onresult"] = null;
  aborted = false;
  constructor() { FakeRec.all.push(this); }
  start(): void { queueMicrotask(() => this.onstart?.()); }
  stop(): void {}
  abort(): void { this.aborted = true; }
  say(text: string, isFinal: boolean): void {
    const result = Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal });
    this.onresult?.({ resultIndex: 0, results: [result] as never });
  }
  get last(): FakeRec { return FakeRec.all[FakeRec.all.length - 1]; }
}

function make(extra: Partial<ConstructorParameters<typeof BrowserRecognizer>[0]> = {}) {
  const got: { text: string; duringSpeech: boolean }[] = [];
  const events: string[] = [];
  const speaking = { on: false };
  const rec = new BrowserRecognizer({
    onUtterance: () => undefined,
    onTranscript: (text, meta) => got.push({ text, ...meta }),
    onSpeechStart: () => events.push("start"),
    onSpeechEnd: () => events.push("end"),
    onInterim: (t) => events.push(`interim:${t}`),
    onError: (e) => events.push(`error:${e.code}`),
    isSpeaking: () => speaking.on,
    language: () => "en-IN",
    ...extra,
  }, FakeRec as never);
  return { rec, got, events, speaking };
}

beforeEach(() => { vi.useFakeTimers(); FakeRec.all = []; });
afterEach(() => { vi.useRealTimers(); });

describe("the browser's own speech recogniser", () => {
  it("starts listening continuously with live partial results in the chosen language", async () => {
    const { rec } = make();
    await rec.start();
    const r = FakeRec.all[0];
    expect(r).toMatchObject({ continuous: true, interimResults: true, maxAlternatives: 1, lang: "en-IN" });
    expect(rec.running).toBe(true);
  });

  it("shows partial text, then delivers the finished sentence once", async () => {
    const { rec, got, events } = make();
    await rec.start();
    const r = FakeRec.all[0];
    r.say("open the", false);
    r.say("open the settings", false);
    r.say("Open the settings.", true);
    expect(got).toEqual([{ text: "Open the settings.", duringSpeech: false }]);
    expect(events).toEqual(["start", "interim:open the", "interim:open the settings", "interim:", "end"]);
  });

  it("flags a sentence as spoken over LEXA if its voice overlapped it, for that sentence only", async () => {
    const { rec, got, speaking } = make();
    await rec.start();
    const r = FakeRec.all[0];
    speaking.on = true;
    r.say("stop", false);
    speaking.on = false;
    r.say("stop", true);
    r.say("what's pending", true);
    expect(got.map((g) => g.duringSpeech)).toEqual([true, false]);
  });

  it("listens again after the browser ends the session (silence, or about a minute), backing off", async () => {
    const { rec } = make();
    await rec.start();
    FakeRec.all[0].onend?.();
    expect(FakeRec.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(FakeRec.all).toHaveLength(2);
    expect(rec.running).toBe(true);
  });

  it("ignores 'no speech' and tolerates a couple of network hiccups", async () => {
    const { rec, events } = make();
    await rec.start();
    FakeRec.all[0].onerror?.({ error: "no-speech" });
    FakeRec.all[0].onerror?.({ error: "network" });
    FakeRec.all[0].onerror?.({ error: "network" });
    expect(rec.running).toBe(true);
    expect(events.filter((e) => e.startsWith("error"))).toEqual([]);
  });

  it("gives up, and says why, when the speech service stays unreachable", async () => {
    const { rec, events } = make();
    await rec.start();
    for (let i = 0; i < 3; i++) FakeRec.all[0].onerror?.({ error: "network" });
    expect(rec.running).toBe(false);
    expect(events).toContain("error:failed");
    expect(FakeRec.all[0].aborted).toBe(true);
  });

  it("rejects start() with a clear reason if the microphone is blocked", async () => {
    const rec = new BrowserRecognizer({ onUtterance: () => undefined, onTranscript: () => undefined }, class extends FakeRec {
      start(): void { queueMicrotask(() => this.onerror?.({ error: "not-allowed" })); }
    } as never);
    await expect(rec.start()).rejects.toMatchObject({ code: "denied" });
    expect(rec.running).toBe(false);
  });

  it("rejects when the browser has no recogniser (Firefox)", async () => {
    const rec = new BrowserRecognizer({ onUtterance: () => undefined, onTranscript: () => undefined }, null);
    await expect(rec.start()).rejects.toBeInstanceOf(MicError);
    await expect(rec.start()).rejects.toMatchObject({ code: "unsupported" });
  });

  it("drops a sentence that is just one of LEXA's own sound cues", async () => {
    const { rec, got } = make();
    await rec.start();
    rec.ignoreFor(500);
    FakeRec.all[0].say("beep", true);
    expect(got).toEqual([]);
    await vi.advanceTimersByTimeAsync(600);
    FakeRec.all[0].say("hello", true);
    expect(got).toHaveLength(1);
  });

  it("stops cleanly: aborts, never restarts, ignores late results", async () => {
    const { rec, got } = make();
    await rec.start();
    const r = FakeRec.all[0];
    rec.stop();
    expect(r.aborted).toBe(true);
    r.say("late", true);
    r.onend?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(got).toEqual([]);
    expect(FakeRec.all).toHaveLength(1);
    expect(rec.running).toBe(false);
  });
});
