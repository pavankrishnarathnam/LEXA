import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/misc";
import { AgentForm } from "@/components/agents/agent-form";

export const metadata = { title: "Create agent" };
export default function NewAgent() {
  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/agents" className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"><ArrowLeft className="size-3" />Agents</Link>
      <PageHeader title="Create a custom agent" description="Registered instantly — LEXA CORE can delegate to it without code changes." />
      <AgentForm />
    </div>
  );
}
