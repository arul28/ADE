import type { ThisMachineRefusal } from "../../shared/accountMachineRefusal";
import type { AdeAccountMachinePairingRepairResult } from "../../shared/types";
import { ADE_ACCOUNT_PAIRING_AUTHENTICATION_REQUIRED_CODE } from "../../shared/types/account";
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

/** What the user is told after a reconnect attempt, and how it is styled. */
export type ReconnectOutcome = { tone: "success" | "warning" | "danger"; message: string };

/** Join the brain's reason onto our sentence without doubling its punctuation. */
function sentence(reason: string): string {
  const trimmed = reason.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Turn a repair result into copy that stays true to what actually happened.
 *
 * Read against `repairMachinePairing` in ade-cli, not by intuition:
 * `published` is true only on the path that also sets `repaired`, and a
 * successful re-pair reports `pushRestored: false` whenever the push half was
 * never gated — so `!pushRestored` on its own does NOT mean "still muted".
 *
 * The state that does mean it is `repaired && wasRevoked && !pushRestored`:
 * something was gated, the directory took the machine back, and the push
 * revocation did not lift with it. That machine is on the roster and silent —
 * the exact failure the ade-cli side refuses to paper over — so it must not be
 * reported as a clean reconnect.
 */
export function describeReconnectOutcome(
  result: AdeAccountMachinePairingRepairResult,
): ReconnectOutcome {
  if (result.repaired) {
    if (!result.wasRevoked) {
      return { tone: "success", message: "This computer is already connected to your account." };
    }
    return result.pushRestored
      ? {
          tone: "success",
          message: "This computer is back on your account. Activity and alerts are delivering again.",
        }
      : {
          tone: "warning",
          message:
            "This computer is back on your account, but it isn't delivering Activity yet. Reopen ADE on this computer to finish.",
        };
  }
  // Nothing was gated and the brain skipped the publish — no work to report.
  if (result.state === "not_revoked") {
    return { tone: "success", message: "This computer is already connected to your account." };
  }
  return {
    tone: "danger",
    message: result.reason
      ? `Couldn't reconnect this computer: ${sentence(result.reason)} It's still disconnected from your account.`
      : "Couldn't reconnect this computer, so it's still disconnected from your account. Try again in a moment.",
  };
}

/**
 * Does this failed reconnect mean "prove a fresh sign-in", rather than a
 * transport, configuration, or brain-availability failure?
 *
 * Decided by `reasonCode`, the brain's machine-readable answer. Both refusals
 * still share `state: "http_error"`, but they no longer share a discriminator:
 * `pairing_authentication_required` is the recoverable one, and a present code
 * is authoritative — `machine_revoked` means the sentence must NOT be consulted
 * to talk us into a sign-in the directory did not ask for.
 *
 * Fails CLOSED: an unrecognised or absent answer reports the brain's reason
 * as-is rather than dragging the user into a browser sign-in that would not
 * have fixed anything.
 */
export function reconnectNeedsFreshSignIn(
  result: AdeAccountMachinePairingRepairResult,
): boolean {
  if (result.repaired) return false;
  if (result.reasonCode) {
    return result.reasonCode === ADE_ACCOUNT_PAIRING_AUTHENTICATION_REQUIRED_CODE;
  }
  // COMPATIBILITY SHIM — older brain only.
  //
  // Brains before `reasonCode` existed encoded this refusal solely in the
  // user-facing sentence `PAIRING_REAUTHENTICATION_REQUIRED_MESSAGE` (see
  // `apps/ade-cli/src/services/account/accountMachinePublisherService.ts`; the
  // renderer cannot import that module because it pulls in Node, so a test pins
  // the two together). Matched loosely so small copy edits in those already-
  // shipped builds do not break their recovery path.
  //
  // Delete this branch — and the test that pins the sentence — once the
  // supported brain floor includes `reasonCode`.
  return /\bsign in\b[\s\S]*\bagain on this computer\b/i.test(result.reason ?? "");
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
