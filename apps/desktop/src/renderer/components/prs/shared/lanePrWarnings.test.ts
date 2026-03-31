import { describe, expect, it } from "vitest";
import { buildLanePrWarnings, buildLaneRebaseRecommendedLaneIds, describeLanePrIssues } from "./lanePrWarnings";
import type { GitUpstreamSyncStatus, LaneSummary } from "../../../../shared/types";

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: overrides.id ?? "lane-1",
    name: overrides.name ?? "Lane 1",
    laneType: overrides.laneType ?? "worktree",
    baseRef: overrides.baseRef ?? "main",
    branchRef: overrides.branchRef ?? "feature/test",
    worktreePath: overrides.worktreePath ?? "/tmp/lane-1",
    parentLaneId: overrides.parentLaneId ?? null,
    childCount: overrides.childCount ?? 0,
    stackDepth: overrides.stackDepth ?? 0,
    parentStatus: overrides.parentStatus ?? null,
    isEditProtected: overrides.isEditProtected ?? false,
    status: overrides.status ?? {
      dirty: false,
      ahead: 0,
      behind: 0,
      remoteBehind: -1,
      rebaseInProgress: false,
    },
    color: overrides.color ?? null,
    icon: overrides.icon ?? null,
    tags: overrides.tags ?? [],
    folder: overrides.folder ?? null,
    createdAt: overrides.createdAt ?? "2026-03-11T00:00:00.000Z",
    archivedAt: overrides.archivedAt ?? null,
    description: overrides.description ?? null,
    attachedRootPath: overrides.attachedRootPath ?? null,
  };
}

function makeSyncStatus(overrides: Partial<GitUpstreamSyncStatus> = {}): GitUpstreamSyncStatus {
  return {
    hasUpstream: overrides.hasUpstream ?? true,
    upstreamRef: overrides.upstreamRef ?? "origin/feature/test",
    ahead: overrides.ahead ?? 0,
    behind: overrides.behind ?? 0,
    diverged: overrides.diverged ?? false,
    recommendedAction: overrides.recommendedAction ?? "none",
  };
}

