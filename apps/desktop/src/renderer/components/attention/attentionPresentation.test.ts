import { describe, expect, it } from "vitest";

import {
  attentionPhasePriority,
  type AttentionItem,
  type AttentionPhase,
} from "../../../shared/types";
import type { CanonicalSessionPhase } from "../../../shared/sessionCanonicalState";
import { sessionStatusPresentation } from "../../../shared/sessionStatusPresentation";
import {
  attentionPhaseIsSessionDerived,
  attentionPhasePresentation,
  attentionViewEmptyCopy,
  activityItemPresentation,
  SESSION_DERIVED_ATTENTION_PHASES,
  type AttentionTone,
} from "./attentionPresentation";

/**
 * Written as an exhaustive record rather than an array so a new `AttentionPhase`
 * cannot slip past the amber guard below: adding one to the union without
 * listing it here is a type error, not a silently unchecked phase.
 */
const ALL_ATTENTION_PHASES = Object.keys({
  starting: true,
  running: true,
  needs_you: true,
  blocked: true,
  failed: true,
  completed: true,
  stale: true,
  checks_failing: true,
  review_requested: true,
  changes_requested: true,
  merge_ready: true,
  open: true,
  merged: true,
  closed: true,
} satisfies Record<AttentionPhase, true>) as AttentionPhase[];

/**
 * The only phase allowed to be amber, anywhere in Attention: a raised hand.
 * `blocked` is deliberately absent — it means MERGE blocked (tier 2 in
 * `attentionPhasePriority`, grouped under "Failing or blocked", never published
 * for an agent session), which is not a claim on the reader.
 */
const AMBER_ALLOWLIST: AttentionPhase[] = ["needs_you"];

