import { resolveUsageLimitResumeState } from "./chatAutoResume";
import { usageLimitResumeRowStatus } from "./usageLimitResumePresentation";
import type { AgentChatUsageLimitResume } from "./types/chat";
import type { SessionActivityReport } from "./types/sessions";
import { isReportFromTurn } from "./sessionActivity";
import type {
  CanonicalSessionPhase,
  SessionBackgroundWork,
  SessionLiveness,
} from "./sessionCanonicalState";
import { totalBackgroundWork } from "./sessionCanonicalState";

/**
 * The ONE presentation vocabulary for "how does a session's state look and
 * read", shared by the Work sidebar, the attention center, the header rollup,
 * desktop notifications, and — by documented mirror — the iOS widgets and Live
 * Activity (`AgentRunPhase` in `apps/ios/ADE/Shared/ADEAgentActivityAttributes.swift`).
 *
 * `sessionCanonicalState.ts` owns WHAT state a session is in. This module owns
 * WHAT THAT LOOKS LIKE. The split matters: the phase vocabulary is load-bearing
 * for filing, filtering, and the push wire format, so presentation changes must
 * never require touching it.
 *
 * ── The one-hue-one-meaning rule ────────────────────────────────────────────
 *
 * Before this module, amber carried five unrelated meanings on a single row:
 * `needs_you`, `ready`/`idle`, the stale-CLI warning, stopped-by-signal, and
 * the cross-machine marker. A user cannot learn a color that means five things,
 * so amber meant nothing and every row had to be read word by word.
 *
 * The rule now, and the reason each hue is spent where it is:
 *
 *   blue     work is happening, nothing is asked of you
 *   amber    YOUR MOVE — and nothing else, ever
 *   emerald  finished cleanly, you have not looked yet
 *   red      it broke
 *   neutral  true, but not actionable (stale, stopped, ended, snoozed)
 *
 * Two consequences worth stating, because both look like bugs otherwise:
 *
 *   • `stopped` is neutral, not red. A SIGINT/SIGTERM exit (130/143) is the
 *     user pressing stop — spending the alarm hue on an outcome the user chose
 *     is what trained people to ignore red. Red now means only "it broke".
 *
 *   • `ready`/`idle` are emerald "Done", not amber. They previously shared
 *     amber with `needs_you`, which made "finished, go look" and "blocked,
 *     go act" indistinguishable at a glance — the single worst confusion in
 *     the old row.
 *
 * The cross-machine marker keeps its amber tower glyph: it is a 10px monochrome
 * identity mark inside a neutral chip, not a status label, and it never renders
 * in the status slot this module owns. The two cannot collide.
 */
export type SessionStatusTone = "blue" | "violet" | "amber" | "emerald" | "red" | "neutral";

/**
 * Glyph identity, not an icon import. Each consumer maps these to its own icon
 * set — Phosphor on desktop, SF Symbols on iOS — so this module stays free of
 * renderer dependencies and can be imported by main-process code.
 */
export type SessionStatusGlyph =
  | "working"
  | "monitoring"
  | "recording"
  | "planning"
  | "exploring"
  | "implementing"
  | "testing"
  | "reviewing"
  | "debugging"
  | "shipping"
  | "waiting"
  | "needs-you"
  | "done"
  | "stale"
  | "failed"
  | "woke"
  | "snoozed"
  | null;

export type SessionStatusPresentation = {
  /** Sentence-case label. Empty-string is never returned; use `null` presentation instead. */
  label: string;
  tone: SessionStatusTone;
  glyph: SessionStatusGlyph;
  /**
   * Whether the label should be followed by a live-ticking elapsed duration
   * ("Working 14s"). Only true for phases where elapsed time is the useful
   * fact — a failed run's age is noise.
   */
  showsElapsed: boolean;
  /**
   * Whether this state should pull the eye. Drives the sidebar's recede rule:
   * non-prominent rows fade to 70% so the few rows that want a human stand out.
   * Working is deliberately NOT prominent — an agent mid-turn is not yet your
   * problem (inbox-zero: prominence is a request for attention, not a progress
   * report).
   */
  prominent: boolean;
  /** This label is a finer activity detail inside the parent phase. */
  activityDetail?: boolean;
  /** Who set the activity: the agent, or ADE's tool-call detector. */
  activitySource?: SessionActivityReport["source"];
  /** When the session entered this activity — the row's elapsed counts from here. */
  activityUpdatedAt?: string;
};

