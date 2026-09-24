import { describe, expect, it } from "vitest";
import {
  CODEX_PLAN_LIMIT_NOTICE_PERCENT,
  codexPlanLimitNoticeState,
  parseCodexResetCredits,
  parseCopilotIdentity,
  parseCopilotQuota,
  parseCursorUsageSummary,
  parseFactorySessionCredits,
  parseGrokCredits,
  parseKimiIdentity,
  parseKimiUsage,
  parseOpenCodeGoUsage,
  shouldEmitCodexApproachingPlanLimit,
  wholePercent,
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
  it("re-arms when the window rolls over, so the next window warns too", () => {
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

describe("Kimi and Copilot quota identity", () => {
  // Kimi Code's own client (`packages/oauth/src/managed-usage.ts`) reads this
  // shape: counts in `detail`, length in `window.duration` x `window.timeUnit`,
  // int64 counts as protobuf-JSON strings, and a top-level `usage` it labels weekly.
  const KIMI_USAGES = {
    usage: { used: "25", limit: "100", resetTime: "2026-09-29T00:00:00Z" },
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { used: "3", limit: "10", resetTime: "2026-09-23T20:00:00Z" },
      },
      {
        name: "Monthly",
        window: { duration: 30, timeUnit: "TIME_UNIT_DAY" },
        detail: { used: 50, limit: 200, resetTime: "2026-10-01T00:00:00Z" },
      },
    ],
  };

  it("reads Kimi's /usages shape: the weekly summary plus each limit row by its length", () => {
    const windows = parseKimiUsage(KIMI_USAGES, Date.parse("2026-09-23T16:00:00.000Z"), "Ada@Example.com");

    expect(windows.map((window) => [window.windowType, window.percentUsed, window.windowDurationMs])).toEqual([
      ["weekly", 25, 7 * 86_400_000],
      ["five_hour", 30, 5 * 3_600_000],
      ["monthly", 25, 30 * 86_400_000],
    ]);
    expect(windows.every((window) => window.accountId === "kimi:ada@example.com")).toBe(true);
    expect(windows[1]).toMatchObject({ resetsAt: "2026-09-23T20:00:00Z", resetsInMs: 4 * 3_600_000 });
  });

  it("reads each Kimi time unit, and a unit it does not know as no length", () => {
    const durationFor = (timeUnit: string) => parseKimiUsage({
      limits: [{ window: { duration: 2, timeUnit }, detail: { used: 1, limit: 10 } }],
    }, Date.parse("2026-09-23T16:00:00.000Z"))[0]?.windowDurationMs;

    expect(durationFor("TIME_UNIT_MINUTE")).toBe(2 * 60_000);
    expect(durationFor("TIME_UNIT_HOUR")).toBe(2 * 3_600_000);
    expect(durationFor("TIME_UNIT_DAY")).toBe(2 * 86_400_000);
    expect(durationFor("TIME_UNIT_WEEK")).toBe(2 * 7 * 86_400_000);
    expect(durationFor("TIME_UNIT_UNSPECIFIED")).toBeUndefined();
    expect(durationFor("constructor")).toBeUndefined();
  });

  it("reads an omitted Kimi `used` as 0%, and skips a row with no limit", () => {
    const windows = parseKimiUsage({
      usage: { limit: "100", resetTime: "2026-09-29T00:00:00Z" },
      limits: [{ window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { used: "4" } }],
    }, Date.parse("2026-09-23T16:00:00.000Z"));

    expect(windows.map((window) => [window.windowType, window.percentUsed])).toEqual([["weekly", 0]]);
    // No email is the machine's one local account, the same id every quota parser stamps.
    expect(windows[0]?.accountId).toBe("kimi:local");
  });

  it("keeps one Kimi window per type, the first one reported", () => {
    const windows = parseKimiUsage({
      usage: { used: 10, limit: 100 },
      limits: [{ window: { duration: 1, timeUnit: "TIME_UNIT_WEEK" }, detail: { used: 90, limit: 100 } }],
    }, Date.parse("2026-09-23T16:00:00.000Z"));

    expect(windows.map((window) => [window.windowType, window.percentUsed])).toEqual([["weekly", 10]]);
  });

  it("reads Kimi identity and Copilot login/email without exposing credentials", () => {
    expect(parseKimiIdentity({ user_id: "u1", email: "ada@example.com", nickname: "Ada" })).toEqual({
      email: "ada@example.com",
      name: "Ada",
    });
    expect(parseCopilotIdentity({ login: "ada-lovelace", email: "ada@example.com" })).toEqual({
      login: "ada-lovelace",
      email: "ada@example.com",
    });
  });
});

describe("Factory usage parsers", () => {
  it("reads Factory session credits from the documented token usage field", () => {
    expect(parseFactorySessionCredits({ tokenUsage: { factoryCredits: 4.25 } })).toBe(4.25);
    expect(parseFactorySessionCredits({ factoryCredits: 0 })).toBe(0);
    expect(parseFactorySessionCredits({ tokenUsage: {} })).toBeNull();
  });
});

describe("extra provider quota parsers", () => {
  const NOW = Date.parse("2026-09-21T16:00:00.000Z");

  it("keeps a 1% OpenCode window at 1%, including zero", () => {
    expect(wholePercent(1)).toBe(1);
    const windows = parseOpenCodeGoUsage({
      usage: {
        rolling: { percent: 3, resetInSec: 3600 },
        weekly: { percent: 1, resetInSec: 86_400 },
        monthly: { percent: 0, resetInSec: 86_400 * 10 },
      },
    }, NOW);
    expect(windows.map((window) => [window.windowType, window.percentUsed])).toEqual([
      ["five_hour", 3],
      ["weekly", 1],
      ["monthly", 0],
    ]);
    expect(windows[0]?.resetsAt).toBe(new Date(NOW + 3_600_000).toISOString());
  });

  it("reads Cursor plan percent and the billing-cycle reset", () => {
    const parsed = parseCursorUsageSummary({
      membershipType: "pro",
      email: "Ada@Example.com",
      billingCycleEnd: "2026-10-01T00:00:00.000Z",
      individualUsage: { plan: { totalPercentUsed: 40, used: 1, limit: 2 } },
    }, NOW);
    expect(parsed.plan).toBe("pro");
    expect(parsed.windows).toEqual([expect.objectContaining({
      provider: "cursor",
      windowType: "monthly",
      percentUsed: 40,
      resetsAt: "2026-10-01T00:00:00.000Z",
      accountId: "cursor:ada@example.com",
    })]);
  });

  it("turns Copilot premium remaining into used percent and omits a missing reset", () => {
    const parsed = parseCopilotQuota({
      copilotPlan: "pro",
      quota_snapshots: { premium_interactions: { percent_remaining: 40 } },
    }, NOW);
    expect(parsed.plan).toBe("pro");
    expect(parsed.windows[0]).toMatchObject({
      provider: "copilot",
      windowType: "monthly",
      percentUsed: 60,
      resetsAt: "",
      accountId: "copilot:local",
    });
  });

  it("stamps every quota parser's windows from the email it is given, once", () => {
    const copilot = parseCopilotQuota({
      quota_snapshots: { premium_interactions: { percent_remaining: 40 } },
    }, NOW, "Ada@Example.com");
    const grok = parseGrokCredits({ creditUsagePercent: 12 }, NOW, "ada@example.com");
    const kimi = parseKimiUsage({ usage: { used: 1, limit: 10 } }, NOW, "ada@example.com");
    expect([copilot.windows[0]?.accountId, grok.windows[0]?.accountId, kimi[0]?.accountId]).toEqual([
      "copilot:ada@example.com",
      "grok:ada@example.com",
      "kimi:ada@example.com",
    ]);
    expect(parseGrokCredits({ creditUsagePercent: 12 }, NOW, null).windows[0]?.accountId).toBe("grok:local");
  });

  it("accepts Copilot's current top-level UTC reset date", () => {
    const parsed = parseCopilotQuota({
      quota_snapshots: { premium_interactions: { percent_remaining: 80 } },
      quota_reset_date_utc: "2026-10-01T00:00:00.000Z",
    }, NOW);
    expect(parsed.windows[0]?.resetsAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("labels a 7-day Grok period weekly and a longer one monthly", () => {
    const weekly = parseGrokCredits({
      config: {
        creditUsagePercent: 12,
        currentPeriod: {
          start: "2026-09-15T00:00:00.000Z",
          end: "2026-09-22T00:00:00.000Z",
        },
      },
    }, NOW);
    expect(weekly.windows[0]).toMatchObject({ windowType: "weekly", percentUsed: 12 });

    const monthly = parseGrokCredits({
      credit_usage_percent: 8,
      billing_period_end: "2026-10-21T00:00:00.000Z",
    }, NOW);
    expect(monthly.windows[0]).toMatchObject({ windowType: "monthly", percentUsed: 8 });
  });
});
