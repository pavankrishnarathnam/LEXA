"use client";
import * as React from "react";
import * as T from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

export const Tabs = T.Root;
export function TabsList({ className, ...p }: React.ComponentProps<typeof T.List>) {
  return <T.List className={cn("inline-flex h-9 items-center gap-1 rounded-lg border border-border bg-surface-2/60 p-1 overflow-x-auto max-w-full scrollbar-thin", className)} {...p} />;
}
export function TabsTrigger({ className, ...p }: React.ComponentProps<typeof T.Trigger>) {
  return <T.Trigger className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-muted transition data-[state=active]:bg-surface data-[state=active]:text-foreground data-[state=active]:shadow-sm hover:text-foreground whitespace-nowrap", className)} {...p} />;
}
export const TabsContent = ({ className, ...p }: React.ComponentProps<typeof T.Content>) =>
  <T.Content className={cn("mt-4 outline-none", className)} {...p} />;
