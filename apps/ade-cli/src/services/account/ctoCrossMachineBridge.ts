/**
 * Brain -> brain calls for the CTO.
 *
 * The CTO runs on one home machine. This lets its tools run ONE ADE action on
 * another machine on the same ADE account, in that machine's checkout of the
 * same repository.
 *
 * Transport: the paired runtime channel the TUI's `ade code` hop already uses
 * (`openPairedCandidate` -> `RuntimeRpcClient`), over LAN, Tailscale or ADE
 * Relay. Authentication is the account's: the pairing is created by the same
 * account-authenticated hello the desktop and TUI use (`pairListedMachine`),
 * and a Relay leg carries the account token. Nothing here connects while the
 * brain is signed out.
 *
 * The brain pairs under ITS OWN device identity (`cto-paired-machines.json`),
 * not the desktop's. A host keeps one live connection per paired device and
 * closes the older one, so borrowing the desktop's pairing would drop the
 * user's own desktop connection to that machine every time the CTO looked.
 *
 * Caller identity: the channel initializes as role `cto` under
 * `CTO_REMOTE_CLIENT_NAME`, which is not a desktop name. The target clamps the
 * role to its own ceiling, applies its own action allowlist and CTO-only rules,
 * refuses its user-only and secret-bearing actions, and does not count the
 * caller as a user client. Nothing here can reach more on the target than a CTO
 * there could. The home machine runs the generic actions through this brain's
 * own dispatcher under the same identity (`createCtoActionCaller`), so both
 * paths apply one policy.
 *
 * Cost: nothing here reads the account directory until a cross-machine tool
 * runs. After that the live-state roster refreshes in the background at most
 * every few minutes, and never while signed out or turned off.
 *
 * The user's switch (Settings › CTO, "Let the CTO reach my other machines")
 * turns all of it off.
 */
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DesktopPairedMachineStore } from "../../../../desktop/src/main/services/remoteRuntime/syncPairedMachineStore";
import { RuntimeRpcClient } from "../../../../desktop/src/main/services/remoteRuntime/runtimeRpcClient";
import {
  isPairedRuntimeSupersededError,
  PairedRuntimeCompatibilityError,
} from "../../../../desktop/src/main/services/remoteRuntime/pairedRuntimeErrors";
import { getOrCreateLocalAccountMachineIdentity } from "../../../../desktop/src/main/services/account/localMachineIdentity";
import { normalizeGitRemoteIdentity } from "../../../../desktop/src/shared/crossMachineHandoff";
import {
  accountMachineDisplayName,
  selectAccountMachine,
} from "../../../../desktop/src/shared/accountDirectory";
import { accountMachinePresence } from "../../../../desktop/src/shared/machinePresence";
import {
  CTO_REMOTE_CLIENT_NAME,
  ctoCallerInitializeParams,
} from "../../../../desktop/src/shared/runtimeClientNames";
import type { AdeAccountLocalMachineIdentity, AdeAccountMachine } from "../../../../desktop/src/shared/types/account";
import type { RemoteRuntimeTarget } from "../../../../desktop/src/shared/types/remoteRuntime";
import {
  CTO_CROSS_MACHINE_DISABLED_MESSAGE,
  type CtoCrossMachineDeps,
  type CtoMachineListResult,
  type CtoMachineSummary,
  type CtoMachineActionInfo,
  type CtoMachineTarget,
  type CtoRemoteActionCall,
} from "../../../../desktop/src/main/services/ai/tools/ctoCrossMachine";
import { isSecretBearingAdeAction } from "../../../../desktop/src/main/services/adeActions/actionPolicy";
import type { CtoActionCaller } from "../../adeRpcServer";
import {
  openPairedCandidate,
  type AccountRelayProof,
} from "../../tuiClient/pairedRemoteConnector";
import { createRemoteLaunchBudget, withTimeout } from "../../tuiClient/remoteLaunchBudget";
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

