import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, CaretDown, CaretRight, Check, Gear, Stop, X } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { formatSubagentDurationMs } from "../../lib/format";
import { ChatSubagentGlyph, chatSubagentColor } from "./chatSubagentIdentity";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";
import type { AgentChatSpawnKind } from "../../../shared/types";
import { navigateToSpawnedChat } from "./spawnNavigation";
import {
  ChatCard,
  ChatCardDetail,
  ChatCardDetailRow,
  ChatCardRow,
  ChatCardTitle,
  firstMeaningfulSummary,
  humanizeAgentIdentity,
} from "./chatCardPrimitives";
import { formatContextTokens } from "./usage/contextUsageModel";
import type {
  BackgroundJobLineRenderEvent,
  SubagentResultCardRenderEvent,
  SubagentSpawnAnchorRenderEvent,
  SubagentStoppedGroupEvent,
} from "./chatTranscriptRows";

// Re-exported for existing importers that reach it through this module.
export { navigateToSpawnedChat };

/**
 * Type-tinted accent for a spawned ADE chat card. subagent = violet (the chat's
 * `--color-accent`); peer = steel/neutral slate. Missing legacy metadata keeps
 * the default `--chat-accent` styling and shows no type chip.
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
// (soft-tinted card, no red error blocks). Background shell commands get no
// cards at all — just the single `BackgroundJobLine` one-liner below.

/**
 * Live elapsed since a start timestamp, ticking once a second while `running`.
 * Shared by the spawn card and the background-job line — the one live-duration
 * ticker in this file.
 *
 * Anchored to the real start timestamp rather than to mount time, so scrolling
 * the row out of the virtualizer and back keeps the true elapsed instead of
 * restarting from zero. Same shape as `useElapsedLabel` in `SessionStatusLabel`
 * — a state tick on a leaf that renders one line, so the per-second re-render
 * never reaches the memoized transcript rows around it. (`WorkingIndicator`'s
 * ticker is deliberately NOT this: it mutates `textContent` through a ref to
 * avoid a per-second commit on the message list itself.)
 *
 * Returns null for an absent or unparseable timestamp so callers render no
 * duration rather than `NaN`.
 */
