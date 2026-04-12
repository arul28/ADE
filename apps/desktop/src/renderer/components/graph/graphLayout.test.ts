import { describe, expect, it } from "vitest";
import type { LaneSummary } from "../../../shared/types";
import { computeAutoLayout, laneHierarchyFromPrimary, normalizeGraphPreferences } from "./graphLayout";

function lane(partial: Partial<LaneSummary> & Pick<LaneSummary, "id" | "name" | "laneType" | "parentLaneId">): LaneSummary {
  return {
    description: null,
    attachedRootPath: null,
    baseRef: "refs/heads/main",
    branchRef: `refs/heads/${partial.name}`,
    worktreePath: "",
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    ...partial
  };
}

describe("normalizeGraphPreferences", () => {
  it("keeps the new preferences shape unchanged", () => {
    expect(normalizeGraphPreferences({ lastViewMode: "activity" })).toEqual({
      preferences: { lastViewMode: "activity" },
      migrated: false
    });
  });

  it("migrates legacy preset state to the last view mode", () => {
    const legacyState = {
      activePreset: "Risk preset",
      presets: [
        {
          name: "Risk preset",
          byViewMode: {
            risk: { viewMode: "risk" }
          }
        }
      ]
    };

    expect(normalizeGraphPreferences(legacyState)).toEqual({
      preferences: { lastViewMode: "risk" },
      migrated: true
    });
  });

  it("falls back to Overview for malformed stored data", () => {
    expect(normalizeGraphPreferences({ lastViewMode: "sideways", presets: "nope" })).toEqual({
      preferences: { lastViewMode: "all" },
      migrated: true
    });

    expect(normalizeGraphPreferences(null)).toEqual({
      preferences: { lastViewMode: "all" },
      migrated: false
    });
  });
});

describe("laneHierarchyFromPrimary", () => {
  it("assigns depth 0 to primary and increments along parent chain", () => {
    const lanes = [
      lane({ id: "p", name: "main", laneType: "primary", parentLaneId: null }),
      lane({ id: "a", name: "feat-a", laneType: "worktree", parentLaneId: "p" }),
      lane({ id: "b", name: "feat-b", laneType: "worktree", parentLaneId: "a" })
    ];
    const { depthByLaneId, parentNameByLaneId } = laneHierarchyFromPrimary(lanes);
    expect(depthByLaneId.get("p")).toBe(0);
    expect(depthByLaneId.get("a")).toBe(1);
    expect(depthByLaneId.get("b")).toBe(2);
    expect(parentNameByLaneId.get("a")).toBe("main");
    expect(parentNameByLaneId.get("b")).toBe("feat-a");
  });

  it("marks lanes not under primary with a large sentinel depth", () => {
    const lanes = [
      lane({ id: "p", name: "main", laneType: "primary", parentLaneId: null }),
      lane({ id: "o", name: "orphan", laneType: "worktree", parentLaneId: null })
    ];
    const { depthByLaneId } = laneHierarchyFromPrimary(lanes);
    expect(depthByLaneId.get("o")).toBe(10_000);
  });
});

describe("computeAutoLayout overview", () => {
  it("places primary above children in row order", () => {
    const lanes = [
      lane({ id: "p", name: "main", laneType: "primary", parentLaneId: null, stackDepth: 0 }),
      lane({ id: "x", name: "z-last", laneType: "worktree", parentLaneId: "p", stackDepth: 1 }),
      lane({ id: "y", name: "a-first", laneType: "worktree", parentLaneId: "p", stackDepth: 1 })
    ];
    const pos = computeAutoLayout(lanes, "all", {}, {});
    expect(pos.p!.y).toBeLessThan(pos.x!.y);
    expect(pos.p!.y).toBeLessThan(pos.y!.y);
    expect(pos.x!.y).toBe(pos.y!.y);
    expect(pos.y!.x).toBeLessThan(pos.x!.x);
  });
});

describe("computeAutoLayout aligned modes", () => {
  it("matches stack and risk positions to overview for the same lanes", () => {
    const lanes = [
      lane({ id: "p", name: "main", laneType: "primary", parentLaneId: null, stackDepth: 0 }),
      lane({ id: "c", name: "child", laneType: "worktree", parentLaneId: "p", stackDepth: 1 })
    ];
    const allPos = computeAutoLayout(lanes, "all", {}, {});
    const stackPos = computeAutoLayout(lanes, "stack", {}, {});
    const riskPos = computeAutoLayout(lanes, "risk", {}, {});
    expect(stackPos).toEqual(allPos);
    expect(riskPos).toEqual(allPos);
  });

  it("activity mode sorts siblings by activity score within the same depth", () => {
    const lanes = [
      lane({ id: "p", name: "main", laneType: "primary", parentLaneId: null, stackDepth: 0 }),
      lane({ id: "low", name: "low", laneType: "worktree", parentLaneId: "p", stackDepth: 1 }),
      lane({ id: "high", name: "high", laneType: "worktree", parentLaneId: "p", stackDepth: 1 })
    ];
    const scores = { low: 1, high: 99 };
    const pos = computeAutoLayout(lanes, "activity", scores, {});
    expect(pos.low!.y).toBe(pos.high!.y);
    expect(pos.high!.x).toBeLessThan(pos.low!.x);
  });
});
