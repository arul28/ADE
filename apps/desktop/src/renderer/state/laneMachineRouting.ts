/**
 * Tab-agnostic lane → machine routing.
 *
 * A lane owns its machine (`worktree_path` is absolute on exactly one), so every
 * read and action on a lane must reach THAT machine. This module is the one
 * answer to "which machine owns lane X, and what pin do I pass" for every tab
 * that is not Work (Work keeps its own session-aware router in
 * `components/terminals/useWorkMachineRouter.ts`).
 *
 * Pin semantics are the preload's: `null` means "the machine this project tab
 * is bound to" — the existing unpinned path, byte-for-byte. A non-null pin is
 * a binding for another machine. Lane ids are unique per machine, not globally
 * (lane rows sync between machines), so whenever a caller knows which machine a
 * lane came from it must say so; resolving a bare id prefers the tab's machine.
 *
 * Cost: everything here derives from renderer state that already exists. The
 * only side effect is joining the shared, ref-counted union sync
 * (`useCrossMachineLaneSync`) while a surface that lists other machines is
 * visible — never a new polling loop.
 */

import { useMemo } from "react";
import type {
  LaneSummary,
  OpenProjectBinding,
  PrSummary,
  TerminalSessionSummary,
} from "../../shared/types";
import { THIS_MACHINE_ID, THIS_MACHINE_NAME } from "../../shared/machineIdentity";
import { isLivePinnedBinding } from "../lib/chatMachineRouting";
import {
  useAppStore,
  useRootAppStore,
  type CrossMachineMachineLanes,
} from "./appStore";
import { useCrossMachineLaneSync } from "./crossMachineLanes";

/** One machine that holds (or can hold) lanes of the active project's repo. */
export type LaneMachine = {
  machineId: string;
  /** Absolute machine name; never the word "remote". */
  machineName: string;
  online: boolean;
  /** The physical Mac this app runs on. */
  isThisMachine: boolean;
  /** The machine the project tab is bound to (unpinned calls reach it). */
  isActiveBinding: boolean;
  /**
   * The binding that addresses this machine's checkout of the repo. For the
   * active machine it is the tab's own binding (null only before a project is
   * open). For another machine, null means it cannot be addressed yet.
   */
  binding: OpenProjectBinding | null;
  /** The pin to pass to preload calls: null for the active machine. */
  pin: OpenProjectBinding | null;
  /** False for another machine that has no binding: nothing can be sent there. */
  routable: boolean;
};

/** One lane, tagged with the machine that owns it. */
export type MachineLane = LaneMachine & {
  /**
   * Stable, collision-free row key. The bare lane id for lanes on the active
   * machine (so existing selection state keeps working), and
   * `${machineId}:${laneId}` for lanes on any other machine — the same form
   * the Work sidebar uses.
   */
  key: string;
  /** The machine's own lane record. `lane.id` is only unique on that machine. */
  lane: LaneSummary;
};

export type AllMachineLanes = {
  /** Active machine first, then every other machine in the union. */
  machines: LaneMachine[];
  machinesById: ReadonlyMap<string, LaneMachine>;
  /** Every lane on every machine, active machine's lanes first. */
  lanes: MachineLane[];
  lanesByKey: ReadonlyMap<string, MachineLane>;
  /** Each other machine's mapped PR records, keyed by machine id. */
  prsByMachineId: ReadonlyMap<string, PrSummary[]>;
  /** Each other machine's session roster, keyed by machine id. */
  sessionsByMachineId: ReadonlyMap<string, TerminalSessionSummary[]>;
};

/**
 * The machine-chip rule shared by every tab: when the project spans more than
 * one known machine, EVERY lane row shows a machine chip (this machine's
 * included) and the machine filter chips appear. With one machine, no chips.
 */
export function shouldShowMachineChips(
  all: Pick<AllMachineLanes, "machines"> | { readonly length: number },
): boolean {
  // Any machine list counts (lane machines, PR/automation/history targets).
  const count = "machines" in all ? all.machines.length : all.length;
  return count > 1;
}

