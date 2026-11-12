import { accountRepoScopeKey } from "./accountSettingsScope";
import type { AccountProjectCopy, AccountProjectId, AccountProjectView } from "./accountProject";
import { pickLiveCheckout } from "./crossMachineHandoff";
import { THIS_MACHINE_ID, THIS_MACHINE_NAME } from "./machineIdentity";
import { remoteProjectBindingKey } from "./projectIdentity";
import type { OpenProjectBinding, RecentProjectSummary } from "./types/core";
import type { RemoteRuntimeConnectionStatus, RemoteRuntimeProjectRecord } from "./types/remoteRuntime";

/**
 * A project tab is a repository on the account, not a machine. This module is
 * the one place that answers which copies a repository has, on which machine,
 * which ones are online, which copy the tab used to be bound to (the
 * compatibility resolver), and what "Start on" offers for new work.
 *
 * Everything here is pure: no I/O, no React. The renderer hooks in
 * `renderer/state/useRepositoryCopies.ts` feed it from state that already
 * exists (the connection snapshot, this computer's recents, the account list).
 */

/** The id a "this computer only" tab has: `local:` and its folder, the text of today's local binding key. */
export type ThisComputerOnlyTabId = `local:${string}`;

/** A tab's id: the account project id, or the folder of a project that is on this computer only. */
export type RepositoryTabId = AccountProjectId | ThisComputerOnlyTabId;

export type RepositoryTab =
  | {
      /** A GitHub repository on the account (`AccountProject`). */
      kind: "account";
      id: AccountProjectId;
      /** The repository's name on the account, never a machine name. */
      displayName: string;
      iconDataUrl: string | null;
      /** Lowercase GitHub host: `github.com` or a GitHub Enterprise host. */
      host: string;
      /** Every address of the project (`repo:<host>/<owner>/<name>`), the current one first. */
      repoKeys: readonly string[];
    }
  | {
      /** A folder with no GitHub remote: it has no account project and lives on this computer only. */
      kind: "this_computer_only";
      id: ThisComputerOnlyTabId;
      displayName: string;
      iconDataUrl: string | null;
      rootPath: string;
    };

/**
 * The pin. It addresses exactly one copy on one machine. Same shape and keys as
 * `OpenProjectBinding`, so every `pin?: OpenProjectBinding | null` parameter,
 * the web adapter guards and every event key keep working.
 */
export type MachineAddress = OpenProjectBinding;

/** One copy of the tab's repository, joined from the account copy list and the live connections. */
export type RepositoryCopy = {
  /** The tab this copy belongs to. */
  projectId: RepositoryTabId;
  /** The account machine key. Null for this computer until its identity is read, and for an SSH target with no key. */
  machineKey: string | null;
  /** `THIS_MACHINE_ID`, the remote target id, or `account-machine:<machineKey>` for a machine with no saved connection. */
  machineId: string;
  machineName: string;
  /** The computer this app runs on. Always false in the hosted web client. */
  isThisMachine: boolean;
  /** The machine's main location for the project: new lanes start there. One per machine. */
  isMain: boolean;
  online: boolean;
  /** A lane's own ADE Cloud computer. It is listed, but never a place for new work. */
  isAdeCloud: boolean;
  rootPath: string;
  displayName: string;
  /** The machine's registry id of the folder (`project_<hash>`); null for this computer's copy before it is known. */
  checkoutId: string | null;
  gitOriginUrl: string | null;
  /** When the account last saw the copy, else when the machine last opened it. Epoch ms. */
  lastSeenAt: number | null;
  /** Null when the machine is offline, not connected, or does not list the folder. */
  address: MachineAddress | null;
};

/** A machine that can take new work: this computer (desktop) or a connected machine. */
export type StartOnMachine = {
  machineKey: string | null;
  machineId: string;
  machineName: string;
  isThisMachine: boolean;
  online: boolean;
  /** ADE Cloud lane computers never count as a machine that lacks the project. */
  isAdeCloud: boolean;
};

