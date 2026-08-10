import type {
  SessionAttentionSource,
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

/**
 * WHY a `running` phase is running. The phase alone cannot answer it, and the
 * answer changes the copy: "Working 14s" is a live turn, "Background work ×2"
 * is a turn that ended while its jobs kept going, and "Monitoring" is a watch
 * loop that will never finish on its own.
 *
 * Deliberately not a phase. Filing, filtering, buckets, and the push wire all
 * key off the phase, and every one of them wants these three treated
 * identically: work is happening, nothing is asked of you. Splitting the phase
 * would have forced a matching split into iOS's `AgentRunPhase`, the roster
 * status, and `canonicalStatusBucket` for a distinction only the label cares
 * about.
 */
export type SessionLiveness = "turn" | "background" | "monitoring";

export type CanonicalSessionState = {
  phase: CanonicalSessionPhase;
  /** Non-null ONLY for attention states — capsules never render for calm ones. */
  badge: SessionBadge | null;
  /** Non-null ONLY for `running`. See `SessionLiveness`. */
  liveness: SessionLiveness | null;
};

/**
 * Live work a session still owns after its foreground turn bookends — background
 * shells, monitors, and subagent fleets that outlive the turn that spawned them.
 *
 * Split two ways because users need to tell "still building" apart from "just
 * watching CI": a `monitoring` row is safe to walk away from, a `working` row
 * is not. See `classifyBackgroundWorkKind` for how the split is decided.
 */
export type SessionBackgroundWork = {
  /** Jobs doing real work. Anything unrecognised lands here — see the classifier. */
  workingCount: number;
  /** Jobs that only watch: monitors, tails, polling loops. */
  monitoringCount: number;
};

export function totalBackgroundWork(work: SessionBackgroundWork | null | undefined): number {
  if (!work) return 0;
  return Math.max(0, work.workingCount) + Math.max(0, work.monitoringCount);
}

/**
 * Read a session summary's background work, tolerating a payload that carries
 * only the older total.
 *
 * `activeBackgroundTaskCount` predates the working/monitoring split and is still
 * the field the mobile roster and the push publisher read, so it stays the wire
 * total. A summary that arrives with the total but no split (an older peer, a
 * remote runtime mid-upgrade) is counted as WORKING — same denylist principle as
 * `classifyBackgroundWorkKind`: unclassified is never assumed passive.
 */
export function backgroundWorkFromSummary(summary: {
  backgroundWork?: SessionBackgroundWork | null;
  activeBackgroundTaskCount?: number | null;
}): SessionBackgroundWork | null {
  if (summary.backgroundWork) return summary.backgroundWork;
  const total = summary.activeBackgroundTaskCount ?? 0;
  if (!Number.isFinite(total) || total <= 0) return null;
  return { workingCount: Math.trunc(total), monitoringCount: 0 };
}

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

/**
 * Task types that only WATCH. A session whose ONLY live work is on this list
 * reads "Monitoring" rather than "Working".
 *
 * ── Why a denylist, and why it must stay one ────────────────────────────────
 *
 * The obvious shape is an allowlist of "these are real subagents". It is also
 * the wrong one: provider agent-type names drift with every SDK release, so the
 * first unfamiliar name silently drops a genuinely working agent out of the
 * count and the row goes quiet while the agent is mid-run — the exact failure
 * this whole state exists to prevent.
 *
 * The rule, therefore: classify only what we KNOW is passive, and treat every
 * unrecognised type as working. A new SDK task type shows up as "Working",
 * which is at worst slightly over-loud and at best exactly right. Adding a name
 * here is a deliberate act with a known job behind it.
 *
 * ── Why the generic shell types are NOT here ────────────────────────────────
 *
 * `local_bash` / `shell` / `background` / `bash` are how a provider reports
 * "the agent backgrounded a command". That is a MIXED bag, not a passive one: a
 * `tail -f` and a 20-minute `npm run build` arrive under the same type. Listing
 * them here labelled every background build "Monitoring" — telling the user
 * nothing was being produced while it was. Mixed is unknown, and by the rule
 * above unknown is working. Only types whose whole job is to watch belong here.
 */
const MONITOR_TASK_TYPES: ReadonlySet<string> = new Set([
  "monitor",
  "monitor_mcp",
]);

/**
 * Types that hold no live work at all — they describe a turn's *thinking*, not
 * a process. Counting them would put a "Working" pill on a session whose only
 * outstanding item is a plan document.
 */
const INERT_TASK_TYPES: ReadonlySet<string> = new Set(["plan", "dream"]);

export type BackgroundWorkKind = "working" | "monitoring" | "inert";

/**
 * The ONE classifier for live background work, shared by every runtime adapter
 * so Claude's `local_bash` and Codex's monitor land in the same column.
 */
export function classifyBackgroundWorkKind(taskType: string | null | undefined): BackgroundWorkKind {
  const normalized = typeof taskType === "string" ? taskType.trim().toLowerCase() : "";
  if (!normalized) return "working";
  if (INERT_TASK_TYPES.has(normalized)) return "inert";
  if (MONITOR_TASK_TYPES.has(normalized)) return "monitoring";
  return "working";
}

/** Fold a list of live task types into the two-state count. */
export function summarizeBackgroundWork(
  taskTypes: Iterable<string | null | undefined>,
): SessionBackgroundWork {
  let workingCount = 0;
  let monitoringCount = 0;
  for (const taskType of taskTypes) {
    const kind = classifyBackgroundWorkKind(taskType);
    if (kind === "working") workingCount += 1;
    else if (kind === "monitoring") monitoringCount += 1;
  }
  return { workingCount, monitoringCount };
}

export type CanonicalSessionInputs = {
  status: TerminalSessionStatus;
  runtimeState?: TerminalRuntimeState | null;
  toolType?: TerminalToolType | null;
  pendingInputItemId?: string | null;
  attentionSource?: SessionAttentionSource | null;
  lastOutputPreview?: string | null;
  /** ISO timestamp of most recent output/activity (drives stale). */
  lastActivityAt?: string | null;
  exitCode?: number | null;
  /**
   * Declared settle. Only two writers exist: the user (desktop row/bulk
   * actions, `ade code`) and the deterministic PR-merge policy — agents lost
   * `ade chat settle` in 2026-07 because "is this done" is not their call.
   * Presence alone settles — new activity clears the column at the write site
   * (turn start / PTY output), so no timestamp comparison happens here.
   */
  settledAt?: string | null;
  /** Explicit lifecycle override. Cleared with `settledAt` on real activity. */
  settleOverride?: SessionSettleOverride | null;
  /**
   * Escalated ask from `ade chat ask`. Cleared by the next user message.
   */
  attentionRequestedAt?: string | null;
  /**
   * Chat turn that died on a runtime/API error (chats keep status "running",
   * so exitCode can't carry this). Cleared when the next turn starts.
   */
  lastTurnFailedAt?: string | null;
  /**
   * Live background work owned by the session (monitors, background shells,
   * subagent fleets still running after the turn bookends).
   *
   * In-memory and runtime-derived by design: after a restart nothing is live,
   * because orphaned background work is not live work. There is deliberately no
   * persisted column behind this — a resurrected "Working" pill on a session
   * whose process died with the app is worse than no pill at all.
   */
  backgroundWork?: SessionBackgroundWork | null;
  nowMs?: number;
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
 *   1. explicit/structured needs-input — pendingInputItemId or an
 *      `ade chat ask` escalation (never outvoted by anything below),
 *   2. settled — explicitly declared (user, or the PR-merge policy) or forced
 *      by a "settled" override; presence wins over failure because a declared
 *      quiet is a human judgment call. An "active" override suppresses this
 *      tier entirely. Cleared at the write site on any new activity,
 *   3. stopped — user/system-disposed PTY,
 *   4. failed — non-zero exit / killed / chat turn death,
 *   5. stale — status running but silent ≥ SESSION_STALE_AFTER_MS,
 *   6. running,
 *   7. resting states — ready (idle chat, quiet "your move"), idle, ended,
 *      EXCEPT when the session still owns live background work, which promotes
 *      the row back to `running` (see `restingPhaseWithBackgroundWork`).
 *
 * Note where the background-work promotion sits: below failure, below stale.
 * A stale "Working" pill must never mask a failed session — so a chat whose
 * turn died reads Failed even while its orphaned monitor is still ticking, and
 * a session silent past the stale threshold still reads Stale, because "nothing
 * has happened in three hours" is the fact worth surfacing regardless of what
 * claims to be alive.
 */
export function canonicalSessionState(args: CanonicalSessionInputs): CanonicalSessionState {
  const nowMs = args.nowMs ?? Date.now();
  const chat = args.isChatTool?.(args.toolType) ?? false;

  /**
   * A resting session that still owns live background work is not resting.
   * Returns the promoted `running` state, or the caller's resting state when
   * nothing is live.
   */
  const restingPhaseWithBackgroundWork = (
    resting: CanonicalSessionState,
  ): CanonicalSessionState => {
    const work = args.backgroundWork;
    if (totalBackgroundWork(work) <= 0) return resting;
    return {
      phase: "running",
      badge: null,
      // Monitoring only when watch loops are the SOLE live work. One real job
      // alongside three monitors is still "Working" — the honest summary of a
      // session is its loudest live commitment, not its quietest.
      liveness: (work?.workingCount ?? 0) > 0 ? "background" : "monitoring",
    };
  };

  // 1. Deterministic attention beats everything — including the failure and
  // stale checks below (an agent explicitly asking is actionable regardless).
  if (
    args.pendingInputItemId
    || args.attentionRequestedAt
    || args.attentionSource === "provider_structured"
  ) {
    return { phase: "needs_you", badge: BADGE_BY_KIND.needs_you, liveness: null };
  }

  // 2. Declared settle (or a "settled" override). No timestamp math: activity
  // un-settles by clearing the column where the activity happens (user turn
  // start / PTY output). Only honored AT REST — a settled chat woken by
  // scheduled work shows green while the turn streams, then re-settles when it
  // goes idle again (the settledAt column survives background wakes; only user
  // activity clears it).
  //
  const pinnedActive = args.settleOverride === "active";
  const atRest = args.status !== "running" || args.runtimeState === "idle";
  if (!pinnedActive && atRest && (args.settleOverride === "settled" || args.settledAt)) {
    // The PHASE stays settled: a declared settle is a human judgment call, and
    // re-lighting the row would let a stubborn monitor out-vote the user's
    // explicit "this is done".
    //
    // But `liveness` still reports the truth, because settle does NOT stop
    // background work today — archive is the only lifecycle path that stops
    // processes. A settled session can therefore legitimately still own a live
    // background shell, subagent, or Cursor cloud run, and a surface that wants
    // to show "settled, but something is still running" must be able to. The
    // phase alone would hide it, which is the exact failure this module exists
    // to prevent — just at the other end of the lifecycle.
    //
    // Making settle stop that work is a separate change; it needs a synchronous
    // lifecycle revision teardown can serialize against, not a wrapper around
    // this write. See the settle-teardown design doc.
    const settledWork = args.backgroundWork;
    return {
      phase: "settled",
      badge: null,
      liveness: totalBackgroundWork(settledWork) <= 0
        ? null
        : (settledWork?.workingCount ?? 0) > 0 ? "background" : "monitoring",
    };
  }

  const ended = args.status !== "running";
  if (ended) {
    // 3. Stopped: an explicitly disposed PTY is resumable/closed, not a task
    // failure. Keep it badge-free and let the session row's red dot carry the
    // ended state.
    if (args.status === "disposed") {
      return { phase: "stopped", badge: null, liveness: null };
    }
    // 4. Failure: a non-clean exit, an explicit "failed" persisted status
    // (spawn/setup failures that die before an exit code), or a killed
    // runtime — all deterministic "failed" signals a terminal-backed session
    // reports.
    if (typeof args.exitCode === "number" && args.exitCode !== 0) {
      return { phase: "failed", badge: BADGE_BY_KIND.failed, liveness: null };
    }
    if (args.status === "failed") {
      return { phase: "failed", badge: BADGE_BY_KIND.failed, liveness: null };
    }
    if (args.runtimeState === "killed") {
      return { phase: "failed", badge: BADGE_BY_KIND.failed, liveness: null };
    }
    // Chats never "end" like PTYs — they rest between turns. A turn that died
    // on a runtime/API error is a real failure the row must carry (chats have
    // no exit code); otherwise the chat is ready — the quiet "your move" tier.
    // Exception: a DETACHED chat (backing runtime gone, e.g. closed/imported)
    // is genuinely over — ended, not perpetually "your move".
    if (chat) {
      if (args.lastTurnFailedAt) {
        return { phase: "failed", badge: BADGE_BY_KIND.failed, liveness: null };
      }
      if (args.status === "detached") {
        return { phase: "ended", badge: null, liveness: null };
      }
      return restingPhaseWithBackgroundWork({ phase: "ready", badge: null, liveness: null });
    }
    // A clean process exit only says the CLI ended. Settlement is a lifecycle
    // declaration made by the user (or the lane PR-merge policy), never
    // inferred from process mechanics. There is no "derived clean-exit settle"
    // anywhere in ADE — if you find a comment claiming otherwise, it is stale.
    return { phase: "ended", badge: null, liveness: null };
  }

  // Chat rows keep status "running" even when a turn dies — surface the
  // persisted failure marker ahead of the calm running/ready states.
  if (chat && args.lastTurnFailedAt) {
    return { phase: "failed", badge: BADGE_BY_KIND.failed, liveness: null };
  }

  // 6. Stale: running but silent past the threshold.
  if (isSilentPast(args.lastActivityAt, nowMs, SESSION_STALE_AFTER_MS)) {
    return { phase: "stale", badge: BADGE_BY_KIND.stale, liveness: null };
  }

  // Idle chats between turns are ready (calm); idle agent CLIs at an
  // undetected prompt stay actionable via the caller's existing idle rules —
  // canonical keeps them "idle" (calm) because there is no deterministic ask.
  if (args.runtimeState === "idle") {
    return restingPhaseWithBackgroundWork(
      chat
        ? { phase: "ready", badge: null, liveness: null }
        : { phase: "idle", badge: null, liveness: null },
    );
  }

  return { phase: "running", badge: null, liveness: "turn" };
}

/**
 * The at-rest bucket vocabulary for session lists (desktop sidebar sections,
 * the mobile roster, lane snapshots). Derives from the canonical phase so all
 * surfaces slice identically:
 *   running   — work happening (incl. stale: the process IS still running),
 *   awaiting-input — "your move": loud needs_you rows and quiet resting chats
 *                    and idle CLIs share the section; the badge alone is loud,
 *   ended     — died (failed / stopped / unknown exit),
 *   settled   — explicitly declared done; quiet tier at the bottom.
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
 * (~100 years) can bury a row whose hand IS raised. Explicit and structured
 * requests project to `needs_you`, so deriving the filing rule from the phase
 * covers chat and CLI identically.
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
