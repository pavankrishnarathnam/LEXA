"use client";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

/** LEXA's visual presence. Reacts to state (idle/listening/thinking/speaking) and live mic level. */
export function LexaOrb({ state = "idle", level = 0, size = 96, className }:
  { state?: "idle" | "listening" | "processing" | "speaking" | "thinking"; level?: number; size?: number; className?: string }) {
  const reduce = useReducedMotion();
  const active = state !== "idle";
  const scale = state === "listening" ? 1 + Math.min(level * 1.6, 0.35) : 1;
  return (
    <div className={cn("relative grid place-items-center", className)} style={{ width: size, height: size }}
      role="img" aria-label={`LEXA is ${state}`}>
      <motion.div className="absolute inset-0 rounded-full bg-grad opacity-30 blur-2xl"
        animate={reduce ? {} : { scale: active ? [1, 1.25, 1] : [1, 1.08, 1] }}
        transition={{ duration: active ? 1.4 : 4, repeat: Infinity, ease: "easeInOut" }} />
      <motion.div className="absolute inset-[14%] rounded-full"
        style={{ background: "conic-gradient(from 0deg, var(--primary), var(--accent), #b39dff, var(--primary))" }}
        animate={reduce ? {} : { rotate: 360 }}
        transition={{ duration: state === "processing" || state === "thinking" ? 2 : 12, repeat: Infinity, ease: "linear" }} />
      <motion.div className="absolute inset-[20%] rounded-full bg-background"
        animate={{ scale }} transition={{ type: "spring", stiffness: 300, damping: 20 }} />
      <motion.div className="absolute inset-[32%] rounded-full bg-grad"
        animate={reduce ? {} : state === "speaking" ? { scale: [1, 1.18, 0.95, 1.1, 1] } : { scale: [1, 1.05, 1] }}
        transition={{ duration: state === "speaking" ? 0.9 : 3, repeat: Infinity }} />
    </div>
  );
}

export function LexaMark({ className }: { className?: string }) {
  return (
    <span className={cn("relative grid size-7 place-items-center rounded-lg bg-[#0a0a0f] ring-1 ring-white/10", className)}>
      <span className="size-4 rounded-full border-[2.5px] border-transparent [background:linear-gradient(#0a0a0f,#0a0a0f)_padding-box,var(--grad)_border-box]" />
      <span className="absolute size-1.5 rounded-full bg-grad" />
    </span>
  );
}
