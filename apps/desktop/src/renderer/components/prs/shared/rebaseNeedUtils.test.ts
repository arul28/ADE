import { describe, expect, it } from "vitest";
import { rebaseNeedItemKey, findLaneBaseNeed, findMatchingRebaseNeed } from "./rebaseNeedUtils";
import type { RebaseNeed } from "../../../../shared/types";

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
