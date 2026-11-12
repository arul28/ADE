/**
 * Contract C2 in the main process: connect to any machine of the account by
 * its machine key, and hand back one `MachineAddress`.
 *
 * Input is the machine key only. Nothing here reads or changes the machine of
 * a tab or a window, and nothing adds a default route: the address names one
 * machine, and the caller passes it with each call.
 *
 * In order, cheapest first:
 * 1. This computer's own key: `{ kind: "this" }`, no network.
 * 2. A saved connection to that machine: reused (connected only when asked).
 * 3. Else the account's machine list is read once to check the key is on the
 *    account, and this computer pairs with it through the account (the same
 *    account-attested pairing the cloud lane launch uses). The pairing is saved,
 *    so the next call takes step 2.
 *
 * One flight per machine key: two callers asking at once share one pairing.
 * A connect that arrives during a save-only pairing waits, then connects.
 */

import { getErrorMessage } from "../shared/utils";
import { isCloudInstanceId } from "../../../shared/adeCloud";
import { stripElectronErrorWrapper } from "../../../shared/codedError";
import {
  sameMachineKey,
  type MachineAddress,
  type MachineConnectFailureReason,
  type MachineConnectOptions,
  type MachineConnectResult,
} from "../../../shared/machineAddress";

export type MachineConnectorTarget = { id: string; name: string };

/** What a wake before a pairing did: `woken` means a start was asked for and the machine's ADE answers soon. */
export type MachineWakeResult = { state: "not_cloud" | "awake" | "woken" } | { state: "refused"; message: string };

export type MachineConnectorDeps = {
  /** This computer's account machine key, or null when it has none yet. */
  localMachineKey: () => string | null;
  /** Whether this computer is signed in to an ADE account. */
  signedIn: () => boolean;
  /** This computer's saved connection to the machine, or null. */
  savedTarget: (machineKey: string) => MachineConnectorTarget | null;
  isConnected: (targetId: string) => boolean;
  /**
   * The account's row for the machine: its display name, or null when the key
   * is not on the account. Throws when the list can't be read.
   */
  accountMachine: (machineKey: string) => Promise<{ name: string | null } | null>;
  /** Pairs this computer with the machine through the account; saves the connection. */
  pairMachine: (machineKey: string) => Promise<{ targetId: string; name: string }>;
  /** Opens a saved connection; wakes a sleeping cloud computer. Throws on failure. */
  connect: (targetId: string) => Promise<unknown>;
  /**
   * Wakes the machine when it is a sleeping cloud computer, before a pairing
   * (a pairing is a live hello with its ADE, which a sleeping computer can't
   * answer). `woken`: a start was asked for and its ADE answers soon.
   */
  wake?: (machineKey: string) => Promise<MachineWakeResult>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: {
    info?: (event: string, meta?: Record<string, unknown>) => void;
    warn?: (event: string, meta?: Record<string, unknown>) => void;
  };
};

export type MachineConnector = {
  /** An address for the machine, pairing and connecting as needed. Never throws. */
  connect(machineKey: string, options?: MachineConnectOptions): Promise<MachineConnectResult>;
  /** The address from what this computer already has saved; no network. Null when nothing is saved. */
  addressFor(machineKey: string): MachineAddress | null;
};

const FALLBACK_NAME = "your computer";

/** A display name, never a cloud computer's raw id. */
function displayName(...names: Array<string | null | undefined>): string {
  for (const name of names) {
    const trimmed = name?.trim();
    if (trimmed && !isCloudInstanceId(trimmed)) return trimmed;
  }
  return names.some((name) => name?.trim()) ? "your ADE Cloud computer" : FALLBACK_NAME;
}

/** A cloud computer just woken takes this long at most for its ADE to answer a pairing. */
const WOKEN_PAIR_WAIT_MS = 120_000;
const WOKEN_PAIR_RETRY_MS = 4_000;

function failure(
  machineKey: string,
  reason: MachineConnectFailureReason,
  message: string,
): Extract<MachineConnectResult, { ok: false }> {
  return { ok: false, reason, machineKey, message };
}

/** The connection error's own sentence, without the transport's wrapper or a closing period. */
function reasonText(error: unknown): string {
  return stripElectronErrorWrapper(getErrorMessage(error)).trim().replace(/\.$/, "");
}

