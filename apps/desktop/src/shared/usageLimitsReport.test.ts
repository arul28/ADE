import { describe, expect, it } from "vitest";
import type { UsageSnapshot } from "./types/usage";
import { buildUsageLimitsReport, usageLimitsLeftText, usageLimitsPaceText } from "./usageLimitsReport";

const NOW_MS = Date.parse("2026-10-23T12:00:00.000Z");
const LATER = "2026-10-23T18:00:00.000Z";
const EARLIER = "2026-10-23T06:00:00.000Z";

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    windows: [],
    accounts: [],
    pacing: {} as UsageSnapshot["pacing"],
    costs: [],
    extraUsage: [],
    lastPolledAt: "2026-10-23T11:55:00.000Z",
    errors: [],
    ...overrides,
  };
}

describe("buildUsageLimitsReport", () => {
  it("marks the account the asking chat runs on and the one smart balance would start", () => {
    const report = buildUsageLimitsReport(snapshot({
      accounts: [
        { id: "claude:claude-2", provider: "claude", instanceId: "claude-2", email: "work@example.com", machines: [] },
        { id: "claude:claude-3", provider: "claude", instanceId: "claude-3", email: "home@example.com", machines: [] },
      ],
      windows: [
        { provider: "claude", windowType: "weekly", accountId: "claude:claude-2", percentUsed: 40, resetsAt: LATER, resetsInMs: 1 },
        { provider: "claude", windowType: "weekly", accountId: "claude:claude-3", percentUsed: 20, resetsAt: LATER, resetsInMs: 1 },
      ],
      // The asking chat is on claude-3, while smart balance would pick claude-2.
      balanceNext: [{ provider: "claude", instanceId: "claude-2" }],
    }), {
      nowMs: NOW_MS,
      chat: { provider: "claude", instanceId: "claude-3" },
    });

    const byId = new Map(report.accounts.map((account) => [account.instanceId, account]));
    expect(byId.get("claude-3")).toMatchObject({ thisChat: true, nextChat: false });
    expect(byId.get("claude-2")).toMatchObject({ thisChat: false, nextChat: true });
    expect(report.chat).toEqual({ provider: "claude", instanceId: "claude-3" });
  });

  it("reads a window whose reset passed since the reading as full again", () => {
    const report = buildUsageLimitsReport(snapshot({
      accounts: [{ id: "claude:claude-2", provider: "claude", instanceId: "claude-2", machines: [] }],
      windows: [
        // 92% used, but that reading is from before the reset.
        { provider: "claude", windowType: "five_hour", accountId: "claude:claude-2", percentUsed: 92, resetsAt: EARLIER, resetsInMs: 0 },
        { provider: "claude", windowType: "weekly", accountId: "claude:claude-2", percentUsed: 40, resetsAt: LATER, resetsInMs: 1 },
      ],
    }), { nowMs: NOW_MS });

    const [account] = report.accounts;
    const fiveHour = account?.windows.find((window) => window.type === "five_hour");
    const weekly = account?.windows.find((window) => window.type === "weekly");
    expect(fiveHour).toMatchObject({ percentLeft: 100, hasReset: true, resetsInMinutes: null });
    expect(fiveHour?.pace).toBeUndefined();
    expect(usageLimitsLeftText(fiveHour!)).toBe("100%");
    expect(usageLimitsPaceText(fiveHour!)).toMatch(/full again/);
    // A reading whose reset has not passed keeps its fill.
    expect(weekly).toMatchObject({ percentLeft: 60 });
    expect(weekly?.hasReset).toBeUndefined();
  });
});
