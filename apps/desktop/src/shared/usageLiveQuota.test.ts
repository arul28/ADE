import { describe, expect, it } from "vitest";
import type { AdeUsageLiveEnvironment, UsageAccount, UsageWindow } from "./types/usage";
import { liveAccountPoolKey, poolLiveQuota } from "./usageLiveQuota";

const account = (overrides: Partial<UsageAccount> & { id: string }): UsageAccount => ({
  provider: "claude",
  machines: [{ label: "Mac" }],
  ...overrides,
});

const window = (overrides: Partial<UsageWindow> & { windowType: UsageWindow["windowType"] }): UsageWindow => ({
  provider: "claude",
  percentUsed: 40,
  resetsAt: "2026-09-25T18:00:00.000Z",
  resetsInMs: 3_600_000,
  ...overrides,
});

const environment = (
  overrides: Partial<AdeUsageLiveEnvironment> & { machineKey: string },
): AdeUsageLiveEnvironment => ({
  label: overrides.machineKey,
  platform: "darwin",
  isLocal: false,
  state: "live",
  windows: [],
  accounts: [],
  ...overrides,
});

describe("poolLiveQuota", () => {
  it("counts one login reported by two machines once, freshest reading wins", () => {
    const environments = [
      environment({
        machineKey: "mac",
        isLocal: true,
        accounts: [account({ id: "claude:a@example.com", email: "a@example.com" })],
        windows: [
          window({ windowType: "five_hour", accountId: "claude:a@example.com", percentUsed: 20 }),
          window({ windowType: "weekly", accountId: "claude:a@example.com", percentUsed: 10 }),
        ],
      }),
      environment({
        machineKey: "nuc",
        accounts: [account({ id: "claude:work", email: "a@example.com", machines: [{ label: "nuc" }] })],
        windows: [
          window({ windowType: "five_hour", accountId: "claude:work", percentUsed: 80 }),
          window({ windowType: "weekly", accountId: "claude:work", percentUsed: 90 }),
        ],
      }),
    ];

    const pooled = poolLiveQuota(environments);

    expect(pooled.accounts).toHaveLength(1);
    expect(pooled.accounts[0]?.email).toBe("a@example.com");
    // Both machines' labels are kept on the one pooled account.
    expect(pooled.accounts[0]?.machines.map((machine) => machine.label).sort()).toEqual(["Mac", "nuc"]);
    // One window per label, from the first (freshest) environment.
    expect(pooled.windows).toHaveLength(2);
    expect(pooled.windows.find((entry) => entry.windowType === "five_hour")?.percentUsed).toBe(20);
    expect(pooled.windows.find((entry) => entry.windowType === "weekly")?.percentUsed).toBe(10);
  });

  it("keeps monthly separate from session and weekly, and only pools windows an account reports", () => {
    const environments = [
      environment({
        machineKey: "mac",
        accounts: [account({ id: "claude:a@example.com", email: "a@example.com" })],
        windows: [window({ windowType: "five_hour", accountId: "claude:a@example.com" })],
      }),
      environment({
        machineKey: "nuc",
        accounts: [account({ id: "claude:b@example.com", email: "b@example.com" })],
        windows: [window({ windowType: "monthly", accountId: "claude:b@example.com" })],
      }),
    ];

    const pooled = poolLiveQuota(environments);

    expect(pooled.windows.map((entry) => entry.windowType).sort()).toEqual(["five_hour", "monthly"]);
    expect(pooled.accounts.map((entry) => entry.email).sort()).toEqual(["a@example.com", "b@example.com"]);
  });

  it("recomputes the pool for an environment selection, including an empty one", () => {
    const environments = [
      environment({
        machineKey: "mac",
        accounts: [account({ id: "claude:a@example.com", email: "a@example.com" })],
        windows: [window({ windowType: "weekly", accountId: "claude:a@example.com" })],
      }),
      environment({
        machineKey: "nuc",
        accounts: [account({ id: "claude:b@example.com", email: "b@example.com" })],
        windows: [window({ windowType: "weekly", accountId: "claude:b@example.com" })],
      }),
    ];

    expect(poolLiveQuota(environments, new Set(["nuc"])).accounts.map((entry) => entry.email))
      .toEqual(["b@example.com"]);
    expect(poolLiveQuota(environments, new Set())).toEqual({ windows: [], accounts: [] });
  });

  it("leaves a failed environment out of the pool rather than inventing a window", () => {
    const environments = [
      environment({
        machineKey: "mac",
        accounts: [account({ id: "claude:a@example.com", email: "a@example.com" })],
        windows: [window({ windowType: "weekly", accountId: "claude:a@example.com" })],
      }),
      environment({ machineKey: "dead", state: "failed" }),
    ];

    expect(poolLiveQuota(environments).windows).toHaveLength(1);
    expect(poolLiveQuota(environments, new Set(["dead"]))).toEqual({ windows: [], accounts: [] });
  });

  it("does not pool a login with no email across machines", () => {
    const anonymous = account({ id: "claude:local" });
    expect(liveAccountPoolKey(anonymous)).toBe("claude:local");
    expect(liveAccountPoolKey(account({ id: "claude:work", email: "a@example.com" })))
      .toBe("claude:a@example.com");
  });
});