describe("attention phase presentation", () => {
  it("speaks the sidebar's words for every session-derived phase", () => {
    // Not a hand-copied table: each expectation is the phase's canonical
    // counterpart, so a wording change in sessionStatusPresentation.ts either
    // flows through both surfaces or fails here.
    const bridge: Record<string, CanonicalSessionPhase> = {
      starting: "starting",
      running: "running",
      needs_you: "needs_you",
      completed: "ready",
      failed: "failed",
      stale: "stale",
    };

    expect(SESSION_DERIVED_ATTENTION_PHASES.slice().sort())
      .toEqual(Object.keys(bridge).sort());

    for (const [attentionPhase, canonicalPhase] of Object.entries(bridge)) {
      const canonical = sessionStatusPresentation(canonicalPhase);
      const attention = attentionPhasePresentation(attentionPhase as AttentionPhase);
      expect(canonical).not.toBeNull();
      expect(attention.label).toBe(canonical?.label);
      expect(attention.tone).toBe(canonical?.tone);
    }
  });

  it("returns the complete canonical status presentation for every session-derived phase", () => {
    const bridge: Record<string, CanonicalSessionPhase> = {
      starting: "starting",
      running: "running",
      needs_you: "needs_you",
      completed: "ready",
      failed: "failed",
      stale: "stale",
    };

    for (const [attentionPhase, canonicalPhase] of Object.entries(bridge)) {
      expect(activityItemPresentation({ phase: attentionPhase } as AttentionItem))
        .toEqual(sessionStatusPresentation(canonicalPhase));
    }
  });

  it("returns a complete status presentation for every PR-only phase", () => {
    for (const phase of ALL_ATTENTION_PHASES.filter(
      (candidate) => !attentionPhaseIsSessionDerived(candidate),
    )) {
      const presentation = activityItemPresentation({ phase } as AttentionItem);
      expect(presentation).toMatchObject({
        label: attentionPhasePresentation(phase).label,
        tone: attentionPhasePresentation(phase).tone,
        showsElapsed: false,
      });
    }
  });

  it("labels work in motion 'Working' and clean outcomes 'Done'", () => {
    // The two renames the sidebar redesign turned on. Asserted literally as
    // well as via the bridge above, because these exact words appear in
    // notification copy and in the iOS mirror — a silent drift here desyncs
    // three surfaces at once.
    expect(attentionPhasePresentation("running")).toEqual({
      label: "Working",
      tone: "blue",
      active: true,
    });
    expect(attentionPhasePresentation("completed")).toEqual({
      label: "Done",
      tone: "emerald",
      active: false,
    });
    expect(attentionPhasePresentation("starting").label).toBe("Starting");
    expect(attentionPhasePresentation("needs_you").label).toBe("Needs you");
    expect(attentionPhasePresentation("failed").label).toBe("Failed");
    expect(attentionPhasePresentation("stale").label).toBe("Stale");
  });

  /**
   * The guard on the one-hue-one-meaning rule. Amber used to carry five
   * unrelated meanings on a single row; the fix only holds if adding a sixth is
   * loud. If this fails, do not extend the allowlist — find another hue, or
   * decide the state genuinely is "your move" and say so in the test.
   */
  it("spends amber only on states that need the user to act", () => {
    const amberPhases = ALL_ATTENTION_PHASES.filter(
      (phase) => attentionPhasePresentation(phase).tone === "amber",
    );
    expect(amberPhases.sort()).toEqual(AMBER_ALLOWLIST.slice().sort());
  });

  it("keeps every session-derived phase out of amber unless it is a raised hand", () => {
    for (const phase of SESSION_DERIVED_ATTENTION_PHASES) {
      if (phase === "needs_you") {
        expect(attentionPhasePresentation(phase).tone).toBe("amber");
        continue;
      }
      expect(attentionPhasePresentation(phase).tone).not.toBe("amber");
    }
  });

  it("keeps the deliberate deviations from the old vocabulary", () => {
    // `completed` is emerald, not amber: "finished, go look" must not wear the
    // same colour as "blocked, go act".
    expect(attentionPhasePresentation("completed").tone).toBe("emerald");
    // `stale` is neutral, not amber and not blue: a silent process is true but
    // not actionable, and calling it live was the lie the old green dot told.
    expect(attentionPhasePresentation("stale").tone).toBe("neutral");
    expect(attentionPhasePresentation("stale").active).toBe(false);
    // `failed` keeps red, so red still means exactly one thing: it broke.
    expect(attentionPhasePresentation("failed").tone).toBe("red");
  });

  it("returns a presentation for every phase and pulses only live ones", () => {
    const active = ALL_ATTENTION_PHASES.filter(
      (phase) => attentionPhasePresentation(phase).active,
    );
    expect(active.sort()).toEqual(["needs_you", "running", "starting"]);
    for (const phase of ALL_ATTENTION_PHASES) {
      expect(attentionPhasePresentation(phase).label.length).toBeGreaterThan(0);
    }
  });

  it("knows which phases came from a session and which are pull-request only", () => {
    expect(attentionPhaseIsSessionDerived("running")).toBe(true);
    expect(attentionPhaseIsSessionDerived("completed")).toBe(true);
    expect(attentionPhaseIsSessionDerived("merge_ready")).toBe(false);
    expect(attentionPhaseIsSessionDerived("blocked")).toBe(false);
  });

  it("never colours a pull-request phase amber", () => {
    const prTones: AttentionTone[] = ALL_ATTENTION_PHASES
      .filter((phase) => !attentionPhaseIsSessionDerived(phase))
      .map((phase) => attentionPhasePresentation(phase).tone);
    expect(prTones).not.toContain("amber");
  });

  it("reads a merge-blocked pull request as neutral, not as a raised hand", () => {
    // `blocked` is the phase most likely to be re-promoted to amber by someone
    // reading the word alone. Its priority tier is the argument against that:
    // it sits with review_requested and merge_ready, not with needs_you.
    expect(attentionPhasePresentation("blocked")).toEqual({
      label: "Blocked",
      tone: "neutral",
      active: false,
    });
    expect(attentionPhasePriority("blocked")).toBe(attentionPhasePriority("merge_ready"));
    expect(attentionPhasePriority("blocked")).toBeGreaterThan(
      attentionPhasePriority("needs_you"),
    );
  });

  it("uses the row's own word for finished work in empty-state copy", () => {
    const recent = attentionViewEmptyCopy("recent");
    expect(recent.body).toContain("Done");
    expect(recent.body).not.toMatch(/completed/i);
  });
});
