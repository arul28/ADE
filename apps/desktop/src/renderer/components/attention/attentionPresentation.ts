import type {
  AttentionActionKind,
  AttentionItem,
  AttentionPhase,
} from "../../../shared/types";
import type { CanonicalSessionPhase } from "../../../shared/sessionCanonicalState";
import {
  sessionStatusPresentation,
  type SessionStatusGlyph,
  type SessionStatusPresentation,
  type SessionStatusTone,
} from "../../../shared/sessionStatusPresentation";

/**
 * Attention's tone vocabulary is `sessionStatusPresentation`'s five hues plus
 * two that only pull requests ever use. The session five keep their meanings
 * exactly — see the one-hue-one-meaning rule in
 * `apps/desktop/src/shared/sessionStatusPresentation.ts`:
 *
 *   blue     work is happening, nothing is asked of you
 *   amber    YOUR MOVE — and nothing else, ever
 *   emerald  finished cleanly, you have not looked yet
 *   red      it broke
 *   neutral  true, but not actionable
 *
 * Exactly one phase in this module is amber: `needs_you`.
 *
 * `violet` carries "a human review is outstanding" — neither "your move" (it is
 * usually someone else's) nor an outcome, and without its own hue it would have
 * to borrow amber, which is precisely the erosion the rule forbids. `cyan` is
 * currently unused by any phase; it stays in the union and the stylesheets as
 * the spare for the next PR-side distinction, and must never be handed to a
 * session state — those five hues are settled.
 */
export type AttentionTone =
  | "amber"
  | "red"
  | "violet"
  | "blue"
  | "cyan"
  | "emerald"
  | "neutral";

export type AttentionPhasePresentation = {
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

export type SessionDerivedAttentionPhase = keyof typeof SESSION_PHASE_BY_ATTENTION_PHASE;

/**
 * Every session-derived attention phase, exported so the regression test that
 * guards the one-hue rule enumerates the real list instead of a copy that can
 * silently fall behind.
 */
export const SESSION_DERIVED_ATTENTION_PHASES = Object.keys(
  SESSION_PHASE_BY_ATTENTION_PHASE,
) as SessionDerivedAttentionPhase[];

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
function requireSessionPresentation(phase: CanonicalSessionPhase): SessionStatusPresentation {
  return (
    sessionStatusPresentation(phase)
    ?? { label: "Stale", tone: "neutral", glyph: "stale", showsElapsed: true, prominent: false }
  );
}

function sessionDerivedPresentation(
  phase: SessionDerivedAttentionPhase,
): AttentionPhasePresentation {
  const presentation = requireSessionPresentation(SESSION_PHASE_BY_ATTENTION_PHASE[phase]);
  // This annotated assignment is what enforces `SessionStatusTone ⊆ AttentionTone`
  // at compile time: add a hue to the session vocabulary that Attention has no
  // colour for and this line stops compiling, rather than silently rendering an
  // unstyled tone class.
  const tone: AttentionTone = presentation.tone;
  return { label: presentation.label, tone, active: ACTIVE_PHASES.has(phase) };
}

const SESSION_DERIVED_PRESENTATION = Object.fromEntries(
  SESSION_DERIVED_ATTENTION_PHASES.map((phase) => [phase, sessionDerivedPresentation(phase)]),
) as Record<SessionDerivedAttentionPhase, AttentionPhasePresentation>;

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
 * NOTE: `attentionHeaderSummary.ts` still files `blocked` into the red
 * "Failing or blocked" bucket. That disagreement with the neutral tone here is
 * known and deliberately left for now — reconciling a phase that has no
 * producer would be two speculative changes instead of one documented one.
 */
const NON_SESSION_PRESENTATION: Record<
  Exclude<AttentionPhase, SessionDerivedAttentionPhase>,
  AttentionPhasePresentation & { tone: SessionStatusTone }
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

const PHASE_PRESENTATION: Record<AttentionPhase, AttentionPhasePresentation> = {
  ...SESSION_DERIVED_PRESENTATION,
  ...NON_SESSION_PRESENTATION,
};

export function attentionPhasePresentation(phase: AttentionPhase): AttentionPhasePresentation {
  return PHASE_PRESENTATION[phase];
}

const NON_SESSION_STATUS_DETAILS: Record<
  Exclude<AttentionPhase, SessionDerivedAttentionPhase>,
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
  if (attentionPhaseIsSessionDerived(item.phase)) {
    return requireSessionPresentation(SESSION_PHASE_BY_ATTENTION_PHASE[item.phase]);
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

export function attentionPhaseIsSessionDerived(
  phase: AttentionPhase,
): phase is SessionDerivedAttentionPhase {
  return phase in SESSION_PHASE_BY_ATTENTION_PHASE;
}

export function attentionActionTone(
  kind: AttentionActionKind,
): "primary" | "danger" | "secondary" | "ghost" {
  if (kind === "approve" || kind === "answer" || kind === "rerun_checks") return "primary";
  if (kind === "deny") return "danger";
  if (kind === "open" || kind === "restart") return "secondary";
  return "ghost";
}

export function attentionViewEmptyCopy(view: "live" | "inbox" | "recent"): {
  title: string;
  body: string;
} {
  if (view === "inbox") {
    return {
      title: "You’re all caught up",
      body: "Approvals, failures, review requests, and finished work you haven’t seen will collect here.",
    };
  }
  if (view === "recent") {
    return {
      // "Done" rather than "Completed": the pill on these rows says Done, and
      // prose that uses a different word for the same state is how a vocabulary
      // starts to fray.
      title: "No recent outcomes",
      body: "Done and resolved work stays here for 24 hours after you review it.",
    };
  }
  return {
    title: "No live work yet",
    body: "Active agents and pull requests from every signed-in machine will appear here as they move.",
  };
}
