import { afterEach, describe, expect, it, vi } from "vitest";
import { derivePrActivityState, getPrEdgeColor } from "./prVisuals";

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
});