/** Nested compact rows keep the word only for Needs you / Failed. */
export function sessionStatusShoutsLabel(
  presentation: Pick<SessionStatusPresentation, "glyph" | "tone">,
): boolean {
  return presentation.glyph === "needs-you" || presentation.tone === "red";
}

/**
 * Settled rows carry no status label at all — they live in the collapsed
 * settled tail, where the section itself is the status. Returning `null` rather
 * than a "Settled" presentation keeps the row's status slot free for its
 * timestamp, which is the only thing worth reading in the tail.
 */
const PHASE_PRESENTATION: Record<CanonicalSessionPhase, SessionStatusPresentation | null> = {
  starting: { label: "Starting", tone: "blue", glyph: "working", showsElapsed: false, prominent: false },
  running: { label: "Working", tone: "blue", glyph: "working", showsElapsed: true, prominent: false },
  needs_you: { label: "Needs you", tone: "amber", glyph: "needs-you", showsElapsed: false, prominent: true },
  ready: { label: "Done", tone: "emerald", glyph: "done", showsElapsed: false, prominent: true },
  idle: { label: "Done", tone: "emerald", glyph: "done", showsElapsed: false, prominent: true },
  // Running but silent past the threshold. Neutral, not blue: the process is
  // technically alive, but reporting it as work-in-progress is a lie the old
  // green dot told for hours at a time.
  //
  // Elapsed is shown because "how long has it been silent" IS the question a
  // stale row raises — bare "Stale" tells you to investigate without telling
  // you how urgently. "Stale 4h" answers both at once.
  stale: { label: "Stale", tone: "neutral", glyph: "stale", showsElapsed: true, prominent: false },
  failed: { label: "Failed", tone: "red", glyph: "failed", showsElapsed: false, prominent: true },
  stopped: { label: "Stopped", tone: "neutral", glyph: null, showsElapsed: false, prominent: false },
  ended: { label: "Ended", tone: "neutral", glyph: null, showsElapsed: false, prominent: false },
  settled: null,
};

/**
 * Snooze and woke are VISIBILITY OVERLAYS, not phases — `canonicalSessionState`
 * deliberately never reads their columns. They are resolved here, above the
 * phase, because they are what the status slot should say when both are true:
 * a snoozed row's whole story is when it comes back, and a woken row's is that
 * it came back early and why.
 *
 * Precedence matches the filing rule in `isSessionFiledAsSnoozed`: a snooze
 * yields to `needs_you`, so a raised hand is never buried by a ~100-year
 * "until I'm asked" window.
 */
export type SessionStatusOverlay = {
  /** Currently under an unexpired snooze (see `isSessionSnoozed`). */
  snoozed?: boolean;
  /** Woke early and the user has not opened the row yet (see `sessionWokeMarker`). */
  woke?: boolean;
  /** Compact "in 2h" copy for a snoozed row; omitted renders the bare glyph. */
  snoozeWakeLabel?: string | null;
};

export type SessionStatusActivityContext = {
  chatActivityMode?: "planning" | null;
  /** Typed, host-stamped activity: detected from tool calls, or reported by the agent. */
  activityStatus?: SessionActivityReport | null;
  /** Used to reject an agent report left over from an earlier foreground turn. */
  currentTurnStartedAt?: string | null;
  /**
   * Why the session is running, from `canonicalSessionState`. Absent (or
   * `"turn"`) means a live foreground turn and the plain "Working" copy.
   */
  liveness?: SessionLiveness | null;
  /** Live background work, for the "×N" suffix. */
  backgroundWork?: SessionBackgroundWork | null;
  nextWakeAt?: string | null;
  /**
   * A nested subagent still keeps this chat busy (`subagentKeepsParentBusy`).
   * A finished parent then reads Waiting, the same column the board and the
   * lane rollup file it in, because the subagent wakes it when its turn ends.
   */
  subagentBusy?: boolean;
  nowMs?: number;
  /**
   * Host-computed usage-limit resume state (`AgentChatSessionSummary.usageLimitResume`).
   * The row label is derived from it rather than from the deprecated
   * `usageLimitParkedUntil` mirror, so opted-out and no-reset limits — which
   * have no fire instant at all — are still visible in the list.
   */
  usageLimitResume?: AgentChatUsageLimitResume | null;
};

