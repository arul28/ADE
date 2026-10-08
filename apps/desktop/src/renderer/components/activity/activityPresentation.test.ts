import { describe, expect, it } from "vitest";

import {
  attentionPhasePriority,
  type AttentionItem,
  type AttentionPhase,
} from "../../../shared/types";
import type { CanonicalSessionPhase } from "../../../shared/sessionCanonicalState";
import { sessionStatusPresentation } from "../../../shared/sessionStatusPresentation";
import {
  ACTIVITY_COLUMN_PRESENTATION,
  ACTIVITY_COLUMNS,
  activityPhaseIsSessionDerived,
  activityPhasePresentation,
  activityItemPresentation,
  activityRowStatus,
  activityStateElapsed,
  activityStateSentence,
  activityWaitingReasonLabel,
  SESSION_DERIVED_ACTIVITY_PHASES,
  type AttentionTone,
} from "./activityPresentation";

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

describe("Activity phase presentation", () => {
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

    expect(SESSION_DERIVED_ACTIVITY_PHASES.slice().sort())
      .toEqual(Object.keys(bridge).sort());

    for (const [attentionPhase, canonicalPhase] of Object.entries(bridge)) {
      const canonical = sessionStatusPresentation(canonicalPhase);
      const attention = activityPhasePresentation(attentionPhase as AttentionPhase);
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
      (candidate) => !activityPhaseIsSessionDerived(candidate),
    )) {
      const presentation = activityItemPresentation({ phase } as AttentionItem);
      expect(presentation).toMatchObject({
        label: activityPhasePresentation(phase).label,
        tone: activityPhasePresentation(phase).tone,
        showsElapsed: false,
      });
    }
  });

  it("labels work in motion 'Working' and clean outcomes 'Done'", () => {
    // The two renames the sidebar redesign turned on. Asserted literally as
    // well as via the bridge above, because these exact words appear in
    // notification copy and in the iOS mirror — a silent drift here desyncs
    // three surfaces at once.
    expect(activityPhasePresentation("running")).toEqual({
      label: "Working",
      tone: "blue",
      active: true,
    });
    expect(activityPhasePresentation("completed")).toEqual({
      label: "Done",
      tone: "emerald",
      active: false,
    });
    expect(activityPhasePresentation("starting").label).toBe("Starting");
    expect(activityPhasePresentation("needs_you").label).toBe("Needs you");
    expect(activityPhasePresentation("failed").label).toBe("Failed");
    expect(activityPhasePresentation("stale").label).toBe("Stale");
  });

  /**
   * The guard on the one-hue-one-meaning rule. Amber used to carry five
   * unrelated meanings on a single row; the fix only holds if adding a sixth is
   * loud. If this fails, do not extend the allowlist — find another hue, or
   * decide the state genuinely is "your move" and say so in the test.
   */
  it("spends amber only on states that need the user to act", () => {
    const amberPhases = ALL_ATTENTION_PHASES.filter(
      (phase) => activityPhasePresentation(phase).tone === "amber",
    );
    expect(amberPhases.sort()).toEqual(AMBER_ALLOWLIST.slice().sort());
  });

  it("keeps every session-derived phase out of amber unless it is a raised hand", () => {
    for (const phase of SESSION_DERIVED_ACTIVITY_PHASES) {
      if (phase === "needs_you") {
        expect(activityPhasePresentation(phase).tone).toBe("amber");
        continue;
      }
      expect(activityPhasePresentation(phase).tone).not.toBe("amber");
    }
  });

  it("keeps the deliberate deviations from the old vocabulary", () => {
    // `completed` is emerald, not amber: "finished, go look" must not wear the
    // same colour as "blocked, go act".
    expect(activityPhasePresentation("completed").tone).toBe("emerald");
    // `stale` is neutral, not amber and not blue: a silent process is true but
    // not actionable, and calling it live was the lie the old green dot told.
    expect(activityPhasePresentation("stale").tone).toBe("neutral");
    expect(activityPhasePresentation("stale").active).toBe(false);
    // `failed` keeps red, so red still means exactly one thing: it broke.
    expect(activityPhasePresentation("failed").tone).toBe("red");
  });

  it("returns a presentation for every phase and pulses only live ones", () => {
    const active = ALL_ATTENTION_PHASES.filter(
      (phase) => activityPhasePresentation(phase).active,
    );
    expect(active.sort()).toEqual(["needs_you", "running", "starting"]);
    for (const phase of ALL_ATTENTION_PHASES) {
      expect(activityPhasePresentation(phase).label.length).toBeGreaterThan(0);
    }
  });

  it("knows which phases came from a session and which are pull-request only", () => {
    expect(activityPhaseIsSessionDerived("running")).toBe(true);
    expect(activityPhaseIsSessionDerived("completed")).toBe(true);
    expect(activityPhaseIsSessionDerived("merge_ready")).toBe(false);
    expect(activityPhaseIsSessionDerived("blocked")).toBe(false);
  });

  it("never colours a pull-request phase amber", () => {
    const prTones: AttentionTone[] = ALL_ATTENTION_PHASES
      .filter((phase) => !activityPhaseIsSessionDerived(phase))
      .map((phase) => activityPhasePresentation(phase).tone);
    expect(prTones).not.toContain("amber");
  });

  it("reads a merge-blocked pull request as neutral, not as a raised hand", () => {
    // `blocked` is the phase most likely to be re-promoted to amber by someone
    // reading the word alone. Its priority tier is the argument against that:
    // it sits with review_requested and merge_ready, not with needs_you.
    expect(activityPhasePresentation("blocked")).toEqual({
      label: "Blocked",
      tone: "neutral",
      active: false,
    });
    expect(attentionPhasePriority("blocked")).toBe(attentionPhasePriority("merge_ready"));
    expect(attentionPhasePriority("blocked")).toBeGreaterThan(
      attentionPhasePriority("needs_you"),
    );
  });
});

