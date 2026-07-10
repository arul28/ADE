import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, CaretDown, CaretRight, CheckCircle, Circle, XCircle } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { formatSubagentDurationMs } from "../../lib/format";
import { ChatSubagentGlyph, chatSubagentColor } from "./chatSubagentIdentity";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";
import type {
  BackgroundFinishChipRenderEvent,
  SubagentResultCardRenderEvent,
  SubagentSpawnAnchorRenderEvent,
} from "./chatTranscriptRows";

// Two rows per real subagent — a spawn card anchored where it started, and a
// result card at the settle position. Both inherit the chat accent
// (`--chat-accent`) and mirror the calm styling idiom of AgentCliAuthCard
// (soft-tinted card, no red error blocks). Background shell commands render a
// single compact finish chip instead of cards.

function liveElapsedText(startedAt: string, nowMs: number): string | null {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  return formatSubagentDurationMs(Math.max(0, nowMs - start));
}

function glyphStatusFor(status: SubagentSpawnAnchorRenderEvent["status"]): ChatSubagentSnapshot["status"] {
  return status;
}

/**
 * Spawn card — one row anchored where the agent started. Shows identicon/color,
 * task description title, agent-type + background chips, and ONE single-line
 * live status line (`running · <activity> · <N> tools · <elapsed>`). The elapsed
 * ticks at render-time only while running; when the agent ends the status flips
 * and a subtle "jump to result ↓" affordance appears.
 */
