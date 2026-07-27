import type { SessionWakeReason, TerminalSessionSummary } from "../../shared/types";
import {
  isSessionFiledAsSnoozed,
  isSessionSnoozeExpired,
  isSessionSnoozed,
  resolveSessionWakeReason,
} from "../../shared/sessionCanonicalState";

/**
 * Renderer-side snooze presentation. The derivations themselves
 * (`isSessionSnoozed` / `isSessionSnoozeExpired` / `resolveSessionWakeReason`)
 * live in `shared/sessionCanonicalState` and are shared with the CLI and iOS —
 * this module only owns the desktop copy and the client-side deadline math
 * behind the duration menu.
 *
 * Snooze is a VISIBILITY OVERLAY, never a lifecycle phase: nothing here reads
 * or writes a canonical phase, so the sidebar files a snoozed row without
 * changing what the row's status dot says.
 */

export type SnoozeDurationKey = "hour" | "evening" | "tomorrow" | "asked";

export type SnoozeDurationOption = {
  key: SnoozeDurationKey;
  label: string;
};

/** Menu order is fixed: shortest window first, open-ended last. */
export const SNOOZE_DURATION_OPTIONS: readonly SnoozeDurationOption[] = [
  { key: "hour", label: "1 hour" },
  { key: "evening", label: "Until this evening" },
  { key: "tomorrow", label: "Until tomorrow 9am" },
  { key: "asked", label: "Until I'm asked" },
];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** "Until I'm asked" has no clock deadline, so it parks the row far enough out
 *  that only a hand-raise (needs-you / error / turn complete) brings it back. */
const INDEFINITE_MS = 100 * 365 * DAY_MS;
/** Any deadline beyond this reads as open-ended rather than a countdown. */
const INDEFINITE_LABEL_THRESHOLD_MS = 365 * DAY_MS;

const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

function atLocalHour(base: Date, hour: number, dayOffset = 0): Date {
  const next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, 0, 0, 0);
  return next;
}

/**
 * Concrete ISO deadline for a menu choice, computed client-side (there is no
 * scheduler anywhere — every surface derives expiry by comparing to now).
 */
export function snoozeDeadlineIso(key: SnoozeDurationKey, nowMs: number = Date.now()): string {
  const now = new Date(nowMs);
  switch (key) {
    case "hour":
      return new Date(nowMs + HOUR_MS).toISOString();
    case "evening": {
      const evening = atLocalHour(now, EVENING_HOUR);
      // Past 6pm already: this evening has gone, so roll to the next one.
      if (evening.getTime() <= nowMs) return atLocalHour(now, EVENING_HOUR, 1).toISOString();
      return evening.toISOString();
    }
    case "tomorrow":
      return atLocalHour(now, MORNING_HOUR, 1).toISOString();
    case "asked":
    default:
      return new Date(nowMs + INDEFINITE_MS).toISOString();
  }
}

/** Short confirmation fragment used by the undo toast ("Snoozed until 9am"). */
export function snoozeConfirmationLabel(key: SnoozeDurationKey): string {
  switch (key) {
    case "hour":
      return "for 1 hour";
    case "evening":
      return "until this evening";
    case "tomorrow":
      return "until 9am";
    case "asked":
    default:
      return "until you're asked";
  }
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

function calendarDayDelta(fromMs: number, toMs: number): number {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const fromMidnight = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const toMidnight = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((toMidnight - fromMidnight) / DAY_MS);
}

/**
 * The per-row wake line in the Snoozed group: "wakes in 3h", "wakes tomorrow",
 * "wakes when asked". Returns null when the row has no usable deadline.
 */
export function snoozeWakeLabel(
  snoozedUntil: string | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  const untilMs = parseIsoMs(snoozedUntil);
  if (untilMs == null) return null;
  const remaining = untilMs - nowMs;
  if (remaining <= 0) return "wakes now";
  if (remaining >= INDEFINITE_LABEL_THRESHOLD_MS) return "wakes when asked";
  if (remaining < 60_000) return "wakes in 1m";
  if (remaining < HOUR_MS) return `wakes in ${Math.round(remaining / 60_000)}m`;

  const dayDelta = calendarDayDelta(nowMs, untilMs);
  if (dayDelta === 0) return `wakes in ${Math.round(remaining / HOUR_MS)}h`;
  if (dayDelta === 1) return remaining < 12 * HOUR_MS ? `wakes in ${Math.round(remaining / HOUR_MS)}h` : "wakes tomorrow";
  return `wakes in ${Math.max(1, dayDelta)}d`;
}

/**
 * Specific, operational copy for why a snoozed row came back. Deliberately not
 * "woke up" — the user needs to know what changed.
 */
export function wakeReasonLabel(reason: SessionWakeReason | null | undefined): string | null {
  switch (reason) {
    case "needs_you":
      return "needs approval";
    case "error":
      return "errored";
    case "turn_complete":
      return "turn finished";
    case "timer":
      return "snooze ended";
    case "manual":
      return "woken by you";
    default:
      return null;
  }
}

export type SessionWokeMarker = {
  reason: SessionWakeReason;
  label: string;
};

/**
 * The "woke" marker a row carries until it is opened. Prefers the persisted
 * `wokeReason`; a row whose snooze merely lapsed (expiry is derived, so the
 * backend never wrote a marker) falls back to the shared resolver so timer
 * wakes still explain themselves.
 */
export function sessionWokeMarker(
  session: Pick<
    TerminalSessionSummary,
    "snoozedUntil" | "snoozedAt" | "wokeAt" | "wokeReason" | "pendingInputItemId" | "lastTurnFailedAt"
  >,
  nowMs: number = Date.now(),
): SessionWokeMarker | null {
  if (session.wokeAt) {
    const reason = session.wokeReason ?? "timer";
    const label = wakeReasonLabel(reason);
    return label ? { reason, label } : null;
  }
  if (!isSessionSnoozeExpired(session, nowMs)) return null;
  const reason = resolveSessionWakeReason(
    session,
    {
      hasPendingInput: Boolean(session.pendingInputItemId),
      errorAt: session.lastTurnFailedAt ?? null,
    },
    nowMs,
  );
  const label = wakeReasonLabel(reason);
  return reason && label ? { reason, label } : null;
}

/**
 * Soonest future snooze deadline across a list, so a caller can arm exactly one
 * timer instead of polling. Null when nothing is currently snoozed.
 */
export function nextSnoozeDeadlineMs(
  sessions: readonly Pick<TerminalSessionSummary, "snoozedUntil">[],
  nowMs: number = Date.now(),
): number | null {
  let soonest: number | null = null;
  for (const session of sessions) {
    const untilMs = parseIsoMs(session.snoozedUntil);
    if (untilMs == null || untilMs <= nowMs) continue;
    if (soonest == null || untilMs < soonest) soonest = untilMs;
  }
  return soonest;
}

/**
 * Re-exported so Work-tab call sites never hand-roll a phase check for snooze.
 * `isSessionSnoozed` is the raw column read (chips, menus, wake labels);
 * `isSessionFiledAsSnoozed` is the FILING rule every Snoozed group must use, so
 * a row whose hand is raised is never hidden by the overlay.
 */
export { isSessionFiledAsSnoozed, isSessionSnoozed, isSessionSnoozeExpired };
