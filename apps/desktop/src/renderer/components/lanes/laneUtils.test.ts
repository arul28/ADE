import { describe, expect, it } from "vitest";
import type { LaneSummary } from "../../../shared/types";
import {
  LANES_TILING_LAYOUT_VERSION,
  LANES_TILING_TREE,
  LANES_TILING_WORK_FOCUS_TREE,
  formatBranchCheckoutError,
  isMissionLaneHiddenByDefault,
  laneMatchesFilter,
  stripRemotePrefix,
  validateBranchName,
} from "./laneUtils";

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "Lane One",
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/lane-one",
    worktreePath: "/tmp/lane-one",
    attachedRootPath: null,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    folder: null,
    missionId: null,
    laneRole: null,
    createdAt: "2026-03-30T10:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

describe("laneUtils tiling defaults", () => {
  it("makes git actions the largest default pane", () => {
    expect(LANES_TILING_TREE.children[0]?.defaultSize).toBe(15);
    expect(LANES_TILING_TREE.children[1]?.defaultSize).toBe(30);
    expect(LANES_TILING_TREE.children[2]?.defaultSize).toBe(55);
  });

  it("raises the git actions minimum share", () => {
    expect(LANES_TILING_TREE.children[2]?.minSize).toBe(28);
  });

  it("bumps the persisted tiling layout version", () => {
    expect(LANES_TILING_LAYOUT_VERSION).toBe("v6");
  });

  it("work-focus layout emphasizes the work pane", () => {
    expect(LANES_TILING_WORK_FOCUS_TREE.children[1]?.defaultSize).toBeGreaterThan(40);
    expect(LANES_TILING_WORK_FOCUS_TREE.children[2]?.defaultSize).toBeLessThan(
      (LANES_TILING_TREE.children[2]?.defaultSize ?? 0),
    );
  });

  it("hides non-result mission lanes by default but reveals them with mission filters", () => {
    const workerLane = makeLane({ missionId: "mission-1", laneRole: "worker", name: "Mission worker" });
    const resultLane = makeLane({ missionId: "mission-1", laneRole: "result", name: "Mission result" });

    expect(isMissionLaneHiddenByDefault(workerLane)).toBe(true);
    expect(laneMatchesFilter(workerLane, false, "")).toBe(false);
    expect(laneMatchesFilter(workerLane, false, "is:mission")).toBe(true);
    expect(laneMatchesFilter(resultLane, false, "")).toBe(true);
    expect(laneMatchesFilter(resultLane, false, "is:mission-result")).toBe(true);
  });

  describe("validateBranchName", () => {
    it("accepts ordinary names", () => {
      expect(validateBranchName("feature/foo").ok).toBe(true);
      expect(validateBranchName("topic-1").ok).toBe(true);
      expect(validateBranchName("release/2025-04").ok).toBe(true);
    });

    it("rejects empty / whitespace-only input", () => {
      expect(validateBranchName("").ok).toBe(false);
      expect(validateBranchName("   ").ok).toBe(false);
    });

    it("rejects illegal characters and patterns from git check-ref-format", () => {
      for (const bad of [
        "-leading-dash",
        "/leading-slash",
        "trailing-slash/",
        "trailing-dot.",
        "ends.lock",
        "two..dots",
        "double//slash",
        "ref@{stale}",
        "has space",
        "has~tilde",
        "has^caret",
        "has:colon",
        "has?question",
        "has*star",
        "has[bracket",
        "has\\backslash",
      ]) {
        expect(validateBranchName(bad).ok, `expected '${bad}' to fail`).toBe(false);
      }
    });

    it("rejects control characters", () => {
      expect(validateBranchName(`foo${String.fromCharCode(0x07)}bar`).ok).toBe(false);
      expect(validateBranchName(`foo${String.fromCharCode(0x7f)}bar`).ok).toBe(false);
    });

    it("rejects path segments starting with '.' or ending with '.lock'", () => {
      expect(validateBranchName("feature/.hidden").ok).toBe(false);
      expect(validateBranchName("feature/oops.lock").ok).toBe(false);
    });
  });

  describe("formatBranchCheckoutError", () => {
    it("interpolates the lane name when provided", () => {
      const raw = "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/foo.ts";
      const formatted = formatBranchCheckoutError(raw, "ship/auth");
      expect(formatted).toContain("ship/auth has uncommitted changes");
      expect(formatted).not.toContain("primary");
    });

    it("falls back to a generic 'this lane' phrasing without a lane name", () => {
      const raw = "error: Please commit your changes or stash them before you switch branches.";
      const formatted = formatBranchCheckoutError(raw);
      expect(formatted).toContain("this lane has uncommitted changes");
    });

    it("passes non-dirty errors through unchanged", () => {
      expect(formatBranchCheckoutError("fatal: not a git repository", "primary")).toBe("fatal: not a git repository");
    });
  });

  describe("stripRemotePrefix", () => {
    it("strips remote names (origin/foo → foo)", () => {
      expect(stripRemotePrefix("origin/main")).toBe("main");
      expect(stripRemotePrefix("upstream/feature/x")).toBe("feature/x");
    });

    it("strips refs/remotes/<remote>/ prefixes", () => {
      expect(stripRemotePrefix("refs/remotes/origin/main")).toBe("main");
    });

    it("returns the input when there is no prefix to strip", () => {
      expect(stripRemotePrefix("main")).toBe("main");
    });
  });
});
