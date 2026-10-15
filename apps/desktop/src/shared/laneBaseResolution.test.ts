import { describe, expect, it } from "vitest";
import { laneIsOnBaseBranch, resolveStableLaneBaseBranch, shouldLaneTrackParent } from "./laneBaseResolution";

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

  it("falls back to the stored base when the primary parent is missing", () => {
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

  describe("laneIsOnBaseBranch", () => {
    const cases: Array<[string, { laneType: string; branchRef?: string | null; baseRef?: string | null }, boolean]> = [
      ["a primary lane on its base", { laneType: "primary", branchRef: "main", baseRef: "main" }, true],
      ["a primary lane on a work branch", { laneType: "primary", branchRef: "fix/release", baseRef: "main" }, false],
      ["a worktree lane matching its own base", { laneType: "worktree", branchRef: "main", baseRef: "main" }, false],
      ["ref-spelled branches", { laneType: "primary", branchRef: "refs/heads/main", baseRef: "refs/heads/main" }, true],
      ["a remote-spelled base", { laneType: "primary", branchRef: "main", baseRef: "origin/main" }, true],
      ["a missing branch", { laneType: "primary", branchRef: null, baseRef: "main" }, false],
    ];

    it.each(cases)("%s", (_label, lane, expected) => {
      expect(laneIsOnBaseBranch(lane)).toBe(expected);
    });
  });
});
