import { describe, expect, it } from "vitest";
import {
  buildUpstreamRebaseChain,
  findLaneBaseNeed,
  findMatchingRebaseNeed,
  formatUpstreamRebaseSummary,
  rebaseNeedItemKey,
  resolveRouteRebaseSelection,
} from "./rebaseNeedUtils";
import type { LaneSummary, RebaseNeed } from "../../../../shared/types";

function makeNeed(overrides: Partial<RebaseNeed> = {}): RebaseNeed {
  return {
    laneId: overrides.laneId ?? "lane-1",
    laneName: overrides.laneName ?? "Feature Lane",
    kind: overrides.kind ?? "lane_base",
    baseBranch: overrides.baseBranch ?? "main",
    behindBy: overrides.behindBy ?? 3,
    conflictPredicted: overrides.conflictPredicted ?? false,
    conflictingFiles: overrides.conflictingFiles ?? [],
    prId: overrides.prId ?? null,
    groupContext: overrides.groupContext ?? null,
    dismissedAt: overrides.dismissedAt ?? null,
    deferredUntil: overrides.deferredUntil ?? null,
  };
}

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: overrides.id ?? "lane-1",
    name: overrides.name ?? "Feature Lane",
    laneType: overrides.laneType ?? "worktree",
    baseRef: overrides.baseRef ?? "refs/heads/main",
    branchRef: overrides.branchRef ?? "refs/heads/feature",
    worktreePath: overrides.worktreePath ?? "/tmp/feature",
    parentLaneId: overrides.parentLaneId ?? null,
    childCount: overrides.childCount ?? 0,
    stackDepth: overrides.stackDepth ?? 0,
    parentStatus: overrides.parentStatus ?? null,
    isEditProtected: overrides.isEditProtected ?? false,
    status: overrides.status ?? {
      dirty: false,
      ahead: 0,
      behind: 0,
      remoteBehind: 0,
      rebaseInProgress: false,
    },
    color: overrides.color ?? null,
    icon: overrides.icon ?? null,
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("rebaseNeedItemKey", () => {
  it("produces a colon-delimited key for lane_base needs", () => {
    const need = makeNeed({ laneId: "lane-1", kind: "lane_base", prId: null, baseBranch: "main" });
    expect(rebaseNeedItemKey(need)).toBe("lane-1:lane_base:base:main");
  });

  it("includes prId in key for pr_target needs", () => {
    const need = makeNeed({ laneId: "lane-1", kind: "pr_target", prId: "pr-42", baseBranch: "develop" });
    expect(rebaseNeedItemKey(need)).toBe("lane-1:pr_target:pr-42:develop");
  });

  it("uses 'base' placeholder when prId is null", () => {
    const need = makeNeed({ prId: null });
    expect(rebaseNeedItemKey(need)).toContain(":base:");
  });

  it("produces distinct keys for same lane with different kinds", () => {
    const laneBase = makeNeed({ kind: "lane_base", prId: null });
    const prTarget = makeNeed({ kind: "pr_target", prId: "pr-1" });
    expect(rebaseNeedItemKey(laneBase)).not.toBe(rebaseNeedItemKey(prTarget));
  });

  it("produces distinct keys for same lane with different base branches", () => {
    const needMain = makeNeed({ baseBranch: "main" });
    const needDevelop = makeNeed({ baseBranch: "develop" });
    expect(rebaseNeedItemKey(needMain)).not.toBe(rebaseNeedItemKey(needDevelop));
  });

  it("produces distinct keys for different lanes", () => {
    const need1 = makeNeed({ laneId: "lane-1" });
    const need2 = makeNeed({ laneId: "lane-2" });
    expect(rebaseNeedItemKey(need1)).not.toBe(rebaseNeedItemKey(need2));
  });
});

