import { describe, expect, it } from "vitest";
import type { LaneSummary, RebaseNeed } from "../../../../shared/types";
import { branchNameFromRef, resolveLaneBaseBranch } from "../shared/laneBranchTargets";

function isPrTargetNeed(need: RebaseNeed, lane: LaneSummary): boolean {
  const laneBaseBranch = branchNameFromRef(resolveLaneBaseBranch({
    lane,
    lanes: [lane],
    primaryBranchRef: null,
  }));
  return Boolean(need.prId) && laneBaseBranch !== branchNameFromRef(need.baseBranch);
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

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "Feature Lane",
    description: null,
    laneType: "worktree",
    baseRef: "release-9",
    branchRef: "feature/lane",
    worktreePath: "/tmp/lane",
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

describe("RebaseTab grouping helpers", () => {
  it("treats a linked PR on a different branch as a PR-target need", () => {
    expect(isPrTargetNeed(makeNeed({ prId: "pr-1", baseBranch: "main" }), makeLane({ baseRef: "release-9" }))).toBe(true);
  });

  it("treats a matching linked PR as a lane-base need", () => {
    expect(isPrTargetNeed(makeNeed({ prId: "pr-1", baseBranch: "release-9" }), makeLane({ baseRef: "release-9" }))).toBe(false);
  });

  it("treats non-PR suggestions as lane-base needs", () => {
    expect(isPrTargetNeed(makeNeed({ prId: null, baseBranch: "main" }), makeLane({ baseRef: "release-9" }))).toBe(false);
  });
});
