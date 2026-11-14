import { describe, expect, it } from "vitest";
import { chunksToWav, concatFloat32, encodeWav, resample, rms } from "@/lib/voice/wav";
import { DEFAULT_VAD, Vad, type VadEvent } from "@/lib/voice/vad";

function sine(seconds: number, rate: number, freq = 440, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.floor(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

describe("wav", () => {
  it("writes a valid PCM16 mono header and the right amount of data", () => {
    const bytes = encodeWav(sine(0.5, 16000), 16000);
    const v = new DataView(bytes.buffer);
    const tag = (o: number) => String.fromCharCode(...bytes.slice(o, o + 4));
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(40, true)).toBe(8000 * 2);
    expect(bytes.length).toBe(44 + 16000);
    expect(v.getUint32(4, true)).toBe(bytes.length - 8);
  });

  it("clamps out-of-range samples instead of wrapping", () => {
    const v = new DataView(encodeWav(new Float32Array([2, -2]), 16000).buffer);
    expect(v.getInt16(44, true)).toBe(0x7fff);
    expect(v.getInt16(46, true)).toBe(-0x8000);
  });

  it("resamples 48 kHz and 44.1 kHz to 16 kHz with the right length", () => {
    expect(resample(sine(1, 48000), 48000, 16000).length).toBe(16000);
    expect(Math.abs(resample(sine(1, 44100), 44100, 16000).length - 16000)).toBeLessThanOrEqual(1);
    const same = sine(0.1, 16000);
    expect(resample(same, 16000, 16000)).toBe(same);
  });

  it("keeps a speech-band tone's energy when downsampling", () => {
    const out = resample(sine(0.5, 48000, 300, 0.5), 48000, 16000);
    expect(rms(out)).toBeGreaterThan(0.3);
  });

  it("reports the duration of the encoded clip", () => {
    const { durationMs, bytes } = chunksToWav([sine(0.4, 48000), sine(0.6, 48000)], 48000);
    expect(durationMs).toBe(1000);
    expect(bytes.length).toBe(44 + 16000 * 2);
    expect(concatFloat32([new Float32Array(3), new Float32Array(2)]).length).toBe(5);
  });
});

/** Feed `ms` milliseconds of constant energy in 20 ms frames and collect events. */
function feed(vad: Vad, level: number, ms: number): VadEvent[] {
  const events: VadEvent[] = [];
  for (let t = 0; t < ms; t += 20) events.push(...vad.push(level, 20));
  return events;
}
const types = (e: VadEvent[]) => e.map((x) => x.type);

describe("vad", () => {
  const calibrated = () => {
    const v = new Vad();
    feed(v, 0.002, 700);
    return v;
  };

  it("detects an utterance: start, then end after the configured silence", () => {
    const v = calibrated();
    expect(feed(v, 0.002, 300)).toEqual([]);
    expect(types(feed(v, 0.1, 1200))).toEqual(["start"]);
    const end = feed(v, 0.002, 1100);
    expect(types(end)).toEqual(["end"]);
    const e = end[0] as Extract<VadEvent, { type: "end" }>;
    expect(e.reason).toBe("silence");
    expect(e.speechMs).toBeGreaterThanOrEqual(1100);
  });

  it("ignores very short noises such as key clicks", () => {
    const v = calibrated();
    expect(types(feed(v, 0.2, 60))).toEqual([]);
    expect(types(feed(v, 0.002, 2000))).toEqual([]);
  });

  it("discards an utterance that had too little speech", () => {
    const v = calibrated();
    expect(types(feed(v, 0.1, 160))).toEqual(["start"]);
    expect(types(feed(v, 0.002, 1100))).toEqual(["discard"]);
  });

  it("keeps one utterance together across a short pause", () => {
    const v = calibrated();
    const all = [...feed(v, 0.1, 600), ...feed(v, 0.002, 500), ...feed(v, 0.1, 600), ...feed(v, 0.002, 1100)];
    expect(types(all)).toEqual(["start", "end"]);
  });

  it("force-closes a never-ending utterance at the maximum length", () => {
    const v = calibrated();
    const all = feed(v, 0.1, DEFAULT_VAD.maxUtteranceMs + 500);
    // The utterance is cut at the limit; speech that is still going on opens a fresh one right away.
    expect(types(all)).toEqual(["start", "end", "start"]);
    expect((all[1] as Extract<VadEvent, { type: "end" }>).reason).toBe("max");
  });

  it("raises the bar while LEXA is speaking (boost) so quieter sound is not taken as you", () => {
    const v = calibrated();
    v.boost = 2.5;
    expect(types(feed(v, 0.02, 800))).toEqual([]); // above 0.012 but below 0.03
    expect(types(feed(v, 0.2, 400))).toEqual(["start"]); // a clearly louder voice still gets through
  });

  it("calibrates to a noisy room so steady noise is not speech", () => {
    const v = new Vad();
    feed(v, 0.02, 700); // fan noise during calibration
    expect(v.background).toBeCloseTo(0.02, 2);
    expect(v.threshold()).toBeGreaterThan(0.05);
    expect(types(feed(v, 0.02, 3000))).toEqual([]);
    expect(types(feed(v, 0.15, 500))).toEqual(["start"]); // a voice over the noise is detected
  });

  it("adapts its background estimate when the room gets quieter", () => {
    const v = new Vad();
    feed(v, 0.02, 700);
    const before = v.background;
    feed(v, 0.002, 10000);
    expect(v.background).toBeLessThan(before / 2);
  });
});
