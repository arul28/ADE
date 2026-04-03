import { describe, expect, it } from "vitest";
import type { LaneSummary } from "../../../shared/types";
import {
  LANES_TILING_LAYOUT_VERSION,
  LANES_TILING_TREE,
  LANES_TILING_WORK_FOCUS_TREE,
  isMissionLaneHiddenByDefault,
  laneMatchesFilter,
} from "./laneUtils";

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "Lane One",
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/lane-one",
    worktreePath: "/tmp/lane-one",
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
    missionId: null,
    laneRole: null,
    createdAt: "2026-03-30T10:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

describe("laneUtils tiling defaults", () => {
  it("makes git actions the largest default pane", () => {
    expect(LANES_TILING_TREE.children[0]?.defaultSize).toBe(15);
    expect(LANES_TILING_TREE.children[1]?.defaultSize).toBe(30);
    expect(LANES_TILING_TREE.children[2]?.defaultSize).toBe(55);
  });

  it("raises the git actions minimum share", () => {
    expect(LANES_TILING_TREE.children[2]?.minSize).toBe(28);
  });

  it("bumps the persisted tiling layout version", () => {
    expect(LANES_TILING_LAYOUT_VERSION).toBe("v6");
  });

  it("work-focus layout emphasizes the work pane", () => {
    expect(LANES_TILING_WORK_FOCUS_TREE.children[1]?.defaultSize).toBeGreaterThan(40);
    expect(LANES_TILING_WORK_FOCUS_TREE.children[2]?.defaultSize).toBeLessThan(
      (LANES_TILING_TREE.children[2]?.defaultSize ?? 0),
    );
  });

  it("hides non-result mission lanes by default but reveals them with mission filters", () => {
    const workerLane = makeLane({ missionId: "mission-1", laneRole: "worker", name: "Mission worker" });
    const resultLane = makeLane({ missionId: "mission-1", laneRole: "result", name: "Mission result" });

    expect(isMissionLaneHiddenByDefault(workerLane)).toBe(true);
    expect(laneMatchesFilter(workerLane, false, "")).toBe(false);
    expect(laneMatchesFilter(workerLane, false, "is:mission")).toBe(true);
    expect(laneMatchesFilter(resultLane, false, "")).toBe(true);
    expect(laneMatchesFilter(resultLane, false, "is:mission-result")).toBe(true);
  });
});
