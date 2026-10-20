import type { OnboardingHintId } from "../../../onboarding/onboardingProgress";

/**
 * The first-chat hints, in the order they show. A surface marks the control a
 * hint points at with `data-onboarding-anchor="<id>"`; the host finds it.
 *
 * - `sequential` hints show one after another: a later one waits until every
 *   earlier one is done, dismissed or used up.
 * - `doneOnClick`: clicking the anchor is the thing the hint asks for. The
 *   composer hint is done by typing "@" instead (`AgentChatComposer`).
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
    id: "new-chat",
    title: "Start a chat",
    line: "ADE gives each chat its own lane, a separate copy of your repo, so agents never collide.",
    sequential: true,
    doneOnClick: true,
  },
  {
    id: "composer-at",
    title: "Type @ to delegate",
    line: "Hand work to another model as a subagent, or send it to another machine.",
    sequential: true,
    doneOnClick: false,
  },
  {
    // Shows whenever a chat actually needs the user and no other hint is up.
    id: "needs-you",
    title: "This chat needs you",
    line: "Chats waiting on you show up here, from every machine.",
    sequential: false,
    doneOnClick: true,
  },
];
