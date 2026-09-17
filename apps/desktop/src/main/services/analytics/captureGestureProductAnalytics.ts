import type { ProductAnalyticsService } from "./productAnalyticsService";

/**
 * Deduped by minute rather than per press: the product question is whether the
 * gesture works for an installation, and a user who fires it four times in a
 * row while something is broken is one fact, not four.
 */
const CAPTURE_GESTURE_ANALYTICS_DEDUPE_MS = 60_000;

export type CaptureGestureOutcome = "delivered" | "failed" | "too_large";

/**
 * One coarse fact per capture-gesture press.
 *
 * Called where the shot is delivered or refused, which is the only place that
 * knows whether the gesture actually worked — the renderer sees the result and
 * the helper sees the press, but neither sees both. Never the window, its
 * title, the app it belonged to, the temp path the PNG passed through, the
 * image, or the helper's error text.
 */
export function reportCaptureGesture(
  service: Pick<ProductAnalyticsService, "captureInternal"> | null | undefined,
  outcome: CaptureGestureOutcome,
): void {
  service?.captureInternal({
    event: "ade_feature_used",
    surface: "desktop",
    properties: { feature: "cto", action: "capture_gesture", outcome },
    dedupeKey: `capture_gesture:${outcome}`,
    minimumIntervalMs: CAPTURE_GESTURE_ANALYTICS_DEDUPE_MS,
  });
}
