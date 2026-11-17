import { useSyncExternalStore } from "react";
import type { CloudMachine } from "../../shared/adeCloud";
import type { CloudLaneMachine } from "../../shared/cloudLaneLaunch";
import { laneComputersOf, parseSavedLaneComputers, savedLaneComputerRows, type LaneComputer } from "../../shared/laneComputer";
import { machineNameForBinding } from "../../shared/machineIdentity";
import type { OpenProjectBinding } from "../../shared/types/core";
import { chatLaunchStore } from "./chatLaunchStore";
import { ADE_CLOUD_NAME } from "../../shared/adeCloudMachine";

/**
 * The account's ADE Cloud lane computers as last read, kept after the read's
 * surface closes and across a restart (this computer's storage only). It holds
 * no secret: lane names, ids, project origins and computer ids.
 *
 * Two readers need it without a read of their own:
 * - the composer's Run on menu, which opens with the last list in hand while
 *   the account's list is read again;
 * - a chat's machine chip, which says "ADE Cloud" for a chat on a cloud
 *   computer instead of the computer's own name.
 *
 * `useCloudMachines` fills it on every good read. Nothing here reads the
 * network or sets a timer.
 */

/** A lane and the computer it is on now (contract C3's `LaneComputer`). */
export type AdeCloudLaneComputer = LaneComputer;

const STORAGE_KEY = "ade.cloudLaneComputers.v1";
/** Every ADE Cloud computer of the account (with a lane or not), by its ids. */
const CLOUD_COMPUTERS_STORAGE_KEY = "ade.cloudComputerIds.v1";

/** An ADE Cloud computer as the account names it: its id on the provider and its account key. */
export type AdeCloudComputerId = { instanceId: string; machineKey: string | null };

export type AdeCloudIndexState = IndexState;
type IndexState = {
  computers: readonly AdeCloudLaneComputer[];
  /**
   * Every ADE Cloud computer of the last read, a lane computer or not: a
   * computer made without a lane is an ADE Cloud computer too (it sleeps and
   * wakes the same way).
   */
  cloudComputers: readonly AdeCloudComputerId[];
  /** True once a read (or the saved copy) filled it. */
  known: boolean;
  /** When a read in this window last filled it (the saved copy doesn't count), or null. */
  readAtMs: number | null;
};

/** How long a read of the account's computers is fresh enough to call a computer missing from it deleted. */
const FRESH_LANE_INDEX_MS = 10 * 60_000;

let state: IndexState = readSaved();
const listeners = new Set<() => void>();

function readSavedCloudComputers(): AdeCloudComputerId[] {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(CLOUD_COMPUTERS_STORAGE_KEY) : null;
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object") return [];
      const { instanceId, machineKey } = entry as Record<string, unknown>;
      return typeof instanceId === "string" && instanceId
        ? [{ instanceId, machineKey: typeof machineKey === "string" && machineKey ? machineKey : null }]
        : [];
    });
  } catch {
    return [];
  }
}

function readSaved(): IndexState {
  const cloudComputers = readSavedCloudComputers();
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { computers: [], cloudComputers, known: false, readAtMs: null };
    return { computers: parseSavedLaneComputers(JSON.parse(raw) as unknown), cloudComputers, known: true, readAtMs: null };
  } catch {
    return { computers: [], cloudComputers, known: false, readAtMs: null };
  }
}

function signature(computers: readonly AdeCloudLaneComputer[], cloudComputers: readonly AdeCloudComputerId[]): string {
  return [
    ...computers.map((computer) => [computer.instanceId, computer.laneId, computer.laneName, computer.projectOrigin ?? "", computer.machineKey ?? "", computer.state].join("\u0001")),
    ...cloudComputers.map((computer) => `box\u0001${computer.instanceId}\u0001${computer.machineKey ?? ""}`),
  ].join("\u0002");
}

/** Records the lane computers of a good read of the account's computers. */
export function noteCloudLaneMachines(machines: readonly CloudMachine[]): void {
  // One computer per lane, the same rule as the main process's follower: while
  // a move runs, the lane stays on the old computer.
  const computers = laneComputersOf(machines as readonly CloudLaneMachine[])
    .sort((a, b) => a.laneName.localeCompare(b.laneName) || a.instanceId.localeCompare(b.instanceId));
  const cloudComputers = machines
    .map((machine) => ({ instanceId: machine.instanceId, machineKey: machine.machineKey?.trim() || null }))
    .sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  noteCloudLaneComputers(computers, cloudComputers);
}

