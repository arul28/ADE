import { describe, expect, it } from "vitest";
import type { AiProviderConnectionStatus, AiProviderConnections, UsageAccount, UsageWindow } from "../../../shared/types";
import { providerColor } from "./providerColors";
import {
  emailInitials,
  buildAccountRows,
  buildLimitCards,
  headerUsageProviders,
  percentLeft,
  poolAccounts,
  quotaPopoverProviders,
} from "./usageLimitModel";
import { paceOutlook, paceVisual, shortWindowLabel } from "./usageWindowFormat";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");

function window(overrides: Partial<UsageWindow> & Pick<UsageWindow, "windowType">): UsageWindow {
  return {
    provider: "codex",
    percentUsed: 0,
    resetsAt: new Date(NOW + 3_600_000).toISOString(),
    resetsInMs: 3_600_000,
    ...overrides,
  } as UsageWindow;
}

describe("emailInitials", () => {
  it("takes one letter from each name part, or two from a single one", () => {
    expect(emailInitials("first.last@example.com")).toBe("FL");
    expect(emailInitials("jane_goodall@example.com")).toBe("JG");
    expect(emailInitials("dev@example.com")).toBe("DE");
  });

  it("falls back to the machine label, then to a neutral glyph", () => {
    expect(emailInitials(undefined, "nucbox-1")).toBe("NU");
    expect(emailInitials(undefined)).toBe("··");
  });
});

describe("poolAccounts", () => {
  const base: UsageAccount = {
    id: "codex:dev@example.com",
    provider: "codex",
    email: "dev@example.com",
    plan: "ChatGPT Pro",
    machines: [{ label: "studio", checkedAt: "2026-09-10T11:00:00.000Z" }],
  };

  it("merges the same login from two machines into one account, freshest first", () => {
    const pooled = poolAccounts([
      base,
      {
        ...base,
        id: "codex:DEV@example.com",
        email: "DEV@example.com",
        machines: [{ label: "nucbox-1", checkedAt: "2026-09-10T11:30:00.000Z" }],
      },
    ]);
    expect(pooled).toHaveLength(1);
    expect(pooled[0]!.machines.map((machine) => machine.label)).toEqual(["nucbox-1", "studio"]);
    expect(pooled[0]!.initials).toBe("DE");
  });

  it("keeps account-less entries distinct, since there is nothing to pool on", () => {
    const pooled = poolAccounts([
      { id: "claude:local", provider: "claude", machines: [{ label: "studio" }] },
      { id: "codex:local", provider: "codex", machines: [{ label: "studio" }] },
    ]);
    expect(pooled.map((account) => account.id)).toEqual(["claude:local", "codex:local"]);
  });

  it("keeps two local logins apart even when they share an email", () => {
    const pooled = poolAccounts([
      {
        id: "claude:claude",
        provider: "claude",
        email: "same@example.com",
        instanceId: "claude",
        machines: [],
      },
      {
        id: "claude:1028",
        provider: "claude",
        email: "same@example.com",
        instanceId: "1028",
        machines: [],
      },
    ]);
    expect(pooled.map((account) => account.id)).toEqual(["claude:claude", "claude:1028"]);
  });
});

