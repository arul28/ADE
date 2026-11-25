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
 * A pin addresses one copy on one machine. `LaneMachine.pin` is set for every
 * routable machine, the tab's own included; it is null only when nothing can
 * be sent there. "Is this the tab's machine" is `isActiveBinding`, never a null
 * pin. Lane ids are unique per machine, not globally (lane
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

import { savedChatsMachineKey } from "../../shared/cloudSavedChats";
import { useMemo, useState } from "react";
import type {
  LaneSummary,
  OpenProjectBinding,
  PrSummary,
  RemoteRuntimeConnectionStatus,
  TerminalSessionSummary,
} from "../../shared/types";
import type { CloudLaneWithoutComputer } from "../../shared/cloudLaneLaunch";
import { distinctMachineNames, machineIdOfSlot, THIS_MACHINE_ID, THIS_MACHINE_NAME } from "../../shared/machineIdentity";
import { formatMachineVersions } from "../../shared/machineVersions";
import type { MachineAddress } from "../../shared/repositoryTab";
import { ADE_CLOUD_MACHINE_ID } from "../../shared/adeCloudMachine";
import {
  adeCloudLaneComputerForMachine,
  adeCloudLaneComputersNow,
  machineLabelForMachine,
  useAdeCloudLaneComputers,
  type AdeCloudComputerId,
  type AdeCloudLaneComputer,
} from "./adeCloudLaneIndex";
import {
  useAppStore,
  useRootAppStore,
  type CrossMachineMachineLanes,
} from "./appStore";
import { listedLanesOfMachine } from "./cloudRestingRows";
import { useCrossMachineLaneSync } from "./crossMachineLanes";
import { LANES_MACHINE_FILTER_ALL } from "./laneMachineFilterIds";

/** One version, or both when the machine's app and brain drift ("1.2.123 · brain 1.2.125"). */
function connectionVersionLabel(
  connection: { version: string | null; appVersion?: string | null } | null | undefined,
): string | null {
  return connection?.version ? formatMachineVersions({ brainVersion: connection.version, appVersion: connection.appVersion }) : null;
}

/** One machine that holds (or could hold) the active project's repo. */
export type LaneMachine = {
  machineId: string;
  /** Absolute machine name; never the word "remote". */
  machineName: string;
  online: boolean;
  /** The physical Mac this app runs on. */
  isThisMachine: boolean;
  /** The machine the project tab is bound to. Read this, not a null pin. */
  isActiveBinding: boolean;
  /**
   * The binding that addresses this machine's checkout of the repo. For the
   * active machine it is the tab's own binding (null only before a project is
   * open). For another machine, null means it cannot be addressed yet.
   */
  binding: OpenProjectBinding | null;
  /**
   * The pin to pass to preload calls: this machine's copy of the repo, the
   * tab's own included. Null only when nothing can be sent there.
   */
  pin: OpenProjectBinding | null;
  /** The same address as `pin`, under the repository-tab name. */
  address: MachineAddress | null;
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
  /**
   * The brain's own version, bare ("1.2.125"). `version` is a label that can
   * name the app too; anything the brain runs (automations) compares this.
   * Optional: rows built elsewhere (the Lanes page, an ADE Cloud lane with no
   * computer) have no brain to name.
   */
  brainVersion?: string | null;
  /**
   * Whether another machine's brain answers its own settings with no project
   * (`shared/machineScope.ts`): false for an older brain, unset until its
   * connection reports capabilities, and for This computer.
   */
  machineScope?: boolean;
  /**
   * The domains that brain answers there (`MACHINE_SCOPE_DOMAINS`). Unset with
   * `machineScope` true: a brain of the route's first version, which answers
   * none of `MACHINE_SCOPE_LATER_DOMAINS`.
   */
  machineScopeDomains?: readonly string[];
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
  /** The ADE Cloud group, present only when the caller passes the `adeCloud` input. */
  adeCloud?: AdeCloudLaneGroup;
};

/**
 * The project's ADE Cloud lanes, as one group: the lanes on its lane
 * computers (which the union already lists as machines) and the lanes kept
 * without a computer. Each lane computer holds one lane.
 */
export type AdeCloudLaneGroup = {
  /** Machines of the union that are a lane's own ADE Cloud computer. */
  machineIds: string[];
  /** Lanes on those machines, as the union lists them. */
  lanes: MachineLane[];
  /** This project's ADE Cloud lanes that have no computer now. */
  withoutComputer: CloudLaneWithoutComputer[];
};

/**
 * When the project spans more than one known machine, the machine filter
 * chips appear. A row's own chip follows `rowMachineChip`.
 */
export function shouldShowMachineChips(machineCount: number): boolean {
  return machineCount > 1;
}

/** What a machine chip renders. */
export type MachineChipModel = Pick<LaneMachine, "machineId" | "machineName" | "online" | "isThisMachine">;

/** The chip for a machine (a filter chip names every machine). */
export function machineChipFor(machine: MachineChipModel): MachineChipModel {
  return {
    machineId: machine.machineId,
    machineName: machine.machineName,
    online: machine.online,
    isThisMachine: machine.isThisMachine,
  };
}

/**
 * The chip of a row (a lane, a PR's lane, a rule, an event): a row names its
 * computer only when that computer is not this one. The rule is the same in
 * every tab, and it never depends on the machine the tab reads from.
 */
export function rowMachineChip(machine: MachineChipModel | null | undefined): MachineChipModel | null {
  return machine && !machine.isThisMachine ? machineChipFor(machine) : null;
}

/* ---- The Lanes sidebar's Computer filter ---- */

/**
 * One entry in the Lanes sidebar's Computer filter, in menu order: `All`, each
 * computer the person owns, then `ADE Cloud` (one entry for every cloud
 * computer, and the cloud lanes whose computer was deleted).
 */
export type LaneMachineFilterEntry = {
  /** `"all"`, a computer id, or `ADE_CLOUD_MACHINE_ID`. */
  id: string;
  name: string;
  kind: "all" | "computer" | "cloud";
  /** Lanes this entry reveals right now. */
  laneCount: number;
  /** The tab's own computer: it leads the list, right after All. */
  isThisMachine: boolean;
};

/** A listed machine as the filter sees it: one per union slice (a computer may have two checkouts). */
export type LaneMachineFilterMachine = {
  /** `laneFilterEntryId(machine.machineId, isCloud)`; two slices of one computer share it. */
  entryId: string;
  name: string;
  isCloud: boolean;
  isThisMachine: boolean;
  /** Lanes this slice contributes. */
  laneCount: number;
};

/**
 * The entry a machine belongs to. Every ADE Cloud computer is one entry: the
 * person has no single cloud computers to pick from. Everything else is one
 * entry per computer, so two checkouts of one computer do not get two entries.
 */
export function laneFilterEntryId(machineId: string, isCloudMachine: boolean): string {
  return isCloudMachine ? ADE_CLOUD_MACHINE_ID : machineIdOfSlot(machineId);
}

/**
 * Every entry of the Computer filter, from the machines the list is showing.
 * Pure: names, counts and cloud-ness are decided by the caller, which holds the
 * cloud index and the lane labels.
 */
export function buildLaneMachineFilterEntries(input: {
  machines: readonly LaneMachineFilterMachine[];
}): LaneMachineFilterEntry[] {
  const byEntryId = new Map<string, LaneMachineFilterEntry>();
  for (const machine of input.machines) {
    // A computer with no lanes of this project reveals nothing: it is not a
    // choice, and picking it would leave an empty list.
    if (machine.laneCount <= 0) continue;
    const known = byEntryId.get(machine.entryId);
    if (known) {
      known.laneCount += machine.laneCount;
      known.isThisMachine ||= machine.isThisMachine;
      continue;
    }
    byEntryId.set(machine.entryId, {
      id: machine.entryId,
      name: machine.name,
      kind: machine.isCloud ? "cloud" : "computer",
      laneCount: machine.laneCount,
      isThisMachine: machine.isThisMachine,
    });
  }
  const computers = [...byEntryId.values()]
    .filter((entry) => entry.kind === "computer")
    .sort((a, b) => Number(b.isThisMachine) - Number(a.isThisMachine) || a.name.localeCompare(b.name));
  const cloud = byEntryId.get(ADE_CLOUD_MACHINE_ID) ?? null;
  return [
    {
      id: LANES_MACHINE_FILTER_ALL,
      name: "All",
      kind: "all",
      laneCount: computers.reduce((sum, entry) => sum + entry.laneCount, 0) + (cloud?.laneCount ?? 0),
      isThisMachine: false,
    },
    ...computers,
    ...(cloud ? [cloud] : []),
  ];
}

/**
 * The entry the chosen filter reads as: the stored one while its entry is
 * listed, else `"all"`. A computer that went offline (its lanes left the list)
 * or an entry this ADE no longer offers must not leave the sidebar looking empty
 * with nothing to click to undo it.
 */
export function effectiveLaneMachineFilter(
  stored: string,
  entries: readonly Pick<LaneMachineFilterEntry, "id">[],
): string {
  return stored !== LANES_MACHINE_FILTER_ALL && entries.some((entry) => entry.id === stored)
    ? stored
    : LANES_MACHINE_FILTER_ALL;
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

/**
 * A session's lane on another machine: its Lanes-tab row key, the lane, and
 * why it can't be acted on right now (null when it can).
 */
export type ForeignSessionLane = { key: string; lane: LaneSummary; blockedReason: string | null };

/**
 * Each other machine's sessions → their lanes, from the live union the Lanes
 * tab lists (not the Work sidebar's retained slices), so every key here is one
 * the Lanes tab can resolve. The tab's own machine is skipped, as
 * `buildAllMachineLanes` does. Keyed machine first: two machines can report
 * the same session id.
 */
export function buildForeignSessionLanes(
  machines: Record<string, CrossMachineMachineLanes>,
  activeMachineId: string,
): Map<string, Map<string, ForeignSessionLane>> {
  const byMachineId = new Map<string, Map<string, ForeignSessionLane>>();
  for (const entry of Object.values(machines)) {
    if (entry.machineId === activeMachineId) continue;
    const blockedReason = machineBlockedReason({
      machineName: entry.machineName?.trim() || entry.machineId,
      online: entry.online,
      routable: entry.binding != null,
    });
    const lanesById = new Map(entry.lanes.map((lane) => [lane.id, lane] as const));
    const bySessionId = new Map<string, ForeignSessionLane>();
    for (const session of entry.sessions) {
      const lane = lanesById.get(session.laneId);
      if (lane) bySessionId.set(session.id, { key: foreignLaneKey(entry.machineId, lane.id), lane, blockedReason });
    }
    byMachineId.set(entry.machineId, bySessionId);
  }
  return byMachineId;
}

/**
 * The machines a call can be sent to (the tab's own, and every addressable
 * other). A cloud computer's saved chats (`cloud-saved:<key>`, listed while it
 * isn't connected) are left out: they answer only for those chats, and
 * anything more would have to wake the computer.
 */
export function routableMachines(machines: readonly LaneMachine[]): LaneMachine[] {
  return machines.filter((machine) => machine.routable && savedChatsMachineKey(machine.machineId) == null);
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

/** `LaneMachine.machineScope` from a connection, once it reported capabilities. */
function connectionMachineScope(connection: RemoteRuntimeConnectionStatus | undefined): Pick<LaneMachine, "machineScope" | "machineScopeDomains"> {
  const capabilities = connection?.capabilities;
  if (!capabilities) return {};
  return {
    machineScope: capabilities.machineScope === true,
    ...(capabilities.machineScope === true && capabilities.machineScopeDomains
      ? { machineScopeDomains: capabilities.machineScopeDomains }
      : {}),
  };
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
  /**
   * The account's ADE Cloud lane computers (`useAdeCloudLaneComputers`), which
   * name the cloud machines; a hook passes the ones it renders from, so its
   * memo follows them. With the lanes without a computer
   * (`useCloudLanesWithoutComputer`) and the repo's normalized origin too, the
   * result also carries `adeCloud`.
   */
  adeCloud?: {
    computers: readonly AdeCloudLaneComputer[];
    /** Every ADE Cloud computer of the index (`useAdeCloudLaneComputers().cloudComputers`); else the ones last read. */
    cloudComputers?: readonly AdeCloudComputerId[];
    withoutComputer?: readonly CloudLaneWithoutComputer[];
    repoOriginIdentity?: string | null;
  };
}): AllMachineLanes {
  const activeBinding = input.activeBinding ?? null;
  // What a person sees: an ADE Cloud computer reads "ADE Cloud" (known from the
  // lane computers passed, else, for a caller outside React, the ones last
  // read); every other machine keeps its own name.
  const laneComputers = input.adeCloud?.computers ?? adeCloudLaneComputersNow();
  const labelFor = (hostname: string | null, machineId: string, name: string): string =>
    machineLabelForMachine({ hostname, machineKey: machineId, name }, laneComputers);
  const shownName = (binding: OpenProjectBinding | null, machineId: string, name: string): string =>
    labelFor(binding?.kind === "remote" ? binding.hostname ?? null : null, machineId, name);
  const active = activeMachineFor(activeBinding);
  const activeSlice = input.machines[active.machineId];
  const connectionById = new Map((input.connections ?? []).map((connection) => [connection.target.id, connection]));
  const thisDeviceId = input.thisMachineDeviceId ?? null;
  const activeConnection = activeBinding?.kind === "remote" ? connectionById.get(activeBinding.targetId) : undefined;

  const activeMachine: LaneMachine = {
    machineId: active.machineId,
    machineName: shownName(activeBinding, active.machineId, active.machineName),
    // A local binding is reachable by definition. A remote one follows its
    // union slice; before the first read, the connection snapshot; before
    // that, reachable (the tab would not be bound to it otherwise).
    online: activeBinding?.kind === "remote"
      ? activeSlice?.online ?? (activeConnection ? connectionOnline(activeConnection) : true)
      : true,
    isThisMachine: active.machineId === THIS_MACHINE_ID,
    isActiveBinding: true,
    binding: activeBinding,
    pin: activeBinding,
    address: activeBinding,
    routable: true,
    hasRepo: activeBinding != null,
    deviceId: activeBinding?.kind === "remote" ? connectionDeviceId(activeConnection) : thisDeviceId,
    hostname: activeBinding?.kind === "remote"
      ? activeConnection?.target.hostname ?? activeBinding.hostname ?? null
      : null,
    version: connectionVersionLabel(activeConnection),
    brainVersion: activeConnection?.version?.trim() || null,
    // The tab's remote reports its machine route like every other machine (none for a local tab).
    ...connectionMachineScope(activeConnection),
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
    // A computer that is gone from the account holds no copy of the repository.
    // The union keeps it only for its saved chats, so no lane surface lists it.
    if (entry.computerGone === true) continue;
    const binding = entry.binding ?? null;
    // A second checkout on a computer has a slice id of its own; the computer is the part before it.
    const ownMachineId = machineIdOfSlot(entry.machineId);
    const connection = connectionById.get(entry.targetId ?? ownMachineId);
    const isThisMachine = ownMachineId === THIS_MACHINE_ID;
    const pin = binding;
    const machine: LaneMachine = {
      machineId: entry.machineId,
      machineName: shownName(binding, ownMachineId, entry.machineName?.trim() || connection?.target.name?.trim() || ownMachineId),
      online: entry.online,
      isThisMachine,
      isActiveBinding: false,
      binding,
      pin,
      address: binding,
      routable: binding != null,
      // The union only carries machines matched on the repo's origin.
      hasRepo: true,
      deviceId: isThisMachine ? thisDeviceId : connectionDeviceId(connection),
      hostname: connection?.target.hostname ?? (binding?.kind === "remote" ? binding.hostname ?? null : null),
      version: connectionVersionLabel(connection),
      brainVersion: connection?.version?.trim() || null,
      ...connectionMachineScope(connection),
    };
    machines.push(machine);
    prsByMachineId.set(entry.machineId, entry.prs);
    sessionsByMachineId.set(entry.machineId, entry.sessions);
    const machineLanes: LaneSummary[] = [];
    const seen = new Set<string>();
    // An ADE Cloud lane computer adds no main checkout, awake or asleep.
    for (const lane of listedLanesOfMachine(entry, laneComputers, input.adeCloud?.cloudComputers)) {
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
    const noRepo = (overrides: Pick<LaneMachine, "machineId" | "machineName" | "online" | "isThisMachine" | "deviceId" | "hostname" | "version" | "brainVersion" | "machineScope" | "machineScopeDomains">): LaneMachine => ({
      ...overrides,
      isActiveBinding: false,
      binding: null,
      pin: null,
      address: null,
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
        machineName: labelFor(connection.target.hostname ?? null, connection.target.id, connection.target.name?.trim() || connection.target.hostname || connection.target.id),
        online: connectionOnline(connection),
        isThisMachine: false,
        deviceId: connectionDeviceId(connection),
        hostname: connection.target.hostname ?? null,
        version: connectionVersionLabel(connection),
        brainVersion: connection.version?.trim() || null,
        ...connectionMachineScope(connection),
      }));
    }
  }

  // Two computers that share a name ("Arul's Mac Studio" twice) are told
  // apart here, once, for every list and picker built from this.
  // A computer with two checkouts is one computer here: its slices share its label.
  const namedOnce = new Map<string, LaneMachine>();
  for (const machine of [...machines, ...machinesWithoutRepo]) {
    const ownId = machineIdOfSlot(machine.machineId);
    if (!namedOnce.has(ownId)) namedOnce.set(ownId, machine);
  }
  const shown = distinctMachineNames([...namedOnce].map(([id, machine]) => ({
    id,
    name: machine.machineName,
    isThisMachine: machine.isThisMachine,
    hostname: machine.hostname,
    deviceId: machine.deviceId,
  })));
  const distinctLabelOf = (machine: LaneMachine) => shown.get(machineIdOfSlot(machine.machineId));
  const renamed = (machine: LaneMachine) => {
    const name = distinctLabelOf(machine);
    return name != null && name !== machine.machineName;
  };
  const relabel = <T extends LaneMachine>(machine: T): T =>
    renamed(machine) ? { ...machine, machineName: distinctLabelOf(machine)! } : machine;
  if (machines.some(renamed) || machinesWithoutRepo.some(renamed)) {
    machines.splice(0, machines.length, ...machines.map(relabel));
    machinesWithoutRepo.splice(0, machinesWithoutRepo.length, ...machinesWithoutRepo.map(relabel));
    lanes.splice(0, lanes.length, ...lanes.map(relabel));
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
    ...(input.adeCloud?.withoutComputer
      ? { adeCloud: buildAdeCloudLaneGroup(machines, lanes, { ...input.adeCloud, withoutComputer: input.adeCloud.withoutComputer }) }
      : {}),
  };
}

function buildAdeCloudLaneGroup(
  machines: readonly LaneMachine[],
  lanes: readonly MachineLane[],
  input: NonNullable<Parameters<typeof buildAllMachineLanes>[0]["adeCloud"]> & { withoutComputer: readonly CloudLaneWithoutComputer[] },
): AdeCloudLaneGroup {
  const origin = input.repoOriginIdentity?.trim().toLowerCase() || null;
  // A computer with no recorded origin is kept: the union only lists machines
  // matched on this repo, so a lane computer it carries is this project's.
  const computers = input.computers.filter((computer) => !origin || !computer.projectOrigin || computer.projectOrigin === origin);
  const machineIds = machines
    .filter((machine) => adeCloudLaneComputerForMachine({ hostname: machine.hostname, targetId: machine.machineId }, computers) != null)
    .map((machine) => machine.machineId);
  const cloudIds = new Set(machineIds);
  return {
    machineIds,
    lanes: lanes.filter((row) => cloudIds.has(row.machineId)),
    // A lane kept without a computer is matched on its origin only; with no
    // origin to match, none is this project's.
    withoutComputer: origin ? input.withoutComputer.filter((lane) => lane.projectOrigin === origin) : [],
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
  const { computers, cloudComputers } = useAdeCloudLaneComputers();
  return useMemo(
    () => buildAllMachineLanes({ activeBinding: activeBinding ?? null, activeLanes, machines: machines ?? {}, adeCloud: { computers, cloudComputers } }),
    [activeBinding, activeLanes, machines, computers, cloudComputers],
  );
}

/** Where a call about one lane has to go. */
export type LaneRoute =
  /** Pass this pin; `machine.isActiveBinding` says whether it is the tab's machine. */
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
