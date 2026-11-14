"use client";
import { useState } from "react";
import { HelpCircle, Moon, Power, Square, Sun } from "lucide-react";
import { LexaOrb } from "@/components/layout/orb";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Phase } from "@/lib/voice/controller";
import { useVoice, useVoiceLevel } from "./voice-provider";

const LABEL: Record<Phase, string> = {
  off: "Voice is off", starting: "Starting the microphone…", listening: "Listening", hearing: "Hearing you…",
  transcribing: "Understanding…", thinking: "Working on it…", speaking: "Speaking", sleeping: "Sleeping. Say “Hey LEXA”",
};

const ORB: Record<Phase, "idle" | "listening" | "processing" | "speaking" | "thinking"> = {
  off: "idle", starting: "processing", listening: "idle", hearing: "listening", transcribing: "processing",
  thinking: "thinking", speaking: "speaking", sleeping: "idle",
};

function LiveOrb({ phase }: { phase: Phase }) {
  const level = useVoiceLevel();
  return <LexaOrb size={44} state={ORB[phase]} level={level} className="shrink-0" />;
}

/** The voice bar docked at the bottom while voice mode is on: what LEXA is doing, what it heard, and typed fallback. */
export function VoiceStrip() {
  const { snap, controller, stopSpeaking, hear, setHelpOpen, toggle } = useVoice();
  const [text, setText] = useState("");
  const sleeping = snap.phase === "sleeping";

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText("");
    void hear(t);
  };

  return (
    <section data-voice-ui aria-label="Voice control"
      className="fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
      <div className="mx-auto max-w-3xl rounded-2xl border border-border-strong bg-elevated/95 p-3 shadow-2xl backdrop-blur">
        <div className="flex items-center gap-3">
          <LiveOrb phase={snap.phase} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium" data-testid="voice-phase">{snap.listening ? LABEL[snap.phase] : "Voice (text only)"}</p>
            <p className="truncate text-xs text-muted">
              {snap.interim && <span data-testid="voice-interim" className="italic">“{snap.interim}…”</span>}
              {!snap.interim && snap.heard && <><span className="sr-only">You said: </span><span data-testid="voice-heard">“{snap.heard}”</span></>}
              {!snap.interim && !snap.heard && snap.listening && <span>Say what you need, or “help”.</span>}
            </p>
            {snap.active && (
              <p className="text-[11px] text-subtle" data-testid="voice-engine">
                {snap.recognition === "server" ? "Listening with OpenAI speech recognition"
                  : snap.recognition === "browser" ? "Listening with your browser's free speech recognition"
                  : "Can't hear you: type commands below"}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {snap.phase === "speaking" && (
              <Button type="button" size="sm" variant="secondary" onClick={stopSpeaking}><Square />Stop</Button>
            )}
            {snap.listening && (
              <Button type="button" size="icon" variant="ghost" aria-label={sleeping ? "Wake LEXA" : "Put voice to sleep"}
                onClick={() => (sleeping ? controller.wakeUp() : controller.goToSleep())}>
                {sleeping ? <Sun /> : <Moon />}
              </Button>
            )}
            <Button type="button" size="icon" variant="ghost" aria-label="Voice help" onClick={() => setHelpOpen(true)}><HelpCircle /></Button>
            <Button type="button" size="icon" variant="ghost" aria-label="Turn voice mode off" aria-keyshortcuts="Alt+V" onClick={toggle}><Power /></Button>
          </div>
        </div>

        {snap.said && (
          <p className="mt-2 line-clamp-2 text-xs text-foreground/80" data-testid="voice-said">
            <span className="sr-only">LEXA said: </span><span aria-hidden>LEXA: </span>{snap.said}
          </p>
        )}
        {snap.awaiting && (
          <p className={cn("mt-2 rounded-lg border px-2.5 py-1.5 text-xs", "border-warning/40 bg-warning/10 text-foreground")} data-testid="voice-awaiting">
            Waiting for your answer: {snap.awaiting.prompt}
          </p>
        )}
        {(snap.micProblem || snap.error) && (
          <p role="alert" className="mt-2 rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs text-foreground">{snap.micProblem || snap.error}</p>
        )}
        {snap.notice && <p role="status" className="mt-2 text-xs text-muted">{snap.notice}</p>}

        <form onSubmit={send} className="mt-2 flex items-center gap-2">
          <label htmlFor="voice-typed" className="sr-only">Type a command for LEXA</label>
          <input id="voice-typed" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false}
            placeholder="Or type a command, e.g. “what's pending”"
            className="h-9 min-w-0 flex-1 rounded-lg border border-border-strong bg-surface-2/60 px-3 text-sm outline-none placeholder:text-subtle focus:border-primary focus:ring-2 focus:ring-[var(--ring)]" />
          <Button type="submit" size="sm" variant="secondary" disabled={!text.trim()}>Send</Button>
        </form>

        {snap.history.length > 0 && (
          <details className="mt-2 text-xs text-muted">
            <summary className="cursor-pointer select-none">Transcript</summary>
            <ol role="log" aria-live="off" className="mt-1 max-h-40 space-y-1 overflow-y-auto pr-1 scrollbar-thin">
              {snap.history.map((h) => (
                <li key={h.id}><span className="font-medium text-foreground/80">{h.role === "you" ? "You" : "LEXA"}:</span> {h.text}</li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </section>
  );
}
