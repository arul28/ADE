import type { PrCheck, PrIssueResolutionScope, PrReviewThread } from "./types";

export type PrIssueResolutionAvailability = {
  failingCheckCount: number;
  pendingCheckCount: number;
  actionableReviewThreadCount: number;
  hasActionableChecks: boolean;
  hasActionableComments: boolean;
  hasAnyActionableIssues: boolean;
};

export function getPrIssueResolutionAvailability(
  checks: PrCheck[],
  reviewThreads: PrReviewThread[],
): PrIssueResolutionAvailability {
  const failingCheckCount = checks.filter((check) => check.conclusion === "failure").length;
  const pendingCheckCount = checks.filter((check) => check.status !== "completed").length;
  const actionableReviewThreadCount = reviewThreads.filter((thread) => !thread.isResolved && !thread.isOutdated).length;
  const hasActionableChecks = failingCheckCount > 0 && pendingCheckCount === 0;
  const hasActionableComments = actionableReviewThreadCount > 0;
  return {
    failingCheckCount,
    pendingCheckCount,
    actionableReviewThreadCount,
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
