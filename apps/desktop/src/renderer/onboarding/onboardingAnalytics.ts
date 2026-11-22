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
  | "onboarding_projects_shown"
  | "onboarding_completed"
  | "onboarding_skipped"
  | "onboarding_tour_completed"
  | "onboarding_tour_skipped";

function onboardingOutcome(action: OnboardingAction): "opened" | "completed" | "cancelled" {
  if (action === "onboarding_completed" || action === "onboarding_tour_completed") return "completed";
  return action === "onboarding_skipped" || action === "onboarding_tour_skipped" ? "cancelled" : "opened";
}

export function captureOnboarding(action: OnboardingAction): void {
  const reportFailed = () => console.warn("[onboarding] step could not be reported", action);
  try {
    void window.ade?.analytics?.capture({
      event: "ade_feature_used",
      properties: { feature: "onboarding", action, outcome: onboardingOutcome(action), source: "renderer_route" },
      dedupeKey: `onboarding:${action}`,
      minimumIntervalMs: 24 * 60 * 60_000,
    }).catch(reportFailed);
  } catch {
    // Reporting must never block onboarding.
    reportFailed();
  }
}
