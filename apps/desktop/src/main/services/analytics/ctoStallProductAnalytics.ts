import type { FeatureAnalytics } from "./featureProductAnalytics";

/** One fact per outcome an hour: nudges are minutes apart, and the question is whether they happen at all. */
const CTO_STALL_ANALYTICS_DEDUPE_MS = 60 * 60_000;

/**
 * What the CTO stall judge did, from the brain that runs the CTO:
 * `cto_stall_nudge` `completed` (the CTO was woken about a stuck chat it
 * started) or `failed` (the CTO refused the wake); `cto_need` `started` (the
 * CTO handed a stuck chat to the person with a "Waiting on you" line).
 * Never the chat, its title, the line, the stall kind, or the child's words.
 */
export function reportCtoStall(
  analytics: FeatureAnalytics | null | undefined,
  action: "cto_stall_nudge" | "cto_need",
  outcome: "completed" | "failed" | "started",
): void {
  analytics?.captureInternal({
    event: "ade_feature_used",
    surface: "api",
    // The judge and the CTO act unattended: measured, never counted as a person using ADE.
    properties: { feature: "cto", action, outcome, mode: "automatic" },
    dedupeKey: `${action}:${outcome}`,
    minimumIntervalMs: CTO_STALL_ANALYTICS_DEDUPE_MS,
  });
}
