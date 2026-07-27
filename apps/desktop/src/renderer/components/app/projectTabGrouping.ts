import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import type { OpenProjectBinding, RecentProjectSummary } from "../../../shared/types";

export const LOCAL_MACHINE_ID = "local";
export const LOCAL_MACHINE_NAME = "This Mac";

export type RemoteProjectTabBinding = Extract<OpenProjectBinding, { kind: "remote" }>;

/** One checkout of a repo, on one machine. */
export type ProjectTabMachine = {
  bindingKey: string;
  machineId: string;
  /** Absolute machine name. Never "remote" — that word has no fixed referent
   *  once the machine a tab is bound to can itself change. */
  machineName: string;
  isLocal: boolean;
  rootPath: string;
  displayName: string;
  laneCount?: number;
  iconDataUrl?: string | null;
};

/** One repo — the thing that gets a tab. */
export type ProjectTabGroup = {
  id: string;
  displayName: string;
  machines: ProjectTabMachine[];
  /** The machine this tab is currently bound to, when it is the active tab. */
  activeBindingKey: string | null;
};

function localMachine(tab: RecentProjectSummary): ProjectTabMachine {
  return {
    bindingKey: tab.rootPath,
    machineId: LOCAL_MACHINE_ID,
    machineName: LOCAL_MACHINE_NAME,
    isLocal: true,
    rootPath: tab.rootPath,
    displayName: tab.displayName,
    laneCount: tab.laneCount,
  };
}

function remoteMachine(binding: RemoteProjectTabBinding): ProjectTabMachine {
  return {
    bindingKey: binding.key,
    machineId: binding.targetId,
    machineName: binding.runtimeName,
    isLocal: false,
    rootPath: binding.rootPath,
    displayName: binding.displayName,
    iconDataUrl: binding.iconDataUrl,
  };
}

/**
 * Collapses the open local and remote project tabs into one tab per repository,
 * with the machine as a dimension inside it.
 *
 * The join key is the repo's normalized git origin. Two rules keep it honest:
 *
 * - A project with no resolvable origin is never merged with anything. It gets
 *   its own group keyed by its binding, so two unrelated origin-less folders
 *   can't collapse into one tab.
 * - At most one checkout per machine joins a group. A lane worktree shares its
 *   parent repo's origin, so without this a worktree tab and its parent tab
 *   would silently become one tab that can't represent both. Extra checkouts on
 *   an already-claimed machine stay as their own tabs.
 */
export function groupProjectTabs(args: {
  localTabs: readonly RecentProjectSummary[];
  remoteTabs: readonly RemoteProjectTabBinding[];
  /** Normalized origin per remote binding key, from the live connection
   *  snapshots the renderer already holds. */
  remoteOriginByKey?: Readonly<Record<string, string | null | undefined>>;
  activeBindingKey?: string | null;
}): ProjectTabGroup[] {
  const { localTabs, remoteTabs, remoteOriginByKey = {}, activeBindingKey = null } = args;

  const entries: { machine: ProjectTabMachine; origin: string | null }[] = [
    ...localTabs.map((tab) => ({
      machine: localMachine(tab),
      origin: normalizeGitRemoteIdentity(tab.gitOriginUrl),
    })),
    ...remoteTabs.map((binding) => ({
      machine: remoteMachine(binding),
      origin: normalizeGitRemoteIdentity(remoteOriginByKey[binding.key] ?? null),
    })),
  ];

  const groups: ProjectTabGroup[] = [];
  const groupByOrigin = new Map<string, ProjectTabGroup>();
  const claimedMachines = new Map<string, Set<string>>();

  const standalone = (machine: ProjectTabMachine): ProjectTabGroup => ({
    id: machine.bindingKey,
    displayName: machine.displayName,
    machines: [machine],
    activeBindingKey: machine.bindingKey === activeBindingKey ? machine.bindingKey : null,
  });

  for (const { machine, origin } of entries) {
    if (!origin) {
      groups.push(standalone(machine));
      continue;
    }
    const existing = groupByOrigin.get(origin);
    if (!existing) {
      const group = { ...standalone(machine), id: origin };
      groupByOrigin.set(origin, group);
      claimedMachines.set(origin, new Set([machine.machineId]));
      groups.push(group);
      continue;
    }
    const claimed = claimedMachines.get(origin)!;
    if (claimed.has(machine.machineId)) {
      // Second checkout of this repo on a machine that already has one — a lane
      // worktree beside its parent, typically. Keep it addressable on its own.
      groups.push(standalone(machine));
      continue;
    }
    claimed.add(machine.machineId);
    existing.machines.push(machine);
    if (machine.bindingKey === activeBindingKey) {
      existing.activeBindingKey = machine.bindingKey;
    }
  }

  return groups;
}

/** The machine a group is currently showing: the bound one, else its first. */
export function activeMachineForGroup(group: ProjectTabGroup): ProjectTabMachine | null {
  if (group.machines.length === 0) return null;
  return (
    group.machines.find((m) => m.bindingKey === group.activeBindingKey)
    ?? group.machines[0]
  );
}

/** True when a group spans more than one machine and therefore needs a picker. */
export function isMultiMachine(group: ProjectTabGroup): boolean {
  return group.machines.length > 1;
}
