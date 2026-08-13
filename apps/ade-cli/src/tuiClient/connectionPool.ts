/**
 * Per-machine AdeCodeConnection pool for transparent remote hops.
 *
 * `ade code remote` already knew how to open a paired bridge and hand a local
 * socket to the TUI. The TUI itself assumed one connection. This module is the
 * headless re-cut: keep the local connection, open a second paired connection
 * to another machine, and switch the active one without restarting Ink.
 *
 * ADE Code hops are paired-only. Advanced SSH stays on `ade code remote` and
 * the desktop Advanced path — an account-created target never falls back to
 * SSH from inside the TUI. Windows uses the same bridge socket URL the
 * launcher already builds (loopback TCP / named-pipe via localIpcListenOptions).
 */

import { RemoteTargetRegistry } from "../../../desktop/src/main/services/remoteRuntime/remoteTargetRegistry";
import type { RemoteRuntimeProjectRecord, RemoteRuntimeTarget } from "../../../desktop/src/shared/types/remoteRuntime";
import type { AdeAccountMachine } from "../../../desktop/src/shared/types/account";
import { deriveProjectId } from "../services/projects/projectRegistry";
import { AccountMachineDirectoryService } from "../services/account/accountMachineDirectoryService";
import {
  getSharedAccountAuthService,
  getSharedAccountDirectoryBaseUrl,
} from "../services/account/sharedAccountAuthService";
import { connectToAde, INTERACTIVE_PROJECT_REGISTRATION } from "./connection";
import { JsonRpcClient } from "./jsonRpcClient";
import { startSyncRemoteBridge, type RemoteBridge } from "./remoteBridge";
import { createRemoteLaunchBudget } from "./remoteLaunchBudget";
import {
  getCurrentAccountRelayProof,
  openPairedTransport,
  resolveRemoteTargetForLaunch,
} from "./remoteLauncher";
import type { AdeCodeConnection, ProjectLaunchContext } from "./types";

export const LOCAL_MACHINE_KEY = "__local__";

export type MachineQuery = {
  machineKey: string;
  accountMachineKey?: string | null;
  deviceId?: string | null;
  name?: string | null;
};

export type PooledConnection = {
  machineKey: string;
  label: string;
  connection: AdeCodeConnection;
  projectRoot: string;
  remoteLabel: string | null;
  bridge: RemoteBridge | null;
};

export type ConnectRemoteArgs = {
  query: MachineQuery;
  /** Prefer this project on the remote (canonical id, root path, or name). */
  projectCanonicalId?: string | null;
  projectRootPath?: string | null;
  projectQuery?: string | null;
  accountProjectRoots?: readonly string[];
};

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function queryKeys(query: MachineQuery): string[] {
  return [query.machineKey, query.accountMachineKey, query.deviceId]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
}

/** Match a saved desktop remote target to an attention/account machine identity. */
export function matchSavedRemoteTarget(
  targets: readonly RemoteRuntimeTarget[],
  query: MachineQuery,
): RemoteRuntimeTarget | null {
  const keys = new Set(queryKeys(query).map((key) => key.toLowerCase()));
  if (keys.size === 0 && !query.name?.trim()) return null;

  const byIdentity = targets.filter((target) => {
    const pairedKey = target.pairedMachine?.machineKey?.trim();
    const hostIdentity = target.pairedMachine?.hostIdentity?.trim();
    return (
      keys.has(target.id.toLowerCase())
      || (pairedKey != null && keys.has(pairedKey.toLowerCase()))
      || (hostIdentity != null && keys.has(hostIdentity.toLowerCase()))
    );
  });
  if (byIdentity.length === 1) return byIdentity[0]!;
  if (byIdentity.length > 1) {
    const paired = byIdentity.filter((target) => target.transport === "paired");
    if (paired.length === 1) return paired[0]!;
  }

  const name = normalize(query.name);
  if (!name) return null;
  const byName = targets.filter((target) => normalize(target.name) === name);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    const paired = byName.filter((target) => target.transport === "paired");
    if (paired.length === 1) return paired[0]!;
  }
  return null;
}