describe("lanePrWarnings", () => {
  it("reports dirty and unpushed issues for a selected lane", () => {
    const lane = makeLane({
      status: {
        dirty: true,
        ahead: 0,
        behind: 2,
        remoteBehind: 0,
        rebaseInProgress: false,
      },
    });

    expect(describeLanePrIssues(lane, makeSyncStatus({ ahead: 2 }))).toEqual([
      "has uncommitted changes",
      "is 2 commits behind its base branch — rebase recommended before creating or merging a PR",
      "has 2 unpushed commits",
    ]);
  });

  it("tracks which selected lanes should deep-link into the Rebase tab", () => {
    const cleanLane = makeLane({ id: "lane-clean", status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false } });
    const staleLane = makeLane({ id: "lane-stale", status: { dirty: false, ahead: 0, behind: 3, remoteBehind: 0, rebaseInProgress: false } });
    const activeRebaseLane = makeLane({ id: "lane-rebasing", status: { dirty: false, ahead: 0, behind: 4, remoteBehind: 0, rebaseInProgress: true } });

    expect(
      buildLaneRebaseRecommendedLaneIds({
        lanes: [cleanLane, staleLane, activeRebaseLane],
        selectedLaneIds: ["lane-clean", "lane-stale", "lane-rebasing"],
      }),
    ).toEqual(["lane-stale", "lane-rebasing"]);
  });

  it("reports unpublished and diverged lanes distinctly", () => {
    const unpublished = describeLanePrIssues(makeLane(), makeSyncStatus({ hasUpstream: false, upstreamRef: null }));
    const diverged = describeLanePrIssues(makeLane(), makeSyncStatus({ ahead: 1, behind: 3, diverged: true }));

    expect(unpublished).toEqual(["has not been published to remote"]);
    expect(diverged).toEqual(["has diverged from remote (1 ahead, 3 behind) — force push if this is from a rebase, or pull to merge remote changes."]);
  });

  it("builds warnings only for lanes with issues", () => {
    const cleanLane = makeLane({ id: "lane-clean", name: "Clean Lane" });
    const dirtyLane = makeLane({
      id: "lane-dirty",
      name: "Dirty Lane",
      status: {
        dirty: true,
        ahead: 0,
        behind: 0,
        remoteBehind: 0,
        rebaseInProgress: false,
      },
    });

    expect(buildLanePrWarnings({
      lanes: [cleanLane, dirtyLane],
      selectedLaneIds: ["lane-clean", "lane-dirty"],
      syncStatusByLaneId: {
        "lane-clean": makeSyncStatus(),
        "lane-dirty": makeSyncStatus(),
      },
    })).toEqual([
      {
        laneId: "lane-dirty",
        laneName: "Dirty Lane",
        issues: ["has uncommitted changes"],
      },
    ]);
  });

  it("returns empty array when lane list is empty", () => {
    expect(buildLanePrWarnings({
      lanes: [],
      selectedLaneIds: [],
      syncStatusByLaneId: {},
    })).toEqual([]);
  });

  it("returns empty issues for a lane with no problems", () => {
    const lane = makeLane();
    const issues = describeLanePrIssues(lane, makeSyncStatus());
    expect(issues).toEqual([]);
  });

  it("returns empty issues when syncStatus is null", () => {
    const lane = makeLane();
    const issues = describeLanePrIssues(lane, null);
    expect(issues).toEqual([]);
  });

  it("returns empty issues when syncStatus is undefined", () => {
    const lane = makeLane();
    const issues = describeLanePrIssues(lane, undefined);
    expect(issues).toEqual([]);
  });

  it("reports multiple conflicting issues on the same lane", () => {
    const lane = makeLane({
      status: {
        dirty: true,
        ahead: 0,
        behind: 5,
        remoteBehind: 0,
        rebaseInProgress: true,
      },
    });
    const issues = describeLanePrIssues(lane, makeSyncStatus({ hasUpstream: false, upstreamRef: null }));

    expect(issues).toEqual([
      "has a rebase in progress",
      "has uncommitted changes",
      "is 5 commits behind its base branch — rebase recommended before creating or merging a PR",
      "has not been published to remote",
    ]);
  });

  it("reports rebase in progress alongside diverged remote", () => {
    const lane = makeLane({
      status: {
        dirty: false,
        ahead: 0,
        behind: 0,
        remoteBehind: 0,
        rebaseInProgress: true,
      },
    });
    const issues = describeLanePrIssues(lane, makeSyncStatus({ ahead: 2, behind: 1, diverged: true }));

    expect(issues).toEqual([
      "has a rebase in progress",
      "has diverged from remote (2 ahead, 1 behind) — force push if this is from a rebase, or pull to merge remote changes.",
    ]);
  });

  it("uses singular 'commit' for count of 1", () => {
    const behindLane = makeLane({
      status: { dirty: false, ahead: 0, behind: 1, remoteBehind: 0, rebaseInProgress: false },
    });
    const issues = describeLanePrIssues(behindLane, makeSyncStatus({ ahead: 1 }));

    expect(issues).toContain("is 1 commit behind its base branch — rebase recommended before creating or merging a PR");
    expect(issues).toContain("has 1 unpushed commit");
  });

  it("reports being behind remote separately from being behind base", () => {
    const lane = makeLane();
    const issues = describeLanePrIssues(lane, makeSyncStatus({ behind: 4 }));

    expect(issues).toEqual(["is 4 commits behind remote"]);
  });

  it("buildLanePrWarnings skips selectedLaneIds not found in lane list", () => {
    const lane = makeLane({ id: "lane-1", name: "Lane 1" });
    const warnings = buildLanePrWarnings({
      lanes: [lane],
      selectedLaneIds: ["lane-1", "lane-nonexistent"],
      syncStatusByLaneId: {
        "lane-1": makeSyncStatus(),
        "lane-nonexistent": makeSyncStatus({ hasUpstream: false, upstreamRef: null }),
      },
    });

    // lane-nonexistent is not in lanes, so it should be filtered out
    expect(warnings).toEqual([]);
  });

  it("buildLanePrWarnings produces warnings for multiple lanes with distinct issues", () => {
    const dirtyLane = makeLane({
      id: "lane-dirty",
      name: "Dirty",
      status: { dirty: true, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    });
    const behindLane = makeLane({
      id: "lane-behind",
      name: "Behind",
      status: { dirty: false, ahead: 0, behind: 3, remoteBehind: 0, rebaseInProgress: false },
    });

    const warnings = buildLanePrWarnings({
      lanes: [dirtyLane, behindLane],
      selectedLaneIds: ["lane-dirty", "lane-behind"],
      syncStatusByLaneId: {
        "lane-dirty": makeSyncStatus(),
        "lane-behind": makeSyncStatus(),
      },
    });

    expect(warnings).toHaveLength(2);
    expect(warnings[0].laneId).toBe("lane-dirty");
    expect(warnings[0].issues).toEqual(["has uncommitted changes"]);
    expect(warnings[1].laneId).toBe("lane-behind");
    expect(warnings[1].issues[0]).toContain("behind its base branch");
  });

  it("buildLaneRebaseRecommendedLaneIds returns empty for all-clean lanes", () => {
    const cleanLane = makeLane({ id: "lane-clean", status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false } });
    expect(
      buildLaneRebaseRecommendedLaneIds({
        lanes: [cleanLane],
        selectedLaneIds: ["lane-clean"],
      }),
    ).toEqual([]);
  });

  it("buildLaneRebaseRecommendedLaneIds ignores selectedLaneIds not in lanes", () => {
    expect(
      buildLaneRebaseRecommendedLaneIds({
        lanes: [],
        selectedLaneIds: ["nonexistent"],
      }),
    ).toEqual([]);
  });
});
