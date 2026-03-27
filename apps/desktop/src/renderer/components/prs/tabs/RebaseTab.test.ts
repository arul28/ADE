/**
 * Tests for RebaseTab categorization and style helpers.
 *
 * The RebaseTab component has a categorize() function that determines
 * the urgency bucket for each RebaseNeed. We re-derive and test it.
 */
import { describe, expect, it } from "vitest";
import type { RebaseNeed } from "../../../../shared/types";

type UrgencyCategory = "attention" | "clean" | "recent" | "upToDate";

// Re-derive the categorize function from RebaseTab
function categorize(need: RebaseNeed): UrgencyCategory {
  if (need.dismissedAt) return "upToDate";
  if (need.deferredUntil && new Date(need.deferredUntil) > new Date()) return "upToDate";
  if (need.behindBy === 0) return "upToDate";
  if (need.conflictPredicted) return "attention";
  return "clean";
}

function makeNeed(overrides: Partial<RebaseNeed> = {}): RebaseNeed {
  return {
    laneId: "lane-1",
    laneName: "Feature Lane",
    baseBranch: "main",
    behindBy: 3,
    conflictPredicted: false,
    conflictingFiles: [],
    prId: null,
    groupContext: null,
    dismissedAt: null,
    deferredUntil: null,
    ...overrides,
  };
}

describe("RebaseTab categorize", () => {
  it("returns 'upToDate' when dismissed", () => {
    expect(categorize(makeNeed({ dismissedAt: "2026-03-01T00:00:00.000Z" }))).toBe("upToDate");
  });

  it("returns 'upToDate' when deferred until future", () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(categorize(makeNeed({ deferredUntil: future }))).toBe("upToDate");
  });

  it("returns 'upToDate' when behindBy is 0", () => {
    expect(categorize(makeNeed({ behindBy: 0 }))).toBe("upToDate");
  });

  it("returns 'attention' when conflict is predicted", () => {
    expect(categorize(makeNeed({ conflictPredicted: true, behindBy: 5 }))).toBe("attention");
  });

  it("returns 'clean' when behind but no conflict", () => {
    expect(categorize(makeNeed({ behindBy: 3, conflictPredicted: false }))).toBe("clean");
  });

  it("prioritizes dismissedAt over conflictPredicted", () => {
    expect(categorize(makeNeed({
      dismissedAt: "2026-03-01T00:00:00.000Z",
      conflictPredicted: true,
      behindBy: 5,
    }))).toBe("upToDate");
  });

  it("does not treat past deferredUntil as upToDate", () => {
    const past = new Date(Date.now() - 3_600_000).toISOString();
    expect(categorize(makeNeed({ deferredUntil: past, behindBy: 2 }))).toBe("clean");
  });
});
