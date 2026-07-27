import {
  SNOOZE_DURATION_OPTIONS,
  sessionWokeMarker,
  snoozeConfirmationLabel,
  snoozeDeadlineIso,
  snoozeWakeLabel,
  type SnoozeDurationKey,
} from "../../../desktop/src/renderer/lib/sessionSnooze";
import {
  isSessionFiledAsSnoozed,
  isSessionSnoozed,
} from "../../../desktop/src/shared/sessionCanonicalState";
import { parseSnoozeDuration } from "../sessionSnoozeDuration";
import type { TuiSessionLifecycleFields } from "./adeApi";

/**
 * `ade code`'s half of the session-lifecycle surface: argument parsing for the
 * `/session …` slash commands and the text-only row markers the drawer and the
 * right-pane chat list render.
 *
 * Everything semantic is imported, never re-derived:
 *   - "is this row snoozed" comes from the shared `isSessionSnoozed`
 *     (expiry is DERIVED by comparing `snoozedUntil` to now — no timers here),
 *   - wake-label copy ("wakes in 3h" / "wakes tomorrow" / "wakes when asked" /
 *     "wakes now") comes from `snoozeWakeLabel`,
 *   - woke-reason copy ("needs approval" / "errored" / "turn finished") comes
 *     from `sessionWokeMarker`,
 *   - duration grammar comes from `parseSnoozeDuration`.
 *
 * Snooze stays a VISIBILITY OVERLAY: nothing below reads or writes a canonical
 * phase, and no marker here is derived from a phase check.
 */

export type SessionLifecycleCommand =
  | "snooze"
  | "wake"
  | "settle"
  | "unsettle"
  | "keep-active";

/** Slash names this module owns, mapped to their verb. `/chat settle` and
 *  `/chat unsettle` keep their own (active-only) dispatch in app.tsx. */
export const SESSION_LIFECYCLE_COMMAND_BY_NAME: Readonly<Record<string, SessionLifecycleCommand>> = {
  "/session snooze": "snooze",
  "/session wake": "wake",
  "/session settle": "settle",
  "/session unsettle": "unsettle",
  "/session keep-active": "keep-active",
};

export function sessionLifecycleCommandFor(name: string): SessionLifecycleCommand | null {
  return SESSION_LIFECYCLE_COMMAND_BY_NAME[name] ?? null;
}

// ---------------------------------------------------------------------------
// Per-session targeting
// ---------------------------------------------------------------------------

/** Shortest prefix we will resolve to a session. Below this a typo is more
 *  likely than an abbreviation, and a wrong target is a destructive surprise. */
const MIN_ID_PREFIX = 4;

export type SessionTargetResolution =
  | { ok: true; sessionId: string; explicit: boolean; rest: string }
  | { ok: false; code: "no-active" | "unknown-session" | "ambiguous-session"; message: string };

function matchSessionId(token: string, knownSessionIds: readonly string[]): "none" | "ambiguous" | string {
  const needle = token.trim().toLowerCase();
  if (!needle) return "none";
  const exact = knownSessionIds.find((id) => id.toLowerCase() === needle);
  if (exact) return exact;
  if (needle.length < MIN_ID_PREFIX) return "none";
  const prefixed = knownSessionIds.filter((id) => id.toLowerCase().startsWith(needle));
  if (prefixed.length === 1) return prefixed[0]!;
  if (prefixed.length > 1) return "ambiguous";
  return "none";
}

/**
 * Resolve `[<id>] <rest…>`: an id is only consumed when the leading token
 * actually names a session the client knows about, so `/session snooze 1h`
 * still means "snooze the active session for an hour" and never means "snooze
 * the session called 1h". Omitting the id targets the active session, matching
 * how `/chat settle` behaves.
 *
 * `strictLeadingToken` is for the verbs that take no other argument (wake /
 * unsettle / keep-active): there, a leading token that does not name a session
 * is a typo, not a passthrough.
 */
export function resolveSessionTarget(args: {
  input: string;
  activeSessionId: string | null;
  knownSessionIds: readonly string[];
  strictLeadingToken?: boolean;
}): SessionTargetResolution {
  const trimmed = args.input.trim();
  const [leading = ""] = trimmed.split(/\s+/, 1);
  const matched = leading ? matchSessionId(leading, args.knownSessionIds) : "none";

  if (matched === "ambiguous") {
    return {
      ok: false,
      code: "ambiguous-session",
      message: `'${leading}' matches more than one session. Pass more of the id.`,
    };
  }
  if (matched !== "none") {
    return {
      ok: true,
      sessionId: matched,
      explicit: true,
      rest: trimmed.slice(leading.length).trim(),
    };
  }
  if (leading && args.strictLeadingToken) {
    return {
      ok: false,
      code: "unknown-session",
      message: `No session matches '${leading}'. Run /chats to see session ids, or omit the id to target the active session.`,
    };
  }
  if (!args.activeSessionId) {
    return {
      ok: false,
      code: "no-active",
      message: "No active chat or CLI session is selected. Pass a session id.",
    };
  }
  return { ok: true, sessionId: args.activeSessionId, explicit: false, rest: trimmed };
}

