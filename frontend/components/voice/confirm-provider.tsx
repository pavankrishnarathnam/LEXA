"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import * as D from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { useVoiceOptional } from "./voice-provider";

interface Base { title: string; description?: string; confirmLabel?: string; cancelLabel?: string; destructive?: boolean }
export interface PromptOptions extends Base { label: string; defaultValue?: string; type?: "text" | "number" }

interface Api {
  confirm: (o: Base) => Promise<boolean>;
  prompt: (o: PromptOptions) => Promise<string | null>;
}

type Req =
  | { kind: "confirm"; o: Base; resolve: (v: boolean) => void }
  | { kind: "prompt"; o: PromptOptions; resolve: (v: string | null) => void };

const Ctx = createContext<Api | null>(null);

/**
 * Replaces the browser's native confirm()/prompt(). Those cannot be operated or even read reliably by voice or
 * assistive tech; this dialog is a real alertdialog, reads itself aloud in voice mode, and "yes" / "no" answer it.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const voice = useVoiceOptional();
  const [req, setReq] = useState<Req | null>(null);
  const [value, setValue] = useState("");

  const confirm = useCallback((o: Base) => new Promise<boolean>((resolve) => setReq({ kind: "confirm", o, resolve })), []);
  const prompt = useCallback((o: PromptOptions) => new Promise<string | null>((resolve) => {
    setValue(o.defaultValue ?? "");
    setReq({ kind: "prompt", o, resolve });
  }), []);

  const finish = (ok: boolean) => {
    if (!req) return;
    if (req.kind === "confirm") req.resolve(ok);
    else req.resolve(ok ? value : null);
    setReq(null);
  };

  // Read the question aloud once per dialog (never in response to the voice bar updating).
  const announceRef = useRef(voice?.announce);
  useEffect(() => { announceRef.current = voice?.announce; });
  useEffect(() => {
    if (!req) return;
    announceRef.current?.(req.kind === "confirm"
      ? `${req.o.title}. ${req.o.description ?? ""} Say yes or no.`
      : `${req.o.title}. ${req.o.label}. Say set ${req.o.label} to a value, then say yes.`);
  }, [req]);

  return (
    <Ctx.Provider value={{ confirm, prompt }}>
      {children}
      <D.Root open={!!req} onOpenChange={(open) => { if (!open) finish(false); }}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm" />
          <D.Content role="alertdialog" className="fixed left-1/2 top-1/2 z-[60] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border-strong bg-elevated p-5 shadow-2xl">
            <D.Title className="text-base font-semibold">{req?.o.title}</D.Title>
            <D.Description className="mt-1 text-sm text-muted">{req?.o.description ?? (req?.kind === "prompt" ? req.o.label : "Please confirm.")}</D.Description>
            <form className="mt-4 grid gap-4" onSubmit={(e) => { e.preventDefault(); finish(true); }}>
              {req?.kind === "prompt" && (
                <Field label={req.o.label}>
                  <Input autoFocus type={req.o.type ?? "text"} value={value} onChange={(e) => setValue(e.target.value)} />
                </Field>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" data-voice-confirm="no" onClick={() => finish(false)}>{req?.o.cancelLabel ?? "Cancel"}</Button>
                <Button type="submit" variant={req?.o.destructive ? "danger" : "default"} data-voice-confirm="yes">{req?.o.confirmLabel ?? "Confirm"}</Button>
              </div>
            </form>
          </D.Content>
        </D.Portal>
      </D.Root>
    </Ctx.Provider>
  );
}

export function useConfirm(): Api {
  const c = useContext(Ctx);
  if (!c) throw new Error("useConfirm outside ConfirmProvider");
  return c;
}
