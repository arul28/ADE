import { describe, expect, it } from "vitest";
import type { AdeUsageLiveEnvironment, UsageAccount, UsageWindow } from "./types/usage";
import { liveAccountPoolKey, poolLiveQuota, poolPeerQuota, type PeerLiveQuota } from "./usageLiveQuota";

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

/**
 * A machine's own usage view, pooled with what its peers read. Quota belongs
 * to the login: each login this machine holds shows the freshest reading from
 * any machine (machines name one login differently, so it is matched by
 * email), and logins only another machine holds are shown but never picked.
 */
describe("poolPeerQuota", () => {
  const NOW = Date.parse("2026-09-25T12:00:00.000Z");
  const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
  const later = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
  const peer = (overrides: Partial<PeerLiveQuota> & { machineKey: string }): PeerLiveQuota => ({
    label: overrides.machineKey,
    windows: [],
    accounts: [],
    ...overrides,
  });

  it("takes each login's freshest reading from any machine, and keeps a fresher local one", () => {
    // This machine: login A's token expired three hours ago (old numbers); login
    // B was read a minute ago. The studio names both logins differently.
    const local = {
      windows: [
        window({ windowType: "weekly", accountId: "claude:claude", percentUsed: 5, resetsAt: later(40) }),
        window({ windowType: "weekly", accountId: "claude:beats", percentUsed: 30, resetsAt: later(14) }),
      ],
      accounts: [
        account({ id: "claude:claude", email: "a@example.com", login: "expired", machines: [{ label: "laptop", checkedAt: at(180) }] }),
        account({ id: "claude:beats", email: "b@example.com", login: "ok", machines: [{ label: "laptop", checkedAt: at(1) }] }),
      ],
    };
    const studio = peer({
      machineKey: "studio",
      accounts: [
        account({ id: "claude:1028", email: "A@example.com", login: "ok", machines: [{ label: "studio", checkedAt: at(2) }] }),
        account({ id: "claude:other", email: "b@example.com", login: "ok", machines: [{ label: "studio", checkedAt: at(30) }] }),
      ],
      windows: [
        window({ windowType: "weekly", accountId: "claude:1028", percentUsed: 60, resetsAt: later(40) }),
        window({ windowType: "weekly", accountId: "claude:other", percentUsed: 90, resetsAt: later(14) }),
      ],
    });

    const { forPicking } = poolPeerQuota(local, [studio], NOW);

    const weekly = (accountId: string) =>
      forPicking.windows.find((entry) => entry.accountId === accountId && entry.windowType === "weekly")?.percentUsed;
    // A: the studio's reading, filed under this machine's own id for the login.
    expect(weekly("claude:claude")).toBe(60);
    expect(forPicking.accounts?.find((entry) => entry.id === "claude:claude")?.readingFrom?.machineKey).toBe("studio");
    // B: this machine's reading is newer, so it stands.
    expect(weekly("claude:beats")).toBe(30);
    expect(forPicking.accounts?.find((entry) => entry.id === "claude:beats")?.readingFrom).toBeUndefined();
    // No peer id leaks into this machine's view.
    expect(forPicking.windows.some((entry) => entry.accountId === "claude:1028" || entry.accountId === "claude:other")).toBe(false);
  });

  it("replaces only the windows a peer reported, in place", () => {
    // An idle 5-hour window has no reset time, so it never crosses machines; a
    // fresher weekly reading must not erase it or reorder the provider's windows.
    const local = {
      windows: [
        window({ windowType: "five_hour", accountId: "claude:claude", percentUsed: 0, resetsAt: later(5) }),
        window({ windowType: "weekly", accountId: "claude:claude", percentUsed: 10, resetsAt: later(40) }),
        window({ windowType: "weekly", accountId: "claude:second", percentUsed: 20, resetsAt: later(40) }),
      ],
      accounts: [
        account({ id: "claude:claude", email: "a@example.com", login: "expired", machines: [{ label: "laptop", checkedAt: at(300) }] }),
        account({ id: "claude:second", email: "c@example.com", login: "ok", machines: [{ label: "laptop", checkedAt: at(1) }] }),
      ],
    };
    const studio = peer({
      machineKey: "studio",
      accounts: [account({ id: "claude:x", email: "a@example.com", login: "ok", machines: [{ label: "studio", checkedAt: at(1) }] })],
      windows: [window({ windowType: "weekly", accountId: "claude:x", percentUsed: 70, resetsAt: later(40) })],
    });

    const { forPicking } = poolPeerQuota(local, [studio], NOW);

    expect(forPicking.windows.map((entry) => [entry.accountId, entry.windowType, entry.percentUsed])).toEqual([
      ["claude:claude", "five_hour", 0],
      ["claude:claude", "weekly", 70],
      ["claude:second", "weekly", 20],
    ]);
  });

  it("shows a login only another machine holds, but never offers it for picking", () => {
    const local = {
      windows: [window({ windowType: "weekly", accountId: "claude:claude", percentUsed: 10, resetsAt: later(40) })],
      accounts: [account({ id: "claude:claude", email: "a@example.com", login: "ok", machines: [{ label: "laptop", checkedAt: at(1) }] })],
    };
    const studio = peer({
      machineKey: "studio",
      accounts: [account({ id: "claude:claude", email: "z@example.com", login: "ok", machines: [{ label: "studio", checkedAt: at(1) }] })],
      windows: [window({ windowType: "weekly", accountId: "claude:claude", percentUsed: 50, resetsAt: later(40) })],
    });

    const { forPicking, forDisplay } = poolPeerQuota(local, [studio], NOW);

    // Same id on both machines, different logins: this machine's account keeps
    // its own reading, and the studio's login does not land on it.
    expect(forPicking.accounts?.map((entry) => entry.email)).toEqual(["a@example.com"]);
    expect(forPicking.windows.map((entry) => entry.percentUsed)).toEqual([10]);
    const elsewhere = forDisplay.accounts?.find((entry) => entry.email === "z@example.com");
    expect(elsewhere?.notSignedInHere).toBe(true);
    expect(elsewhere?.id).not.toBe("claude:claude");
    expect(forDisplay.windows.find((entry) => entry.accountId === elsewhere?.id)?.percentUsed).toBe(50);
  });
});
