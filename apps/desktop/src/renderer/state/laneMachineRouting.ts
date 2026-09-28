/**
 * The one machine model for every tab that is not Work.
 *
 * A lane owns its machine (`worktree_path` is absolute on exactly one), so every
 * read and action on a lane must reach THAT machine. This module owns the answer
 * to "which machines hold this project, which one owns lane X, and what pin do I
 * pass": the machine shape, its pin, the lane route, the chip model, the blocked
 * reason and the trailing pin argument. Work keeps its own session-aware router
 * in `components/terminals/useWorkMachineRouter.ts`.
 *
 * Pin semantics are the preload's: `null` means "the machine this project tab
 * is bound to" (the unpinned path). A non-null pin is a binding for another
 * machine. `LaneMachine.pin` is already null for the tab's own machine, so
 * callers pass it as is. Lane ids are unique per machine, not globally (lane
 * rows sync between machines), so whenever a caller knows which machine a lane
 * came from it must say so; resolving a bare id prefers the tab's machine.
 *
 * Online rule, shared by every surface: a machine the union carries is online
 * exactly when its union slice says so. The remote-runtime connection snapshot
 * only fills in machines the union has no slice for (the tab's own remote
 * machine before its first read, machines connected without this repository).
 *
 * Cost: everything here derives from renderer state that already exists. The
 * only side effect is joining the shared, ref-counted union sync
 * (`useCrossMachineLaneSync`) while a surface that lists other machines is
 * visible, never a new polling loop.
 */

import { useMemo, useState } from "react";
import type {
  LaneSummary,
  OpenProjectBinding,
  PrSummary,
  RemoteRuntimeConnectionStatus,
  TerminalSessionSummary,
} from "../../shared/types";
import { THIS_MACHINE_ID, THIS_MACHINE_NAME } from "../../shared/machineIdentity";
import {
  useAppStore,
  useRootAppStore,
  type CrossMachineMachineLanes,
} from "./appStore";
import { useCrossMachineLaneSync } from "./crossMachineLanes";

/** One machine that holds (or could hold) the active project's repo. */
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
  /** Whether this machine holds a checkout of the active repo. */
  hasRepo: boolean;
  /**
   * Account-wide identity (the sync device id): the local one for This
   * computer, the paired host identity for a paired machine. Null for SSH
   * targets and until the enrichment inputs are known.
   */
  deviceId: string | null;
  /** Network host name, when the target record carries one. */
  hostname: string | null;
  /** ADE runtime version the machine reported. Null for This computer. */
  version: string | null;
};

/** One lane, tagged with the machine that owns it. */
export type MachineLane = LaneMachine & {
  /**
   * Stable, collision-free row key. The bare lane id for lanes on the active
   * machine (the id the store's selection holds), and
   * `${machineId}:${laneId}` for lanes on any other machine, the same form the
   * Work sidebar uses.
   */
  key: string;
  /** The machine's own lane record. `lane.id` is only unique on that machine. */
  lane: LaneSummary;
};

export type AllMachineLanes = {
  /** Every machine with this repo: the active machine first, then the union's. */
  machines: LaneMachine[];
  machinesById: ReadonlyMap<string, LaneMachine>;
  /**
   * Machines known from the connection snapshot (or This computer) that hold
   * no checkout of this repo. Empty unless the enrichment inputs are passed.
   * Never routable; listed only by surfaces about machines themselves.
   */
  machinesWithoutRepo: LaneMachine[];
  /** Every lane on every machine, active machine's lanes first. */
  lanes: MachineLane[];
  lanesByKey: ReadonlyMap<string, MachineLane>;
  /** Each machine's own lane records, keyed by machine id. */
  lanesByMachineId: ReadonlyMap<string, LaneSummary[]>;
  /** Each other machine's mapped PR records, keyed by machine id. */
  prsByMachineId: ReadonlyMap<string, PrSummary[]>;
  /** Each other machine's session roster, keyed by machine id. */
  sessionsByMachineId: ReadonlyMap<string, TerminalSessionSummary[]>;
};

