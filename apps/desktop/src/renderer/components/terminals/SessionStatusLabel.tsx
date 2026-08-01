import React from "react";
import {
  Alarm,
  CheckCircle,
  Circle,
  CircleDashed,
  Clock,
  NotePencil,
  Moon,
} from "@phosphor-icons/react";
import {
  SESSION_TONE_TEXT_CLASS,
  formatFutureDuration,
  formatWorkingDuration,
  type SessionStatusGlyph,
  type SessionStatusPresentation,
} from "../../../shared/sessionStatusPresentation";
import { cn } from "../ui/cn";

/** Renderer-only mapping from shared glyph identity to Phosphor icons. */
function StatusGlyph({ glyph }: { glyph: SessionStatusGlyph }) {
  switch (glyph) {
    case "working":
      return <CircleDashed size={13} weight="bold" aria-hidden className="shrink-0" />;
    case "planning":
      return <NotePencil size={13} weight="bold" aria-hidden className="shrink-0" />;
    case "waiting":
      return <Alarm size={13} weight="regular" aria-hidden className="shrink-0" />;
    case "done":
      return <CheckCircle size={13} weight="bold" aria-hidden className="shrink-0" />;
    // Filled, not outlined: "your move" is the one state allowed to shout.
    case "needs-you":
      return <Circle size={9} weight="fill" aria-hidden className="shrink-0" />;
    case "stale":
      return <Clock size={13} weight="regular" aria-hidden className="shrink-0" />;
    case "woke":
      return <Alarm size={13} weight="regular" aria-hidden className="shrink-0" />;
    case "snoozed":
      return <Moon size={12} weight="fill" aria-hidden className="shrink-0" />;
    // `failed` deliberately has no glyph — red plus the word is already the
    // loudest thing on the row.
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
  const [nowMs, setNowMs] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!enabled || sinceMs == null) return undefined;
    setNowMs(Date.now());
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [enabled, sinceMs]);

  if (!enabled || sinceMs == null) return "";
  return formatWorkingDuration(nowMs - sinceMs);
}

function useFutureLabel(atIso: string | null | undefined, enabled: boolean): string {
  const atMs = React.useMemo(() => {
    const parsed = atIso ? Date.parse(atIso) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }, [atIso]);
  const [nowMs, setNowMs] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!enabled || atMs == null) return undefined;
    setNowMs(Date.now());
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(intervalId);
  }, [atMs, enabled]);

  if (!enabled || atMs == null) return "";
  return formatFutureDuration(atMs, nowMs);
}

export type SessionStatusLabelProps = {
  presentation: SessionStatusPresentation | null;
  elapsedSince?: string | null;
  futureAt?: string | null;
  timestampLabel: string;
  compact: boolean;
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

  if (!presentation) {
    return (
      <span className={cn("text-muted-fg/45", compact ? "text-[10px]" : "text-[11px]")}>
        {timestampLabel}
      </span>
    );
  }

  return (
    <span
      data-session-status={presentation.label}
      data-session-tone={presentation.tone}
      className={cn(
        "inline-flex items-center gap-1 font-medium",
        compact ? "text-[10px]" : "text-[11px]",
        SESSION_TONE_TEXT_CLASS[presentation.tone],
        // Breathing is reserved for the one state that is actively changing.
        presentation.glyph === "working"
          && presentation.showsElapsed
          && "motion-safe:animate-[ade-session-working-breathe_2600ms_ease-in-out_infinite]",
      )}
    >
      <StatusGlyph glyph={presentation.glyph} />
      {/* Keep the ticker outside role=status so screen readers do not announce
          the row again every second. */}
      <span role="status" aria-label={exactWakeTitle}>{presentation.label}</span>
      {elapsed ? <span aria-hidden className="tabular-nums">{elapsed}</span> : null}
      {future ? <span aria-hidden className="tabular-nums">{future}</span> : null}
    </span>
  );
}
