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
  | "planning"
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
};

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
  /**
   * Why the session is running, from `canonicalSessionState`. Absent (or
   * `"turn"`) means a live foreground turn and the plain "Working" copy.
   */
  liveness?: SessionLiveness | null;
  /** Live background work, for the "×N" suffix. */
  backgroundWork?: SessionBackgroundWork | null;
  nextWakeAt?: string | null;
  nowMs?: number;
};

function countSuffix(count: number): string {
  return count > 1 ? ` ×${count}` : "";
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

  // Planning is a property of a LIVE TURN. A resting session promoted back to
  // `running` by its background work is not planning anything — its plan-mode
  // flag is just the mode the finished turn ran in.
  const liveness = activity.liveness ?? "turn";
  if (phase === "running" && liveness === "turn" && activity.chatActivityMode === "planning") {
    return {
      label: "Planning",
      tone: "violet",
      glyph: "planning",
      showsElapsed: true,
      prominent: false,
    };
  }

  // The turn is over but a backgrounded job outlives it. This previously read
  // as a bare "Working" with no duration, which is indistinguishable from a
  // live turn that has stalled — the row claimed the model was thinking when it
  // had already finished, and offered no elapsed to judge it by. Name the state
  // for what it is and let the row show its elapsed.
  //
  // That elapsed is time since the session's last activity (the caller supplies
  // the anchor — see `SessionStatusSlot`), NOT the job's own runtime, which is
  // not in the session summary. It is a proxy: a job launched early in a long
  // turn reads ~0s at turn end. `showsElapsed` also re-enables the breathing
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
      };
    }
    return {
      label: `Background work${countSuffix(totalBackgroundWork(work))}`,
      tone: "blue",
      glyph: "working",
      showsElapsed: true,
      prominent: false,
    };
  }

  if ((phase === "ready" || phase === "idle") && activity.nextWakeAt) {
    const wakeAt = Date.parse(activity.nextWakeAt);
    if (Number.isFinite(wakeAt) && wakeAt > (activity.nowMs ?? Date.now())) {
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