export type StartOnChoice =
  | {
      kind: "copy";
      copy: RepositoryCopy;
      why: "this-computer" | "last-used" | "other" | "unavailable";
      /** False for a copy that cannot take work now (offline, or its machine does not list the folder): the picker shows it disabled. */
      available: boolean;
    }
  | { kind: "clone"; machineKey: string | null; machineId: string; machineName: string; available: true }
  | { kind: "cloud"; available: true };

// ── Tabs ────────────────────────────────────────────────────────────────────

/** The tab of an account project. */
export function repositoryTabFromAccountProject(
  project: Pick<AccountProjectView, "id" | "host" | "repoKey" | "name"> & { aliases?: readonly string[] },
  options?: { displayName?: string | null; iconDataUrl?: string | null },
): RepositoryTab {
  const repoKeys = [project.repoKey, ...(project.aliases ?? []).filter((alias) => alias !== project.repoKey)];
  return {
    kind: "account",
    id: project.id,
    displayName: options?.displayName?.trim() || project.name,
    iconDataUrl: options?.iconDataUrl ?? null,
    host: project.host,
    repoKeys,
  };
}

/** The tab of a folder that has no account project. */
export function thisComputerOnlyTab(folder: { rootPath: string; displayName: string; iconDataUrl?: string | null }): RepositoryTab {
  return {
    kind: "this_computer_only",
    id: `local:${folder.rootPath}`,
    displayName: folder.displayName,
    iconDataUrl: folder.iconDataUrl ?? null,
    rootPath: folder.rootPath,
  };
}

/** ADE Cloud sets up github.com repositories only (`cloudLaneLaunchStartRefusal`). */
export function repositoryTabCanUseAdeCloud(tab: RepositoryTab): boolean {
  return tab.kind === "account" && tab.host === "github.com";
}

// ── Addresses ───────────────────────────────────────────────────────────────

type AddressableCopy = Pick<
  RepositoryCopy,
  "projectId" | "isThisMachine" | "rootPath" | "displayName" | "checkoutId" | "gitOriginUrl"
>;

/**
 * The address of one copy. A copy on this computer gets a local binding. A
 * copy on another machine gets a remote binding only while that machine is
 * connected AND lists the folder: by its registry id, else by the account
 * project id, else by its folder. Anything else is null; a guessed project id
 * would send calls to the wrong folder.
 */
export function copyAddress(
  copy: AddressableCopy,
  connection: RemoteRuntimeConnectionStatus | null | undefined,
): MachineAddress | null {
  if (copy.isThisMachine) {
    return {
      kind: "local",
      key: `local:${copy.rootPath}`,
      rootPath: copy.rootPath,
      displayName: copy.displayName,
      ...(copy.gitOriginUrl ? { gitOriginUrl: copy.gitOriginUrl } : {}),
    };
  }
  if (!connection || connection.state !== "connected") return null;
  const projects = connection.projects ?? [];
  const row = (copy.checkoutId ? projects.find((project) => project.projectId === copy.checkoutId) : undefined)
    ?? pickLiveCheckout(projects.filter((project) =>
      project.accountProjectId != null
      && project.accountProjectId === copy.projectId
      && project.rootPath === copy.rootPath))
    ?? pickLiveCheckout(projects.filter((project) => project.rootPath === copy.rootPath));
  if (!row) return null;
  const target = connection.target;
  return {
    kind: "remote",
    key: remoteProjectBindingKey(target.id, row.projectId),
    targetId: target.id,
    runtimeName: target.name?.trim() || target.hostname || target.id,
    transport: target.transport ?? "ssh",
    ...(target.hostname ? { hostname: target.hostname } : {}),
    projectId: row.projectId,
    rootPath: row.rootPath,
    displayName: row.displayName || copy.displayName,
    ...((row.gitOriginUrl ?? copy.gitOriginUrl) ? { gitOriginUrl: row.gitOriginUrl ?? copy.gitOriginUrl } : {}),
  };
}

// ── Copies ──────────────────────────────────────────────────────────────────