/** Match an account-directory machine to the same identity. */
export function matchAccountMachine(
  machines: readonly AdeAccountMachine[],
  query: MachineQuery,
): AdeAccountMachine | null {
  const keys = new Set(queryKeys(query).map((key) => key.toLowerCase()));
  const byIdentity = machines.filter((machine) => {
    const deviceId = machine.deviceId?.trim();
    return (
      keys.has(machine.machineKey.toLowerCase())
      || (deviceId != null && keys.has(deviceId.toLowerCase()))
    );
  });
  if (byIdentity.length === 1) return byIdentity[0]!;
  const name = normalize(query.name);
  if (!name) return byIdentity[0] ?? null;
  const byName = machines.filter((machine) => {
    const display = normalize(machine.customName) || normalize(machine.name);
    return display === name;
  });
  if (byName.length === 1) return byName[0]!;
  return byIdentity[0] ?? null;
}

export function coerceProjectRecords(value: unknown): RemoteRuntimeProjectRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const projectId = typeof record.projectId === "string" ? record.projectId.trim() : "";
    const rootPath = typeof record.rootPath === "string" ? record.rootPath.trim() : "";
    if (!projectId || !rootPath) return [];
    const displayName = typeof record.displayName === "string" && record.displayName.trim()
      ? record.displayName.trim()
      : rootPath.split("/").filter(Boolean).at(-1) ?? rootPath;
    return [{
      projectId,
      rootPath,
      displayName,
      addedAt: typeof record.addedAt === "number" ? record.addedAt : 0,
      lastOpenedAt: typeof record.lastOpenedAt === "number" ? record.lastOpenedAt : 0,
      gitOriginUrl: typeof record.gitOriginUrl === "string" ? record.gitOriginUrl : null,
    }];
  });
}

export function sortProjectRecords(
  projects: readonly RemoteRuntimeProjectRecord[],
): RemoteRuntimeProjectRecord[] {
  return [...projects].sort((left, right) => {
    const activity = (right.lastOpenedAt ?? 0) - (left.lastOpenedAt ?? 0);
    if (activity !== 0) return activity;
    return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" });
  });
}

/** Put the project we already inferred from cwd at the top of the picker. */
export function rankProjectsForPicker(
  projects: readonly RemoteRuntimeProjectRecord[],
  currentRoot: string | null | undefined,
): RemoteRuntimeProjectRecord[] {
  const sorted = sortProjectRecords(projects);
  const current = currentRoot?.trim();
  if (!current) return sorted;
  const match = sorted.find((project) => project.rootPath === current);
  if (!match) return sorted;
  return [match, ...sorted.filter((project) => project.rootPath !== current)];
}

export function pickProjectRecord(
  projects: readonly RemoteRuntimeProjectRecord[],
  query?: {
    projectId?: string | null;
    canonicalId?: string | null;
    rootPath?: string | null;
    name?: string | null;
  },
): RemoteRuntimeProjectRecord | null {
  if (projects.length === 0) return null;
  const projectId = query?.projectId?.trim();
  if (projectId) {
    const match = projects.find((project) => project.projectId === projectId);
    if (match) return match;
  }
  const canonicalId = query?.canonicalId?.trim();
  if (canonicalId) {
    const match = projects.find((project) => deriveProjectId(project.rootPath) === canonicalId);
    if (match) return match;
  }
  const rootPath = query?.rootPath?.trim();
  if (rootPath) {
    const match = projects.find((project) => project.rootPath === rootPath);
    if (match) return match;
  }
  const name = normalize(query?.name);
  if (name) {
    const matches = projects.filter((project) => normalize(project.displayName) === name);
    if (matches.length === 1) return matches[0]!;
  }
  return sortProjectRecords(projects)[0] ?? null;
}

export type MachinePickerRow = {
  id: string;
  label: string;
  detail: string;
  kind: "local" | "connected" | "paired" | "account";
  query: MachineQuery;
};