function countSuffix(count: number): string {
  return count > 1 ? ` ×${count}` : "";
}

const REPORTED_ACTIVITY_PRESENTATION: Record<SessionActivityReport["value"], SessionStatusPresentation> = {
  planning: { label: "Planning", tone: "violet", glyph: "planning", showsElapsed: true, prominent: false, activityDetail: true },
  exploring: { label: "Exploring", tone: "blue", glyph: "exploring", showsElapsed: true, prominent: false, activityDetail: true },
  implementing: { label: "Implementing", tone: "blue", glyph: "implementing", showsElapsed: true, prominent: false, activityDetail: true },
  testing: { label: "Testing", tone: "blue", glyph: "testing", showsElapsed: true, prominent: false, activityDetail: true },
  reviewing: { label: "Reviewing", tone: "blue", glyph: "reviewing", showsElapsed: true, prominent: false, activityDetail: true },
  debugging: { label: "Debugging", tone: "blue", glyph: "debugging", showsElapsed: true, prominent: false, activityDetail: true },
  shipping: { label: "Shipping", tone: "blue", glyph: "shipping", showsElapsed: true, prominent: false, activityDetail: true },
  monitoring: { label: "Monitoring", tone: "blue", glyph: "monitoring", showsElapsed: true, prominent: false, activityDetail: true },
  compacting: { label: "Compacting…", tone: "blue", glyph: "working", showsElapsed: true, prominent: false, activityDetail: true },
  compaction_failed: { label: "Compaction failed", tone: "amber", glyph: "failed", showsElapsed: false, prominent: false, activityDetail: true },
  recording: { label: "Recording", tone: "red", glyph: "recording", showsElapsed: true, prominent: false, activityDetail: true },
};

/**
 * The activity to show for a live turn, or null. An agent report is
 * turn-scoped: one from an earlier turn is stale data, possibly from an older
 * peer. A detected one is not — the host clears it whenever the user engages,
 * and it deliberately carries across continuation turns.
 */
function currentActivityReport(
  report: SessionActivityReport | null | undefined,
  currentTurnStartedAt: string | null | undefined,
): SessionActivityReport | null {
  if (!report) return null;
  if (!Number.isFinite(Date.parse(report.updatedAt))) return null;
  if (report.source === "detected") return report;
  return isReportFromTurn(report, currentTurnStartedAt) ? report : null;
}

