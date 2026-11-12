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
 */

import { getErrorMessage } from "../shared/utils";
import {
  sameMachineKey,
  type MachineAddress,
  type MachineConnectFailureReason,
  type MachineConnectOptions,
  type MachineConnectResult,
} from "../../../shared/machineAddress";

export type MachineConnectorTarget = { id: string; name: string };

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

function failure(
  machineKey: string,
  reason: MachineConnectFailureReason,
  message: string,
): Extract<MachineConnectResult, { ok: false }> {
  return { ok: false, reason, machineKey, message };
}

/** The connection error's own sentence, without the transport's wrapper. */
function reasonText(error: unknown): string {
  return getErrorMessage(error)
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim()
    .replace(/\.$/, "");
}

export function createMachineConnector(deps: MachineConnectorDeps): MachineConnector {
  const inFlight = new Map<string, Promise<MachineConnectResult>>();

  const addressFor = (machineKey: string): MachineAddress | null => {
    const key = machineKey.trim();
    if (!key) return null;
    if (sameMachineKey(deps.localMachineKey(), key)) return { kind: "this", machineKey: key };
    const saved = deps.savedTarget(key);
    return saved ? { kind: "remote", machineKey: key, targetId: saved.id, name: saved.name || FALLBACK_NAME } : null;
  };

  const run = async (key: string, wantConnected: boolean): Promise<MachineConnectResult> => {
    const known = addressFor(key);
    if (known?.kind === "this") return { ok: true, address: known };

    let address = known;
    if (!address) {
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
      const name = row.name?.trim() || FALLBACK_NAME;
      try {
        const paired = await deps.pairMachine(key);
        address = { kind: "remote", machineKey: key, targetId: paired.targetId, name: paired.name?.trim() || name };
        deps.logger?.info?.("machines.connect_paired", { targetId: paired.targetId });
      } catch (error) {
        deps.logger?.warn?.("machines.connect_pair_failed", { error: getErrorMessage(error) });
        return failure(key, "unreachable", `ADE couldn't reach ${name}: ${reasonText(error)}.`);
      }
    }
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
      const flightKey = `${key.toLowerCase()}\u0000${wantConnected ? "connect" : "save"}`;
      const existing = inFlight.get(flightKey);
      if (existing) return existing;
      const flight = run(key, wantConnected).finally(() => inFlight.delete(flightKey));
      inFlight.set(flightKey, flight);
      return flight;
    },
  };
}
