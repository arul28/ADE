import { useEffect, useState } from "react";
import { ArrowsIn, WarningCircle } from "@phosphor-icons/react";
import type { AgentChatEvent } from "../../../shared/types";
import { formatCompactTokenCount, formatCompactDuration } from "../../../shared/contextCompaction";

export function ContextCompactDivider({ event, startedAt, onRetry }: {
  event: Extract<AgentChatEvent, { type: "context_compact" }>;
  startedAt?: string;
  onRetry?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const running = event.state === "started";
  const failed = event.state === "failed";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running]);
  const elapsed = startedAt ? Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000)) : 0;
  const pre = formatCompactTokenCount(event.preTokens);
  const post = formatCompactTokenCount(event.postTokens);
  const duration = formatCompactDuration(event.durationMs);
  const detail = event.failDetail;
  const failure = detail && /weekly limit/i.test(detail) ? "weekly limit" : detail && /quota|usage limit/i.test(detail) ? "usage limit" : undefined;
  const title = running
    ? `Compacting context${pre ? ` · ${pre} tokens` : ""}${elapsed >= 5 ? ` · ${elapsed} s` : ""}`
    : failed ? `Compaction failed${failure ? ` · ${failure}` : ""}`
    : `Context compacted${pre && post ? ` · ${pre} → ${post}` : ""}${duration ? ` · ${duration}` : ""}`;
  const trigger = event.trigger === "manual" ? "you asked" : event.trigger === "ade_fallback" ? "ADE (near limit)" : "automatic";
  const count = event.sessionCompactionCount;
  const suffix = count != null && (count % 100 < 11 || count % 100 > 13) ? ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[count % 10] ?? "th" : "th";
  const ordinal = `${count}${suffix}`;
  return <div className="my-1 text-[length:calc(var(--chat-font-size)*10/14)] text-fg/50" role="status">
    <div className="flex min-h-7 items-center justify-center gap-2">
      <span aria-hidden className={`h-px min-w-4 flex-1 bg-fg/10 ${running ? "motion-safe:animate-pulse" : ""}`} />
      {failed ? <WarningCircle size={12} className="text-[var(--color-warning)]" aria-hidden /> : <ArrowsIn size={12} aria-hidden />}
      <button type="button" disabled={!event.summary} onClick={() => setExpanded(!expanded)} title={failed ? detail : event.summary ? "Show compaction summary" : undefined}
        className={`min-w-0 text-left ${failed ? "text-[var(--color-warning)]" : ""}`} aria-expanded={event.summary ? expanded : undefined}>
        {title}
      </button>
      {!running && !failed ? <span className="text-fg/35">{trigger}{count && count >= 2 ? ` · ${ordinal} this chat` : ""}</span> : null}
      {failed && onRetry ? <button type="button" className="text-[var(--color-warning)] underline underline-offset-2" onClick={onRetry}>Retry</button> : null}
      <span aria-hidden className={`h-px min-w-4 flex-1 bg-fg/10 ${running ? "motion-safe:animate-pulse" : ""}`} />
    </div>
    {expanded && event.summary ? <div className="mx-auto max-w-[var(--chat-content-width,52rem)] whitespace-pre-wrap py-2 text-fg/65">{event.summary}</div> : null}
  </div>;
}
export default ContextCompactDivider;