function noteCloudLaneComputers(
  computers: readonly AdeCloudLaneComputer[],
  cloudComputers: readonly AdeCloudComputerId[] = state.cloudComputers,
): void {
  const readAtMs = Date.now();
  if (state.known && signature(computers, cloudComputers) === signature(state.computers, state.cloudComputers)) {
    // Same list: fresher, but nothing for a listener to redraw.
    state = { ...state, readAtMs };
    return;
  }
  state = { computers, cloudComputers, known: true, readAtMs };
  try {
    window.localStorage.setItem(STORAGE_KEY, savedLaneComputerRows(computers));
    window.localStorage.setItem(CLOUD_COMPUTERS_STORAGE_KEY, JSON.stringify(cloudComputers));
  } catch {
    // This computer's copy is a convenience; the next read fills it again.
  }
  for (const listener of listeners) listener();
}

/**
 * Drops one lane computer at once, after this window freed or deleted it, so a
 * chat's chip and the machine lists stop naming it before the next read.
 */
export function forgetCloudLaneComputer(instanceId: string): void {
  const computers = state.computers.filter((computer) => computer.instanceId !== instanceId);
  const cloudComputers = state.cloudComputers.filter((computer) => computer.instanceId !== instanceId);
  if (computers.length === state.computers.length && cloudComputers.length === state.cloudComputers.length) return;
  noteCloudLaneComputers(computers, cloudComputers);
}