// ---------------------------------------------------------------------------
// Duration choices
// ---------------------------------------------------------------------------

export type SnoozeChoice = { key: SnoozeDurationKey; label: string };

/** The palette rows, in the shared fixed order (shortest window first,
 *  open-ended last). Free-text durations bypass this list entirely. */
export const SNOOZE_CHOICES: readonly SnoozeChoice[] = SNOOZE_DURATION_OPTIONS.map((option) => ({
  key: option.key,
  label: option.label,
}));

export type SnoozeResolution =
  | { ok: true; untilIso: string; confirmation: string }
  | { ok: false; message: string };

/** Resolve a menu choice to a concrete deadline (computed client-side; there is
 *  no scheduler — every surface derives expiry by comparing to now). */
export function resolveSnoozeChoice(key: SnoozeDurationKey, nowMs: number = Date.now()): SnoozeResolution {
  return {
    ok: true,
    untilIso: snoozeDeadlineIso(key, nowMs),
    confirmation: `Snoozed ${snoozeConfirmationLabel(key)}.`,
  };
}

/**
 * Resolve free-text duration entry ("45m", "1.5h", "2d") through the shared
 * grammar. The TUI never typed a flag, so flag-worded failures are rewritten.
 */
export function resolveSnoozeFreeText(value: string, nowMs: number = Date.now()): SnoozeResolution {
  const parsed = parseSnoozeDuration(value);
  if (!parsed.ok) {
    switch (parsed.code) {
      case "too-short":
        return { ok: false, message: "Snooze for at least one second." };
      case "too-long":
        // Point at the open-ended choice rather than dead-ending: a user asking
        // for 90d wants "until I'm asked", not a shorter countdown.
        return {
          ok: false,
          message: "Snooze for 30d or less, or pick \"Until I'm asked\" for an open-ended snooze.",
        };
      default:
        return {
          ok: false,
          message: `'${value.trim()}' is not a duration. Try 30m, 1h, 4h, or 1d.`,
        };
    }
  }
  const untilIso = new Date(nowMs + parsed.ms).toISOString();
  const label = snoozeWakeLabel(untilIso, nowMs);
  return { ok: true, untilIso, confirmation: label ? `Snoozed · ${label}.` : "Snoozed." };
}

// ---------------------------------------------------------------------------
// Row markers — text only, legible with no color at all
// ---------------------------------------------------------------------------

export type SessionLifecycleSnapshot = Partial<TuiSessionLifecycleFields> & {
  /** Passed separately because chat rows and CLI rows spell "still going"
   *  differently; only used to keep a running row out of the quiet tier. */
  isActive?: boolean;
  pendingInputItemId?: string | null;
  /** Deterministic needs-you signals, read straight off the row the caller
   *  already spreads in — a snoozed row that is asking for you must not be
   *  MARKED snoozed (see `sessionLifecycleMarker`). */
  awaitingInput?: boolean | null;
  runtimeState?: string | null;
};

/**
 * The deterministic hand-raise a text row can see, mirroring rule 1 of
 * `canonicalSessionState`: a pending input item, a "waiting-input" runtime, an
 * `ade chat ask` escalation, or the runtime's own awaiting-input flag. This is
 * all the TUI needs to decide filing — the preview heuristic only ever upgrades
 * running → needs_you, and a running row is not the case at risk here.
 */
function snapshotRaisesHand(session: SessionLifecycleSnapshot): boolean {
  if (session.awaitingInput === true) return true;
  if (typeof session.runtimeState === "string" && session.runtimeState.trim().toLowerCase() === "waiting-input") {
    return true;
  }
  if (typeof session.pendingInputItemId === "string" && session.pendingInputItemId.trim().length > 0) return true;
  return typeof session.attentionRequestedAt === "string" && session.attentionRequestedAt.trim().length > 0;
}

/**
 * Leading marker glyph for a snoozed row. Deliberately the ASCII letter `z`:
 * every state below must survive a terminal with no color, no bold, and no
 * emoji font, so state is NEVER encoded in color alone.
 */
export const SNOOZED_GLYPH = "z";
/** Leading marker for a row that came back on its own. */
export const WOKE_GLYPH = "*";
/** Quiet-tier marker; pairs with an outcome note when the session left one. */
export const SETTLED_LABEL = "done";

