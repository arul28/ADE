import { describe, expect, it, vi } from "vitest";
import { COLORS } from "../../lanes/laneDesignTokens";
import { derivePrActivityState, getPrEdgeColor } from "./prVisuals";

describe("prVisuals", () => {
  it("prioritizes merged state over other PR signals for graph edge color", () => {
    expect(
      getPrEdgeColor({
        state: "merged",
        checksStatus: "pending",
        reviewStatus: "changes_requested"
      })
    ).toBe(COLORS.success);
  });

  it("marks stale PRs when review activity is old and no active signals remain", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T12:00:00.000Z"));

    expect(
      derivePrActivityState({
        state: "open",
        lastActivityAt: "2026-02-25T12:00:00.000Z",
        reviewStatus: "none",
        pendingCheckCount: 0
      })
    ).toBe("stale");

    vi.useRealTimers();
  });
});
