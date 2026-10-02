import { describe, expect, it } from "vitest";
import type { ProviderInstance } from "../../../shared/types/providerInstances";
import type { UsageAccount, UsageAccountLogin, UsageWindow } from "../../../shared/types/usage";
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

/**
 * One account's windows. `weekly`/`fiveHour` are percentUsed; omit either to
 * model an account the provider has no reading for in that window (a missing
 * five-hour window is an idle account, not a full one).
 */
function windowSet(
  instanceId: string,
  values: { fiveHour?: number; weekly?: number },
  resets: { weekly?: number; fiveHour?: number } = {},
): [string, UsageWindow[]] {
  const key = `claude:${instanceId}`;
  const windows: UsageWindow[] = [];
  if (values.fiveHour !== undefined) {
    const resetsAtMs = resets.fiveHour ?? WEEK_START + 60 * 60 * 1000;
    windows.push({
      provider: "claude",
      windowType: "five_hour",
      accountId: key,
      percentUsed: values.fiveHour,
      resetsAt: new Date(resetsAtMs).toISOString(),
      resetsInMs: Math.max(0, resetsAtMs - WEEK_START),
    });
  }
  if (values.weekly !== undefined) {
    const resetsAtMs = resets.weekly ?? WEEK_START + WEEK_MS;
    windows.push({
      provider: "claude",
      windowType: "weekly",
      accountId: key,
      percentUsed: values.weekly,
      resetsAt: new Date(resetsAtMs).toISOString(),
      resetsInMs: Math.max(0, resetsAtMs - WEEK_START),
      windowDurationMs: WEEK_MS,
    });
  }
  return [key, windows];
}

