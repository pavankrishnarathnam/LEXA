"use client";
import { useCallback, useEffect, useState } from "react";
import { del, get, post } from "@/services/api";

export interface Job {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error" | "cancelled";
  content: string;
  is_error: boolean;
  untrusted: boolean;
  started_at: number;
  finished_at: number | null;
  seconds: number | null;
}

const POLL_MS = 1000;

/**
 * Starts one analysis on the server and follows it until it ends. No AI model is involved: the server runs the
 * same tools the Trader agent uses, straight from this button.
 * The latest result of the tool is loaded on mount, so a reload (or a long scan you navigated away from) loses nothing.
 */
export function useJob(tool: string) {
  const [job, setJob] = useState<Job | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const id = job?.id;
  const running = job?.status === "running";

  useEffect(() => {
    let cancelled = false;
    get<Job>(`/api/trading/jobs/latest?tool=${encodeURIComponent(tool)}`)
      .then((j) => { if (!cancelled) setJob(j); })
      .catch(() => { /* no earlier result */ });
    return () => { cancelled = true; };
  }, [tool]);

  useEffect(() => {
    if (!id || !running) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = await get<Job>(`/api/trading/jobs/${id}`);
        if (cancelled) return;
        setJob(next);
        if (next.status === "running") timer = setTimeout(tick, POLL_MS);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    timer = setTimeout(tick, POLL_MS);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [id, running]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const run = useCallback(async (args: Record<string, unknown>) => {
    setError(null);
    setStarting(true);
    try {
      setJob(await post<Job>("/api/trading/jobs", { tool, args }));
      setNow(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }, [tool]);

  const stop = useCallback(async () => {
    if (id) await del(`/api/trading/jobs/${id}`).catch(() => undefined);
  }, [id]);

  const elapsed = running && job ? Math.max(0, Math.floor((now - job.started_at * 1000) / 1000)) : 0;
  return { job, run, stop, starting, running: !!running, elapsed, error };
}
