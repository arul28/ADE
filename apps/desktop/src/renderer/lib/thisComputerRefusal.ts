import type { ThisMachineRefusal } from "../../shared/accountMachineRefusal";
import type { ReconnectOutcome } from "../../shared/reconnectOutcome";
import type { AccountDeviceLoginPrompt } from "./accountLogin";

/**
 * What ADE says when the account directory refuses THIS computer, and what the
 * "Reconnect this computer" action says at each step.
 *
 * The shell banner, the Account page card and the Connections pane all say it,
 * from these functions, so they can never disagree about the date or the next
 * step. The person is signed in here: the words are "Reconnect this computer"
 * and "Confirm it's you", never "Sign in again". The flow that runs the action
 * is `reconnectThisComputer.ts`.
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

/** What a surface renders for the reconnect action: one button and one line. */
export type ReconnectActionView = {
  label: string;
  onClick: () => void;
  disabled: boolean;
  /**
   * The line beside the button: the browser code, the reason an attempt
   * failed, or else the surface's own detail.
   */
  detail?: string;
  /** An attempt is running (a spinner is fine here). */
  busy: boolean;
  /** The button cancels the browser step instead of starting an attempt. */
  cancels: boolean;
};

/**
 * Derive the button from the flow. The surface gives only its idle label and
 * detail (the refusal copy, or the card's own); every other state reads the
 * same everywhere: "Cancel" with the browser code during the browser step,
 * a disabled "Reconnecting…" while the attempt runs, and after a failure the
 * idle button again with the reason as the detail.
 */
export function reconnectActionView(
  flow: { reconnecting: boolean; signInPrompt: AccountDeviceLoginPrompt | null; outcome: ReconnectOutcome | null },
  idle: { label: string; detail?: string },
  handlers: { reconnect: () => void; cancel: () => void },
): ReconnectActionView {
  if (flow.signInPrompt) {
    return {
      label: "Cancel",
      onClick: handlers.cancel,
      disabled: false,
      detail: reconnectBrowserPromptText(flow.signInPrompt.userCode),
      busy: true,
      cancels: true,
    };
  }
  if (flow.reconnecting) {
    return { label: "Reconnecting…", onClick: () => undefined, disabled: true, detail: idle.detail, busy: true, cancels: false };
  }
  // A failed attempt keeps the button and says why, so no surface dead-ends
  // on the brain's reason.
  const failure = flow.outcome && flow.outcome.tone !== "success" ? flow.outcome.message : null;
  return {
    label: idle.label,
    onClick: handlers.reconnect,
    disabled: false,
    detail: failure ?? idle.detail,
    busy: false,
    cancels: false,
  };
}