describe("findLaneBaseNeed", () => {
  it("finds the lane_base need for a given laneId", () => {
    const needs = [
      makeNeed({ laneId: "lane-1", kind: "lane_base" }),
      makeNeed({ laneId: "lane-1", kind: "pr_target", prId: "pr-1" }),
      makeNeed({ laneId: "lane-2", kind: "lane_base" }),
    ];
    const result = findLaneBaseNeed(needs, "lane-1");
    expect(result).not.toBeNull();
    expect(result!.laneId).toBe("lane-1");
    expect(result!.kind).toBe("lane_base");
  });

  it("returns null when no lane_base need exists for the laneId", () => {
    const needs = [
      makeNeed({ laneId: "lane-1", kind: "pr_target", prId: "pr-1" }),
    ];
    expect(findLaneBaseNeed(needs, "lane-1")).toBeNull();
  });

  it("returns null when laneId is not found at all", () => {
    const needs = [
      makeNeed({ laneId: "lane-1", kind: "lane_base" }),
    ];
    expect(findLaneBaseNeed(needs, "lane-nonexistent")).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(findLaneBaseNeed([], "lane-1")).toBeNull();
  });

  it("returns the first lane_base match when multiple exist", () => {
    const needs = [
      makeNeed({ laneId: "lane-1", kind: "lane_base", baseBranch: "main" }),
      makeNeed({ laneId: "lane-1", kind: "lane_base", baseBranch: "develop" }),
    ];
    const result = findLaneBaseNeed(needs, "lane-1");
    expect(result).not.toBeNull();
    expect(result!.baseBranch).toBe("main");
  });
});

describe("findMatchingRebaseNeed", () => {
  it("matches by prId when provided", () => {
    const needs = [
      makeNeed({ laneId: "lane-1", kind: "lane_base", prId: null, baseBranch: "main" }),
      makeNeed({ laneId: "lane-1", kind: "pr_target", prId: "pr-42", baseBranch: "develop" }),
      makeNeed({ laneId: "lane-2", kind: "lane_base", prId: null, baseBranch: "main" }),
    ];
    const result = findMatchingRebaseNeed({ rebaseNeeds: needs, laneId: "lane-1", prId: "pr-42" });
    expect(result).not.toBeNull();
    expect(result!.prId).toBe("pr-42");
    expect(result!.kind).toBe("pr_target");
  });

  it("matches by laneId + baseBranch when prId is not provided", () => {
    const needs = [
      makeNeed({ laneId: "lane-1", kind: "lane_base", baseBranch: "main" }),
      makeNeed({ laneId: "lane-1", kind: "lane_base", baseBranch: "develop" }),
    ];
    const result = findMatchingRebaseNeed({ rebaseNeeds: needs, laneId: "lane-1", baseBranch: "develop" });
    expect(result).not.toBeNull();
    expect(result!.baseBranch).toBe("develop");
  });

  it("falls back to any need matching laneId when neither prId nor baseBranch match", () => {
    const needs = [
      makeNeed({ laneId: "lane-1", kind: "lane_base", baseBranch: "main" }),
    ];
    const result = findMatchingRebaseNeed({ rebaseNeeds: needs, laneId: "lane-1" });
    expect(result).not.toBeNull();
    expect(result!.laneId).toBe("lane-1");
  });

  it("returns null when no needs match at all", () => {
    const needs = [
      makeNeed({ laneId: "lane-2", kind: "lane_base" }),
    ];
    expect(findMatchingRebaseNeed({ rebaseNeeds: needs, laneId: "lane-1" })).toBeNull();
  });

  it("returns null for null rebaseNeeds", () => {
    expect(findMatchingRebaseNeed({ rebaseNeeds: null, laneId: "lane-1" })).toBeNull();
  });

  it("returns null for undefined rebaseNeeds", () => {
    expect(findMatchingRebaseNeed({ rebaseNeeds: undefined, laneId: "lane-1" })).toBeNull();
  });

  it("returns null for empty rebaseNeeds array", () => {
    expect(findMatchingRebaseNeed({ rebaseNeeds: [], laneId: "lane-1" })).toBeNull();
  });

  it("prId match takes priority over baseBranch match", () => {
    const needs = [
      makeNeed({ laneId: "lane-1", kind: "lane_base", prId: null, baseBranch: "develop" }),
      makeNeed({ laneId: "lane-2", kind: "pr_target", prId: "pr-99", baseBranch: "main" }),
    ];
    // prId "pr-99" belongs to lane-2, but we're searching for lane-1
    // The prId match should win even though laneId doesn't match
    const result = findMatchingRebaseNeed({
      rebaseNeeds: needs,
      laneId: "lane-1",
      prId: "pr-99",
      baseBranch: "develop",
    });
    expect(result).not.toBeNull();
    expect(result!.prId).toBe("pr-99");
    expect(result!.laneId).toBe("lane-2");
  });

  it("trims whitespace from prId before matching", () => {
    const needs = [
      makeNeed({ laneId: "lane-1", kind: "pr_target", prId: "pr-5", baseBranch: "main" }),
    ];
    const result = findMatchingRebaseNeed({ rebaseNeeds: needs, laneId: "lane-1", prId: "  pr-5  " });
    expect(result).not.toBeNull();
    expect(result!.prId).toBe("pr-5");
  });

  it("trims whitespace from baseBranch before matching", () => {
    const needs = [
      makeNeed({ laneId: "lane-1", baseBranch: "develop" }),
    ];
    const result = findMatchingRebaseNeed({ rebaseNeeds: needs, laneId: "lane-1", baseBranch: "  develop  " });
    expect(result).not.toBeNull();
    expect(result!.baseBranch).toBe("develop");
  });

  it("does not match when prId is empty string (treated as no prId)", () => {
    const needs = [
      makeNeed({ laneId: "lane-1", kind: "lane_base", baseBranch: "main" }),
    ];
    // Empty prId should be treated as no prId, fall through to baseBranch/laneId matching
    const result = findMatchingRebaseNeed({ rebaseNeeds: needs, laneId: "lane-1", prId: "" });
    expect(result).not.toBeNull();
    expect(result!.laneId).toBe("lane-1");
  });

  it("does not match when baseBranch is whitespace-only (treated as no baseBranch)", () => {
    const needs = [
      makeNeed({ laneId: "lane-1", kind: "lane_base", baseBranch: "main" }),
    ];
    // Whitespace-only baseBranch should be treated as empty, fall through to laneId-only matching
    const result = findMatchingRebaseNeed({ rebaseNeeds: needs, laneId: "lane-1", baseBranch: "   " });
    expect(result).not.toBeNull();
    expect(result!.laneId).toBe("lane-1");
  });

  it("baseBranch match requires laneId to also match", () => {
    const needs = [
      makeNeed({ laneId: "lane-2", kind: "lane_base", baseBranch: "develop" }),
    ];
    // baseBranch matches but laneId doesn't -- should not match on baseBranch
    const result = findMatchingRebaseNeed({ rebaseNeeds: needs, laneId: "lane-1", baseBranch: "develop" });
    expect(result).toBeNull();
  });
});

