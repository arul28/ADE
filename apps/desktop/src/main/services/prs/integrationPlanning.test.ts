import { describe, expect, it } from "vitest";
import type { LaneSummary } from "../../../shared/types";
import { buildIntegrationPreflight, resolveIntegrationBaseLane } from "./integrationPlanning";

function makeLane(id: string, branch: string, overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id,
    name: branch,
    description: null,
    laneType: "worktree",
    baseRef: "refs/heads/main",
    branchRef: `refs/heads/${branch}`,
    worktreePath: `/tmp/${id}`,
    attachedRootPath: null,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    folder: null,
    createdAt: "2026-03-11T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

describe("integrationPlanning", () => {
  it("resolves the base lane from the actual branch lane", () => {
    const primary = makeLane("lane-main", "main", { laneType: "primary", baseRef: "refs/heads/main" });
    const child = makeLane("lane-feature", "feature/auth", { baseRef: "refs/heads/main" });

    expect(resolveIntegrationBaseLane([child, primary], "main")?.id).toBe("lane-main");
  });

  it("does not treat descendant lanes with matching baseRef as the base lane", () => {
    const child = makeLane("lane-feature", "feature/auth", { baseRef: "refs/heads/main" });

    expect(resolveIntegrationBaseLane([child], "main")).toBeNull();
  });

  it("deduplicates source lanes and reports missing lanes", () => {
    const lanes = [makeLane("lane-a", "feature/a"), makeLane("lane-main", "main", { laneType: "primary" })];

    expect(buildIntegrationPreflight(lanes, ["lane-a", "lane-a", "lane-missing"], "main")).toEqual({
      baseLane: lanes[1],
      uniqueSourceLaneIds: ["lane-a", "lane-missing"],
      duplicateSourceLaneIds: ["lane-a"],
      missingSourceLaneIds: ["lane-missing"],
    });
  });
});
