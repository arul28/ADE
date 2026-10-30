import React from "react";
import {
  Alarm,
  Binoculars,
  Bug,
  CheckCircle,
  Circle,
  CircleDashed,
  Clock,
  Code,
  Eye,
  Flask,
  MagnifyingGlass,
  NotePencil,
  Moon,
  RocketLaunch,
  SunHorizon,
  XCircle,
} from "@phosphor-icons/react";
import {
  SESSION_TONE_TEXT_CLASS,
  formatFutureDuration,
  formatWorkingDuration,
  type SessionStatusGlyph,
  type SessionStatusPresentation,
} from "../../../shared/sessionStatusPresentation";
import { cn } from "../ui/cn";
import { useTicker } from "../../lib/ticker";

/** Renderer-only mapping from shared glyph identity to Phosphor icons. */
function StatusGlyph({ glyph }: { glyph: SessionStatusGlyph }) {
  switch (glyph) {
    case "working":
      return <CircleDashed size={13} weight="bold" aria-hidden className="shrink-0" />;
    case "planning":
      return <NotePencil size={13} weight="bold" aria-hidden className="shrink-0" />;
    case "exploring":
      return <Binoculars size={13} weight="bold" aria-hidden className="shrink-0" />;
    case "implementing":
      return <Code size={13} weight="bold" aria-hidden className="shrink-0" />;
    case "testing":
      return <Flask size={13} weight="bold" aria-hidden className="shrink-0" />;
    case "reviewing":
      return <MagnifyingGlass size={13} weight="bold" aria-hidden className="shrink-0" />;
    case "debugging":
      return <Bug size={13} weight="bold" aria-hidden className="shrink-0" />;
    case "shipping":
      return <RocketLaunch size={13} weight="bold" aria-hidden className="shrink-0" />;
    case "monitoring":
      return <Eye size={13} weight="bold" aria-hidden className="shrink-0" />;
    // A recording is live: the dot blinks the way every recording pill does.
    case "recording":
      return <Circle size={9} weight="fill" aria-hidden className="shrink-0 text-[var(--color-error)] motion-safe:animate-pulse" />;
    case "waiting":
      return <Alarm size={13} weight="regular" aria-hidden className="shrink-0" />;
    case "done":
      return <CheckCircle size={13} weight="bold" aria-hidden className="shrink-0" />;
    // Filled, not outlined: "your move" is the one state allowed to shout.
    case "needs-you":
      return <Circle size={9} weight="fill" aria-hidden className="shrink-0" />;
    case "stale":
      return <Clock size={13} weight="regular" aria-hidden className="shrink-0" />;
    // Not the alarm clock: that is Waiting's mark, and the two sat in the same
    // column in different colours meaning different things.
    case "woke":
      return <SunHorizon size={13} weight="regular" aria-hidden className="shrink-0" />;
    case "snoozed":
      return <Moon size={12} weight="fill" aria-hidden className="shrink-0" />;
    // Every status in the column leads with a glyph, so the words line up.
    case "failed":
      return <XCircle size={13} weight="bold" aria-hidden className="shrink-0" />;
    default:
      return null;
  }
}

/**
 * Live elapsed copy for the states where "how long" is the useful fact.
 * The timestamp comes from the caller so this component stays independent of
 * terminal-session models and renderer actions.
 */
function useElapsedLabel(sinceIso: string | null | undefined, enabled: boolean): string {
  const sinceMs = React.useMemo(() => {
    const parsed = sinceIso ? Date.parse(sinceIso) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }, [sinceIso]);
  const active = enabled && sinceMs != null;
  // One shared one-second timer for every elapsed label on screen, instead of
  // an interval per row. The tick still lands every second, so the copy moves
  // exactly when it did before.
  const nowMs = useTicker(1_000, active);

  if (!active || sinceMs == null) return "";
  return formatWorkingDuration(nowMs - sinceMs);
}

