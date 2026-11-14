/**
 * Voice activity detector: decides when an utterance starts and ends from a stream of frame energies (RMS).
 * Pure state machine (no audio APIs) so it can be unit tested with synthetic frames.
 *
 * - Calibrates the room's background level during the first moments, then keeps adapting it while silent.
 * - Needs sustained energy to open an utterance (ignores clicks and keyboard taps).
 * - Closes the utterance after `endSilenceMs` of quiet; short blips are discarded.
 * - `boost` raises the threshold (used while LEXA itself is speaking so its own voice is not mistaken for you).
 */
export interface VadConfig {
  minThreshold: number; // never treat anything quieter than this RMS as speech
  startRatio: number; // speech must exceed background * startRatio
  endRatio: number; // hysteresis: an utterance continues while energy stays above threshold * endRatio
  minSpeechMs: number; // sustained energy needed to open an utterance
  endSilenceMs: number; // silence that closes an utterance
  maxUtteranceMs: number; // force-close very long utterances
  minUtteranceMs: number; // discard utterances with less speech than this
  floorInit: number; // initial background estimate
  calibrateMs: number; // measure the background for this long before listening
}

export const DEFAULT_VAD: VadConfig = {
  minThreshold: 0.012,
  startRatio: 3,
  endRatio: 0.6,
  minSpeechMs: 120,
  endSilenceMs: 1000,
  maxUtteranceMs: 40000,
  minUtteranceMs: 300,
  floorInit: 0.003,
  calibrateMs: 600,
};

export type VadEvent =
  | { type: "start" }
  | { type: "end"; speechMs: number; totalMs: number; reason: "silence" | "max" }
  | { type: "discard"; speechMs: number };

export class Vad {
  boost = 1;
  private floor: number;
  private inSpeech = false;
  private candidateMs = 0;
  private speechMs = 0;
  private silenceMs = 0;
  private totalMs = 0;
  private calibratedMs = 0;
  private calibSum = 0;
  private calibFrames = 0;

  constructor(public cfg: VadConfig = DEFAULT_VAD) {
    this.floor = cfg.floorInit;
  }

  get speaking(): boolean {
    return this.inSpeech;
  }
  get calibrating(): boolean {
    return this.calibratedMs < this.cfg.calibrateMs;
  }
  get background(): number {
    return this.floor;
  }
  threshold(): number {
    return Math.max(this.cfg.minThreshold, this.floor * this.cfg.startRatio) * this.boost;
  }

  reset(): void {
    this.inSpeech = false;
    this.candidateMs = this.speechMs = this.silenceMs = this.totalMs = 0;
  }

  push(rms: number, dtMs: number): VadEvent[] {
    if (this.calibrating) {
      this.calibratedMs += dtMs;
      this.calibSum += rms;
      this.calibFrames += 1;
      if (!this.calibrating && this.calibFrames) {
        // If the user started talking during calibration the average is too high: cap it.
        this.floor = Math.min(Math.max(this.cfg.floorInit, this.calibSum / this.calibFrames), 0.03);
      }
      return [];
    }
    const th = this.threshold();
    const events: VadEvent[] = [];
    if (!this.inSpeech) {
      if (rms > th) {
        this.candidateMs += dtMs;
        if (this.candidateMs >= this.cfg.minSpeechMs) {
          this.inSpeech = true;
          this.speechMs = this.candidateMs;
          this.totalMs = this.candidateMs;
          this.silenceMs = 0;
          events.push({ type: "start" });
        }
      } else {
        this.candidateMs = 0;
        const alpha = 1 - Math.exp(-dtMs / 2000); // ~2 second time constant
        this.floor += (Math.min(rms, th) - this.floor) * alpha;
      }
      return events;
    }
    this.totalMs += dtMs;
    if (rms > th * this.cfg.endRatio) {
      this.speechMs += dtMs;
      this.silenceMs = 0;
    } else {
      this.silenceMs += dtMs;
    }
    if (this.silenceMs >= this.cfg.endSilenceMs) {
      const speechMs = this.speechMs;
      const totalMs = this.totalMs;
      this.reset();
      events.push(speechMs < this.cfg.minUtteranceMs ? { type: "discard", speechMs } : { type: "end", speechMs, totalMs, reason: "silence" });
    } else if (this.totalMs >= this.cfg.maxUtteranceMs) {
      const speechMs = this.speechMs;
      const totalMs = this.totalMs;
      this.reset();
      events.push({ type: "end", speechMs, totalMs, reason: "max" });
    }
    return events;
  }
}
