import { useSyncExternalStore } from "react";
import type { CloudMachine } from "../../shared/adeCloud";
import type { CloudLaneMachine } from "../../shared/cloudLaneLaunch";
import { laneComputersOf, parseSavedLaneComputers, savedLaneComputerRows, type LaneComputer } from "../../shared/laneComputer";
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
 * - a chat's machine chip, which says "ADE Cloud" for a chat on a lane
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
};

let state: IndexState = readSaved();
const listeners = new Set<() => void>();

function readSaved(): IndexState {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { computers: [], known: false };
    return { computers: parseSavedLaneComputers(JSON.parse(raw) as unknown), known: true };
  } catch {
    return { computers: [], known: false };
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
  if (state.known && signature(computers) === signature(state.computers)) return;
  state = { computers, known: true };
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const readState = () => state;

/** The lane computers as last read, for code outside React. */
export function adeCloudLaneComputersNow(): readonly AdeCloudLaneComputer[] {
  return state.computers;
}

/** Whether any read (or the saved copy) filled the list: only then does a missing lane computer mean anything. */
export function cloudLaneIndexKnown(): boolean {
  return state.known;
}

/** The lane computers as last read, and whether any read filled the list yet. */
export function useAdeCloudLaneComputers(): IndexState {
  return useSyncExternalStore(subscribe, readState, readState);
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

/** "ADE Cloud · fix-login": how a switcher names a chat's ADE Cloud lane. */
export function adeCloudLaneLabel(laneName: string): string {
  return `ADE Cloud · ${laneName}`;
}
