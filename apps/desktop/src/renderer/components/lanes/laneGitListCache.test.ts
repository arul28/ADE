import { beforeEach, describe, expect, it } from "vitest";
import type { BranchDiffChanges, GitCommitSummary } from "../../../shared/types";
import {
  __resetLaneGitListCacheForTests,
  invalidateLaneGitListCache,
  isSameListResult,
  laneGitListEpoch,
  laneGitListScope,
  readLaneGitListCache,
  writeLaneGitListCache,
} from "./laneGitListCache";

const branchDiff: BranchDiffChanges = {
  baseRef: "main",
  mergeBase: "0123456789abcdef",
  files: [{ path: "src/alpha.ts", kind: "modified", additions: 1, deletions: 0 }],
  additions: 1,
  deletions: 0,
};

const commits: GitCommitSummary[] = [
  {
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    parents: [],
    authorName: "Ada",
    authoredAt: "2026-10-17T10:00:00.000Z",
    subject: "feat: alpha",
    pushed: false,
  },
];

describe("laneGitListCache", () => {
  beforeEach(() => {
    __resetLaneGitListCacheForTests();
  });

  it("has nothing for a lane that was never read", () => {
    expect(readLaneGitListCache(laneGitListScope("/repo", "lane-1"), "feature/a")).toBeNull();
  });

  it("returns a read only for the branch it was read for", () => {
    const scope = laneGitListScope("/repo", "lane-1");
    writeLaneGitListCache(scope, laneGitListEpoch(), "feature/a", { branchChanges: branchDiff, commits });

    expect(readLaneGitListCache(scope, "feature/a")).toEqual({ branchChanges: branchDiff, commits });
    expect(readLaneGitListCache(scope, "feature/renamed")).toBeNull();
  });

  it("keeps the other list when only one is written for the same branch", () => {
    const scope = laneGitListScope("/repo", "lane-1");
    writeLaneGitListCache(scope, laneGitListEpoch(), "feature/a", { branchChanges: branchDiff });
    writeLaneGitListCache(scope, laneGitListEpoch(), "feature/a", { commits });

    expect(readLaneGitListCache(scope, "feature/a")).toEqual({ branchChanges: branchDiff, commits });
  });

  it("drops the other list when a write is for a different branch", () => {
    const scope = laneGitListScope("/repo", "lane-1");
    writeLaneGitListCache(scope, laneGitListEpoch(), "feature/a", { branchChanges: branchDiff, commits });
    writeLaneGitListCache(scope, laneGitListEpoch(), "feature/b", { commits: [] });

    expect(readLaneGitListCache(scope, "feature/b")).toEqual({ branchChanges: undefined, commits: [] });
    expect(readLaneGitListCache(scope, "feature/a")).toBeNull();
  });

  it("drops a write whose read started before an invalidation", () => {
    const scope = laneGitListScope("/repo", "lane-1");
    const epochAtStart = laneGitListEpoch();
    invalidateLaneGitListCache("/repo", "lane-1");

    writeLaneGitListCache(scope, epochAtStart, "feature/a", { branchChanges: branchDiff });

    expect(readLaneGitListCache(scope, "feature/a")).toBeNull();
  });

  it("drops only the invalidated lane's rows", () => {
    const lane1 = laneGitListScope("/repo", "lane-1");
    const lane10 = laneGitListScope("/repo", "lane-10");
    const otherProject = laneGitListScope("/other", "lane-1");
    for (const scope of [lane1, lane10, otherProject]) {
      writeLaneGitListCache(scope, laneGitListEpoch(), "feature/a", { commits });
    }

    invalidateLaneGitListCache("/repo", "lane-1");

    expect(readLaneGitListCache(lane1, "feature/a")).toBeNull();
    expect(readLaneGitListCache(lane10, "feature/a")).toEqual({ branchChanges: undefined, commits });
    expect(readLaneGitListCache(otherProject, "feature/a")).toEqual({ branchChanges: undefined, commits });
  });

  it("keeps the twenty most recently read lanes", () => {
    const scopes = Array.from({ length: 21 }, (_, index) => laneGitListScope("/repo", `lane-${index}`) as string);
    for (const scope of scopes) {
      writeLaneGitListCache(scope, laneGitListEpoch(), "feature/a", { commits });
    }

    expect(readLaneGitListCache(scopes[0], "feature/a")).toBeNull();
    expect(readLaneGitListCache(scopes[1], "feature/a")).not.toBeNull();
    expect(readLaneGitListCache(scopes[20], "feature/a")).not.toBeNull();
  });

  it("treats a null scope as uncacheable", () => {
    expect(laneGitListScope("/repo", null)).toBeNull();
    writeLaneGitListCache(null, laneGitListEpoch(), "feature/a", { commits });
    expect(readLaneGitListCache(null, "feature/a")).toBeNull();
  });
});

describe("isSameListResult", () => {
  it("matches equal content and rejects a change or nothing rendered yet", () => {
    expect(isSameListResult(branchDiff, { ...branchDiff, files: [...branchDiff.files] })).toBe(true);
    expect(isSameListResult(branchDiff, { ...branchDiff, additions: 2 })).toBe(false);
    expect(isSameListResult(null, branchDiff)).toBe(false);
    expect(isSameListResult(undefined, [])).toBe(false);
    expect(isSameListResult([], [])).toBe(true);
  });
});
