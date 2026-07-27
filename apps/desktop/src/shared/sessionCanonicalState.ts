import type {
  SessionSettleOverride,
  SessionWakeReason,
  TerminalRuntimeState,
  TerminalSessionStatus,
  TerminalToolType,
} from "./types/sessions";

/**
 * The ONE vocabulary for "what state is this session in", shared by the Work
 * tab (desktop + iOS mirror), the TUI, and — by documented mapping — the push
 * pipeline, so a session's badge, its Live Activity phase, and any
 * notification always tell the same story.
 *
 * Mapping to the Live Activity wire phases (names unchanged on the push side):
 *   needs_you  ⇔ waiting_for_approval | waiting_for_input
 *   failed     ⇔ failed
 *   stale      ⇔ stale
 *   starting/running ⇔ starting/running
 *   ready/idle/stopped/ended have no LA row (terminal or chat-resting states).
 */
export type CanonicalSessionPhase =
  | "starting"
  | "running"
  | "needs_you"
  | "failed"
  | "stale"
  | "stopped"
  | "ready"
  | "idle"
  | "ended"
  | "settled";

export type SessionBadgeKind = "needs_you" | "failed" | "stale";

export type SessionBadge = {
  kind: SessionBadgeKind;
  /** One-word capsule copy; calm states get no badge at all. */
  label: string;
};

export type CanonicalSessionState = {
  phase: CanonicalSessionPhase;
  /** Non-null ONLY for attention states — capsules never render for calm ones. */
  badge: SessionBadge | null;
};

/**
 * A session still marked running that has produced no output for this long is
 * "stale" — running but silent. Distinct from the push relay's APNs TTLs
 * (2h/24h delivery expiry) and the Live Activity stale-date (10min lock-screen
 * dimming): this is the human-facing "is anything actually happening" bar.
 */
export const SESSION_STALE_AFTER_MS = 3 * 60 * 60 * 1000;

const BADGE_BY_KIND: Record<SessionBadgeKind, SessionBadge> = {
  needs_you: { kind: "needs_you", label: "Needs you" },
  failed: { kind: "failed", label: "Failed" },
  stale: { kind: "stale", label: "Stale" },
};

export type CanonicalSessionInputs = {
  status: TerminalSessionStatus;
  runtimeState?: TerminalRuntimeState | null;
  toolType?: TerminalToolType | null;
  pendingInputItemId?: string | null;
  lastOutputPreview?: string | null;
  /** ISO timestamp of most recent output/activity (drives stale). */
  lastActivityAt?: string | null;
  exitCode?: number | null;
  /**
   * Declared settle (agent `ade chat settle` or user action). Presence alone
   * settles — new activity clears the column at the write site (turn start /
   * PTY output), so no timestamp comparison happens here.
   */
  settledAt?: string | null;
  /**
   * Tri-state settle override, consulted BEFORE the derived exit-0 rule.
   * "settled" behaves like a declared settle; "active" is an explicit
   * keep-active pin that suppresses settle (derived AND declared) so a clean
   * PTY exit is not permanently pinned to the quiet tier. Cleared on real
   * activity at the same write sites that clear `settledAt`.
   */
  settleOverride?: SessionSettleOverride | null;
  /**
   * Escalated ask from `ade chat ask` (chat sessions; CLI sessions ride
   * runtimeState "waiting-input" instead). Cleared by the next user message.
   */
  attentionRequestedAt?: string | null;
  /**
   * Chat turn that died on a runtime/API error (chats keep status "running",
   * so exitCode can't carry this). Cleared when the next turn starts.
   */
  lastTurnFailedAt?: string | null;
  nowMs?: number;
  /**
   * The preview-text heuristic (regex over terminal output) supplied by the
   * caller so this module stays dependency-free. It is consulted LAST and can
   * only upgrade running → needs_you — deterministic signals always win.
   */
  previewSuggestsNeedsInput?: (preview: string | null | undefined) => boolean;
  /** Chat sessions idle between turns are "ready", not running/ended. */
  isChatTool?: (toolType: TerminalToolType | null | undefined) => boolean;
};