export function sessionStatusPresentation(
  phase: CanonicalSessionPhase,
  overlay: SessionStatusOverlay = {},
  activity: SessionStatusActivityContext = {},
): SessionStatusPresentation | null {
  // A raised hand outranks both overlays — same precedence as the filing rule,
  // so where the row is filed and what it says can never disagree.
  if (phase === "needs_you") return PHASE_PRESENTATION.needs_you;

  if (overlay.snoozed) {
    return {
      // The return ticket IS the status. Falling back to the bare word keeps
      // the slot meaningful when the caller has no formatted label to hand.
      label: overlay.snoozeWakeLabel?.trim() || "Snoozed",
      tone: "neutral",
      glyph: "snoozed",
      showsElapsed: false,
      prominent: false,
    };
  }

  if (overlay.woke) {
    return { label: "Woke", tone: "amber", glyph: "woke", showsElapsed: false, prominent: true };
  }

  const liveness = activity.liveness ?? "turn";

  // A typed activity (detected or agent-reported) refines a live turn only.
  // When the turn ends, host-observed background work (especially Monitoring)
  // becomes the more current status and must not be hidden by the last one.
  // It never changes the phase; Needs you, snooze, and woke remain
  // higher-priority signals.
  const reportedActivity = (phase === "running" && liveness === "turn") || activity.activityStatus?.value === "compaction_failed"
    ? currentActivityReport(activity.activityStatus, activity.currentTurnStartedAt)
    : null;
  const nativePlanning = phase === "running" && liveness === "turn" && activity.chatActivityMode === "planning";
  const detectedExplorationDuringPlanning = nativePlanning
    && reportedActivity?.source === "detected"
    && reportedActivity.value === "exploring";
  if (reportedActivity && !detectedExplorationDuringPlanning) {
    return {
      ...REPORTED_ACTIVITY_PRESENTATION[reportedActivity.value],
      ...(reportedActivity.value === "compacting" && reportedActivity.contextTokens ? { label: `Compacting… · ${Math.round(reportedActivity.contextTokens / 1000)}k` } : {}),
      activitySource: reportedActivity.source,
      activityUpdatedAt: reportedActivity.updatedAt,
    };
  }

  // Planning is a property of a LIVE TURN. A resting session promoted back to
  // `running` by its background work is not planning anything — its plan-mode
  // flag is just the mode the finished turn ran in.
  if (nativePlanning) {
    return {
      label: "Planning",
      tone: "violet",
      glyph: "planning",
      showsElapsed: true,
      prominent: false,
      activityDetail: true,
    };
  }

  // The turn is over but a backgrounded job outlives it. This previously read
  // as a bare "Working" with no duration, which is indistinguishable from a
  // live turn that has stalled — the row claimed the model was thinking when it
  // had already finished, and offered no elapsed to judge it by. Name the state
  // for what it is and let the row show its elapsed.
  //
  // That elapsed counts from `backgroundWorkSince` — when this session's live
  // background set last went from empty to non-empty — via
  // `sessionElapsedAnchor` below, falling back to last activity for a provider
  // that reports no background level. It is a session-level anchor, NOT any
  // single job's runtime: a second job joining a live set counts from the
  // first one's start. `showsElapsed` also re-enables the breathing
  // animation, which is intended — background work genuinely is a live state.
  if (phase === "running" && liveness !== "turn") {
    const work = activity.backgroundWork;
    // "Monitoring" earns its own word because it answers a different question.
    // Background work might finish on its own; a watch loop will not, so the
    // row is telling you it is safe to walk away — and, once the CI run it is
    // watching lands, that it is yours to close.
    if (liveness === "monitoring") {
      return {
        label: `Monitoring${countSuffix(work?.monitoringCount ?? 0)}`,
        tone: "blue",
        glyph: "monitoring",
        showsElapsed: true,
        prominent: false,
        activityDetail: true,
      };
    }
    return {
      label: `Background work${countSuffix(totalBackgroundWork(work))}`,
      tone: "blue",
      glyph: "working",
      showsElapsed: true,
      prominent: false,
      activityDetail: true,
    };
  }

  // `failed` is included deliberately. A turn that died at a usage limit sets
  // `lastTurnFailedAt`, so `canonicalSessionState` files the row as failed —
  // and a red "Failed" is the wrong story for a chat that is going to resume on
  // its own, or that is holding on a limit. A live limit outranks it; a chat
  // that failed for any other reason has no resume state and still reads red.
  //
  // `usageLimitResumeRowStatus` returns null for `opted_out`/`no_reset`: those
  // states are not waiting for anything, so the row keeps its ordinary
  // failed/idle presentation rather than being quieted into "Limit".
  if (phase === "ready" || phase === "idle" || phase === "failed") {
    const nowMs = activity.nowMs ?? Date.now();
    const resume = resolveUsageLimitResumeState(activity.usageLimitResume, nowMs);
    const rowStatus = usageLimitResumeRowStatus(resume, nowMs);
    if (rowStatus) {
      return {
        label: rowStatus.label,
        // `attention` is the shared vocabulary's name for "this needs a
        // decision"; on this surface that is amber, the same hue `needs_you`
        // uses. It is not red: nothing is broken.
        tone: rowStatus.tone === "attention" ? "amber" : "neutral",
        glyph: rowStatus.glyph,
        showsElapsed: false,
        // A paused streak is the one resume state that wants a person: it
        // stopped trying and will not restart itself. That is the same claim
        // `needs_you` and `woke` make, and they are prominent — a non-prominent
        // amber row is faded to 70% by SessionCard's recede rule, which is
        // exactly the row you must not lose. The neutral countdown states stay
        // quiet: they are going to resume on their own.
        prominent: rowStatus.tone === "attention",
      };
    }
  }

  if (phase === "ready" || phase === "idle") {
    if (
      activity.subagentBusy === true
      || scheduledWakeState(activity.nextWakeAt, activity.nowMs ?? Date.now()) === "pending"
    ) {
      return {
        label: "Waiting",
        tone: "neutral",
        glyph: "waiting",
        showsElapsed: false,
        prominent: false,
      };
    }
  }

  return PHASE_PRESENTATION[phase];
}

