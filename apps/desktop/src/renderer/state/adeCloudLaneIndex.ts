import { useSyncExternalStore } from "react";
import type { CloudMachine, CloudMachineState } from "../../shared/adeCloud";
import type { CloudLaneMachine, CloudMachineLaneFacts } from "../../shared/cloudLaneLaunch";
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

export type AdeCloudLaneComputer = CloudMachineLaneFacts & {
  instanceId: string;
  machineKey: string | null;
  state: CloudMachineState;
};

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
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return { computers: [], known: false };
    const computers = parsed.flatMap((row): AdeCloudLaneComputer[] => {
      if (!row || typeof row !== "object") return [];
      const value = row as Record<string, unknown>;
      if (typeof value.instanceId !== "string" || typeof value.laneId !== "string" || typeof value.laneName !== "string") return [];
      return [{
        instanceId: value.instanceId,
        laneId: value.laneId,
        laneName: value.laneName,
        projectOrigin: typeof value.projectOrigin === "string" ? value.projectOrigin : null,
        machineKey: typeof value.machineKey === "string" ? value.machineKey : null,
        // A saved copy is old: never show a computer as awake from it.
        state: "asleep",
      }];
    });
    return { computers, known: true };
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
  const computers = (machines as readonly CloudLaneMachine[]).flatMap((machine): AdeCloudLaneComputer[] => {
    if (!machine.lane || machine.state === "deleting") return [];
    return [{ ...machine.lane, instanceId: machine.instanceId, machineKey: machine.machineKey, state: machine.state }];
  }).sort((a, b) => a.laneName.localeCompare(b.laneName) || a.instanceId.localeCompare(b.instanceId));
  noteCloudLaneComputers(computers);
}

function noteCloudLaneComputers(computers: readonly AdeCloudLaneComputer[]): void {
  if (state.known && signature(computers) === signature(state.computers)) return;
  state = { computers, known: true };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(computers.map(({ state: _state, ...rest }) => rest)));
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