function isSilentPast(lastActivityAt: string | null | undefined, nowMs: number, thresholdMs: number): boolean {
  if (!lastActivityAt) return false;
  const at = Date.parse(lastActivityAt);
  if (!Number.isFinite(at)) return false;
  return nowMs - at >= thresholdMs;
}

/**
 * Canonical precedence (highest first):
 *   1. deterministic needs-input — pendingInputItemId, runtimeState
 *      "waiting-input", or an `ade chat ask` escalation (never outvoted by
 *      anything below),
 *   2. settled — explicitly declared (agent/user) or forced by a "settled"
 *      override; presence wins over failure because a declared quiet is a
 *      human/agent judgment call. An "active" override suppresses this tier
 *      entirely. Cleared at the write site on any new activity,
 *   3. stopped — user/system-disposed PTY,
 *   4. failed — non-zero exit / killed / chat turn death,
 *   5. clean exit — a PTY that exited 0 IS the process declaring it's done;
 *      auto-settles without any declaration, UNLESS an "active" override pins
 *      it (rule 2's override check runs first),
 *   6. stale — status running but silent ≥ SESSION_STALE_AFTER_MS,
 *   7. running (incl. the preview heuristic's needs_you upgrade, LAST),
 *   8. resting states — ready (idle chat, quiet "your move"), idle, ended.
 */
export function canonicalSessionState(args: CanonicalSessionInputs): CanonicalSessionState {
  const nowMs = args.nowMs ?? Date.now();
  const chat = args.isChatTool?.(args.toolType) ?? false;

  // 1. Deterministic attention beats everything — including the failure and
  // stale checks below (an agent explicitly asking is actionable regardless).
  if (args.pendingInputItemId || args.runtimeState === "waiting-input" || args.attentionRequestedAt) {
    return { phase: "needs_you", badge: BADGE_BY_KIND.needs_you };
  }

  // 2. Declared settle (or a "settled" override). No timestamp math: activity
  // un-settles by clearing the column where the activity happens (user turn
  // start / PTY output). Only honored AT REST — a settled chat woken by
  // scheduled work shows green while the turn streams, then re-settles when it
  // goes idle again (the settledAt column survives background wakes; only user
  // activity clears it).
  //
  // The tri-state override is consulted here, i.e. BEFORE the derived exit-0
  // rule below. "active" is an explicit keep-active pin: it beats derived
  // settle (a clean exit) and a stale declared settle alike, so the row keeps a
  // real lifecycle action instead of being stuck in the quiet tier forever.
  const pinnedActive = args.settleOverride === "active";
  const atRest = args.status !== "running" || args.runtimeState === "idle";
  if (!pinnedActive && atRest && (args.settleOverride === "settled" || args.settledAt)) {
    return { phase: "settled", badge: null };
  }

  const ended = args.status !== "running";
  if (ended) {
    // 3. Stopped: an explicitly disposed PTY is resumable/closed, not a task
    // failure. Keep it badge-free and let the session row's red dot carry the
    // ended state.
    if (args.status === "disposed") {
      return { phase: "stopped", badge: null };
    }
    // 4. Failure: a non-clean exit, an explicit "failed" persisted status
    // (spawn/setup failures that die before an exit code), or a killed
    // runtime — all deterministic "failed" signals a terminal-backed session
    // reports.
    if (typeof args.exitCode === "number" && args.exitCode !== 0) {
      return { phase: "failed", badge: BADGE_BY_KIND.failed };
    }
    if (args.status === "failed") {
      return { phase: "failed", badge: BADGE_BY_KIND.failed };
    }
    if (args.runtimeState === "killed") {
      return { phase: "failed", badge: BADGE_BY_KIND.failed };
    }
    // Chats never "end" like PTYs — they rest between turns. A turn that died
    // on a runtime/API error is a real failure the row must carry (chats have
    // no exit code); otherwise the chat is ready — the quiet "your move" tier.
    // Exception: a DETACHED chat (backing runtime gone, e.g. closed/imported)
    // is genuinely over — ended, not perpetually "your move".
    if (chat) {
      if (args.lastTurnFailedAt) {
        return { phase: "failed", badge: BADGE_BY_KIND.failed };
      }
      if (args.status === "detached") {
        return { phase: "ended", badge: null };
      }
      return { phase: "ready", badge: null };
    }
    // 5. Clean exit auto-settle: exit 0 is the one deterministic "done"
    // declaration a process can make. Unknown exits stay "ended" (red).
    // An "active" override vetoes it — that is the whole point of the pin.
    if (args.exitCode === 0 && !pinnedActive) {
      return { phase: "settled", badge: null };
    }
    return { phase: "ended", badge: null };
  }

  // Chat rows keep status "running" even when a turn dies — surface the
  // persisted failure marker ahead of the calm running/ready states.
  if (chat && args.lastTurnFailedAt) {
    return { phase: "failed", badge: BADGE_BY_KIND.failed };
  }

  // 6. Stale: running but silent past the threshold.
  if (isSilentPast(args.lastActivityAt, nowMs, SESSION_STALE_AFTER_MS)) {
    return { phase: "stale", badge: BADGE_BY_KIND.stale };
  }

  // Idle chats between turns are ready (calm); idle agent CLIs at an
  // undetected prompt stay actionable via the caller's existing idle rules —
  // canonical keeps them "idle" (calm) because there is no deterministic ask.
  if (args.runtimeState === "idle") {
    return chat ? { phase: "ready", badge: null } : { phase: "idle", badge: null };
  }

  // 7. Preview heuristic LAST: it may only upgrade running → needs_you.
  if (args.previewSuggestsNeedsInput?.(args.lastOutputPreview)) {
    return { phase: "needs_you", badge: BADGE_BY_KIND.needs_you };
  }

  return { phase: "running", badge: null };
}