/** Row key for a lane on a machine other than the tab's. */
export function foreignLaneKey(machineId: string, laneId: string): string {
  return `${machineId}:${laneId}`;
}

function activeMachineFor(binding: OpenProjectBinding | null): { machineId: string; machineName: string } {
  return binding?.kind === "remote"
    ? { machineId: binding.targetId, machineName: binding.runtimeName }
    : { machineId: THIS_MACHINE_ID, machineName: THIS_MACHINE_NAME };
}

/**
 * Pure derivation of {@link AllMachineLanes}. Exported for callers that already
 * hold the inputs (and for the hook below); it performs no I/O.
 */
export function buildAllMachineLanes(input: {
  activeBinding: OpenProjectBinding | null;
  activeLanes: readonly LaneSummary[];
  machines: Readonly<Record<string, CrossMachineMachineLanes>>;
}): AllMachineLanes {
  const activeBinding = input.activeBinding ?? null;
  const active = activeMachineFor(activeBinding);
  const activeSlice = input.machines[active.machineId];
  const machines: LaneMachine[] = [{
    machineId: active.machineId,
    machineName: active.machineName,
    // A local binding is reachable by definition; a remote active binding is
    // offline exactly when its retained slice says so.
    online: activeBinding?.kind === "remote" ? activeSlice?.online ?? true : true,
    isThisMachine: active.machineId === THIS_MACHINE_ID,
    isActiveBinding: true,
    binding: activeBinding,
    pin: null,
    routable: true,
  }];
  const lanes: MachineLane[] = [];
  const seenActive = new Set<string>();
  for (const lane of input.activeLanes) {
    if (seenActive.has(lane.id)) continue;
    seenActive.add(lane.id);
    lanes.push({ ...machines[0]!, key: lane.id, lane });
  }
  const prsByMachineId = new Map<string, PrSummary[]>();
  const sessionsByMachineId = new Map<string, TerminalSessionSummary[]>();
  for (const entry of Object.values(input.machines)) {
    // The active machine is represented by the tab's own lane list above; the
    // union may still hold a (stale) slice for it.
    if (entry.machineId === active.machineId) continue;
    const binding = entry.binding ?? null;
    // Defensive: a slice whose binding IS the tab's binding must take the
    // unpinned path, exactly like the chat router resolves it.
    const pin = binding && binding.key === activeBinding?.key ? null : binding;
    const machine: LaneMachine = {
      machineId: entry.machineId,
      machineName: entry.machineName,
      online: entry.online,
      isThisMachine: entry.machineId === THIS_MACHINE_ID,
      isActiveBinding: false,
      binding,
      pin,
      routable: binding != null,
    };
    machines.push(machine);
    prsByMachineId.set(entry.machineId, entry.prs);
    sessionsByMachineId.set(entry.machineId, entry.sessions);
    const seen = new Set<string>();
    for (const lane of entry.lanes) {
      if (seen.has(lane.id)) continue;
      seen.add(lane.id);
      lanes.push({ ...machine, key: foreignLaneKey(entry.machineId, lane.id), lane });
    }
  }
  return {
    machines,
    machinesById: new Map(machines.map((machine) => [machine.machineId, machine] as const)),
    lanes,
    lanesByKey: new Map(lanes.map((row) => [row.key, row] as const)),
    prsByMachineId,
    sessionsByMachineId,
  };
}

/**
 * Every lane of the active project's repo on every machine, each tagged with
 * its machine, online state, binding and pin.
 *
 * `active` joins the shared union sync (ref-counted; see
 * `useCrossMachineLaneSync`) so other machines stay fresh while the calling
 * surface is visible. Pass false from a hidden surface: the rows keep rendering
 * from the store, they just stop being refreshed on this surface's behalf.
 */
