import { describe, expect, it } from "vitest";
import type { UsageAccount, UsageWindow } from "../../../shared/types";
import {
  emailInitials,
  buildLimitCards,
  percentLeft,
  poolAccounts,
} from "./usageLimitModel";

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
