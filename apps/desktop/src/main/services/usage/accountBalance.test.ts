import { describe, expect, it } from "vitest";
import type { ProviderInstance } from "../../../shared/types/providerInstances";
import type { UsageAccount, UsageWindow } from "../../../shared/types/usage";
import { pickAlternateInstanceForLimitedChat, pickInstanceForNewChat } from "./accountBalance";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEK_START = Date.parse("2026-09-14T00:00:00.000Z");

function instance(id: string, options: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id,
    provider: "claude",
    label: id === "claude" ? "Default" : id,
    configHome: `/tmp/${id}`,
    isDefault: id === "claude",
    createdAt: new Date(0).toISOString(),
    signedIn: true,
    ...options,
  };
}

function usageWindow(
  instanceId: string,
  windowType: UsageWindow["windowType"],
  percentUsed: number,
  resetsAtMs: number,
): [string, UsageWindow[]] {
  return [
    `claude:${instanceId}`,
    [{
      provider: "claude",
      windowType,
      accountId: `claude:${instanceId}`,
      percentUsed,
      resetsAt: new Date(resetsAtMs).toISOString(),
      resetsInMs: Math.max(0, resetsAtMs - WEEK_START),
      ...(windowType === "weekly" ? { windowDurationMs: WEEK_MS } : {}),
    }],
  ];
}

function accounts(...ids: string[]): UsageAccount[] {
  return ids.map((instanceId) => ({
    id: `claude:${instanceId}`,
    provider: "claude",
    instanceId,
    label: instanceId,
    machines: [{ label: "test" }],
  }));
}

function windowsFor(
  defaults: Record<string, { fiveHour: number; weekly: number }>,
  weeklyResetsAtMs = WEEK_START + WEEK_MS,
): Map<string, UsageWindow[]> {
  const result = new Map<string, UsageWindow[]>();
  for (const [instanceId, values] of Object.entries(defaults)) {
    result.set(instanceId === "claude" ? "claude:claude" : `claude:${instanceId}`, [
      usageWindow(instanceId, "five_hour", values.fiveHour, WEEK_START + 60 * 60 * 1000)[1][0]!,
      usageWindow(instanceId, "weekly", values.weekly, weeklyResetsAtMs)[1][0]!,
    ]);
  }
  return result;
}

describe("pickInstanceForNewChat", () => {
  it("picks the obvious headroom winner", () => {
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("claude"), instance("work")],
      accounts: accounts("claude", "work"),
      windowsByAccountId: windowsFor({ claude: { fiveHour: 80, weekly: 20 }, work: { fiveHour: 20, weekly: 40 } }),
      nowMs: WEEK_START,
    });

    expect(result).toEqual({ instanceId: "work", reason: "weighted headroom" });
  });

  it("lets the weekly window flip the choice late in the week", () => {
    const input = {
      provider: "claude" as const,
      instances: [instance("claude"), instance("work")],
      accounts: accounts("claude", "work"),
      windowsByAccountId: windowsFor({ claude: { fiveHour: 10, weekly: 20 }, work: { fiveHour: 80, weekly: 5 } }),
    };

    expect(pickInstanceForNewChat({ ...input, nowMs: WEEK_START })).toEqual({
      instanceId: "claude",
      reason: "weighted headroom",
    });
    expect(pickInstanceForNewChat({ ...input, nowMs: WEEK_START + WEEK_MS })).toEqual({
      instanceId: "work",
      reason: "weighted headroom",
    });
  });

  it("skips unsigned accounts and keeps the default for an all-unsigned set", () => {
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("claude", { signedIn: false }), instance("work", { signedIn: false })],
      accounts: accounts("claude", "work"),
      windowsByAccountId: windowsFor({ claude: { fiveHour: 0, weekly: 0 }, work: { fiveHour: 0, weekly: 0 } }),
      nowMs: WEEK_START,
    });

    expect(result).toEqual({ instanceId: "claude", reason: "no signed-in instances" });
  });

  it("uses the account that has the available partial reading", () => {
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("claude"), instance("work")],
      accounts: accounts("claude", "work"),
      windowsByAccountId: new Map([
        ["claude:claude", []],
        ["claude:work", usageWindow("work", "weekly", 15, WEEK_START + WEEK_MS)[1]],
      ]),
      nowMs: WEEK_START,
    });

    expect(result).toEqual({ instanceId: "work", reason: "partial usage data" });
  });

  it("falls back to the default when no usage data exists", () => {
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("claude"), instance("work")],
      accounts: accounts("claude", "work"),
      windowsByAccountId: new Map(),
      nowMs: WEEK_START,
    });

    expect(result).toEqual({ instanceId: "claude", reason: "no usage data" });
  });
});

