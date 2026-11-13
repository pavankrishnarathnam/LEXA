"use client";
import * as React from "react";
import * as T from "@radix-ui/react-tooltip";

export const TooltipProvider = T.Provider;
export function Tooltip({ content, children, side = "right" }: { content: string; children: React.ReactNode; side?: "top" | "right" | "bottom" | "left" }) {
  return (
    <T.Root delayDuration={250}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={8} className="z-50 rounded-md border border-border-strong bg-elevated px-2 py-1 text-xs shadow-lg">
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
