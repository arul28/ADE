import { describe, expect, it } from "vitest";

import {
  RESET_CREDIT_OUTCOME_TEXT,
  resetCreditApplied,
  resetCreditOutcomeKey,
  resetCreditOutcomeText,
} from "./usageResetCredit";
import type { UsageResetCreditResult } from "./types";

describe("resetCreditOutcomeText", () => {
  it("phrases the four real outcomes itself", () => {
    expect(resetCreditOutcomeText({ ok: true, status: "reset" }))
      .toBe(RESET_CREDIT_OUTCOME_TEXT.reset);
    expect(resetCreditOutcomeText({ ok: false, status: "nothingToReset" }))
      .toBe(RESET_CREDIT_OUTCOME_TEXT.nothingToReset);
    expect(resetCreditOutcomeText({ ok: false, status: "noCredit" }))
      .toBe(RESET_CREDIT_OUTCOME_TEXT.noCredit);
    expect(resetCreditOutcomeText({ ok: false, status: "alreadyRedeemed" }))
      .toBe(RESET_CREDIT_OUTCOME_TEXT.alreadyRedeemed);
  });

  it("prefers the host's sentence over the generic failure line", () => {
    // `failure` is the catch-all bucket, so a host that also said WHY must not
    // be flattened into "Could not use the reset credit." — the real sentence
    // is the one that tells the reader what to do next.
    expect(resetCreditOutcomeText({
      ok: false,
      status: "failure",
      message: "That Codex account is not signed in on this computer.",
    })).toBe("That Codex account is not signed in on this computer.");
  });

  it("falls back to the generic failure line when there is nothing else to say", () => {
    expect(resetCreditOutcomeText({ ok: false, status: "failure" }))
      .toBe(RESET_CREDIT_OUTCOME_TEXT.failure);
    expect(resetCreditOutcomeText({ ok: false, status: "failure", message: "   " }))
      .toBe(RESET_CREDIT_OUTCOME_TEXT.failure);
    expect(resetCreditOutcomeText(null)).toBe(RESET_CREDIT_OUTCOME_TEXT.failure);
  });

  it("shows a statusless host's own prose verbatim", () => {
    expect(resetCreditOutcomeText({ ok: false, message: "This machine cannot spend credits." }))
      .toBe("This machine cannot spend credits.");
  });

  it("never reports a reset that did not happen", () => {
    // ok without a status is the old host's success shape; ok WITH `failure`
    // is contradictory, and the safe reading is the failure.
    expect(resetCreditOutcomeText({ ok: true })).toBe(RESET_CREDIT_OUTCOME_TEXT.reset);
    expect(resetCreditOutcomeText({ ok: true, status: "failure" }))
      .toBe(RESET_CREDIT_OUTCOME_TEXT.failure);
  });

  it("tolerates a status this build has never heard of", () => {
    // A newer host may name an outcome this build does not know. `ok` is the
    // only thing that says the credit was really spent, so an unknown status
    // reads as a reset only when the host also said it succeeded — and never
    // otherwise. Mirrored by `workResetCreditOutcomeText` on iOS.
    const unknown = (ok: boolean) =>
      resetCreditOutcomeText({ ok, status: "futureStatus" } as unknown as UsageResetCreditResult);
    expect(unknown(true)).toBe(RESET_CREDIT_OUTCOME_TEXT.reset);
    expect(unknown(false)).toBe(RESET_CREDIT_OUTCOME_TEXT.failure);
  });

  it("does not mistake an inherited object key for a known status", () => {
    // A hostile or buggy host naming `toString` must not resolve to a function
    // through the prototype chain; it is just another unknown status.
    const inherited = (ok: boolean) =>
      resetCreditOutcomeText({ ok, status: "toString" } as unknown as UsageResetCreditResult);
    expect(inherited(false)).toBe(RESET_CREDIT_OUTCOME_TEXT.failure);
    expect(inherited(true)).toBe(RESET_CREDIT_OUTCOME_TEXT.reset);
  });
});

describe("resetCreditOutcomeKey", () => {
  it("reads an older host's statusless success as an applied reset", () => {
    // The key is what analytics records, so this shape must not be filed as a
    // failure on one surface and a reset on another.
    expect(resetCreditOutcomeKey({ ok: true })).toBe("reset");
  });

  it("names the host's own sentence as its own outcome", () => {
    expect(resetCreditOutcomeKey({ ok: false, message: "This machine cannot spend credits." }))
      .toBe("hostMessage");
  });
});

describe("resetCreditApplied", () => {
  it("is true only for the answers that really cleared the windows", () => {
    expect(resetCreditApplied({ ok: true, status: "reset" })).toBe(true);
    expect(resetCreditApplied({ ok: true })).toBe(true);
    expect(resetCreditApplied({ ok: true, status: "failure" })).toBe(false);
    expect(resetCreditApplied({ ok: false, status: "nothingToReset" })).toBe(false);
    expect(resetCreditApplied({ ok: false, status: "noCredit" })).toBe(false);
    expect(resetCreditApplied(null)).toBe(false);
  });

  it("is false for a failing host that echoes the success sentence back", () => {
    // The verdict reads the outcome, not the rendered copy: a host whose own
    // explanation happens to be worded exactly like the applied-reset line must
    // not be reported as a reset that happened.
    const echo = {
      ok: false,
      message: RESET_CREDIT_OUTCOME_TEXT.reset,
    } as UsageResetCreditResult;
    expect(resetCreditOutcomeText(echo)).toBe(RESET_CREDIT_OUTCOME_TEXT.reset);
    expect(resetCreditApplied(echo)).toBe(false);
  });
});
