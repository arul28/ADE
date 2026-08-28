import { describe, expect, it } from "vitest";
import {
  applySharedBranchAdjacency,
  consecutiveSharedBranchRuns,
  inboxIdsKeptForSharedBranch,
  sharedBranchClusterKey,
} from "./workLaneBranchClusters";

describe("sharedBranchClusterKey", () => {
  it("normalizes refs and ignores primaries and default trunks", () => {
    expect(sharedBranchClusterKey({
      branchRef: "refs/heads/ade/mobile-chat-scrolling",
      laneType: "worktree",
    })).toBe("ade/mobile-chat-scrolling");
    expect(sharedBranchClusterKey({
      branchRef: "ade/mobile-chat-scrolling",
      laneType: "worktree",
    })).toBe("ade/mobile-chat-scrolling");
    expect(sharedBranchClusterKey({ branchRef: "main", laneType: "worktree" })).toBeNull();
    expect(sharedBranchClusterKey({ branchRef: "refs/heads/master", laneType: "worktree" })).toBeNull();
    expect(sharedBranchClusterKey({
      branchRef: "refs/heads/ade/mobile-chat-scrolling",
      laneType: "primary",
    })).toBeNull();
    expect(sharedBranchClusterKey({ branchRef: "", laneType: "worktree" })).toBeNull();
  });
});

describe("applySharedBranchAdjacency", () => {
  const keyOf = (item: { branch: string | null }) => item.branch;

  it("pulls later same-branch lanes up beside the first one", () => {
    const ordered = applySharedBranchAdjacency([
      { id: "local-mobile", branch: "ade/mobile" },
      { id: "local-other", branch: "ade/other" },
      { id: "studio-mobile", branch: "ade/mobile" },
    ], keyOf);
    expect(ordered.map((entry) => entry.item.id)).toEqual([
      "local-mobile",
      "studio-mobile",
      "local-other",
    ]);
    expect(ordered.map((entry) => entry.clusterKey)).toEqual([
      "ade/mobile",
      "ade/mobile",
      null,
    ]);
  });

  it("leaves unique branches in place", () => {
    const ordered = applySharedBranchAdjacency([
      { id: "a", branch: "feat/a" },
      { id: "b", branch: "feat/b" },
    ], keyOf);
    expect(ordered.map((entry) => entry.item.id)).toEqual(["a", "b"]);
    expect(ordered.every((entry) => entry.clusterKey === null)).toBe(true);
  });

  it("does not cluster items whose key is null", () => {
    const ordered = applySharedBranchAdjacency([
      { id: "primary-local", branch: null },
      { id: "work", branch: "feat/x" },
      { id: "primary-studio", branch: null },
    ], keyOf);
    expect(ordered.map((entry) => entry.item.id)).toEqual([
      "primary-local",
      "work",
      "primary-studio",
    ]);
  });
});

describe("inboxIdsKeptForSharedBranch", () => {
  it("keeps a quiet sibling in the inbox when the other lane is live", () => {
    const kept = inboxIdsKeptForSharedBranch([
      { id: "local", clusterKey: "ade/mobile", shelf: null },
      { id: "studio", clusterKey: "ade/mobile", shelf: "settled" },
    ]);
    expect([...kept]).toEqual(["studio"]);
  });

  it("does not unshelf a cluster that is entirely quiet", () => {
    const kept = inboxIdsKeptForSharedBranch([
      { id: "local", clusterKey: "ade/mobile", shelf: "settled" },
      { id: "studio", clusterKey: "ade/mobile", shelf: "settled" },
    ]);
    expect(kept.size).toBe(0);
  });
});

describe("consecutiveSharedBranchRuns", () => {
  it("groups only adjacent clustered items", () => {
    const runs = consecutiveSharedBranchRuns([
      { id: "a", clusterKey: "feat" },
      { id: "b", clusterKey: "feat" },
      { id: "c", clusterKey: null },
    ]);
    expect(runs.map((run) => run.map((item) => item.id))).toEqual([["a", "b"], ["c"]]);
  });
});
