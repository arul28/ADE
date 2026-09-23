import type {
  AdeAccountLocalMachineIdentity,
  AdeAccountMachine,
  AdeAccountMachinePairingRepairResult,
  AdeAccountMachinesResult,
} from "../../shared/types";
import { invalidateAccountMachines, publishAccountMachines } from "./account";
import { runAccountDeviceLogin, type AccountDeviceLoginPrompt } from "./accountLogin";
import {
  describeReconnectOutcome,
  reconnectNeedsFreshSignIn,
  type ReconnectOutcome,
} from "./thisComputerRefusal";
import { isWebClientMode } from "./webClientMode";

/**
 * "Reconnect this computer": the one flow that puts a removed or refused
 * computer back on its account.
 *
 * The shell banner, the Account page card, the Connections pane's This machine
 * card and the Machines list all offer it, and two of them can be on screen at
 * once. So the flow is one per window, not one per button: its state lives in
 * this module, `useReconnectThisComputer` only subscribes to it, and a second
 * press joins the attempt that is already running instead of starting another
 * device login. The words each state shows live in `thisComputerRefusal.ts`.
 */

type ReconnectBridge = {
  listMachines?: () => Promise<AdeAccountMachinesResult>;
  getLocalMachineIdentity?: () => Promise<AdeAccountLocalMachineIdentity>;
  repairMachinePairing?: () => Promise<AdeAccountMachinePairingRepairResult>;
};

function reconnectBridge(): ReconnectBridge | undefined {
  return (window.ade as (typeof window.ade & { account?: ReconnectBridge }) | undefined)?.account;
}

/** False in the hosted web client and on builds without the repair bridge. */
export function reconnectAvailable(): boolean {
  return !isWebClientMode() && typeof reconnectBridge()?.repairMachinePairing === "function";
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

export type ReconnectFlowState = {
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
// Bumped by the test reset, so an attempt it abandoned can never write again.
let flowGeneration = 0;
const flowListeners = new Set<() => void>();
// The options of every mounted hook instance, so the end of an attempt
// refreshes every surface on screen, not only the one that started it.
const participants = new Set<{ current: ReconnectThisComputerOptions }>();

function updateFlow(patch: Partial<ReconnectFlowState>): void {
  flowState = { ...flowState, ...patch };
  for (const listener of flowListeners) listener();
}

export function subscribeReconnectFlow(listener: () => void): () => void {
  flowListeners.add(listener);
  return () => {
    flowListeners.delete(listener);
  };
}

export function readReconnectFlow(): ReconnectFlowState {
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
  isCurrent: () => boolean,
): Promise<ReconnectOutcome | null> {
  try {
    const first = await api.repairMachinePairing();
    if (!reconnectNeedsFreshSignIn(first)) {
      await reloadEverywhere(starter);
      return describeReconnectOutcome(first);
    }
    const signIn = await runAccountDeviceLogin({
      onPrompt: (signInPrompt) => {
        if (isCurrent()) updateFlow({ signInPrompt });
      },
      isCancelled: () => cancelRequested || !isCurrent(),
    });
    if (isCurrent()) updateFlow({ signInPrompt: null });
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
export function startReconnect(starter: ReconnectThisComputerOptions): Promise<void> {
  if (runningAttempt) return runningAttempt;
  const api = reconnectBridge();
  const repairMachinePairing = api?.repairMachinePairing;
  if (!repairMachinePairing) return Promise.resolve();
  cancelRequested = false;
  const generation = flowGeneration;
  const isCurrent = () => generation === flowGeneration;
  updateFlow({ reconnecting: true, signInPrompt: null, outcome: null, attempt: flowState.attempt + 1 });
  runningAttempt = (async () => {
    const outcome = await attemptReconnect({ repairMachinePairing }, starter, isCurrent);
    if (!isCurrent()) return;
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

export function cancelReconnect(): void {
  cancelRequested = true;
  updateFlow({ signInPrompt: null });
}

/**
 * Put this surface's options on the list every attempt reads when it ends.
 * Returns the unregister function, for an effect cleanup.
 */
export function registerReconnectParticipant(entry: { current: ReconnectThisComputerOptions }): () => void {
  participants.add(entry);
  return () => {
    participants.delete(entry);
  };
}

/**
 * Forget every attempt. A test that fails while an attempt is pending would
 * otherwise leave it running, and every later test would join that dead one.
 */
export function resetReconnectFlowForTests(): void {
  flowGeneration += 1;
  flowState = { reconnecting: false, signInPrompt: null, outcome: null, attempt: 0 };
  runningAttempt = null;
  cancelRequested = false;
  participants.clear();
  for (const listener of flowListeners) listener();
}
