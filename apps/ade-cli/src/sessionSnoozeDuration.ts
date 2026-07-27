/**
 * Snooze duration parsing, shared by the `ade session snooze` planner in
 * `cli.ts` and the `ade code` TUI's `/session snooze` command.
 *
 * Extracted rather than duplicated: there must be exactly one answer to "what
 * does `1.5h` mean" across the CLI and the terminal client, and exactly one cap
 * on how far out a snooze may be parked. Snooze expiry is DERIVED everywhere
 * (compare `snoozedUntil` to now) — nothing in here schedules anything.
 *
 * The functions return a result union instead of throwing so each surface can
 * dress the failure in its own voice: `cli.ts` re-throws `CliUsageError` with
 * the flag-worded `message`, the TUI switches on `code` to write terminal copy
 * that never mentions a flag the user did not type.
 */

import { snoozeDeadlineIso } from "../../desktop/src/renderer/lib/sessionSnooze";

const SNOOZE_UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/** Longest *relative* snooze we accept. `--for 400d` is almost certainly a typo,
 *  and there is no scheduler anywhere that could walk the deadline back. The cap
 *  is deliberately NOT applied to the open-ended "until asked" form below, which
 *  is a named intent rather than a mistyped number. */
export const MAX_SNOOZE_MS = 30 * SNOOZE_UNIT_MS.d!;

/**
 * A deadline this far out is open-ended in every surface: desktop's
 * `snoozeWakeLabel` prints "wakes when asked" instead of a countdown, so the CLI
 * must not print the raw far-future timestamp either. Mirrors
 * `INDEFINITE_LABEL_THRESHOLD_MS` in
 * `desktop/src/renderer/lib/sessionSnooze.ts`, which is module-private there.
 */
export const INDEFINITE_SNOOZE_THRESHOLD_MS = 365 * SNOOZE_UNIT_MS.d!;

/**
 * Whether a stored deadline is the open-ended "until I'm asked" kind — the one
 * the desktop/iOS preset writes (~100 years out) and that `--until-asked`
 * reproduces. Callers use this to render "wakes when asked" instead of a date.
 */
export function isIndefiniteSnooze(
  untilIso: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (typeof untilIso !== "string" || !untilIso.trim()) return false;
  const ms = Date.parse(untilIso);
  if (!Number.isFinite(ms)) return false;
  return ms - nowMs >= INDEFINITE_SNOOZE_THRESHOLD_MS;
}

/**
 * The open-ended deadline, delegated to the desktop preset so the CLI, the TUI,
 * the desktop menu, and iOS all park an "until asked" row on the exact same
 * instant. Nothing here schedules anything — expiry is still derived by
 * comparing the deadline to now.
 */
export function untilAskedSnoozeIso(nowMs: number = Date.now()): string {
  return snoozeDeadlineIso("asked", nowMs);
}

export type SnoozeDurationErrorCode = "invalid" | "too-short" | "too-long";

export type SnoozeDurationResult =
  | { ok: true; ms: number }
  | { ok: false; code: SnoozeDurationErrorCode; message: string };

/**
 * Parse a snooze duration: an integer or one-decimal amount plus a unit suffix
 * (`30m`, `1h`, `1.5h`, `4h`, `1d`). A bare number is read as minutes so `90`
 * does the obvious thing.
 */
export function parseSnoozeDuration(value: string): SnoozeDurationResult {
  const invalid = {
    ok: false,
    code: "invalid",
    message: "--for must be a positive duration such as 30m, 1h, 4h, or 1d.",
  } as const;
  const raw = value.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w|sec|secs|min|mins|hour|hours|day|days|week|weeks)?$/.exec(raw);
  if (!match) return invalid;
  const amount = Number(match[1]);
  // `Infinity` (a digit run past 1e308) is not a grammar failure — it is a
  // magnitude failure, so it falls through to the "too long" branch below
  // rather than being reported as an unparseable duration.
  if (Number.isNaN(amount) || amount <= 0) return invalid;
  const unit = (match[2] ?? "m").slice(0, 1);
  const ms = Math.round(amount * SNOOZE_UNIT_MS[unit]!);
  // Magnitude first, deliberately. An input big enough to overflow past the safe
  // integer range (`999999999999999w`) is absurdly LONG, so testing "too short"
  // first told the user to "snooze for at least one second" — the exact opposite
  // of the problem. Overflow is folded into `too-long` so every surface that
  // switches on `code` says "that's too far out" for both.
  if (!Number.isFinite(ms) || ms > MAX_SNOOZE_MS) {
    return { ok: false, code: "too-long", message: "--for must be 30d or less." };
  }
  if (ms < 1000) {
    return { ok: false, code: "too-short", message: "--for must resolve to at least one second." };
  }
  return { ok: true, ms };
}

export type SnoozeDeadlineErrorCode =
  | SnoozeDurationErrorCode
  | "both"
  | "neither"
  | "not-iso"
  | "past";

export type SnoozeDeadlineResult =
  | { ok: true; untilIso: string }
  | { ok: false; code: SnoozeDeadlineErrorCode; message: string };

/**
 * Resolve the snooze deadline from a relative duration, an absolute ISO
 * instant, or the open-ended "until asked" form. Exactly one is required; an
 * absolute deadline must parse and must be in the future, because a past
 * deadline makes the row instantly visible again and reads as a silently
 * ignored command.
 *
 * `untilAsked` exists so the CLI can express the same thing the desktop/iOS
 * "Until I'm asked" preset writes. It bypasses `MAX_SNOOZE_MS` on purpose: the
 * cap guards mistyped relative durations, and refusing the named form here
 * would leave a deadline ADE's own UI creates unreachable from the CLI.
 */
export function resolveSnoozeUntil(
  args: { forValue: string | null; untilValue: string | null; untilAsked?: boolean },
  now: number = Date.now(),
): SnoozeDeadlineResult {
  const { forValue, untilValue } = args;
  const untilAsked = args.untilAsked === true;
  if (forValue != null && untilValue != null) {
    return { ok: false, code: "both", message: "Use either --for or --until, not both." };
  }
  if (untilAsked && (forValue != null || untilValue != null)) {
    return {
      ok: false,
      code: "both",
      message: "Use either --until-asked or a --for/--until deadline, not both.",
    };
  }
  if (untilAsked) {
    return { ok: true, untilIso: untilAskedSnoozeIso(now) };
  }
  if (forValue != null) {
    const parsed = parseSnoozeDuration(forValue);
    if (!parsed.ok) return parsed;
    return { ok: true, untilIso: new Date(now + parsed.ms).toISOString() };
  }
  if (untilValue != null) {
    const parsed = new Date(untilValue.trim());
    if (Number.isNaN(parsed.getTime())) {
      return {
        ok: false,
        code: "not-iso",
        message: `--until must be an ISO-8601 timestamp such as 2026-07-26T18:00:00Z; received '${untilValue}'.`,
      };
    }
    if (parsed.getTime() <= now) {
      return { ok: false, code: "past", message: "--until must be in the future." };
    }
    return { ok: true, untilIso: parsed.toISOString() };
  }
  return {
    ok: false,
    code: "neither",
    message:
      "Pass --for <30m|1h|4h|1d> or --until <iso-timestamp>, or --until-asked to snooze until a hand-raise.",
  };
}
