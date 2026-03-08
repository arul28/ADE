import type { PrCheck, PrComment, PrReview, PrStatus, PrSummary } from "../../../shared/types";
import { derivePrActivityState } from "../prs/shared/prVisuals";
import type { GraphPrOverlay } from "./graphTypes";

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
  const liveStatus = detail?.status;

  const pendingCheckCount = checks.filter((check) => check.status === "queued" || check.status === "in_progress").length;
  const approvedCount = reviews.filter((review) => review.state === "approved").length;
  const changeRequestCount = reviews.filter((review) => review.state === "changes_requested").length;

  const timestamps = [
    pr.updatedAt,
    pr.lastSyncedAt,
    ...checks.flatMap((check) => [check.startedAt, check.completedAt]),
    ...reviews.map((review) => review.submittedAt),
    ...comments.flatMap((comment) => [comment.createdAt, comment.updatedAt]),
  ];
  let lastActivityAt: string | null = null;
  let maxTs = 0;
  for (const value of timestamps) {
    const ts = toTs(value);
    if (ts > maxTs) {
      maxTs = ts;
      lastActivityAt = value ?? null;
    }
  }

  return {
    prId: pr.id,
    laneId: pr.laneId,
    baseLaneId,
    number: pr.githubPrNumber,
    title: pr.title,
    url: pr.githubUrl,
    state: liveStatus?.state ?? pr.state,
    checksStatus: liveStatus?.checksStatus ?? pr.checksStatus,
    reviewStatus: liveStatus?.reviewStatus ?? pr.reviewStatus,
    lastSyncedAt: pr.lastSyncedAt ?? null,
    lastActivityAt,
    mergeInProgress,
    isMergeable: liveStatus?.isMergeable ?? null,
    mergeConflicts: liveStatus?.mergeConflicts ?? null,
    behindBaseBy: liveStatus?.behindBaseBy ?? null,
    reviewCount: reviews.length,
    approvedCount,
    changeRequestCount,
    commentCount: comments.length,
    pendingCheckCount,
    activityState: derivePrActivityState({
      state: liveStatus?.state ?? pr.state,
      lastActivityAt,
      reviewStatus: liveStatus?.reviewStatus ?? pr.reviewStatus,
      pendingCheckCount,
    }),
  };
}
