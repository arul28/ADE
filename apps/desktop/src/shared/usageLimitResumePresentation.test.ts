import { describe, expect, it } from "vitest";

import type { AgentChatUsageLimitResume } from "./types/chat";
import {
  formatUsageLimitClock,
  formatUsageLimitCountdown,
  isUsageLimitFailureText,
  isUsageLimitTurn,
  parseUsageLimitResume,
  usageLimitResumeProviderLabel,
  usageLimitResumeRowStatus,
  usageLimitChip,
  usageLimitTurnFooterLabel,
} from "./usageLimitResumePresentation";

const NOW = Date.parse("2026-09-08T19:28:00.000Z");

function resume(patch: Partial<AgentChatUsageLimitResume> = {}): AgentChatUsageLimitResume {
  return {
    state: "armed",
    provider: "claude",
    fireAt: new Date(NOW + 3 * 60_000).toISOString(),
    resetAt: new Date(NOW + 90_000).toISOString(),
    scheduleId: "auto-resume:session-1",
    attempts: 1,
    providerDetail: "Resets at 7:31 PM ET",
    turnId: "turn-limit",
    updatedAt: new Date(NOW).toISOString(),
    ...patch,
  };
}

describe("formatUsageLimitCountdown", () => {
  it("spells the units out, matching the contract and iOS", () => {
    expect(formatUsageLimitCountdown(59_000)).toBe("59 s");
    expect(formatUsageLimitCountdown(4 * 60_000 + 30_000)).toBe("4 min 30 s");
    expect(formatUsageLimitCountdown(3 * 60_000)).toBe("3 min");
    expect(formatUsageLimitCountdown(125 * 60_000)).toBe("2 hr 5 min");
  });

  it("degrades to whole minutes and then hours as the wait grows", () => {
    expect(formatUsageLimitCountdown(12 * 60_000)).toBe("12 min");
    expect(formatUsageLimitCountdown(120 * 60_000)).toBe("2 hr");
  });

  it("never counts below zero", () => {
    expect(formatUsageLimitCountdown(-5_000)).toBe("0 s");
  });
});


describe("usageLimitResumeProviderLabel", () => {
  it("uses the known display names and title-cases anything else", () => {
    expect(usageLimitResumeProviderLabel("opencode")).toBe("OpenCode");
    expect(usageLimitResumeProviderLabel("someNewProvider")).toBe("SomeNewProvider");
    expect(usageLimitResumeProviderLabel(null)).toBe("Provider");
  });
});

describe("usageLimitResumeRowStatus", () => {
  it("names the resume clock, quietly, while one is pending", () => {
    expect(usageLimitResumeRowStatus(resume(), NOW)).toEqual({
      label: `Resumes ${formatUsageLimitClock(NOW + 3 * 60_000)}`,
      tone: "neutral",
      glyph: "waiting",
    });
  });

  it("says Resuming, not a past clock, once the row is due", () => {
    // `resuming` is due by definition; an `armed` row whose fire time has
    // passed is waiting only for the turn boundary. Either way "Resumes 7:31
    // PM" would be promising a time that is already gone.
    expect(usageLimitResumeRowStatus(resume({ state: "resuming" }), NOW)).toEqual({
      label: "Resuming",
      tone: "neutral",
      glyph: "waiting",
    });
    expect(usageLimitResumeRowStatus(
      resume({ fireAt: new Date(NOW - 30_000).toISOString(), resetAt: null }),
      NOW,
    )).toEqual({ label: "Resuming", tone: "neutral", glyph: "waiting" });
  });

  it("drops the clock rather than the row when there is no usable instant", () => {
    expect(usageLimitResumeRowStatus(resume({ fireAt: null, resetAt: null }), NOW)).toEqual({
      label: "Resuming",
      tone: "neutral",
      glyph: "waiting",
    });
  });

  it("asks for attention once the chat has stopped trying", () => {
    expect(usageLimitResumeRowStatus(resume({ state: "paused" }), NOW)).toEqual({
      label: "Paused · limit",
      tone: "attention",
      glyph: "waiting",
    });
  });

  it("keeps opted-out and no-reset limits visible as attention rows", () => {
    const expected = { label: "Usage limit", tone: "attention", glyph: "waiting" };
    expect(usageLimitResumeRowStatus(resume({ state: "opted_out" }), NOW)).toEqual(expected);
    expect(usageLimitResumeRowStatus(resume({ state: "no_reset" }), NOW)).toEqual(expected);
    expect(usageLimitResumeRowStatus(null, NOW)).toBeNull();
    expect(usageLimitResumeRowStatus(undefined, NOW)).toBeNull();
  });
});

describe("usageLimitChip", () => {
  it.each([
    ["armed", {}, "resumes in 3 min", "Cancel", false],
    ["resuming", {}, "resuming…", null, null],
    ["paused", { attempts: 2 }, "paused after 2 tries", "Try again", true],
    ["opted_out", {}, "auto-resume off", "Resume in 3 min", true],
    ["no_reset", { fireAt: null, resetAt: null }, "Claude", null, null],
  ] as const)("models the %s state and its available toggle", (state, patch, detail, toggleLabel, enable) => {
    const model = usageLimitChip(resume({ state, ...patch }), NOW);
    expect(model.detail).toBe(detail);
    expect(model.toggle?.label ?? null).toBe(toggleLabel);
    expect(model.toggle?.enable ?? null).toBe(enable);
  });
});

