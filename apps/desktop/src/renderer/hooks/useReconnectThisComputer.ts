import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  AdeAccountLocalMachineIdentity,
  AdeAccountMachine,
  AdeAccountMachinePairingRepairResult,
  AdeAccountMachinesResult,
} from "../../shared/types";
import { ADE_ACCOUNT_PAIRING_AUTHENTICATION_REQUIRED_CODE } from "../../shared/types/account";
import { invalidateAccountMachines, publishAccountMachines } from "../lib/account";
import { runAccountDeviceLogin, type AccountDeviceLoginPrompt } from "../lib/accountLogin";
import { reconnectBrowserPromptText } from "../lib/thisComputerRefusal";
import { isWebClientMode } from "../lib/webClientMode";

/**
 * "Reconnect this computer": the one flow that puts a removed or refused
 * computer back on its account.
 *
 * The shell banner, the Account page card, the Connections pane's This machine
 * card and the Machines list all offer it, and two of them can be on screen at
 * once. So the flow is one per window, not one per button: its state lives in
 * this module, every hook instance reads the same state, and a second press
 * joins the attempt that is already running instead of starting another device
 * login. Each surface renders only the `view` this hook derives, so the
 * buttons can never say or do different things.
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

export type ReconnectThisComputerOptions = {
  /**
   * Re-read the directory after the attempt. The Account page passes its own
   * loader so its list refreshes in the same step.
   */
  reloadMachines?: () => Promise<AdeAccountMachinesResult>;
  /** Recognise this computer's row. Defaults to the brain's local identity. */
  isThisMac?: (machine: AdeAccountMachine) => boolean;
  /** Called once an attempt ends, whatever its outcome. */
  onSettled?: () => void;
};

type ReconnectFlowState = {
  reconnecting: boolean;
  /** Set while the browser step runs, so a surface can show the code. */
  signInPrompt: AccountDeviceLoginPrompt | null;
  outcome: ReconnectOutcome | null;
  /** Serial of the latest attempt; it goes up when an attempt starts. */
  attempt: number;
};

// One flow for the whole window. Every hook instance reads this state.
let flowState: ReconnectFlowState = { reconnecting: false, signInPrompt: null, outcome: null, attempt: 0 };
let runningAttempt: Promise<void> | null = null;
// Read by the sign-in loop between polls, so a Cancel from any surface stops it.
let cancelRequested = false;
const flowListeners = new Set<() => void>();
// The options of every mounted hook instance, so the end of an attempt
// refreshes every surface on screen, not only the one that started it.
const participants = new Set<{ current: ReconnectThisComputerOptions }>();

function updateFlow(patch: Partial<ReconnectFlowState>): void {
  flowState = { ...flowState, ...patch };
  for (const listener of flowListeners) listener();
}

function subscribeFlow(listener: () => void): () => void {
  flowListeners.add(listener);
  return () => {
    flowListeners.delete(listener);
  };
}

function readFlow(): ReconnectFlowState {
  return flowState;
}

async function defaultReloadMachines(): Promise<AdeAccountMachinesResult | null> {
  const api = reconnectBridge();
  if (!api?.listMachines) return null;
  const next = await api.listMachines();
  publishAccountMachines(next);
  return next;
}

/**
 * Re-read the directory for every mounted surface.
 *
 * The starter's loader is awaited, because the outcome is read from its
 * answer. Every other distinct loader runs in the background, so a card that
 * keeps its own list (the Account page) refreshes even when another surface
 * pressed the button.
 */
async function reloadEverywhere(
  starter: ReconnectThisComputerOptions,
): Promise<AdeAccountMachinesResult | null> {
  invalidateAccountMachines();
  const own = starter.reloadMachines ?? defaultReloadMachines;
  const others = new Set([...participants].map((entry) => entry.current.reloadMachines ?? defaultReloadMachines));
  others.delete(own);
  for (const reload of others) void reload().catch(() => null);
  return await own();
}

async function recogniseThisComputer(
  starter: ReconnectThisComputerOptions,
): Promise<(machine: AdeAccountMachine) => boolean> {
  if (starter.isThisMac) return starter.isThisMac;
  const identity = await reconnectBridge()?.getLocalMachineIdentity?.().catch(() => null);
  return (machine) => matchesIdentity(machine, identity);
}

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
 *
 * Returns null when the person cancelled the browser step: a cancel states
 * nothing, because the surface already says what is wrong.
 */
