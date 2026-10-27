import { useEffect, useState } from "react";
import { ArrowRight, ArrowsInLineVertical, CaretDown, CircleNotch, WarningCircle } from "@phosphor-icons/react";
import type { AgentChatEvent } from "../../../shared/types";
import { compactionFailLabel, formatCompactTokenCount, formatCompactDuration } from "../../../shared/contextCompaction";
import { cn } from "../ui/cn";
import { useTicker } from "../../lib/ticker";

/** English ordinal suffix: 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st. */
function ordinalSuffix(n: number): "st" | "nd" | "rd" | "th" {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

/** A provider's summary can arrive wrapped in its own tags; the reader wants the words. */
function readableSummary(summary: string): string {
  return summary
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
    .replace(/<\/?summary>/gi, "")
    .trim();
}

const PILL_CLASS = "inline-flex h-7 min-w-0 shrink items-center gap-2 rounded-full border px-3 font-sans";
const NUMBER_CLASS = "font-mono tabular-nums";

/**
 * The line a compaction draws across the thread: everything above it was
 * replaced by a summary. One pill between two rules says what happened and how
 * much smaller the chat got; who asked, how long it took and the summary itself
 * stay one hover or one click away.
 */
export function ContextCompactDivider({ event, startedAt, onRetry }: {
  event: Extract<AgentChatEvent, { type: "context_compact" }>;
  startedAt?: string;
  onRetry?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const running = event.state === "started";
  const now = useTicker(1000, running);
  const failed = event.state === "failed";
  // One click per failure: the retry starts a new compaction, which replaces
  // this row as the latest one and removes its Retry.
  const [retrying, setRetrying] = useState(false);
  useEffect(() => setRetrying(false), [event.compactionId, event.state]);
  const elapsed = startedAt ? Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000)) : 0;
  const pre = formatCompactTokenCount(event.preTokens);
  const post = formatCompactTokenCount(event.postTokens);
  const duration = formatCompactDuration(event.durationMs);
  const detail = event.failDetail;
  const failure = detail && /weekly limit/i.test(detail)
    ? "weekly limit"
    : detail && /quota|usage limit/i.test(detail)
      ? "usage limit"
      : undefined;
  const failureSuffix = failure
    ? ` — ${failure}${event.accountLabel ? ` on ${event.accountLabel}` : ""}`
    : "";
  const trigger = event.trigger === "manual"
    ? "You asked"
    : event.trigger === "ade_fallback"
      ? "ADE compacted — the chat was almost full"
      : "Automatic";
  const count = event.sessionCompactionCount;
  const facts = [
    trigger,
    duration ? `took ${duration}` : null,
    count != null && count >= 2 ? `${count}${ordinalSuffix(count)} time in this chat` : null,
  ].filter(Boolean).join(" · ");
  const rule = <span aria-hidden className="h-px min-w-6 flex-1 bg-fg/[0.08]" />;
  const textSize = "text-[length:calc(var(--chat-font-size)*11.5/14)]";

  let pill: React.ReactNode;
  if (running) {
    pill = (
      <span className={cn(PILL_CLASS, textSize, "border-fg/[0.08] bg-fg/[0.03] text-fg/75")}>
        <CircleNotch size={12} weight="bold" className="shrink-0 text-accent motion-safe:animate-spin" aria-hidden />
        <span className="font-medium">Compacting</span>
        {pre ? <span className={cn(NUMBER_CLASS, "text-fg/45")}>{pre}</span> : null}
        {elapsed >= 5 ? <span className={cn(NUMBER_CLASS, "text-fg/35")}>{elapsed}s</span> : null}
      </span>
    );
  } else if (failed) {
    pill = (
      <span
        className={cn(PILL_CLASS, textSize, "border-[color-mix(in_srgb,var(--color-warning)_28%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_7%,transparent)] text-fg/80")}
        title={detail}
      >
        <WarningCircle size={12} weight="bold" className="shrink-0 text-[var(--color-warning)]" aria-hidden />
        <span className="min-w-0 truncate font-medium">{compactionFailLabel(event.failReason)}{failureSuffix}</span>
        {onRetry ? (
          <button
            type="button"
            className="-mr-1.5 inline-flex h-5 shrink-0 items-center rounded-full px-2 font-medium text-[var(--color-warning)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-warning)_14%,transparent)] disabled:opacity-50"
            disabled={retrying}
            onClick={() => { setRetrying(true); onRetry(); }}
          >
            Retry
          </button>
        ) : null}
      </span>
    );
  } else {
    const body = (
      <>
        <ArrowsInLineVertical size={13} weight="bold" className="shrink-0 text-fg/45" aria-hidden />
        <span className="font-medium">Compacted</span>
        {pre && post ? (
          <span className={cn(NUMBER_CLASS, "inline-flex items-center gap-1.5")}>
            <span className="text-fg/40">{pre}</span>
            <ArrowRight size={10} weight="bold" className="text-fg/30" aria-hidden />
            <span className="text-fg/85">{post}</span>
          </span>
        ) : null}
      </>
    );
    pill = event.summary ? (
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        title={`${facts} — show the summary`}
        className={cn(PILL_CLASS, textSize, "border-fg/[0.08] bg-fg/[0.03] text-fg/70 transition-colors hover:border-fg/[0.14] hover:bg-fg/[0.06] hover:text-fg/85")}
      >
        {body}
        <CaretDown size={10} weight="bold" className={cn("shrink-0 text-fg/35 transition-transform", expanded ? "rotate-180" : "")} aria-hidden />
      </button>
    ) : (
      <span title={facts} className={cn(PILL_CLASS, textSize, "border-fg/[0.08] bg-fg/[0.03] text-fg/70")}>{body}</span>
    );
  }

  return (
    <div className="my-2" role="status" data-compaction-state={event.state ?? "completed"}>
      <div className="flex min-h-7 items-center gap-3">
        {rule}
        {pill}
        {rule}
      </div>
      {expanded && event.summary ? (
        <section className="kit-card mx-auto mt-2 max-w-[var(--chat-content-width,52rem)]">
          <header className="kit-card-head">
            <ArrowsInLineVertical size={14} aria-hidden />
            Summary the chat continues from
          </header>
          <div className="kit-card-body max-h-80 overflow-y-auto whitespace-pre-wrap text-[length:calc(var(--chat-font-size)*12.5/14)] leading-relaxed text-fg/70">
            {readableSummary(event.summary)}
          </div>
        </section>
      ) : null}
    </div>
  );
}
