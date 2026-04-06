import type {
  ReviewEventPayload,
  ReviewLaunchContext,
  ReviewListRunsArgs,
  ReviewRun,
  ReviewRunDetail,
  ReviewStartRunArgs,
} from "./reviewTypes";

type ReviewBridge = {
  listRuns: (args?: ReviewListRunsArgs) => Promise<ReviewRun[]>;
  getRunDetail: (runId: string) => Promise<ReviewRunDetail | null>;
  startRun: (args: ReviewStartRunArgs) => Promise<{ runId?: string; id?: string } | ReviewRunDetail | string | null>;
  rerun: (runId: string) => Promise<{ runId?: string; id?: string } | ReviewRunDetail | string | null>;
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
  return bridge.listRuns(args).catch(() => []);
}

export async function getReviewRunDetail(runId: string): Promise<ReviewRunDetail | null> {
  const bridge = getReviewBridge();
  if (!bridge) return null;
  return bridge.getRunDetail(runId).catch(() => null);
}

export async function startReviewRun(args: ReviewStartRunArgs): Promise<{ runId: string | null }> {
  const bridge = getReviewBridge();
  if (!bridge) return { runId: null };
  const result = await bridge.startRun(args).catch(() => null);
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
  const result = await bridge.rerun(runId).catch(() => null);
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
  return bridge.listLaunchContext().catch(() => null);
}

export function onReviewEvent(listener: (event: ReviewEventPayload) => void): () => void {
  const bridge = getReviewBridge();
  if (!bridge) return () => {};
  return bridge.onEvent(listener);
}
