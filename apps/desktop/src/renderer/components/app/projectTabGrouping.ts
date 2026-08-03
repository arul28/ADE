// Origin normalization is a URL/regex parse and the tab list re-derives on
// every connection-snapshot tick, so it goes through the shared per-URL cache.
import { cachedGitRemoteIdentity } from "../lanes/laneMachines";
import type {
  OpenProjectBinding,
  RecentProjectSummary,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeConnectionState,
} from "../../../shared/types";

import {
  THIS_MACHINE_ID as LOCAL_MACHINE_ID,
  THIS_MACHINE_NAME as LOCAL_MACHINE_NAME,
} from "../../../shared/machineIdentity";
import { remoteProjectBindingKey } from "../../../shared/projectIdentity";
export { LOCAL_MACHINE_ID, LOCAL_MACHINE_NAME };

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
  /** Full binding when the location can be opened without first becoming a tab. */
  binding?: OpenProjectBinding;
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
    binding: {
      kind: "local",
      key: `local:${tab.rootPath}`,
      rootPath: tab.rootPath,
      displayName: tab.displayName,
      gitOriginUrl: tab.gitOriginUrl,
    },
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
    binding,
  };
}

/**
 * Collapses the open local and remote project tabs into one tab per repository,
 * with the machine as a dimension inside it.
 *
 * The join key is the repo's normalized git origin. Three rules keep it honest:
 *
 * - A project with no resolvable origin is never merged with anything. It gets
 *   its own group keyed by its binding, so two unrelated origin-less folders
 *   can't collapse into one tab.
 * - An OPEN tab is never absorbed by another open tab. Only checkouts the user
 *   has not opened join an existing group. Two open tabs are two things the
 *   user asked to keep in front of them, and collapsing them produced a single
 *   tab whose machine changed every time the other tab was activated — the tab
 *   you left appeared to jump machines. Merging is for reaching a checkout you
 *   do NOT have open, which is exactly what the machine switcher is for.
 * - At most one checkout per machine joins a group. A lane worktree shares its
 *   parent repo's origin, so without this a worktree and its parent would
 *   silently become one tab that can't represent both.
 */
