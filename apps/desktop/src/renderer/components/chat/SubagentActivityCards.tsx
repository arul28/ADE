import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, CaretDown, CaretRight, CheckCircle, Circle, Stop, XCircle } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { formatSubagentDurationMs } from "../../lib/format";
import { ChatSubagentGlyph, chatSubagentColor } from "./chatSubagentIdentity";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";
import type { AgentChatSpawnKind } from "../../../shared/types";
import { navigateToSpawnedChat } from "./spawnNavigation";
import type {
  BackgroundFinishChipRenderEvent,
  SubagentResultCardRenderEvent,
  SubagentSpawnAnchorRenderEvent,
  SubagentStoppedGroupEvent,
} from "./chatTranscriptRows";

// Re-exported for existing importers that reach it through this module.
export { navigateToSpawnedChat };

/**
 * Type-tinted accent for a spawned ADE chat card. subagent = violet (the chat's
 * `--color-accent`); peer = steel/neutral slate. `none`/null spawns keep the
 * default `--chat-accent` styling and show no type chip.
 */
export function spawnTypeAccent(
  spawnKind: AgentChatSpawnKind | null | undefined,
): { label: string; cardClass: string; chipClass: string } | null {
  if (spawnKind === "subagent") {
    return {
      label: "SUBAGENT",
      cardClass: "border-violet-400/22 bg-violet-400/[0.06] hover:border-violet-300/32",
      chipClass: "border-violet-300/25 bg-violet-400/10 text-violet-200/85",
    };
  }
  if (spawnKind === "peer") {
    return {
      label: "PEER",
      cardClass: "border-slate-400/18 bg-slate-400/[0.06] hover:border-slate-300/28",
      chipClass: "border-slate-300/20 bg-slate-400/10 text-slate-300/75",
    };
  }
  return null;
}

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
  laneId,
}: {
  event: SubagentSpawnAnchorRenderEvent;
  onJumpToResult?: () => void;
  /** Lane of the spawner, forwarded to the navigation event when known. */
  laneId?: string | null;
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

  // Suppress activity text that just echoes the task title (e.g. title
  // "Run affected suites" + status "done · Run affected suites · 27s").
  const title = (event.description || "").trim();
  const rawActivity = event.statusLine?.trim() || event.lastToolName?.trim() || null;
  const activity =
    rawActivity && title && title.toLowerCase().includes(rawActivity.toLowerCase()) ? null : rawActivity;
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

  // A spawned ADE chat (peer/subagent) carries a child session id → the whole
  // card navigates. Runtime-native subagents (no child id) keep the passive
  // card + nested "jump to result" affordance.
  const childSessionId = event.childSessionId?.trim() || null;
  const navigable = Boolean(childSessionId);
  const typeAccent = spawnTypeAccent(event.spawnKind);
  const resultSummary = !isRunning ? event.resultSummary?.trim() || null : null;

  const cardShell = cn(
    "w-full max-w-[min(100%,70ch)] overflow-hidden rounded-[calc(var(--chat-radius-card)-6px)] border transition-colors",
    typeAccent
      ? typeAccent.cardClass
      : "border-[color:color-mix(in_srgb,var(--chat-accent)_16%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_6%,transparent)]",
  );

  const inner = (
    <>
      <span className="flex h-[27px] w-[27px] shrink-0 items-center justify-center self-center">
        <span className="scale-[1.5]">
          <ChatSubagentGlyph id={event.agentKey} color={color} status={glyphStatusFor(event.status)} />
        </span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate font-sans text-[length:calc(var(--chat-font-size)*12/14)] font-semibold text-fg/82">
            {event.description || "Subagent task"}
          </span>
          {typeAccent ? (
            <span className={cn("shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*8/14)] font-bold uppercase tracking-[0.14em]", typeAccent.chipClass)}>
              {typeAccent.label}
            </span>
          ) : null}
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
        {resultSummary ? (
          <div className="mt-1 line-clamp-2 text-[length:calc(var(--chat-font-size)*11/14)] leading-relaxed text-fg/62">
            {resultSummary}
          </div>
        ) : null}
      </div>
      {navigable ? (
        <span className="inline-flex shrink-0 items-center gap-0.5 self-center whitespace-nowrap font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-fg/40">
          open
          <CaretRight size={11} weight="bold" aria-hidden />
        </span>
      ) : !isRunning && onJumpToResult ? (
        <button
          type="button"
          onClick={onJumpToResult}
          className="inline-flex shrink-0 items-center gap-1 self-center whitespace-nowrap font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-fg/38 transition-colors hover:text-[color:var(--chat-accent)]"
          title="Jump to result"
        >
          jump to result
          <ArrowDown size={11} weight="bold" aria-hidden />
        </button>
      ) : null}
    </>
  );

  if (navigable && childSessionId) {
    return (
      <button
        type="button"
        onClick={() => navigateToSpawnedChat(childSessionId, laneId ?? null)}
        className={cn(cardShell, "text-left")}
        title="Open the spawned chat"
      >
        <div className="flex items-center gap-3 px-3.5 py-3">{inner}</div>
      </button>
    );
  }

  return (
    <div className={cardShell}>
      <div className="flex items-center gap-3 px-3.5 py-3">{inner}</div>
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
    <div className={cn("w-full max-w-[min(100%,70ch)] overflow-hidden rounded-[calc(var(--chat-radius-card)-6px)] border transition-colors", toneCard)}>
      <div className="flex items-center gap-3 px-3.5 py-3">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center self-center">
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
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 self-center">
          {onViewTranscript ? (
            <button
              type="button"
              onClick={onViewTranscript}
              className="inline-flex items-center gap-1 whitespace-nowrap font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-fg/45 transition-colors hover:text-[color:var(--chat-accent)]"
              title="View transcript"
            >
              View transcript
            </button>
          ) : null}
          {onJumpToStart ? (
            <button
              type="button"
              onClick={onJumpToStart}
              className="inline-flex items-center gap-1 whitespace-nowrap font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-fg/38 transition-colors hover:text-[color:var(--chat-accent)]"
              title="Jump to start"
            >
              <ArrowUp size={11} weight="bold" aria-hidden />
              jump to start
            </button>
          ) : null}
        </div>
      </div>
      {isFailed && event.error?.trim() ? (
        <div className="px-3.5 pb-3">
          <button
            type="button"
            onClick={() => setDetailsOpen((value) => !value)}
            aria-expanded={detailsOpen}
            className="inline-flex items-center gap-1 font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-fg/45 transition-colors hover:text-amber-100/80"
          >
            {detailsOpen ? <CaretDown size={11} weight="bold" aria-hidden /> : <CaretRight size={11} weight="bold" aria-hidden />}
            Details
          </button>
          {detailsOpen ? (
            <div className="mt-1.5 whitespace-pre-wrap break-words rounded-md border border-amber-400/12 bg-black/20 px-2.5 py-2 font-mono text-[length:calc(var(--chat-font-size)*10/14)] leading-relaxed text-fg/62">
              {event.error.trim()}
            </div>
          ) : null}
        </div>
      ) : null}
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
        "inline-flex max-w-[min(100%,70ch)] items-center gap-2 overflow-hidden rounded-md border px-2.5 py-1 font-mono text-[length:calc(var(--chat-font-size)*10/14)]",
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

/**
 * One calm card standing in for a run of subagents that were all stopped by a
 * single user interrupt — instead of a wall of identical "stopped — interrupted"
 * result cards. Collapsed by default: a single amber line reading "N agents
 * stopped when you interrupted" with a disclosure that lists each agent and a
 * "jump to start" link (reusing the same row-key scroll machinery as the result
 * cards). Never a red error block; inherits `--chat-accent` for the hover.
 */
export function SubagentStoppedGroupCard({
  event,
  onJumpToStart,
}: {
  event: SubagentStoppedGroupEvent;
  onJumpToStart?: (rowKey: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = event.count;
  const headline = `${count} ${count === 1 ? "agent" : "agents"} stopped when you interrupted`;

  return (
    <div
      className={cn(
        "w-full max-w-[min(100%,70ch)] overflow-hidden rounded-[calc(var(--chat-radius-card)-6px)] border transition-colors",
        "border-amber-300/14 bg-amber-300/[0.045]",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-amber-300/[0.05]"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center self-center">
          <Stop size={13} weight="fill" className="text-amber-300/80" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 font-sans text-[length:calc(var(--chat-font-size)*11.5/14)] font-semibold text-amber-100/85">
          {headline}
        </span>
        <span className="shrink-0 self-center text-amber-100/55">
          {expanded ? <CaretDown size={12} weight="bold" aria-hidden /> : <CaretRight size={12} weight="bold" aria-hidden />}
        </span>
      </button>
      {expanded ? (
        <ul className="flex flex-col border-t border-amber-300/10 px-3.5 py-1.5">
          {event.items.map((item) => (
            <li key={item.agentKey} className="flex min-w-0 items-center gap-2 py-1">
              <span className="min-w-0 flex-1 truncate font-sans text-[length:calc(var(--chat-font-size)*11/14)] text-fg/66">
                {item.title}
              </span>
              {onJumpToStart ? (
                <button
                  type="button"
                  onClick={() => onJumpToStart(item.jumpToStartRowKey)}
                  className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-fg/38 transition-colors hover:text-[color:var(--chat-accent)]"
                  title="Jump to start"
                >
                  <ArrowUp size={11} weight="bold" aria-hidden />
                  jump to start
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
