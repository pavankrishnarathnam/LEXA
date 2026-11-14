"use client";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { HELP_SECTIONS } from "@/lib/voice/commands";
import { useVoice } from "./voice-provider";

const SHORTCUTS: [string, string][] = [
  ["Alt + V", "Turn voice mode on or off"],
  ["Esc", "Stop LEXA talking"],
  ["Ctrl/⌘ + K", "Command menu"],
];

export function VoiceHelp() {
  const { helpOpen, setHelpOpen } = useVoice();
  return (
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogContent title="Talking to LEXA" description="Everything in LEXA works by voice. You never need a mouse." className="max-w-xl">
        <div className="space-y-4 text-sm">
          {HELP_SECTIONS.map((s) => (
            <section key={s.title}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{s.title}</h3>
              <ul className="mt-1 space-y-1">{s.items.map((i) => <li key={i}>{i}</li>)}</ul>
            </section>
          ))}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Keyboard</h3>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              {SHORTCUTS.map(([k, d]) => (<div key={k} className="contents"><dt><kbd className="rounded border border-border px-1.5 py-0.5 text-xs">{k}</kbd></dt><dd>{d}</dd></div>))}
            </dl>
          </section>
          <p className="text-xs text-muted">
            Approvals are always read to you in full before you can approve them. High-risk actions need you to say “approve” twice.
            “Never mind” and “cancel” never approve or reject anything.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
