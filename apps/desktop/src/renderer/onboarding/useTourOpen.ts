import { useSyncExternalStore } from "react";
import { isTourOpen, subscribeOnboardingProgress } from "./onboardingProgress";

const tourOpenNow = () => isTourOpen();

/** Whether the guided tour is running: helpers that compete with its cards (sidebar nudges, the import pill) wait for it. */
export function useTourOpen(): boolean {
  return useSyncExternalStore(subscribeOnboardingProgress, tourOpenNow, tourOpenNow);
}