describe("resolveRouteRebaseSelection", () => {
  it("keeps an exact rebase item key unchanged", () => {
    const need = makeNeed({ laneId: "lane-1", kind: "lane_base", baseBranch: "main" });
    const itemKey = rebaseNeedItemKey(need);

    expect(resolveRouteRebaseSelection({ rebaseNeeds: [need], routeItemId: itemKey })).toBe(itemKey);
  });

  it("resolves a raw lane id to the lane-base need key when available", () => {
    const laneBaseNeed = makeNeed({ laneId: "lane-1", kind: "lane_base", baseBranch: "main" });
    const prTargetNeed = makeNeed({ laneId: "lane-1", kind: "pr_target", prId: "pr-1", baseBranch: "develop" });

    expect(resolveRouteRebaseSelection({ rebaseNeeds: [prTargetNeed, laneBaseNeed], routeItemId: "lane-1" })).toBe(
      rebaseNeedItemKey(laneBaseNeed),
    );
  });

  it("falls back to another matching rebase need when no lane-base need exists", () => {
    const prTargetNeed = makeNeed({ laneId: "lane-1", kind: "pr_target", prId: "pr-1", baseBranch: "develop" });

    expect(resolveRouteRebaseSelection({ rebaseNeeds: [prTargetNeed], routeItemId: "lane-1" })).toBe(
      rebaseNeedItemKey(prTargetNeed),
    );
  });

  it("preserves the raw route item id when rebase needs have not loaded yet", () => {
    expect(resolveRouteRebaseSelection({ rebaseNeeds: [], routeItemId: "lane-1" })).toBe("lane-1");
  });

  it("returns null for empty route ids", () => {
    expect(resolveRouteRebaseSelection({ rebaseNeeds: [], routeItemId: "   " })).toBeNull();
  });
});

