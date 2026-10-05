/**
 * Brain -> brain connections to the account's other machines.
 *
 * One pool per CALLER CLASS (the CTO, ordinary agents), each with its own paired
 * device identity and its own `ade/initialize`. They must not share: a host
 * keeps one live connection per paired device and closes the older one, and
 * the identity a connection initializes with is the identity every call on it
 * carries. A CTO connection lent to an agent would hand the agent the CTO role.
 *
 * Transport: the paired runtime channel the TUI's `ade code` hop already uses
 * (`openPairedCandidate` -> `RuntimeRpcClient`), over LAN, Tailscale or ADE
 * Relay. Authentication is the account's: the pairing is created by the same
 * account-authenticated hello the desktop and TUI use (`pairListedMachine`),
 * and a Relay leg carries the account token. Nothing here connects while the
 * brain is signed out.
 *
 * Each pool pairs under the brain's own device identity for that class, never
 * the desktop's, so looking at a machine never drops the user's own desktop
 * connection to it.
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DesktopPairedMachineStore } from "../../../../desktop/src/main/services/remoteRuntime/syncPairedMachineStore";
import { RuntimeRpcClient } from "../../../../desktop/src/main/services/remoteRuntime/runtimeRpcClient";
import { PairedRuntimeCompatibilityError } from "../../../../desktop/src/main/services/remoteRuntime/pairedRuntimeErrors";
import { getOrCreateLocalAccountMachineIdentity } from "../../../../desktop/src/main/services/account/localMachineIdentity";
import {
  AmbiguousAccountMachineError,
  accountMachineDisplayName,
  selectAccountMachine,
} from "../../../../desktop/src/shared/accountDirectory";
import type { AdeAccountLocalMachineIdentity, AdeAccountMachine } from "../../../../desktop/src/shared/types/account";
import type { RemoteRuntimeTarget } from "../../../../desktop/src/shared/types/remoteRuntime";
import {
  openPairedCandidate,
  type AccountRelayProof,
} from "../../tuiClient/pairedRemoteConnector";
import { createRemoteLaunchBudget } from "../../tuiClient/remoteLaunchBudget";
import { resolveMachineAdeLayout } from "../projects/machineLayout";
import { SYNC_REMOTE_COMMAND_RESULT_MAX_BYTES } from "../sync/syncProtocol";
import { AccountMachineDirectoryService } from "./accountMachineDirectoryService";
import {
  getSignedInAccountAccessToken,
  type AccountAuthService,
} from "./accountAuthService";
import {
  getSharedAccountAuthService,
  getSharedAccountDirectoryBaseUrl,
} from "./sharedAccountAuthService";

/** Opening a route, including one re-pair. */
const CONNECT_BUDGET_MS = 25_000;
export const MACHINE_BRIDGE_DEFAULT_CALL_TIMEOUT_MS = 30_000;
export const MACHINE_BRIDGE_MAX_CALL_TIMEOUT_MS = 180_000;
const PROJECTS_LIST_TIMEOUT_MS = 10_000;
const PROJECTS_CACHE_MS = 60_000;
/** How long a directory read serves the tools (name resolution, routing). */
const DIRECTORY_CACHE_MS = 15_000;
const DIRECTORY_TIMEOUT_MS = 10_000;
/** A connection nobody used for this long is closed. */
const IDLE_CLOSE_MS = 90_000;

export type RemoteProjectRecord = {
  projectId: string;
  rootPath: string;
  displayName: string | null;
  gitOriginUrl: string | null;
  lastOpenedAt: number;
};

export type PooledConnection = {
  hostDeviceId: string;
  client: RuntimeRpcClient;
  projects: { at: number; records: RemoteProjectRecord[] } | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Calls in flight on this connection; the idle timer only runs at zero. */
  inFlight: number;
};

type AccountDirectory = Pick<AccountMachineDirectoryService, "listMachines" | "pairListedMachine">;

export type MachineBridgeLogger = {
  info(event: string, meta?: Record<string, unknown>): void;
  warn(event: string, meta?: Record<string, unknown>): void;
};

