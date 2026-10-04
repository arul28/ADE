import { describe, expect, it } from "vitest";
import type { AdeTurnUsageRecord } from "../../../shared/types";
import { buildCostBreakdown, type CostBreakdownLabels } from "./usageCostBreakdown";

let sequence = 0;
function turn(overrides: Partial<AdeTurnUsageRecord>): AdeTurnUsageRecord {
  sequence += 1;
  return {
    v: 1,
    key: `s:${sequence}`,
    at: "2026-10-04T12:00:00.000Z",
    startedAt: null,
    sessionId: "chat-a",
    turnId: `t-${sequence}`,
    projectRoot: "/repo",
    laneId: "lane-a",
    surface: null,
    parentSessionId: null,
    provider: "claude",
    status: "completed",
    requestedModel: "claude-opus-5-5",
    servedModel: null,
    reasoningEffort: null,
    account: { provider: "claude", kind: "subscription", email: "me@example.com" },
    accountKey: "claude:me@example.com",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: null,
    reasoningTokens: null,
    contextTokens: null,
    contextWindow: null,
    requestCount: null,
    subagentTokens: null,
    costUsd: null,
    costSource: null,
    apiEquivalentUsd: 1,
    planUsage: null,
    factoryCreditsSessionTotal: null,
    usageConfidence: null,
    durationMs: null,
    compactions: 0,
    ...overrides,
  };
}

const labels: CostBreakdownLabels = {
  chat: (sessionId) => (sessionId === "chat-a" ? { title: "Chat A", laneId: "lane-a" } : sessionId === "chat-b" ? { title: "Chat B", laneId: "lane-b" } : null),
  lane: (laneId) => (laneId === "lane-a" ? "Lane A" : laneId === "lane-b" ? "Lane B" : null),
};
const range = { since: null, until: "2026-10-05T00:00:00.000Z" };

describe("buildCostBreakdown", () => {
  it.each([
    {
      name: "a subscription turn is plan value, not billed",
      row: {},
      billed: 0,
      plan: 1,
    },
    {
      name: "an API-key turn is billed at the provider's own figure when it sent one",
      row: { account: { provider: "claude", kind: "api_key" as const }, costUsd: 0.8, costSource: "provider" as const },
      billed: 0.8,
      plan: 0,
    },
    {
      name: "an API-key turn with no provider bill is billed at list price",
      row: { account: { provider: "claude", kind: "api_key" as const } },
      billed: 1,
      plan: 0,
    },
    {
      name: "a subscription routed to another bill (a keyed preset) is billed",
      row: { account: { provider: "claude", kind: "subscription" as const, routedAway: "preset" as const } },
      billed: 1,
      plan: 0,
    },
    {
      name: "a local model is neither",
      row: { account: { provider: "opencode", kind: "local" as const } },
      billed: 0,
      plan: 0,
    },
  ])("$name", ({ row, billed, plan }) => {
    const result = buildCostBreakdown({ rows: [turn(row)], by: "account", range, labels });
    expect(result.totals.billedUsd).toBeCloseTo(billed);
    expect(result.totals.planValueUsd).toBeCloseTo(plan);
    expect(result.totals.costUsd).toBeCloseTo(1);
  });

  it("folds deleted lanes and chats into one row each, counting what went in", () => {
    const rows = [
      turn({ sessionId: "gone-1", laneId: "dead-1", apiEquivalentUsd: 2 }),
      turn({ sessionId: "gone-2", laneId: "dead-2", apiEquivalentUsd: 3 }),
      turn({ sessionId: "chat-a", laneId: "lane-a", apiEquivalentUsd: 1 }),
    ];
    const byLane = buildCostBreakdown({ rows, by: "lane", range, labels });
    expect(byLane.rows.map((row) => [row.label, row.costUsd])).toEqual([["Deleted lanes (2)", 5], ["Lane A", 1]]);
    const byChat = buildCostBreakdown({ rows, by: "chat", range, labels });
    expect(byChat.rows.map((row) => [row.label, row.costUsd])).toEqual([["Deleted chats (2)", 5], ["Chat A", 1]]);
  });

  it("counts one login reached through two provider instances as one account", () => {
    const rows = [
      turn({ accountKey: "claude:instance-1", account: { provider: "claude", kind: "subscription", email: "Me@Example.com", instanceId: "instance-1" } }),
      turn({ accountKey: "claude:me@example.com", account: { provider: "claude", kind: "subscription", email: "me@example.com" } }),
      turn({ accountKey: "claude:other@example.com", account: { provider: "claude", kind: "subscription", email: "other@example.com" } }),
    ];
    const result = buildCostBreakdown({ rows, by: "account", range, labels });
    expect(result.rows.map((row) => row.turns).sort()).toEqual([1, 2]);
  });

  it("drills into one lane's chats and folds the tail past the limit", () => {
    const rows = [
      turn({ sessionId: "chat-a", apiEquivalentUsd: 4 }),
      turn({ sessionId: "chat-b", laneId: "lane-b", apiEquivalentUsd: 9 }),
      ...["x", "y", "z"].map((id) => turn({ sessionId: `gone-${id}`, laneId: "lane-a", apiEquivalentUsd: 1 })),
    ];
    const lane = buildCostBreakdown({ rows, by: "chat", range, labels, laneId: "lane-a" });
    expect(lane.totals.costUsd).toBeCloseTo(7);
    expect(lane.rows.map((row) => row.label)).toEqual(["Chat A", "Deleted chats (3)"]);

    const limited = buildCostBreakdown({ rows, by: "chat", range, labels, limit: 1 });
    expect(limited.rows.map((row) => row.label)).toEqual(["Chat B"]);
    expect(limited.other).toMatchObject({ count: 2, costUsd: 7 });
  });
});