export { CTO_REMOTE_CLIENT_NAME };
const CTO_PAIRED_STORE_FILE = "cto-paired-machines.json";
/** Opening a route, including one re-pair. */
const CONNECT_BUDGET_MS = 25_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const MAX_CALL_TIMEOUT_MS = 180_000;
const PROJECTS_LIST_TIMEOUT_MS = 10_000;
const PROJECTS_CACHE_MS = 60_000;
/** How long a directory read serves the tools (name resolution, routing). */
const DIRECTORY_CACHE_MS = 15_000;
/** How often the live-state roster may read the directory in the background. */
const ROSTER_REFRESH_MS = 5 * 60_000;
const DIRECTORY_TIMEOUT_MS = 10_000;
/** A connection nobody used for this long is closed. */
const IDLE_CLOSE_MS = 90_000;
/** One slow machine must not hold `listMachines` hostage. */
const LIST_PER_MACHINE_BUDGET_MS = 20_000;
/** The live-state roster is a glance, not a directory dump. */
const ROSTER_MAX_MACHINES = 12;
/** An all-domain action listing names actions only; one domain also carries inputs. */
const ACTION_LIST_MAX_ROWS = 600;

function shapeActionList(
  rows: unknown[],
  domain: string | null,
): { count: number; actions: CtoMachineActionInfo[] } {
  const actions = rows.flatMap((row): CtoMachineActionInfo[] => {
    if (!isRecord(row) || typeof row.domain !== "string" || typeof row.action !== "string") return [];
    // A target on an older ADE may still list these; the CTO can't run them.
    if (isSecretBearingAdeAction(row.domain, row.action)) return [];
    return [{
      domain: row.domain,
      action: row.action,
      ...(typeof row.description === "string" ? { description: row.description } : {}),
      ...(domain && row.input !== undefined ? { input: row.input } : {}),
      ...(domain && row.example !== undefined ? { example: row.example } : {}),
    }];
  });
  return { count: actions.length, actions: actions.slice(0, ACTION_LIST_MAX_ROWS) };
}

type RemoteProjectRecord = {
  projectId: string;
  rootPath: string;
  gitOriginUrl: string | null;
  lastOpenedAt: number;
};

type PooledConnection = {
  hostDeviceId: string;
  client: RuntimeRpcClient;
  projects: { at: number; records: RemoteProjectRecord[] } | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Calls in flight on this connection; the idle timer only runs at zero. */
  inFlight: number;
};

type AccountDirectory = Pick<AccountMachineDirectoryService, "listMachines" | "pairListedMachine">;

/** The user's switch, as the CTO's settings store it. */
export type CtoCrossMachineAccess = {
  enabled: boolean;
};

export type CtoCrossMachineBridgeOptions = {
  projectRoot: string;
  appVersion: string;
  /**
   * This brain's action dispatcher, as the CTO caller, for `runAction` and
   * `listActions` aimed at the home machine. A thunk: the runtime it runs on
   * is assembled after the chat service that builds the CTO's tools. Null
   * until that runtime exists.
   */
  getLocalActionCaller?: () => Promise<CtoActionCaller> | null;
  /** Read on every call; absent means on. */
  getAccess?: () => CtoCrossMachineAccess;
  logger?: {
    info(event: string, meta?: Record<string, unknown>): void;
    warn(event: string, meta?: Record<string, unknown>): void;
  } | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function machineName(machine: AdeAccountMachine): string {
  return accountMachineDisplayName(machine) ?? machine.machineKey;
}

function readGitOriginUrl(root: string): string | null {
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

function coerceProjects(value: unknown): RemoteProjectRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const projectId = typeof entry.projectId === "string" ? entry.projectId.trim() : "";
    const rootPath = typeof entry.rootPath === "string" ? entry.rootPath.trim() : "";
    if (!projectId || !rootPath) return [];
    return [{
      projectId,
      rootPath,
      gitOriginUrl: typeof entry.gitOriginUrl === "string" ? entry.gitOriginUrl : null,
      lastOpenedAt: typeof entry.lastOpenedAt === "number" ? entry.lastOpenedAt : 0,
    }];
  });
}

