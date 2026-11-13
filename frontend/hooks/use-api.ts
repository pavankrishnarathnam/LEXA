"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/services/api";

/** Minimal data hook: fetches `path` on mount/change and exposes reload + local mutate. */
export function useApi<T>(path: string | null) {
  const [state, setState] = useState<{ path: string | null; data?: T; error: Error | null; loading: boolean }>(
    { path, data: undefined, error: null, loading: !!path });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    api<T>(path)
      .then((d) => { if (!cancelled) setState({ path, data: d, error: null, loading: false }); })
      .catch((e: Error) => { if (!cancelled) setState((s) => ({ ...s, path, error: e, loading: false })); });
    return () => { cancelled = true; };
  }, [path, version]);

  const reload = useCallback(async () => { setVersion((v) => v + 1); }, []);
  const setData = useCallback((d: T | undefined) => setState((s) => ({ ...s, data: d })), []);
  const stale = state.path !== path;
  return { data: state.data, error: state.error, loading: stale ? !!path : state.loading, reload, setData };
}