describe("buildLimitCards", () => {
  const accounts = poolAccounts([
    {
      id: "codex:a@example.com",
      provider: "codex",
      email: "a@example.com",
      machines: [{ label: "studio" }],
    },
    {
      id: "codex:b@example.com",
      provider: "codex",
      email: "b@example.com",
      machines: [{ label: "nucbox-1" }],
    },
  ]);

  it("pools headroom across accounts and forecasts the next reset that gives something back", () => {
    const cards = buildLimitCards(
      "codex",
      [
        window({
          windowType: "weekly",
          accountId: "codex:a@example.com",
          percentUsed: 100,
          resetsAt: new Date(NOW + 6 * 86_400_000).toISOString(),
        }),
        window({
          windowType: "weekly",
          accountId: "codex:b@example.com",
          percentUsed: 3,
          resetsAt: new Date(NOW + 6 * 86_400_000 + 7 * 3_600_000).toISOString(),
        }),
      ],
      accounts,
      NOW,
    );

    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(Math.round(card.percentLeft)).toBe(49);
    // The exhausted account comes back first and returns its whole half of the pool.
    expect(Math.round(card.forecast!.percent)).toBe(50);
    expect(card.forecast!.resetsInMs).toBe(6 * 86_400_000);
    expect(card.segments.map((segment) => Math.round(segment.percentLeft))).toEqual([0, 97]);
    expect(Math.round(card.segments[1]!.restoresPercentOfPool)).toBe(2);
  });

  it("skips a reset that restores nothing", () => {
    const cards = buildLimitCards(
      "claude",
      [
        window({
          provider: "claude",
          windowType: "five_hour",
          accountId: "claude:x",
          percentUsed: 0,
          resetsAt: new Date(NOW + 300_000).toISOString(),
        }),
        window({
          provider: "claude",
          windowType: "five_hour",
          accountId: "claude:y",
          percentUsed: 10,
          resetsAt: new Date(NOW + 4 * 3_600_000).toISOString(),
        }),
      ],
      [],
      NOW,
    );
    expect(cards[0]!.forecast!.resetsInMs).toBe(4 * 3_600_000);
    expect(Math.round(cards[0]!.forecast!.percent)).toBe(5);
  });

  it("separates model-specific windows into their own card and attributes a lone account", () => {
    const single = poolAccounts([
      { id: "claude:solo", provider: "claude", email: "solo@example.com", machines: [{ label: "studio" }] },
    ]);
    const cards = buildLimitCards(
      "claude",
      [
        window({ provider: "claude", windowType: "weekly", percentUsed: 40 }),
        window({ provider: "claude", windowType: "weekly_cowork", percentUsed: 80 }),
      ],
      single,
      NOW,
    );
    expect(cards.map((card) => card.label)).toEqual(["Weekly", "Cowork"]);
    expect(cards[0]!.segments[0]!.account?.email).toBe("solo@example.com");
    expect(Math.round(cards[1]!.percentLeft)).toBe(20);
  });

  it("reads an expired window as fully restored rather than stale", () => {
    const expired = window({ windowType: "weekly", percentUsed: 90, resetsAt: new Date(NOW - 1000).toISOString() });
    expect(percentLeft(expired, NOW)).toBe(100);
  });
});

/**
 * The window vocabulary, where the popover's copy actually comes from.
 *
 * These two strings were the owner's read of the popover: `weekly_oauth_apps`
 * rendered as "apps", a three-letter riddle for the OAuth-apps allowance, and
 * the pace pill said "12% ahead" with nothing to say ahead of what.
 */
describe("buildAccountRows", () => {
  it("lists every account, including one that has not reported a window", () => {
    const accounts = poolAccounts([
      {
        id: "claude:claude",
        provider: "claude",
        email: "a@example.com",
        instanceId: "claude",
        label: "Default",
        machines: [],
      },
      {
        id: "claude:1028",
        provider: "claude",
        email: "b@example.com",
        instanceId: "1028",
        label: "1028",
        machines: [],
      },
      {
        id: "claude:third",
        provider: "claude",
        email: "c@example.com",
        instanceId: "third",
        label: "Third",
        machines: [],
      },
    ]);
    const rows = buildAccountRows(
      "claude",
      [
        window({
          provider: "claude",
          windowType: "five_hour",
          accountId: "claude:claude",
          percentUsed: 20,
        }),
      ],
      accounts,
      NOW,
    );
    expect(rows.map((row) => row.key)).toEqual(["claude:claude", "claude:1028", "claude:third"]);
    expect(rows[0]!.cells).toHaveLength(1);
    expect(rows[1]!.cells).toEqual([]);
    expect(rows[2]!.cells).toEqual([]);
  });
});

