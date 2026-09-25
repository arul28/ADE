import { describe, expect, it } from "vitest";
import { selectLanePrs } from "./lanePageModel";
import type { LaneSummary, PrSummary } from "../../../shared/types";

type LanePrTarget = Pick<LaneSummary, "id" | "laneType" | "branchRef" | "baseRef" | "branchDrift">;

function makeLane(overrides: Partial<LanePrTarget> = {}): LanePrTarget {
  return {
    id: "lane-1",
    laneType: "worktree",
    branchRef: "ade/pr-state",
    baseRef: "main",
    ...overrides,
  };
}

function makePr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    id: "pr-1",
    laneId: "lane-1",
    projectId: "project-1",
    repoOwner: "arul28",
    repoName: "ADE",
    githubPrNumber: 224,
    githubUrl: "https://github.com/arul28/ADE/pull/224",
    githubNodeId: "PR_node224",
    title: "Show merged PR state",
    state: "open",
    baseBranch: "main",
    headBranch: "origin/ade/pr-state",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 1,
    deletions: 1,
    lastSyncedAt: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("selectLanePrs branch drift", () => {
  it("shows an owned PR on the checked-out branch when the lane record is stale", () => {
    const lane = makeLane({
      id: "lane-1",
      branchRef: "t3code/6fcd8d4a",
      branchDrift: {
        expectedBranchRef: "t3code/6fcd8d4a",
        headBranchRef: "t3code/web-render-local-dev",
      },
    });
    const live = makePr({ id: "pr-live", laneId: "lane-1", headBranch: "t3code/web-render-local-dev" });
    const recorded = makePr({ id: "pr-recorded", laneId: "lane-1", headBranch: "t3code/6fcd8d4a" });

    expect(selectLanePrs(lane, [live, recorded]).map((pr) => pr.id)).toEqual(["pr-live"]);
  });

  it("shows a primary lane's checked-out pull request after it drifts off its base", () => {
    const lane = makeLane({
      id: "lane-1",
      laneType: "primary",
      branchRef: "main",
      baseRef: "main",
      branchDrift: { expectedBranchRef: "main", headBranchRef: "ade/live" },
    });
    const live = makePr({ id: "pr-live", laneId: "lane-1", headBranch: "ade/live" });

    expect(selectLanePrs(lane, [live]).map((pr) => pr.id)).toEqual(["pr-live"]);
  });
});
