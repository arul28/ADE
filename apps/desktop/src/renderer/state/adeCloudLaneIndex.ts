import { useSyncExternalStore } from "react";
import type { CloudMachine } from "../../shared/adeCloud";
import type { CloudLaneMachine } from "../../shared/cloudLaneLaunch";
import { laneComputersOf, parseSavedLaneComputers, savedLaneComputerRows, type LaneComputer } from "../../shared/laneComputer";
import { machineNameForBinding } from "../../shared/machineIdentity";
import type { OpenProjectBinding } from "../../shared/types/core";
import { chatLaunchStore } from "./chatLaunchStore";

/**
 * The account's ADE Cloud lane computers as last read, kept after the read's
 * surface closes and across a restart (this computer's storage only). It holds
 * no secret: lane names, ids, project origins and computer ids.
 *
 * Two readers need it without a read of their own:
 * - the composer's Run on menu, which opens with the last list in hand while
 *   the account's list is read again;
 * - a chat's machine chip, which says "Cloud · <lane>" for a chat on a lane
 *   computer instead of the computer's own name.
 *
 * `useCloudMachines` fills it on every good read. Nothing here reads the
 * network or sets a timer.
 */

/** A lane and the computer it is on now (contract C3's `LaneComputer`). */
export type AdeCloudLaneComputer = LaneComputer;

const STORAGE_KEY = "ade.cloudLaneComputers.v1";

type IndexState = {
  computers: readonly AdeCloudLaneComputer[];
  /** True once a read (or the saved copy) filled it. */
  known: boolean;
  /** When a read in this window last filled it (the saved copy doesn't count), or null. */
  readAtMs: number | null;
};

/** How long a read of the account's computers is fresh enough to call a computer missing from it deleted. */
const FRESH_LANE_INDEX_MS = 10 * 60_000;

let state: IndexState = readSaved();
const listeners = new Set<() => void>();

function readSaved(): IndexState {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { computers: [], known: false, readAtMs: null };
    return { computers: parseSavedLaneComputers(JSON.parse(raw) as unknown), known: true, readAtMs: null };
  } catch {
    return { computers: [], known: false, readAtMs: null };
  }
}

function signature(computers: readonly AdeCloudLaneComputer[]): string {
  return computers
    .map((computer) => [computer.instanceId, computer.laneId, computer.laneName, computer.projectOrigin ?? "", computer.machineKey ?? "", computer.state].join("\u0001"))
    .join("\u0002");
}

/** Records the lane computers of a good read of the account's computers. */
export function noteCloudLaneMachines(machines: readonly CloudMachine[]): void {
  // One computer per lane, the same rule as the main process's follower: while
  // a move runs, the lane stays on the old computer.
  const computers = laneComputersOf(machines as readonly CloudLaneMachine[])
    .sort((a, b) => a.laneName.localeCompare(b.laneName) || a.instanceId.localeCompare(b.instanceId));
  noteCloudLaneComputers(computers);
}

function noteCloudLaneComputers(computers: readonly AdeCloudLaneComputer[]): void {
  const readAtMs = Date.now();
  if (state.known && signature(computers) === signature(state.computers)) {
    // Same list: fresher, but nothing for a listener to redraw.
    state = { ...state, readAtMs };
    return;
  }
  state = { computers, known: true, readAtMs };
  try {
    window.localStorage.setItem(STORAGE_KEY, savedLaneComputerRows(computers));
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
  if (computers.length === state.computers.length) return;
  noteCloudLaneComputers(computers);
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
 * What a person sees for an ADE Cloud computer: "Cloud", never its generated
 * name (an instance id as its host name, a lane-derived computer name). The
 * generated names stay in logs, support views and tooltips.
 */
export const ADE_CLOUD_MACHINE_LABEL = "Cloud";

/** "Cloud · fix-login": a lane's cloud computer, with its lane to tell two apart. */
export function adeCloudLaneLabel(laneName: string): string {
  return `${ADE_CLOUD_MACHINE_LABEL} · ${laneName}`;
}

/**
 * The name a person sees for the machine a binding targets: "Cloud · <lane>"
 * for an ADE Cloud lane computer, else the machine's own (device) name or
 * "This computer" (`machineNameForBinding`). A label only: routing keeps the
 * binding itself.
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
  const lane = adeCloudLaneForBinding(binding, computers);
  return lane ? adeCloudLaneLabel(lane.laneName) : machineNameForBinding(binding);
}

/** `machineLabelForBinding` for a component: it follows the index as reads arrive. */
export function useMachineLabelForBinding(binding: OpenProjectBinding | null | undefined): string {
  const { computers } = useAdeCloudLaneComputers();
  return machineLabelForBinding(binding, computers);
}

/**
 * The name a person sees for a machine listed by host name or machine key
 * (account machine rows, machine pickers): "Cloud · <lane>" for an ADE Cloud
 * lane computer, else `name`.
 */
export function machineLabelForMachine(
  machine: { hostname?: string | null; machineKey?: string | null; name: string },
  computers: readonly AdeCloudLaneComputer[] = state.computers,
): string {
  return adeCloudLaneLabelForMachine(machine, computers) ?? machine.name;
}

/**
 * "Cloud · <lane>" when the machine is an ADE Cloud lane computer, else null:
 * for a row that shows the machine's own name too (as the tooltip) only when
 * the label replaced it.
 */
export function adeCloudLaneLabelForMachine(
  machine: { hostname?: string | null; machineKey?: string | null },
  computers: readonly AdeCloudLaneComputer[] = state.computers,
): string | null {
  const computer = adeCloudLaneComputerForMachine(machine, computers);
  return computer ? adeCloudLaneLabel(computer.laneName) : null;
}
