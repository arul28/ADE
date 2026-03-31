import { describe, expect, it } from "vitest";
import { branchNameFromRef, resolveLaneBaseBranch, describePrTargetDiff } from "./laneBranchTargets";
import type { LaneSummary } from "../../../../shared/types";

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

describe("branchNameFromRef", () => {
  it("strips refs/heads/ prefix", () => {
    expect(branchNameFromRef("refs/heads/main")).toBe("main");
  });

  it("strips refs/remotes/origin/ prefix", () => {
    expect(branchNameFromRef("refs/remotes/origin/feature/foo")).toBe("feature/foo");
  });

  it("strips origin/ prefix", () => {
    expect(branchNameFromRef("origin/develop")).toBe("develop");
  });

  it("returns plain branch name unchanged", () => {
    expect(branchNameFromRef("main")).toBe("main");
  });

  it("returns empty string for null", () => {
    expect(branchNameFromRef(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(branchNameFromRef(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(branchNameFromRef("")).toBe("");
  });
});

describe("resolveLaneBaseBranch", () => {
  it("returns the lane baseRef when no parent", () => {
    const lane = makeLane({ baseRef: "develop" });
    expect(resolveLaneBaseBranch({ lane, lanes: [] })).toBe("develop");
  });

  it("defaults to 'main' when lane is null", () => {
    expect(resolveLaneBaseBranch({ lane: null, lanes: [] })).toBe("main");
  });

  it("uses primaryBranchRef fallback when lane is null", () => {
    expect(resolveLaneBaseBranch({ lane: null, lanes: [], primaryBranchRef: "refs/heads/develop" })).toBe("develop");
  });

  it("resolves parent branch when lane has a non-primary parent", () => {
    const parent = makeLane({
      id: "parent-lane",
      laneType: "worktree",
      branchRef: "refs/heads/feature/parent",
    });
    const child = makeLane({
      id: "child-lane",
      parentLaneId: "parent-lane",
      baseRef: "main",
    });
    expect(resolveLaneBaseBranch({ lane: child, lanes: [parent, child] })).toBe("feature/parent");
  });

  it("falls back to lane baseRef when parent is primary type", () => {
    const parent = makeLane({
      id: "primary-lane",
      laneType: "primary",
      branchRef: "refs/heads/main",
    });
    const child = makeLane({
      id: "child-lane",
      parentLaneId: "primary-lane",
      baseRef: "develop",
    });
    expect(resolveLaneBaseBranch({ lane: child, lanes: [parent, child] })).toBe("develop");
  });

  it("falls back to lane baseRef when parent is not found in lanes", () => {
    const child = makeLane({
      id: "child-lane",
      parentLaneId: "missing-parent",
      baseRef: "develop",
    });
    expect(resolveLaneBaseBranch({ lane: child, lanes: [child] })).toBe("develop");
  });

  it("uses primaryBranchRef when lane has no baseRef", () => {
    const lane = makeLane({ baseRef: "" });
    expect(resolveLaneBaseBranch({ lane, lanes: [], primaryBranchRef: "refs/heads/master" })).toBe("master");
  });
});

describe("describePrTargetDiff", () => {
  it("returns null when lane is null", () => {
    expect(describePrTargetDiff({ lane: null, lanes: [] })).toBeNull();
  });

  it("returns null when targetBranch is null", () => {
    const lane = makeLane({ baseRef: "main" });
    expect(describePrTargetDiff({ lane, lanes: [], targetBranch: null })).toBeNull();
  });

  it("returns null when targetBranch is empty string", () => {
    const lane = makeLane({ baseRef: "main" });
    expect(describePrTargetDiff({ lane, lanes: [], targetBranch: "" })).toBeNull();
  });

  it("returns null when target matches the lane base branch", () => {
    const lane = makeLane({ baseRef: "main" });
    expect(describePrTargetDiff({ lane, lanes: [], targetBranch: "main" })).toBeNull();
  });

  it("returns a mismatch description when target differs from lane base", () => {
    const lane = makeLane({ baseRef: "main" });
    const result = describePrTargetDiff({ lane, lanes: [], targetBranch: "develop" });
    expect(result).toBe(
      "targets develop, but this lane currently tracks main. If you want to move the lane onto develop, use rebase or reparent instead of only retargeting the PR.",
    );
  });

  it("resolves the target ref before comparing", () => {
    const lane = makeLane({ baseRef: "main" });
    // refs/heads/main should resolve to "main" which matches the baseRef
    expect(describePrTargetDiff({ lane, lanes: [], targetBranch: "refs/heads/main" })).toBeNull();
  });

  it("resolves target origin/ prefix before comparing", () => {
    const lane = makeLane({ baseRef: "develop" });
    expect(describePrTargetDiff({ lane, lanes: [], targetBranch: "origin/develop" })).toBeNull();
  });

  it("accounts for parent lane when determining the base branch", () => {
    const parent = makeLane({
      id: "parent-lane",
      laneType: "worktree",
      branchRef: "refs/heads/feature/parent",
    });
    const child = makeLane({
      id: "child-lane",
      parentLaneId: "parent-lane",
      baseRef: "main",
    });
    // Child tracks feature/parent, so targeting "main" should show mismatch
    const result = describePrTargetDiff({ lane: child, lanes: [parent, child], targetBranch: "main" });
    expect(result).toBe(
      "targets main, but this lane currently tracks feature/parent. If you want to move the lane onto main, use rebase or reparent instead of only retargeting the PR.",
    );
  });

  it("returns null when target matches parent-resolved base", () => {
    const parent = makeLane({
      id: "parent-lane",
      laneType: "worktree",
      branchRef: "refs/heads/feature/parent",
    });
    const child = makeLane({
      id: "child-lane",
      parentLaneId: "parent-lane",
      baseRef: "main",
    });
    expect(describePrTargetDiff({ lane: child, lanes: [parent, child], targetBranch: "feature/parent" })).toBeNull();
  });

  it("uses primaryBranchRef in resolution when provided", () => {
    const lane = makeLane({ baseRef: "" });
    // Lane has no baseRef, resolves to primaryBranchRef "master"
    // Targeting "develop" should produce a mismatch
    const result = describePrTargetDiff({
      lane,
      lanes: [],
      targetBranch: "develop",
      primaryBranchRef: "refs/heads/master",
    });
    expect(result).toBe(
      "targets develop, but this lane currently tracks master. If you want to move the lane onto develop, use rebase or reparent instead of only retargeting the PR.",
    );
  });
});
