import type { AdeAccountMachinePairingRepairResult } from "../../shared/types";
import { ADE_ACCOUNT_PAIRING_AUTHENTICATION_REQUIRED_CODE } from "../../shared/types/account";
import {
  runAccountDeviceLogin,
  type AccountDeviceLoginPrompt,
} from "./accountLogin";

/**
 * Reconnecting THIS machine to the signed-in account after the directory
 * removed it.
 *
 * The Account page owned this orchestration inline (the banner on `YourMacsCard`
 * and its row menu). The Machines popover needed the same repair with the same
 * busy/result handling, and duplicating the first-try/sign-in/verify sequence is
 * exactly how the two would drift, so it lives here once and both call it.
 */

/** What the user is told after a reconnect attempt, and how it is styled. */
export type MachinePairingReconnectOutcome = {
  tone: "success" | "warning" | "danger";
  message: string;
};

/**
 * What the caller found when it re-read its own view of the machine after a
 * completed sign-in. `unverified` is for surfaces (the Machines popover) that
 * have no directory roster to check against — they must not claim a repair the
 * sign-in alone did not prove.
 */
export type MachinePairingReconnectVerification =
  | "reconnected"
  | "still_missing"
  | "unverified";

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
): MachinePairingReconnectOutcome {
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

/**
 * Run one reconnect: try the re-pair; if the directory demands a fresh
 * interactive sign-in, run the DEVICE flow (the only flow the directory can
 * observe and therefore the only one that can mint the pairing grant a removed
 * machine needs) and let the caller re-read its view afterwards.
 *
 * Returns null when the attempt was cancelled — nothing to report.
 */
export async function runMachinePairingReconnect(deps: {
  repair: () => Promise<AdeAccountMachinePairingRepairResult>;
  /** Renders the in-flight sign-in prompt, or clears it with null. */
  onPrompt?: (prompt: AccountDeviceLoginPrompt | null) => void;
  /** Polled during the sign-in so the caller can abandon the flow. */
  isCancelled?: () => boolean;
  /**
   * Refresh the caller's own view of this machine. The return value is
   * consulted only after a completed sign-in; the direct-repair path has
   * already described its own outcome from the brain's result.
   */
  afterAttempt: () => Promise<MachinePairingReconnectVerification>;
}): Promise<MachinePairingReconnectOutcome | null> {
  try {
    const first = await deps.repair();
    if (!reconnectNeedsFreshSignIn(first)) {
      const outcome = describeReconnectOutcome(first);
      await deps.afterAttempt();
      return outcome;
    }
    const signIn = await runAccountDeviceLogin({
      onPrompt: (prompt) => deps.onPrompt?.(prompt),
      isCancelled: deps.isCancelled,
    });
    deps.onPrompt?.(null);
    if (signIn.status === "cancelled") return null;
    if (signIn.status === "failed") {
      return { tone: "danger", message: signIn.message };
    }
    const verification = await deps.afterAttempt();
    if (verification === "reconnected") {
      return {
        tone: "success",
        message: "This computer is back on your account. Activity and alerts are delivering again.",
      };
    }
    if (verification === "still_missing") {
      return {
        tone: "danger",
        message: "You're signed in, but this computer still isn't on your account. Try reconnecting it again.",
      };
    }
    // The surface has no roster to verify against; the brain re-pairs on its
    // own after an interactive sign-in, so state that rather than claim it.
    return { tone: "success", message: "Signed in — reconnecting this computer to your account." };
  } catch (err) {
    // Main already translated the brain's failure into a sentence; only a
    // truly unexpected throw reaches the fallback.
    return {
      tone: "danger",
      message: err instanceof Error && err.message
        ? err.message
        : "Couldn't reconnect this computer to your account. Try again in a moment.",
    };
  }
}
