/**
 * Every machine that holds this project, as call targets.
 *
 * Shared by the History, Automations and PRs tabs. A thin view over the shared
 * lane→machine router (`state/laneMachineRouting`), which reads the
 * cross-machine union plus the tab's own binding and joins the one ref-counted
 * union sync while the calling tab is visible. Nothing here opens a feed.
 *
 * Pin contract (matches preload `callPinnedOrBoundRuntimeActionOr`): a target's
 * `pin` is `null` for the machine the tab is bound to, so the common local path
 * stays exactly as it was, and a concrete binding for every other machine.
 * Machines the router cannot address (no binding yet) are left out: nothing
 * could be sent there, so they must not be offered as targets.
 */

import { useMemo } from "react";
import type { LaneSummary, OpenProjectBinding, PrSummary } from "../../../shared/types";
import { shouldShowMachineChips, useAllMachineLanes, type AllMachineLanes } from "../../state/laneMachineRouting";

export type ProjectMachineTarget = {
  /** Stable identity: the machine id. */
  key: string;
  machineId: string;
  /** Absolute machine name; never the word "remote". */
  machineName: string;
  /** `null` = the tab's binding (unpinned path). Otherwise the owning machine. */
  pin: OpenProjectBinding | null;
  /** The effective binding, even for the tab's own machine. */
  binding: OpenProjectBinding | null;
  online: boolean;
  /** The physical Mac this app runs on. */
  isThisMachine: boolean;
  /** The machine the project tab is bound to. */
  isActive: boolean;
  lanes: readonly LaneSummary[];
  /** The machine's mapped PR rows. Empty for the active machine (PrsContext owns those). */
  prs: readonly PrSummary[];
};

const EMPTY_PRS: readonly PrSummary[] = [];

export function projectMachineTargetsFrom(all: AllMachineLanes): ProjectMachineTarget[] {
  const lanesByMachine = new Map<string, LaneSummary[]>();
  for (const row of all.lanes) {
    const list = lanesByMachine.get(row.machineId);
    if (list) list.push(row.lane);
    else lanesByMachine.set(row.machineId, [row.lane]);
  }
  const targets: ProjectMachineTarget[] = [];
  for (const machine of all.machines) {
    if (!machine.isActiveBinding && (!machine.routable || !machine.pin)) continue;
    targets.push({
      key: machine.machineId,
      machineId: machine.machineId,
      machineName: machine.machineName,
      pin: machine.isActiveBinding ? null : machine.pin,
      binding: machine.binding,
      online: machine.online,
      isThisMachine: machine.isThisMachine,
      isActive: machine.isActiveBinding,
      lanes: lanesByMachine.get(machine.machineId) ?? [],
      prs: machine.isActiveBinding ? EMPTY_PRS : all.prsByMachineId.get(machine.machineId) ?? EMPTY_PRS,
    });
  }
  return targets;
}

/**
 * All machines for this project: the bound one first, then every other machine
 * the union knows about (online or not — offline machines are dimmed, not hidden).
 */
export function useProjectMachineTargets(active = true): ProjectMachineTarget[] {
  const all = useAllMachineLanes(active);
  return useMemo(() => projectMachineTargetsFrom(all), [all]);
}

export function targetByKey(
  targets: readonly ProjectMachineTarget[],
  key: string | null | undefined,
): ProjectMachineTarget | null {
  if (!key) return null;
  return targets.find((target) => target.key === key) ?? null;
}

/** What a machine chip renders. */
export type MachineChipModel = {
  machineId: string;
  machineName: string;
  online: boolean;
  isThisMachine: boolean;
};

/**
 * The chip for a row, per the shared rule (`shouldShowMachineChips` in
 * `state/laneMachineRouting`): every row once the project spans machines,
 * none on a one-machine project.
 */
export function machineChipForTarget(
  target: ProjectMachineTarget | null | undefined,
  machines: { readonly length: number },
): MachineChipModel | null {
  if (!target || !shouldShowMachineChips(machines)) return null;
  return {
    machineId: target.machineId,
    machineName: target.machineName,
    online: target.online,
    isThisMachine: target.isThisMachine,
  };
}

export function offlineMessage(target: Pick<ProjectMachineTarget, "machineName">): string {
  return `${target.machineName} is offline`;
}

/** Upper bound on one machine's read, so a wedged machine never holds a list. */
export const MACHINE_READ_TIMEOUT_MS = 8_000;

/** Reject after `ms`; the underlying call is left to settle on its own. */
export function withMachineTimeout<T>(
  promise: Promise<T>,
  machineName: string,
  ms = MACHINE_READ_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${machineName} did not answer in time`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
