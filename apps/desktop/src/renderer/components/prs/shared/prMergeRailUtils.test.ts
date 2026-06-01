import { describe, expect, it } from "vitest";

import type { PrCheck, PrReview, PrStatus, PrWithConflicts } from "../../../../shared/types/prs";
import {
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
});