/** Hears each change of the lane computers (not a fresher read of the same list). */
export function subscribeAdeCloudLaneComputers(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const readState = () => state;

/** The lane computers as last read, for code outside React. */
export function adeCloudLaneComputersNow(): readonly AdeCloudLaneComputer[] {
  return state.computers;
}

/**
 * Whether this window read the account's computers in the last few minutes:
 * only then may a computer missing from the index be called deleted. The saved
 * copy from an earlier run, or an old read, can miss a computer made since.
 */
export function cloudLaneIndexFresh(nowMs: number = Date.now()): boolean {
  return state.readAtMs != null && nowMs - state.readAtMs < FRESH_LANE_INDEX_MS;
}

/** The lane computers as last read, and whether any read filled the list yet. */
export function useAdeCloudLaneComputers(): IndexState {
  return useSyncExternalStore(subscribeAdeCloudLaneComputers, readState, readState);
}

/** A chat's ADE Cloud lane, and its computer's ADE Cloud id once known. */
export type AdeCloudLaneOfBinding = { laneId: string; laneName: string; instanceId: string | null };

/**
 * The ADE Cloud lane a chat's binding points at, or null for any other
 * machine. A lane computer's remote target carries the computer's id as its
 * host name; a launch made in this window also names its binding.
 */
function adeCloudLaneForBinding(
  binding: OpenProjectBinding | null | undefined,
  computers: readonly AdeCloudLaneComputer[] = state.computers,
): AdeCloudLaneOfBinding | null {
  if (!binding || binding.kind !== "remote") return null;
  const computer = adeCloudLaneComputerForMachine({ hostname: binding.hostname }, computers);
  if (computer) return { laneId: computer.laneId, laneName: computer.laneName, instanceId: computer.instanceId };
  for (const entry of Object.values(chatLaunchStore.getState().entries)) {
    const cloud = entry.snapshot.cloud;
    if (cloud?.binding && cloud.binding.targetId === binding.targetId) {
      return { laneId: entry.snapshot.laneId, laneName: entry.snapshot.laneName, instanceId: cloud.instanceId ?? null };
    }
  }
  return null;
}

/** `adeCloudLaneForBinding` for a component: it follows the index as reads arrive. */
export function useAdeCloudLaneForBinding(binding: OpenProjectBinding | null | undefined): AdeCloudLaneOfBinding | null {
  const { computers } = useAdeCloudLaneComputers();
  return adeCloudLaneForBinding(binding, computers);
}

/**
 * The ADE Cloud lane computer a machine stands for, by its remote host name
 * (a lane computer's target carries its ADE Cloud id) or its machine key.
 */
export function adeCloudLaneComputerForMachine(
  machine: { hostname?: string | null; machineKey?: string | null },
  computers: readonly AdeCloudLaneComputer[] = state.computers,
): AdeCloudLaneComputer | null {
  const host = machine.hostname?.trim().toLowerCase() ?? "";
  const key = machine.machineKey?.trim() ?? "";
  if (!host && !key) return null;
  return computers.find((computer) => (host && computer.instanceId.toLowerCase() === host) || (key && computer.machineKey === key)) ?? null;
}

/**
 * Whether a machine is an ADE Cloud computer of the account, with a lane or
 * not: by its remote host name (the computer's ADE Cloud id) or its machine
 * key. A React caller passes the index it subscribes to.
 */
export function isAdeCloudComputer(
  machine: { hostname?: string | null; machineKey?: string | null },
  index: Pick<IndexState, "computers" | "cloudComputers"> = state,
): boolean {
  return adeCloudInstanceIdForMachine(machine, index) != null;
}

/** The ADE Cloud id of a machine that is one of the account's ADE Cloud computers; else null. */
export function adeCloudInstanceIdForMachine(
  machine: { hostname?: string | null; machineKey?: string | null },
  index: Pick<IndexState, "computers" | "cloudComputers"> = state,
): string | null {
  const lane = adeCloudLaneComputerForMachine(machine, index.computers);
  if (lane) return lane.instanceId;
  const host = machine.hostname?.trim().toLowerCase() ?? "";
  const key = machine.machineKey?.trim() ?? "";
  if (!host && !key) return null;
  return index.cloudComputers.find((computer) => (host && computer.instanceId.toLowerCase() === host) || (key && computer.machineKey === key))?.instanceId ?? null;
}

/**
 * What a person sees for any ADE Cloud computer: "ADE Cloud", the one machine
 * every account has. Never a computer's generated name (an instance id as its
 * host name, a lane-derived computer name). Rows show the lane name on their
 * own; the generated names stay in logs, support views and tooltips.
 */
export const ADE_CLOUD_MACHINE_LABEL = ADE_CLOUD_NAME;

/**
 * The machine label of a lane's cloud computer: "ADE Cloud". The lane name is
 * not part of it: ADE Cloud is one machine, and the row names the lane.
 */
export function adeCloudLaneLabel(_laneName?: string): string {
  return ADE_CLOUD_NAME;
}

/**
 * The name a person sees for the machine a binding targets: "ADE Cloud" for
 * any of the account's ADE Cloud computers, else the machine's own (device)
 * name or "This computer" (`machineNameForBinding`). A label only: routing
 * keeps the binding itself.
 *
 * For code outside React and for event-time reads (a callback, a toast),
 * which read the index as it is then. A component that renders the label
 * uses `useMachineLabelForBinding`, or the label goes stale when the lane
 * computers are read after it rendered. The machine-row sibling is
 * `useMachineLabelForMachine` (`components/cloudLane`, apart from here
 * because it reads the app store, which imports this module).
 */
export function machineLabelForBinding(
  binding: OpenProjectBinding | null | undefined,
  computers: readonly AdeCloudLaneComputer[] = state.computers,
): string {
  if (adeCloudLaneForBinding(binding, computers)) return ADE_CLOUD_NAME;
  if (binding?.kind === "remote" && isAdeCloudComputer({ hostname: binding.hostname }, { computers, cloudComputers: state.cloudComputers })) {
    return ADE_CLOUD_NAME;
  }
  return machineNameForBinding(binding);
}

/** `machineLabelForBinding` for a component: it follows the index as reads arrive. */
export function useMachineLabelForBinding(binding: OpenProjectBinding | null | undefined): string {
  const { computers } = useAdeCloudLaneComputers();
  return machineLabelForBinding(binding, computers);
}

/**
 * The name a person sees for a machine listed by host name or machine key
 * (account machine rows, machine pickers): "ADE Cloud" for any ADE Cloud
 * computer, else `name`.
 */
export function machineLabelForMachine(
  machine: { hostname?: string | null; machineKey?: string | null; name: string },
  computers: readonly AdeCloudLaneComputer[] = state.computers,
): string {
  return adeCloudMachineLabel(machine, { computers, cloudComputers: state.cloudComputers }) ?? machine.name;
}

/**
 * What a machine row shows for an ADE Cloud computer: "ADE Cloud", with a
 * lane or not; else null (not ADE Cloud: the row keeps the machine's own
 * name). Never the instance id.
 */
export function adeCloudMachineLabel(
  machine: { hostname?: string | null; machineKey?: string | null },
  index: Pick<IndexState, "computers" | "cloudComputers"> = state,
): string | null {
  return isAdeCloudComputer(machine, index) ? ADE_CLOUD_NAME : null;
}

/**
 * "ADE Cloud" when the machine is an ADE Cloud lane computer, else null: for
 * a row that shows the machine's own name too (as the tooltip) only when the
 * label replaced it.
 */
export function adeCloudLaneLabelForMachine(
  machine: { hostname?: string | null; machineKey?: string | null },
  computers: readonly AdeCloudLaneComputer[] = state.computers,
): string | null {
  return adeCloudMachineLabel(machine, { computers, cloudComputers: state.cloudComputers });
}
