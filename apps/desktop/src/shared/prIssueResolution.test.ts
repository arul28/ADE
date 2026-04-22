import { describe, expect, it } from "vitest";
import {
  defaultPrIssueResolutionScope,
  getPrIssueResolutionAvailability,
  isActionableIssueComment,
  isIssueInventoryItemActionableForRound,
  isNoisyIssueComment,
  isPrCheckActionableFailure,
  isPrCheckPassing,
  type PrIssueResolutionAvailability,
} from "./prIssueResolution";
import type { IssueInventoryItem, PrCheck, PrComment, PrReviewThread } from "./types";

function makeCheck(overrides: Partial<PrCheck> = {}): PrCheck {
  return {
    name: "ci/build",
    status: "completed",
    conclusion: "success",
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function makeComment(overrides: Partial<PrComment> = {}): PrComment {
  return {
    id: "c1",
    author: "alice",
    authorAvatarUrl: null,
    body: "Looks good, please address the nit above.",
    source: "issue",
    url: null,
    path: null,
    line: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function makeReviewThread(overrides: Partial<PrReviewThread> = {}): PrReviewThread {
  return {
    id: "t1",
    isResolved: false,
    isOutdated: false,
    path: "src/foo.ts",
    line: 10,
    originalLine: 10,
    startLine: null,
    originalStartLine: null,
    diffSide: "RIGHT",
    url: null,
    createdAt: null,
    updatedAt: null,
    comments: [],
    ...overrides,
  };
}

function makeIssueItem(overrides: Partial<IssueInventoryItem> = {}): IssueInventoryItem {
  return {
    id: "i1",
    prId: "pr1",
    source: "coderabbit",
    type: "review_thread",
    externalId: "ext1",
    state: "new",
    round: 1,
    filePath: null,
    line: null,
    severity: null,
    headline: "headline",
    body: null,
    author: null,
    url: null,
    dismissReason: null,
    agentSessionId: null,
    createdAt: "2026-04-22T00:00:00Z",
    updatedAt: "2026-04-22T00:00:00Z",
    ...overrides,
  };
}

describe("isPrCheckPassing", () => {
  it("returns true for success, neutral, and skipped conclusions", () => {
    expect(isPrCheckPassing(makeCheck({ conclusion: "success" }))).toBe(true);
    expect(isPrCheckPassing(makeCheck({ conclusion: "neutral" }))).toBe(true);
    expect(isPrCheckPassing(makeCheck({ conclusion: "skipped" }))).toBe(true);
  });

  it("returns false for failure, cancelled, and null conclusions", () => {
    expect(isPrCheckPassing(makeCheck({ conclusion: "failure" }))).toBe(false);
    expect(isPrCheckPassing(makeCheck({ conclusion: "cancelled" }))).toBe(false);
    expect(isPrCheckPassing(makeCheck({ conclusion: null }))).toBe(false);
  });
});

describe("isPrCheckActionableFailure", () => {
  it("returns true only for completed failure or cancelled checks", () => {
    expect(isPrCheckActionableFailure(makeCheck({ status: "completed", conclusion: "failure" }))).toBe(true);
    expect(isPrCheckActionableFailure(makeCheck({ status: "completed", conclusion: "cancelled" }))).toBe(true);
  });

  it("returns false for completed non-failing checks", () => {
    expect(isPrCheckActionableFailure(makeCheck({ status: "completed", conclusion: "success" }))).toBe(false);
    expect(isPrCheckActionableFailure(makeCheck({ status: "completed", conclusion: "neutral" }))).toBe(false);
    expect(isPrCheckActionableFailure(makeCheck({ status: "completed", conclusion: "skipped" }))).toBe(false);
    expect(isPrCheckActionableFailure(makeCheck({ status: "completed", conclusion: null }))).toBe(false);
  });

  it("returns false when status is not completed regardless of conclusion", () => {
    expect(isPrCheckActionableFailure(makeCheck({ status: "queued", conclusion: "failure" }))).toBe(false);
    expect(isPrCheckActionableFailure(makeCheck({ status: "in_progress", conclusion: "cancelled" }))).toBe(false);
  });
});

describe("isNoisyIssueComment", () => {
  it("treats empty or whitespace bodies as noisy", () => {
    expect(isNoisyIssueComment({ author: "alice", body: "" })).toBe(true);
    expect(isNoisyIssueComment({ author: "alice", body: "   " })).toBe(true);
    expect(isNoisyIssueComment({ author: "alice", body: null })).toBe(true);
  });

  it("treats known bot authors as noisy regardless of body", () => {
    expect(isNoisyIssueComment({ author: "vercel", body: "deployment ready" })).toBe(true);
    expect(isNoisyIssueComment({ author: "Vercel[bot]", body: "deployment ready" })).toBe(true);
    expect(isNoisyIssueComment({ author: "mintlify", body: "docs preview" })).toBe(true);
    expect(isNoisyIssueComment({ author: "mintlify[bot]", body: "docs preview" })).toBe(true);
  });

  it("matches each noise pattern regardless of surrounding text", () => {
    expect(isNoisyIssueComment({ author: "alice", body: "[vc]: preview link" })).toBe(true);
    expect(isNoisyIssueComment({ author: "alice", body: "see mintlify-preview.example.com" })).toBe(true);
    expect(isNoisyIssueComment({ author: "alice", body: "This is an auto-generated comment from CI" })).toBe(true);
    expect(isNoisyIssueComment({ author: "alice", body: "Pre-merge checks passed" })).toBe(true);
    expect(isNoisyIssueComment({ author: "alice", body: "Thanks for using [CodeRabbit] reviews" })).toBe(true);
    expect(isNoisyIssueComment({ author: "alice", body: "<!-- Internal State: foo -->" })).toBe(true);
    expect(isNoisyIssueComment({ author: "alice", body: "## Walkthrough\nhere is the summary" })).toBe(true);
    expect(isNoisyIssueComment({ author: "alice", body: "Please @codex review this diff" })).toBe(true);
  });

  it("returns false for normal human comments", () => {
    expect(isNoisyIssueComment({ author: "alice", body: "Please rename this variable" })).toBe(false);
  });
});

describe("isActionableIssueComment", () => {
  it("requires source==='issue' and non-noisy content", () => {
    expect(isActionableIssueComment(makeComment({ source: "issue", body: "real feedback" }))).toBe(true);
  });

  it("rejects review-sourced comments even if non-noisy", () => {
    expect(isActionableIssueComment(makeComment({ source: "review", body: "real feedback" }))).toBe(false);
  });

  it("rejects issue comments that match noise patterns", () => {
    expect(isActionableIssueComment(makeComment({ source: "issue", author: "vercel", body: "preview ready" }))).toBe(false);
    expect(isActionableIssueComment(makeComment({ source: "issue", body: "" }))).toBe(false);
  });
});

describe("isIssueInventoryItemActionableForRound", () => {
  it("always returns true for items in the 'new' state regardless of type", () => {
    expect(isIssueInventoryItemActionableForRound(makeIssueItem({ state: "new", type: "review_thread" }))).toBe(true);
    expect(isIssueInventoryItemActionableForRound(makeIssueItem({ state: "new", type: "check_failure" }))).toBe(true);
    expect(isIssueInventoryItemActionableForRound(makeIssueItem({ state: "new", type: "issue_comment" }))).toBe(true);
  });

  it("returns true for sent_to_agent items of type check_failure or review_thread", () => {
    expect(
      isIssueInventoryItemActionableForRound(makeIssueItem({ state: "sent_to_agent", type: "check_failure" })),
    ).toBe(true);
    expect(
      isIssueInventoryItemActionableForRound(makeIssueItem({ state: "sent_to_agent", type: "review_thread" })),
    ).toBe(true);
  });

  it("returns false for sent_to_agent issue_comment items", () => {
    expect(
      isIssueInventoryItemActionableForRound(makeIssueItem({ state: "sent_to_agent", type: "issue_comment" })),
    ).toBe(false);
  });

  it("returns false for fixed/dismissed/escalated regardless of type", () => {
    expect(isIssueInventoryItemActionableForRound(makeIssueItem({ state: "fixed", type: "check_failure" }))).toBe(false);
    expect(isIssueInventoryItemActionableForRound(makeIssueItem({ state: "dismissed", type: "review_thread" }))).toBe(false);
    expect(isIssueInventoryItemActionableForRound(makeIssueItem({ state: "escalated", type: "check_failure" }))).toBe(false);
  });
});

describe("getPrIssueResolutionAvailability", () => {
  it("counts failing checks, pending checks, actionable threads and comments", () => {
    const checks: PrCheck[] = [
      makeCheck({ name: "a", status: "completed", conclusion: "failure" }),
      makeCheck({ name: "b", status: "completed", conclusion: "cancelled" }),
      makeCheck({ name: "c", status: "completed", conclusion: "success" }),
      makeCheck({ name: "d", status: "in_progress", conclusion: null }),
    ];
    const threads: PrReviewThread[] = [
      makeReviewThread({ id: "t1", isResolved: false, isOutdated: false }),
      makeReviewThread({ id: "t2", isResolved: true, isOutdated: false }),
      makeReviewThread({ id: "t3", isResolved: false, isOutdated: true }),
    ];
    const comments: PrComment[] = [
      makeComment({ id: "c1", source: "issue", body: "real" }),
      makeComment({ id: "c2", source: "issue", body: "" }),
      makeComment({ id: "c3", source: "review", body: "also real" }),
    ];

    const availability = getPrIssueResolutionAvailability(checks, threads, comments);
    expect(availability.failingCheckCount).toBe(2);
    expect(availability.pendingCheckCount).toBe(1);
    expect(availability.actionableReviewThreadCount).toBe(1);
    expect(availability.actionableIssueCommentCount).toBe(1);
    // Pending checks present so hasActionableChecks is false
    expect(availability.hasActionableChecks).toBe(false);
    expect(availability.hasActionableComments).toBe(true);
    expect(availability.hasAnyActionableIssues).toBe(true);
  });

  it("marks hasActionableChecks true only when failing>0 and no pending checks", () => {
    const checks = [makeCheck({ status: "completed", conclusion: "failure" })];
    const availability = getPrIssueResolutionAvailability(checks, [], []);
    expect(availability.failingCheckCount).toBe(1);
    expect(availability.pendingCheckCount).toBe(0);
    expect(availability.hasActionableChecks).toBe(true);
    expect(availability.hasAnyActionableIssues).toBe(true);
  });

  it("defaults issueComments to [] when omitted", () => {
    const availability = getPrIssueResolutionAvailability([], []);
    expect(availability.actionableIssueCommentCount).toBe(0);
    expect(availability.hasActionableComments).toBe(false);
    expect(availability.hasAnyActionableIssues).toBe(false);
  });

  it("returns all-zero/false availability for empty inputs", () => {
    const availability = getPrIssueResolutionAvailability([], [], []);
    expect(availability).toEqual({
      failingCheckCount: 0,
      pendingCheckCount: 0,
      actionableReviewThreadCount: 0,
      actionableIssueCommentCount: 0,
      hasActionableChecks: false,
      hasActionableComments: false,
      hasAnyActionableIssues: false,
    });
  });
});

describe("defaultPrIssueResolutionScope", () => {
  function makeAvailability(
    overrides: Partial<PrIssueResolutionAvailability> = {},
  ): PrIssueResolutionAvailability {
    return {
      failingCheckCount: 0,
      pendingCheckCount: 0,
      actionableReviewThreadCount: 0,
      actionableIssueCommentCount: 0,
      hasActionableChecks: false,
      hasActionableComments: false,
      hasAnyActionableIssues: false,
      ...overrides,
    };
  }

  it("returns 'both' when checks and comments are both actionable", () => {
    expect(
      defaultPrIssueResolutionScope(
        makeAvailability({
          hasActionableChecks: true,
          hasActionableComments: true,
          hasAnyActionableIssues: true,
        }),
      ),
    ).toBe("both");
  });

  it("returns 'comments' when only comments are actionable", () => {
    expect(
      defaultPrIssueResolutionScope(
        makeAvailability({
          hasActionableChecks: false,
          hasActionableComments: true,
          hasAnyActionableIssues: true,
        }),
      ),
    ).toBe("comments");
  });

  it("returns 'checks' when only checks are actionable", () => {
    expect(
      defaultPrIssueResolutionScope(
        makeAvailability({
          hasActionableChecks: true,
          hasActionableComments: false,
          hasAnyActionableIssues: true,
        }),
      ),
    ).toBe("checks");
  });

  it("returns null when nothing is actionable", () => {
    expect(defaultPrIssueResolutionScope(makeAvailability())).toBeNull();
  });
});
