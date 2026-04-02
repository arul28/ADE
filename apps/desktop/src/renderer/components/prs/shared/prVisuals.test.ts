import { afterEach, describe, expect, it, vi } from "vitest";
import { derivePrActivityState, formatCompactCount, getPrEdgeColor } from "./prVisuals";

describe("prVisuals", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps merged PRs out of the stale state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T12:00:00Z"));

    expect(
      derivePrActivityState({
        state: "merged",
        reviewStatus: "approved",
        lastActivityAt: "2026-02-20T12:00:00Z",
        pendingCheckCount: 0
      })
    ).toBe("idle");
  });

  it("marks old open PRs as stale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T12:00:00Z"));

    expect(
      derivePrActivityState({
        state: "open",
        reviewStatus: "approved",
        lastActivityAt: "2026-02-20T12:00:00Z",
        pendingCheckCount: 0
      })
    ).toBe("stale");
  });

  it("prioritizes requested reviews over older activity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T12:00:00Z"));

    expect(
      derivePrActivityState({
        state: "open",
        reviewStatus: "requested",
        lastActivityAt: "2026-02-20T12:00:00Z",
        pendingCheckCount: 0
      })
    ).toBe("active");
  });

  it("uses merged, review, draft, and ci-running colors in the expected priority order", () => {
    expect(getPrEdgeColor({ state: "merged", checksStatus: "passing", reviewStatus: "approved" })).toBe("#22C55E");
    expect(getPrEdgeColor({ state: "open", checksStatus: "passing", reviewStatus: "requested" })).toBe("#F59E0B");
    expect(getPrEdgeColor({ state: "open", checksStatus: "pending", reviewStatus: "approved" })).toBe("#3B82F6");
    expect(getPrEdgeColor({ state: "draft", checksStatus: "none", reviewStatus: "none" })).toBe("#A78BFA");
    expect(getPrEdgeColor({ state: "open", checksStatus: "passing", reviewStatus: "changes_requested" })).toBe("#EF4444");
  });

  it("returns info color for getPrEdgeColor when ciRunning flag is explicitly set", () => {
    // ciRunning should take priority over other statuses (except merged, draft, changes_requested)
    expect(getPrEdgeColor({ state: "open", checksStatus: "passing", reviewStatus: "approved", ciRunning: true })).toBe("#3B82F6");
    expect(getPrEdgeColor({ state: "open", checksStatus: "failing", reviewStatus: "approved", ciRunning: true })).toBe("#3B82F6");
    // But merged still wins
    expect(getPrEdgeColor({ state: "merged", checksStatus: "pending", reviewStatus: "approved", ciRunning: true })).toBe("#22C55E");
    // And changes_requested still wins
    expect(getPrEdgeColor({ state: "open", checksStatus: "passing", reviewStatus: "changes_requested", ciRunning: true })).toBe("#EF4444");
  });

  describe("formatCompactCount", () => {
    it("returns the number as a string for values under 1000", () => {
      expect(formatCompactCount(0)).toBe("0");
      expect(formatCompactCount(42)).toBe("42");
      expect(formatCompactCount(999)).toBe("999");
    });

    it("returns a compact 'k' suffix for values at or above 1000", () => {
      expect(formatCompactCount(1000)).toBe("1k");
      expect(formatCompactCount(1500)).toBe("1.5k");
      expect(formatCompactCount(2345)).toBe("2.3k");
      expect(formatCompactCount(10000)).toBe("10k");
    });
  });
});