export function createMachineConnector(deps: MachineConnectorDeps): MachineConnector {
  const inFlight = new Map<string, { wantConnected: boolean; promise: Promise<MachineConnectResult>; paired: Promise<MachineConnectResult> }>();
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const addressFor = (machineKey: string): MachineAddress | null => {
    const key = machineKey.trim();
    if (!key) return null;
    if (sameMachineKey(deps.localMachineKey(), key)) return { kind: "this", machineKey: key };
    const saved = deps.savedTarget(key);
    return saved ? { kind: "remote", machineKey: key, targetId: saved.id, name: displayName(saved.name) } : null;
  };

  /**
   * A machine this computer never saved: check the key is on the account, wake
   * a sleeping cloud computer when the caller wants a connection (a pairing is
   * a live hello its ADE must answer), then pair through the account.
   */
  const pairThroughAccount = async (key: string, wantConnected: boolean): Promise<MachineConnectResult> => {
    if (!deps.signedIn()) {
      return failure(key, "signed_out", "Sign in to your ADE account on this computer to reach your other computers.");
    }
    let row: { name: string | null } | null;
    try {
      row = await deps.accountMachine(key);
    } catch (error) {
      return failure(key, "unreachable", `ADE couldn't read your account's computers: ${reasonText(error)}.`);
    }
    if (!row) return failure(key, "not_in_account", "That computer is no longer on your ADE account.");
    const name = displayName(row.name);
    let woken = false;
    if (wantConnected && deps.wake) {
      try {
        const wake = await deps.wake(key);
        if (wake.state === "refused") return failure(key, "unreachable", wake.message);
        woken = wake.state === "woken";
        deps.logger?.info?.("machines.connect_wake", { state: wake.state });
      } catch (error) {
        return failure(key, "unreachable", `ADE couldn't wake ${name}: ${reasonText(error)}.`);
      }
    }
    // A computer that is still starting answers within a minute or two.
    const deadline = now() + (woken ? WOKEN_PAIR_WAIT_MS : 0);
    let lastError: unknown = null;
    do {
      if (lastError) await sleep(WOKEN_PAIR_RETRY_MS);
      try {
        const paired = await deps.pairMachine(key);
        deps.logger?.info?.("machines.connect_paired", { targetId: paired.targetId, woken });
        return { ok: true, address: { kind: "remote", machineKey: key, targetId: paired.targetId, name: displayName(row.name, paired.name) } };
      } catch (error) {
        lastError = error;
      }
    } while (now() < deadline);
    deps.logger?.warn?.("machines.connect_pair_failed", { error: getErrorMessage(lastError), woken });
    return failure(key, "unreachable", `ADE couldn't reach ${name}: ${reasonText(lastError)}.`);
  };

  /** `onPaired` hears the address (or the failure) as soon as it is known, before any connect. */
  const run = async (key: string, wantConnected: boolean, onPaired: (result: MachineConnectResult) => void): Promise<MachineConnectResult> => {
    const known = addressFor(key);
    if (known?.kind === "this") return { ok: true, address: known };
    let address = known;
    if (!address) {
      const paired = await pairThroughAccount(key, wantConnected);
      if (!paired.ok || paired.address.kind !== "remote") return paired;
      address = paired.address;
    }
    onPaired({ ok: true, address });
    if (!wantConnected || deps.isConnected(address.targetId)) return { ok: true, address };
    try {
      await deps.connect(address.targetId);
    } catch (error) {
      deps.logger?.warn?.("machines.connect_failed", { targetId: address.targetId, error: getErrorMessage(error) });
      return failure(key, "unreachable", `ADE couldn't reach ${address.name}: ${reasonText(error)}.`);
    }
    return { ok: true, address };
  };

  return {
    addressFor,
    connect(machineKey, options) {
      const key = machineKey?.trim() ?? "";
      if (!key) return Promise.resolve(failure("", "invalid", "ADE needs to know which computer to reach."));
      const wantConnected = options?.connect !== false;
      const flightKey = key.toLowerCase();
      const existing = inFlight.get(flightKey);
      // One flight per machine: a connect that finds a save-only pairing
      // running waits for it, then connects (the pairing is saved by then).
      // A save-only call that finds a connect running takes its pairing, not
      // its wake wait or connect.
      if (existing && existing.wantConnected && !wantConnected) return existing.paired;
      if (existing && (existing.wantConnected || !wantConnected)) return existing.promise;
      let settlePaired!: (result: MachineConnectResult) => void;
      const paired = new Promise<MachineConnectResult>((resolve) => { settlePaired = resolve; });
      const promise = (async (): Promise<MachineConnectResult> => {
        if (existing) await existing.promise;
        try {
          const result = await run(key, wantConnected, settlePaired);
          if (!result.ok) deps.logger?.warn?.("machines.connect_refused", { reason: result.reason, wantConnected });
          return result;
        } catch (error) {
          // A dependency that throws (the account's status, a saved target read) is a failed reach, never a throw.
          deps.logger?.warn?.("machines.connect_threw", { error: getErrorMessage(error) });
          return failure(key, "unreachable", `ADE couldn't reach that computer: ${reasonText(error)}.`);
        }
      })().then((result) => {
        // A flight that ended before an address (a failure, this computer) settles its pairing with the same answer.
        settlePaired(result);
        return result;
      }).finally(() => {
        if (inFlight.get(flightKey)?.promise === promise) inFlight.delete(flightKey);
      });
      inFlight.set(flightKey, { wantConnected, promise, paired });
      return promise;
    },
  };
}
