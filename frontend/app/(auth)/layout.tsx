import { LexaOrb } from "@/components/layout/orb";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="ambient grid min-h-dvh lg:grid-cols-2">
      <div className="hidden flex-col justify-between border-r border-border p-10 lg:flex">
        <span className="text-sm font-semibold tracking-[0.2em]">LEXA</span>
        <div>
          <LexaOrb size={120} className="mb-8" />
          <h2 className="max-w-md text-3xl font-semibold leading-tight tracking-tight">
            Your personal <span className="text-gradient">AI operating system</span>.
          </h2>
          <p className="mt-3 max-w-md text-sm text-muted">
            One assistant. Nine specialist agents. Persistent memory, real integrations, and approvals before anything
            leaves your control.
          </p>
        </div>
        <p className="text-xs text-subtle">Actions that matter always wait for your approval.</p>
      </div>
      <div className="flex items-center justify-center p-6">{children}</div>
    </div>
  );
}