function useFutureLabel(atIso: string | null | undefined, enabled: boolean): string {
  const atMs = React.useMemo(() => {
    const parsed = atIso ? Date.parse(atIso) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }, [atIso]);
  const active = enabled && atMs != null;
  // The copy is minute-granular; the shared thirty-second tick is the same
  // period the per-row timer used.
  const nowMs = useTicker(30_000, active);

  if (!active || atMs == null) return "";
  return formatFutureDuration(atMs, nowMs);
}

export type SessionStatusLabelProps = {
  presentation: SessionStatusPresentation | null;
  elapsedSince?: string | null;
  futureAt?: string | null;
  timestampLabel: string;
  compact: boolean;
  steeringInput?: boolean;
};

/**
 * Pure-props status vocabulary shared by session rows and upcoming Activity
 * projections. It owns no session model, hover actions, or IPC.
 */
export function SessionStatusLabel({
  presentation,
  elapsedSince,
  futureAt,
  timestampLabel,
  compact,
  steeringInput = false,
}: SessionStatusLabelProps) {
  const waiting = presentation?.glyph === "waiting";
  const elapsed = useElapsedLabel(elapsedSince, Boolean(presentation?.showsElapsed));
  const future = useFutureLabel(futureAt, waiting);
  const exactWakeTitle = React.useMemo(() => {
    if (!waiting || !futureAt) return undefined;
    const wakeAt = Date.parse(futureAt);
    return Number.isFinite(wakeAt)
      ? `Next run ${new Date(wakeAt).toLocaleString()}`
      : undefined;
  }, [futureAt, waiting]);
  const activityReportTitle = React.useMemo(() => {
    const source = presentation?.activitySource;
    if (!source) return undefined;
    const origin = source === "agent" ? "Reported by the agent" : "Detected from tool calls";
    const since = presentation.activityUpdatedAt ? Date.parse(presentation.activityUpdatedAt) : Number.NaN;
    return Number.isFinite(since)
      ? `${origin} · since ${new Date(since).toLocaleTimeString()}`
      : origin;
  }, [presentation?.activitySource, presentation?.activityUpdatedAt]);

  if (!presentation) {
    return (
      <span data-perf-ignore className={cn("text-muted-fg/45", compact ? "text-[10px]" : "text-[11px]")}>
        {timestampLabel}
      </span>
    );
  }

  const breathes = presentation.glyph === "working" && presentation.showsElapsed;
  return (
    <span
      data-session-status={presentation.label}
      data-session-tone={presentation.tone}
      data-session-status-source={presentation.activitySource}
      // The breathe changes only opacity, so the compositor runs it. On the
      // stepped loop clock each of its 15 steps a second was a main-thread
      // frame that re-layered the whole page (about 50 ms a second with a
      // chat open).
      data-loop-clock={breathes ? "off" : undefined}
      className={cn(
        "inline-flex items-center gap-1 font-medium",
        compact ? "text-[10px]" : "text-[11px]",
        SESSION_TONE_TEXT_CLASS[presentation.tone],
        // Breathing is reserved for the one state that is actively changing.
        breathes && "motion-safe:animate-[ade-session-working-breathe_2600ms_step-end_infinite]",
      )}
      title={activityReportTitle ?? exactWakeTitle}
    >
      <StatusGlyph glyph={presentation.glyph} />
      {/* Keep the ticker outside role=status so screen readers do not announce
          the row again every second. */}
      <span role="status" aria-label={exactWakeTitle}>
        {presentation.label}
      </span>
      {steeringInput && presentation.glyph === "working" ? (
        <span data-testid="session-steering-pip" aria-label="has a question">?</span>
      ) : null}
      {elapsed ? <span aria-hidden data-perf-ignore className="tabular-nums">{elapsed}</span> : null}
      {future ? <span aria-hidden data-perf-ignore className="tabular-nums">{future}</span> : null}
    </span>
  );
}
