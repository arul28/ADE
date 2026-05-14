import type { PrCheck, PrComment, PrIssueResolutionScope, PrReviewThread } from "./types";

export type PrIssueResolutionAvailability = {
  failingCheckCount: number;
  pendingCheckCount: number;
  actionableReviewThreadCount: number;
  actionableIssueCommentCount: number;
  actionableCommentCount: number;
  hasActionableChecks: boolean;
  hasActionableComments: boolean;
  hasAnyActionableIssues: boolean;
};

const NOISY_ISSUE_COMMENT_AUTHORS = new Set(["vercel", "vercel[bot]", "mintlify", "mintlify[bot]"]);

const NOISY_ISSUE_COMMENT_PATTERNS = [
  /\[vc\]:/i,
  /mintlify-preview/i,
  /this is an auto-generated comment/i,
  /<!--\s*capy:auto-review-spend-limit\s*-->/i,
  /\bcapy auto-review is paused\b/i,
  /pre-merge checks/i,
  /thanks for using \[coderabbit\]/i,
  /<!-- internal state/i,
  /walkthrough/i,
  /@codex review/i,
  /^@(copilot|coderabbitai|greptile|codex)\s+review\b/i,
  /\bship-lane handoff\b/i,
  /\bclear-to-merge\b/i,
  /\bci green\b/i,
];

export function isActionablePrIssueComment(comment: PrComment): boolean {
  if (comment.source !== "issue") return false;
  const author = comment.author.trim().toLowerCase();
  const body = (comment.body ?? "").trim();
  if (!body) return false;
  if (NOISY_ISSUE_COMMENT_AUTHORS.has(author)) return false;
  return !NOISY_ISSUE_COMMENT_PATTERNS.some((pattern) => pattern.test(body));
}

export function getPrIssueResolutionAvailability(
  checks: PrCheck[],
  reviewThreads: PrReviewThread[],
  issueComments: PrComment[] = [],
): PrIssueResolutionAvailability {
  const failingCheckCount = checks.filter((check) => check.conclusion === "failure").length;
  const pendingCheckCount = checks.filter((check) => check.status !== "completed").length;
  const actionableReviewThreadCount = reviewThreads.filter((thread) => !thread.isResolved && !thread.isOutdated).length;
  const actionableIssueCommentCount = issueComments.filter(isActionablePrIssueComment).length;
  const actionableCommentCount = actionableReviewThreadCount + actionableIssueCommentCount;
  const hasActionableChecks = failingCheckCount > 0 && pendingCheckCount === 0;
  const hasActionableComments = actionableCommentCount > 0;
  return {
    failingCheckCount,
    pendingCheckCount,
    actionableReviewThreadCount,
    actionableIssueCommentCount,
    actionableCommentCount,
    hasActionableChecks,
    hasActionableComments,
    hasAnyActionableIssues: hasActionableChecks || hasActionableComments,
  };
}

export function defaultPrIssueResolutionScope(
  availability: PrIssueResolutionAvailability,
): PrIssueResolutionScope | null {
  if (availability.hasActionableChecks && availability.hasActionableComments) return "both";
  if (availability.hasActionableComments) return "comments";
  if (availability.hasActionableChecks) return "checks";
  return null;
}