function resultByteLength(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** `run_ade_action`'s arguments for one call, identical for every machine. */
function runActionArguments(call: CtoRemoteActionCall): Record<string, unknown> {
  return {
    domain: call.domain,
    action: call.action,
    ...(call.args ? { args: call.args } : {}),
    ...(call.arg !== undefined ? { arg: call.arg } : {}),
  };
}

/** `run_ade_action` answers `{ domain, action, result, statusHints }`; the caller wants `result`. */
function runActionResult(value: unknown): unknown {
  return isRecord(value) && "result" in value ? value.result : value;
}

function clampTimeout(value: number | undefined): number {
  const requested = Number(value ?? DEFAULT_CALL_TIMEOUT_MS);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_CALL_TIMEOUT_MS;
  return Math.min(MAX_CALL_TIMEOUT_MS, Math.ceil(requested));
}

// ── Machine-wide state ───────────────────────────────────────────────────────
// One connection per target machine for the whole brain. Every project scope
// shares it: each connection from this brain's pairing replaces the previous
// one on the host, so two project scopes with their own sockets would close
// each other in turn.

const connections = new Map<string, Promise<PooledConnection>>();
let ctoPairedStore: DesktopPairedMachineStore | null = null;

function getCtoPairedStore(): DesktopPairedMachineStore {
  ctoPairedStore ??= new DesktopPairedMachineStore({
    filePath: path.join(resolveMachineAdeLayout().secretsDir, CTO_PAIRED_STORE_FILE),
  });
  return ctoPairedStore;
}

function dropConnection(hostDeviceId: string, pooled?: PooledConnection | null): void {
  const current = connections.get(hostDeviceId);
  if (!current) return;
  void current.then((entry) => {
    if (pooled && entry !== pooled) return;
    if (connections.get(hostDeviceId) === current) connections.delete(hostDeviceId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try { entry.client.close(); } catch {}
  }, () => {
    if (connections.get(hostDeviceId) === current) connections.delete(hostDeviceId);
  });
}

/**
 * Restart the idle countdown. A connection with a call in flight never counts
 * as idle: calls may run up to three minutes, longer than `IDLE_CLOSE_MS`, and
 * closing the socket mid-call would lose a result the host may already have
 * produced.
 */
function touch(entry: PooledConnection): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
  if (entry.inFlight > 0) return;
  entry.idleTimer = setTimeout(() => dropConnection(entry.hostDeviceId, entry), IDLE_CLOSE_MS);
  entry.idleTimer.unref?.();
}

export function createCtoCrossMachineBridge(
  options: CtoCrossMachineBridgeOptions,
): CtoCrossMachineDeps {
  const logger = options.logger ?? null;
  const account = (): Pick<AccountAuthService, "getStatus" | "getAccessToken"> =>
    getSharedAccountAuthService({ projectRoots: () => [options.projectRoot] });
  const access = (): CtoCrossMachineAccess => options.getAccess?.() ?? { enabled: true };
  const assertEnabled = (): void => {
    if (!access().enabled) throw new Error(CTO_CROSS_MACHINE_DISABLED_MESSAGE);
  };
  /** A local read of the stored session; no network. */
  const isSignedIn = (): boolean => {
    try {
      const status = account().getStatus();
      return status.signedIn || status.source === "env-token";
    } catch {
      return false;
    }
  };
  const directory = (): AccountDirectory =>
    new AccountMachineDirectoryService(account(), {
      appVersion: options.appVersion,
      directoryBaseUrl: () => getSharedAccountDirectoryBaseUrl({
        projectRoots: () => [options.projectRoot],
      }),
      pairedStore: getCtoPairedStore(),
      // The CTO's pairing is the brain's own. It must never appear in the
      // user's Connections list, so the target it would save is kept in memory.
      targetRegistry: {
        save: (input) => ({
          id: `cto:${input.pairedMachine?.machineKey ?? input.hostname}`,
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
      deviceName: () => `ADE CTO on ${os.hostname()}`,
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

  let originCache: { identity: string | null; raw: string | null } | null = null;
  const projectOrigin = (): { identity: string | null; raw: string | null } => {
    if (!originCache) {
      const raw = readGitOriginUrl(options.projectRoot);
      originCache = { raw, identity: normalizeGitRemoteIdentity(raw) };
    }
    return originCache;
  };

  let directoryCache: { at: number; machines: AdeAccountMachine[] } | null = null;
  let rosterRefresh: Promise<unknown> | null = null;
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
      throw new Error(
        "This computer's ADE is not signed in to an ADE account, so the CTO can't reach your other machines. Sign in to ADE here, then try again.",
      );
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
    if (!userId) {
      throw new Error(
        "This computer's ADE is not signed in to an ADE account, so the CTO can't reach your other machines.",
      );
    }
    return userId;
  };

  const openConnection = async (machine: AdeAccountMachine): Promise<PooledConnection> => {
    const hostDeviceId = machine.deviceId?.trim() ?? "";
    if (!hostDeviceId) throw new Error(`${machineName(machine)} has no stable device id on your account yet.`);
    const userId = signedInUserId();
    const store = getCtoPairedStore();
    const budget = createRemoteLaunchBudget(CONNECT_BUDGET_MS);
    const target: RemoteRuntimeTarget = {
      id: `cto:${machine.machineKey}`,
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
          const client = new RuntimeRpcClient(transport, DEFAULT_CALL_TIMEOUT_MS);
          try {
            const initialized = await client.call(
              "ade/initialize",
              ctoCallerInitializeParams(options.appVersion),
              { timeoutMs: PROJECTS_LIST_TIMEOUT_MS },
            );
            const info = isRecord(initialized) && isRecord(initialized.runtimeInfo)
              ? initialized.runtimeInfo
              : null;
            const capabilities = isRecord(initialized) && isRecord(initialized.capabilities)
              ? initialized.capabilities
              : null;
            if (info?.multiProject !== true && capabilities?.projects !== true) {
              throw new PairedRuntimeCompatibilityError(
                `${machineName(machine)} runs an ADE too old to take CTO requests. Update ADE there.`,
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
        logger?.info("cto_cross_machine.repair_pairing", {
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
    logger?.info("cto_cross_machine.connected", { machineKey: machine.machineKey });
    return entry;
  };

  const acquire = async (machine: AdeAccountMachine): Promise<PooledConnection> => {
    const hostDeviceId = machine.deviceId?.trim() ?? machine.machineKey;
    const existing = connections.get(hostDeviceId);
    if (existing) {
      const entry = await existing.catch(() => null);
      if (entry && !entry.client.isClosed()) {
        touch(entry);
        return entry;
      }
      if (connections.get(hostDeviceId) === existing) connections.delete(hostDeviceId);
    }
    const pending = openConnection(machine);
    connections.set(hostDeviceId, pending);
    try {
      return await pending;
    } catch (error) {
      if (connections.get(hostDeviceId) === pending) connections.delete(hostDeviceId);
      throw new Error(`Couldn't reach ${machineName(machine)}: ${errorMessage(error)}`, { cause: error });
    }
  };

  /** What the roster knows about each machine's copy of this project. */
  const hasProjectByMachine = new Map<string, boolean>();

  const findProject = async (
    entry: PooledConnection,
    machine: AdeAccountMachine,
  ): Promise<RemoteProjectRecord | null> => {
    const origin = projectOrigin().identity;
    if (!origin) {
      throw new Error(
        "This project has no git origin remote, so ADE can't find the same repository on your other machines.",
      );
    }
    if (!entry.projects || Date.now() - entry.projects.at > PROJECTS_CACHE_MS) {
      const raw = await entry.client.call("projects.list", {}, { timeoutMs: PROJECTS_LIST_TIMEOUT_MS });
      entry.projects = { at: Date.now(), records: coerceProjects(raw) };
    }
    // The same repository can be registered twice on one machine (two
    // checkouts). The one opened most recently is the one in use.
    const matches = entry.projects.records
      .filter((record) => normalizeGitRemoteIdentity(record.gitOriginUrl) === origin)
      .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
    hasProjectByMachine.set(machine.machineKey, matches.length > 0);
    return matches[0] ?? null;
  };

  const machineForTarget = async (target: CtoMachineTarget): Promise<AdeAccountMachine> => {
    const machines = await listAccountMachines();
    const machine = machines.find((candidate) => candidate.machineKey === target.machineId);
    if (!machine) throw new Error(`${target.name} is no longer on your ADE account.`);
    return machine;
  };

  /** A connection to `machine` plus this project's checkout on it. */
  const connectToProject = async (
    machine: AdeAccountMachine,
  ): Promise<{ entry: PooledConnection; project: RemoteProjectRecord }> => {
    if (!machine.online) {
      throw new Error(`${machineName(machine)} is offline, so the CTO can't reach it right now.`);
    }
    let entry = await acquire(machine);
    let project: RemoteProjectRecord | null;
    try {
      project = await findProject(entry, machine);
    } catch (error) {
      // A pooled connection the host closed under us (idle route drop, or a
      // newer connection from this brain's pairing) is reopened once. Nothing
      // was sent yet, so the retry cannot repeat an action.
      const closed = entry.client.isClosed()
        || isPairedRuntimeSupersededError(error instanceof Error ? error.cause : null);
      if (!closed) throw error;
      dropConnection(entry.hostDeviceId, entry);
      entry = await acquire(machine);
      project = await findProject(entry, machine);
    }
    if (!project) {
      const origin = projectOrigin().identity;
      throw new Error(
        `${machineName(machine)} doesn't have this project (${origin ?? "no origin"}). Open the repository in ADE on that machine once, then try again.`,
      );
    }
    return { entry, project };
  };

  /**
   * What `ade/actions/call` answered, from any machine: a refusal becomes an
   * error carrying the machine's message verbatim, and an answer over the
   * transport cap is refused rather than passed on.
   */
  const readActionResponse = (
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
    logger?.info("cto_cross_machine.action", { machineKey, label, bytes });
    return value;
  };

  /**
   * One request on an established connection. A JSON-RPC error is the target
   * saying no, and its message is passed on verbatim. A connection that dies
   * mid-call is reported as such: the action may or may not have run there,
   * and it is never retried.
   */
  const requestOnMachine = async (
    machine: AdeAccountMachine,
    entry: PooledConnection,
    label: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> => {
    let value: unknown;
    entry.inFlight += 1;
    touch(entry);
    try {
      value = await withTimeout(
        entry.client.call("ade/actions/call", params, { timeoutMs }),
        timeoutMs + 1_000,
        `${machineName(machine)} did not answer ${label} within ${Math.round(timeoutMs / 1000)}s. It may still have run there.`,
      );
    } catch (error) {
      if (entry.client.isClosed()) {
        dropConnection(entry.hostDeviceId, entry);
        throw new Error(
          `The connection to ${machineName(machine)} dropped during ${label} (${errorMessage(error)}). It may or may not have run there; check before repeating it.`,
          { cause: error },
        );
      }
      if (/did not answer .* within/.test(errorMessage(error))) throw error;
      throw new Error(`${machineName(machine)} refused ${label}: ${errorMessage(error)}`, { cause: error });
    } finally {
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      if (!entry.client.isClosed()) touch(entry);
    }
    return readActionResponse(machineName(machine), label, value, machine.machineKey);
  };

  const callOnMachine = async (
    machine: AdeAccountMachine,
    call: CtoRemoteActionCall,
  ): Promise<unknown> => {
    const { entry, project } = await connectToProject(machine);
    const value = await requestOnMachine(machine, entry, `${call.domain}.${call.action}`, {
      projectId: project.projectId,
      name: "run_ade_action",
      arguments: runActionArguments(call),
    }, clampTimeout(call.timeoutMs));
    return runActionResult(value);
  };

  const listActionsOnMachine = async (
    machine: AdeAccountMachine,
    domain: string | null,
  ): Promise<{ count: number; actions: CtoMachineActionInfo[] }> => {
    const { entry, project } = await connectToProject(machine);
    const value = await requestOnMachine(machine, entry, "list_ade_actions", {
      projectId: project.projectId,
      name: "list_ade_actions",
      arguments: { domain: domain ?? "all" },
    }, DEFAULT_CALL_TIMEOUT_MS);
    const rows = isRecord(value) && Array.isArray(value.actions) ? value.actions : [];
    return shapeActionList(rows, domain);
  };

  const localCaller = async (): Promise<CtoActionCaller> => {
    const caller = await options.getLocalActionCaller?.();
    if (!caller) throw new Error("ADE actions are not available on this runtime yet.");
    return caller;
  };

  const callLocally = async (call: CtoRemoteActionCall): Promise<unknown> => {
    const caller = await localCaller();
    const label = `${call.domain}.${call.action}`;
    const timeoutMs = clampTimeout(call.timeoutMs);
    const value = await withTimeout(
      caller("run_ade_action", runActionArguments(call)),
      timeoutMs,
      `${label} did not finish within ${Math.round(timeoutMs / 1000)}s on this machine. It may still be running.`,
    );
    return runActionResult(readActionResponse("This machine", label, value, null));
  };

  const listLocally = async (domain: string | null): Promise<{ count: number; actions: CtoMachineActionInfo[] }> => {
    const caller = await localCaller();
    const value = readActionResponse(
      "This machine",
      "list_ade_actions",
      await caller("list_ade_actions", { domain: domain ?? "all" }),
      null,
    );
    return shapeActionList(isRecord(value) && Array.isArray(value.actions) ? value.actions : [], domain);
  };

  const resolveMachine = async (query: string): Promise<CtoMachineTarget> => {
    const trimmed = query.trim();
    if (!trimmed) throw new Error("machine must be a machine id or name.");
    if (!access().enabled) {
      // Naming the home machine works with the switch off, as omitting it does.
      // Matched locally: the account directory is not read while it is off.
      const home = homeMachine();
      const local = thisMachine();
      const needle = trimmed.toLowerCase();
      const hostname = os.hostname().toLowerCase();
      const names = [
        home.machineId,
        local?.deviceId ?? "",
        home.name,
        hostname,
        hostname.replace(/\.local$/, ""),
      ].map((name) => name.toLowerCase()).filter(Boolean);
      if (names.includes(needle)) return home;
      throw new Error(CTO_CROSS_MACHINE_DISABLED_MESSAGE);
    }
    let machines = await listAccountMachines();
    let machine: AdeAccountMachine;
    try {
      try {
        machine = selectAccountMachine(machines, trimmed);
      } catch (error) {
        // A machine renamed since the cached read: look once more, fresh.
        if (/ambiguous/i.test(errorMessage(error))) throw error;
        machines = await listAccountMachines(true);
        machine = selectAccountMachine(machines, trimmed);
      }
    } catch (error) {
      const message = errorMessage(error);
      if (/ambiguous/i.test(message)) throw new Error(`${message} Pass the machine id from listMachines.`);
      const known = machines.map((candidate) => `${machineName(candidate)} (${candidate.machineKey})`);
      throw new Error(
        `No machine on your ADE account matches "${trimmed}".${known.length ? ` Machines: ${known.join(", ")}.` : ""}`,
      );
    }
    return {
      machineId: machine.machineKey,
      name: machineName(machine),
      isThisMachine: isThisMachine(machine),
    };
  };

  const summarizeRemote = async (
    machine: AdeAccountMachine,
    includeWork: boolean,
  ): Promise<Pick<CtoMachineSummary, "hasProject" | "projectRoot" | "laneCount" | "runningChatCount" | "note">> => {
    if (!machine.online) {
      return { hasProject: null, projectRoot: null, note: "Offline; project not checked." };
    }
    try {
      const entry = await acquire(machine);
      const project = await findProject(entry, machine);
      if (!project) return { hasProject: false, projectRoot: null };
      if (!includeWork) return { hasProject: true, projectRoot: project.rootPath };
      const [lanes, chats] = await Promise.all([
        callOnMachine(machine, {
          domain: "lane",
          action: "list",
          args: { includeArchived: false, includeStatus: false },
          timeoutMs: 15_000,
        }).catch(() => null),
        callOnMachine(machine, {
          domain: "chat",
          action: "listSessions",
          args: { includeIdentity: false, includeAutomation: false },
          timeoutMs: 15_000,
        }).catch(() => null),
      ]);
      return {
        hasProject: true,
        projectRoot: project.rootPath,
        laneCount: Array.isArray(lanes) ? lanes.length : null,
        runningChatCount: Array.isArray(chats)
          ? chats.filter((chat) => isRecord(chat) && chat.status === "active").length
          : null,
      };
    } catch (error) {
      return { hasProject: null, projectRoot: null, note: errorMessage(error) };
    }
  };

  const homeMachine = (): CtoMachineTarget => {
    const local = thisMachine();
    const listed = directoryCache?.machines.find(isThisMachine) ?? null;
    return {
      machineId: local?.machineKey ?? listed?.machineKey ?? "this-machine",
      name: listed ? machineName(listed) : os.hostname(),
      isThisMachine: true,
    };
  };

  return {
    homeMachine,
    resolveMachine,

    async listMachines(listOptions = {}): Promise<CtoMachineListResult> {
      if (!access().enabled) {
        return { state: "disabled", message: CTO_CROSS_MACHINE_DISABLED_MESSAGE, machines: [] };
      }
      let machines: AdeAccountMachine[];
      try {
        machines = await listAccountMachines(true);
      } catch (error) {
        const message = errorMessage(error);
        return {
          state: /not signed in/i.test(message) ? "signed_out" : "unavailable",
          message,
          machines: [],
        };
      }
      const includeWork = listOptions.includeWork === true;
      const summaries = await Promise.all(machines.map(async (machine): Promise<CtoMachineSummary> => {
        const local = isThisMachine(machine);
        const base = {
          machineId: machine.machineKey,
          name: machineName(machine),
          isThisMachine: local,
          online: local ? true : machine.online,
          presence: local ? "online" : accountMachinePresence(machine),
          platform: machine.platform ?? null,
          lastSeenAt: machine.lastSeenAt ? new Date(machine.lastSeenAt).toISOString() : null,
        };
        if (local) return { ...base, hasProject: true, projectRoot: options.projectRoot };
        const remote = await withTimeout(
          summarizeRemote(machine, includeWork),
          LIST_PER_MACHINE_BUDGET_MS,
          `${machineName(machine)} did not answer in time.`,
        ).catch((error) => ({ hasProject: null, projectRoot: null, note: errorMessage(error) }));
        return { ...base, ...remote };
      }));
      return { state: "ok", projectOrigin: projectOrigin().identity, machines: summaries };
    },

    async runAction(target, call) {
      // The home machine never goes over the bridge, even when named.
      if (target.isThisMachine) return await callLocally(call);
      assertEnabled();
      return await callOnMachine(await machineForTarget(target), call);
    },

    async listActions(target, domain) {
      const normalized = domain?.trim() || null;
      if (target.isThisMachine) return await listLocally(normalized);
      assertEnabled();
      return await listActionsOnMachine(await machineForTarget(target), normalized);
    },

    peekRoster() {
      // Nothing here starts reading the directory: the roster exists once a
      // cross-machine tool has read it, and each tool read refreshes it.
      if (!directoryCache) return null;
      if (!isSignedIn()) {
        directoryCache = null;
        return null;
      }
      // Kept while off, so the home machine keeps its account name.
      if (!access().enabled) return null;
      if (Date.now() - directoryCache.at >= ROSTER_REFRESH_MS && !rosterRefresh) {
        rosterRefresh = listAccountMachines(true)
          .catch(() => undefined)
          .finally(() => { rosterRefresh = null; });
      }
      return directoryCache.machines.slice(0, ROSTER_MAX_MACHINES).map((machine) => {
        const local = isThisMachine(machine);
        return {
          name: machineName(machine),
          machineId: machine.machineKey,
          isThisMachine: local,
          online: local ? true : machine.online,
          hasProject: local ? true : hasProjectByMachine.get(machine.machineKey) ?? null,
        };
      });
    },
  };
}
