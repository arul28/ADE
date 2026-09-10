import { describe, expect, it } from "vitest";

import type { AgentChatUsageLimitResume } from "./types/chat";
import {
  formatUsageLimitClock,
  formatUsageLimitCountdown,
  isUsageLimitFailureText,
  isUsageLimitTurn,
  parseUsageLimitResume,
  usageLimitResumePill,
  usageLimitResumePopover,
  usageLimitResumeProviderLabel,
  usageLimitResumeRowStatus,
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

describe("usageLimitResumePill", () => {
  it("counts down to the fire time and ticks once a minute while far out", () => {
    const pill = usageLimitResumePill(
      resume({ fireAt: new Date(NOW + 12 * 60_000).toISOString() }),
      NOW,
    );
    expect(pill.label).toBe("Resumes in 12 min · usage limit");
    expect(pill.refreshMs).toBe(60_000);
  });

  it("ticks once a second inside the last five minutes", () => {
    const pill = usageLimitResumePill(resume(), NOW);
    expect(pill.label).toBe("Resumes in 3 min · usage limit");
    expect(pill.refreshMs).toBe(1_000);
  });

  it("reads Resuming… once the fire time has passed, and arms no timer", () => {
    const pill = usageLimitResumePill(resume(), NOW + 5 * 60_000);
    expect(pill.label).toBe("Resuming…");
    expect(pill.refreshMs).toBeNull();
  });

  it("names the retry time on a paused streak", () => {
    const pill = usageLimitResumePill(
      resume({ state: "paused", attempts: 2, fireAt: null, resetAt: null }),
      NOW,
    );
    expect(pill.segments[0]).toBe("Paused after 2 tries");
    expect(pill.actionHint).toBe("Try again");
    expect(pill.refreshMs).toBeNull();
  });

  it("offers Turn on when the user opted out, and Retry when there is no reset", () => {
    expect(usageLimitResumePill(resume({ state: "opted_out" }), NOW).label)
      .toBe("Won't auto-resume · Turn on");
    expect(usageLimitResumePill(resume({ state: "no_reset", fireAt: null, resetAt: null }), NOW).label)
      .toBe("Usage limit · no reset time · Retry");
  });

  it("falls back to the reset instant when the host published no fire time", () => {
    const pill = usageLimitResumePill(
      resume({ fireAt: null, resetAt: new Date(NOW + 20 * 60_000).toISOString() }),
      NOW,
    );
    expect(pill.label).toBe("Resumes in 20 min · usage limit");
  });
});

describe("usageLimitResumePopover", () => {
  it("names the provider and states the instant plus the countdown", () => {
    const popover = usageLimitResumePopover(resume(), NOW);
    expect(popover.title).toBe("Claude usage limit");
    expect(popover.body).toContain('ADE sends "continue" at ');
    expect(popover.body).toContain("(in 3 min)");
    expect(popover.reassurance).toBe("Nothing is lost. Subagents restart with it.");
    expect(popover.primary).toEqual({ action: "resume-now", label: "Resume now" });
    expect(popover.showDontContinue).toBe(true);
    expect(popover.providerDetail).toBe("Resets at 7:31 PM ET");
  });

  it("re-arms rather than resumes for a paused streak", () => {
    const popover = usageLimitResumePopover(resume({ state: "paused", attempts: 2 }), NOW);
    expect(popover.primary).toEqual({ action: "enable", label: "Try again" });
    expect(popover.showDontContinue).toBe(true);
  });

  it("offers Turn on and drops Don't continue once auto-resume is already off", () => {
    const popover = usageLimitResumePopover(resume({ state: "opted_out" }), NOW);
    expect(popover.primary).toEqual({ action: "enable", label: "Turn on" });
    expect(popover.showDontContinue).toBe(false);
  });

  it("says there is nothing to schedule when the provider published no reset", () => {
    const popover = usageLimitResumePopover(
      resume({ state: "no_reset", provider: "codex", fireAt: null, resetAt: null }),
      NOW,
    );
    expect(popover.title).toBe("Codex usage limit");
    expect(popover.body).toContain("didn't publish a reset time");
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

  it("declines the row for states that are not waiting for anything", () => {
    // The row falls back to its ordinary failed/idle presentation: a chat the
    // user switched off, or one with no reset to wait for, is not "waiting".
    expect(usageLimitResumeRowStatus(resume({ state: "opted_out" }), NOW)).toBeNull();
    expect(usageLimitResumeRowStatus(resume({ state: "no_reset" }), NOW)).toBeNull();
    expect(usageLimitResumeRowStatus(null, NOW)).toBeNull();
    expect(usageLimitResumeRowStatus(undefined, NOW)).toBeNull();
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

  it("floors attempts at a finite, non-negative integer", () => {
    expect(parseUsageLimitResume({ ...resume(), attempts: 2.9 })?.attempts).toBe(2);
    expect(parseUsageLimitResume({ ...resume(), attempts: -4 })?.attempts).toBe(0);
    expect(parseUsageLimitResume({ ...resume(), attempts: "3" })?.attempts).toBe(0);
    expect(parseUsageLimitResume({ ...resume(), attempts: Number.POSITIVE_INFINITY })?.attempts)
      .toBe(0);
  });
});
