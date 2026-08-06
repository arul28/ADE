import type {
  AttentionActionKind,
  AttentionItem,
  AttentionPhase,
  AttentionTone,
} from "../../../shared/types";
import { activityItemTier } from "../../../shared/types";
import type { CanonicalSessionPhase } from "../../../shared/sessionCanonicalState";
import { providerDisplayName } from "../../../shared/pendingInputLabels";
import {
  formatWorkingDuration,
  sessionStatusPresentation,
  type SessionStatusGlyph,
  type SessionStatusPresentation,
  type SessionStatusTone,
} from "../../../shared/sessionStatusPresentation";

/**
 * The tone vocabulary itself moved to `shared/types/attention.ts` — the native
 * notch protocol carries it on the wire, so the main process has to name it
 * too. Its meanings, and the reason `violet` and `cyan` exist at all, are
 * documented there. Exactly one phase in this module is amber: `needs_you`.
 */
export type { AttentionTone };

export type ActivityPhasePresentation = {
  label: string;
  tone: AttentionTone;
  /**
   * Liveness, not prominence: drives the pulsing dot on a row whose machine is
   * online. Deliberately NOT the same axis as `SessionStatusPresentation.prominent`
   * (which asks "should this pull the eye"), because a finished run is prominent
   * but must not pulse, and a starting run pulses but must not shout.
   */
  active: boolean;
};

/**
 * `AttentionPhase` is strictly broader than `CanonicalSessionPhase`: it also
 * carries the pull-request lifecycle. The overlap — everything a running agent
 * session can be — is bridged here rather than re-tabulated, so the attention
 * center, the header rollup, and the Work sidebar cannot drift into three
 * different words for the same state. `sessionStatusPresentation.ts` is the
 * authority; this table only says which canonical phase each attention phase
 * stands for.
 *
 * `completed` maps to `ready` because the push wire format collapses
 * `ready`/`idle` into one terminal-but-clean phase, and both read "Done".
 */
const SESSION_PHASE_BY_ATTENTION_PHASE = {
  starting: "starting",
  running: "running",
  needs_you: "needs_you",
  completed: "ready",
  failed: "failed",
  stale: "stale",
} as const satisfies Partial<Record<AttentionPhase, CanonicalSessionPhase>>;

export type SessionDerivedActivityPhase = keyof typeof SESSION_PHASE_BY_ATTENTION_PHASE;

/**
 * Every session-derived attention phase, exported so the regression test that
 * guards the one-hue rule enumerates the real list instead of a copy that can
 * silently fall behind.
 */
export const SESSION_DERIVED_ACTIVITY_PHASES = Object.keys(
  SESSION_PHASE_BY_ATTENTION_PHASE,
) as SessionDerivedActivityPhase[];

/**
 * Only these pulse: a session that is in motion or is actively holding for the
 * user. Everything else is a resting state, and a pulsing dot on a resting row
 * is the progress-report version of the same lie amber used to tell.
 */
const ACTIVE_PHASES = new Set<AttentionPhase>(["starting", "running", "needs_you"]);

/**
 * `sessionStatusPresentation` returns null only for `settled`, which has no
 * attention-phase counterpart and therefore never appears in the bridge table
 * above. The fallback exists so this module stays total rather than throwing
 * during module init — and it is deliberately the quietest presentation there
 * is, because a fallback that could manufacture amber would defeat the rule it
 * is meant to protect.
 */
function requireSessionPresentation(
  phase: CanonicalSessionPhase,
  activity: { chatActivityMode?: "planning" | null } = {},
): SessionStatusPresentation {
  return (
    sessionStatusPresentation(phase, {}, activity)
    ?? { label: "Stale", tone: "neutral", glyph: "stale", showsElapsed: true, prominent: false }
  );
}

/**
 * The boundary check for the one optional field a publisher may add to an item
 * that this module trusts. Anything other than the single literal is treated as
 * absent, so a future value from a newer publisher degrades to the phase rather
 * than painting an unstyled tone.
 */
export function activityChatMode(item: AttentionItem): "planning" | null {
  return item.chatActivityMode === "planning" ? "planning" : null;
}

function sessionDerivedPresentation(
  phase: SessionDerivedActivityPhase,
): ActivityPhasePresentation {
  const presentation = requireSessionPresentation(SESSION_PHASE_BY_ATTENTION_PHASE[phase]);
  // This annotated assignment is what enforces `SessionStatusTone ⊆ AttentionTone`
  // at compile time: add a hue to the session vocabulary that Attention has no
  // colour for and this line stops compiling, rather than silently rendering an
  // unstyled tone class.
  const tone: AttentionTone = presentation.tone;
  return { label: presentation.label, tone, active: ACTIVE_PHASES.has(phase) };
}