/**
 * The ONE elapsed anchor, shared by the desktop status slot and `ade code`'s
 * work list so the two cannot report different durations for the same row.
 *
 * Four anchors, one per kind of "how long":
 *   • a live turn showing an activity ("Testing") counts from when the session
 *     entered that activity. It used to count from the turn start, so a turn
 *     that tested for two minutes after an hour of work read "Testing 1h". The
 *     turn's own total is the chat's "Working…" timer,
 *   • any other live turn counts from `currentTurnStartedAt` — immutable for
 *     the turn, so a CLI repainting its TUI cannot reset it every few seconds,
 *   • background work counts from when that work STARTED. It used to count
 *     from `lastActivityAt`, which every provider frame refreshes: a job that
 *     had been running two hours read "Background work ×2 3s", which is the
 *     same thing a job that started three seconds ago reads. The row could not
 *     tell a long-running commitment from a fresh one, which is exactly the
 *     judgement the elapsed exists to support,
 *   • everything else counts from last activity.
 *
 * `backgroundWorkSince` is runtime-derived and may be absent (a provider with
 * no background level, a summary from an older peer). Falling back to
 * `lastActivityAt` keeps those rows exactly as they read before.
 */
export type SessionElapsedAnchors = {
  currentTurnStartedAt?: string | null;
  lastActivityAt?: string | null;
  startedAt?: string | null;
  backgroundWorkSince?: string | null;
  activityStatus?: SessionActivityReport | null;
};

export function sessionElapsedAnchor(
  session: SessionElapsedAnchors,
  phase: CanonicalSessionPhase,
  liveness: SessionLiveness | null | undefined,
): string | null {
  const lastActivity = session.lastActivityAt ?? session.startedAt ?? null;
  if (phase !== "running") return lastActivity;
  if (liveness && liveness !== "turn") return session.backgroundWorkSince ?? lastActivity;
  const activity = currentActivityReport(session.activityStatus, session.currentTurnStartedAt);
  return activity?.updatedAt ?? session.currentTurnStartedAt ?? lastActivity;
}

/**
 * The already-formatted elapsed a text surface shows beside a status word —
 * "2h" in "Background work ×2 2h".
 *
 * `ade code` and `ade session show` both need a finished string, and each would
 * otherwise re-derive the same three steps (does this presentation want an
 * elapsed, is the anchor parseable, format it). One helper so the two cannot
 * report different durations for the same session. The desktop deliberately
 * does NOT use it: its status slot feeds the raw anchor to a component that
 * ticks, so it wants `sessionElapsedAnchor` instead.
 *
 * Null whenever the presentation does not want an elapsed, or the anchor is
 * missing or unparseable.
 */
export function sessionElapsedLabel(
  session: SessionElapsedAnchors,
  presentation: SessionStatusPresentation | null,
  phase: CanonicalSessionPhase,
  liveness: SessionLiveness | null | undefined,
  nowMs: number,
): string | null {
  if (!presentation?.showsElapsed) return null;
  const anchor = sessionElapsedAnchor(session, phase, liveness);
  const anchorMs = anchor ? Date.parse(anchor) : Number.NaN;
  if (!Number.isFinite(anchorMs)) return null;
  return formatWorkingDuration(Math.max(0, nowMs - anchorMs));
}

