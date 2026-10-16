import { describe, expect, it } from "vitest";
import type { LaneSummary, PrSummary } from "../../../shared/types";
import { isBaseLinePrimary, prsForLaneBranch } from "./commitRowModel";

type PrimaryInput = Pick<LaneSummary, "laneType" | "branchRef" | "baseRef">;

describe("isBaseLinePrimary", () => {
  it.each<{ name: string; lane: PrimaryInput; expected: boolean }>([
    { name: "Primary checked out on its base branch is the base line", lane: { laneType: "primary", branchRef: "refs/heads/main", baseRef: "main" }, expected: true },
    { name: "Primary whose base is the remote-tracking ref is the base line", lane: { laneType: "primary", branchRef: "main", baseRef: "origin/main" }, expected: true },
    { name: "Primary on a feature branch is a lane like any other", lane: { laneType: "primary", branchRef: "feat/stale-pill", baseRef: "main" }, expected: false },
    { name: "a non-primary lane is never the base line", lane: { laneType: "worktree", branchRef: "main", baseRef: "main" }, expected: false },
  ])("$name", ({ lane, expected }) => {
    expect(isBaseLinePrimary(lane)).toBe(expected);
  });
});

function pr(headBranch: string): PrSummary {
  // Only headBranch is read by prsForLaneBranch.
  return { headBranch } as PrSummary;
}

function lane(branchRef: string): Pick<LaneSummary, "branchRef"> {
  return { branchRef };
}

describe("prsForLaneBranch", () => {
  const current = lane("refs/heads/feat/current");

  it("keeps only the PRs whose head is the lane's current branch", () => {
    const kept = prsForLaneBranch([pr("feat/current"), pr("feat/previous"), pr("refs/heads/feat/current")], current);
    expect(kept.map((row) => row.headBranch)).toEqual(["feat/current", "refs/heads/feat/current"]);
  });

  it("keeps a PR whose head branch is not known rather than guessing it is stale", () => {
    const kept = prsForLaneBranch([pr(""), pr("feat/previous")], current);
    expect(kept.map((row) => row.headBranch)).toEqual([""]);
  });

  it("returns nothing when the lane has no branch to match", () => {
    expect(prsForLaneBranch([pr("feat/current")], lane(""))).toEqual([]);
  });
});