/**
 * The machine-chip rule shared by every tab: when the project spans more than
 * one known machine, EVERY row shows a machine chip (this machine's included)
 * and the machine filter chips appear. With one machine, no chips.
 */
export function shouldShowMachineChips(machineCount: number): boolean {
  return machineCount > 1;
}

/** What a machine chip renders. */
export type MachineChipModel = Pick<LaneMachine, "machineId" | "machineName" | "online" | "isThisMachine">;

/** The chip for a machine. Callers gate it with `shouldShowMachineChips`. */
export function machineChipFor(machine: MachineChipModel): MachineChipModel {
  return {
    machineId: machine.machineId,
    machineName: machine.machineName,
    online: machine.online,
    isThisMachine: machine.isThisMachine,
  };
}

/**
 * Why nothing can be sent to this machine right now, or null when it can.
 * One wording everywhere: "<Machine> is offline" / "<Machine> is unavailable".
 */
export function machineBlockedReason(
  machine: Pick<LaneMachine, "machineName" | "online" | "routable"> | null | undefined,
): string | null {
  if (!machine) return null;
  if (!machine.online) return `${machine.machineName} is offline`;
  if (!machine.routable) return `${machine.machineName} is unavailable`;
  return null;
}

/**
 * The trailing pin argument for a preload call: nothing for the tab's machine
 * (the unpinned call, arity included), `[pin]` for another machine.
 */
export function pinArg(pin: OpenProjectBinding | null | undefined): [] | [OpenProjectBinding] {
  return pin ? [pin] : [];
}

/**
 * `binding`, held by its key: the same object back until the key changes. The
 * lane union re-derives on every sync tick, and a fresh pin object each time
 * would re-run every read that depends on it.
 */
export function useStableBinding<T extends { key: string }>(binding: T | null): T | null {
  const [stable, setStable] = useState(binding);
  if ((stable?.key ?? null) !== (binding?.key ?? null)) {
    setStable(binding);
    return binding;
  }
  return stable;
}

/** Row key for a lane on a machine other than the tab's. */
export function foreignLaneKey(machineId: string, laneId: string): string {
  return `${machineId}:${laneId}`;
}

/** The machines a call can be sent to (the tab's own, and every addressable other). */
export function routableMachines(machines: readonly LaneMachine[]): LaneMachine[] {
  return machines.filter((machine) => machine.routable);
}

function activeMachineFor(binding: OpenProjectBinding | null): { machineId: string; machineName: string } {
  return binding?.kind === "remote"
    ? { machineId: binding.targetId, machineName: binding.runtimeName }
    : { machineId: THIS_MACHINE_ID, machineName: THIS_MACHINE_NAME };
}

/** A remote connection counts as online only while it is connected. */
export function connectionOnline(connection: RemoteRuntimeConnectionStatus | undefined): boolean {
  return connection?.state === "connected";
}

function connectionDeviceId(connection: RemoteRuntimeConnectionStatus | undefined): string | null {
  return connection?.target.pairedMachine?.hostIdentity?.trim() || null;
}

/**
 * Pure derivation of {@link AllMachineLanes}; it performs no I/O. The optional
 * `connections` and `thisMachineDeviceId` enrich the machines with identity and
 * version and list connected machines without this repo; surfaces that only
 * route lanes leave them out.
 */