/**
 * Tailwind classes per tone, for the desktop renderer. Kept beside the tone
 * definition rather than in the card so the attention center, the header
 * rollup, and the sidebar cannot drift into three different ambers.
 */
export const SESSION_TONE_TEXT_CLASS: Record<SessionStatusTone, string> = {
  blue: "text-sky-400",
  violet: "text-violet-300",
  amber: "text-amber-300",
  emerald: "text-emerald-300",
  red: "text-red-300",
  neutral: "text-muted-fg/60",
};

/**
 * Dot fills for the compact status dot (sidebar rows at `compact`, the lane
 * rollup, dense list surfaces). `settled` has no entry — it renders a hollow
 * ring, which reads as visually "less than" every filled dot and matches its
 * position as the quietest tier.
 */
export const SESSION_TONE_DOT_CLASS: Record<SessionStatusTone, string> = {
  blue: "bg-sky-400",
  violet: "bg-violet-400",
  amber: "bg-amber-300",
  emerald: "bg-emerald-400",
  red: "bg-red-400",
  neutral: "bg-white/30",
};

/**
 * Compact elapsed copy for the "Working 14s" ticker: seconds under a minute,
 * then minutes, then hours. Deliberately lossy above the hour — a turn that has
 * run for 3h14m is reported as "3h", because past that point the exact figure
 * stops changing any decision and the ticking digits are pure noise.
 */