export function groupProjectTabs(args: {
  localTabs: readonly RecentProjectSummary[];
  remoteTabs: readonly RemoteProjectTabBinding[];
  /** Known-but-not-open locations. They are attached to an existing logical
   *  tab, but never create a tab by themselves. */
  knownLocalTabs?: readonly RecentProjectSummary[];
  knownRemoteTabs?: readonly RemoteProjectTabBinding[];
  /** Normalized origin per remote binding key, from the live connection
   *  snapshots the renderer already holds. */
  remoteOriginByKey?: Readonly<Record<string, string | null | undefined>>;
  activeBindingKey?: string | null;
  preferredBindingKeyByGroup?: Readonly<Record<string, string | null | undefined>>;
}): ProjectTabGroup[] {
  const {
    localTabs,
    remoteTabs,
    knownLocalTabs = [],
    knownRemoteTabs = [],
    remoteOriginByKey = {},
    activeBindingKey = null,
    preferredBindingKeyByGroup = {},
  } = args;

  const openEntries: { machine: ProjectTabMachine; origin: string | null }[] = [
    ...localTabs.map((tab) => ({
      machine: localMachine(tab),
      origin: cachedGitRemoteIdentity(tab.gitOriginUrl),
    })),
    ...remoteTabs.map((binding) => ({
      machine: remoteMachine(binding),
      origin: cachedGitRemoteIdentity(
        remoteOriginByKey[binding.key] ?? binding.gitOriginUrl ?? null,
      ),
    })),
  ];
  const knownEntries: { machine: ProjectTabMachine; origin: string | null }[] = [
    ...knownLocalTabs.map((tab) => ({
      machine: localMachine(tab),
      origin: cachedGitRemoteIdentity(tab.gitOriginUrl),
    })),
    ...knownRemoteTabs.map((binding) => ({
      machine: remoteMachine(binding),
      origin: cachedGitRemoteIdentity(
        remoteOriginByKey[binding.key] ?? binding.gitOriginUrl ?? null,
      ),
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

  for (const { machine, origin } of openEntries) {
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
    // Another open tab already holds this origin. Claim this machine so a
    // discovered counterpart cannot re-add it below, and give the tab its own
    // group — an open tab always keeps its own tab, and therefore its own
    // machine, no matter which tab is active.
    claimedMachines.get(origin)!.add(machine.machineId);
    groups.push(standalone(machine));
  }

  // Attach discovered counterparts only after open entries establish the tab
  // set. This is what lets an unopened local checkout appear in the machine
  // switcher without turning every recent project into an open tab.
  for (const { machine, origin } of knownEntries) {
    if (!origin) continue;
    const existing = groupByOrigin.get(origin);
    if (!existing) continue;
    if (existing.machines.some((candidate) => candidate.bindingKey === machine.bindingKey)) {
      continue;
    }
    const claimed = claimedMachines.get(origin)!;
    if (claimed.has(machine.machineId)) continue;
    claimed.add(machine.machineId);
    existing.machines.push(machine);
    if (machine.bindingKey === activeBindingKey) {
      existing.activeBindingKey = machine.bindingKey;
    }
  }

  for (const group of groups) {
    if (group.activeBindingKey) continue;
    const preferred = preferredBindingKeyByGroup[group.id] ?? null;
    if (preferred && group.machines.some((machine) => machine.bindingKey === preferred)) {
      group.activeBindingKey = preferred;
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

export type RecentProjectLocation = {
  summary: RecentProjectSummary;
  recentKey: string | null;
  machineId: string;
  machineName: string;
  connectionState: RemoteRuntimeConnectionState | null;
  reachable: boolean;
};

export type RecentProjectGroup = {
  id: string;
  displayName: string;
  locations: RecentProjectLocation[];
  primary: RecentProjectLocation;
  recentKeys: string[];
  pinned: boolean;
  lastOpenedAt: string;
};

export function recentProjectLocationKey(project: RecentProjectSummary): string {
  return project.kind === "remote" && project.remote
    ? remoteProjectBindingKey(project.remote.targetId, project.remote.projectId)
    : project.rootPath;
}

function isoTimestamp(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function recentTimestamp(project: RecentProjectSummary): number {
  return isoTimestamp(project.lastOpenedAt);
}

/**
 * One recent card per repository, enriched with matching machine-catalog
 * locations. Pure live catalog entries attach to a recent group but never
 * create a card on their own.
 */
export function groupRecentProjects(args: {
  recentProjects: readonly RecentProjectSummary[];
  remoteSnapshot?: RemoteRuntimeConnectionSnapshot | null;
}): RecentProjectGroup[] {
  const { recentProjects, remoteSnapshot = null } = args;
  const connections = remoteSnapshot?.connections ?? [];
  const liveProjectByKey = new Map<string, {
    connection: (typeof connections)[number];
    project: (typeof connections)[number]["projects"][number];
  }>();
  for (const connection of connections) {
    for (const project of connection.projects ?? []) {
      liveProjectByKey.set(
        remoteProjectBindingKey(connection.target.id, project.projectId),
        { connection, project },
      );
    }
  }

  type MutableGroup = {
    id: string;
    displayName: string;
    locations: RecentProjectLocation[];
    recentKeys: string[];
    pinned: boolean;
    lastOpenedAt: string;
    claimedMachines: Set<string>;
  };
  const groups: MutableGroup[] = [];
  const byOrigin = new Map<string, MutableGroup>();

  const toLocation = (
    summary: RecentProjectSummary,
    recentKey: string | null,
  ): RecentProjectLocation => {
    if (summary.kind === "remote" && summary.remote) {
      const connection = connections.find(
        (candidate) => candidate.target.id === summary.remote?.targetId,
      );
      const connectionState = connection?.state ?? "idle";
      return {
        summary,
        recentKey,
        machineId: summary.remote.targetId,
        machineName: summary.remote.runtimeName,
        connectionState,
        reachable: connectionState === "connected",
      };
    }
    return {
      summary,
      recentKey,
      machineId: LOCAL_MACHINE_ID,
      machineName: LOCAL_MACHINE_NAME,
      connectionState: null,
      reachable: summary.exists !== false,
    };
  };

  for (const summary of recentProjects) {
    const key = recentProjectLocationKey(summary);
    const live = summary.kind === "remote" ? liveProjectByKey.get(key) : null;
    const origin = cachedGitRemoteIdentity(
      summary.gitOriginUrl ?? live?.project.gitOriginUrl ?? null,
    );
    const location = toLocation(
      live && !summary.gitOriginUrl
        ? { ...summary, gitOriginUrl: live.project.gitOriginUrl }
        : summary,
      key,
    );
    let group = origin ? byOrigin.get(origin) : undefined;
    if (!group || group.claimedMachines.has(location.machineId)) {
      group = {
        id: origin && !byOrigin.has(origin) ? origin : key,
        displayName: summary.displayName,
        locations: [],
        recentKeys: [],
        pinned: false,
        lastOpenedAt: summary.lastOpenedAt,
        claimedMachines: new Set(),
      };
      groups.push(group);
      if (origin && !byOrigin.has(origin)) byOrigin.set(origin, group);
    }
    group.locations.push(location);
    group.claimedMachines.add(location.machineId);
    group.recentKeys.push(key);
    group.pinned ||= Boolean(summary.pinned);
    if (recentTimestamp(summary) > isoTimestamp(group.lastOpenedAt)) {
      group.lastOpenedAt = summary.lastOpenedAt;
      group.displayName = summary.displayName;
    }
  }

  // A connected machine may know a checkout that has never been opened from
  // this desktop. Attach it by strict origin identity so the card can say
  // "Also on …" and the tab switcher can open it immediately.
  for (const connection of connections) {
    for (const project of connection.projects ?? []) {
      const origin = cachedGitRemoteIdentity(project.gitOriginUrl);
      if (!origin) continue;
      const group = byOrigin.get(origin);
      if (!group || group.claimedMachines.has(connection.target.id)) continue;
      const summary: RecentProjectSummary = {
        rootPath: project.rootPath,
        displayName: project.displayName,
        lastOpenedAt: project.lastOpenedAt
          ? new Date(project.lastOpenedAt).toISOString()
          : "",
        exists: true,
        kind: "remote",
        gitOriginUrl: project.gitOriginUrl,
        remote: {
          targetId: connection.target.id,
          projectId: project.projectId,
          runtimeName: connection.target.name,
          hostname: connection.target.hostname,
          gitOriginUrl: project.gitOriginUrl,
          iconDataUrl: project.icon?.dataUrl ?? null,
        },
      };
      group.locations.push(toLocation(summary, null));
      group.claimedMachines.add(connection.target.id);
    }
  }

  return groups
    .map((group): RecentProjectGroup => {
      const locations = [...group.locations].sort(
        (left, right) => recentTimestamp(right.summary) - recentTimestamp(left.summary),
      );
      const primary = locations.find((location) => location.reachable) ?? locations[0]!;
      return {
        id: group.id,
        displayName: group.displayName,
        locations,
        primary,
        recentKeys: group.recentKeys,
        pinned: group.pinned,
        lastOpenedAt: group.lastOpenedAt,
      };
    })
    .sort((left, right) => {
      const pinDelta = Number(right.pinned) - Number(left.pinned);
      if (pinDelta !== 0) return pinDelta;
      return isoTimestamp(right.lastOpenedAt) - isoTimestamp(left.lastOpenedAt);
    });
}