/**
 * Activity groups agents by the Work board's four columns. The column a row
 * sits in comes from `activityBoardColumn` (pinned by its own cross-language
 * fixture); these are the rules for how a column and a row in it read.
 */
describe("Activity columns", () => {
  it("names the four columns in board order, one hue each, amber only for Needs you", () => {
    expect(ACTIVITY_COLUMNS.map((column) => [
      column,
      ACTIVITY_COLUMN_PRESENTATION[column].label,
      ACTIVITY_COLUMN_PRESENTATION[column].tone,
    ])).toEqual([
      ["needs_you", "Needs you", "amber"],
      ["working", "Working", "blue"],
      ["waiting", "Waiting", "neutral"],
      ["done", "Done", "emerald"],
    ]);
    const tones = ACTIVITY_COLUMNS.map((column) => ACTIVITY_COLUMN_PRESENTATION[column].tone);
    expect(new Set(tones).size).toBe(tones.length);
    expect(tones).not.toContain("cyan");
  });

  /**
   * A row reads its column, not its phase: a failure sits under Needs you but
   * keeps a red Failed mark, and a running agent whose lane waits on CI reads
   * Waiting with its reason, matching the heading above it.
   */
  it.each([
    ["a raised hand", { phase: "needs_you" }, "Needs you", "amber", null],
    ["a failure, with its red mark", { phase: "failed" }, "Failed", "red", null],
    ["a running turn", { phase: "running" }, "Working", "blue", null],
    ["a planning turn, folded into Working", { phase: "running", chatActivityMode: "planning" }, "Working", "blue", null],
    ["a running turn waiting on CI", { phase: "running", boardColumn: "waiting", waitingReason: "ci" }, "Waiting", "neutral", "CI running"],
    ["a snoozed session", { phase: "stale", boardColumn: "waiting", waitingReason: "snoozed" }, "Waiting", "neutral", "Snoozed"],
    ["a requested review", { phase: "completed", boardColumn: "waiting", waitingReason: "review" }, "Waiting", "neutral", "Review requested"],
    ["a session gone quiet, folded into Done", { phase: "running", activityTier: "idle" }, "Done", "emerald", null],
    ["a finished turn", { phase: "completed" }, "Done", "emerald", null],
  ] as const)("reads %s", (_name, patch, label, tone, reason) => {
    const item = { kind: "agent", ...patch } as unknown as AttentionItem;
    const status = activityRowStatus(item);
    expect(status?.label).toBe(label);
    expect(status?.tone).toBe(tone);
    expect(activityWaitingReasonLabel(item)).toBe(reason);
  });

  it("keeps a pull request on its own phase vocabulary, outside the columns", () => {
    const pr = { kind: "pull_request", phase: "checks_failing" } as AttentionItem;
    expect(activityRowStatus(pr)).toMatchObject({ label: "Checks failing", tone: "red" });
    expect(activityWaitingReasonLabel(pr)).toBeNull();
    expect(activityStateSentence(pr)).toBe("Checks failing");
  });

  it("reads a planning turn with the sidebar's own words", () => {
    const presentation = activityItemPresentation({
      phase: "running",
      kind: "agent",
      chatActivityMode: "planning",
    } as AttentionItem);
    expect(presentation).toMatchObject({ label: "Planning", tone: "violet", glyph: "planning" });
  });

  it("says the state as a sentence about a named agent", () => {
    const sentence = (phase: AttentionPhase, patch: Partial<AttentionItem> = {}) =>
      activityStateSentence({
        phase,
        kind: "agent",
        provider: "claude",
        ...patch,
      } as AttentionItem);

    expect(sentence("needs_you")).toBe("Claude needs you");
    expect(sentence("failed")).toBe("Claude stopped on an error");
    expect(sentence("running")).toBe("Claude is working");
    expect(sentence("running", { boardColumn: "waiting", waitingReason: "ci" })).toBe("Claude is waiting on CI");
    expect(sentence("stale", { boardColumn: "waiting", waitingReason: "snoozed" })).toBe("Claude is snoozed");
    expect(sentence("completed")).toBe("Claude is done");
    // A pull request has no agent to name, so it says what it is instead.
    expect(activityStateSentence({
      phase: "merge_ready",
      kind: "pull_request",
    } as AttentionItem)).toBe("Ready to merge");
  });

  /**
   * `statusSince` is immutable for the life of a phase; `updatedAt` churns on
   * every cosmetic republish. Reading elapsed off the wrong one is how a
   * "needs you for 4m" ticker resets itself every poll.
   */
  it("measures elapsed from the phase, not from the last republish", () => {
    const now = Date.parse("2026-08-01T12:00:00.000Z");
    expect(activityStateElapsed({
      statusSince: "2026-08-01T11:56:00.000Z",
      occurredAt: "2026-08-01T09:00:00.000Z",
      updatedAt: "2026-08-01T11:59:59.000Z",
    } as AttentionItem, now)).toBe("4m");

    // No `statusSince` from an older publisher: `occurredAt` is the honest
    // approximation, and a future timestamp is no reading at all.
    expect(activityStateElapsed({
      occurredAt: "2026-08-01T11:00:00.000Z",
      updatedAt: "2026-08-01T11:59:00.000Z",
    } as AttentionItem, now)).toBe("1h");
    expect(activityStateElapsed({
      statusSince: "2026-08-01T12:30:00.000Z",
      occurredAt: "2026-08-01T12:30:00.000Z",
      updatedAt: "2026-08-01T12:30:00.000Z",
    } as AttentionItem, now)).toBeNull();

    // A Waiting row's statusSince is when the chat entered its status, not
    // when the wait began, so it shows no duration rather than a wrong one.
    expect(activityStateElapsed({
      kind: "agent",
      phase: "running",
      boardColumn: "waiting",
      waitingReason: "ci",
      statusSince: "2026-08-01T10:00:00.000Z",
      occurredAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T11:59:00.000Z",
    } as AttentionItem, now)).toBeNull();
  });
});
