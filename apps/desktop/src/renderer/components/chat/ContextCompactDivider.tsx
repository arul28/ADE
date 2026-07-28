import { CircleNotch, Check } from "@phosphor-icons/react";
import { motion } from "motion/react";
import type { AgentChatEvent } from "../../../shared/types";
import {
  normalizeContextCompactEvent,
  resolveProviderTint,
} from "../../../shared/contextCompaction";
import { cn } from "../ui/cn";

type ContextCompactDividerProps = {
  event: Extract<AgentChatEvent, { type: "context_compact" }>;
};

function completedTitle(_sessionCompactionCount?: number, fallback?: boolean): string {
  return fallback ? "Context compacted (fallback)" : "Context compacted";
}

export function ContextCompactDivider({ event }: ContextCompactDividerProps) {
  const compact = normalizeContextCompactEvent(event);
  if (!compact) return null;

  const isInProgress = compact.state === "started";
  // ADE only steps in when the SDK's own >90% auto-compaction demonstrably did
  // not run; label it distinctly so the accompanying notice doesn't read as a
  // duplicate of a normal compaction.
  const isFallback = compact.trigger === "ade_fallback";
  const tint = resolveProviderTint(compact.provider);

  return (
    <motion.div
      layout
      className="my-1 flex items-center gap-3 py-1"
      initial={false}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.28, ease: "easeOut" }}
      aria-label={isInProgress ? "Compacting context" : completedTitle(compact.sessionCompactionCount, isFallback)}
    >
      <span
        className="h-px min-w-8 flex-1 bg-gradient-to-r from-transparent via-amber-400/20 to-transparent"
        aria-hidden
      />
      <motion.div
        layout
        className={cn(
          // One transcript width for every row — see `--chat-content-width`.
          "inline-flex max-w-[var(--chat-content-width,52rem)] items-center rounded-full px-3 py-1.5 ring-1 ring-inset",
          "bg-amber-500/[0.08] text-amber-100/85",
          tint.ring,
          tint.border,
        )}
        transition={{ duration: 0.28, ease: "easeOut" }}
      >
        {isInProgress ? (
          <CircleNotch size={12} weight="bold" className="animate-spin text-amber-200/80" aria-hidden />
        ) : (
          <Check size={12} weight="bold" className="text-amber-200/90" aria-hidden />
        )}
        <span className="ml-2 whitespace-nowrap text-[length:calc(var(--chat-font-size)*10/14)] font-semibold tracking-[0.02em]">
          {isInProgress
            ? (isFallback ? "Compacting context (fallback)…" : "Compacting context…")
            : completedTitle(compact.sessionCompactionCount, isFallback)}
        </span>
      </motion.div>
      <span
        className="h-px min-w-8 flex-1 bg-gradient-to-l from-transparent via-amber-400/20 to-transparent"
        aria-hidden
      />
    </motion.div>
  );
}

export default ContextCompactDivider;
