import type { ThisMachineRefusal } from "../../shared/accountMachineRefusal";

/**
 * What ADE says when the account directory refuses THIS computer.
 *
 * The shell banner, the Account page card and the Connections pane all say it,
 * from this one function, so the three can never disagree about the date or
 * the next step. The person is signed in here: the words are "Reconnect this
 * computer" and "Confirm it's you", never "Sign in again".
 */
export type ThisComputerRefusalCopy = {
  title: string;
  detail: string;
  /** The label of the button that runs `useReconnectThisComputer`. */
  action: string;
};

/** "14 August", with the year only when it is not this year. Null for a bad date. */
export function formatRemovalDate(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

const GAVE_UP_SENTENCE = "ADE stopped trying to reconnect it on its own.";

export function describeThisComputerRefusal(
  refusal: ThisMachineRefusal,
  now: Date = new Date(),
): ThisComputerRefusalCopy {
  const removedOn = formatRemovalDate(refusal.revokedAt, now);
  const gaveUp = refusal.recoveryGaveUpAt != null;
  if (refusal.code === "pairing_authentication_required") {
    return {
      title: "This computer needs you to confirm it's you before it can rejoin your account",
      detail: [
        removedOn ? `It was removed from your account on ${removedOn}.` : null,
        gaveUp ? GAVE_UP_SENTENCE : "Your other devices can't reach it until you do.",
      ].filter(Boolean).join(" "),
      action: "Confirm it's you",
    };
  }
  return {
    title: removedOn
      ? `This computer was removed from your account on ${removedOn}`
      : "This computer was removed from your account",
    detail: gaveUp
      ? `Your other devices can't reach it. ${GAVE_UP_SENTENCE}`
      : "Your other devices can't reach it, and it doesn't send Activity or alerts.",
    action: "Reconnect this computer",
  };
}

/** The line shown while the browser step of a reconnect is open. */
export function reconnectBrowserPromptText(userCode: string): string {
  return `Confirm it's you in your browser. If the page asks for a code, enter ${userCode}.`;
}
