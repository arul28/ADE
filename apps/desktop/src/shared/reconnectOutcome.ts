import type { AdeAccountMachinePairingRepairResult } from "./types";
import { ADE_ACCOUNT_PAIRING_AUTHENTICATION_REQUIRED_CODE } from "./types/account";

/**
 * What "Reconnect this computer" did, in one sentence. The desktop's reconnect
 * surfaces, `ade machines reconnect --text` and the `ade code` `/reconnect`
 * notice all read it from here, so the three cannot disagree. Pure: no
 * renderer or Node globals.
 */

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

/**
 * A repair result read off the wire, or null when it is not one. The CLI and
 * the TUI get it as untyped JSON; every field an older brain may omit reads as
 * its "nothing happened" value.
 */
export function readReconnectResult(value: unknown): AdeAccountMachinePairingRepairResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.repaired !== "boolean") return null;
  const reason = typeof record.reason === "string" && record.reason.trim() ? record.reason : null;
  const reasonCode = typeof record.reasonCode === "string" && record.reasonCode.trim() ? record.reasonCode : null;
  return {
    repaired: record.repaired,
    wasRevoked: record.wasRevoked === true,
    published: record.published === true,
    pushRestored: record.pushRestored === true,
    state: typeof record.state === "string" ? record.state : "",
    reason,
    ...(reasonCode ? { reasonCode } : {}),
  };
}
