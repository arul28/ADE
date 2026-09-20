import { describe, expect, it } from "vitest";
import {
  CODEX_PLAN_LIMIT_NOTICE_PERCENT,
  codexPlanLimitNoticeState,
  parseCodexResetCredits,
  shouldEmitCodexApproachingPlanLimit,
} from "./providerQuotaParsers";

describe("codexPlanLimitNoticeState", () => {
  const at = (percentUsed: number | null | undefined, alreadyEmitted = false) =>
    codexPlanLimitNoticeState({ alreadyEmitted, percentUsed });

  it("emits the first time the five-hour window crosses the threshold", () => {
    expect(at(CODEX_PLAN_LIMIT_NOTICE_PERCENT)).toEqual({ emit: true, emitted: true });
    expect(at(CODEX_PLAN_LIMIT_NOTICE_PERCENT - 0.1)).toEqual({ emit: false, emitted: false });
  });

  it("stays quiet for the rest of the same window", () => {
    expect(at(CODEX_PLAN_LIMIT_NOTICE_PERCENT + 20, true)).toEqual({ emit: false, emitted: true });
    expect(at(99, true)).toEqual({ emit: false, emitted: true });
  });

  // The bug: the armed flag was only ever set. A chat open across a five-hour
  // rollover warned for the first window and never again.
  it("regression: re-arms when the window rolls over, so the next window warns too", () => {
    const rolledOver = at(3, true);
    expect(rolledOver).toEqual({ emit: false, emitted: false });
    expect(at(CODEX_PLAN_LIMIT_NOTICE_PERCENT, rolledOver.emitted)).toEqual({
      emit: true,
      emitted: true,
    });
  });

  it("treats an absent reading as no information, never as a rollover", () => {
    expect(at(null, true)).toEqual({ emit: false, emitted: true });
    expect(at(undefined, true)).toEqual({ emit: false, emitted: true });
    expect(at(null, false)).toEqual({ emit: false, emitted: false });
  });

  it("agrees with the threshold predicate it shares", () => {
    for (const percent of [0, 49.9, 50, 75, 100]) {
      expect(at(percent).emit).toBe(shouldEmitCodexApproachingPlanLimit(percent));
    }
  });
});

describe("parseCodexResetCredits", () => {
  it("counts only credits that are still available", () => {
    expect(parseCodexResetCredits({
      rateLimitResetCredits: {
        availableCount: 3,
        credits: [
          { id: "a", status: "available", expiresAt: "2026-04-01T00:00:00.000Z" },
          { id: "b", status: "redeeming" },
          { id: "c", status: "redeemed" },
        ],
      },
    })).toEqual({ availableCount: 1, nextExpiresAt: "2026-04-01T00:00:00.000Z" });
  });

  it("reports the soonest expiry across available credits", () => {
    expect(parseCodexResetCredits({
      rateLimitResetCredits: {
        credits: [
          { id: "a", status: "available", expiresAt: "2026-05-01T00:00:00.000Z" },
          { id: "b", status: "available", expiresAt: "2026-04-01T00:00:00.000Z" },
        ],
      },
    })).toEqual({ availableCount: 2, nextExpiresAt: "2026-04-01T00:00:00.000Z" });
  });

  it("falls back to the server tally when the array is absent", () => {
    expect(parseCodexResetCredits({ rateLimitResetCredits: { availableCount: 2, credits: null } }))
      .toEqual({ availableCount: 2 });
  });

  it("returns null when the payload carries no credit container at all", () => {
    // `CreditsSnapshot` is the BILLING balance. Reading it here would offer a
    // reset the API refuses.
    expect(parseCodexResetCredits({ rateLimits: {}, credits: { balance: 42 } })).toBeNull();
    expect(parseCodexResetCredits(null)).toBeNull();
  });
});
