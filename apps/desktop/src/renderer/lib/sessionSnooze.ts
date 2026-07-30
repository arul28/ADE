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

export type SnoozeDurationKey = "hour" | "evening" | "tomorrow" | "next-week" | "asked";

export type SnoozeDurationOption = {
  key: SnoozeDurationKey;
  label: string;
};

/**
 * Menu order is fixed: shortest window first, open-ended last.
 *
 * Labels name the DAY, never the clock time — the menu renders a separate time
 * column (`SnoozePreset.whenLabel`) beside them, and "Until tomorrow 9am" next
 * to "9:00 AM" says the same thing twice. The one exception is "Until I'm
 * asked", which names an intent rather than a day and has no clock time to
 * repeat.
 *
 * This is the STATIC superset — every key, in order, with no time attached. It
 * is the vocabulary, not the menu: rendering surfaces go through
 * `resolveSnoozePresets`, which resolves each row against the wall clock and
 * drops the ones that have stopped making sense at the current time of day.
 */
export const SNOOZE_DURATION_OPTIONS: readonly SnoozeDurationOption[] = [
  { key: "hour", label: "In 1 hour" },
  { key: "evening", label: "This evening" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "next-week", label: "Next week" },
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
/** `Date.prototype.getDay()` for Monday, the day "next week" always lands on. */
const MONDAY = 1;

/**
 * A local wall-clock hour, `dayOffset` CALENDAR days from `base`.
 *
 * Deliberately built from Y/M/D fields rather than by adding `dayOffset *
 * DAY_MS`: a fixed millisecond offset lands on the wrong local day across a DST
 * transition. A spring-forward day is 23 hours, so `23:30 + 24h` skips the
 * whole next day, and "snooze until tomorrow 9am" would silently become the day
 * after. The `Date` constructor normalises out-of-range day numbers (and month
 * rollover) using the calendar, so this stays correct across every transition.
 */
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
      // Past 6pm already: this evening has gone, so roll to the next one. The
      // desktop menu suppresses the row entirely by then (see
      // `resolveSnoozePresets`), but the CLI can still name the preset directly
      // and must not get a deadline in the past.
      if (evening.getTime() <= nowMs) return atLocalHour(now, EVENING_HOUR, 1).toISOString();
      return evening.toISOString();
    }
    case "tomorrow":
      return atLocalHour(now, MORNING_HOUR, 1).toISOString();
    case "next-week": {
      // Next Monday 9am — a FULL week out when today is already Monday, because
      // "next week" must never resolve to "in a few hours". `|| 7` turns the
      // zero-day case (today is Monday) into the following Monday.
      const daysUntilMonday = (MONDAY - now.getDay() + 7) % 7 || 7;
      return atLocalHour(now, MORNING_HOUR, daysUntilMonday).toISOString();
    }
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
    case "next-week":
      return "until next Monday";
    case "asked":
    default:
      return "until you're asked";
  }
}

function timeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function weekdayLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: "short" });
}

/**
 * A menu row: the fixed label, the time column beside it, and the deadline the
 * row will write if clicked.
 */
export type SnoozePreset = SnoozeDurationOption & {
  /**
   * The menu's right-hand time column. Complements the label instead of
   * repeating it: "Tomorrow" pairs with "9:00 AM", not "tomorrow 9:00 AM". The
   * open-ended preset has no clock time, so it names its wake CONDITION
   * instead — an empty column would read as a missing value rather than a
   * deliberate one.
   */
  whenLabel: string;
  /** Deadline resolved against the `nowMs` the list was built with. */
  untilIso: string;
};

function presetWhenLabel(key: SnoozeDurationKey, untilIso: string): string {
  if (key === "asked") return "on a hand-raise";
  const wake = new Date(untilIso);
  const time = timeOfDayLabel(wake);
  // "Next week" is the one preset whose label does not identify a day, so its
  // column carries the weekday as well as the time.
  return key === "next-week" ? `${weekdayLabel(wake)} ${time}` : time;
}

/**
 * The snooze menu, resolved against local time.
 *
 * Not a constant, because one of the rows only makes sense at certain hours:
 * "This evening" is dropped once 6pm is within an hour (it would just duplicate
 * "In 1 hour") or already past (a row labelled "This evening" that resolves to
 * TOMORROW evening is a lie). Past that point the list simply starts at
 * "Tomorrow". Callers must therefore resolve per-open and never hoist the
 * result to module scope, or a long-lived process freezes that judgement at
 * startup.
 *
 * "Until I'm asked" always survives: it has no clock semantics to go stale, and
 * it is the only preset whose wake is driven by the session rather than the
 * calendar (see `resolveSessionWakeReason`).
 */
export function resolveSnoozePresets(nowMs: number = Date.now()): readonly SnoozePreset[] {
  const eveningMs = atLocalHour(new Date(nowMs), EVENING_HOUR).getTime();
  const eveningIsUseful = eveningMs - nowMs > HOUR_MS;

  const presets: SnoozePreset[] = [];
  for (const option of SNOOZE_DURATION_OPTIONS) {
    if (option.key === "evening" && !eveningIsUseful) continue;
    const untilIso = snoozeDeadlineIso(option.key, nowMs);
    presets.push({ ...option, whenLabel: presetWhenLabel(option.key, untilIso), untilIso });
  }
  return presets;
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
 * The absolute wake TIME, for menus and toasts: "9:00 AM", "tomorrow 9:00 AM",
 * "Mon 9:00 AM", "Sep 3, 9:00 AM".
 *
 * Distinct from `snoozeWakeLabel` on purpose. The row label answers "how much
 * longer" in the least space possible ("wakes in 3h") because it sits in a
 * status slot that a hundred rows share. This answers "when, exactly", which is
 * what you need when you are about to commit to a deadline or have just been
 * told one — a toast that says "wakes in 18h" makes the reader do arithmetic.
 *
 * Day words come from `calendarDayDelta` rather than dividing the remaining
 * milliseconds by 24h: across a spring-forward transition "tomorrow 9am" is
 * only 23 hours out, and a millisecond division would report it as today.
 */
export function snoozeWakeDescription(
  snoozedUntil: string | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  const untilMs = parseIsoMs(snoozedUntil);
  if (untilMs == null) return null;
  const remaining = untilMs - nowMs;
  if (remaining <= 0) return "now";
  // The open-ended preset parks the deadline ~100 years out; printing that date
  // would be technically true and completely useless.
  if (remaining >= INDEFINITE_LABEL_THRESHOLD_MS) return "when you're asked";

  const wake = new Date(untilMs);
  const time = timeOfDayLabel(wake);
  const dayDelta = calendarDayDelta(nowMs, untilMs);
  if (dayDelta === 0) return time;
  if (dayDelta === 1) return `tomorrow ${time}`;
  // Inside the coming week a weekday is the fastest thing to read; past it the
  // weekday becomes ambiguous ("Mon" — which Monday?) so switch to a date.
  if (dayDelta < 7) return `${weekdayLabel(wake)} ${time}`;
  return `${wake.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
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
