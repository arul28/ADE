import { describe, expect, it } from "vitest";
import {
  buildConfirmation,
  classifySpokenReply,
  resolveSpokenConfirmation,
} from "./ctoVoiceConfirmation";

const NOW = 1_000_000;

function pending(overrides: Partial<ReturnType<typeof buildConfirmation>> = {}) {
  return {
    ...buildConfirmation({
      id: "c1",
      toolName: "openPr",
      prompt: "Open a pull request?",
      utteranceId: "u1",
      nowMs: NOW,
    }),
    ...overrides,
  };
}

describe("classifySpokenReply", () => {
  it("reads the ordinary affirmatives", () => {
    for (const phrase of ["yes", "Yeah.", "go ahead", "sure!", "do it", "sounds good"]) {
      expect(classifySpokenReply(phrase)).toBe("approve");
    }
  });

  /**
   * The worst possible failure is reading a refusal as consent. "no, don't do
   * it" contains "do it", so negatives must win outright.
   */
  it("never reads a refusal as consent", () => {
    for (const phrase of ["no", "no, don't do it", "wait", "hold on", "stop", "not now"]) {
      expect(classifySpokenReply(phrase)).toBe("deny");
    }
  });

  it("stays out of the way when there is no decision", () => {
    expect(classifySpokenReply("what would that change?")).toBe("none");
    expect(classifySpokenReply("")).toBe("none");
    // "yesterday" must not match "yes".
    expect(classifySpokenReply("what merged yesterday")).toBe("none");
  });
});

describe("resolveSpokenConfirmation", () => {
  it("approves a plain yes to a pending question", () => {
    expect(
      resolveSpokenConfirmation({ confirmation: pending(), utteranceId: "u2", text: "yes", nowMs: NOW + 2_000 }),
    ).toEqual({ kind: "approved" });
  });

  /** A misheard word must not be able to destroy history. */
  it("refuses to approve anything destructive by voice", () => {
    const outcome = resolveSpokenConfirmation({
      confirmation: pending({ toolName: "gitForcePush", destructive: true }),
      utteranceId: "u2",
      text: "yes",
      nowMs: NOW + 2_000,
    });
    expect(outcome).toEqual({ kind: "ignored", reason: "destructive actions need a tap" });
  });

  /**
   * Without this, "force-push it" would raise the question and answer it in the
   * same breath.
   */
  it("does not let the utterance that raised the question answer it", () => {
    const outcome = resolveSpokenConfirmation({
      confirmation: pending({ utteranceId: "u1" }),
      utteranceId: "u1",
      text: "yes do it",
      nowMs: NOW + 500,
    });
    expect(outcome.kind).toBe("ignored");
  });

  it("expires, so a yes much later does not land on a stale question", () => {
    const confirmation = pending();
    const outcome = resolveSpokenConfirmation({
      confirmation,
      utteranceId: "u2",
      text: "yes",
      nowMs: confirmation.expiresAtMs + 1,
    });
    expect(outcome).toEqual({ kind: "ignored", reason: "the question has expired" });
  });

  it("carries a spoken no straight through as a denial", () => {
    expect(
      resolveSpokenConfirmation({ confirmation: pending(), utteranceId: "u2", text: "no, not now", nowMs: NOW + 100 }),
    ).toEqual({ kind: "denied" });
  });

  it("ignores everything when nothing is pending", () => {
    expect(
      resolveSpokenConfirmation({ confirmation: null, utteranceId: "u2", text: "yes", nowMs: NOW }),
    ).toEqual({ kind: "ignored", reason: "nothing pending" });
  });
});

describe("buildConfirmation", () => {
  it("marks the history/remote/delete class destructive and everything else not", () => {
    expect(buildConfirmation({ id: "a", toolName: "gitPush", prompt: "", utteranceId: null, nowMs: NOW }).destructive).toBe(true);
    expect(buildConfirmation({ id: "b", toolName: "mergePr", prompt: "", utteranceId: null, nowMs: NOW }).destructive).toBe(true);
    expect(buildConfirmation({ id: "c", toolName: "spawnChat", prompt: "", utteranceId: null, nowMs: NOW }).destructive).toBe(false);
    expect(buildConfirmation({ id: "d", toolName: "gitCommit", prompt: "", utteranceId: null, nowMs: NOW }).destructive).toBe(false);
  });
});