export function SubagentSpawnCard({
  event,
  onJumpToResult,
}: {
  event: SubagentSpawnAnchorRenderEvent;
  onJumpToResult?: () => void;
}) {
  const isRunning = event.status === "running";
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [isRunning]);

  const color = chatSubagentColor(event.agentKey);
  const elapsed = isRunning
    ? liveElapsedText(event.startedAt, nowMs)
    : formatSubagentDurationMs(
        event.endedAt ? Math.max(0, Date.parse(event.endedAt) - Date.parse(event.startedAt)) : null,
      );

  const activity = event.statusLine?.trim() || event.lastToolName?.trim() || null;
  const statusWord = isRunning
    ? "running"
    : event.status === "completed"
      ? "done"
      : event.status === "failed"
        ? "failed"
        : "stopped";
  const liveParts = [
    statusWord,
    activity,
    typeof event.toolCount === "number" && event.toolCount > 0
      ? `${event.toolCount} tool${event.toolCount === 1 ? "" : "s"}`
      : null,
    elapsed,
  ].filter((part): part is string => Boolean(part));

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[calc(var(--chat-radius-card)-6px)] border transition-colors",
        "border-[color:color-mix(in_srgb,var(--chat-accent)_16%,transparent)]",
        "bg-[color:color-mix(in_srgb,var(--chat-accent)_6%,transparent)]",
      )}
    >
      <div className="flex items-start gap-3 px-3.5 py-3">
        <span className="mt-0.5 shrink-0">
          <ChatSubagentGlyph id={event.agentKey} color={color} status={glyphStatusFor(event.status)} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="min-w-0 truncate font-sans text-[length:calc(var(--chat-font-size)*12/14)] font-semibold text-fg/82">
              {event.description || "Subagent task"}
            </span>
            {event.agentType?.trim() && event.agentType.trim() !== "background" ? (
              <span className="shrink-0 rounded-md border border-[color:color-mix(in_srgb,var(--chat-accent)_18%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_7%,transparent)] px-1.5 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*8/14)] font-bold uppercase tracking-[0.14em] text-[color:var(--chat-accent)]">
                {event.agentType.trim()}
              </span>
            ) : null}
            {event.background ? (
              <span className="shrink-0 rounded-md border border-cyan-300/15 bg-cyan-300/[0.06] px-1.5 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*8/14)] font-bold uppercase tracking-[0.14em] text-cyan-200/70">
                background
              </span>
            ) : null}
          </div>
          {liveParts.length ? (
            <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap font-mono text-[length:calc(var(--chat-font-size)*10/14)] text-fg/45">
              <span className="min-w-0 truncate">{liveParts.join(" · ")}</span>
            </div>
          ) : null}
          {!isRunning && onJumpToResult ? (
            <button
              type="button"
              onClick={onJumpToResult}
              className="mt-1.5 inline-flex items-center gap-1 font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-fg/38 transition-colors hover:text-[color:var(--chat-accent)]"
              title="Jump to result"
            >
              jump to result
              <ArrowDown size={11} weight="bold" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Result card at the chronological position where the agent ended. Status +
 * duration, a ~2-line preview of the final report, "View transcript", and a
 * "↑ jump to start" affordance. Warm terminal states: stopped → amber tone,
 * failed → reason chip + a `Details` disclosure with the error text (never a red
 * error block).
 */
export function SubagentResultCard({
  event,
  onViewTranscript,
  onJumpToStart,
}: {
  event: SubagentResultCardRenderEvent;
  onViewTranscript?: () => void;
  onJumpToStart?: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const isSuccess = event.status === "completed";
  const isStopped = event.status === "stopped";
  const isFailed = event.status === "failed";
  const duration = formatSubagentDurationMs(event.durationMs);

  const toneCard = isSuccess
    ? "border-[color:color-mix(in_srgb,var(--chat-accent)_14%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_5%,transparent)]"
    : isStopped
      ? "border-amber-300/14 bg-amber-300/[0.045]"
      : "border-amber-400/16 bg-amber-400/[0.05]";
  const statusLabel = isSuccess ? "Finished" : isStopped ? "stopped — interrupted" : "Failed";
  const statusColor = isSuccess ? "text-fg/70" : "text-amber-100/85";

  return (
    <div className={cn("overflow-hidden rounded-[calc(var(--chat-radius-card)-6px)] border transition-colors", toneCard)}>
      <div className="flex items-start gap-3 px-3.5 py-3">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
          {isSuccess ? (
            <CheckCircle size={16} weight="bold" className="text-[color:var(--chat-accent)]" />
          ) : isStopped ? (
            <Circle size={14} weight="fill" className="text-amber-300/80" />
          ) : (
            <XCircle size={16} weight="bold" className="text-amber-300/85" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("font-sans text-[length:calc(var(--chat-font-size)*11.5/14)] font-semibold", statusColor)}>
              {statusLabel}
            </span>
            {duration ? (
              <span className="font-mono text-[length:calc(var(--chat-font-size)*9.5/14)] tabular-nums text-fg/38">{duration}</span>
            ) : null}
            {isFailed && event.error?.trim() ? (
              <span className="rounded-md border border-amber-400/18 bg-amber-400/[0.07] px-1.5 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*8/14)] font-bold uppercase tracking-[0.12em] text-amber-100/75">
                error
              </span>
            ) : null}
          </div>
          {event.summaryPreview?.trim() ? (
            <div className="mt-1 line-clamp-2 text-[length:calc(var(--chat-font-size)*11/14)] leading-relaxed text-fg/66">
              {event.summaryPreview.trim()}
            </div>
          ) : null}
          {isFailed && event.error?.trim() ? (
            <button
              type="button"
              onClick={() => setDetailsOpen((value) => !value)}
              aria-expanded={detailsOpen}
              className="mt-1.5 inline-flex items-center gap-1 font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-fg/45 transition-colors hover:text-amber-100/80"
            >
              {detailsOpen ? <CaretDown size={11} weight="bold" aria-hidden /> : <CaretRight size={11} weight="bold" aria-hidden />}
              Details
            </button>
          ) : null}
          {isFailed && detailsOpen && event.error?.trim() ? (
            <div className="mt-1.5 whitespace-pre-wrap break-words rounded-md border border-amber-400/12 bg-black/20 px-2.5 py-2 font-mono text-[length:calc(var(--chat-font-size)*10/14)] leading-relaxed text-fg/62">
              {event.error.trim()}
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            {onViewTranscript ? (
              <button
                type="button"
                onClick={onViewTranscript}
                className="inline-flex items-center gap-1 font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-fg/45 transition-colors hover:text-[color:var(--chat-accent)]"
                title="View transcript"
              >
                View transcript
              </button>
            ) : null}
            {onJumpToStart ? (
              <button
                type="button"
                onClick={onJumpToStart}
                className="inline-flex items-center gap-1 font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-fg/38 transition-colors hover:text-[color:var(--chat-accent)]"
                title="Jump to start"
              >
                <ArrowUp size={11} weight="bold" aria-hidden />
                jump to start
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Compact single-line finish chip for a backgrounded shell command:
 * `✓ background command finished · exit <code?> · <duration>` (✗ variant for
 * failure/stopped). Calm styling, never a red error block.
 */
export function BackgroundFinishChip({ event }: { event: BackgroundFinishChipRenderEvent }) {
  const ok = event.status === "completed";
  const duration = formatSubagentDurationMs(event.durationMs);
  const parts = [
    "background command finished",
    typeof event.exitCode === "number" ? `exit ${event.exitCode}` : null,
    duration,
  ].filter((part): part is string => Boolean(part));

  return (
    <div
      className={cn(
        "inline-flex max-w-full items-center gap-2 overflow-hidden rounded-md border px-2.5 py-1 font-mono text-[length:calc(var(--chat-font-size)*10/14)]",
        ok
          ? "border-white/[0.07] bg-white/[0.025] text-fg/55"
          : "border-amber-300/14 bg-amber-300/[0.05] text-amber-100/75",
      )}
      title={event.label}
    >
      <span aria-hidden className="shrink-0">{ok ? "✓" : "✗"}</span>
      <span className="min-w-0 truncate">
        {parts.join(" · ")}
        {event.label ? <span className="ml-2 text-fg/38">· {event.label}</span> : null}
      </span>
    </div>
  );
}
