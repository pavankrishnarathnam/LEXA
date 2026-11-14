"use client";
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/services/api";
import { useAuth } from "@/components/layout/auth";
import { useEvents } from "@/hooks/use-events";
import type { User } from "@/types";
import type { VoiceController, VoiceSnapshot } from "@/lib/voice/controller";
import { bindVoice, getSpeaker, getVoice, prefsFromSettings, SERVER_SNAPSHOT, type ChatSend, type VoiceCaps } from "@/lib/voice/runtime";
import { VoiceStrip } from "./voice-strip";
import { VoiceHelp } from "./voice-help";

export interface VoiceCtx {
  snap: VoiceSnapshot;
  caps: VoiceCaps | null;
  controller: VoiceController;
  /** Turns voice mode on (microphone + spoken replies) or off. Must run from a click or key press. */
  toggle: () => void;
  stopSpeaking: () => void;
  /** Run a typed command through exactly the same grammar as speech. */
  hear: (text: string) => Promise<void>;
  /** Read a chat reply aloud (first part now, "read more" for the rest). */
  readAloud: (markdown: string) => void;
  announce: (text: string) => void;
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
}

export const VoiceContext = createContext<VoiceCtx | null>(null);
const Ctx = VoiceContext;

const TEXT_ONLY_NOTICE =
  "Speech recognition isn't set up on the server yet (it needs OPENAI_API_KEY), so I can't hear you. Type commands in the box below; I will still speak.";

/** Voice for the whole signed-in app: owns the microphone, speech, hotkeys and the voice bar. */
export function VoiceProvider({ children }: { children: React.ReactNode }) {
  const { user, setUser } = useAuth();
  const router = useRouter();
  const controller = getVoice();
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, () => SERVER_SNAPSHOT);
  const [helpOpen, setHelpOpen] = useState(false);
  const [caps, setCaps] = useState<VoiceCaps | null>(null);
  const userId = user?.id;

  // What React knows (router, saved settings) is handed to the voice runtime after every render.
  useEffect(() => {
    bindVoice({
      prefs: prefsFromSettings(user?.settings),
      navigate: (path) => router.push(path),
      openHelp: () => setHelpOpen(true),
      persist: async (patch) => {
        const u = await api<User>("/api/auth/me/settings", { method: "PATCH", json: patch });
        setUser(u);
      },
    });
    getSpeaker()?.refreshRate();
  });

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    api<VoiceCaps>("/api/voice/capabilities")
      .then((c) => { if (!cancelled) { bindVoice({ caps: c }); setCaps(c); } })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [userId]);

  const toggle = useCallback(() => {
    if (controller.getSnapshot().active) { void controller.stop(); return; }
    const listen = caps ? caps.server_stt : true;
    void controller.start({ listen }).then((ok) => { if (ok && !listen) controller.setNotice(TEXT_ONLY_NOTICE); });
  }, [controller, caps]);

  // Stable identities: consumers use these in effect dependencies, and the snapshot changes many times a second.
  const stopSpeaking = useCallback(() => controller.stopSpeaking(), [controller]);
  const hear = useCallback((text: string) => controller.hearTyped(text), [controller]);
  const readAloud = useCallback((md: string) => controller.readAloud(md), [controller]);
  const announce = useCallback((text: string) => controller.announce(text), [controller]);

  const value: VoiceCtx = { snap, caps, controller, toggle, helpOpen, setHelpOpen, stopSpeaking, hear, readAloud, announce };

  return (
    <Ctx.Provider value={value}>
      {children}
      {userId && <VoiceEffects toggle={toggle} />}
      {(snap.active || snap.micProblem) && <VoiceStrip />}
      <VoiceHelp />
    </Ctx.Provider>
  );
}

/** Things that must only run for a signed-in user: events, hotkeys, first-gesture unlock, auto-start. */
function VoiceEffects({ toggle }: { toggle: () => void }) {
  const { user } = useAuth();
  const controller = getVoice();
  const pathname = usePathname();
  const autoStart = prefsFromSettings(user?.settings).autoStart;

  useEvents((e) => controller.handleEvent(e));

  useEffect(() => { controller.routeChanged(); }, [controller, pathname]);

  useEffect(() => () => { void controller.stop("fatal"); }, [controller]);

  // Alt+V toggles voice; Escape silences LEXA. Capture phase so no page element can swallow it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "KeyV" && e.altKey && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        toggle();
        return;
      }
      if (e.key === "Escape" && controller.getSnapshot().phase === "speaking") controller.stopSpeaking();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [controller, toggle]);

  // Browsers only allow sound and microphone after a gesture: use the first one to unlock audio (and auto-start).
  useEffect(() => {
    let done = false;
    const onGesture = (e: Event) => {
      getSpeaker()?.unlock();
      if (done) return;
      done = true;
      if (autoStart && !controller.getSnapshot().active && !(e instanceof KeyboardEvent && e.altKey)) toggle();
    };
    window.addEventListener("pointerdown", onGesture, { capture: true });
    window.addEventListener("keydown", onGesture, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", onGesture, { capture: true });
      window.removeEventListener("keydown", onGesture, { capture: true });
    };
  }, [controller, autoStart, toggle]);

  return null;
}

export function useVoice(): VoiceCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useVoice outside VoiceProvider");
  return c;
}

/** Same as useVoice, but null when there is no provider (isolated component tests). */
export function useVoiceOptional(): VoiceCtx | null {
  return useContext(Ctx);
}

/** Microphone level 0..1, re-rendering only the component that uses it. */
export function useVoiceLevel(): number {
  const c = getVoice();
  return useSyncExternalStore(c.subscribeLevel, c.getLevel, () => 0);
}

/** Lets the open chat take over sending, so voice requests appear in the conversation you are looking at. */
export function useVoiceChatBridge(send: ChatSend): void {
  useEffect(() => {
    bindVoice({ chatSend: send });
    return () => bindVoice({ chatSend: null });
  });
}
