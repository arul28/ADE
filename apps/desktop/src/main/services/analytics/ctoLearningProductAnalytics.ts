import type { FeatureAnalytics } from "./featureProductAnalytics";

/** One fact per action an hour: the question is whether the CTO learns and how often the person undoes it. */
const CTO_LEARNING_ANALYTICS_DEDUPE_MS = 60 * 60_000;

/**
 * The CTO learning loop, from the brain that owns the CTO chat:
 * `cto_learned` `completed` (a CTO turn saved a rule, skill or note and drew
 * a Learned row; unattended) or `cto_learned_undo` `completed` (the person
 * pressed Undo on one of its changes). Never the rule, skill, note, chat, or
 * how many changes the turn made.
 */
export function reportCtoLearning(
  analytics: FeatureAnalytics | null | undefined,
  action: "cto_learned" | "cto_learned_undo",
): void {
  analytics?.captureInternal({
    event: "ade_feature_used",
    surface: "api",
    properties: {
      feature: "cto",
      action,
      outcome: "completed",
      // The CTO learns on its own: measured, never counted as a person using ADE.
      ...(action === "cto_learned" ? { mode: "automatic" } : {}),
    },
    dedupeKey: `${action}:completed`,
    minimumIntervalMs: CTO_LEARNING_ANALYTICS_DEDUPE_MS,
  });
}

/**
 * A CTO open-work item closed itself because the chat or PR it was linked to
 * finished: `cto_work_auto_closed` `completed`, unattended. The question is
 * whether linked work closes on its own. Never the item, its title, the chat,
 * the PR, or how many closed at once.
 */
export function reportCtoWorkAutoClosed(analytics: FeatureAnalytics | null | undefined): void {
  analytics?.captureInternal({
    event: "ade_feature_used",
    surface: "api",
    properties: { feature: "cto", action: "cto_work_auto_closed", outcome: "completed", mode: "automatic" },
    dedupeKey: "cto_work_auto_closed:completed",
    minimumIntervalMs: CTO_LEARNING_ANALYTICS_DEDUPE_MS,
  });
}
