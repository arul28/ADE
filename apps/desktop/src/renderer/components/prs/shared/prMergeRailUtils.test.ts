import { describe, expect, it } from "vitest";

import type { PrCheck, PrCommit, PrReview, PrStatus, PrWithConflicts } from "../../../../shared/types/prs";
import {
  buildDefaultCommitMessage,
  buildMergeChecklist,
  buildMergeCommandLineInstructions,
  canAttemptMerge,
  deriveMergeBlockers,
  mergeMethodLabel,
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

  it("derives merge blockers from status, checks, and reviews", () => {
    const checks: PrCheck[] = [{
      name: "ci",
      status: "completed",
      conclusion: "failure",
      detailsUrl: null,
      startedAt: null,
      completedAt: null,
    }];
    const reviews: PrReview[] = [{
      reviewer: "alice",
      reviewerAvatarUrl: null,
      state: "changes_requested",
      body: null,
      submittedAt: null,
    }];

    const blockers = deriveMergeBlockers({
      pr: makePr(),
      status: makeStatus({ isMergeable: false, reviewStatus: "changes_requested" }),
      checks,
      reviews,
    });

    expect(blockers.some((blocker) => blocker.id === "failing-checks")).toBe(true);
    expect(blockers.some((blocker) => blocker.id === "changes-requested")).toBe(true);
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

describe("buildMergeChecklist", () => {
  it("derives review / checks / conflict / behind rows from merge-box state", () => {
    const checks: PrCheck[] = [{
      name: "ci",
      status: "completed",
      conclusion: "success",
      detailsUrl: null,
      startedAt: null,
      completedAt: null,
    }];
    const items = buildMergeChecklist({
      pr: makePr(),
      status: makeStatus({
        mergeStateStatus: "blocked",
        reviewDecision: "review_required",
        approvalsCount: 0,
        requiredApprovals: 1,
        behindBaseBy: 2,
        canBypass: true,
      }),
      checks,
      reviews: [],
    });

    const review = items.find((i) => i.id === "review");
    expect(review?.state).toBe("fail");
    expect(review?.detail).toContain("0 of 1");

    expect(items.find((i) => i.id === "checks")?.state).toBe("pass");
    expect(items.find((i) => i.id === "conflicts")?.state).toBe("pass");

    const behind = items.find((i) => i.id === "behind");
    expect(behind?.state).toBe("neutral");
    expect(behind?.label).toContain("2 commits behind");

    expect(items.find((i) => i.id === "protected")?.state).toBe("neutral");
  });

  it("marks conflicts and approval as pass/fail correctly", () => {
    const cleanItems = buildMergeChecklist({
      pr: makePr(),
      status: makeStatus({ mergeStateStatus: "clean", reviewDecision: "approved", approvalsCount: 1, requiredApprovals: 1 }),
      checks: [],
      reviews: [],
    });
    expect(cleanItems.find((i) => i.id === "review")?.state).toBe("pass");
    expect(cleanItems.find((i) => i.id === "conflicts")?.label).toContain("No conflicts");

    const dirtyItems = buildMergeChecklist({
      pr: makePr(),
      status: makeStatus({ mergeStateStatus: "dirty", mergeConflicts: true }),
      checks: [],
      reviews: [],
    });
    expect(dirtyItems.find((i) => i.id === "conflicts")?.state).toBe("fail");
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