export type RepositoryCopyInputs = {
  /** The account's copies of this project (every machine); null when the account list is not known. */
  accountCopies: readonly AccountProjectCopy[] | null;
  /** Every saved machine from the connection snapshot, connected or not. */
  connections: readonly RemoteRuntimeConnectionStatus[];
  /**
   * This computer, or null in the hosted web client (it has no computer of its
   * own). `localProjects` are this computer's recents.
   */
  thisMachine: { machineKey: string | null; localProjects: readonly RecentProjectSummary[] } | null;
  /** Machine names by account machine key, for machines with no saved connection. */
  machineNames?: Readonly<Record<string, string>>;
  /** A lane's own ADE Cloud computer (`adeCloudLaneComputerForMachine`). */
  isAdeCloudMachine?: (machine: { hostname: string | null; machineKey: string | null }) => boolean;
};

/** A connection's account machine key: the paired machine's key, or the target id for an SSH target. */
export function connectionMachineKey(connection: RemoteRuntimeConnectionStatus): string {
  return connection.target.pairedMachine?.machineKey?.trim() || connection.target.id;
}

function machineName(connection: RemoteRuntimeConnectionStatus): string {
  return connection.target.name?.trim() || connection.target.hostname || connection.target.id;
}

function lastOpenedMs(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whether a folder's registry row belongs to the tab: the same account project
 * id, OR the same origin (today's rule for the tab bar and the union). The id
 * adds a join; it never removes the origin join. A this-computer-only tab
 * matches only its folder (handled by the caller).
 */
function rowBelongsToTab(
  tab: RepositoryTab,
  row: { accountProjectId?: string | null; gitOriginUrl?: string | null; rootPath: string },
): boolean {
  if (tab.kind === "this_computer_only") return false;
  if (row.accountProjectId && row.accountProjectId === tab.id) return true;
  const key = accountRepoScopeKey(row.gitOriginUrl ?? null);
  return key != null && tab.repoKeys.includes(key);
}

function isUsableRemoteRow(row: RemoteRuntimeProjectRecord): boolean {
  return row.exists !== false && row.registrationSource !== "test";
}

/**
 * Every copy of the tab's repository. Account copies (with their main flag)
 * come first; copies the live sources know but the account does not (no
 * account list yet, an older machine, a folder not on the account) are added
 * from the connection snapshot and this computer's recents. One machine may
 * hold several copies; exactly one of them is main when any is listed.
 */
export function buildRepositoryCopies(
  tab: RepositoryTab | null,
  inputs: RepositoryCopyInputs,
): RepositoryCopy[] {
  if (!tab) return [];
  const thisMachine = inputs.thisMachine;
  const thisKey = thisMachine?.machineKey?.trim() || null;
  const isCloud = inputs.isAdeCloudMachine ?? (() => false);
  const connectionByKey = new Map<string, RemoteRuntimeConnectionStatus>();
  for (const connection of inputs.connections) {
    connectionByKey.set(connectionMachineKey(connection), connection);
    connectionByKey.set(connection.target.id, connection);
  }

  const copies: RepositoryCopy[] = [];
  const has = (machineId: string, rootPath: string, checkoutId: string | null) =>
    copies.find((copy) => copy.machineId === machineId
      && (copy.rootPath === rootPath || (checkoutId != null && copy.checkoutId === checkoutId)));

  const localCopy = (fields: {
    rootPath: string;
    displayName: string;
    checkoutId: string | null;
    gitOriginUrl: string | null;
    isMain: boolean;
    lastSeenAt: number | null;
  }): RepositoryCopy => {
    const copy: RepositoryCopy = {
      projectId: tab.id,
      machineKey: thisKey,
      machineId: THIS_MACHINE_ID,
      machineName: THIS_MACHINE_NAME,
      isThisMachine: true,
      isMain: fields.isMain,
      online: true,
      isAdeCloud: false,
      rootPath: fields.rootPath,
      displayName: fields.displayName,
      checkoutId: fields.checkoutId,
      gitOriginUrl: fields.gitOriginUrl,
      lastSeenAt: fields.lastSeenAt,
      address: null,
    };
    copy.address = copyAddress(copy, null);
    return copy;
  };

  const remoteCopy = (
    connection: RemoteRuntimeConnectionStatus | null,
    fields: {
      machineKey: string;
      rootPath: string;
      displayName: string;
      checkoutId: string | null;
      gitOriginUrl: string | null;
      isMain: boolean;
      lastSeenAt: number | null;
    },
  ): RepositoryCopy => {
    const copy: RepositoryCopy = {
      projectId: tab.id,
      machineKey: connection ? connectionMachineKey(connection) : fields.machineKey,
      machineId: connection ? connection.target.id : `account-machine:${fields.machineKey}`,
      machineName: connection
        ? machineName(connection)
        : inputs.machineNames?.[fields.machineKey]?.trim() || "Another computer",
      isThisMachine: false,
      isMain: fields.isMain,
      online: connection?.state === "connected",
      isAdeCloud: connection
        ? isCloud({ hostname: connection.target.hostname ?? null, machineKey: connection.target.pairedMachine?.machineKey ?? null })
        : isCloud({ hostname: null, machineKey: fields.machineKey }),
      rootPath: fields.rootPath,
      displayName: fields.displayName,
      checkoutId: fields.checkoutId,
      gitOriginUrl: fields.gitOriginUrl,
      lastSeenAt: fields.lastSeenAt,
      address: null,
    };
    copy.address = copyAddress(copy, connection);
    return copy;
  };

  // 1. The account's copies. A copy whose machine is this computer is local;
  //    on the web there is no this computer, so it is "another computer".
  if (tab.kind === "account") {
    for (const entry of inputs.accountCopies ?? []) {
      if (entry.projectId !== tab.id) continue;
      if (thisMachine && thisKey && entry.machineKey === thisKey) {
        const recent = thisMachine.localProjects.find((project) => project.kind !== "remote" && project.rootPath === entry.rootPath);
        if (has(THIS_MACHINE_ID, entry.rootPath, entry.checkoutId)) continue;
        copies.push(localCopy({
          rootPath: entry.rootPath,
          displayName: recent?.displayName || folderName(entry.rootPath),
          checkoutId: entry.checkoutId,
          gitOriginUrl: recent?.gitOriginUrl ?? null,
          isMain: entry.isMain,
          lastSeenAt: entry.lastSeenAt,
        }));
        continue;
      }
      const connection = connectionByKey.get(entry.machineKey) ?? null;
      const row = connection?.projects?.find((project) => project.projectId === entry.checkoutId)
        ?? connection?.projects?.find((project) => project.rootPath === entry.rootPath);
      const copy = remoteCopy(connection, {
        machineKey: entry.machineKey,
        rootPath: entry.rootPath,
        displayName: row?.displayName || folderName(entry.rootPath),
        checkoutId: entry.checkoutId,
        gitOriginUrl: row?.gitOriginUrl ?? null,
        isMain: entry.isMain,
        lastSeenAt: entry.lastSeenAt,
      });
      if (has(copy.machineId, copy.rootPath, copy.checkoutId)) continue;
      copies.push(copy);
    }
  }

  // 2. This computer's folders from its recents (never a lane worktree, never a missing folder).
  if (thisMachine) {
    const live = thisMachine.localProjects.filter((project) =>
      project.kind !== "remote"
      && project.exists !== false
      && !project.worktreeOf
      && (tab.kind === "this_computer_only" ? project.rootPath === tab.rootPath : rowBelongsToTab(tab, project)));
    for (const project of live) {
      if (has(THIS_MACHINE_ID, project.rootPath, null)) continue;
      copies.push(localCopy({
        rootPath: project.rootPath,
        displayName: project.displayName,
        checkoutId: null,
        gitOriginUrl: project.gitOriginUrl ?? null,
        isMain: false,
        lastSeenAt: lastOpenedMs(project.lastOpenedAt),
      }));
    }
  }

  // 3. Other machines' folders from the connection snapshot.
  if (tab.kind === "account") {
    for (const connection of inputs.connections) {
      for (const row of connection.projects ?? []) {
        if (!isUsableRemoteRow(row) || !rowBelongsToTab(tab, row)) continue;
        if (has(connection.target.id, row.rootPath, row.projectId)) continue;
        copies.push(remoteCopy(connection, {
          machineKey: connectionMachineKey(connection),
          rootPath: row.rootPath,
          displayName: row.displayName,
          checkoutId: row.projectId,
          gitOriginUrl: row.gitOriginUrl,
          isMain: false,
          lastSeenAt: lastOpenedMs(row.lastOpenedAt),
        }));
      }
    }
  }

  // One main per machine: the account's, else the most recently opened folder.
  const byMachine = new Map<string, RepositoryCopy[]>();
  for (const copy of copies) {
    const list = byMachine.get(copy.machineId);
    if (list) list.push(copy);
    else byMachine.set(copy.machineId, [copy]);
  }
  for (const list of byMachine.values()) {
    if (list.some((copy) => copy.isMain)) {
      let seen = false;
      for (const copy of list) {
        if (copy.isMain && !seen) seen = true;
        else copy.isMain = false;
      }
      continue;
    }
    const best = pickLiveCheckout(list.map((copy) => ({ copy, lastOpenedAt: copy.lastSeenAt })));
    if (best) best.copy.isMain = true;
  }
  return copies;
}

function folderName(rootPath: string): string {
  const trimmed = rootPath.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/** The machines that can take new work, from the connection snapshot (and this computer on the desktop). */
export function startOnMachines(inputs: Pick<RepositoryCopyInputs, "connections" | "thisMachine" | "isAdeCloudMachine">): StartOnMachine[] {
  const isCloud = inputs.isAdeCloudMachine ?? (() => false);
  const machines: StartOnMachine[] = [];
  if (inputs.thisMachine) {
    machines.push({
      machineKey: inputs.thisMachine.machineKey?.trim() || null,
      machineId: THIS_MACHINE_ID,
      machineName: THIS_MACHINE_NAME,
      isThisMachine: true,
      online: true,
      isAdeCloud: false,
    });
  }
  for (const connection of inputs.connections) {
    machines.push({
      machineKey: connectionMachineKey(connection),
      machineId: connection.target.id,
      machineName: machineName(connection),
      isThisMachine: false,
      online: connection.state === "connected",
      isAdeCloud: isCloud({ hostname: connection.target.hostname ?? null, machineKey: connection.target.pairedMachine?.machineKey ?? null }),
    });
  }
  return machines;
}

// ── Ordering helpers ────────────────────────────────────────────────────────

/** Main copies first, then the newest, then by machine name, so ties never flip between renders. */
function compareCopies(a: RepositoryCopy, b: RepositoryCopy): number {
  if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
  const seen = (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0);
  if (seen !== 0) return seen;
  return a.machineName.localeCompare(b.machineName) || a.rootPath.localeCompare(b.rootPath);
}

function isRoutable(copy: RepositoryCopy): copy is RepositoryCopy & { address: MachineAddress } {
  return copy.online && copy.address != null;
}

// ── The compatibility resolver ──────────────────────────────────────────────

export type DefaultCopyInputs = {
  copies: readonly RepositoryCopy[];
  /** The binding key of a copy the person picked on purpose for this tab (the copies menu). */
  explicitPickKey?: string | null;
  /** The binding key the window was restored to, or is bound to now. */
  currentKey?: string | null;
};

/**
 * The binding the tab has today, from its copies. It reproduces today's rules
 * so callers that are not migrated yet keep the same machine:
 *
 * 1. a copy the person picked on purpose, while its machine is online;
 * 2. this computer's copy (the one in use, else the main one);
 * 3. the copy the window was restored to or is on;
 * 4. another online copy (main first, newest next, ADE Cloud lane computers last);
 * 5. null: no copy is online.
 */
export function resolveDefaultCopy(
  _tab: RepositoryTab | null,
  inputs: DefaultCopyInputs,
): MachineAddress | null {
  const routable = inputs.copies.filter(isRoutable);
  if (routable.length === 0) return null;
  const byKey = (key: string | null | undefined) => (key ? routable.find((copy) => copy.address.key === key) : undefined);

  const picked = byKey(inputs.explicitPickKey);
  if (picked) return picked.address;

  const local = routable.filter((copy) => copy.isThisMachine);
  const localInUse = local.find((copy) => copy.address.key === inputs.currentKey);
  const localChoice = localInUse ?? [...local].sort(compareCopies)[0];
  if (localChoice) return localChoice.address;

  const current = byKey(inputs.currentKey);
  if (current) return current.address;

  const rest = [...routable].sort((a, b) => {
    if (a.isAdeCloud !== b.isAdeCloud) return a.isAdeCloud ? 1 : -1;
    return compareCopies(a, b);
  });
  return rest[0]?.address ?? null;
}

// ── Start on ────────────────────────────────────────────────────────────────

export type StartOnInputs = {
  copies: readonly RepositoryCopy[];
  /** Every machine that could take new work (`startOnMachines`). */
  machines: readonly StartOnMachine[];
  /** The machine key (or machine id) this client last started work on for this tab. */
  lastUsedMachineKey?: string | null;
  /** ADE Cloud is on for this account. Defaults to true. */
  cloudAvailable?: boolean;
};

/**
 * What "Start on" offers for new work in this tab, in order. The first
 * available entry is the default (`startOnDefault`):
 *
 * 1. this computer's online copy (desktop only; its main copy);
 * 2. the copy on the computer used last for this project;
 * 3. other online copies (main copies first);
 * 4. online computers with no copy ("clone first"); not for a this-computer-only project;
 * 5. ADE Cloud, for a github.com project;
 * 6. offline copies (and copies whose machine does not list the folder),
 *    listed but not available.
 *
 * A lane's own ADE Cloud computer is never offered, with or without a copy:
 * it is not a place for new work, and it never counts as a machine that lacks
 * the project.
 */
export function resolveStartOn(tab: RepositoryTab | null, inputs: StartOnInputs): StartOnChoice[] {
  if (!tab) return [];
  const copies = inputs.copies.filter((copy) => !copy.isAdeCloud);
  const choices: StartOnChoice[] = [];
  const listed = new Set<RepositoryCopy>();
  const add = (copy: RepositoryCopy | undefined, why: "this-computer" | "last-used" | "other") => {
    if (!copy || listed.has(copy)) return;
    listed.add(copy);
    choices.push({ kind: "copy", copy, why, available: true });
  };
  const online = copies.filter(isRoutable).sort(compareCopies);

  add(online.find((copy) => copy.isThisMachine), "this-computer");
  const lastUsed = inputs.lastUsedMachineKey?.trim();
  if (lastUsed) {
    add(online.find((copy) => !copy.isThisMachine && (copy.machineKey === lastUsed || copy.machineId === lastUsed)), "last-used");
  }
  for (const copy of online) add(copy, "other");

  if (tab.kind === "account") {
    const withCopy = new Set(copies.map((copy) => copy.machineId));
    const clones = inputs.machines
      .filter((machine) => machine.online && !machine.isAdeCloud && !withCopy.has(machine.machineId))
      .sort((a, b) => Number(b.isThisMachine) - Number(a.isThisMachine) || a.machineName.localeCompare(b.machineName));
    for (const machine of clones) {
      choices.push({ kind: "clone", machineKey: machine.machineKey, machineId: machine.machineId, machineName: machine.machineName, available: true });
    }
  }

  if (repositoryTabCanUseAdeCloud(tab) && inputs.cloudAvailable !== false) choices.push({ kind: "cloud", available: true });

  for (const copy of copies.filter((entry) => !listed.has(entry)).sort(compareCopies)) {
    choices.push({ kind: "copy", copy, why: "unavailable", available: false });
  }
  return choices;
}

/** The default "Start on" entry: the first available one, or null when nothing can take the work. */
export function startOnDefault(choices: readonly StartOnChoice[]): StartOnChoice | null {
  return choices.find((choice) => choice.available) ?? null;
}

/**
 * The address repository-level reads use until the client can ask GitHub
 * itself: the first online copy in "Start on" order. Null with no copy online.
 */
export function repositoryReaderAddress(choices: readonly StartOnChoice[]): MachineAddress | null {
  for (const choice of choices) {
    if (choice.kind === "copy" && choice.available && choice.copy.address) return choice.copy.address;
  }
  return null;
}
