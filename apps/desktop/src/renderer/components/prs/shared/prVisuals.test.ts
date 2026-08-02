import { afterEach, describe, expect, it, vi } from "vitest";
import { COLORS } from "../../lanes/laneDesignTokens";
import {
  derivePrActivityState,
  formatCompactCount,
  getPrChecksBadge,
  getPrCiDotColor,
  getPrEdgeColor,
} from "./prVisuals";

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
    expect(getPrEdgeColor({ state: "merged", checksStatus: "passing", reviewStatus: "approved" })).toBe(COLORS.success);
    expect(getPrEdgeColor({ state: "open", checksStatus: "passing", reviewStatus: "requested" })).toBe(COLORS.warning);
    expect(getPrEdgeColor({ state: "open", checksStatus: "pending", reviewStatus: "approved" })).toBe(COLORS.info);
    expect(getPrEdgeColor({ state: "draft", checksStatus: "none", reviewStatus: "none" })).toBe(COLORS.accent);
    expect(getPrEdgeColor({ state: "open", checksStatus: "passing", reviewStatus: "changes_requested" })).toBe(COLORS.danger);
  });

  it("returns info color for getPrEdgeColor when ciRunning flag is explicitly set", () => {
    expect(getPrEdgeColor({ state: "open", checksStatus: "passing", reviewStatus: "approved", ciRunning: true })).toBe(COLORS.info);
    expect(getPrEdgeColor({ state: "open", checksStatus: "failing", reviewStatus: "approved", ciRunning: true })).toBe(COLORS.info);
    expect(getPrEdgeColor({ state: "merged", checksStatus: "pending", reviewStatus: "approved", ciRunning: true })).toBe(COLORS.success);
    expect(getPrEdgeColor({ state: "open", checksStatus: "passing", reviewStatus: "changes_requested", ciRunning: true })).toBe(COLORS.danger);
  });

  // ADE-135: an approved PR whose commit nothing verified used to inherit the
  // success edge from the approval alone, which is exactly the "CI passed"
  // illusion this ticket exists to kill.
  it("never paints a not_run PR green", () => {
    expect(getPrEdgeColor({ state: "open", checksStatus: "not_run", reviewStatus: "approved" })).toBe(COLORS.textMuted);
    expect(getPrCiDotColor({ checksStatus: "not_run" })).toBe(COLORS.textMuted);
    expect(getPrChecksBadge("not_run").color).toBe(COLORS.textMuted);
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
