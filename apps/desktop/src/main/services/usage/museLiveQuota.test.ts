import { describe, expect, it } from "vitest";
import type { SubscriptionUsage } from "@muse-code/sdk/dist/src/msp.js";
import { createMuseQuotaStore, museSubscriptionUsageToWindows } from "./museLiveQuota";

const NOW = 1_700_000_000_000;

function reading(overrides: Partial<SubscriptionUsage> = {}): SubscriptionUsage {
  return {
    observedAtMs: NOW - 1_000,
    tier: "pro",
    window: { usedPercent: 40, resetsAtMs: NOW + 60_000, windowDurationMins: 300 },
    weekly: { usedPercent: 12, resetsAtMs: NOW + 86_400_000 },
    ...overrides,
  };
}

describe("createMuseQuotaStore.record", () => {
  it("keeps a reading newer than the held one and rejects an older observation that arrives later", () => {
    const store = createMuseQuotaStore();

    expect(store.record(reading({ observedAtMs: NOW, tier: "newest" }))).toBe(true);
    // Two chats' hosts can report out of order; the stale one must not win.
    expect(store.record(reading({ observedAtMs: NOW - 5_000, tier: "stale" }))).toBe(false);
    expect(store.record(reading({ observedAtMs: NOW, tier: "equal" }))).toBe(true);
  });

  it("ignores a payload that is not a subscription reading", () => {
    const store = createMuseQuotaStore();

    for (const value of [null, undefined, 42, {}, { observedAtMs: NOW }, reading({ weekly: {} as never })]) {
      expect(store.record(value)).toBe(false);
    }
  });
});

describe("createMuseQuotaStore.poll", () => {
  it("reports nothing before any reading arrives", async () => {
    await expect(createMuseQuotaStore().poll(NOW)).resolves.toEqual({
      disposition: "not_signed_in",
      windows: [],
      errors: [],
    });
  });

  it("publishes the held reading as Muse's two windows", async () => {
    const store = createMuseQuotaStore();
    store.record(reading({ tier: "ultra" }));

    const result = await store.poll(NOW);

    expect(result.windows.map((window) => window.windowType)).toEqual(["five_hour", "weekly"]);
    expect(result).toMatchObject({ accountPlan: "ultra", freshWindowCount: 2, errors: [] });
  });

  it("drops a window whose reset has already passed rather than showing it as current", async () => {
    const store = createMuseQuotaStore();
    store.record(reading({ window: { usedPercent: 40, resetsAtMs: NOW - 1, windowDurationMins: 300 } }));

    const result = await store.poll(NOW);

    expect(result.windows.map((window) => window.windowType)).toEqual(["weekly"]);
    expect(result).toMatchObject({ freshWindowCount: 1 });
  });

  it("reports not_signed_in once every window has reset", async () => {
    const store = createMuseQuotaStore();
    store.record(reading({
      window: { usedPercent: 40, resetsAtMs: NOW - 1, windowDurationMins: 300 },
      weekly: { usedPercent: 12, resetsAtMs: NOW - 1 },
    }));

    await expect(store.poll(NOW)).resolves.toEqual({
      disposition: "not_signed_in",
      windows: [],
      errors: [],
    });
  });
});

describe("museSubscriptionUsageToWindows", () => {
  it("carries Muse's own reset stamps and clamps a past reset to zero remaining", () => {
    const windows = museSubscriptionUsageToWindows(
      reading({ window: { usedPercent: 88, resetsAtMs: NOW - 500, windowDurationMins: 300 } }),
      NOW,
    );

    const fiveHour = windows.find((window) => window.windowType === "five_hour");
    expect(fiveHour).toMatchObject({ provider: "muse", percentUsed: 88, resetsInMs: 0, windowDurationMs: 300 * 60_000 });
    expect(windows.find((window) => window.windowType === "weekly")).toMatchObject({ percentUsed: 12 });
  });
});
