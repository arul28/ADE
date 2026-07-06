import type { TerminalRuntimeState, TerminalSessionStatus, TerminalToolType } from "./types/sessions";

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
 *   ready/idle/ended have no LA row (terminal or chat-resting states).
 */
export type CanonicalSessionPhase =
  | "starting"
  | "running"
  | "needs_you"
  | "failed"
  | "stale"
  | "ready"
  | "idle"
  | "ended";

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
export const SESSION_STALE_AFTER_MS = 20 * 60 * 1000;

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
 *   1. deterministic needs-input — pendingInputItemId or runtimeState
 *      "waiting-input" (never outvoted by anything below),
 *   2. failed — non-zero exit / killed,
 *   3. stale — status running but silent ≥ SESSION_STALE_AFTER_MS,
 *   4. running (incl. the preview heuristic's needs_you upgrade, LAST),
 *   5. resting states — ready (idle chat), idle, ended.
 */
export function canonicalSessionState(args: CanonicalSessionInputs): CanonicalSessionState {
  const nowMs = args.nowMs ?? Date.now();
  const chat = args.isChatTool?.(args.toolType) ?? false;

  // 1. Deterministic attention beats everything — including the failure and
  // stale checks below (an agent explicitly asking is actionable regardless).
  if (args.pendingInputItemId || args.runtimeState === "waiting-input") {
    return { phase: "needs_you", badge: BADGE_BY_KIND.needs_you };
  }

  const ended = args.status !== "running";
  if (ended) {
    // 2. Failure: a non-clean exit, an explicit "failed" persisted status
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
    // Chats never "end" like PTYs — they rest between turns, ready for input.
    if (chat) return { phase: "ready", badge: null };
    return { phase: "ended", badge: null };
  }

  // 3. Stale: running but silent past the threshold.
  if (isSilentPast(args.lastActivityAt, nowMs, SESSION_STALE_AFTER_MS)) {
    return { phase: "stale", badge: BADGE_BY_KIND.stale };
  }

  // Idle chats between turns are ready (calm); idle agent CLIs at an
  // undetected prompt stay actionable via the caller's existing idle rules —
  // canonical keeps them "idle" (calm) because there is no deterministic ask.
  if (args.runtimeState === "idle") {
    return chat ? { phase: "ready", badge: null } : { phase: "idle", badge: null };
  }

  // 4. Preview heuristic LAST: it may only upgrade running → needs_you.
  if (args.previewSuggestsNeedsInput?.(args.lastOutputPreview)) {
    return { phase: "needs_you", badge: BADGE_BY_KIND.needs_you };
  }

  return { phase: "running", badge: null };
}
