import { describe, expect, it } from "vitest";
import type { ProviderInstance } from "../../../shared/types/providerInstances";
import type { UsageAccount, UsageAccountLogin, UsageWindow } from "../../../shared/types/usage";
import {
  pickAlternateInstanceForLimitedChat,
  pickInstanceForNewChat,
  type AccountBalanceLoad,
} from "./accountBalance";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
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
  return windowSetForProvider("claude", instanceId, values, resets);
}

function windowSetForProvider(
  provider: "claude" | "codex",
  instanceId: string,
  values: { fiveHour?: number; weekly?: number },
  resets: { weekly?: number; fiveHour?: number } = {},
): [string, UsageWindow[]] {
  const key = `${provider}:${instanceId}`;
  const windows: UsageWindow[] = [];
  if (values.fiveHour !== undefined) {
    const resetsAtMs = resets.fiveHour ?? WEEK_START + HOUR_MS;
    windows.push({
      provider,
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
      provider,
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
  return accountsForProvider("claude", ...ids);
}

function accountsForProvider(provider: "claude" | "codex", ...ids: string[]): UsageAccount[] {
  return ids.map((instanceId) => ({
    id: `${provider}:${instanceId}`,
    provider,
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

function load(entries: Record<string, AccountBalanceLoad>): Map<string, AccountBalanceLoad> {
  return new Map(Object.entries(entries));
}

const HOURS = (hours: number): number => WEEK_START + hours * HOUR_MS;

describe("pickInstanceForNewChat", () => {
  it("feeds the account that needs the most weekly room spent before its reset", () => {
    // The screenshot state: Default has 72% left and resets in 46h, 1028 has
    // 38% left and resets in 42h. Reset order alone picks 1028; the required
    // rate (72/46 = 1.57 vs 38/42 = 0.90) picks Default, the account that
    // would otherwise let the most room expire.
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("claude"), instance("90"), instance("1028")],
      accounts: accounts("claude", "90", "1028"),
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 11, weekly: 28 }, { fiveHour: HOURS(1.1), weekly: HOURS(46) }),
        windowSet("90", { fiveHour: 1, weekly: 64 }, { fiveHour: HOURS(4.6), weekly: HOURS(94) }),
        windowSet("1028", { fiveHour: 0, weekly: 62 }, { fiveHour: HOURS(4.27), weekly: HOURS(42) }),
      ),
      nowMs: WEEK_START,
    });

    expect(result).toEqual({
      instanceId: "claude",
      reason: "most room to spend before reset",
    });
  });

  it("keeps the sooner weekly reset when the room is equal", () => {
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("claude"), instance("work"), instance("third")],
      accounts: accounts("claude", "work", "third"),
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 20, weekly: 50 }, { weekly: HOURS(40) }),
        windowSet("work", { fiveHour: 20, weekly: 50 }, { weekly: HOURS(20) }),
        windowSet("third", { fiveHour: 20, weekly: 50 }, { weekly: HOURS(60) }),
      ),
      nowMs: WEEK_START,
    });

    expect(result).toMatchObject({ instanceId: "work", reason: "most room to spend before reset" });
  });

  it("subtracts the chats already running on an account", () => {
    // Default and 1028 each carry three running chats; 90 carries none. The
    // sixth chat belongs on 90, not on the account with the soonest reset.
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("claude"), instance("90"), instance("1028")],
      accounts: accounts("claude", "90", "1028"),
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 11, weekly: 28 }, { fiveHour: HOURS(1.1), weekly: HOURS(46) }),
        windowSet("90", { fiveHour: 1, weekly: 64 }, { fiveHour: HOURS(4.6), weekly: HOURS(94) }),
        windowSet("1028", { fiveHour: 0, weekly: 62 }, { fiveHour: HOURS(4.27), weekly: HOURS(42) }),
      ),
      loadByInstanceId: load({
        claude: { runningWeight: 3 },
        "1028": { runningWeight: 3 },
      }),
      nowMs: WEEK_START,
    });

    expect(result.instanceId).toBe("90");
  });

  it("uses expiring weekly room that cannot run out before its reset", () => {
    // 1028 has 6% left but only two hours to spend it. A normal chat cannot
    // burn six points that fast, and the reset refills the account mid-chat.
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("claude"), instance("work"), instance("1028")],
      accounts: accounts("claude", "work", "1028"),
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 20, weekly: 60 }, { weekly: HOURS(60) }),
        windowSet("work", { fiveHour: 20, weekly: 45 }, { weekly: HOURS(30) }),
        windowSet("1028", { fiveHour: 20, weekly: 94 }, { weekly: HOURS(2) }),
      ),
      nowMs: WEEK_START,
    });

    expect(result.instanceId).toBe("1028");
  });

  it("refuses a five-hour window that cannot carry the chats already on it", () => {
    // Default has the most weekly room and the soonest reset, but 20% of its
    // five-hour window with three chats on it projects to 6.5 points of room:
    // a new chat would stop almost immediately.
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("claude"), instance("work"), instance("1028")],
      accounts: accounts("claude", "work", "1028"),
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 80, weekly: 30 }, { fiveHour: HOURS(3), weekly: HOURS(30) }),
        windowSet("work", { fiveHour: 10, weekly: 65 }, { fiveHour: HOURS(4), weekly: HOURS(90) }),
        windowSet("1028", { fiveHour: 40, weekly: 60 }, { fiveHour: HOURS(3), weekly: HOURS(40) }),
      ),
      loadByInstanceId: load({
        claude: { runningWeight: 3 },
        work: { runningWeight: 1 },
        "1028": { runningWeight: 1 },
      }),
      nowMs: WEEK_START,
    });

    expect(result.instanceId).toBe("1028");
  });

  it("does not give a near-reset five-hour window a free pass", () => {
    // 8% of the five-hour window with two chats running, 18 minutes before the
    // reset, still has to cover a first turn. It does not.
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("claude"), instance("work"), instance("1028")],
      accounts: accounts("claude", "work", "1028"),
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 92, weekly: 20 }, { fiveHour: HOURS(0.3), weekly: HOURS(42) }),
        windowSet("work", { fiveHour: 20, weekly: 70 }, { fiveHour: HOURS(3), weekly: HOURS(42) }),
        windowSet("1028", { fiveHour: 15, weekly: 80 }, { fiveHour: HOURS(4), weekly: HOURS(60) }),
      ),
      loadByInstanceId: load({ claude: { runningWeight: 2 } }),
      nowMs: WEEK_START,
    });

    expect(result.instanceId).toBe("work");
  });

  it("reserves weekly room for recently idle chats, but not forever", () => {
    // Eight chats just went idle on Default; eight chats idle for two days are
    // almost certainly not coming back. The first case pushes the chat away,
    // the second leaves Default as the pick.
    const args = {
      provider: "claude" as const,
      instances: [instance("claude"), instance("work"), instance("1028")],
      accounts: accounts("claude", "work", "1028"),
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 20, weekly: 34 }, { weekly: HOURS(50) }),
        windowSet("work", { fiveHour: 20, weekly: 40 }, { weekly: HOURS(50) }),
        windowSet("1028", { fiveHour: 20, weekly: 48 }, { weekly: HOURS(50) }),
      ),
      nowMs: WEEK_START,
    };
    const idle = (idleMs: number) => ({ idle: Array.from({ length: 8 }, () => ({ idleMs })) });

    expect(pickInstanceForNewChat({
      ...args,
      loadByInstanceId: load({ claude: idle(0) }),
    }).instanceId).toBe("work");

    expect(pickInstanceForNewChat({
      ...args,
      loadByInstanceId: load({ claude: idle(48 * HOUR_MS) }),
    }).instanceId).toBe("claude");
  });

  it("waits on the roomiest account when its reset is days away", () => {
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("claude"), instance("work"), instance("1028")],
      accounts: accounts("claude", "work", "1028"),
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 10, weekly: 20 }, { weekly: HOURS(120) }),
        windowSet("work", { fiveHour: 30, weekly: 70 }, { weekly: HOURS(30) }),
        windowSet("1028", { fiveHour: 20, weekly: 55 }, { weekly: HOURS(50) }),
      ),
      loadByInstanceId: load({ work: { runningWeight: 1 } }),
      nowMs: WEEK_START,
    });

    expect(result.instanceId).toBe("1028");
  });

  it("still starts the chat when every account is at or beyond its pace", () => {
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("claude"), instance("work"), instance("1028")],
      accounts: accounts("claude", "work", "1028"),
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 70, weekly: 88 }, { fiveHour: HOURS(3), weekly: HOURS(20) }),
        windowSet("work", { fiveHour: 40, weekly: 92 }, { fiveHour: HOURS(2), weekly: HOURS(40) }),
        windowSet("1028", { fiveHour: 60, weekly: 95 }, { fiveHour: HOURS(4), weekly: HOURS(10) }),
      ),
      loadByInstanceId: load({
        claude: { runningWeight: 2 },
        work: { runningWeight: 2 },
        "1028": { runningWeight: 1 },
      }),
      nowMs: WEEK_START,
    });

    // 1028 is exactly on pace and has 5% weekly left: still the least-ahead.
    expect(result).toMatchObject({ instanceId: "1028" });
    expect(result.skip).toBeUndefined();
  });

  it("prefers a measured burn rate over the chat-count prior", () => {
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("claude"), instance("1028")],
      accounts: accounts("claude", "1028"),
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 20, weekly: 28 }, { weekly: HOURS(46) }),
        windowSet("1028", { fiveHour: 20, weekly: 62 }, { weekly: HOURS(42) }),
      ),
      loadByInstanceId: load({
        claude: { weeklyRate: 2 },
        "1028": { weeklyRate: 0 },
      }),
      nowMs: WEEK_START,
    });

    expect(result.instanceId).toBe("1028");
  });

  it("weights a running Fable chat far above a running Haiku chat", () => {
    // Default runs two Fable chats (weight 2.4 each) and 90 runs two Haiku
    // chats (0.3 each). Without the model weight the two accounts tie on load
    // and Default wins on its sooner reset; with it, 90 is the quiet account.
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("claude"), instance("work"), instance("1028")],
      accounts: accounts("claude", "work", "1028"),
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 20, weekly: 40 }, { weekly: HOURS(40) }),
        windowSet("work", { fiveHour: 20, weekly: 55 }, { weekly: HOURS(40) }),
        windowSet("1028", { fiveHour: 15, weekly: 70 }, { weekly: HOURS(60) }),
      ),
      loadByInstanceId: load({
        claude: { runningWeight: 2 * 2.4 },
        work: { runningWeight: 2 * 0.3 },
      }),
      nowMs: WEEK_START,
    });

    expect(result.instanceId).toBe("work");
  });

  it("lets the sooner reset win when two deficits are within the tie band", () => {
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("claude"), instance("work")],
      accounts: accounts("claude", "work"),
      windowsByAccountId: windows(
        // Default needs 1.750/h; work needs 1.744/h but resets an hour sooner.
        windowSet("claude", { fiveHour: 20, weekly: 30 }, { weekly: HOURS(40) }),
        windowSet("work", { fiveHour: 20, weekly: 32 }, { weekly: HOURS(39) }),
      ),
      nowMs: WEEK_START,
    });

    expect(result.instanceId).toBe("work");
  });

  it("treats a missing five-hour window as an idle account with full room", () => {
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

    expect(result.instanceId).toBe("work");
  });

  it("applies the same ranking to Codex", () => {
    const result = pickInstanceForNewChat({
      provider: "codex",
      instances: [
        { ...instance("codex", { provider: "codex" }), isDefault: true },
        instance("work", { provider: "codex" }),
      ],
      accounts: accountsForProvider("codex", "codex", "work"),
      windowsByAccountId: windows(
        windowSetForProvider("codex", "codex", { fiveHour: 11, weekly: 28 }, {
          fiveHour: HOURS(1.1),
          weekly: HOURS(46),
        }),
        windowSetForProvider("codex", "work", { fiveHour: 0, weekly: 62 }, {
          fiveHour: HOURS(4.27),
          weekly: HOURS(42),
        }),
      ),
      nowMs: WEEK_START,
    });

    expect(result.instanceId).toBe("codex");
  });

  it("falls back to the best survivor when every account is blocked", () => {
    const result = pickInstanceForNewChat({
      provider: "claude",
      instances: [instance("claude"), instance("work")],
      accounts: accounts("claude", "work"),
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 90, weekly: 96 }, { weekly: HOURS(40) }),
        windowSet("work", { fiveHour: 95, weekly: 97 }, { weekly: HOURS(40) }),
      ),
      nowMs: WEEK_START,
    });

    expect(result).toMatchObject({
      instanceId: "claude",
      skip: "all_full",
      reason: "least likely to run dry",
    });
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
      reason: "most room to spend before reset",
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
        windowSet("claude", { fiveHour: 95, weekly: 96 }),
        windowSet("work", { fiveHour: 95, weekly: 97 }),
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

    expect(result.skip).toBe(skip);
  });
});