describe("usage window vocabulary", () => {
  it("names the OAuth-apps allowance in full", () => {
    expect(shortWindowLabel({ windowType: "weekly_oauth_apps" })).toBe("OAuth apps");
    expect(shortWindowLabel({ windowType: "weekly" })).toBe("wk");
    expect(shortWindowLabel({ windowType: "five_hour", windowDurationMs: 5 * 3_600_000 })).toBe("5h");
  });

  it("says what the pace is measured against", () => {
    expect(paceVisual({
      weekElapsedPercent: 50,
      status: "ahead",
      deltaPercent: 12,
      projectedWeeklyPercent: 90,
      expectedPercent: 50,
      etaHours: 40,
      willLastToReset: true,
      resetsInHours: 100,
    })?.label).toBe("12% ahead of pace");

    expect(paceVisual({
      weekElapsedPercent: 50,
      status: "behind",
      deltaPercent: -8,
      projectedWeeklyPercent: 40,
      expectedPercent: 50,
      etaHours: 90,
      willLastToReset: true,
      resetsInHours: 100,
    })?.label).toBe("8% behind pace");

    expect(paceVisual({
      weekElapsedPercent: 50,
      status: "on-track",
      deltaPercent: 0,
      projectedWeeklyPercent: 50,
      expectedPercent: 50,
      etaHours: 80,
      willLastToReset: true,
      resetsInHours: 100,
    })?.label).toBe("on pace");
  });

  /**
   * The projection and its outcome are two rows, not one sentence: joined, they
   * truncated mid-word in the 300px details panel.
   */
  it("splits the projection from its outcome", () => {
    const now = Date.UTC(2026, 4, 8, 7, 0, 0);
    expect(paceOutlook({
      weekElapsedPercent: 50,
      status: "far-ahead",
      deltaPercent: 40,
      projectedWeeklyPercent: 126,
      expectedPercent: 50,
      etaHours: 5,
      willLastToReset: false,
      resetsInHours: 100,
    }, now)).toEqual({ projected: "126% by reset", outcome: expect.stringContaining("runs dry") });

    expect(paceOutlook({
      weekElapsedPercent: 50,
      status: "on-track",
      deltaPercent: 0,
      projectedWeeklyPercent: 51,
      expectedPercent: 50,
      etaHours: 200,
      willLastToReset: true,
      resetsInHours: 100,
    }, now)).toEqual({ projected: "51% by reset", outcome: "lasts to reset" });
  });
});

function connection(
  provider: AiProviderConnectionStatus["provider"],
  flags: { auth?: boolean; runtime?: boolean } = {},
): AiProviderConnectionStatus {
  return {
    provider,
    authAvailable: flags.auth ?? false,
    runtimeDetected: flags.runtime ?? false,
    runtimeAvailable: false,
    usageAvailable: false,
    path: null,
    blocker: null,
    lastCheckedAt: "2026-09-21T00:00:00.000Z",
    sources: [],
  };
}

function connections(overrides: Partial<AiProviderConnections> = {}): AiProviderConnections {
  return {
    claude: connection("claude", { auth: true, runtime: true }),
    codex: connection("codex", { auth: true, runtime: true }),
    cursor: connection("cursor"),
    droid: connection("droid"),
    ...overrides,
  };
}

describe("live quota visibility", () => {
  const cursorWindow = window({
    provider: "cursor",
    windowType: "monthly",
    percentUsed: 40,
  });

  it("keeps Claude and Codex on the connection signal and adds an authed extra provider", () => {
    const popover = quotaPopoverProviders({
      connections: connections({
        claude: connection("claude"),
        copilot: connection("copilot", { auth: true }),
      }),
    });
    expect(popover).toEqual(["codex", "copilot"]);

    const chips = headerUsageProviders({
      connections: connections({
        claude: connection("claude"),
        grok: connection("grok", { auth: true }),
      }),
      windows: [cursorWindow],
    });
    expect(chips).toEqual(["codex", "cursor", "grok"]);
  });

  it("does not treat a Cursor API-key connection or an installed CLI as a plan sign-in", () => {
    const input = {
      connections: connections({
        cursor: connection("cursor", { auth: true, runtime: true }),
      }),
    };
    expect(quotaPopoverProviders(input)).toEqual(["claude", "codex"]);
    expect(headerUsageProviders(input)).toEqual(["claude", "codex"]);
  });

  it("shows Cursor, Copilot, Grok, and OpenCode once each has a reading, in brand colours", () => {
    expect(headerUsageProviders({
      connections: connections(),
      windows: [
        cursorWindow,
        window({ provider: "copilot", windowType: "monthly" }),
        window({ provider: "grok", windowType: "weekly" }),
        window({ provider: "opencode", windowType: "five_hour" }),
      ],
    })).toEqual(["claude", "codex", "cursor", "copilot", "grok", "opencode"]);
    const colors = ["cursor", "copilot", "grok", "opencode"].map((provider) => providerColor(provider));
    expect(new Set(colors).size).toBe(4);
  });

  it("drops an extra provider that signs out", () => {
    expect(headerUsageProviders({
      connections: connections(),
      windows: [],
      statuses: {},
    })).toEqual(["claude", "codex"]);
  });
});