export function buildMachinePickerRows(args: {
  localLabel: string;
  localProjectRoot: string;
  pooled: readonly PooledConnection[];
  targets: readonly RemoteRuntimeTarget[];
  accountMachines: readonly AdeAccountMachine[];
  activeMachineKey: string;
}): MachinePickerRow[] {
  const rows: MachinePickerRow[] = [{
    id: LOCAL_MACHINE_KEY,
    label: args.activeMachineKey === LOCAL_MACHINE_KEY ? `${args.localLabel} · this session` : args.localLabel,
    detail: args.localProjectRoot,
    kind: "local",
    query: { machineKey: LOCAL_MACHINE_KEY, name: args.localLabel },
  }];
  const seen = new Set<string>([LOCAL_MACHINE_KEY]);

  for (const pooled of args.pooled) {
    if (pooled.machineKey === LOCAL_MACHINE_KEY || seen.has(pooled.machineKey)) continue;
    seen.add(pooled.machineKey);
    rows.push({
      id: pooled.machineKey,
      label: `${pooled.label} · connected`,
      detail: pooled.projectRoot,
      kind: "connected",
      query: { machineKey: pooled.machineKey, name: pooled.label },
    });
  }

  for (const target of args.targets) {
    const key = target.pairedMachine?.machineKey?.trim() || target.id;
    if (seen.has(key) || seen.has(target.id)) continue;
    seen.add(key);
    seen.add(target.id);
    const transport = target.transport === "paired" ? "paired" : "advanced SSH";
    rows.push({
      id: key,
      label: target.name,
      detail: `${transport} · ${target.hostname}`,
      kind: "paired",
      query: {
        machineKey: key,
        accountMachineKey: target.pairedMachine?.machineKey ?? null,
        deviceId: target.pairedMachine?.hostIdentity ?? null,
        name: target.name,
      },
    });
  }

  for (const machine of args.accountMachines) {
    if (seen.has(machine.machineKey)) continue;
    if (machine.deviceId && seen.has(machine.deviceId)) continue;
    seen.add(machine.machineKey);
    const name = machine.customName?.trim() || machine.name?.trim() || machine.machineKey;
    rows.push({
      id: machine.machineKey,
      label: name,
      detail: machine.online ? "account · online" : "account · offline",
      kind: "account",
      query: {
        machineKey: machine.machineKey,
        deviceId: machine.deviceId,
        name,
      },
    });
  }

  return rows;
}

export type AdeCodeConnectionPool = {
  local(): PooledConnection | null;
  get(machineKey: string): PooledConnection | null;
  list(): PooledConnection[];
  setLocal(entry: {
    connection: AdeCodeConnection;
    projectRoot: string;
    remoteLabel?: string | null;
  }): PooledConnection;
  connectRemote(args: ConnectRemoteArgs): Promise<PooledConnection>;
  close(machineKey: string): Promise<void>;
  closeAll(): Promise<void>;
};

export async function loadMachinePickerSources(
  accountProjectRoots: readonly string[] = [],
): Promise<{
  targets: RemoteRuntimeTarget[];
  accountMachines: AdeAccountMachine[];
}> {
  const targets = new RemoteTargetRegistry().list();
  const accountMachines = new AccountMachineDirectoryService(
    getSharedAccountAuthService(),
    {
      directoryBaseUrl: () => getSharedAccountDirectoryBaseUrl({
        projectRoots: () => accountProjectRoots,
      }),
    },
  );
  const listed = await accountMachines.listMachines({ timeoutMs: 8_000 });
  return {
    targets,
    accountMachines: listed.state === "ok" ? listed.machines : [],
  };
}

export function createAdeCodeConnectionPool(): AdeCodeConnectionPool {
  const entries = new Map<string, PooledConnection>();

  const setEntry = (entry: PooledConnection): PooledConnection => {
    entries.set(entry.machineKey, entry);
    return entry;
  };

  return {
    local() {
      return entries.get(LOCAL_MACHINE_KEY) ?? null;
    },
    get(machineKey) {
      return entries.get(machineKey) ?? null;
    },
    list() {
      return [...entries.values()];
    },
    setLocal(entry) {
      return setEntry({
        machineKey: LOCAL_MACHINE_KEY,
        label: "this machine",
        connection: entry.connection,
        projectRoot: entry.projectRoot,
        remoteLabel: entry.remoteLabel ?? null,
        bridge: null,
      });
    },
    async connectRemote(args) {
      const existing = entries.get(args.query.machineKey);
      if (existing) return existing;

      const opened = await openPairedPooledConnection(args);
      return setEntry(opened);
    },
    async close(machineKey) {
      const entry = entries.get(machineKey);
      if (!entry) return;
      entries.delete(machineKey);
      await entry.connection.close().catch(() => undefined);
      await entry.bridge?.close().catch(() => undefined);
    },
    async closeAll() {
      const closing = [...entries.values()];
      entries.clear();
      await Promise.all(closing.map(async (entry) => {
        await entry.connection.close().catch(() => undefined);
        await entry.bridge?.close().catch(() => undefined);
      }));
    },
  };
}

