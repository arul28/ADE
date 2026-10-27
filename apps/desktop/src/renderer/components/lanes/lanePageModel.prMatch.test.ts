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
  it("shows both the drifted checkout's PR and the recorded branch's owned PR", () => {
    const lane = makeLane({
      id: "lane-1",
      branchRef: "feature/6fcd8d4a",
      branchDrift: {
        expectedBranchRef: "feature/6fcd8d4a",
        headBranchRef: "feature/web-render-local-dev",
      },
    });
    const live = makePr({ id: "pr-live", laneId: "lane-1", headBranch: "feature/web-render-local-dev" });
    const recorded = makePr({ id: "pr-recorded", laneId: "lane-1", headBranch: "feature/6fcd8d4a" });

    // Drift means the checkout moved; the lane still records its branch, so the
    // recorded branch's own PR stays the lane's work instead of disappearing.
    expect(selectLanePrs(lane, [live, recorded]).map((pr) => pr.id)).toEqual(["pr-live", "pr-recorded"]);
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

  it("hides every PR for a primary lane back on its base branch, chat link included", () => {
    const primary = makeLane({
      id: "lane-1",
      laneType: "primary",
      branchRef: "main",
      baseRef: "main",
    });
    const linkedMerged = makePr({
      id: "pr-linked",
      laneId: "lane-1",
      headBranch: "fix/update-recovery",
      chatSessionIds: ["chat-1"],
    });
    const branchMatched = makePr({ id: "pr-branch", laneId: "lane-1", headBranch: "main", state: "open" });

    // The lane cannot be deleted, so a chat-linked merged PR would otherwise
    // stay pinned to `main` forever.
    expect(selectLanePrs(primary, [linkedMerged, branchMatched])).toEqual([]);

    // The same lane on the PR's own branch still shows it — the gate is the
    // checkout, not the chat link.
    const working = makeLane({ ...primary, branchRef: "fix/update-recovery" });
    expect(selectLanePrs(working, [linkedMerged]).map((pr) => pr.id)).toEqual(["pr-linked"]);
  });
});
