import { Bot, Brain, Briefcase, Calendar, Code2, Mail, Search, Shield, Sparkles, Wallet, Workflow } from "lucide-react";

const ICONS: Record<string, React.ElementType> = {
  briefcase: Briefcase, mail: Mail, search: Search, code: Code2, wallet: Wallet, calendar: Calendar,
  workflow: Workflow, shield: Shield, brain: Brain, bot: Bot, sparkles: Sparkles,
};
export const AGENT_ICON_NAMES = Object.keys(ICONS);

export function AgentIcon({ name, className }: { name?: string | null; className?: string }) {
  const I = ICONS[name || "bot"] ?? Bot;
  return <I className={className} />;
}