describe("buildUpstreamRebaseChain", () => {
  it("surfaces the immediate parent's direct rebase need for a child lane", () => {
    const lanes = [
      makeLane({ id: "root", name: "main" }),
      makeLane({ id: "parent", name: "Parent Lane", parentLaneId: null, stackDepth: 1 }),
      makeLane({ id: "child", name: "Child Lane", parentLaneId: "parent", stackDepth: 2 }),
    ];
    const rebaseNeeds = [
      makeNeed({ laneId: "parent", laneName: "Parent Lane", baseBranch: "main", behindBy: 7 }),
      makeNeed({ laneId: "child", laneName: "Child Lane", baseBranch: "parent", behindBy: 2 }),
    ];

    expect(buildUpstreamRebaseChain({ laneId: "child", lanes, rebaseNeeds })).toEqual([
      {
        laneId: "parent",
        laneName: "Parent Lane",
        kind: "lane_base",
        baseBranch: "main",
        behindBy: 7,
        conflictPredicted: false,
      },
    ]);
  });

  it("walks the full ancestor chain without duplicating the selected lane", () => {
    const lanes = [
      makeLane({ id: "grand", name: "Grand Lane", stackDepth: 1 }),
      makeLane({ id: "parent", name: "Parent Lane", parentLaneId: "grand", stackDepth: 2 }),
      makeLane({ id: "child", name: "Child Lane", parentLaneId: "parent", stackDepth: 3 }),
    ];
    const rebaseNeeds = [
      makeNeed({ laneId: "grand", laneName: "Grand Lane", baseBranch: "main", behindBy: 7 }),
      makeNeed({ laneId: "parent", laneName: "Parent Lane", baseBranch: "grand", behindBy: 2 }),
      makeNeed({ laneId: "child", laneName: "Child Lane", baseBranch: "parent", behindBy: 1 }),
    ];

    expect(buildUpstreamRebaseChain({ laneId: "child", lanes, rebaseNeeds })).toEqual([
      {
        laneId: "parent",
        laneName: "Parent Lane",
        kind: "lane_base",
        baseBranch: "grand",
        behindBy: 2,
        conflictPredicted: false,
      },
      {
        laneId: "grand",
        laneName: "Grand Lane",
        kind: "lane_base",
        baseBranch: "main",
        behindBy: 7,
        conflictPredicted: false,
      },
    ]);
  });

  it("returns an empty chain for top-level lanes", () => {
    const lanes = [makeLane({ id: "root", name: "Root Lane" })];
    const rebaseNeeds = [makeNeed({ laneId: "root", laneName: "Root Lane", baseBranch: "main", behindBy: 3 })];

    expect(buildUpstreamRebaseChain({ laneId: "root", lanes, rebaseNeeds })).toEqual([]);
  });
});

describe("formatUpstreamRebaseSummary", () => {
  it("returns null when there is no upstream drift", () => {
    expect(formatUpstreamRebaseSummary([])).toBeNull();
  });

  it("summarizes a single ancestor directly", () => {
    expect(formatUpstreamRebaseSummary([
      {
        laneId: "parent",
        laneName: "Parent Lane",
        kind: "lane_base",
        baseBranch: "main",
        behindBy: 7,
        conflictPredicted: false,
      },
    ])).toBe("Parent Lane is 7 behind main");
  });

  it("summarizes multiple ancestors using the terminal upstream target", () => {
    expect(formatUpstreamRebaseSummary([
      {
        laneId: "parent",
        laneName: "Parent Lane",
        kind: "lane_base",
        baseBranch: "grand",
        behindBy: 2,
        conflictPredicted: false,
      },
      {
        laneId: "grand",
        laneName: "Grand Lane",
        kind: "lane_base",
        baseBranch: "main",
        behindBy: 7,
        conflictPredicted: false,
      },
    ])).toBe("2 ancestors pending; Grand Lane is 7 behind main");
  });
});