const SESSION_DERIVED_PRESENTATION = Object.fromEntries(
  SESSION_DERIVED_ACTIVITY_PHASES.map((phase) => [phase, sessionDerivedPresentation(phase)]),
) as Record<SessionDerivedActivityPhase, ActivityPhasePresentation>;

/**
 * Phases with no session counterpart — the pull-request lifecycle. Amber does
 * not appear here at all, which leaves `needs_you` as the only amber in the
 * whole module.
 *
 * `blocked` is the one that looks like it should be amber and is not, and the
 * sharpest fact about it is that NOTHING EMITS IT AT ALL. The sole publisher,
 * `apps/ade-cli/src/services/push/pushPublisherService.ts`, maps phases through
 * two closed, exhaustive functions — `agentAttentionPhase()` and
 * `prAttentionState()` — and neither can produce `blocked` on either side. It
 * has no `AttentionEventKind` either. It entered the union speculatively and its
 * only occurrence in the repo is a test fixture; it is a deletion candidate,
 * left in place only because removing it would change the push wire contract.
 *
 * So its tone is decided by what the word means everywhere else in the product:
 * MERGE blocked, not "your move". `attentionPhasePriority` files it at tier 2
 * beside `review_requested` and `merge_ready` rather than with `needs_you` at
 * tier 0, and both the header rollup and the `ade code` TUI group it under
 * "Failing or blocked" — a different group from "Needs you". A PR blocked on
 * branch policy, CI, or someone else's approval is frequently something the
 * reader cannot clear at all, so it makes no claim on them.
 *
 * `activityPriority.ts` files it in the needs-you band on phase priority alone,
 * which is the closest thing to a decision anyone can make about a phase with
 * no producer. Its tone stays neutral here, so it can never paint amber.
 */
const NON_SESSION_PRESENTATION: Record<
  Exclude<AttentionPhase, SessionDerivedActivityPhase>,
  ActivityPhasePresentation & { tone: SessionStatusTone }
> = {
  blocked: { label: "Blocked", tone: "neutral", active: false },
  checks_failing: { label: "Checks failing", tone: "red", active: false },
  review_requested: { label: "Review requested", tone: "violet", active: false },
  changes_requested: { label: "Changes requested", tone: "red", active: false },
  merge_ready: { label: "Ready to merge", tone: "emerald", active: false },
  open: { label: "Open", tone: "blue", active: false },
  merged: { label: "Merged", tone: "emerald", active: false },
  closed: { label: "Closed", tone: "neutral", active: false },
};

const PHASE_PRESENTATION: Record<AttentionPhase, ActivityPhasePresentation> = {
  ...SESSION_DERIVED_PRESENTATION,
  ...NON_SESSION_PRESENTATION,
};

export function activityPhasePresentation(phase: AttentionPhase): ActivityPhasePresentation {
  return PHASE_PRESENTATION[phase];
}

const NON_SESSION_STATUS_DETAILS: Record<
  Exclude<AttentionPhase, SessionDerivedActivityPhase>,
  Pick<SessionStatusPresentation, "glyph" | "showsElapsed" | "prominent">
> = {
  blocked: { glyph: null, showsElapsed: false, prominent: false },
  checks_failing: { glyph: "failed", showsElapsed: false, prominent: true },
  review_requested: { glyph: null, showsElapsed: false, prominent: true },
  changes_requested: { glyph: "failed", showsElapsed: false, prominent: true },
  merge_ready: { glyph: "done", showsElapsed: false, prominent: true },
  open: { glyph: null, showsElapsed: false, prominent: false },
  merged: { glyph: "done", showsElapsed: false, prominent: true },
  closed: { glyph: null, showsElapsed: false, prominent: false },
};

/**
 * Projects every Activity item into the same full status vocabulary used by a
 * Work session row. Session phases delegate directly; PR-only phases add only
 * the glyph/elapsed/prominence fields that the older phase presentation did
 * not need.
 */
export function activityItemPresentation(
  item: AttentionItem,
): SessionStatusPresentation | null {
  if (activityPhaseIsSessionDerived(item.phase)) {
    return requireSessionPresentation(
      SESSION_PHASE_BY_ATTENTION_PHASE[item.phase],
      { chatActivityMode: activityChatMode(item) },
    );
  }
  const presentation = NON_SESSION_PRESENTATION[item.phase];
  const details = NON_SESSION_STATUS_DETAILS[item.phase];
  const glyph: SessionStatusGlyph = details.glyph;
  return {
    label: presentation.label,
    tone: presentation.tone,
    glyph,
    showsElapsed: details.showsElapsed,
    prominent: details.prominent,
  };
}

export function activityPhaseIsSessionDerived(
  phase: AttentionPhase,
): phase is SessionDerivedActivityPhase {
  return phase in SESSION_PHASE_BY_ATTENTION_PHASE;
}