describe("pickAlternateInstanceForLimitedChat", () => {
  const base = {
    provider: "claude" as const,
    instances: [
      instance("claude"),
      instance("work", { label: "Work" }),
      instance("personal", { label: "Personal" }),
    ],
    accounts: accounts("claude", "work", "personal"),
    nowMs: WEEK_START,
  };

  it("picks the other account with the most projected five-hour room", () => {
    expect(pickAlternateInstanceForLimitedChat({
      ...base,
      currentInstanceId: "claude",
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 10, weekly: 10 }),
        windowSet("work", { fiveHour: 40, weekly: 20 }),
        windowSet("personal", { fiveHour: 60, weekly: 20 }),
      ),
    })).toEqual({
      instanceId: "work",
      label: "Work",
      reason: "most five-hour room left",
    });
  });

  it("does not move onto an account that is about to run dry", () => {
    expect(pickAlternateInstanceForLimitedChat({
      ...base,
      currentInstanceId: "claude",
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 20, weekly: 10 }),
        windowSet("work", { fiveHour: 30, weekly: 50 }, { fiveHour: HOURS(3) }),
        windowSet("personal", { fiveHour: 70, weekly: 20 }),
      ),
      loadByInstanceId: load({ work: { fiveHourRate: 30 } }),
    })?.instanceId).toBe("personal");
  });

  it("ignores the blocked account even when its snapshot still looks freer", () => {
    expect(pickAlternateInstanceForLimitedChat({
      ...base,
      currentInstanceId: "work",
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 10, weekly: 10 }),
        windowSet("work", { fiveHour: 95, weekly: 95 }),
        windowSet("personal", { fiveHour: 60, weekly: 20 }),
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
      instances: [instance("claude"), instance("work", { label: "Work" })],
      accounts: accounts("claude", "work"),
      windowsByAccountId: windows(
        windowSet("claude", { fiveHour: 20, weekly: 10 }),
        windowSet("work", workWindows),
      ),
    })).toBeNull();
  });

  it("prefers an idle account with no five-hour window over a busier complete one", () => {
    expect(pickAlternateInstanceForLimitedChat({
      ...base,
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
