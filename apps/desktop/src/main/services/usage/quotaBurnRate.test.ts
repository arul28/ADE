import { describe, expect, it } from "vitest";
import type { AdeQuotaSample, AdeTurnUsageRecord } from "../../../shared/types";
import { estimateQuotaBurnRates, quotaSampleKey, sameResetInstance } from "./quotaBurnRate";

const NOW = Date.UTC(2026, 8, 23, 12);
const HOUR = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const FUTURE_RESET = iso(NOW + 3 * 24 * HOUR);
const PAST_RESET = iso(NOW - 6 * HOUR);

function sample(hoursAgo: number, percentUsed: number, overrides: Partial<AdeQuotaSample> = {}): AdeQuotaSample {
  return {
    v: 1,
    at: iso(NOW - hoursAgo * HOUR),
    provider: "claude",
    accountId: "claude:local",
    windowType: "weekly",
    percentUsed,
    resetsAt: FUTURE_RESET,
    ...overrides,
  };
}

let turnSeq = 0;
function turn(hoursAgo: number, usd: number | null, overrides: Partial<AdeTurnUsageRecord> = {}): AdeTurnUsageRecord {
  turnSeq += 1;
  return {
    v: 1,
    key: `s1:t${turnSeq}`,
    at: iso(NOW - hoursAgo * HOUR),
    startedAt: null,
    sessionId: "s1",
    turnId: `t${turnSeq}`,
    projectRoot: null,
    laneId: null,
    surface: null,
    parentSessionId: null,
    provider: "claude",
    status: "completed",
    requestedModel: null,
    servedModel: null,
    reasoningEffort: null,
    account: null,
    accountKey: "claude:local",
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cacheWrite1hTokens: null,
    reasoningTokens: null,
    contextTokens: null,
    contextWindow: null,
    requestCount: null,
    subagentTokens: null,
    costUsd: null,
    costSource: null,
    apiEquivalentUsd: usd,
    planUsage: null,
    factoryCreditsSessionTotal: null,
    usageConfidence: null,
    durationMs: null,
    compactions: 0,
    ...overrides,
  };
}

function estimate(samples: AdeQuotaSample[], turns: AdeTurnUsageRecord[], lookbackMs?: number) {
  return estimateQuotaBurnRates({ samples, turns, nowMs: NOW, lookbackMs });
}