export function useAllMachineLanes(active = true): AllMachineLanes {
  useCrossMachineLaneSync(active);
  const activeBinding = useAppStore((state) => state.projectBinding);
  const activeLanes = useAppStore((state) => state.lanes);
  const machines = useRootAppStore((state) => state.crossMachineLanesByMachineId);
  return useMemo(
    () => buildAllMachineLanes({ activeBinding: activeBinding ?? null, activeLanes, machines: machines ?? {} }),
    [activeBinding, activeLanes, machines],
  );
}

/** Where a call about one lane has to go. */
export type LaneRoute =
  /** The tab's machine: pass `pin: null` (the existing unpinned path). */
  | { kind: "bound"; pin: null; machine: LaneMachine }
  /** Another machine: pass this pin. */
  | { kind: "pinned"; pin: OpenProjectBinding; machine: LaneMachine }
  /** The machine is known but cannot be addressed (no binding): do not send. */
  | { kind: "unroutable"; pin: null; machine: LaneMachine }
  /** No known machine holds this lane: do not send. */
  | { kind: "unknown"; pin: null; machine: null };

export type LaneMachineRouter = {
  /**
   * Resolve a lane to its machine. Pass `machineId` whenever the caller knows
   * which machine the lane came from (a PR row, an automation rule, a history
   * item read from one machine): lane ids can exist on two machines at once.
   * Without it, the tab's machine wins, then the first other machine that
   * reports the lane.
   */
  route: (laneId: string | null | undefined, machineId?: string | null) => LaneRoute;
  /**
   * Convenience for `route(...).pin`. CAUTION: returns null both for "the tab's
   * machine" and for "unknown/unroutable". Callers that act (write, delete,
   * run) must use `route` and refuse the non-routable kinds.
   */
  pinForLane: (laneId: string | null | undefined, machineId?: string | null) => OpenProjectBinding | null;
  /** The machine entry for a machine id, or null. */
  machine: (machineId: string | null | undefined) => LaneMachine | null;
  /** Is `pin` still a machine this window can reach (see `isLivePinnedBinding`). */
  isLivePin: (pin: { key: string } | null | undefined) => boolean;
};

export function createLaneMachineRouter(all: AllMachineLanes): LaneMachineRouter {
  const laneIndex = new Map<string, MachineLane>();
  // First writer wins, and the active machine's lanes come first.
  for (const row of all.lanes) {
    if (!laneIndex.has(row.lane.id)) laneIndex.set(row.lane.id, row);
  }
  const liveBindings = all.machines
    .map((machine) => machine.binding)
    .filter((binding): binding is OpenProjectBinding => binding != null);
  const toRoute = (machine: LaneMachine): LaneRoute => {
    if (machine.isActiveBinding || (machine.routable && machine.pin == null)) {
      return { kind: "bound", pin: null, machine };
    }
    if (!machine.routable || !machine.pin) return { kind: "unroutable", pin: null, machine };
    return { kind: "pinned", pin: machine.pin, machine };
  };
  const route = (laneId: string | null | undefined, machineId?: string | null): LaneRoute => {
    const id = typeof laneId === "string" ? laneId.trim() : "";
    const wantedMachine = typeof machineId === "string" ? machineId.trim() : "";
    if (wantedMachine) {
      const machine = all.machinesById.get(wantedMachine);
      if (!machine) return { kind: "unknown", pin: null, machine: null };
      return toRoute(machine);
    }
    if (!id) return { kind: "unknown", pin: null, machine: null };
    const owner = laneIndex.get(id);
    if (!owner) return { kind: "unknown", pin: null, machine: null };
    return toRoute(owner);
  };
  return {
    route,
    pinForLane: (laneId, machineId) => route(laneId, machineId).pin,
    machine: (machineId) => (machineId ? all.machinesById.get(machineId) ?? null : null),
    isLivePin: (pin) => isLivePinnedBinding(pin, liveBindings),
  };
}

/**
 * The shared lane router for any tab. Joins the union sync while `active`.
 * Memoized on the union, so a tick that changes nothing returns the same
 * router.
 */
export function useLaneMachineRouter(active = true): LaneMachineRouter {
  const all = useAllMachineLanes(active);
  return useMemo(() => createLaneMachineRouter(all), [all]);
}