export type MachineConnectionPoolOptions = {
  /** Distinct per caller class; pools with the same id share connections. */
  poolId: string;
  /** File under the machine secrets dir holding this class's pairings. */
  pairedStoreFile: string;
  /** How this class's pairing is named on the target ("ADE CTO on <host>"). */
  deviceName: () => string;
  /** `ade/initialize` params every connection in this pool sends. */
  initializeParams: (appVersion: string) => Record<string, unknown>;
  appVersion: string;
  /** Project roots whose account config resolves the signed-in session. */
  projectRoots: () => string[];
  /** Who is asking, in user-facing errors: "the CTO", "agents". */
  who: string;
  /** What the target is too old to take: "CTO requests". */
  requestNoun: string;
  /** Log event prefix, e.g. "cto_cross_machine". */
  logPrefix: string;
  /**
   * An `ade/initialize` capability the target must advertise, beyond
   * multi-project support. Missing means "update ADE there".
   */
  requiredCapability?: string | null;
  logger?: MachineBridgeLogger | null;
};

/** This brain is not signed in to an ADE account, so no other machine is reachable. */
export class MachineAccountSignedOutError extends Error {
  readonly code = "account_signed_out";
}

/** A call to another machine did not answer in time; it may still have run there. */
export class MachineCallTimeoutError extends Error {
  readonly code = "machine_call_timeout";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function machineName(machine: AdeAccountMachine): string {
  return accountMachineDisplayName(machine) ?? machine.machineKey;
}

export function readGitOriginUrl(root: string): string | null {
  const result = spawnSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const value = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return value || null;
}

export function coerceProjects(value: unknown): RemoteProjectRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const projectId = typeof entry.projectId === "string" ? entry.projectId.trim() : "";
    const rootPath = typeof entry.rootPath === "string" ? entry.rootPath.trim() : "";
    if (!projectId || !rootPath) return [];
    return [{
      projectId,
      rootPath,
      displayName: typeof entry.displayName === "string" && entry.displayName.trim()
        ? entry.displayName.trim()
        : null,
      gitOriginUrl: typeof entry.gitOriginUrl === "string" ? entry.gitOriginUrl : null,
      lastOpenedAt: typeof entry.lastOpenedAt === "number" ? entry.lastOpenedAt : 0,
    }];
  });
}