/* ── The state glyph language ──────────────────────────────────────────────
   Five states, one glyph and one hue each. This is the canonical table; the
   notch strip, the iOS widget rows and the Live Activity all mirror it, so a
   change here is a change everywhere and must be made here first.

   It exists because the surfaces that summarise Activity had nothing to
   summarise WITH: a row of repeated provider logos says "three Claudes" when
   the useful sentence is "one is asking you something and two are working".
   A glyph plus a count reads at a glance and survives being 14px wide.

   The hues are the same one-hue-one-meaning table as everywhere else — amber is
   "your move" and is spent nowhere else, and `cyan` is never handed to a
   session state (see the tone doc in `shared/types/attention.ts`). `planning`
   takes violet, which it shares with an outstanding review: both mean "someone
   is deliberating", neither means the reader must act. ────────────────────── */

export type ActivityStateGroup =
  | "needs-you"
  | "failed"
  | "planning"
  | "working"
  | "done";

export type ActivityStateGlyph = {
  /** Section heading and count-group label. */
  label: string;
  tone: AttentionTone;
  /**
   * Shared glyph identity, mapped to Phosphor by `ActivityStateGlyphMark` and
   * to SF Symbols by the iOS mirror. `needs-you` is the filled dot — the one
   * urgent mark — and `failed` is the warning triangle rather than the bare
   * word the session row gets away with, because a count group has no room for
   * a word at all.
   */
  glyph: Exclude<SessionStatusGlyph, null>;
};

export const ACTIVITY_STATE_GLYPHS = {
  "needs-you": { label: "Needs you", tone: "amber", glyph: "needs-you" },
  failed: { label: "Failed", tone: "red", glyph: "failed" },
  planning: { label: "Planning", tone: "violet", glyph: "planning" },
  working: { label: "Working", tone: "blue", glyph: "working" },
  done: { label: "Done", tone: "emerald", glyph: "done" },
} as const satisfies Record<ActivityStateGroup, ActivityStateGlyph>;

/** Priority order — the order the strip, the sections, and the counts use. */
export const ACTIVITY_STATE_GROUPS = [
  "needs-you",
  "failed",
  "planning",
  "working",
  "done",
] as const satisfies readonly ActivityStateGroup[];

/**
 * Which state group an item belongs to. Idle-tier rows are quiet history no
 * matter what phase they preserved, so they land in `done`. This is the only
 * place the rule is written: section headings, glyph counts, and the notch all
 * call it, so "what is this row" has exactly one answer.
 */
export function activityStateGroup(item: AttentionItem): ActivityStateGroup {
  if (activityItemTier(item) === "idle") return "done";
  switch (item.phase) {
    case "needs_you":
      return "needs-you";
    case "failed":
    case "checks_failing":
    case "changes_requested":
      return "failed";
    case "starting":
    case "running":
      return activityChatMode(item) === "planning" ? "planning" : "working";
    case "stale":
    case "open":
      return "working";
    case "review_requested":
    case "merge_ready":
    case "blocked":
      // Someone else's move, not the reader's: filed with the live band so it
      // cannot borrow the amber "needs you" heading.
      return "working";
    default:
      return "done";
  }
}

/**
 * The one-line answer to "what is this agent doing", for the detail sheet.
 * Reads as a sentence about a named agent — "Claude is asking a question" —
 * because the sheet's whole job in v1 is to say the state plainly and offer the
 * chat. Pull requests get the phase label instead: there is no agent to name.
 */
export function activityStateSentence(item: AttentionItem): string {
  if (item.kind === "pull_request") {
    return activityItemPresentation(item)?.label ?? "Tracked";
  }
  const who = providerDisplayName(item.provider);
  switch (activityStateGroup(item)) {
    case "needs-you":
      return `${who} is asking a question`;
    case "failed":
      return `${who} stopped on an error`;
    case "planning":
      return `${who} is planning`;
    case "working":
      return item.phase === "stale"
        ? `${who} has gone quiet`
        : `${who} is working`;
    case "done":
      return `${who} is done`;
  }
}

/**
 * "needs you for 4m". `statusSince` is immutable for the life of a phase, so
 * this is elapsed time in the STATE rather than time since the last cosmetic
 * republish — the distinction that keeps the sheet from resetting every poll.
 */
export function activityStateElapsed(
  item: AttentionItem,
  now = Date.now(),
): string | null {
  const since = item.statusSince ?? item.occurredAt;
  const sinceMs = since ? Date.parse(since) : Number.NaN;
  if (!Number.isFinite(sinceMs) || sinceMs > now) return null;
  const elapsed = formatWorkingDuration(now - sinceMs);
  return elapsed || null;
}

export function activityActionTone(
  kind: AttentionActionKind,
): "primary" | "danger" | "secondary" | "ghost" {
  if (kind === "approve" || kind === "answer" || kind === "rerun_checks") return "primary";
  if (kind === "deny") return "danger";
  if (kind === "open" || kind === "restart") return "secondary";
  return "ghost";
}
