/**
 * The one voice runtime per browser tab (there is only one microphone). It owns the real speaker, microphone and
 * API adapters. React only binds what it knows (router, settings) through `bindVoice`, and renders the state.
 */
import type { Approval } from "@/types";
import { api, post, runInstruction } from "@/services/api";
import { playCue, cueDuration } from "./earcons";
import { Mic } from "./mic";
import { Speaker } from "./speaker";
import {
  VoiceController, type DashboardLite, type NotificationLite, type TaskLite, type VoiceApi, type VoiceConfig, type VoiceHost,
  type VoiceSnapshot,
} from "./controller";

export interface VoiceCaps {
  server_stt: boolean;
  server_tts: boolean;
  stt_model: string;
  tts_model: string;
  voices: string[];
  max_utterance_seconds: number;
}

export interface VoicePrefs extends VoiceConfig {
  engine: "server" | "browser";
  voice: string;
  autoStart: boolean;
}

export const DEFAULT_PREFS: VoicePrefs = {
  speed: 1, language: "", patience: "normal", wakePhrase: false, cues: true, speakResponses: false,
  engine: "server", voice: "nova", autoStart: false,
};

export type ChatSend = (text: string, opts: { voice: boolean }) => Promise<{ taskId: string; conversationId?: string } | null>;

interface Bound {
  prefs: VoicePrefs;
  caps: VoiceCaps | null;
  navigate: (path: string) => void;
  persist: (patch: Record<string, unknown>) => Promise<void>;
  openHelp: () => void;
  chatSend: ChatSend | null;
}

const bound: Bound = {
  prefs: DEFAULT_PREFS, caps: null, navigate: () => undefined, persist: async () => undefined, openHelp: () => undefined, chatSend: null,
};

export function bindVoice(patch: Partial<Bound>): void {
  Object.assign(bound, patch);
}

/** Pulls preferences out of the signed-in user's saved settings. */
export function prefsFromSettings(s: Record<string, unknown> | undefined): VoicePrefs {
  const v = s ?? {};
  const speed = typeof v.voice_speed === "number" ? Math.max(0.6, Math.min(1.8, v.voice_speed)) : 1;
  const patience = v.voice_patience === "quick" || v.voice_patience === "patient" ? v.voice_patience : "normal";
  return {
    speed, patience, language: typeof v.voice_language === "string" ? v.voice_language : "",
    wakePhrase: v.voice_wake_phrase === true, cues: v.voice_cues !== false, speakResponses: v.speak_responses === true,
    engine: v.voice_engine === "browser" ? "browser" : "server", voice: typeof v.voice === "string" && v.voice ? v.voice : "nova",
    autoStart: v.voice_auto_start === true,
  };
}

const realApi: VoiceApi = {
  async transcribe(wav, durationMs, language) {
    const fd = new FormData();
    fd.append("audio", new Blob([wav as BlobPart], { type: "audio/wav" }), "speech.wav");
    if (language) fd.append("language", language);
    fd.append("duration_ms", String(durationMs));
    return api<{ text: string; skipped?: string }>("/api/voice/transcribe", { method: "POST", body: fd });
  },
  approvals: () => api<Approval[]>("/api/approvals"),
  decide: async (id, approve) => { await post(`/api/approvals/${id}/decision`, { approve }); },
  dashboard: () => api<DashboardLite>("/api/dashboard"),
  notifications: () => api<NotificationLite[]>("/api/notifications"),
  markNotificationsRead: async () => { await post("/api/notifications/read", {}); },
  task: (id) => api<TaskLite>(`/api/tasks/${id}`),
  cancelTask: async (id) => { await post(`/api/tasks/${id}/cancel`); },
};

const realHost: VoiceHost = {
  navigate: (p) => bound.navigate(p),
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  pathname: () => window.location.pathname,
  async ask(text, { voice }) {
    if (bound.chatSend) return bound.chatSend(text, { voice });
    const r = await runInstruction(text, undefined, { voice });
    return { taskId: r.taskId, conversationId: r.conversationId };
  },
};

let instance: VoiceController | null = null;
let speakerInstance: Speaker | null = null;

export function getVoice(): VoiceController {
  if (instance) return instance;
  const speaker = new Speaker({
    synth: (text, voice, signal) => api<Blob>("/api/voice/speak", { method: "POST", json: { text, voice }, signal }),
    engine: () => (bound.prefs.engine === "browser" || bound.caps?.server_tts === false ? "browser" : "server"),
    voice: () => bound.prefs.voice,
    rate: () => bound.prefs.speed,
    language: () => bound.prefs.language,
    onStart: () => instance?.onSpeakStart(),
    onEnd: () => instance?.onSpeakEnd(),
    onFallback: (why) => instance?.setNotice(`Using your browser's voice (${why}).`),
    onBlocked: () => instance?.setNotice("Your browser blocked sound. Press any key or click once to allow it."),
  });
  speakerInstance = speaker;
  instance = new VoiceController({
    api: realApi,
    host: realHost,
    speaker,
    createMic: (handlers) => new Mic(handlers),
    config: () => bound.prefs,
    setSpeed: (speed) => {
      bound.prefs = { ...bound.prefs, speed };
      void bound.persist({ voice_speed: speed });
    },
    playCue,
    cueDuration,
    openHelp: () => bound.openHelp(),
  });
  return instance;
}

export function getSpeaker(): Speaker | null {
  return speakerInstance;
}

export function getCaps(): VoiceCaps | null {
  return bound.caps;
}

/** What server-side rendering shows before the controller exists. */
export const SERVER_SNAPSHOT: VoiceSnapshot = {
  active: false, listening: false, phase: "off", heard: "", said: "", error: null, notice: null, awaiting: null,
  micProblem: null, history: [],
};
