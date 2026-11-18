import { useEffect, useSyncExternalStore } from "react";
import { isTourOpen, onboardingSettledBeforeThisLaunch, subscribeOnboardingProgress } from "./onboardingProgress";
import { markUnaskedShown, subscribeUnaskedBudget, unaskedAllowed } from "./unaskedBudget";

/**
 * The sidebar nudges ("Star ADE on GitHub", "Invite friends") under the
 * shared unasked budget. A new showing waits until onboarding ended on an
 * earlier launch, a new account's quiet days passed, and nothing else
 * unasked showed today; showing spends the day's budget. A showing already
 * up stays up (it is a quiet banner the person can dismiss), except while
 * onboarding still has this launch.
 */

function subscribe(listener: () => void): () => void {
  const offBudget = subscribeUnaskedBudget(listener);
  const offOnboarding = subscribeOnboardingProgress(listener);
  return () => {
    offBudget();
    offOnboarding();
  };
}

/** 0: hidden (onboarding still has this launch), 1: only a showing already up, 2: a new showing too. */
const nudgeRoom = () => (!onboardingSettledBeforeThisLaunch() ? 0 : unaskedAllowed() ? 2 : 1);

/**
 * Whether a nudge the schedule would show may show now. `newShowing`: this
 * showing was not on screen yet (the schedule's `shownDue`).
 */
export function useUnaskedNudge(scheduled: boolean, newShowing: boolean): boolean {
  const room = useSyncExternalStore(subscribe, nudgeRoom, nudgeRoom);
  const show = scheduled && room > 0 && (!newShowing || room === 2);
  useEffect(() => {
    if (show && newShowing) markUnaskedShown();
  }, [show, newShowing]);
  return show;
}

const tourOpenNow = () => isTourOpen();

/** Whether the guided tour is running: helpers that compete with its cards wait for it. */
export function useTourOpen(): boolean {
  return useSyncExternalStore(subscribeOnboardingProgress, tourOpenNow, tourOpenNow);
}
