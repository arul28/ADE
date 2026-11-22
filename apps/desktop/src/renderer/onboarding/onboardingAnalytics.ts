/**
 * Onboarding facts for product analytics (`ade_feature_used`, feature
 * "onboarding"): each first-run card as it shows, how setup ended, and how the
 * in-project tour ended. At most one of each a day per install; reporting never
 * changes what onboarding does. Never what the person picked, an account, a
 * provider or a project.
 */
export type OnboardingAction =
  | "onboarding_welcome_shown"
  | "onboarding_sign_in_shown"
  | "onboarding_agents_shown"
  | "onboarding_agents_done"
  | "onboarding_projects_shown"
  | "onboarding_completed"
  | "onboarding_skipped"
  | "onboarding_tour_completed"
  | "onboarding_tour_skipped";

function onboardingOutcome(action: OnboardingAction): "opened" | "completed" | "cancelled" {
  if (action === "onboarding_completed" || action === "onboarding_tour_completed" || action === "onboarding_agents_done") return "completed";
  return action === "onboarding_skipped" || action === "onboarding_tour_skipped" ? "cancelled" : "opened";
}

/** A count as PostHog's closed `count_bucket` labels. */
export type CountBucket = "0" | "1" | "2_5" | "6_plus";

/** How many agents were connected, bucketed like every other count. */
export function onboardingCountBucket(count: number): CountBucket {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  return count <= 5 ? "2_5" : "6_plus";
}

export function captureOnboarding(action: OnboardingAction, extra?: { count_bucket: CountBucket }): void {
  const reportFailed = () => console.warn("[onboarding] step could not be reported", action);
  try {
    void window.ade?.analytics?.capture({
      event: "ade_feature_used",
      properties: { feature: "onboarding", action, outcome: onboardingOutcome(action), source: "renderer_route", ...extra },
      dedupeKey: `onboarding:${action}`,
      minimumIntervalMs: 24 * 60 * 60_000,
    }).catch(reportFailed);
  } catch {
    // Reporting must never block onboarding.
    reportFailed();
  }
}
