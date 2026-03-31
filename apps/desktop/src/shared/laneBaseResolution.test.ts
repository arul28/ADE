import { describe, expect, it } from "vitest";
import { resolveStableLaneBaseBranch, shouldLaneTrackParent } from "./laneBaseResolution";

describe("laneBaseResolution", () => {
  it("treats non-primary parents as tracked child stacks", () => {
    expect(
      shouldLaneTrackParent({
        lane: {
          baseRef: "main",
          parentLaneId: "lane-parent",
        },
        parent: {
          laneType: "worktree",
          branchRef: "feature/stack-parent",
        },
      }),
    ).toBe(true);
  });

  it("does not let legacy primary-parent links override a different stored base", () => {
    expect(
      shouldLaneTrackParent({
        lane: {
          baseRef: "main",
          parentLaneId: "lane-primary",
        },
        parent: {
          laneType: "primary",
          branchRef: "release/2026",
        },
      }),
    ).toBe(false);
  });

  it("falls back to the stored base when a primary parent is no longer tracked", () => {
    expect(
      resolveStableLaneBaseBranch({
        lane: {
          baseRef: "main",
          parentLaneId: "lane-primary",
        },
        parent: {
          laneType: "primary",
          branchRef: "release/2026",
        },
        primaryBranchRef: "release/2026",
      }),
    ).toBe("main");
  });
});
