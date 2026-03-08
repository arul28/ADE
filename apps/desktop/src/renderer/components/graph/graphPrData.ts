import type { PrCheck, PrComment, PrReview, PrStatus, PrSummary } from "../../../shared/types";
import type { GraphPrOverlay } from "./graphTypes";

const ACTIVE_REVIEW_WINDOW_MS = 36 * 60 * 60 * 1000;
const STALE_PR_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

export type GraphPrDetailBundle = {
  status: PrStatus | null;
  checks: PrCheck[];
  reviews: PrReview[];
  comments: PrComment[];
};

function toTs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildGraphPrOverlay(args: {
  pr: PrSummary;
  baseLaneId: string;
  detail?: GraphPrDetailBundle | null;
  mergeInProgress: boolean;
}): GraphPrOverlay {
  const { pr, baseLaneId, detail, mergeInProgress } = args;
  const checks = detail?.checks ?? [];
  const reviews = detail?.reviews ?? [];
  const comments = detail?.comments ?? [];

  const ciSummary = {
    total: checks.length,
    passing: checks.filter((check) => check.conclusion === "success").length,
    failing: checks.filter((check) => check.conclusion === "failure" || check.conclusion === "cancelled").length,
    pending: checks.filter((check) => check.status === "queued" || check.status === "in_progress").length
  };
  const reviewCounts = {
    total: reviews.length,
    approved: reviews.filter((review) => review.state === "approved").length,
    changesRequested: reviews.filter((review) => review.state === "changes_requested").length,
    commented: reviews.filter((review) => review.state === "commented").length,
    pending: reviews.filter((review) => review.state === "pending").length
  };
  const commentCounts = {
    total: comments.length,
    issue: comments.filter((comment) => comment.source === "issue").length,
    review: comments.filter((comment) => comment.source === "review").length
  };

  const lastActivityAt = [
    pr.updatedAt,
    pr.lastSyncedAt,
    ...checks.flatMap((check) => [check.startedAt, check.completedAt]),
    ...reviews.map((review) => review.submittedAt),
    ...comments.flatMap((comment) => [comment.createdAt, comment.updatedAt])
  ]
    .map((value) => ({ value, ts: toTs(value) }))
    .sort((a, b) => b.ts - a.ts)[0]?.value ?? null;

  const lastActivityTs = toTs(lastActivityAt);
  const activeReview = pr.reviewStatus === "requested" || (lastActivityTs > 0 && Date.now() - lastActivityTs <= ACTIVE_REVIEW_WINDOW_MS);
  const stale = lastActivityTs > 0 ? Date.now() - lastActivityTs > STALE_PR_WINDOW_MS : false;

  return {
    prId: pr.id,
    laneId: pr.laneId,
    baseLaneId,
    number: pr.githubPrNumber,
    title: pr.title,
    url: pr.githubUrl,
    state: pr.state,
    checksStatus: pr.checksStatus,
    reviewStatus: pr.reviewStatus,
    lastSyncedAt: pr.lastSyncedAt ?? null,
    lastActivityAt,
    mergeInProgress,
    isMergeable: detail?.status?.isMergeable ?? null,
    mergeConflicts: detail?.status?.mergeConflicts ?? null,
    behindBaseBy: detail?.status?.behindBaseBy ?? null,
    reviewCount: reviewCounts.total,
    approvedCount: reviewCounts.approved,
    changeRequestCount: reviewCounts.changesRequested,
    commentCount: commentCounts.total,
    pendingCheckCount: ciSummary.pending,
    activityState: activeReview ? "active" : stale ? "stale" : "idle",
  };
}
