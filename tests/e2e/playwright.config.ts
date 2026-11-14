import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Shared across projects/workers so the mobile project can sign in with the account desktop created.
process.env.E2E_EMAIL ||= `e2e-${Date.now()}@example.com`;

const executablePath = process.env.PW_CHROMIUM || undefined;

/**
 * Speech-like audio for Chromium's fake microphone (`--use-file-for-fake-audio-capture`).
 * 0–1.5 s is quiet (the voice detector measures the room), then two bursts of voiced, syllable-modulated sound at
 * 1.6 s and 9.0 s. The test queues what the server-side "transcription" of each burst should be, so the real
 * pipeline (microphone → detector → WAV upload → command → reply) is exercised without a paid speech API.
 */
function speechFixture(): string {
  const rate = 48000;
  const seconds = 22;
  const bursts: [number, number][] = [[1.6, 1.5], [9.0, 1.5]];
  const samples = new Int16Array(rate * seconds);
  for (const [start, len] of bursts) {
    for (let i = 0; i < len * rate; i++) {
      const t = i / rate;
      const f0 = 120 + 25 * Math.sin(2 * Math.PI * 0.8 * t);
      let v = 0;
      for (let k = 1; k <= 14; k++) v += Math.sin(2 * Math.PI * k * f0 * t + k) / k;
      const syllable = 0.35 + 0.65 * Math.abs(Math.sin(Math.PI * 3.2 * t));
      const fade = Math.min(1, t * 30, (len - t) * 30);
      samples[Math.floor(start * rate) + i] = Math.round(v * syllable * fade * 9000);
    }
  }
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write("RIFF", 0); data.writeUInt32LE(36 + samples.length * 2, 4); data.write("WAVE", 8); data.write("fmt ", 12);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36);
  data.writeUInt32LE(samples.length * 2, 40);
  Buffer.from(samples.buffer).copy(data, 44);
  const dir = path.join(__dirname, "test-results");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "speech-fixture.wav");
  writeFileSync(file, data);
  return file;
}

const fakeMic = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  `--use-file-for-fake-audio-capture=${speechFixture()}%noloop`,
  "--autoplay-policy=no-user-gesture-required",
];

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: process.env.E2E_BASE_URL || "http://localhost:3000", trace: "off", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath } }, testIgnore: /(voice|a11y)\.spec\.ts/ },
    { name: "mobile", use: { ...devices["Pixel 7"], launchOptions: { executablePath } }, testMatch: /lexa\.spec\.ts/, grep: /@mobile/, dependencies: ["desktop"] },
    // Voice runs in a browser with a fake microphone that plays the fixture above.
    { name: "voice", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath, args: fakeMic }, permissions: ["microphone"] },
      testMatch: /voice\.spec\.ts/, dependencies: ["desktop"] },
    { name: "a11y", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath } }, testMatch: /a11y\.spec\.ts/, dependencies: ["desktop"] },
  ],
});