async function openPairedPooledConnection(args: ConnectRemoteArgs): Promise<PooledConnection> {
  const registry = new RemoteTargetRegistry();
  const targets = registry.list();
  let target = matchSavedRemoteTarget(targets, args.query);

  if (!target) {
    const accountMachines = new AccountMachineDirectoryService(
      getSharedAccountAuthService(),
      {
        directoryBaseUrl: () => getSharedAccountDirectoryBaseUrl({
          projectRoots: () => args.accountProjectRoots ?? [],
        }),
      },
    );
    const listed = await accountMachines.listMachines({ timeoutMs: 10_000 });
    if (listed.state !== "ok") {
      throw new Error(
        listed.message?.trim()
        || `Could not find ${args.query.name ?? args.query.machineKey} among saved machines, and the account directory is ${listed.state.replaceAll("_", " ")}.`,
      );
    }
    const machine = matchAccountMachine(listed.machines, args.query);
    if (!machine) {
      throw new Error(
        `No paired machine matches ${args.query.name ?? args.query.machineKey}. Pair it from /machines or desktop first.`,
      );
    }
    if (!machine.online) {
      throw new Error(`${machine.customName?.trim() || machine.name || machine.machineKey} is offline.`);
    }
    const paired = await accountMachines.pairListedMachine(machine, {
      connectTimeoutMs: 10_000,
      pairingTimeoutMs: 10_000,
    });
    target = registry.get(paired.targetId) ?? null;
    if (!target) {
      throw new Error("Account machine pairing did not persist a remote target.");
    }
  }

  const budget = createRemoteLaunchBudget();
  target = await resolveRemoteTargetForLaunch(target, {
    registry,
    budget,
    accountProjectRoots: args.accountProjectRoots,
  });
  if (target.transport !== "paired") {
    throw new Error(
      `${target.name} is an advanced SSH target. ADE Code hops are paired-only — use desktop Advanced SSH, or pair this machine to your account.`,
    );
  }

  const getAccountRelayProof = () => getCurrentAccountRelayProof(
    getSharedAccountAuthService({
      projectRoots: () => args.accountProjectRoots ?? [],
    }),
  );
  const initialConnection = await openPairedTransport(
    target,
    createRemoteLaunchBudget(),
    getAccountRelayProof,
    "auto",
  );
  const bridge = await startSyncRemoteBridge({
    target,
    initialConnection,
    openTransport: (currentTarget) => openPairedTransport(
      currentTarget,
      createRemoteLaunchBudget(),
      getAccountRelayProof,
      "auto",
    ),
  });

  try {
    const listed = await listProjectsOnBridge(bridge.socketUrl);
    const selected = pickProjectRecord(listed, {
      canonicalId: args.projectCanonicalId,
      rootPath: args.projectRootPath,
      name: args.projectQuery,
    });
    if (!selected) {
      throw new Error(`No project is registered on ${target.name}. Open it there once, then hop again.`);
    }
    const connection = await connectToAde({
      project: launchContextFor(target, selected.rootPath),
      socketPath: bridge.socketUrl,
      requireSocket: true,
      remote: true,
      projectRegistration: INTERACTIVE_PROJECT_REGISTRATION,
    });
    return {
      machineKey: args.query.machineKey,
      label: target.name,
      connection,
      projectRoot: selected.rootPath,
      remoteLabel: target.name,
      bridge,
    };
  } catch (error) {
    await bridge.close().catch(() => undefined);
    throw error;
  }
}

async function listProjectsOnBridge(socketUrl: string): Promise<RemoteRuntimeProjectRecord[]> {
  const client = await JsonRpcClient.connect(socketUrl);
  try {
    await client.request("ade/initialize", {
      protocolVersion: "2025-06-18",
      clientName: "ade-code",
      identity: { role: "cto", callerId: `ade-code-hop:${process.pid}` },
    });
    await client.request("ade/initialized");
    const raw = await client.request("projects.list", {});
    return sortProjectRecords(coerceProjectRecords(raw));
  } finally {
    client.close();
  }
}

function launchContextFor(target: RemoteRuntimeTarget, projectRoot: string): ProjectLaunchContext {
  return {
    launchCwd: projectRoot,
    projectRoot,
    workspaceRoot: projectRoot,
    laneHint: null,
    sessionHint: null,
    remote: true,
    remoteLabel: target.name,
  };
}