function windows(...entries: Array<[string, UsageWindow[]]>): Map<string, UsageWindow[]> {
  return new Map(entries);
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

/** Attach a login state to each named account in a snapshot. */
function withLogins(
  base: UsageAccount[],
  logins: Record<string, UsageAccountLogin>,
): UsageAccount[] {
  return base.map((account) => {
    const instanceId = account.instanceId;
    const login = instanceId ? logins[instanceId] : undefined;
    return { ...account, ...(login ? { login } : {}) };
  });
}

describe("pickInstanceForNewChat", () => {
  it("keeps the default account when the weekly resets and five-hour room tie", () => {
    // Both weekly windows reset at the same moment and both have the same
    // five-hour room, so the ranking cannot separate them. The tie goes to the
    // default account (`claude`), listed second, not to whichever came first.
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("work"), instance("claude")],
      accounts: accounts("claude", "work"),
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 20, weekly: 60 }),
        windowSet("work", { fiveHour: 20, weekly: 20 }),
      ),
      nowMs: WEEK_START,
    });

    expect(result).toEqual({ instanceId: "claude", reason: "soonest weekly reset" });
  });

  it("prefers the account whose weekly room expires sooner", () => {
    // Equal room; `work`'s window resets tomorrow and `claude`'s in six days,
    // so `work` is spent first even though `claude` is the default account.
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("claude"), instance("work")],
      accounts: accounts("claude", "work"),
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 10, weekly: 50 }, { weekly: WEEK_START + 6 * 24 * 60 * 60_000 }),
        windowSet("work", { fiveHour: 10, weekly: 50 }, { weekly: WEEK_START + 24 * 60 * 60_000 }),
      ),
      nowMs: WEEK_START,
    });

    expect(result).toEqual({ instanceId: "work", reason: "soonest weekly reset" });
  });

  it("ranks a nearly-spent five-hour window last when it is not about to reset", () => {
    // `claude` has the sooner weekly reset, so it would win on that alone. But
    // only 20% of its five-hour window is left and that window is two hours
    // away from resetting, so a chat there stops within the hour. `work` wins.
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("claude"), instance("work")],
      accounts: accounts("claude", "work"),
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 80, weekly: 90 }, {
          weekly: WEEK_START + 24 * 60 * 60_000,
          fiveHour: WEEK_START + 2 * 60 * 60_000,
        }),
        windowSet("work", { fiveHour: 20, weekly: 40 }, { weekly: WEEK_START + 6 * 24 * 60 * 60_000 }),
      ),
      nowMs: WEEK_START,
    });

    expect(result).toEqual({ instanceId: "work", reason: "soonest weekly reset" });
  });

  it("treats an idle account with no five-hour window as having full five-hour room", () => {
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("claude"), instance("work")],
      accounts: accounts("claude", "work"),
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 20, weekly: 20 }),
        windowSet("work", { weekly: 10 }),
      ),
      nowMs: WEEK_START,
    });

    expect(result).toEqual({ instanceId: "work", reason: "soonest weekly reset" });
  });

  it("skips a signed-out login and keeps balancing on the account that still works", () => {
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("claude"), instance("work")],
      accounts: withLogins(accounts("claude", "work"), { work: "signed_out" }),
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 20, weekly: 60 }),
        windowSet("work", { fiveHour: 20, weekly: 20 }),
      ),
      nowMs: WEEK_START,
    });

    expect(result).toEqual({
      instanceId: "claude",
      reason: "soonest weekly reset",
      signedOutInstanceIds: ["work"],
    });
  });

  it.each<[string, ProviderInstance[], UsageAccount[], Map<string, UsageWindow[]>, string]>([
    ["a single signed-in account", [instance("claude")], accounts("claude"), windows(), "one_account"],
    [
      "accounts with no readable windows",
      [instance("claude"), instance("work")],
      accounts("claude", "work"),
      windows(),
      "no_usage_data",
    ],
    [
      "every account at its limit",
      [instance("claude"), instance("work")],
      accounts("claude", "work"),
      windows(
        windowSet("claude", { fiveHour: 95, weekly: 10 }),
        windowSet("work", { fiveHour: 95, weekly: 10 }),
      ),
      "all_full",
    ],
    [
      "every login signed out",
      [instance("claude"), instance("work")],
      withLogins(accounts("claude", "work"), { claude: "signed_out", work: "signed_out" }),
      windows(
        windowSet("claude", { fiveHour: 20, weekly: 20 }),
        windowSet("work", { fiveHour: 20, weekly: 20 }),
      ),
      "all_signed_out",
    ],
  ])("skips balance with %s", (_label, instances, accountList, windowsByAccountId, skip) => {
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances,
      accounts: accountList,
      windowsByAccountId,
      nowMs: WEEK_START,
    });

    expect(result.instanceId).toBe("claude");
    expect(result.skip).toBe(skip);
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
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 10, weekly: 10 }),
        windowSet("work", { fiveHour: 40, weekly: 20 }),
      ),
    })).toEqual({
      instanceId: "work",
      label: "Work",
      reason: "soonest weekly reset",
    });
  });

  it("ignores the blocked account even when its snapshot still looks freer", () => {
    expect(pickAlternateInstanceForLimitedChat({
      ...base,
      currentInstanceId: "work",
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 90, weekly: 90 }),
        windowSet("work", { fiveHour: 5, weekly: 5 }),
      ),
    })?.instanceId).toBe("claude");
  });

  it("returns null when the other account has no windows", () => {
    expect(pickAlternateInstanceForLimitedChat({
      ...base,
      currentInstanceId: "claude",
      windowsByAccountId: windows(windowSet("claude", { fiveHour: 20, weekly: 10 })),
    })).toBeNull();
  });

  it("returns null when the other account has no weekly reading", () => {
    expect(pickAlternateInstanceForLimitedChat({
      ...base,
      currentInstanceId: "claude",
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 20, weekly: 10 }),
        windowSet("work", { fiveHour: 20 }),
      ),
    })).toBeNull();
  });

  it.each([
    ["five-hour", { fiveHour: 100, weekly: 10 }],
    ["weekly", { fiveHour: 10, weekly: 100 }],
  ])("returns null when the other account's %s window is already full", (_label, workWindows) => {
    expect(pickAlternateInstanceForLimitedChat({
      ...base,
      currentInstanceId: "claude",
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 20, weekly: 10 }),
        windowSet("work", workWindows),
      ),
    })).toBeNull();
  });

  it("prefers an idle account with no five-hour window over a busier complete one", () => {
    expect(pickAlternateInstanceForLimitedChat({
      ...base,
      instances: [
        instance("claude"),
        instance("work", { label: "Work" }),
        instance("personal", { label: "Personal" }),
      ],
      accounts: accounts("claude", "work", "personal"),
      currentInstanceId: "claude",
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 20, weekly: 10 }),
        windowSet("work", { weekly: 10 }),
        windowSet("personal", { fiveHour: 20, weekly: 20 }),
      ),
    })?.instanceId).toBe("work");
  });

  it("returns null when the only other account is signed out", () => {
    expect(pickAlternateInstanceForLimitedChat({
      ...base,
      instances: [instance("claude"), instance("work", { signedIn: false, label: "Work" })],
      currentInstanceId: "claude",
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 100, weekly: 10 }),
        windowSet("work", { fiveHour: 10, weekly: 10 }),
      ),
    })).toBeNull();
  });

  it("returns null when the only other account's saved login is gone", () => {
    expect(pickAlternateInstanceForLimitedChat({
      ...base,
      accounts: withLogins(accounts("claude", "work"), { work: "signed_out" }),
      currentInstanceId: "claude",
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 20, weekly: 10 }),
        windowSet("work", { fiveHour: 20, weekly: 10 }),
      ),
    })).toBeNull();
  });
});
