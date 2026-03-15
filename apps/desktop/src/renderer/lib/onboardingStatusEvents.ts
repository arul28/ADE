import type { OnboardingStatus } from "../../shared/types";

export const ONBOARDING_STATUS_UPDATED_EVENT = "ade:onboarding-status-updated";

export function publishOnboardingStatusUpdated(status: OnboardingStatus): void {
  window.dispatchEvent(
    new CustomEvent<OnboardingStatus>(ONBOARDING_STATUS_UPDATED_EVENT, {
      detail: status,
    }),
  );
}