export function formatWorkingDuration(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "";
  const totalSeconds = Math.floor(elapsedMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h`;
  return `${Math.floor(totalHours / 24)}d`;
}

/**
 * How long a LIVE turn may produce no output before ADE calls it stalled.
 *
 * A provider that accepts a request and then stops answering looks identical to
 * a slow one: no error, no result, no event — only silence, and it can stay that
 * way forever. This is the bar at which a surface stops presenting the turn as
 * working and offers a way out. It is a presentation bar, not a kill switch:
 * nothing here stops the turn, because time-based aborts false-positived on
 * genuinely long tool calls (a foreground command emits nothing for minutes).
 */
export const TURN_STALL_AFTER_MS = 5 * 60 * 1000;

/**
 * How long a live turn has been silent, or null when it is not past the bar.
 *
 * The caller supplies a session whose turn is LIVE — this reads the timestamps
 * and answers the silence question, nothing more. `lastProgressAt` is the
 * newest progress event in the transcript (`latestTurnProgressAt`): the live
 * clock, because a renderer's session summary can sit unrefreshed for a whole
 * turn of tool calls. `lastActivityAt` covers a transcript window that has not
 * loaded yet. `currentTurnStartedAt` keeps a turn that has produced nothing at
 * all yet from inheriting the previous turn's quiet stretch, because a turn's
 * silence cannot start before the turn did. The anchor is the latest of the
 * three.
 */
export function turnStallSilenceMs(
  session: { lastActivityAt?: string | null; currentTurnStartedAt?: string | null },
  nowMs: number = Date.now(),
  lastProgressAt: string | null = null,
): number | null {
  const anchorMs = turnSilenceAnchorMs(session, lastProgressAt);
  if (anchorMs == null) return null;
  const silentForMs = nowMs - anchorMs;
  return silentForMs >= TURN_STALL_AFTER_MS ? silentForMs : null;
}

/** When the turn's silence started: the later of its last output and its start. */
export function turnSilenceAnchorMs(
  session: { lastActivityAt?: string | null; currentTurnStartedAt?: string | null },
  lastProgressAt: string | null = null,
): number | null {
  const anchorMs = Math.max(
    ...[session.lastActivityAt, session.currentTurnStartedAt, lastProgressAt].map((value) => {
      const ms = value ? Date.parse(value) : Number.NaN;
      return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
    }),
  );
  return Number.isFinite(anchorMs) ? anchorMs : null;
}

export type TurnStallInput = {
  lastActivityAt?: string | null;
  currentTurnStartedAt?: string | null;
  turnOpenWorkCount?: number | null;
};

/**
 * How long a live turn has been stalled, or null when it is not stalled.
 *
 * Stalled means: a turn is live, it owns no open work (no running command,
 * tool, foreground subagent or pending approval, per the host's fold), and it
 * has been silent past `TURN_STALL_AFTER_MS`. A turn waiting on a long test run
 * owns open work, so it is never called stalled. The caller decides the turn
 * is live (its canonical phase is running); this answers only the stall.
 */
export function sessionTurnStallMs(session: TurnStallInput, nowMs: number = Date.now()): number | null {
  return turnCanStall(session) ? turnStallSilenceMs(session, nowMs) : null;
}

/**
 * A live turn known to own no open work, so silence alone can stall it. A
 * missing count is unknown (a host older than the count), never zero: such a
 * turn may be waiting on a long command, so it is not called stalled.
 */
function turnCanStall(session: TurnStallInput): boolean {
  return Boolean(session.currentTurnStartedAt) && session.turnOpenWorkCount === 0;
}

/**
 * The next instant one of these live turns crosses the stall bar, so a
 * surface can re-evaluate exactly then instead of polling. Null when none can.
 */
export function nextTurnStallDeadlineMs(sessions: Iterable<TurnStallInput>, nowMs: number = Date.now()): number | null {
  let next: number | null = null;
  for (const session of sessions) {
    if (!turnCanStall(session)) continue;
    const anchorMs = turnSilenceAnchorMs(session);
    if (anchorMs == null) continue;
    const deadline = anchorMs + TURN_STALL_AFTER_MS;
    if (deadline <= nowMs) continue;
    if (next === null || deadline < next) next = deadline;
  }
  return next;
}

/**
 * How long a due wake may take to start its turn before the row stops reading
 * as parked on it. The scheduler starts a due wake at the next turn boundary,
 * so a wake a few seconds late is normal; one minutes late may never come.
 */
export const SCHEDULED_WAKE_GRACE_MS = 2 * 60 * 1000;

/**
 * Whether a finished (ready/idle) chat is parked on a scheduled wake.
 *
 * `pending`: a wake is armed and not yet overdue, so the agent will start
 * again on its own. Every surface reads this as Waiting, not Done.
 * `overdue`: the wake is past due by more than the grace and has not started a
 * turn. The scheduler may be paused, down or gone, so the row is Done again and
 * needs a person to look, because the work it promised is not coming by itself.
 *
 * `nextWakeAt` is the host's earliest ARMED, UNPAUSED wake, so a paused
 * schedule is already null here. The caller decides the phase is ready/idle.
 */
export type ScheduledWakeState = "pending" | "overdue";

export function scheduledWakeState(
  nextWakeAt: string | null | undefined,
  nowMs: number = Date.now(),
): ScheduledWakeState | null {
  if (!nextWakeAt) return null;
  const wakeMs = Date.parse(nextWakeAt);
  if (!Number.isFinite(wakeMs)) return null;
  return nowMs < wakeMs + SCHEDULED_WAKE_GRACE_MS ? "pending" : "overdue";
}

/**
 * The next instant one of these wakes turns overdue, so a surface can
 * re-evaluate exactly then instead of polling. Null when none can.
 */
export function nextScheduledWakeDeadlineMs(
  sessions: Iterable<{ nextWakeAt?: string | null }>,
  nowMs: number = Date.now(),
): number | null {
  let next: number | null = null;
  for (const session of sessions) {
    if (!session.nextWakeAt) continue;
    const deadline = Date.parse(session.nextWakeAt) + SCHEDULED_WAKE_GRACE_MS;
    if (!Number.isFinite(deadline) || deadline <= nowMs) continue;
    if (next === null || deadline < next) next = deadline;
  }
  return next;
}

export function formatFutureDuration(timestampMs: number, nowMs: number): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= nowMs) return "";
  const totalMinutes = Math.max(1, Math.ceil((timestampMs - nowMs) / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return minutes ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours ? `${days}d ${hours}h` : `${days}d`;
}
