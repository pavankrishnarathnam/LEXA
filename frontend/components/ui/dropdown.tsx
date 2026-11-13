"use client";
import * as React from "react";
import * as M from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";

export const Dropdown = M.Root;
export const DropdownTrigger = M.Trigger;
export function DropdownContent({ className, ...p }: React.ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content sideOffset={6} className={cn("z-50 min-w-48 rounded-lg border border-border-strong bg-elevated p-1 shadow-xl", className)} {...p} />
    </M.Portal>
  );
}
export function DropdownItem({ className, ...p }: React.ComponentProps<typeof M.Item>) {
  return <M.Item className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-2 [&_svg]:size-4 [&_svg]:text-muted", className)} {...p} />;
}
export const DropdownSeparator = () => <M.Separator className="my-1 h-px bg-border" />;
export const DropdownLabel = ({ className, ...p }: React.ComponentProps<typeof M.Label>) =>
  <M.Label className={cn("px-2 py-1 text-[11px] font-medium text-subtle", className)} {...p} />;
