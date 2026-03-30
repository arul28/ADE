import { describe, expect, it } from "vitest";
import type { LaneSummary } from "../../../shared/types";
import { resolveDefaultBaseBranch } from "./LanePrPanel";

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "lane",
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/lane",
    worktreePath: "/tmp/lane-1",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    folder: null,
    createdAt: "2026-03-30T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

describe("resolveDefaultBaseBranch", () => {
  it("uses lane.baseRef for unparented lanes", () => {
    expect(
      resolveDefaultBaseBranch({
        lane: makeLane({ baseRef: "release-9", parentLaneId: null }),
        parentLane: null,
        primaryBranchRef: "fix-rebase-and-new-lane-flow",
      }),
    ).toBe("release-9");
  });

  it("falls back to lane.baseRef when parentLaneId is set but parentLane is missing", () => {
    expect(
      resolveDefaultBaseBranch({
        lane: makeLane({ parentLaneId: "some-id", baseRef: "release-9" }),
        parentLane: null,
        primaryBranchRef: "main",
      }),
    ).toBe("release-9");
  });

  it("uses the parent branch for child lanes", () => {
    expect(
      resolveDefaultBaseBranch({
        lane: makeLane({ parentLaneId: "lane-parent" }),
        parentLane: makeLane({ id: "lane-parent", branchRef: "feature/stack-root" }),
        primaryBranchRef: "main",
      }),
    ).toBe("feature/stack-root");
  });
});
