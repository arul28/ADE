import { describe, expect, it } from "vitest";

import { computeResetsInMs, displayPercent, windowLabel } from "./usageWindowPresentation";

const NOW = Date.parse("2026-09-08T19:28:00.000Z");

describe("windowLabel", () => {
  it("names every known window type the one way both clients print it", () => {
    expect(windowLabel({ windowType: "five_hour" })).toBe("5-hour");
    expect(windowLabel({ windowType: "weekly" })).toBe("Weekly");
    expect(windowLabel({ windowType: "monthly" })).toBe("Monthly");
    expect(windowLabel({ windowType: "weekly_oauth_apps" })).toBe("OAuth apps");
    expect(windowLabel({ windowType: "weekly_cowork" })).toBe("Cowork");
  });

  it("prefers the provider's own duration over the nominal five hours", () => {
    // A provider that publishes a real window length gets named by it, which is
    // the whole reason `five_hour` is not simply hard-coded to "5-hour".
    expect(windowLabel({ windowType: "five_hour", windowDurationMs: 90 * 60_000 })).toBe("1.5-hour");
    expect(windowLabel({ windowType: "five_hour", windowDurationMs: 3 * 3_600_000 })).toBe("3-hour");
    expect(windowLabel({ windowType: "five_hour", windowDurationMs: 45 * 60_000 })).toBe("45-min");
  });

  it("ignores an unusable duration rather than printing NaN", () => {
    expect(windowLabel({ windowType: "five_hour", windowDurationMs: 0 })).toBe("5-hour");
    expect(windowLabel({ windowType: "five_hour", windowDurationMs: -1 })).toBe("5-hour");
    expect(windowLabel({ windowType: "five_hour", windowDurationMs: null })).toBe("5-hour");
    // The duration only speaks for `five_hour`; a weekly window keeps its name.
    expect(windowLabel({ windowType: "weekly", windowDurationMs: 90 * 60_000 })).toBe("Weekly");
  });

  it("passes an unknown window type through instead of dropping the card", () => {
    // A host newer than this client can publish a window type this table has
    // never heard of; printing it verbatim beats an empty or "Unknown" label.
    expect(windowLabel({ windowType: "daily" })).toBe("daily");
    expect(windowLabel({ windowType: "" })).toBe("");
  });
});

describe("computeResetsInMs", () => {
  it("counts the milliseconds left on a future reset", () => {
    expect(computeResetsInMs(new Date(NOW + 90_000).toISOString(), NOW)).toBe(90_000);
    expect(computeResetsInMs(new Date(NOW + 3_600_000).toISOString(), NOW)).toBe(3_600_000);
  });

  it("floors a past reset at zero rather than going negative", () => {
    expect(computeResetsInMs(new Date(NOW - 60_000).toISOString(), NOW)).toBe(0);
    expect(computeResetsInMs(new Date(NOW).toISOString(), NOW)).toBe(0);
  });

  it("reads a missing or unparseable instant as already reset", () => {
    expect(computeResetsInMs("", NOW)).toBe(0);
    expect(computeResetsInMs("not-a-date", NOW)).toBe(0);
  });
});

describe("displayPercent", () => {
  it("reports the fill of a window that is still open", () => {
    const resetsAt = new Date(NOW + 60_000).toISOString();
    expect(displayPercent({ resetsAt, percentUsed: 42 }, NOW)).toBe(42);
    expect(displayPercent({ resetsAt, percentUsed: 0 }, NOW)).toBe(0);
  });

  it("clamps a provider's out-of-range fill into the bar", () => {
    const resetsAt = new Date(NOW + 60_000).toISOString();
    expect(displayPercent({ resetsAt, percentUsed: 140 }, NOW)).toBe(100);
    expect(displayPercent({ resetsAt, percentUsed: -12 }, NOW)).toBe(0);
  });

  it("reads a window past its reset as empty, not as its last-known fill", () => {
    // The snapshot can outlive the window it describes by a refresh interval,
    // and a stale 98% bar is the one reading that makes people stop working.
    expect(displayPercent({ resetsAt: new Date(NOW - 1_000).toISOString(), percentUsed: 98 }, NOW))
      .toBe(0);
    expect(displayPercent({ resetsAt: "", percentUsed: 98 }, NOW)).toBe(0);
  });

  it("never lets a NaN fill reach the bar's width", () => {
    // `Math.max(0, Math.min(100, NaN))` is NaN, so this asserts the guard the
    // parser upstream owes us is actually honoured here too.
    const value = displayPercent(
      { resetsAt: new Date(NOW + 60_000).toISOString(), percentUsed: Number.NaN },
      NOW,
    );
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBe(0);
  });
});