describe("isUsageLimitTurn", () => {
  it("recognises the SDK's own terminal 429", () => {
    expect(isUsageLimitTurn(
      { turnId: "turn-1", terminalReason: "api_error", apiErrorStatus: 429 },
      null,
    )).toBe(true);
  });

  it("recognises a turn the host's live resume state is anchored to", () => {
    expect(isUsageLimitTurn({ turnId: "turn-limit" }, "turn-limit")).toBe(true);
  });

  it("leaves other failures — including a 529 overload — alone", () => {
    expect(isUsageLimitTurn(
      { turnId: "turn-2", terminalReason: "api_error", apiErrorStatus: 529 },
      "turn-limit",
    )).toBe(false);
    expect(isUsageLimitTurn({ turnId: null }, null)).toBe(false);
  });
});

describe("usageLimitTurnFooterLabel", () => {
  it("keeps the elapsed when there is one and stays legible without", () => {
    expect(usageLimitTurnFooterLabel("3m 32s")).toBe("Paused · usage limit · 3m 32s");
    expect(usageLimitTurnFooterLabel(null)).toBe("Paused · usage limit");
  });
});

describe("isUsageLimitFailureText", () => {
  it("matches the provider's limit wording in every spelling", () => {
    expect(isUsageLimitFailureText("Usage limit reached")).toBe(true);
    expect(isUsageLimitFailureText("rate_limit_error")).toBe(true);
    expect(isUsageLimitFailureText("usage_limit exceeded")).toBe(true);
    expect(isUsageLimitFailureText("quota exceeded for this org")).toBe(true);
    expect(isUsageLimitFailureText("Quota exhausted")).toBe(true);
    // The provider's own terminal wording, which a scheduled row used to show
    // as its result under "completed".
    expect(isUsageLimitFailureText("You've hit your session limit")).toBe(true);
    expect(isUsageLimitFailureText("You've hit your weekly limit · resets Monday")).toBe(true);
  });

  it("takes a 429 only when a rate/usage/limit/quota word stands with it", () => {
    expect(isUsageLimitFailureText("HTTP 429 rate_limit")).toBe(true);
    // A bare 429 is a number, not a diagnosis: these are the two real strings
    // the old bare-substring scan mis-filed as usage limits.
    expect(isUsageLimitFailureText("AssertionError at parser.ts:429")).toBe(false);
    expect(isUsageLimitFailureText("context overflow: 4290 tokens")).toBe(false);
  });

  it("does not fold a real error into the usage-limit group", () => {
    expect(isUsageLimitFailureText("TypeError: cannot read property of undefined")).toBe(false);
    expect(isUsageLimitFailureText(null)).toBe(false);
    expect(isUsageLimitFailureText(undefined)).toBe(false);
    expect(isUsageLimitFailureText("")).toBe(false);
  });
});

describe("parseUsageLimitResume", () => {
  it("round-trips a well-formed row", () => {
    expect(parseUsageLimitResume(JSON.parse(JSON.stringify(resume())))).toEqual(resume());
  });

  it("discards the row whole when the state or provider is not recognised", () => {
    // Presence is load-bearing — the heal pass reads a surviving row as proof a
    // structured limit was detected — so a half-trusted row is worse than none.
    expect(parseUsageLimitResume({ ...resume(), state: "waiting" })).toBeNull();
    expect(parseUsageLimitResume({ ...resume(), state: "" })).toBeNull();
    expect(parseUsageLimitResume({ ...resume(), provider: "  " })).toBeNull();
    expect(parseUsageLimitResume({ ...resume(), provider: 7 })).toBeNull();
    expect(parseUsageLimitResume(null)).toBeNull();
    expect(parseUsageLimitResume("armed")).toBeNull();
    expect(parseUsageLimitResume([resume()])).toBeNull();
  });

  it("nulls unusable instants and strings rather than propagating them", () => {
    const parsed = parseUsageLimitResume({
      state: "paused",
      provider: "claude",
      fireAt: "not-a-date",
      resetAt: 12345,
      scheduleId: "   ",
      providerDetail: null,
      turnId: undefined,
      attempts: Number.NaN,
      updatedAt: "also-not-a-date",
    });
    expect(parsed).toEqual({
      state: "paused",
      provider: "claude",
      fireAt: null,
      resetAt: null,
      scheduleId: null,
      attempts: 0,
      providerDetail: null,
      turnId: null,
      updatedAt: new Date(0).toISOString(),
    });
  });

  it("keeps a valid other-account offer and drops a malformed one", () => {
    const withOffer = parseUsageLimitResume({
      ...resume(),
      alternateAccount: { instanceId: "1028", label: "  1028  " },
    });
    expect(withOffer?.alternateAccount).toEqual({ instanceId: "1028", label: "1028" });

    const dropped = parseUsageLimitResume({
      ...resume(),
      alternateAccount: { instanceId: "1028" },
    });
    expect(dropped?.state).toBe("armed");
    expect(dropped?.alternateAccount).toBeUndefined();
  });

  it("floors attempts at a finite, non-negative integer", () => {
    expect(parseUsageLimitResume({ ...resume(), attempts: 2.9 })?.attempts).toBe(2);
    expect(parseUsageLimitResume({ ...resume(), attempts: -4 })?.attempts).toBe(0);
    expect(parseUsageLimitResume({ ...resume(), attempts: "3" })?.attempts).toBe(0);
    expect(parseUsageLimitResume({ ...resume(), attempts: Number.POSITIVE_INFINITY })?.attempts)
      .toBe(0);
  });
});
