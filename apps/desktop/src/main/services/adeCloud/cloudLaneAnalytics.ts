/**
 * Product analytics for ADE Cloud lanes (feature "connections"): how a new
 * lane on its own computer ends, a freed lane and a cache clear. One coarse
 * outcome each; never the lane, project, computer,
 * branch, prompt or an error (productAnalyticsPolicy.ts allows only these).
 */
import type { ChatLaunchEvent } from "../../../shared/types";
import type { ProductAnalyticsCapture } from "../../../shared/types/productAnalytics";

/** The analytics service, or nothing when this process has none. */
export type CloudLaneAnalyticsCapture = { capture(input: ProductAnalyticsCapture): unknown } | null | undefined;
type Surface = ProductAnalyticsCapture["surface"];

/** Sent from main. The renderer sends `cloud_default_size` itself (`cloudDefaultTier.ts`). */
export type CloudLaneAnalyticsAction = "cloud_lane_launch" | "cloud_lane_freed" | "cloud_clear_caches";

export function captureCloudLaneAnalytics(
  analytics: CloudLaneAnalyticsCapture,
  surface: Surface,
  action: CloudLaneAnalyticsAction,
  outcome: string,
): void {
  try {
    void Promise.resolve(analytics?.capture({
      event: "ade_feature_used",
      surface,
      properties: { feature: "connections", action, outcome },
      projectId: null,
    })).catch(() => undefined);
  } catch {
    // Analytics never stops the work it describes.
  }
}

/**
 * Wraps a launch host's `emit`: a launch's end (completed, failed, cancelled)
 * counts when this process saw it move there from another phase. A launch
 * that a restart loads already finished is not counted again; a failure that a
 * Retry fixes counts the failure, then the completion.
 */
export function cloudLaneLaunchOutcomes(analytics: CloudLaneAnalyticsCapture, surface: Surface): (event: ChatLaunchEvent) => void {
  const lastPhase = new Map<string, string>();
  return (event) => {
    if (event.type === "launch-removed") {
      lastPhase.delete(event.launchId);
      return;
    }
    const { launchId, phase } = event.launch;
    const before = lastPhase.get(launchId);
    lastPhase.set(launchId, phase);
    if (before === undefined || before === phase) return;
    if (phase === "completed" || phase === "failed" || phase === "cancelled") {
      captureCloudLaneAnalytics(analytics, surface, "cloud_lane_launch", phase);
    }
  };
}