export function resultByteLength(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function clampMachineCallTimeout(value: number | undefined): number {
  const requested = Number(value ?? MACHINE_BRIDGE_DEFAULT_CALL_TIMEOUT_MS);
  if (!Number.isFinite(requested) || requested <= 0) return MACHINE_BRIDGE_DEFAULT_CALL_TIMEOUT_MS;
  return Math.min(MACHINE_BRIDGE_MAX_CALL_TIMEOUT_MS, Math.ceil(requested));
}

// ── Machine-wide state ───────────────────────────────────────────────────────
// One connection per (pool, target machine) for the whole brain. Every project
// scope shares it: each connection from one pairing replaces the previous one
// on the host, so two project scopes with their own sockets would close each
// other in turn.

type PoolState = {
  connections: Map<string, Promise<PooledConnection>>;
  pairedStore: DesktopPairedMachineStore | null;
};

const pools = new Map<string, PoolState>();

function poolState(poolId: string): PoolState {
  let state = pools.get(poolId);
  if (!state) {
    state = { connections: new Map(), pairedStore: null };
    pools.set(poolId, state);
  }
  return state;
}

export type MachineConnectionPool = ReturnType<typeof createMachineConnectionPool>;

export function createMachineConnectionPool(options: MachineConnectionPoolOptions) {
  const logger = options.logger ?? null;
  const state = poolState(options.poolId);
  const pairedStore = (): DesktopPairedMachineStore => {
    state.pairedStore ??= new DesktopPairedMachineStore({
      filePath: path.join(resolveMachineAdeLayout().secretsDir, options.pairedStoreFile),
    });
    return state.pairedStore;
  };

  const dropConnection = (hostDeviceId: string, pooled?: PooledConnection | null): void => {
    const current = state.connections.get(hostDeviceId);
    if (!current) return;
    void current.then((entry) => {
      if (pooled && entry !== pooled) return;
      if (state.connections.get(hostDeviceId) === current) state.connections.delete(hostDeviceId);
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      try { entry.client.close(); } catch {}
    }, () => {
      if (state.connections.get(hostDeviceId) === current) state.connections.delete(hostDeviceId);
    });
  };

  /**
   * Restart the idle countdown. A connection with a call in flight never counts
   * as idle: calls may run up to three minutes, longer than `IDLE_CLOSE_MS`, and
   * closing the socket mid-call would lose a result the host may already have
   * produced.
   */
  const touch = (entry: PooledConnection): void => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    if (entry.inFlight > 0) return;
    entry.idleTimer = setTimeout(() => dropConnection(entry.hostDeviceId, entry), IDLE_CLOSE_MS);
    entry.idleTimer.unref?.();
  };

  const account = (): Pick<AccountAuthService, "getStatus" | "getAccessToken"> =>
    getSharedAccountAuthService({ projectRoots: options.projectRoots });

  /** A local read of the stored session; no network. */
  const isSignedIn = (): boolean => {
    try {
      const status = account().getStatus();
      return status.signedIn || status.source === "env-token";
    } catch {
      return false;
    }
  };

  const notSignedInMessage = `This computer's ADE is not signed in to an ADE account, so ${options.who} can't reach your other machines.`;

  const directory = (): AccountDirectory =>
    new AccountMachineDirectoryService(account(), {
      appVersion: options.appVersion,
      directoryBaseUrl: () => getSharedAccountDirectoryBaseUrl({ projectRoots: options.projectRoots }),
      pairedStore: pairedStore(),
      // This pairing is the brain's own. It must never appear in the user's
      // Connections list, so the target it would save is kept in memory.
      targetRegistry: {
        save: (input) => ({
          id: `${options.poolId}:${input.pairedMachine?.machineKey ?? input.hostname}`,
          name: input.name ?? input.hostname,
          hostname: input.hostname,
          transport: "paired",
          pairedMachine: input.pairedMachine ?? null,
          accountOwnerUserId: input.accountOwnerUserId ?? null,
          sshUser: null,
          port: null,
          sshKeyPath: null,
          routes: [],
          lastSeenArch: null,
          runtimeBinaryVersion: null,
          lastConnectedAt: null,
        }),
      },
      deviceName: options.deviceName,
    });

  let localIdentity: AdeAccountLocalMachineIdentity | null = null;
  const thisMachine = (): AdeAccountLocalMachineIdentity | null => {
    if (localIdentity) return localIdentity;
    try {
      localIdentity = getOrCreateLocalAccountMachineIdentity();
    } catch {
      localIdentity = null;
    }
    return localIdentity;
  };
  const isThisMachine = (machine: AdeAccountMachine): boolean => {
    const local = thisMachine();
    if (!local) return false;
    return machine.machineKey === local.machineKey
      || (Boolean(machine.deviceId) && machine.deviceId === local.deviceId);
  };

  let directoryCache: { at: number; machines: AdeAccountMachine[] } | null = null;
  const listAccountMachines = async (fresh = false): Promise<AdeAccountMachine[]> => {
    if (!fresh && directoryCache && Date.now() - directoryCache.at < DIRECTORY_CACHE_MS) {
      return directoryCache.machines;
    }
    // Signed out: say so without a directory request.
    const listed = isSignedIn()
      ? await directory().listMachines({ timeoutMs: DIRECTORY_TIMEOUT_MS })
      : { state: "signed_out" as const };
    if (listed.state === "signed_out" || listed.state === "auth_expired") {
      directoryCache = null;
      throw new MachineAccountSignedOutError(`${notSignedInMessage} Sign in to ADE here, then try again.`);
    }
    if (listed.state !== "ok") {
      throw new Error(
        `ADE couldn't read your account's machines${listed.message ? `: ${listed.message}` : "."}`,
      );
    }
    directoryCache = { at: Date.now(), machines: listed.machines };
    return listed.machines;
  };

  const relayProof = async (): Promise<AccountRelayProof | null> => {
    const service = account();
    const token = await getSignedInAccountAccessToken(service);
    if (!token) return null;
    const userId = service.getStatus().userId?.trim() ?? "";
    return userId ? { userId, token } : null;
  };

  const signedInUserId = (): string => {
    const status = account().getStatus();
    const userId = status.signedIn ? status.userId?.trim() ?? "" : "";
    if (!userId) throw new MachineAccountSignedOutError(notSignedInMessage);
    return userId;
  };

  const openConnection = async (machine: AdeAccountMachine): Promise<PooledConnection> => {
    const hostDeviceId = machine.deviceId?.trim() ?? "";
    if (!hostDeviceId) throw new Error(`${machineName(machine)} has no stable device id on your account yet.`);
    const userId = signedInUserId();
    const store = pairedStore();
    const budget = createRemoteLaunchBudget(CONNECT_BUDGET_MS);
    const target: RemoteRuntimeTarget = {
      id: `${options.poolId}:${machine.machineKey}`,
      name: machineName(machine),
      hostname: machineName(machine),
      transport: "paired",
      pairedMachine: { hostIdentity: hostDeviceId, machineKey: machine.machineKey },
      accountOwnerUserId: userId,
      sshUser: null,
      port: null,
      sshKeyPath: null,
      routes: [],
      lastSeenArch: null,
      runtimeBinaryVersion: null,
      lastConnectedAt: null,
    };
    const saved = store.get(hostDeviceId) ?? store.get(machine.machineKey);
    const pair = async () => {
      await directory().pairListedMachine(machine, {
        connectTimeoutMs: 10_000,
        pairingTimeoutMs: 10_000,
        signal: budget.signal,
      });
    };
    const open = async (): Promise<RuntimeRpcClient> => {
      const opened = await openPairedCandidate({
        target,
        budget,
        appVersion: options.appVersion,
        getAccountRelayProof: relayProof,
        routePreference: "auto",
        pairedStore: store,
        acceptTransport: async (transport) => {
          const client = new RuntimeRpcClient(transport, MACHINE_BRIDGE_DEFAULT_CALL_TIMEOUT_MS);
          try {
            const initialized = await client.call(
              "ade/initialize",
              options.initializeParams(options.appVersion),
              { timeoutMs: PROJECTS_LIST_TIMEOUT_MS },
            );
            const info = isRecord(initialized) && isRecord(initialized.runtimeInfo)
              ? initialized.runtimeInfo
              : null;
            const capabilities = isRecord(initialized) && isRecord(initialized.capabilities)
              ? initialized.capabilities
              : null;
            const required = options.requiredCapability ?? null;
            if (
              (info?.multiProject !== true && capabilities?.projects !== true)
              || (required && capabilities?.[required] !== true)
            ) {
              throw new PairedRuntimeCompatibilityError(
                `${machineName(machine)} runs an ADE too old to take ${options.requestNoun}. Update ADE there.`,
              );
            }
            await client.call("ade/initialized", {}, { timeoutMs: PROJECTS_LIST_TIMEOUT_MS }).catch(() => undefined);
            return client;
          } catch (error) {
            client.close();
            throw error;
          }
        },
      });
      return opened.value;
    };

    let client: RuntimeRpcClient;
    const reusable = saved && saved.accountOwnerUserId === userId;
    if (!reusable) {
      await pair();
      client = await open();
    } else {
      try {
        client = await open();
      } catch (error) {
        if (error instanceof PairedRuntimeCompatibilityError) throw error;
        // Saved routes go stale (new LAN address, host re-keyed, pairing
        // removed on the host). Re-pairing once through the account refreshes
        // them; if that fails, its error is the answer.
        logger?.info(`${options.logPrefix}.repair_pairing`, {
          machineKey: machine.machineKey,
          reason: errorMessage(error),
        });
        await pair();
        client = await open();
      }
    }
    const entry: PooledConnection = { hostDeviceId, client, projects: null, idleTimer: null, inFlight: 0 };
    client.onDisconnect(() => dropConnection(hostDeviceId, entry));
    touch(entry);
    logger?.info(`${options.logPrefix}.connected`, { machineKey: machine.machineKey });
    return entry;
  };

  const acquire = async (machine: AdeAccountMachine): Promise<PooledConnection> => {
    const hostDeviceId = machine.deviceId?.trim() ?? machine.machineKey;
    const existing = state.connections.get(hostDeviceId);
    if (existing) {
      const entry = await existing.catch(() => null);
      if (entry && !entry.client.isClosed()) {
        touch(entry);
        return entry;
      }
      if (state.connections.get(hostDeviceId) === existing) state.connections.delete(hostDeviceId);
    }
    const pending = openConnection(machine);
    state.connections.set(hostDeviceId, pending);
    try {
      return await pending;
    } catch (error) {
      if (state.connections.get(hostDeviceId) === pending) state.connections.delete(hostDeviceId);
      throw new Error(`Couldn't reach ${machineName(machine)}: ${errorMessage(error)}`, { cause: error });
    }
  };

  /** The target's registered projects, cached per connection for a minute. */
  const listProjects = async (entry: PooledConnection, fresh = false): Promise<RemoteProjectRecord[]> => {
    if (fresh || !entry.projects || Date.now() - entry.projects.at > PROJECTS_CACHE_MS) {
      const raw = await entry.client.call("projects.list", {}, { timeoutMs: PROJECTS_LIST_TIMEOUT_MS });
      entry.projects = { at: Date.now(), records: coerceProjects(raw) };
    }
    return entry.projects.records;
  };

  /**
   * One request on an established connection. A JSON-RPC error is the target
   * saying no, and its message is passed on verbatim. A connection that dies
   * mid-call is reported as such: the call may or may not have run there, and
   * it is never retried.
   */
  const request = async (
    machine: AdeAccountMachine,
    entry: PooledConnection,
    label: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> => {
    entry.inFlight += 1;
    touch(entry);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new MachineCallTimeoutError(
        `${machineName(machine)} did not answer ${label} within ${Math.round(timeoutMs / 1000)}s. It may still have run there.`,
      )), timeoutMs + 1_000);
      timer.unref?.();
    });
    try {
      return await Promise.race([entry.client.call(method, params, { timeoutMs }), timedOut]);
    } catch (error) {
      if (error instanceof MachineCallTimeoutError) throw error;
      if (entry.client.isClosed()) {
        dropConnection(entry.hostDeviceId, entry);
        throw new Error(
          `The connection to ${machineName(machine)} dropped during ${label} (${errorMessage(error)}). It may or may not have run there; check before repeating it.`,
          { cause: error },
        );
      }
      throw new Error(`${machineName(machine)} refused ${label}: ${errorMessage(error)}`, { cause: error });
    } finally {
      if (timer) clearTimeout(timer);
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      if (!entry.client.isClosed()) touch(entry);
    }
  };

  /**
   * What `ade/actions/call` answered, from any machine: a refusal becomes an
   * error carrying the machine's message verbatim, and an answer over the
   * transport cap is refused rather than passed on.
   */
  const checkActionResponse = (
    source: string,
    label: string,
    value: unknown,
    machineKey: string | null,
  ): unknown => {
    if (isRecord(value) && value.ok === false) {
      const error = isRecord(value.error) ? value.error : {};
      const message = typeof error.message === "string" ? error.message : "The action failed.";
      throw new Error(`${source} refused ${label}: ${message}`);
    }
    const bytes = resultByteLength(value);
    if (bytes > SYNC_REMOTE_COMMAND_RESULT_MAX_BYTES) {
      throw new Error(
        `${source} returned ${label} at ${bytes} bytes, over the ${SYNC_REMOTE_COMMAND_RESULT_MAX_BYTES}-byte limit. Narrow the request.`,
      );
    }
    logger?.info(`${options.logPrefix}.action`, { machineKey, label, bytes });
    return value;
  };

  /**
   * Resolve an id or a display name. A miss on a cached directory read looks
   * once more, fresh, in case the machine was renamed since.
   */
  const selectMachine = async (query: string): Promise<AdeAccountMachine> => {
    const trimmed = query.trim();
    if (!trimmed) throw new Error("machine must be a machine id or name.");
    let machines = await listAccountMachines();
    try {
      try {
        return selectAccountMachine(machines, trimmed);
      } catch (error) {
        if (error instanceof AmbiguousAccountMachineError) throw error;
        machines = await listAccountMachines(true);
        return selectAccountMachine(machines, trimmed);
      }
    } catch (error) {
      const message = errorMessage(error);
      if (error instanceof AmbiguousAccountMachineError) throw new Error(`${message} Pass the machine id from listMachines.`);
      const known = machines.map((candidate) => `${machineName(candidate)} (${candidate.machineKey})`);
      throw new Error(
        `No machine on your ADE account matches "${trimmed}".${known.length ? ` Machines: ${known.join(", ")}.` : ""}`,
      );
    }
  };

  return {
    isSignedIn,
    thisMachine,
    isThisMachine,
    listAccountMachines,
    /** The cached directory read, if any; never touches the network. */
    peekDirectory: (): { at: number; machines: AdeAccountMachine[] } | null => directoryCache,
    clearDirectory: (): void => { directoryCache = null; },
    acquire,
    dropConnection,
    listProjects,
    request,
    checkActionResponse,
    selectMachine,
  };
}
