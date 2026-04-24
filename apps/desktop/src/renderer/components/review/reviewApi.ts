import type {
  ReviewEventPayload,
  ReviewFeedbackRecord,
  ReviewLaunchContext,
  ReviewListRunsArgs,
  ReviewListSuppressionsArgs,
  ReviewQualityReport,
  ReviewRecordFeedbackArgs,
  ReviewRun,
  ReviewRunDetail,
  ReviewStartRunArgs,
  ReviewSuppression,
} from "./reviewTypes";

type ReviewBridge = {
  listRuns: (args?: ReviewListRunsArgs) => Promise<ReviewRun[]>;
  getRunDetail: (runId: string) => Promise<ReviewRunDetail | null>;
  startRun: (args: ReviewStartRunArgs) => Promise<{ runId?: string; id?: string } | ReviewRunDetail | string | null>;
  rerun: (runId: string) => Promise<{ runId?: string; id?: string } | ReviewRunDetail | string | null>;
  cancelRun?: (runId: string) => Promise<ReviewRun | null>;
  recordFeedback?: (args: ReviewRecordFeedbackArgs) => Promise<ReviewFeedbackRecord>;
  listSuppressions?: (args?: ReviewListSuppressionsArgs) => Promise<ReviewSuppression[]>;
  deleteSuppression?: (suppressionId: string) => Promise<boolean>;
  qualityReport?: () => Promise<ReviewQualityReport>;
  listLaunchContext: () => Promise<ReviewLaunchContext | null>;
  onEvent: (listener: (event: ReviewEventPayload) => void) => () => void;
};

function getReviewBridge(): ReviewBridge | null {
  const bridge = (window as Window & { ade?: { review?: ReviewBridge } }).ade?.review ?? null;
  return bridge ?? null;
}

export async function listReviewRuns(args?: ReviewListRunsArgs): Promise<ReviewRun[]> {
  const bridge = getReviewBridge();
  if (!bridge) return [];
  return bridge.listRuns(args);
}

export async function getReviewRunDetail(runId: string): Promise<ReviewRunDetail | null> {
  const bridge = getReviewBridge();
  if (!bridge) return null;
  return bridge.getRunDetail(runId);
}

export async function startReviewRun(args: ReviewStartRunArgs): Promise<{ runId: string | null }> {
  const bridge = getReviewBridge();
  if (!bridge) return { runId: null };
  const result = await bridge.startRun(args);
  if (typeof result === "string") return { runId: result };
  if (result && typeof result === "object") {
    const maybe = result as { runId?: string; id?: string };
    return { runId: maybe.runId ?? maybe.id ?? null };
  }
  return { runId: null };
}

export async function rerunReview(runId: string): Promise<{ runId: string | null }> {
  const bridge = getReviewBridge();
  if (!bridge) return { runId: null };
  const result = await bridge.rerun(runId);
  if (typeof result === "string") return { runId: result };
  if (result && typeof result === "object") {
    const maybe = result as { runId?: string; id?: string };
    return { runId: maybe.runId ?? maybe.id ?? null };
  }
  return { runId: null };
}

export async function listReviewLaunchContext(): Promise<ReviewLaunchContext | null> {
  const bridge = getReviewBridge();
  if (!bridge) return null;
  return bridge.listLaunchContext();
}

export function onReviewEvent(listener: (event: ReviewEventPayload) => void): () => void {
  const bridge = getReviewBridge();
  if (!bridge) return () => {};
  return bridge.onEvent(listener);
}

export async function cancelReviewRun(runId: string): Promise<ReviewRun | null> {
  const bridge = getReviewBridge();
  if (!bridge?.cancelRun) return null;
  return bridge.cancelRun(runId);
}

export async function recordReviewFeedback(
  args: ReviewRecordFeedbackArgs,
): Promise<ReviewFeedbackRecord | null> {
  const bridge = getReviewBridge();
  if (!bridge?.recordFeedback) return null;
  return bridge.recordFeedback(args);
}

export async function listReviewSuppressions(
  args?: ReviewListSuppressionsArgs,
): Promise<ReviewSuppression[]> {
  const bridge = getReviewBridge();
  if (!bridge?.listSuppressions) return [];
  return bridge.listSuppressions(args);
}

export async function deleteReviewSuppression(suppressionId: string): Promise<boolean> {
  const bridge = getReviewBridge();
  if (!bridge?.deleteSuppression) return false;
  return bridge.deleteSuppression(suppressionId);
}

export async function fetchReviewQualityReport(): Promise<ReviewQualityReport | null> {
  const bridge = getReviewBridge();
  if (!bridge?.qualityReport) return null;
  return bridge.qualityReport();
}