describe("pickAlternateInstanceForLimitedChat", () => {
  const base = {
    provider: "claude" as const,
    instances: [instance("claude"), instance("work", { label: "Work" })],
    accounts: accounts("claude", "work"),
    nowMs: WEEK_START,
  };

  it("picks the other signed-in account that still has room", () => {
    expect(pickAlternateInstanceForLimitedChat({
      ...base,
      currentInstanceId: "claude",
      windowsByAccountId: windowsFor({
        claude: { fiveHour: 10, weekly: 10 },
        work: { fiveHour: 40, weekly: 20 },
      }),
    })).toEqual({
      instanceId: "work",
      label: "Work",
      reason: "weighted headroom",
    });
  });

  it("ignores the blocked account even when its snapshot still looks freer", () => {
    expect(pickAlternateInstanceForLimitedChat({
      ...base,
      currentInstanceId: "work",
      windowsByAccountId: windowsFor({
        claude: { fiveHour: 90, weekly: 90 },
        work: { fiveHour: 5, weekly: 5 },
      }),
    })?.instanceId).toBe("claude");
  });

  it("returns null when the other account has no windows", () => {
    expect(pickAlternateInstanceForLimitedChat({
      ...base,
      currentInstanceId: "claude",
      windowsByAccountId: windowsFor({ claude: { fiveHour: 20, weekly: 10 } }),
    })).toBeNull();
  });

  it("returns null when a window on the other account is already full", () => {
    expect(pickAlternateInstanceForLimitedChat({
      ...base,
      currentInstanceId: "claude",
      windowsByAccountId: windowsFor({
        claude: { fiveHour: 100, weekly: 10 },
        work: { fiveHour: 100, weekly: 10 },
      }),
    })).toBeNull();
    expect(pickAlternateInstanceForLimitedChat({
      ...base,
      currentInstanceId: "claude",
      windowsByAccountId: windowsFor({
        claude: { fiveHour: 10, weekly: 100 },
        work: { fiveHour: 10, weekly: 100 },
      }),
    })).toBeNull();
  });

  it("offers a complete account when the higher partial score has a missing window", () => {
    const windows = windowsFor({
      claude: { fiveHour: 100, weekly: 10 },
      personal: { fiveHour: 20, weekly: 20 },
    });
    const weeklyOnly = usageWindow("work", "weekly", 10, WEEK_START + WEEK_MS);
    windows.set(weeklyOnly[0], weeklyOnly[1]);
    expect(pickAlternateInstanceForLimitedChat({
      ...base,
      instances: [instance("claude"), instance("work", { label: "Work" }), instance("personal", { label: "Personal" })],
      accounts: accounts("claude", "work", "personal"),
      currentInstanceId: "claude",
      windowsByAccountId: windows,
    })?.instanceId).toBe("personal");
  });

  it("returns null when the only other account is signed out", () => {
    expect(pickAlternateInstanceForLimitedChat({
      ...base,
      instances: [instance("claude"), instance("work", { signedIn: false, label: "Work" })],
      currentInstanceId: "claude",
      windowsByAccountId: windowsFor({
        claude: { fiveHour: 100, weekly: 10 },
        work: { fiveHour: 10, weekly: 10 },
      }),
    })).toBeNull();
  });
});