function useLiveDurationMs(startedAt: string | null, running: boolean): number | null {
  const startMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const anchored = Number.isFinite(startMs) ? startMs : null;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!running || anchored == null) return undefined;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [running, anchored]);
  if (anchored == null) return null;
  return Math.max(0, nowMs - anchored);
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
  const liveMs = useLiveDurationMs(event.startedAt, isRunning);

  const color = chatSubagentColor(event.agentKey);
  const elapsed = isRunning
    ? formatSubagentDurationMs(liveMs)
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
    event.parentLabel ? `spawned by ${event.parentLabel}` : null,
  ].filter((part): part is string => Boolean(part));

  // A spawned ADE chat (peer/subagent) carries a child session id → the whole
  // card navigates. Runtime-native subagents (no child id) keep the passive
  // card + nested "jump to result" affordance.
  const childSessionId = event.childSessionId?.trim() || null;
  const navigable = Boolean(childSessionId);
  const typeAccent = spawnTypeAccent(event.spawnKind);
  const agentIdentity = humanizeAgentIdentity(event.agentType);
  // Never print `"Agent completed"` where a result belongs — that string is
  // Codex filler, not an outcome.
  const resultSummary = !isRunning ? firstMeaningfulSummary(event.resultSummary) : null;

  const cardShell = cn(
    "w-full max-w-[var(--chat-content-width,52rem)] overflow-hidden rounded-[calc(var(--chat-radius-card)-6px)] border transition-colors",
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
          {/* Role, not id. Codex hands us its internal agent path
              (`/ROOT/SHIP_POLL_927`); `uppercase` on top of that made it shout a
              file path at the reader. `humanizeAgentIdentity` turns the last
              segment into a role and lifts a trailing issue/PR number into its
              own chip; runtimes that never set an agent type (OpenCode, Droid)
              get null and render no chip at all. The raw value stays as the
              tooltip so nothing is lost. */}
          {agentIdentity ? (
            <span
              title={agentIdentity.raw}
              className="shrink-0 rounded-md border border-[color:color-mix(in_srgb,var(--chat-accent)_18%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_7%,transparent)] px-1.5 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*9/14)] font-semibold text-[color:var(--chat-accent)]"
            >
              {agentIdentity.label}
            </span>
          ) : null}
          {agentIdentity?.ref ? (
            <span className="shrink-0 rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*9/14)] tabular-nums text-fg/50">
              {agentIdentity.ref}
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
 * Result card at the chronological position where the agent ended — the "role +
 * result" shape: what it was, what it found, how long it took.
 *
 * The head line is the agent's TASK, not the word "Finished": a transcript full
 * of `Finished / Finished / Finished` says nothing, and the status is already
 * carried by the glyph and the tone. The body is the real report preview;
 * runtime filler (`"Agent completed"`) is filtered out by
 * {@link firstMeaningfulSummary} and falls back to the status word rather than
 * printing placeholder text where a result belongs.
 *
 * Warm terminal states throughout: stopped → amber tone, failed → an `error`
 * chip plus a `Details` disclosure. Never a red error block.
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
  const statusWord = isSuccess ? "Finished" : isStopped ? "Stopped — interrupted" : "Failed";
  const title = event.description?.trim() || statusWord;
  const summary = firstMeaningfulSummary(event.summaryPreview);

  const counters = [
    typeof event.toolUseCount === "number" && event.toolUseCount > 0
      ? `${event.toolUseCount} tool${event.toolUseCount === 1 ? "" : "s"}`
      : null,
    typeof event.totalTokens === "number" && event.totalTokens > 0
      ? `${formatContextTokens(event.totalTokens)} tokens`
      : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <ChatCard skin={isSuccess ? "inset" : "rail"} tone={isSuccess ? "ok" : "warn"}>
      <ChatCardRow
        tone={isSuccess ? "ok" : isStopped ? "idle" : "warn"}
        align="top"
        meta={duration}
        action={onViewTranscript || onJumpToStart ? (
          <span className="flex flex-col items-end gap-1">
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
          </span>
        ) : null}
      >
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <ChatCardTitle className={cn("shrink", !isSuccess && "text-amber-100/85")}>{title}</ChatCardTitle>
          {!isSuccess && event.description?.trim() ? (
            <span className="shrink-0 font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-amber-100/60">
              {statusWord.toLowerCase()}
            </span>
          ) : null}
          {isFailed && event.error?.trim() ? (
            <span className="shrink-0 rounded-md border border-amber-400/18 bg-amber-400/[0.07] px-1.5 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*8/14)] font-bold uppercase tracking-[0.12em] text-amber-100/75">
              error
            </span>
          ) : null}
          {event.worktreeBranch?.trim() ? (
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(event.worktreePath || event.worktreeBranch || "")}
              title={event.worktreePath || event.worktreeBranch}
              className="shrink-0 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*8/14)] font-bold text-fg/55 transition-colors hover:text-fg/75"
            >
              worktree: {event.worktreeBranch}
            </button>
          ) : null}
          {event.parentLabel ? (
            <span className="shrink-0 font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-fg/40">spawned by {event.parentLabel}</span>
          ) : null}
        </div>
        {summary ? (
          <div className="mt-1 line-clamp-2 whitespace-normal text-[length:calc(var(--chat-font-size)*10.5/14)] leading-snug text-fg/66">
            {summary}
          </div>
        ) : null}
        {counters.length ? (
          <div className="mt-1.5 font-mono text-[length:calc(var(--chat-font-size)*10/14)] tabular-nums text-fg/32">
            {counters.join(" · ")}
          </div>
        ) : null}
      </ChatCardRow>
      {isFailed && event.error?.trim() ? (
        <div className="ml-[26px] mt-2">
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
    </ChatCard>
  );
}

/**
 * The whole in-thread presence of a backgrounded shell command: one quiet
 * centered rule-line, in the same idiom as the scheduled-wake and spawn-return
 * dividers — deliberately NOT a card. Background jobs are frequent and rarely
 * the point of the turn, so they get a line, not a block.
 *
 * Running:  `⚙ Background · npm install · 47s        [open]`
 * Finished: `✓ Background · npm install · exit 0 · 4m [open]`
 *
 * (`formatSubagentDurationMs` is lossy above a minute — `4m`, not `4m 11s`.)
 *
 * `open` reveals the chat actions pane, which is where a background job's full
 * state and output already live — the line points at it rather than duplicating
 * it inline.
 */
export function BackgroundJobLine({
  event,
  sessionEnded = false,
  onOpenBackgroundJobs,
}: {
  event: BackgroundJobLineRenderEvent;
  /**
   * Freezes the ticker. A job whose terminal update was never written (app
   * killed mid-run, provider crash) stays `running` in the transcript forever;
   * without this, reopening that dead chat months later renders a live counter
   * ticking up from a session that ended long ago — and holds an interval open
   * for as long as the row is mounted.
   */
  sessionEnded?: boolean;
  onOpenBackgroundJobs?: () => void;
}) {
  const running = event.status === "running";
  // A frozen counter is still a wrong counter: an archived job that never got a
  // terminal update would otherwise read "1440h" — accurate arithmetic, useless
  // claim. Drop the duration entirely rather than assert a number nobody should
  // read.
  const stale = running && sessionEnded;
  const liveMs = useLiveDurationMs(event.startedAt, running && !sessionEnded);
  const ok = event.status === "completed";
  const duration = formatSubagentDurationMs(running ? (stale ? null : liveMs) : event.durationMs);
  const parts = [
    event.label,
    !running && typeof event.exitCode === "number" ? `exit ${event.exitCode}` : null,
    duration,
    !running && !ok ? event.status : null,
  ].filter((part): part is string => Boolean(part));

  const skin = running
    ? { tone: "text-sky-200/60", rule: "bg-sky-200/[0.09]" }
    : ok
      ? { tone: "text-fg/45", rule: "bg-white/[0.06]" }
      : { tone: "text-amber-100/70", rule: "bg-amber-200/[0.10]" };

  return (
    <div
      className={cn(
        "my-2 flex items-center gap-2 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)]",
        skin.tone,
      )}
      data-background-job={event.agentKey}
      data-background-job-status={event.status}
    >
      <span className={cn("h-px flex-1", skin.rule)} />
      <span className="inline-flex min-w-0 shrink items-center gap-1.5" title={event.label}>
        {/* Phosphor rather than raw codepoints: bare ⚙/✓/✗ resolve to Segoe UI
            Emoji on Windows, rendering as heavier colour glyphs that sit off
            the baseline of a 10.5px rule line. */}
        {running
          ? <Gear size={10} weight="bold" aria-hidden className="shrink-0" />
          : ok
            ? <Check size={10} weight="bold" aria-hidden className="shrink-0" />
            : <X size={10} weight="bold" aria-hidden className="shrink-0" />}
        <span className="min-w-0 truncate">
          Background · {parts.join(" · ")}
        </span>
      </span>
      {onOpenBackgroundJobs ? (
        <button
          type="button"
          onClick={onOpenBackgroundJobs}
          className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded-full px-1.5 py-0.5 text-current opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-300/40"
          title="Show background jobs in the chat actions pane"
        >
          open<CaretRight size={9} weight="bold" aria-hidden />
        </button>
      ) : null}
      <span className={cn("h-px flex-1", skin.rule)} />
    </div>
  );
}

/**
 * The fan-in cell: ONE card standing in for a run of subagents that were all
 * stopped by a single user interrupt, instead of a wall of identical "stopped —
 * interrupted" result cards.
 *
 * Head row is the count; each agent is a detail row inside the same card, which
 * is what keeps a mass interrupt (a dozen — or fifty — agents) legible at a
 * glance. Collapsible, expanded by default up to a handful of agents. Never a
 * red error block.
 */
export function SubagentStoppedGroupCard({
  event,
  onJumpToStart,
}: {
  event: SubagentStoppedGroupEvent;
  onJumpToStart?: (rowKey: string) => void;
}) {
  const count = event.count;
  const [expanded, setExpanded] = useState(count <= 6);
  const headline = `${count} ${count === 1 ? "agent" : "agents"} stopped when you interrupted`;

  return (
    <ChatCard skin="rail" tone="warn">
      <ChatCardRow
        tone="warn"
        icon={Stop}
        action={(
          <span className="text-amber-100/55">
            {expanded ? <CaretDown size={12} weight="bold" aria-hidden /> : <CaretRight size={12} weight="bold" aria-hidden />}
          </span>
        )}
      >
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="min-w-0 text-left"
        >
          <ChatCardTitle className="text-amber-100/85">{headline}</ChatCardTitle>
        </button>
      </ChatCardRow>
      {expanded ? (
        <ChatCardDetail>
          {event.items.map((item) => (
            <ChatCardDetailRow
              key={item.agentKey}
              tone="idle"
              label={item.title}
              title={item.title}
              value={onJumpToStart ? "jump to start" : undefined}
              onClick={onJumpToStart ? () => onJumpToStart(item.jumpToStartRowKey) : undefined}
            />
          ))}
        </ChatCardDetail>
      ) : null}
    </ChatCard>
  );
}
