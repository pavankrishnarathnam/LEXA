/** Short synthesized sound cues (no audio files): they confirm what LEXA heard or did without words. */
export type Cue = "start" | "heard" | "ok" | "done" | "error" | "sleep" | "wake";

// [frequency Hz, duration ms, delay ms]
const PATTERNS: Record<Cue, [number, number, number][]> = {
  start: [[523, 80, 0], [784, 110, 70]],
  heard: [[880, 45, 0]],
  ok: [[660, 60, 0]],
  done: [[784, 80, 0], [1047, 120, 70]],
  error: [[330, 140, 0], [247, 200, 120]],
  sleep: [[784, 80, 0], [523, 140, 70]],
  wake: [[523, 70, 0], [659, 70, 60], [880, 110, 120]],
};

/** How long the cue lasts, so the microphone can ignore it. */
export function cueDuration(cue: Cue): number {
  return Math.max(...PATTERNS[cue].map(([, ms, delay]) => ms + delay)) + 90;
}

let ctx: AudioContext | null = null;

export function playCue(cue: Cue, volume = 0.05): void {
  try {
    const AC: typeof AudioContext | undefined = typeof AudioContext !== "undefined" ? AudioContext
      : (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    if (ctx.state === "suspended") void ctx.resume();
    const t0 = ctx.currentTime;
    for (const [freq, ms, delay] of PATTERNS[cue]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = t0 + delay / 1000;
      const end = start + ms / 1000;
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(volume, start + 0.012);
      gain.gain.linearRampToValueAtTime(0, end);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(end + 0.03);
    }
  } catch {
    /* audio not available: cues are a nicety */
  }
}