async function attemptReconnect(
  api: Required<Pick<ReconnectBridge, "repairMachinePairing">>,
  starter: ReconnectThisComputerOptions,
): Promise<ReconnectOutcome | null> {
  try {
    const first = await api.repairMachinePairing();
    if (!reconnectNeedsFreshSignIn(first)) {
      await reloadEverywhere(starter);
      return describeReconnectOutcome(first);
    }
    const signIn = await runAccountDeviceLogin({
      onPrompt: (signInPrompt) => updateFlow({ signInPrompt }),
      isCancelled: () => cancelRequested,
    });
    updateFlow({ signInPrompt: null });
    if (signIn.status === "cancelled") return null;
    if (signIn.status === "failed") return { tone: "danger", message: signIn.message };
    const refreshed = await reloadEverywhere(starter);
    const isThis = await recogniseThisComputer(starter);
    const back = Boolean(
      refreshed?.state === "ok"
      && refreshed.machines.some((candidate) => isThis(candidate)),
    );
    return back
      ? {
          tone: "success",
          message: "This computer is back on your account. Activity and alerts are delivering again.",
        }
      : {
          tone: "danger",
          message:
            "You confirmed it's you, but this computer still isn't on your account. Try Reconnect this computer again.",
        };
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

/** Start an attempt, or join the one already running. */
function startReconnect(starter: ReconnectThisComputerOptions): Promise<void> {
  if (runningAttempt) return runningAttempt;
  const api = reconnectBridge();
  const repairMachinePairing = api?.repairMachinePairing;
  if (!repairMachinePairing) return Promise.resolve();
  cancelRequested = false;
  updateFlow({ reconnecting: true, signInPrompt: null, outcome: null, attempt: flowState.attempt + 1 });
  runningAttempt = (async () => {
    const outcome = await attemptReconnect({ repairMachinePairing }, starter);
    runningAttempt = null;
    updateFlow({ reconnecting: false, signInPrompt: null, outcome });
    for (const entry of [...participants]) {
      try {
        entry.current.onSettled?.();
      } catch {
        // One surface's refresh must not stop the others'.
      }
    }
  })();
  return runningAttempt;
}

function cancelReconnect(): void {
  cancelRequested = true;
  updateFlow({ signInPrompt: null });
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
  flow: Pick<ReconnectThisComputer, "reconnecting" | "signInPrompt" | "outcome">,
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

export type ReconnectThisComputer = {
  /** False in the hosted web client and on builds without the repair bridge. */
  available: boolean;
  reconnecting: boolean;
  /** Set while the browser step runs, so the surface can show the code. */
  signInPrompt: AccountDeviceLoginPrompt | null;
  /** The last attempt's outcome, when this surface was on screen for it. */
  outcome: ReconnectOutcome | null;
  reconnect: () => Promise<void>;
  cancel: () => void;
  /** The button and line to render, given this surface's idle copy. */
  view: (idle: { label: string; detail?: string }) => ReconnectActionView;
};

/**
 * `reloadMachines` and `isThisMac` come from the instance whose press started
 * the attempt, because they decide its outcome. `onSettled` runs for every
 * mounted instance, so each surface refreshes its own refusal read.
 */
export function useReconnectThisComputer(options: ReconnectThisComputerOptions = {}): ReconnectThisComputer {
  const participant = useRef(options);
  useEffect(() => {
    participant.current = options;
  });
  useEffect(() => {
    participants.add(participant);
    return () => {
      participants.delete(participant);
    };
  }, []);
  const flow = useSyncExternalStore(subscribeFlow, readFlow);
  // An outcome is shown only by a surface that was on screen for its attempt.
  // A card opened an hour after a reconnect from the banner must not announce
  // "back on your account" as if it just happened.
  const [lastAttemptBeforeMount] = useState(() =>
    flowState.reconnecting ? flowState.attempt - 1 : flowState.attempt,
  );
  const outcome = flow.attempt > lastAttemptBeforeMount ? flow.outcome : null;
  const available = !isWebClientMode() && typeof reconnectBridge()?.repairMachinePairing === "function";

  const reconnect = useCallback(() => startReconnect(participant.current), []);
  const view = useCallback(
    (idle: { label: string; detail?: string }) =>
      reconnectActionView(
        { reconnecting: flow.reconnecting, signInPrompt: flow.signInPrompt, outcome },
        idle,
        { reconnect: () => void reconnect(), cancel: cancelReconnect },
      ),
    [flow.reconnecting, flow.signInPrompt, outcome, reconnect],
  );

  return {
    available,
    reconnecting: flow.reconnecting,
    signInPrompt: flow.signInPrompt,
    outcome,
    reconnect,
    cancel: cancelReconnect,
    view,
  };
}