export function buildAllMachineLanes(input: {
  activeBinding: OpenProjectBinding | null;
  activeLanes: readonly LaneSummary[];
  machines: Readonly<Record<string, CrossMachineMachineLanes>>;
  connections?: readonly RemoteRuntimeConnectionStatus[];
  thisMachineDeviceId?: string | null;
}): AllMachineLanes {
  const activeBinding = input.activeBinding ?? null;
  const active = activeMachineFor(activeBinding);
  const activeSlice = input.machines[active.machineId];
  const connectionById = new Map((input.connections ?? []).map((connection) => [connection.target.id, connection]));
  const thisDeviceId = input.thisMachineDeviceId ?? null;
  const activeConnection = activeBinding?.kind === "remote" ? connectionById.get(activeBinding.targetId) : undefined;

  const activeMachine: LaneMachine = {
    machineId: active.machineId,
    machineName: active.machineName,
    // A local binding is reachable by definition. A remote one follows its
    // union slice; before the first read, the connection snapshot; before
    // that, reachable (the tab would not be bound to it otherwise).
    online: activeBinding?.kind === "remote"
      ? activeSlice?.online ?? (activeConnection ? connectionOnline(activeConnection) : true)
      : true,
    isThisMachine: active.machineId === THIS_MACHINE_ID,
    isActiveBinding: true,
    binding: activeBinding,
    pin: null,
    routable: true,
    hasRepo: activeBinding != null,
    deviceId: activeBinding?.kind === "remote" ? connectionDeviceId(activeConnection) : thisDeviceId,
    hostname: activeBinding?.kind === "remote"
      ? activeConnection?.target.hostname ?? activeBinding.hostname ?? null
      : null,
    version: activeConnection?.version ?? null,
  };
  const machines: LaneMachine[] = [activeMachine];
  const lanes: MachineLane[] = [];
  const lanesByMachineId = new Map<string, LaneSummary[]>();
  const activeLaneList: LaneSummary[] = [];
  const seenActive = new Set<string>();
  for (const lane of input.activeLanes) {
    if (seenActive.has(lane.id)) continue;
    seenActive.add(lane.id);
    activeLaneList.push(lane);
    lanes.push({ ...activeMachine, key: lane.id, lane });
  }
  lanesByMachineId.set(activeMachine.machineId, activeLaneList);
  const prsByMachineId = new Map<string, PrSummary[]>();
  const sessionsByMachineId = new Map<string, TerminalSessionSummary[]>();
  for (const entry of Object.values(input.machines)) {
    // The active machine is represented by the tab's own lane list above; the
    // union may still hold a (stale) slice for it.
    if (entry.machineId === active.machineId) continue;
    const binding = entry.binding ?? null;
    const connection = connectionById.get(entry.targetId ?? entry.machineId);
    const isThisMachine = entry.machineId === THIS_MACHINE_ID;
    // Defensive: a slice whose binding IS the tab's binding takes the unpinned
    // path, exactly like the chat router resolves it.
    const pin = binding && binding.key === activeBinding?.key ? null : binding;
    const machine: LaneMachine = {
      machineId: entry.machineId,
      machineName: entry.machineName?.trim() || connection?.target.name?.trim() || entry.machineId,
      online: entry.online,
      isThisMachine,
      isActiveBinding: false,
      binding,
      pin,
      routable: binding != null,
      // The union only carries machines matched on the repo's origin.
      hasRepo: true,
      deviceId: isThisMachine ? thisDeviceId : connectionDeviceId(connection),
      hostname: connection?.target.hostname ?? (binding?.kind === "remote" ? binding.hostname ?? null : null),
      version: connection?.version ?? null,
    };
    machines.push(machine);
    prsByMachineId.set(entry.machineId, entry.prs);
    sessionsByMachineId.set(entry.machineId, entry.sessions);
    const machineLanes: LaneSummary[] = [];
    const seen = new Set<string>();
    for (const lane of entry.lanes) {
      if (seen.has(lane.id)) continue;
      seen.add(lane.id);
      machineLanes.push(lane);
      lanes.push({ ...machine, key: foreignLaneKey(entry.machineId, lane.id), lane });
    }
    lanesByMachineId.set(entry.machineId, machineLanes);
  }

  const machinesWithoutRepo: LaneMachine[] = [];
  if (input.connections || input.thisMachineDeviceId !== undefined) {
    const listed = new Set(machines.map((machine) => machine.machineId));
    const noRepo = (overrides: Pick<LaneMachine, "machineId" | "machineName" | "online" | "isThisMachine" | "deviceId" | "hostname" | "version">): LaneMachine => ({
      ...overrides,
      isActiveBinding: false,
      binding: null,
      pin: null,
      routable: false,
      hasRepo: false,
    });
    // This computer is always a machine, even with no checkout of this repo.
    if (!listed.has(THIS_MACHINE_ID)) {
      machinesWithoutRepo.push(noRepo({
        machineId: THIS_MACHINE_ID,
        machineName: THIS_MACHINE_NAME,
        online: true,
        isThisMachine: true,
        deviceId: thisDeviceId,
        hostname: null,
        version: null,
      }));
    }
    const rest = (input.connections ?? [])
      .filter((connection) => !listed.has(connection.target.id))
      .sort((a, b) => Number(connectionOnline(b)) - Number(connectionOnline(a)));
    for (const connection of rest) {
      machinesWithoutRepo.push(noRepo({
        machineId: connection.target.id,
        machineName: connection.target.name?.trim() || connection.target.hostname || connection.target.id,
        online: connectionOnline(connection),
        isThisMachine: false,
        deviceId: connectionDeviceId(connection),
        hostname: connection.target.hostname ?? null,
        version: connection.version ?? null,
      }));
    }
  }

  return {
    machines,
    machinesById: new Map(machines.map((machine) => [machine.machineId, machine] as const)),
    machinesWithoutRepo,
    lanes,
    lanesByKey: new Map(lanes.map((row) => [row.key, row] as const)),
    lanesByMachineId,
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
  /** The tab's machine: pass `pin: null` (the unpinned path). */
  | { kind: "bound"; pin: null; machine: LaneMachine }
  /** Another machine: pass this pin. */
  | { kind: "pinned"; pin: OpenProjectBinding; machine: LaneMachine }
  /** The machine is known but cannot be addressed (no binding): do not send. */
  | { kind: "unroutable"; pin: null; machine: LaneMachine }
  /** No known machine holds this lane: do not send. */
  | { kind: "unknown"; pin: null; machine: null };

const UNKNOWN_ROUTE: LaneRoute = { kind: "unknown", pin: null, machine: null };

export type LaneMachineRouter = {
  /**
   * Resolve a lane to its machine. Pass `machineId` whenever the caller knows
   * which machine the lane came from (a PR row, an automation rule, a history
   * item read from one machine): lane ids can exist on two machines at once.
   * With `machineId`, a lane that machine does not list is `unknown`. Without
   * it, the tab's machine wins, then the first other machine that reports the
   * lane. With a machine but no lane id, the route is the machine's own.
   */
  route: (laneId: string | null | undefined, machineId?: string | null) => LaneRoute;
  /** The machine entry for a machine id, or null. */
  machine: (machineId: string | null | undefined) => LaneMachine | null;
};

export function createLaneMachineRouter(all: AllMachineLanes): LaneMachineRouter {
  const laneIndex = new Map<string, MachineLane>();
  // First writer wins, and the active machine's lanes come first.
  for (const row of all.lanes) {
    if (!laneIndex.has(row.lane.id)) laneIndex.set(row.lane.id, row);
  }
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
      if (!machine) return UNKNOWN_ROUTE;
      if (!id) return toRoute(machine);
      const rowKey = machine.isActiveBinding ? id : foreignLaneKey(machine.machineId, id);
      const row = all.lanesByKey.get(rowKey);
      if (!row || row.machineId !== machine.machineId) return UNKNOWN_ROUTE;
      return toRoute(machine);
    }
    if (!id) return UNKNOWN_ROUTE;
    const owner = laneIndex.get(id);
    if (!owner) return UNKNOWN_ROUTE;
    return toRoute(owner);
  };
  return {
    route,
    machine: (machineId) => (machineId ? all.machinesById.get(machineId) ?? null : null),
  };
}
