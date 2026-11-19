import type { LucideIcon } from "lucide-react";
import { Activity, Bot, Brain, Briefcase, Code2, Home, Mail, MessageSquareText, Plug, Search, Settings, TrendingUp, Wallet, Workflow } from "lucide-react";

export interface NavItem { href: string; label: string; icon: LucideIcon }

export const NAV: { group: string; items: NavItem[] }[] = [
  { group: "Core", items: [
    { href: "/", label: "Command Center", icon: Home },
    { href: "/assistant", label: "Assistant", icon: MessageSquareText },
    { href: "/tasks", label: "Tasks", icon: Activity },
    { href: "/agents", label: "Agents", icon: Bot },
  ] },
  { group: "Workspaces", items: [
    { href: "/career", label: "Career", icon: Briefcase },
    { href: "/communication", label: "Communication", icon: Mail },
    { href: "/research", label: "Research", icon: Search },
    { href: "/developer", label: "Developer", icon: Code2 },
    { href: "/finance", label: "Finance", icon: Wallet },
    { href: "/trading", label: "Trading", icon: TrendingUp },
  ] },
  { group: "System", items: [
    { href: "/automations", label: "Automations", icon: Workflow },
    { href: "/memory", label: "Memory", icon: Brain },
    { href: "/integrations", label: "Integrations", icon: Plug },
    { href: "/settings", label: "Settings", icon: Settings },
  ] },
];

export const ALL_NAV: NavItem[] = NAV.flatMap((g) => g.items);
