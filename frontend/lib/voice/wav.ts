/** Audio helpers: concatenation, resampling and 16-bit mono WAV encoding (what the server sends to OpenAI). */

export function concatFloat32(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Box-filter resampler (good enough for speech; averages source samples so high tones do not alias badly). */
export function resample(input: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate || input.length === 0) return input;
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = i * ratio;
    const end = Math.min((i + 1) * ratio, input.length);
    let sum = 0;
    let weight = 0;
    for (let j = Math.floor(start); j < Math.ceil(end); j++) {
      const w = Math.min(j + 1, end) - Math.max(j, start);
      sum += input[j] * w;
      weight += w;
    }
    out[i] = weight ? sum / weight : 0;
  }
  return out;
}

/** PCM16 mono WAV file bytes. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataLen = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  str(36, "data");
  v.setUint32(40, dataLen, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

export function chunksToWav(chunks: Float32Array[], srcRate: number, dstRate = 16000): { bytes: Uint8Array; durationMs: number } {
  const pcm = resample(concatFloat32(chunks), srcRate, dstRate);
  return { bytes: encodeWav(pcm, dstRate), durationMs: Math.round((pcm.length / dstRate) * 1000) };
}

export function rms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}
