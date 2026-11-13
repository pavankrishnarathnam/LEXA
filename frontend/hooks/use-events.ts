"use client";
import { useEffect, useRef } from "react";

export type LexaEvent = { event: string; data: any };
type Listener = (e: LexaEvent) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;
let retry = 0;

const EVENTS = ["task.created", "task.status", "task.plan", "task.log", "task.delta", "task.completed", "agent.status",
  "agent.tool", "approval.decided", "approval.executed", "notification"];

function connect() {
  if (typeof window === "undefined" || source) return;
  source = new EventSource("/api/events", { withCredentials: true });
  source.onopen = () => (retry = 0);
  for (const name of EVENTS) {
    source.addEventListener(name, (ev) => {
      let data: any = {};
      try {
        data = JSON.parse((ev as MessageEvent).data);
      } catch {
        /* ignore */
      }
      listeners.forEach((l) => l({ event: name, data }));
    });
  }
  source.onerror = () => {
    source?.close();
    source = null;
    if (listeners.size) setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
  };
}

/** Subscribe to LEXA's realtime Server-Sent Events (one shared connection per tab). */
export function useEvents(handler: Listener) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    const l: Listener = (e) => ref.current(e);
    listeners.add(l);
    connect();
    return () => {
      listeners.delete(l);
      if (!listeners.size) {
        source?.close();
        source = null;
      }
    };
  }, []);
}
