"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Command } from "cmdk";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Bell, ChevronsUpDown, HelpCircle, LogOut, Menu, Mic, MicOff, Moon, Search, Sun, X, Zap } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { cn, timeAgo } from "@/lib/utils";
import { NAV, ALL_NAV } from "./nav";
import { LexaMark } from "./orb";
import { useAuth } from "./auth";
import { useEvents } from "@/hooks/use-events";
import { useApi } from "@/hooks/use-api";
import { post, runInstruction } from "@/services/api";
import { Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator, DropdownTrigger } from "@/components/ui/dropdown";
import { useVoice } from "@/components/voice/voice-provider";
import type { Notification } from "@/types";

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  return (
    <nav aria-label="Primary" className="flex h-full flex-col gap-4 p-3">
      <Link href="/" onClick={onNavigate} className="flex items-center gap-2.5 px-2 py-1.5">
        <LexaMark />
        <span className="text-[15px] font-semibold tracking-[0.18em]">LEXA</span>
      </Link>
      <div className="flex-1 space-y-5 overflow-y-auto scrollbar-thin">
        {NAV.map((g) => (
          <div key={g.group}>
            <p className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-subtle">{g.group}</p>
            <ul className="space-y-0.5">
              {g.items.map((item) => {
                const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                return (
                  <li key={item.href}>
                    <Link href={item.href} onClick={onNavigate} aria-current={active ? "page" : undefined}
                      className={cn("group relative flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition",
                        active ? "bg-surface-2 text-foreground" : "text-muted hover:bg-surface-2/70 hover:text-foreground")}>
                      {active && <motion.span layoutId="nav-active" className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-grad" />}
                      <item.icon className={cn("size-4", active ? "text-primary" : "")} />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <Dropdown>
        <DropdownTrigger className="flex w-full items-center gap-2 rounded-lg border border-border p-2 text-left hover:bg-surface-2">
          <span className="grid size-7 place-items-center rounded-md bg-grad text-xs font-semibold text-white">
            {(user?.full_name || user?.email || "?").slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">{user?.full_name || "You"}</span>
            <span className="block truncate text-[11px] text-subtle">{user?.email}</span>
          </span>
          <ChevronsUpDown className="size-3.5 text-subtle" />
        </DropdownTrigger>
        <DropdownContent align="start" className="w-56">
          <DropdownLabel>Signed in as {user?.role}</DropdownLabel>
          <DropdownItem asChild><Link href="/settings">Settings</Link></DropdownItem>
          <DropdownSeparator />
          <DropdownItem onSelect={() => void logout()}><LogOut />Sign out</DropdownItem>
        </DropdownContent>
      </Dropdown>
    </nav>
  );
}

function CommandPalette({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  const router = useRouter();
  const voice = useVoice();
  const [q, setQ] = useState("");
  const go = (href: string) => { setOpen(false); router.push(href); };
  const ask = async () => {
    if (!q.trim()) return;
    setOpen(false);
    try {
      const { conversationId } = await runInstruction(q.trim());
      router.push(`/assistant/${conversationId}`);
    } catch (e) { toast.error((e as Error).message); }
  };
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh] backdrop-blur-sm"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(false)}>
          <motion.div initial={{ y: -8, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: -8, scale: 0.98 }}
            className="w-full max-w-xl overflow-hidden rounded-xl border border-border-strong bg-elevated shadow-2xl"
            onClick={(e) => e.stopPropagation()}>
            <Command label="Command menu" shouldFilter loop>
              <div className="flex items-center gap-2 border-b border-border px-3">
                <Search className="size-4 text-subtle" />
                <Command.Input autoFocus value={q} onValueChange={setQ} placeholder="Ask LEXA or jump to…"
                  className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-subtle"
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void ask(); }} />
                <kbd className="rounded border border-border px-1.5 text-[10px] text-subtle">ESC</kbd>
              </div>
              <Command.List className="max-h-80 overflow-y-auto p-1.5 scrollbar-thin">
                
                <Command.Group heading="Navigate" className="text-[11px] text-subtle [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1">
                  {ALL_NAV.map((n) => (
                    <Command.Item key={n.href} value={n.label} onSelect={() => go(n.href)}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-foreground data-[selected=true]:bg-surface-2">
                      <n.icon className="size-4 text-muted" />{n.label}
                    </Command.Item>
                  ))}
                </Command.Group>
                <Command.Group heading="Voice" className="text-[11px] text-subtle [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1">
                  <Command.Item value="voice mode toggle talk speak microphone" onSelect={() => { setOpen(false); voice.toggle(); }}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-foreground data-[selected=true]:bg-surface-2">
                    <Mic className="size-4 text-muted" />{voice.snap.active ? "Turn voice mode off" : "Turn voice mode on"}
                  </Command.Item>
                  <Command.Item value="voice help what can i say commands" onSelect={() => { setOpen(false); voice.setHelpOpen(true); }}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-foreground data-[selected=true]:bg-surface-2">
                    <HelpCircle className="size-4 text-muted" />What can I say?
                  </Command.Item>
                </Command.Group>
                {q.trim() && (
                  <Command.Group heading="Ask" className="text-[11px] text-subtle [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1">
                    <Command.Item value={`ask ${q}`} keywords={[q]} forceMount onSelect={() => void ask()}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-foreground data-[selected=true]:bg-surface-2">
                      <Zap className="size-4 text-primary" /> Ask LEXA: <span className="truncate text-muted">“{q}”</span>
                    </Command.Item>
                  </Command.Group>
                )}
              </Command.List>
            </Command>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Notifications() {
  const { data, reload, setData } = useApi<Notification[]>("/api/notifications");
  useEvents((e) => {
    if (e.event === "notification") {
      void reload();
      const sev = e.data.severity;
      const fn = sev === "error" ? toast.error : sev === "warning" ? toast.warning : sev === "success" ? toast.success : toast;
      fn(e.data.title);
    }
  });
  const unread = (data || []).filter((n) => !n.read).length;
  const markAll = async () => {
    await post("/api/notifications/read", {});
    setData((data || []).map((n) => ({ ...n, read: true })));
  };
  return (
    <div className="relative">
    <Dropdown>
      <DropdownTrigger className="grid size-9 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-foreground"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}>
        <Bell className="size-4" />
      </DropdownTrigger>
      <DropdownContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-medium">Notifications</span>
          {unread > 0 && <button onClick={() => void markAll()} className="text-xs text-accent hover:underline">Mark all read</button>}
        </div>
        <div className="max-h-96 overflow-y-auto scrollbar-thin">
          {!data?.length && <p className="px-3 py-8 text-center text-xs text-muted">You’re all caught up.</p>}
          {data?.slice(0, 20).map((n) => (
            <DropdownItem key={n.id} asChild className="block rounded-none border-b border-border px-3 py-2.5 last:border-0">
              <Link href={n.link || "/tasks"}>
                <div className="flex items-start gap-2">
                  {!n.read && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />}
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium">{n.title}</p>
                    {n.body && <p className="line-clamp-2 text-xs text-muted">{n.body}</p>}
                    <p className="mt-0.5 text-[10px] text-subtle">{timeAgo(n.created_at)}</p>
                  </div>
                </div>
              </Link>
            </DropdownItem>
          ))}
        </div>
      </DropdownContent>
    </Dropdown>
    {unread > 0 && <span aria-hidden className="pointer-events-none absolute right-1.5 top-1.5 grid min-w-4 place-items-center rounded-full bg-[color-mix(in_srgb,var(--primary)_80%,black)] px-1 text-[9px] font-semibold text-white">{unread > 9 ? "9+" : unread}</span>}
    </div>
  );
}

function VoiceButton() {
  const { snap, toggle } = useVoice();
  const on = snap.active;
  return (
    <button type="button" onClick={toggle} aria-pressed={on} aria-label="Voice mode" aria-keyshortcuts="Alt+V" title="Voice mode (Alt+V)"
      className={cn("flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm transition hover:bg-surface-2",
        on ? "bg-primary/15 text-primary-text" : "text-muted hover:text-foreground")}>
      {on ? <Mic className="size-4" /> : <MicOff className="size-4" />}
      <span className="hidden sm:inline" aria-hidden>Voice</span>
    </button>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(() => () => undefined, () => true, () => false);
  return (
    <button onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")} aria-label="Toggle theme"
      className="grid size-9 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-foreground">
      {mounted && resolvedTheme === "light" ? <Moon className="size-4" /> : <Sun className="size-4" />}
    </button>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const { user, loading } = useAuth();
  const voice = useVoice();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (loading || !user) {
    return <div className="grid min-h-dvh place-items-center"><LexaMark className="size-10 animate-pulse" /></div>;
  }

  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-white">Skip to content</a>
      <button type="button" data-voice-ui onClick={voice.toggle} aria-keyshortcuts="Alt+V"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-14 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-white">
        {voice.snap.active ? "Turn voice control off (Alt+V)" : "Turn voice control on (Alt+V)"}
      </button>
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 border-r border-border bg-surface/60 lg:block">
        <Sidebar />
      </aside>
      <AnimatePresence>
        {mobileNav && (
          <motion.div className="fixed inset-0 z-40 bg-black/50 lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setMobileNav(false)}>
            <motion.aside initial={{ x: -260 }} animate={{ x: 0 }} exit={{ x: -260 }} transition={{ type: "spring", damping: 30, stiffness: 300 }}
              className="h-full w-64 border-r border-border bg-surface" onClick={(e) => e.stopPropagation()}>
              <button className="absolute right-3 top-3 rounded-md p-1 text-muted" onClick={() => setMobileNav(false)} aria-label="Close menu"><X className="size-4" /></button>
              <Sidebar onNavigate={() => setMobileNav(false)} />
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="glass sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border px-3 sm:px-5">
          <button className="grid size-9 place-items-center rounded-lg text-muted hover:bg-surface-2 lg:hidden" onClick={() => setMobileNav(true)} aria-label="Open menu">
            <Menu className="size-4" />
          </button>
          <button onClick={() => setPaletteOpen(true)}
            className="flex h-9 w-full max-w-md items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-3 text-sm text-subtle hover:border-border-strong">
            <Search className="size-4" />
            <span className="truncate">Ask LEXA or search…</span>
            <kbd className="ml-auto hidden rounded border border-border px-1.5 text-[10px] sm:inline">⌘K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <VoiceButton />
            <ThemeToggle />
            <Notifications />
          </div>
        </header>
        <main id="main" tabIndex={-1} className={cn("ambient flex-1 px-4 py-6 outline-none sm:px-6 lg:px-8", voice.snap.active && "pb-56")}>{children}</main>
      </div>
      <CommandPalette open={paletteOpen} setOpen={setPaletteOpen} />
    </div>
  );
}