export type SessionLifecycleMarker = {
  /** Machine-readable state for callers that want to tier or sort rows. */
  kind: "snoozed" | "woke" | "settled";
  /** One-cell text glyph, or "" for settled (the word carries it). */
  glyph: string;
  /** Full marker text, glyph included — safe to render with no styling. */
  text: string;
};

/**
 * The single row marker a session earns, highest priority first:
 *   0. a raised hand — no marker at all: a row blocked on the user must never
 *      read as `z wakes in 3h`, or an "until I'm asked" snooze hides the very
 *      thing it promised to bring back (tracked CLI rows have no early-wake
 *      event, so this derivation is the only thing that surfaces them),
 *   1. snoozed  — `z wakes in 3h` (a live visibility overlay outranks history),
 *   2. woke     — `* needs approval` (why the row came back, until it's opened),
 *   3. settled  — `done` / `done: <outcome>` (the quiet tier).
 * Returns null for an ordinary row.
 *
 * Snooze filing comes from the shared `isSessionFiledAsSnoozed`, never from a
 * local phase check, and a settled marker is suppressed while the session is
 * active so a woken-and-working row is not filed as done.
 */
export function sessionLifecycleMarker(
  session: SessionLifecycleSnapshot,
  options: { note?: string | null; nowMs?: number } = {},
): SessionLifecycleMarker | null {
  const nowMs = options.nowMs ?? Date.now();
  if (isSessionFiledAsSnoozed(
    { snoozedUntil: session.snoozedUntil, snoozedAt: session.snoozedAt },
    snapshotRaisesHand(session) ? "needs_you" : null,
    nowMs,
  )) {
    const label = snoozeWakeLabel(session.snoozedUntil, nowMs) ?? "wakes when asked";
    return { kind: "snoozed", glyph: SNOOZED_GLYPH, text: `${SNOOZED_GLYPH} ${label}` };
  }
  const woke = sessionWokeMarker(
    {
      snoozedUntil: session.snoozedUntil ?? null,
      snoozedAt: session.snoozedAt ?? null,
      wokeAt: session.wokeAt ?? null,
      wokeReason: session.wokeReason ?? null,
      pendingInputItemId: session.pendingInputItemId ?? null,
      lastTurnFailedAt: session.lastTurnFailedAt ?? null,
    },
    nowMs,
  );
  if (woke) {
    return { kind: "woke", glyph: WOKE_GLYPH, text: `${WOKE_GLYPH} ${woke.label}` };
  }
  // An "active" keep-active pin suppresses the quiet tier outright — that is the
  // whole point of the pin — and so does a session that is actually running.
  if (session.settleOverride === "active" || session.isActive) return null;
  if (session.settleOverride === "settled" || session.settledAt) {
    const note = options.note?.trim();
    return {
      kind: "settled",
      glyph: "",
      text: note ? `${SETTLED_LABEL}: ${note}` : SETTLED_LABEL,
    };
  }
  return null;
}

/**
 * Whether opening this row should clear its "woke" marker.
 *
 * Guards on the PERSISTED `wokeAt`, never on `sessionLifecycleMarker()`. A row
 * whose snooze merely lapsed still shows a marker — `sessionWokeMarker` derives
 * one from the expired deadline — but the host never wrote anything, so calling
 * `session.clearWokeMarker` for it is a pointless round-trip.
 */
export function shouldClearWokeMarkerOnVisit(
  session: Pick<SessionLifecycleSnapshot, "wokeAt"> | null | undefined,
): boolean {
  return typeof session?.wokeAt === "string" && session.wokeAt.trim().length > 0;
}

/**
 * Clear the "woke" marker for a session the user just opened, matching desktop
 * (`TerminalsPage.handleSelectSession`) and iOS (`clearWokeMarkerOnVisit`).
 *
 * Strictly fire-and-forget: the promise is never awaited and a rejection is
 * swallowed, so a failed clear can neither block nor delay opening the session.
 * Returns whether the action was dispatched, which is also what makes the
 * persisted-vs-derived guard testable.
 */
export function clearWokeMarkerOnVisit(args: {
  sessionId: string | null;
  sessions: readonly (Pick<SessionLifecycleSnapshot, "wokeAt"> & { sessionId: string })[];
  clear: (sessionId: string) => Promise<unknown>;
}): boolean {
  if (!args.sessionId) return false;
  const session = args.sessions.find((entry) => entry.sessionId === args.sessionId);
  if (!shouldClearWokeMarkerOnVisit(session)) return false;
  void Promise.resolve(args.clear(args.sessionId)).catch(() => {});
  return true;
}

/** Re-exported so TUI call sites never hand-roll a snooze check. `isSessionSnoozed`
 *  is the raw column read; `isSessionFiledAsSnoozed` is the filing rule that
 *  yields to a raised hand. */
export { isSessionFiledAsSnoozed, isSessionSnoozed, snoozeWakeLabel };