/**
 * The at-rest bucket vocabulary for session lists (desktop sidebar sections,
 * the mobile roster, lane snapshots). Derives from the canonical phase so all
 * surfaces slice identically:
 *   running   — work happening (incl. stale: the process IS still running),
 *   awaiting-input — "your move": loud needs_you rows and quiet resting chats
 *                    and idle CLIs share the section; the badge alone is loud,
 *   ended     — died (failed / stopped / unknown exit),
 *   settled   — declared or clean-exit done; quiet tier at the bottom.
 */
export type CanonicalStatusBucket = "running" | "awaiting-input" | "ended" | "settled";

// ---------------------------------------------------------------------------
// Snooze — a synced VISIBILITY OVERLAY, deliberately NOT a lifecycle state
// ---------------------------------------------------------------------------

/**
 * Snooze never alters a session's canonical phase. `canonicalSessionState()`
 * does not read these fields at all: a snoozed row is still running/failed/
 * needs_you exactly as before, snooze only decides where the UI files it.
 * Keeping the two orthogonal is what lets desktop, `ade code`, and iOS derive
 * "is this hidden right now" from the same two columns without re-deriving the
 * lifecycle.
 */
export type SessionSnoozeState = {
  /** ISO deadline; expiry is DERIVED by comparing to now — there is no timer. */
  snoozedUntil?: string | null;
  /** ISO instant the snooze was taken; the early-wake comparison baseline. */
  snoozedAt?: string | null;
};

export type SessionWakeSignals = {
  /** A pending approval / input request is showing on the row. */
  hasPendingInput?: boolean;
  /** ISO timestamp of the session's most recent error, if any. */
  errorAt?: string | null;
  /** A running turn just completed. */
  turnCompleted?: boolean;
};

function parseIsoMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The one derivation of "this row is currently snoozed", shared by desktop,
 * CLI, and iOS. Timer expiry is derived here (`snoozedUntil <= now`), which is
 * why no scheduler or background watchdog exists for snooze.
 */
export function isSessionSnoozed(session: SessionSnoozeState, nowMs: number = Date.now()): boolean {
  const until = parseIsoMs(session.snoozedUntil);
  if (until == null) return false;
  return until > nowMs;
}

/**
 * The FILING rule: "should a list hide this row in its Snoozed group?".
 *
 * Snooze is a visibility overlay, and an overlay must yield to a session that
 * is actually blocked on the user — otherwise the "Until I'm asked" window
 * (~100 years) can bury a row whose hand IS raised. Only three events ever
 * wrote an early wake (`ade chat ask`, chat turn failure, chat turn complete),
 * all chat-only, so a tracked CLI session that hits a permission prompt has no
 * event to fire: for it, `needs_you` is DERIVED (runtimeState "waiting-input"
 * or the output-preview heuristic) and nothing persists a flag. Deriving the
 * filing rule from the phase covers chat and CLI identically with no event.
 *
 * Deliberately separate from `isSessionSnoozed`, which stays the raw two-column
 * read: chips, menus, and wake labels legitimately want "is this row snoozed?"
 * independent of where the list files it. And `canonicalSessionState()` still
 * never reads the snooze columns — this is a predicate over its output, not a
 * new phase.
 */
export function isSessionFiledAsSnoozed(
  session: SessionSnoozeState,
  phase: CanonicalSessionPhase | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!isSessionSnoozed(session, nowMs)) return false;
  return phase !== "needs_you";
}

/** A snooze that was taken but whose window has already elapsed. */
export function isSessionSnoozeExpired(session: SessionSnoozeState, nowMs: number = Date.now()): boolean {
  const until = parseIsoMs(session.snoozedUntil);
  if (until == null) return false;
  return until <= nowMs;
}

/**
 * The load-bearing early-wake comparison.
 *
 * An error only raises a hand when it is STRICTLY NEWER than `snoozedAt`.
 * Without this, the very error the user snoozed on top of re-wakes the row
 * immediately and snooze does nothing at all. An error stamped at exactly
 * `snoozedAt` is the one being snoozed, so it does not wake either.
 *
 * If the row carries no parseable `snoozedAt` we fail CLOSED (no wake): an
 * unknown baseline must not resurrect every historical error.
 */
export function isWakingSessionError(
  session: SessionSnoozeState,
  errorAt: string | null | undefined,
): boolean {
  const errorMs = parseIsoMs(errorAt);
  if (errorMs == null) return false;
  const snoozedAtMs = parseIsoMs(session.snoozedAt);
  if (snoozedAtMs == null) return false;
  return errorMs > snoozedAtMs;
}

/**
 * Resolve why a snoozed row should wake right now, or null to stay asleep.
 * Hand-raises are reported ahead of plain timer expiry because they carry the
 * more useful "woke" marker copy. A row that is not snoozed at all never wakes.
 */
export function resolveSessionWakeReason(
  session: SessionSnoozeState,
  signals: SessionWakeSignals = {},
  nowMs: number = Date.now(),
): SessionWakeReason | null {
  if (parseIsoMs(session.snoozedUntil) == null) return null;
  if (signals.hasPendingInput === true) return "needs_you";
  if (isWakingSessionError(session, signals.errorAt)) return "error";
  if (signals.turnCompleted === true) return "turn_complete";
  if (isSessionSnoozeExpired(session, nowMs)) return "timer";
  return null;
}

export function canonicalStatusBucket(phase: CanonicalSessionPhase): CanonicalStatusBucket {
  switch (phase) {
    case "starting":
    case "running":
    case "stale":
      return "running";
    case "needs_you":
    case "ready":
    case "idle":
      return "awaiting-input";
    case "settled":
      return "settled";
    default:
      return "ended";
  }
}
