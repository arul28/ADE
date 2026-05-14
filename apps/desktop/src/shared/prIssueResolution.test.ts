import { describe, expect, it } from "vitest";
import { getPrIssueResolutionAvailability, isActionablePrIssueComment } from "./prIssueResolution";
import type { PrComment } from "./types";

function issueComment(overrides: Partial<PrComment> = {}): PrComment {
  return {
    id: "issue-comment-1",
    author: "review-bot[bot]",
    authorAvatarUrl: null,
    body: "Please handle this regression.",
    source: "issue",
    url: null,
    path: null,
    line: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe("PR issue resolution availability", () => {
  it("counts actionable PR issue comments as comment work", () => {
    const availability = getPrIssueResolutionAvailability([], [], [
      issueComment(),
      issueComment({ id: "vercel", author: "vercel", body: "[vc]: preview update" }),
    ]);

    expect(availability).toMatchObject({
      actionableReviewThreadCount: 0,
      actionableIssueCommentCount: 1,
      actionableCommentCount: 1,
      hasActionableComments: true,
      hasAnyActionableIssues: true,
    });
  });

  it("filters noisy issue comments from resolver availability", () => {
    expect(isActionablePrIssueComment(issueComment({ author: "vercel", body: "[vc]: preview update" }))).toBe(false);
    expect(isActionablePrIssueComment(issueComment({ body: "This is an auto-generated comment: summarize by coderabbit.ai" }))).toBe(false);
    expect(isActionablePrIssueComment(issueComment({ body: "Human follow-up: this still needs a fix." }))).toBe(true);
  });
});
