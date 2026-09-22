import { useCallback, useRef, useState } from "react";
import type {
  AdeAccountLocalMachineIdentity,
  AdeAccountMachine,
  AdeAccountMachinePairingRepairResult,
  AdeAccountMachinesResult,
} from "../../shared/types";
import { ADE_ACCOUNT_PAIRING_AUTHENTICATION_REQUIRED_CODE } from "../../shared/types/account";
import { invalidateAccountMachines, publishAccountMachines } from "../lib/account";
import { runAccountDeviceLogin, type AccountDeviceLoginPrompt } from "../lib/accountLogin";
import { isWebClientMode } from "../lib/webClientMode";

/**
 * "Reconnect this computer": the one flow that puts a removed or refused
 * computer back on its account.
 *
 * The Account page card, the shell banner and the Connections pane all offer
 * it. They share this hook so the three buttons can never do different things.
 */

/** What the user is told after a reconnect attempt, and how it is styled. */
export type ReconnectOutcome = { tone: "success" | "warning" | "danger"; message: string };

type ReconnectBridge = {
  listMachines?: () => Promise<AdeAccountMachinesResult>;
  getLocalMachineIdentity?: () => Promise<AdeAccountLocalMachineIdentity>;
  repairMachinePairing?: () => Promise<AdeAccountMachinePairingRepairResult>;
};

function reconnectBridge(): ReconnectBridge | undefined {
  return (window.ade as (typeof window.ade & { account?: ReconnectBridge }) | undefined)?.account;
}

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

function matchesIdentity(
  machine: AdeAccountMachine,
  identity: AdeAccountLocalMachineIdentity | null | undefined,
): boolean {
  if (!identity?.machineKey) return false;
  if (machine.machineKey === identity.machineKey) return true;
  return Boolean(machine.deviceId) && machine.deviceId === identity.deviceId;
}

export type ReconnectThisComputer = {
  /** False in the hosted web client and on builds without the repair bridge. */
  available: boolean;
  reconnecting: boolean;
  /** Set while the browser step runs, so the surface can show the code. */
  signInPrompt: AccountDeviceLoginPrompt | null;
  outcome: ReconnectOutcome | null;
  reconnect: () => Promise<void>;
  cancel: () => void;
};

export function useReconnectThisComputer(options: {
  /**
   * Re-read the directory after the attempt. The Account page passes its own
   * loader so its list refreshes in the same step.
   */
  reloadMachines?: () => Promise<AdeAccountMachinesResult>;
  /** Recognise this computer's row. Defaults to the brain's local identity. */
  isThisMac?: (machine: AdeAccountMachine) => boolean;
  /** Called once an attempt ends, whatever its outcome. */
  onSettled?: () => void;
} = {}): ReconnectThisComputer {
  const { reloadMachines, isThisMac, onSettled } = options;
  const [reconnecting, setReconnecting] = useState(false);
  const [outcome, setOutcome] = useState<ReconnectOutcome | null>(null);
  const [signInPrompt, setSignInPrompt] = useState<AccountDeviceLoginPrompt | null>(null);
  // A ref, not state: the in-flight sign-in loop reads it between polls, and a
  // state value captured in that closure would stay false forever.
  const cancelledRef = useRef(false);
  const available = !isWebClientMode() && typeof reconnectBridge()?.repairMachinePairing === "function";

  const reload = useCallback(async (): Promise<AdeAccountMachinesResult | null> => {
    if (reloadMachines) return await reloadMachines();
    const api = reconnectBridge();
    if (!api?.listMachines) return null;
    const next = await api.listMachines();
    publishAccountMachines(next);
    return next;
  }, [reloadMachines]);

  const recognise = useCallback(async (): Promise<(machine: AdeAccountMachine) => boolean> => {
    if (isThisMac) return isThisMac;
    const identity = await reconnectBridge()?.getLocalMachineIdentity?.().catch(() => null);
    return (machine) => matchesIdentity(machine, identity);
  }, [isThisMac]);

  /**
   * Reconnect this computer, confirming it's you first when the directory
   * demands proof of a fresh sign-in.
   *
   * The re-pair is attempted first, because it is the only step needed when the
   * removal left nothing that requires fresh authentication (a push-only gate,
   * or a directory grant already in hand). When the directory does refuse for
   * want of a fresh sign-in, escalating in the same click is the whole point:
   * the person pressed this button to get the computer back.
   *
   * The confirmation runs through the DEVICE flow, not the loopback flow the
   * sign-in card uses. Only the device flow passes through ADE's account
   * directory, so only it can end with the directory minting the single-use
   * pairing grant that gets a removed machine back on the roster.
   *
   * Nothing re-triggers the repair afterwards: the brain already re-pairs on
   * its own when an interactive sign-in completes while this machine is
   * revoked. So the follow-through is the directory read below, which reports
   * the outcome the user cares about — is this computer on the list again.
   */
  const reconnect = useCallback(async () => {
    const api = reconnectBridge();
    if (!api?.repairMachinePairing) return;
    setReconnecting(true);
    setOutcome(null);
    setSignInPrompt(null);
    cancelledRef.current = false;
    try {
      const first = await api.repairMachinePairing();
      if (!reconnectNeedsFreshSignIn(first)) {
        setOutcome(describeReconnectOutcome(first));
        invalidateAccountMachines();
        await reload();
        return;
      }
      const signIn = await runAccountDeviceLogin({
        onPrompt: setSignInPrompt,
        isCancelled: () => cancelledRef.current,
      });
      setSignInPrompt(null);
      if (signIn.status === "cancelled") return;
      if (signIn.status === "failed") {
        setOutcome({ tone: "danger", message: signIn.message });
        return;
      }
      invalidateAccountMachines();
      const refreshed = await reload();
      const isThis = await recognise();
      const back = Boolean(
        refreshed?.state === "ok"
        && refreshed.machines.some((candidate) => isThis(candidate)),
      );
      setOutcome(
        back
          ? {
              tone: "success",
              message: "This computer is back on your account. Activity and alerts are delivering again.",
            }
          : {
              tone: "danger",
              message:
                "You confirmed it's you, but this computer still isn't on your account. Try Reconnect this computer again.",
            },
      );
    } catch (err) {
      // Main already translated the brain's failure into a sentence; only a
      // truly unexpected throw reaches the fallback.
      setOutcome({
        tone: "danger",
        message: err instanceof Error && err.message
          ? err.message
          : "Couldn't reconnect this computer to your account. Try again in a moment.",
      });
    } finally {
      setSignInPrompt(null);
      setReconnecting(false);
      onSettled?.();
    }
  }, [onSettled, recognise, reload]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    setSignInPrompt(null);
  }, []);

  return { available, reconnecting, signInPrompt, outcome, reconnect, cancel };
}
