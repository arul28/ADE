// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PrCommit, PrStatus, PrWithConflicts } from "../../../../shared/types/prs";
import {
  buildDefaultCommitMessage,
  buildMergeCommandLineInstructions,
  canAttemptMerge,
  LAST_MERGE_METHOD_KEY,
  mergeMethodLabel,
  readLastMergeMethod,
  writeLastMergeMethod,
} from "./prMergeRailUtils";

function makePr(overrides: Partial<PrWithConflicts> = {}): PrWithConflicts {
  return {
    id: "pr-1",
    laneId: "lane-1",
    projectId: "project-1",
    repoOwner: "acme",
    repoName: "repo",
    githubPrNumber: 42,
    githubUrl: "https://github.com/acme/repo/pull/42",
    githubNodeId: null,
    title: "Test PR",
    state: "open",
    baseBranch: "main",
    headBranch: "feature",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 1,
    deletions: 0,
    lastSyncedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as PrWithConflicts;
}

function makeStatus(overrides: Partial<PrStatus> = {}): PrStatus {
  return {
    prId: "pr-1",
    state: "open",
    checksStatus: "passing",
    reviewStatus: "approved",
    isMergeable: true,
    mergeConflicts: false,
    behindBaseBy: 0,
    ...overrides,
  };
}

describe("prMergeRailUtils", () => {
  it("labels merge methods like GitHub", () => {
    expect(mergeMethodLabel("squash")).toBe("Squash and merge");
    expect(mergeMethodLabel("merge")).toBe("Create merge commit");
    expect(mergeMethodLabel("rebase")).toBe("Rebase and merge");
  });

  it("allows bypass merge attempts when requested", () => {
    expect(canAttemptMerge({
      pr: makePr(),
      status: makeStatus({ isMergeable: false }),
      bypassRules: false,
    })).toBe(false);
    expect(canAttemptMerge({
      pr: makePr(),
      status: makeStatus({ isMergeable: false }),
      bypassRules: true,
    })).toBe(true);
  });

  it("does not allow draft PR merge attempts even with bypass enabled", () => {
    expect(canAttemptMerge({
      pr: makePr({ state: "draft" }),
      status: makeStatus({ state: "draft", isMergeable: true }),
      bypassRules: true,
    })).toBe(false);
  });

  it("builds gh merge instructions with optional admin bypass", () => {
    expect(buildMergeCommandLineInstructions({
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 42,
      method: "squash",
    })).toBe("gh pr merge 42 --squash --repo acme/repo");
    expect(buildMergeCommandLineInstructions({
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 42,
      method: "merge",
      bypassRules: true,
    })).toBe("gh pr merge 42 --merge --admin --repo acme/repo");
  });

  it("uses mergeStateStatus to gate merge attempts when present", () => {
    // clean → mergeable even if the legacy boolean disagrees.
    expect(canAttemptMerge({
      pr: makePr(),
      status: makeStatus({ mergeStateStatus: "clean", isMergeable: false }),
      bypassRules: false,
    })).toBe(true);
    // unstable (non-required checks failing) is still mergeable.
    expect(canAttemptMerge({
      pr: makePr(),
      status: makeStatus({ mergeStateStatus: "unstable" }),
      bypassRules: false,
    })).toBe(true);
    // blocked is not mergeable without bypass.
    expect(canAttemptMerge({
      pr: makePr(),
      status: makeStatus({ mergeStateStatus: "blocked" }),
      bypassRules: false,
    })).toBe(false);
    // blocked + bypass can land.
    expect(canAttemptMerge({
      pr: makePr(),
      status: makeStatus({ mergeStateStatus: "blocked" }),
      bypassRules: true,
    })).toBe(true);
    // dirty (conflicts) never merges, even with bypass.
    expect(canAttemptMerge({
      pr: makePr(),
      status: makeStatus({ mergeStateStatus: "dirty" }),
      bypassRules: true,
    })).toBe(false);
  });
});

describe("buildDefaultCommitMessage", () => {
  const commits: PrCommit[] = [
    { sha: "a1", shortSha: "a1", message: "First commit", author: { login: "a", name: "A", email: null }, committedDate: "" },
    { sha: "b2", shortSha: "b2", message: "Second commit", author: { login: "b", name: "B", email: null }, committedDate: "" },
  ];

  it("squash → '<title> (#n)' with concatenated commit messages", () => {
    const result = buildDefaultCommitMessage({
      method: "squash",
      prTitle: "Add feature",
      prNumber: 7,
      headBranch: "feature",
      baseBranch: "main",
      repoOwner: "acme",
      commits,
    });
    expect(result.title).toBe("Add feature (#7)");
    expect(result.body).toContain("First commit");
    expect(result.body).toContain("Second commit");
  });

  it("merge → 'Merge pull request #n from owner/head', body = PR title", () => {
    const result = buildDefaultCommitMessage({
      method: "merge",
      prTitle: "Add feature",
      prNumber: 7,
      headBranch: "feature",
      baseBranch: "main",
      repoOwner: "acme",
      commits,
    });
    expect(result.title).toBe("Merge pull request #7 from acme/feature");
    expect(result.body).toBe("Add feature");
  });

  it("rebase → empty", () => {
    const result = buildDefaultCommitMessage({
      method: "rebase",
      prTitle: "Add feature",
      prNumber: 7,
      headBranch: "feature",
      baseBranch: "main",
      repoOwner: "acme",
      commits,
    });
    expect(result.title).toBe("");
    expect(result.body).toBe("");
  });
});

describe("last merge method", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.removeItem(LAST_MERGE_METHOD_KEY);
  });

  it("returns the fallback until a method is written", () => {
    expect(readLastMergeMethod("squash")).toBe("squash");
    writeLastMergeMethod("rebase");
    expect(window.localStorage.getItem(LAST_MERGE_METHOD_KEY)).toBe("rebase");
    expect(readLastMergeMethod("squash")).toBe("rebase");
  });

  it("ignores an unknown stored value", () => {
    window.localStorage.setItem(LAST_MERGE_METHOD_KEY, "fast-forward");
    expect(readLastMergeMethod("merge")).toBe("merge");
  });

  it("does not throw when storage is unavailable", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => writeLastMergeMethod("merge")).not.toThrow();
    expect(readLastMergeMethod("squash")).toBe("squash");
  });
});
