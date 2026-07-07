import { CircleNotch, Check } from "@phosphor-icons/react";
import { motion } from "motion/react";
import type { AgentChatEvent } from "../../../shared/types";
import {
  buildContextCompactMetadataChips,
  normalizeContextCompactEvent,
  resolveProviderTint,
} from "../../../shared/contextCompaction";
import { cn } from "../ui/cn";

type ContextCompactDividerProps = {
  event: Extract<AgentChatEvent, { type: "context_compact" }>;
};

function completedTitle(sessionCompactionCount?: number): string {
  if (typeof sessionCompactionCount === "number" && sessionCompactionCount >= 2) {
    return `Context compacted (${sessionCompactionCount}×)`;
  }
  return "Context compacted";
}

export function ContextCompactDivider({ event }: ContextCompactDividerProps) {
  const compact = normalizeContextCompactEvent(event);
  if (!compact) return null;

  const isInProgress = compact.state === "started";
  const tint = resolveProviderTint(compact.provider);
  const metadataChips = isInProgress ? [] : buildContextCompactMetadataChips(compact);

  return (
    <motion.div
      layout
      className="my-1 flex items-center gap-3 py-1"
      initial={false}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.28, ease: "easeOut" }}
      aria-label={isInProgress ? "Compacting context" : completedTitle(compact.sessionCompactionCount)}
    >
      <span
        className="h-px min-w-8 flex-1 bg-gradient-to-r from-transparent via-amber-400/20 to-transparent"
        aria-hidden
      />
      <motion.div
        layout
        className={cn(
          "inline-flex max-w-[min(100%,34rem)] flex-col items-center gap-1.5 rounded-full px-3 py-1.5 ring-1 ring-inset",
          "bg-amber-500/[0.08] text-amber-100/85",
          tint.ring,
          tint.border,
        )}
        transition={{ duration: 0.28, ease: "easeOut" }}
      >
        <div className="inline-flex items-center gap-2">
          {isInProgress ? (
            <CircleNotch size={12} weight="bold" className="animate-spin text-amber-200/80" aria-hidden />
          ) : (
            <Check size={12} weight="bold" className="text-amber-200/90" aria-hidden />
          )}
          <span className="text-[length:calc(var(--chat-font-size)*10/14)] font-semibold tracking-[0.02em]">
            {isInProgress ? "Compacting context…" : completedTitle(compact.sessionCompactionCount)}
          </span>
        </div>
        {metadataChips.length > 0 ? (
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {metadataChips.map((chip) => (
              <span
                key={chip.key}
                className="rounded-full border border-amber-300/15 bg-amber-500/10 px-2 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*9/14)] text-amber-100/70"
              >
                {chip.label}
              </span>
            ))}
          </div>
        ) : null}
      </motion.div>
      <span
        className="h-px min-w-8 flex-1 bg-gradient-to-l from-transparent via-amber-400/20 to-transparent"
        aria-hidden
      />
    </motion.div>
  );
}

export default ContextCompactDivider;
