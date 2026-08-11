import type { AdeUsageScope } from "../../../shared/types/usage";
import type { ProductAnalyticsCapture } from "../../../shared/types/productAnalytics";

/**
 * How long one scope must stay quiet before it is worth reporting again.
 *
 * The Usage page re-reads `getAdeUsageStats` on every `usage.onUpdate`, on
 * every range change and on every remount, so the boundary is hit far more
 * often than the user makes a decision. A full day per scope turns that stream
 * into the fact actually worth having — "this installation looked at account
 * scope today" — and makes a per-poll event impossible by construction.
 */
export const USAGE_SCOPE_ANALYTICS_MIN_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/**
 * One coarse adoption fact per usage scope per UTC day.
 *
 * The product question is whether anyone uses cross-machine ("account") usage
 * at all; nothing finer is needed to answer it. The payload is therefore the
 * scope enum and nothing else — no machine count, no machine key, no project
 * path, no token or cost totals, no range preset. Worst case is three accepted
 * events per installation per UTC day (one per scope), well inside the
 * `ade_feature_used` 140-per-day / 30-per-minute limits and the shared
 * 200-event ceiling; no ceiling was raised for it.
 */
export function usageScopeSelectedCapture(scope: AdeUsageScope): ProductAnalyticsCapture {
  return {
    event: "ade_feature_used",
    surface: "desktop",
    properties: { feature: "usage", action: "scope_selected", outcome: scope },
    projectId: null,
    // Local-only fingerprint, hashed by the service before anything is sent.
    dedupeKey: `usage_scope:${scope}`,
    minimumIntervalMs: USAGE_SCOPE_ANALYTICS_MIN_INTERVAL_MS,
  };
}
