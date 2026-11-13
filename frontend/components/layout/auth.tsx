"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { api, post } from "@/services/api";
import type { User } from "@/types";

type Ctx = { user: User | null; loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void>; setUser: (u: User) => void };
const AuthCtx = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  const refresh = useCallback(async () => {
    setUser(await api<User>("/api/auth/me"));
  }, []);

  useEffect(() => {
    let cancelled = false;
    api<User>("/api/auth/me")
      .then((u) => { if (!cancelled) { setUser(u); setLoading(false); } })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
        router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      });
    return () => { cancelled = true; };
    // Session check runs once per app mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const logout = useCallback(async () => {
    await post("/api/auth/logout").catch(() => undefined);
    setUser(null);
    router.replace("/login");
  }, [router]);

  return <AuthCtx.Provider value={{ user, loading, refresh, logout, setUser }}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const c = useContext(AuthCtx);
  if (!c) throw new Error("useAuth outside AuthProvider");
  return c;
}
