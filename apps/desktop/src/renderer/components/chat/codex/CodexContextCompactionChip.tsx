import type { AgentChatEvent } from "../../../../shared/types";
import { cn } from "../../ui/cn";

type CompactionEvent = Extract<AgentChatEvent, { type: "codex_context_compaction" }>;

type CodexContextCompactionChipProps = {
  event: CompactionEvent;
  timestamp?: string;
};

function formatClock(timestamp: string | undefined): string | null {
  if (!timestamp) return null;
  try {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return null;
  }
}

export function CodexContextCompactionChip({ event, timestamp }: CodexContextCompactionChipProps) {
  const isStarted = event.state === "started";
  const clock = formatClock(timestamp);
  const verb = isStarted ? "Compacting context" : "Context compacted";
  const tooltip = `${verb}${clock ? ` at ${clock}` : ""} · trigger: ${event.trigger}`;

  return (
    <div className="flex justify-end">
      <span
        className={cn(
          "inline-flex select-none items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[length:calc(var(--chat-font-size)*10/14)] tracking-tight ring-1 ring-inset",
          isStarted
            ? "bg-amber-500/8 text-amber-200/70 ring-amber-400/20"
            : "bg-amber-500/12 text-amber-100/85 ring-amber-400/25",
        )}
        title={tooltip}
      >
        <span aria-hidden className="text-[12px] leading-none">{isStarted ? "⟳" : "✓"}</span>
        <span>{isStarted ? "compacting" : "compacted"}</span>
      </span>
    </div>
  );
}

export default CodexContextCompactionChip;
