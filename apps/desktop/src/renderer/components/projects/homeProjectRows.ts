import type { AccountProjectView } from "../../../shared/accountProject";
import {
  buildRepositoryCopies,
  copyComputers,
  repositoryTabFromAccountProject,
  type CopyComputers,
  type RepositoryCopy,
  type RepositoryCopyInputs,
} from "../../../shared/repositoryTab";
import type { RecentProjectSummary, RemoteRuntimeConnectionSnapshot } from "../../../shared/types";
import { THIS_MACHINE_ID, THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { remoteProjectBindingKey } from "../../../shared/projectIdentity";
import { projectRecordScope } from "../../../shared/projectRecord";
import { cachedGitRemoteIdentity } from "../lanes/laneMachines";
import type { RemovalCopy, RemoveProjectTarget } from "./RemoveProjectDialog";
import { repoKeyForUrl } from "./projectCopies";
import {
  ACCOUNT_MACHINE_TARGET_PREFIX,
  ACCOUNT_NO_COPY_TARGET_ID,
  LOCAL_MACHINE_ID,
  LOCAL_MACHINE_NAME,
  groupRecentProjects,
  recentProjectLocationKey,
  type RecentProjectGroup,
  type RecentProjectLocation,
} from "../app/projectTabGrouping";

/**
 * Home's project list (one source). The account's project list decides which
 * projects show and how many: one row per account project, on every client,
 * with or without a machine connection. This computer's recents only add
 * order ("last opened"), pins and the folders to open. A folder that is no
 * account project (no GitHub repository, or a lane worktree opened as a
 * project) shows in a second group, "Only on <computer>".
 *
 * Pure: the page and its hook feed it state they already hold.
 */

/** A computer as ADE Web knows it, by its account machine key. */
export type HomeWebComputer = {
  /** The web machine row key (`openWebProject` takes it). */
  key: string;
  name: string;
  /** Connected now. */
  live: boolean;
  /** Connected, or awake and one press away. */
  reachable: boolean;
};

export type HomeProjectRow = {
  /** The account project id, or the local group's id. */
  key: string;
  kind: "account" | "local";
  group: RecentProjectGroup;
  /** The row's primary location, with the group's pin. */
  rp: RecentProjectSummary;
  /** `owner/name` of an account project; null for a local folder (its path shows). */
  repository: string | null;
  /** The shared count (`copyComputers`); null for a local folder. */
  computers: CopyComputers | null;
  /** Every copy of an account project, as the copies menu and Location list them. */
  copies: readonly RepositoryCopy[];
  /** The project's icon from any source, kept while its computer is offline. */
  iconDataUrl: string | null;
};

export type HomeLocalGroup = {
  key: string;
  /** "Only on <computer>"; null when the list has no account rows (signed out). */
  label: string | null;
  rows: HomeProjectRow[];
};

export type HomeProjectList = {
  accountRows: HomeProjectRow[];
  localGroups: HomeLocalGroup[];
  /** Account projects shown; the header count. Null when the account list is not read. */
  accountCount: number | null;
};

export type HomeProjectListInput = {
  /** The account's live projects; null until the list is read (or signed out). */
  projects: readonly AccountProjectView[] | null;
  sources: Omit<RepositoryCopyInputs, "accountCopies">;
  /** Desktop: this computer's recents (local and remote rows). Web: the connected computers' catalogs. */
  recents: readonly RecentProjectSummary[];
  remoteSnapshot: RemoteRuntimeConnectionSnapshot | null;
  webMode: boolean;
  /** Web only: computers by account machine key. */
  webComputers?: ReadonlyMap<string, HomeWebComputer>;
  /** Web only: computers by web machine row key (a catalog row's `targetId`) and by browser environment id. */
  webComputersByKey?: ReadonlyMap<string, HomeWebComputer>;
  /** Account projects this computer's Home does not list ("From this list"), with when each was hidden. */
  hidden: ReadonlyMap<string, number>;
  /** Folders on this disk that are another machine's copy (F6). */
  foreignPaths: ReadonlySet<string>;
  thisMachineName: string;
  /** Icons seen earlier this session, by account project id. */
  rememberedIcons: ReadonlyMap<string, string>;
};

function originsOf(project: AccountProjectView): string[] {
  return [project.repoKey, ...project.aliases]
    .map((key) => cachedGitRemoteIdentity(key.startsWith("repo:") ? key.slice("repo:".length) : key))
    .filter((origin): origin is string => origin != null);
}

function originOfRecent(recent: RecentProjectSummary): string | null {
  return cachedGitRemoteIdentity(recent.gitOriginUrl ?? recent.remote?.gitOriginUrl ?? null);
}

function ms(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value: number): string {
  return value > 0 ? new Date(value).toISOString() : "";
}

type RecentFacts = {
  recents: RecentProjectSummary[];
  lastOpenedAt: number;
  pinned: boolean;
  iconDataUrl: string | null;
};

function locationsOfCopies(
  project: AccountProjectView,
  copies: readonly RepositoryCopy[],
  facts: RecentFacts | undefined,
  input: HomeProjectListInput,
  iconDataUrl: string | null,
): RecentProjectLocation[] {
  const address = project.repoKey.startsWith("repo:") ? project.repoKey.slice("repo:".length) : project.repoKey;
  const gitOriginUrl = `https://${address}`;
  const connections = input.sources.connections;
  const openedAt = (rootPath: string): number => {
    const recent = facts?.recents.find((entry) => entry.kind !== "remote" && entry.rootPath === rootPath);
    return recent ? ms(recent.lastOpenedAt) : 0;
  };
  return copies.map((copy): RecentProjectLocation => {
    if (copy.isThisMachine) {
      const opened = openedAt(copy.rootPath);
      return {
        summary: {
          rootPath: copy.rootPath,
          displayName: project.name,
          lastOpenedAt: iso(opened || (copy.lastSeenAt ?? 0)),
          exists: copy.address != null,
          kind: "local",
          gitOriginUrl,
        },
        recentKey: opened ? copy.rootPath : null,
        machineId: LOCAL_MACHINE_ID,
        machineName: LOCAL_MACHINE_NAME,
        connectionState: null,
        reachable: copy.address != null,
      };
    }
    // The target a row opens: a saved connection by its id; a computer with
    // no saved connection by its account key (the page opens it, connecting
    // first on the web, or opens the repository with no machine).
    let targetId = copy.machineId;
    if (input.webMode) {
      // ADE Web opens a computer by its web machine row: through the account
      // key, else through the browser environment id of the connection.
      targetId = copy.machineKey
        ? `${ACCOUNT_MACHINE_TARGET_PREFIX}${copy.machineKey}`
        : input.webComputersByKey?.get(copy.machineId)?.key ?? copy.machineId;
    }
    const connection = connections.find((entry) => entry.target.id === copy.machineId) ?? null;
    const state = input.webMode
      ? (copy.online ? "connected" : "idle")
      : connection?.state ?? "idle";
    return {
      summary: {
        rootPath: copy.rootPath,
        displayName: project.name,
        lastOpenedAt: iso(copy.lastSeenAt ?? 0),
        exists: true,
        kind: "remote",
        gitOriginUrl,
        remote: {
          targetId,
          projectId: copy.address?.kind === "remote" ? copy.address.projectId : copy.checkoutId ?? project.id,
          runtimeName: copy.machineName,
          hostname: connection?.target.hostname ?? "",
          gitOriginUrl,
          iconDataUrl,
          ...(connection?.target.transport ? { transport: connection.target.transport } : {}),
        },
      },
      recentKey: null,
      machineId: targetId,
      machineName: copy.machineName,
      connectionState: state,
      reachable: input.webMode ? copy.online : copy.address != null,
    };
  });
}

function noCopyLocation(project: AccountProjectView, iconDataUrl: string | null): RecentProjectLocation {
  const address = project.repoKey.startsWith("repo:") ? project.repoKey.slice("repo:".length) : project.repoKey;
  const gitOriginUrl = `https://${address}`;
  return {
    summary: {
      rootPath: "",
      displayName: project.name,
      lastOpenedAt: iso(project.addedAt),
      exists: true,
      kind: "remote",
      gitOriginUrl,
      remote: {
        targetId: ACCOUNT_NO_COPY_TARGET_ID,
        projectId: project.id,
        runtimeName: "No computer",
        hostname: "",
        gitOriginUrl,
        iconDataUrl,
      },
    },
    recentKey: null,
    machineId: ACCOUNT_NO_COPY_TARGET_ID,
    machineName: "No computer",
    connectionState: null,
    reachable: false,
  };
}

/** This computer's reachable folder first (the one opened last), then a reachable computer, then the rest. */
function primaryOf(locations: readonly RecentProjectLocation[], copies: readonly RepositoryCopy[]): RecentProjectLocation {
  const isMain = (location: RecentProjectLocation) => copies.some((copy) =>
    copy.isMain && copy.rootPath === location.summary.rootPath
    && (location.summary.kind === "remote") !== copy.isThisMachine);
  const rank = (location: RecentProjectLocation) =>
    (location.reachable ? 0 : 4) + (location.summary.kind === "remote" ? 2 : 0) + (isMain(location) ? 0 : 1);
  return [...locations].sort((left, right) =>
    rank(left) - rank(right)
    || (left.recentKey ? 0 : 1) - (right.recentKey ? 0 : 1)
    || ms(right.summary.lastOpenedAt) - ms(left.summary.lastOpenedAt))[0]!;
}

function webOnline(copies: readonly RepositoryCopy[], webComputers: ReadonlyMap<string, HomeWebComputer> | undefined): RepositoryCopy[] {
  return copies.map((copy) => {
    const computer = copy.machineKey ? webComputers?.get(copy.machineKey) : undefined;
    return { ...copy, online: computer ? computer.reachable : copy.online };
  });
}

export function buildHomeProjectList(input: HomeProjectListInput): HomeProjectList {
  const { projects, recents, webMode } = input;
  // Rows the page never shows: a missing folder, ADE's own scratch projects,
  // another machine's copy at a path on this disk (F6).
  const usable = recents.filter((recent) => {
    if (recent.kind === "remote") return true;
    if (input.foreignPaths.has(recent.rootPath)) return false;
    return recent.exists && !recent.rootPath.includes("ade-project");
  });

  if (!projects) {
    // No account list (signed out, or not read yet): the recents, as before.
    const groups = groupRecentProjects({ recentProjects: usable, remoteSnapshot: webMode ? null : input.remoteSnapshot });
    return {
      accountRows: [],
      localGroups: groups.length > 0 ? [{ key: "recents", label: null, rows: groups.map(localRow) }] : [],
      accountCount: null,
    };
  }

  const projectByOrigin = new Map<string, AccountProjectView>();
  for (const project of projects) {
    for (const origin of originsOf(project)) if (!projectByOrigin.has(origin)) projectByOrigin.set(origin, project);
  }
  const factsById = new Map<string, RecentFacts>();
  const localCandidates: RecentProjectSummary[] = [];
  for (const recent of usable) {
    const origin = originOfRecent(recent);
    const project = origin && !recent.worktreeOf ? projectByOrigin.get(origin) : undefined;
    if (!project) {
      // On the web only a connected computer's folders show.
      if (webMode) {
        const computer = recent.remote ? input.webComputersByKey?.get(recent.remote.targetId) : undefined;
        if (!computer?.live) continue;
      }
      localCandidates.push(recent);
      continue;
    }
    const facts = factsById.get(project.id) ?? { recents: [], lastOpenedAt: 0, pinned: false, iconDataUrl: null };
    facts.recents.push(recent);
    facts.lastOpenedAt = Math.max(facts.lastOpenedAt, ms(recent.lastOpenedAt));
    facts.pinned ||= Boolean(recent.pinned);
    facts.iconDataUrl ??= recent.remote?.iconDataUrl ?? null;
    factsById.set(project.id, facts);
  }

  // Icons the connected computers report, by account project.
  const liveIconById = new Map<string, string>();
  for (const connection of input.sources.connections) {
    for (const row of connection.projects ?? []) {
      const dataUrl = row.icon?.dataUrl;
      if (!dataUrl) continue;
      const origin = cachedGitRemoteIdentity(row.gitOriginUrl ?? null);
      const id = row.accountProjectId ?? (origin ? projectByOrigin.get(origin)?.id : undefined);
      if (id && !liveIconById.has(id)) liveIconById.set(id, dataUrl);
    }
  }

  const accountRows: Array<HomeProjectRow & { sortSeen: number }> = [];
  for (const project of projects) {
    // Hidden from this list, unless it was opened again after that.
    const hiddenAt = input.hidden.get(project.id);
    if (hiddenAt != null && (factsById.get(project.id)?.lastOpenedAt ?? 0) <= hiddenAt) continue;
    const tab = repositoryTabFromAccountProject(project);
    const built = buildRepositoryCopies(tab, { ...input.sources, accountCopies: project.copies })
      .filter((copy) => !copy.isAdeCloud);
    const copies = webMode ? webOnline(built, input.webComputers) : built;
    const facts = factsById.get(project.id);
    const iconDataUrl = facts?.iconDataUrl ?? liveIconById.get(project.id) ?? input.rememberedIcons.get(project.id) ?? null;
    const located = locationsOfCopies(project, copies, facts, input, iconDataUrl);
    const locations = located.length > 0 ? located : [noCopyLocation(project, iconDataUrl)];
    const primary = primaryOf(locations, copies);
    const group: RecentProjectGroup = {
      id: project.id,
      displayName: project.name,
      locations,
      primary,
      recentKeys: (facts?.recents ?? []).map(recentProjectLocationKey),
      pinned: facts?.pinned ?? false,
      lastOpenedAt: iso(facts?.lastOpenedAt ?? 0),
    };
    accountRows.push({
      key: project.id,
      kind: "account",
      group,
      rp: { ...primary.summary, pinned: group.pinned },
      repository: `${project.owner}/${project.name}`,
      computers: copyComputers(copies),
      copies,
      iconDataUrl,
      sortSeen: Math.max(0, ...project.copies.map((copy) => copy.lastSeenAt)),
    });
  }
  accountRows.sort((left, right) =>
    Number(right.group.pinned) - Number(left.group.pinned)
    || ms(right.group.lastOpenedAt) - ms(left.group.lastOpenedAt)
    || right.sortSeen - left.sortSeen
    || left.group.displayName.localeCompare(right.group.displayName));

  // The folders that are no account project, one group per computer.
  const localGroups = new Map<string, HomeLocalGroup>();
  const grouped = groupRecentProjects({ recentProjects: localCandidates, remoteSnapshot: webMode ? null : input.remoteSnapshot });
  for (const group of grouped) {
    const primary = group.primary;
    const machineKey = primary.summary.kind === "remote" ? primary.machineId : LOCAL_MACHINE_ID;
    const name = primary.summary.kind === "remote" ? primary.machineName : input.thisMachineName;
    const entry = localGroups.get(machineKey) ?? { key: `local:${machineKey}`, label: `Only on ${name}`, rows: [] };
    entry.rows.push(localRow(group));
    localGroups.set(machineKey, entry);
  }
  // This computer's group first.
  const ordered = [...localGroups.entries()]
    .sort(([left], [right]) => Number(right === LOCAL_MACHINE_ID) - Number(left === LOCAL_MACHINE_ID))
    .map(([, entry]) => entry);

  return {
    accountRows: accountRows.map(({ sortSeen: _sortSeen, ...row }) => row),
    localGroups: ordered,
    accountCount: accountRows.length,
  };
}

function localRow(group: RecentProjectGroup): HomeProjectRow {
  const iconDataUrl = group.locations
    .map((location) => location.summary.remote?.iconDataUrl ?? null)
    .find((value): value is string => Boolean(value)) ?? null;
  return {
    key: group.id,
    kind: "local",
    group,
    rp: { ...group.primary.summary, pinned: group.pinned },
    repository: null,
    computers: null,
    copies: [],
    iconDataUrl,
  };
}

/**
 * The remove window's target for a Home row of an account project: every
 * copy from the account list, each with the machine it goes to. A copy on a
 * computer this client has no live connection to is listed offline and is
 * never called. "From this computer" acts on this computer's copy, else the
 * first reachable one.
 */
export function removeTargetForRow(
  row: HomeProjectRow,
  onRemoveFromList: () => void,
): { groupId: string; recordScope: string | null; target: RemoveProjectTarget } {
  const gitOriginUrl = row.rp.gitOriginUrl ?? row.rp.remote?.gitOriginUrl ?? null;
  const copies: RemovalCopy[] = row.copies.map((copy) => {
    if (copy.isThisMachine) {
      return {
        machine: { machineId: THIS_MACHINE_ID, name: THIS_MACHINE_NAME, targetId: null, isLocal: true, online: copy.address != null },
        rootPath: copy.rootPath,
        bindingKey: copy.rootPath,
        projectId: null,
      };
    }
    const address = copy.address?.kind === "remote" ? copy.address : null;
    // A saved connection is addressed by its target id even while offline; a
    // computer with no saved connection has no target at all.
    const targetId = address?.targetId
      ?? (copy.machineId.startsWith(ACCOUNT_MACHINE_TARGET_PREFIX) ? null : copy.machineId);
    // The checkout id is that machine's own id of the folder, so a connected
    // machine that has not listed the folder yet is still addressed.
    const projectId = address?.projectId ?? copy.checkoutId;
    const online = copy.online && targetId != null && projectId != null;
    return {
      machine: { machineId: copy.machineId, name: copy.machineName, targetId, isLocal: false, online },
      rootPath: copy.rootPath,
      bindingKey: targetId && projectId ? remoteProjectBindingKey(targetId, projectId) : `${copy.machineId}:${copy.rootPath}`,
      projectId,
    };
  });
  const current = copies.find((copy) => copy.machine.isLocal && copy.machine.online)
    ?? copies.find((copy) => copy.machine.online)
    ?? null;
  return {
    groupId: row.key,
    recordScope: projectRecordScope(gitOriginUrl),
    target: {
      projectName: row.group.displayName,
      repoKey: repoKeyForUrl(gitOriginUrl),
      current,
      copies,
      accountProjectId: row.kind === "account" ? row.key : null,
      onRemoveFromList,
    },
  };
}
