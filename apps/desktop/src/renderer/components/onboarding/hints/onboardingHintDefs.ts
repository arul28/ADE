import type { OnboardingHintId } from "../../../onboarding/onboardingProgress";

/**
 * Contextual hints, shown when a moment calls for them after the guided tour.
 * A surface marks the control a hint points at with
 * `data-onboarding-anchor="<id>"`; the host finds it.
 *
 * - `sequential` hints show one after another: a later one waits until every
 *   earlier one is done, dismissed or used up.
 * - `doneOnClick`: clicking the anchor is the thing the hint asks for.
 */
export type OnboardingHintDef = {
  id: OnboardingHintId;
  title: string;
  line: string;
  sequential: boolean;
  doneOnClick: boolean;
};

export const ONBOARDING_HINTS: readonly OnboardingHintDef[] = [
  {
    // Shows whenever a chat actually needs the user and no other hint is up.
    id: "needs-you",
    title: "This chat needs you",
    line: "Chats waiting on you show up here, from every machine.",
    sequential: false,
    doneOnClick: true,
  },
];