describe("estimateQuotaBurnRates", () => {
  it("answers as of nowMs: readings and turns after it are left out", () => {
    const later = [sample(-2, 60), sample(-3, 80)];
    const laterTurns = [turn(-2.5, 500)];
    const asOfNow = estimate([sample(10, 10), sample(5, 20), ...later], [turn(8, 5), ...laterTurns]);
    expect(asOfNow).toEqual(estimate([sample(10, 10), sample(5, 20)], [turn(8, 5)]));
    expect(asOfNow[0]).toMatchObject({ usdPerPercent: 0.5, observedPercent: 10, latestPercentUsed: 20 });
  });

  it("prices one percent from the ADE turns that ran while the window moved", () => {
    const rates = estimate(
      [sample(10, 10), sample(5, 20), sample(1, 30)],
      [
        turn(8, 5),
        turn(3, 15),
        // At the first reading: it moved the percent before the span began.
        turn(10, 100),
        // After the last reading.
        turn(0.5, 100),
        turn(3, 100, { provider: "codex", accountKey: "codex:local" }),
      ],
    );
    expect(rates).toEqual([{
      provider: "claude",
      accountId: "claude:local",
      windowType: "weekly",
      usdPerPercent: 1,
      turnsPerPercent: 0.1,
      observedPercent: 20,
      observedUsd: 20,
      observedTurns: 2,
      latestPercentUsed: 30,
      latestResetsAt: FUTURE_RESET,
      headroomUsd: 70,
      confidence: "high",
    }]);
  });

  it.each([
    [20, "high"],
    [19.5, "medium"],
    [5, "medium"],
    [4.9, "low"],
  ] as const)("rates a %s point move as %s confidence", (moved, confidence) => {
    const [rate] = estimate([sample(10, 10), sample(1, 10 + moved)], [turn(5, 1)]);
    expect(rate?.confidence).toBe(confidence);
  });

  it("has no rate and no confidence when no ADE turn ran", () => {
    const [rate] = estimate([sample(10, 10), sample(1, 30)], []);
    expect(rate).toMatchObject({
      usdPerPercent: null,
      turnsPerPercent: null,
      observedPercent: 0,
      observedUsd: 0,
      observedTurns: 0,
      latestPercentUsed: 30,
      headroomUsd: null,
      confidence: "none",
    });
  });

  it("splits a window at its reset and never counts the drop", () => {
    const [rate] = estimate(
      [
        sample(12, 10, { resetsAt: PAST_RESET }),
        sample(8, 40, { resetsAt: PAST_RESET }),
        sample(5, 2),
        sample(1, 12),
      ],
      [
        turn(10, 30),
        // Between the old window's last reading and the new window's first.
        turn(6, 1_000),
        turn(3, 10),
      ],
    );
    expect(rate).toMatchObject({
      observedPercent: 40,
      observedUsd: 40,
      observedTurns: 2,
      usdPerPercent: 1,
      latestPercentUsed: 12,
      headroomUsd: 88,
    });
  });

  it("treats Claude's microsecond-jittered reset strings as one window instance", () => {
    const [rate] = estimate(
      [
        sample(10, 10, { resetsAt: "2026-09-26T12:00:00.104823+00:00" }),
        sample(5, 20, { resetsAt: "2026-09-26T12:00:00.917331+00:00" }),
        sample(1, 30, { resetsAt: "2026-09-26T11:59:59.512004+00:00" }),
      ],
      [turn(8, 5), turn(3, 15)],
    );
    expect(rate).toMatchObject({ observedPercent: 20, usdPerPercent: 1 });
  });

  it("treats reset times a few minutes apart as one window instance", () => {
    const reset = NOW + 24 * HOUR;
    const [rate] = estimate(
      [
        sample(10, 10, { resetsAt: iso(reset) }),
        sample(5, 20, { resetsAt: iso(reset + 2 * 60_000) }),
        sample(1, 30, { resetsAt: iso(reset - 60_000) }),
      ],
      [turn(8, 5), turn(3, 15)],
    );
    expect(rate).toMatchObject({ observedPercent: 20, usdPerPercent: 1 });
  });

  it("ignores a span in which no ADE turn ran instead of diluting the rate", () => {
    const [rate] = estimate(
      [
        sample(12, 0, { resetsAt: PAST_RESET }),
        sample(8, 50, { resetsAt: PAST_RESET }),
        sample(5, 10),
        sample(1, 30),
      ],
      [turn(3, 20)],
    );
    expect(rate).toMatchObject({ observedPercent: 20, observedUsd: 20, usdPerPercent: 1, headroomUsd: 70 });
  });

  it("ignores a span that holds an unpriced turn, and has no confidence without a rate", () => {
    // Span 1 (old window) has a turn that used tokens at no list price, so its dollars are unknown.
    const unpriced = { inputTokens: 1_000, outputTokens: 50 };
    const [rate] = estimate(
      [
        sample(12, 0, { resetsAt: PAST_RESET }),
        sample(8, 50, { resetsAt: PAST_RESET }),
        sample(5, 10),
        sample(1, 30),
      ],
      [turn(10, 30), turn(9, null, unpriced), turn(3, 20)],
    );
    expect(rate).toMatchObject({ observedPercent: 20, observedUsd: 20, observedTurns: 1, usdPerPercent: 1 });

    const [unpricedOnly] = estimate([sample(5, 10), sample(1, 30)], [turn(3, null, unpriced)]);
    expect(unpricedOnly).toMatchObject({ usdPerPercent: null, headroomUsd: null, confidence: "none" });
  });

  it("counts a turn with no tokens as $0 instead of calling its span unpriced", () => {
    const [rate] = estimate(
      [sample(10, 10), sample(1, 30)],
      [turn(8, 20), turn(6, null), turn(4, null, { inputTokens: 0, outputTokens: 0, cacheReadTokens: null })],
    );
    expect(rate).toMatchObject({ observedPercent: 20, observedUsd: 20, observedTurns: 3, usdPerPercent: 1 });
  });

  it("leaves out turns that could not move the subscription window", () => {
    const [rate] = estimate(
      [sample(10, 10), sample(1, 30)],
      [
        turn(8, 10, { account: { provider: "claude", kind: "subscription" } }),
        // A legacy row with no account still counts.
        turn(7, 10, { account: null }),
        turn(6, 500, { account: { provider: "claude", kind: "api_key" } }),
        turn(5, 500, { account: { provider: "claude", kind: "local", endpoint: "http://127.0.0.1:1234" } }),
        // Routed away from the plan (Bedrock, a redirected endpoint, a keyed preset): the subscription never saw it.
        turn(4.5, 500, { account: { provider: "claude", kind: "unknown", upstream: "anthropic", routedAway: "cloud" } }),
        turn(4.2, 500, { account: { provider: "claude", kind: "subscription", routedAway: "endpoint" } }),
        turn(4, 500, { account: { provider: "claude", kind: "unknown", routedAway: "preset" } }),
        // Unknown with no upstream is still this login.
        turn(3, 0, { account: { provider: "claude", kind: "unknown" } }),
      ],
    );
    expect(rate).toMatchObject({ observedTurns: 3, observedUsd: 20, usdPerPercent: 1 });
  });

  it("reads `upstream` as the model vendor, not as a route away from the plan", () => {
    // Qwen's own OAuth, and OpenCode or Pi serving a vendor's model on the
    // provider's plan, all name an upstream and all draw on the window.
    const [qwen] = estimate(
      [sample(10, 10, { provider: "qwen", accountId: "qwen:local" }), sample(1, 30, { provider: "qwen", accountId: "qwen:local" })],
      [
        turn(8, 10, { provider: "qwen", accountKey: "qwen:local", account: { provider: "qwen", kind: "unknown", upstream: "qwen-oauth" } }),
        turn(6, 10, { provider: "qwen", accountKey: "qwen:local", account: { provider: "qwen", kind: "subscription", upstream: "qwen-oauth" } }),
      ],
    );
    expect(qwen).toMatchObject({ observedTurns: 2, observedUsd: 20, usdPerPercent: 1 });
    const [opencode] = estimate(
      [sample(10, 10, { provider: "opencode", accountId: "opencode:local" }), sample(1, 30, { provider: "opencode", accountId: "opencode:local" })],
      [
        turn(8, 10, { provider: "opencode", accountKey: "opencode:local", account: { provider: "opencode", kind: "unknown", upstream: "deepseek" } }),
        // The same vendor on a routed-away turn does not count.
        turn(6, 500, { provider: "opencode", accountKey: "opencode:local", account: { provider: "opencode", kind: "unknown", upstream: "deepseek", routedAway: "endpoint" } }),
      ],
    );
    expect(opencode).toMatchObject({ observedTurns: 1, observedUsd: 10, usdPerPercent: 0.5 });
  });

  it("counts only the matching account's turns when a provider has two accounts", () => {
    const rates = estimate(
      [
        sample(10, 10, { accountId: "claude:b" }),
        sample(1, 30, { accountId: "claude:b" }),
        sample(10, 10, { accountId: "claude:a" }),
        sample(1, 30, { accountId: "claude:a" }),
      ],
      [
        turn(5, 20, { accountKey: "claude:a" }),
        turn(5, 40, { accountKey: "claude:b" }),
        turn(5, 1_000, { accountKey: "claude:local" }),
        turn(5, 1_000, { accountKey: "claude:c" }),
      ],
    );
    expect(rates.map((r) => [r.accountId, r.observedTurns, r.usdPerPercent])).toEqual([
      ["claude:a", 1, 1],
      ["claude:b", 1, 2],
    ]);
  });

  it("counts every turn of a provider that has one account in the readings", () => {
    const codex = { provider: "codex", accountId: "codex:local", windowType: "five_hour" };
    const [rate] = estimate(
      [sample(10, 10, codex), sample(1, 30, codex)],
      [
        turn(5, 5, { provider: "codex", accountKey: "codex:instance-2" }),
        turn(5, 10, { provider: "codex", accountKey: "codex:dev@example.com" }),
        turn(5, 5, { provider: "codex", accountKey: "codex:local" }),
        turn(5, 1_000, { provider: "claude", accountKey: "claude:local" }),
      ],
    );
    expect(rate).toMatchObject({ provider: "codex", observedTurns: 3, observedUsd: 20, usdPerPercent: 1 });
  });

  it("does not count a `:local` reading as a second account when the provider has a named one", () => {
    const named = { provider: "kimi", accountId: "kimi:dev@example.com", windowType: "weekly" };
    // Written once when an identity call failed after a restart: the same login, unnamed.
    const unnamed = { provider: "kimi", accountId: "kimi:local", windowType: "weekly" };
    const rates = estimate(
      [sample(10, 10, named), sample(9, 10, unnamed), sample(1, 30, named)],
      [
        turn(5, 10, { provider: "kimi", accountKey: "kimi:dev@example.com" }),
        turn(4, 10, { provider: "kimi", accountKey: "kimi:dev@example.com" }),
      ],
    );
    expect(rates.find((rate) => rate.accountId === "kimi:dev@example.com"))
      .toMatchObject({ observedTurns: 2, observedUsd: 20, usdPerPercent: 1 });
  });

  it("matches a turn keyed `<provider>:local` to the provider's one named account, but not to one of two", () => {
    const named = { provider: "copilot", accountId: "copilot:dev@example.com", windowType: "monthly" };
    const [rate] = estimate(
      [sample(10, 10, named), sample(1, 30, named)],
      [turn(5, 20, { provider: "copilot", accountKey: "copilot:local" })],
    );
    expect(rate).toMatchObject({ accountId: "copilot:dev@example.com", observedTurns: 1, usdPerPercent: 1 });

    const other = { ...named, accountId: "copilot:other@example.com" };
    const rates = estimate(
      [sample(10, 10, named), sample(1, 30, named), sample(10, 10, other), sample(1, 30, other)],
      [turn(5, 20, { provider: "copilot", accountKey: "copilot:local" })],
    );
    expect(rates.map((r) => r.observedTurns)).toEqual([0, 0]);
  });

  it("gives no current percent or headroom once the latest reading's window has reset", () => {
    const resetAnHourAgo = { resetsAt: iso(NOW - HOUR) };
    const [rate] = estimate([sample(10, 10, resetAnHourAgo), sample(2, 30, resetAnHourAgo)], [turn(5, 20)]);
    expect(rate).toMatchObject({
      usdPerPercent: 1,
      observedPercent: 20,
      latestPercentUsed: null,
      latestResetsAt: null,
      headroomUsd: null,
    });
  });

  it("ignores readings and turns older than the lookback", () => {
    const fiveHour = { windowType: "five_hour" };
    const rates = estimate(
      [
        sample(48, 0),
        sample(10, 10),
        sample(1, 30),
        sample(30, 5, fiveHour),
        sample(26, 50, fiveHour),
      ],
      [turn(30, 50), turn(28, 50), turn(5, 20)],
      24 * HOUR,
    );
    expect(rates).toHaveLength(1);
    expect(rates[0]).toMatchObject({ windowType: "weekly", observedPercent: 20, observedUsd: 20, usdPerPercent: 1 });
  });

  it("looks back fourteen days by default", () => {
    const [rate] = estimate([sample(15 * 24, 0), sample(10, 10), sample(1, 30)], [turn(12 * 24, 100), turn(5, 20)]);
    expect(rate).toMatchObject({ observedPercent: 20, usdPerPercent: 1 });
  });
});

describe("quota window identity", () => {
  it("keys a window by provider, account, and window type", () => {
    expect(quotaSampleKey({ provider: "claude", accountId: "claude:work", windowType: "weekly" })).toBe("claude|claude:work|weekly");
  });

  it("matches reset times within five minutes, and exact strings when they do not parse", () => {
    expect(sameResetInstance({ resetsAt: "2026-09-26T12:00:00.104823+00:00" }, { resetsAt: "2026-09-26T12:00:00.917331+00:00" })).toBe(true);
    expect(sameResetInstance({ resetsAt: iso(NOW) }, { resetsAt: iso(NOW + 5 * 60_000) })).toBe(true);
    expect(sameResetInstance({ resetsAt: iso(NOW) }, { resetsAt: iso(NOW + 5 * 60_000 + 1) })).toBe(false);
    expect(sameResetInstance({ resetsAt: "soon" }, { resetsAt: "soon" })).toBe(true);
    expect(sameResetInstance({ resetsAt: "soon" }, { resetsAt: "later" })).toBe(false);
  });
});
