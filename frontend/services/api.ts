/** Same-origin API client: httpOnly cookie session + double-submit CSRF header + transparent refresh. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

function csrf(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.cookie.split("; ").find((c) => c.startsWith("lexa_csrf="))?.split("=")[1];
}

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  refreshing ??= fetch("/api/auth/refresh", { method: "POST", credentials: "include" })
    .then((r) => r.ok)
    .finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method || "GET").toUpperCase();
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  if (method !== "GET" && method !== "HEAD") {
    const t = csrf();
    if (t) headers.set("X-CSRF-Token", t);
  }
  const res = await fetch(path, { ...init, method, headers, body, credentials: "include" });
  if (res.status === 401 && retry && !path.startsWith("/api/auth/")) {
    if (await refresh()) return api<T>(path, init, false);
    if (typeof window !== "undefined" && !location.pathname.startsWith("/login")) {
      window.location.assign(`/login?next=${encodeURIComponent(location.pathname)}`);
    }
  }
  if (!res.ok) {
    let detail: unknown = res.statusText;
    try {
      const j = await res.json();
      detail = j.detail ?? j;
    } catch {
      /* not json */
    }
    const msg = typeof detail === "string" ? detail : Array.isArray(detail)
      ? detail.map((d: { msg?: string }) => d.msg).join("; ")
      : JSON.stringify(detail);
    throw new ApiError(res.status, msg, detail);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") || "";
  return (ct.includes("application/json") ? res.json() : res.blob()) as Promise<T>;
}

export const get = <T,>(p: string) => api<T>(p);
export const post = <T,>(p: string, json?: unknown) => api<T>(p, { method: "POST", json: json ?? {} });
export const patch = <T,>(p: string, json: unknown) => api<T>(p, { method: "PATCH", json });
export const put = <T,>(p: string, json: unknown) => api<T>(p, { method: "PUT", json });
export const del = <T,>(p: string) => api<T>(p, { method: "DELETE" });

export async function upload<T>(p: string, form: FormData): Promise<T> {
  return api<T>(p, { method: "POST", body: form });
}

/** Creates a conversation, sends the instruction to LEXA CORE and returns ids. */
export async function runInstruction(content: string, agent?: string) {
  const conv = await post<{ id: string }>("/api/conversations");
  const res = await post<{ task_id: string }>(`/api/conversations/${conv.id}/messages`, { content, agent });
  return { conversationId: conv.id, taskId: res.task_id };
}
