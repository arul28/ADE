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
import { isPairedRuntimeSupersededError } from "../../../../desktop/src/main/services/remoteRuntime/pairedRuntimeErrors";
import { normalizeGitRemoteIdentity } from "../../../../desktop/src/shared/crossMachineHandoff";
import { accountMachinePresence } from "../../../../desktop/src/shared/machinePresence";
import {
  CTO_REMOTE_CLIENT_NAME,
  ctoCallerInitializeParams,
} from "../../../../desktop/src/shared/runtimeClientNames";
import type { AdeAccountMachine } from "../../../../desktop/src/shared/types/account";
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
import { withTimeout } from "../../tuiClient/remoteLaunchBudget";
import {
  MACHINE_BRIDGE_DEFAULT_CALL_TIMEOUT_MS,
  MachineAccountSignedOutError,
  clampMachineCallTimeout,
  createMachineConnectionPool,
  errorMessage,
  isRecord,
  machineName,
  readGitOriginUrl,
  type PooledConnection,
  type RemoteProjectRecord,
} from "./machineBridge";

export { CTO_REMOTE_CLIENT_NAME };
const CTO_PAIRED_STORE_FILE = "cto-paired-machines.json";
/** How often the live-state roster may read the directory in the background. */
const ROSTER_REFRESH_MS = 5 * 60_000;
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

export function createCtoCrossMachineBridge(
  options: CtoCrossMachineBridgeOptions,
): CtoCrossMachineDeps {
  const logger = options.logger ?? null;
  const pool = createMachineConnectionPool({
    poolId: "cto",
    pairedStoreFile: CTO_PAIRED_STORE_FILE,
    deviceName: () => `ADE CTO on ${os.hostname()}`,
    initializeParams: ctoCallerInitializeParams,
    appVersion: options.appVersion,
    projectRoots: () => [options.projectRoot],
    who: "the CTO",
    requestNoun: "CTO requests",
    logPrefix: "cto_cross_machine",
    logger,
  });
  const access = (): CtoCrossMachineAccess => options.getAccess?.() ?? { enabled: true };
  const assertEnabled = (): void => {
    if (!access().enabled) throw new Error(CTO_CROSS_MACHINE_DISABLED_MESSAGE);
  };
  const { isSignedIn, thisMachine, isThisMachine, listAccountMachines, acquire, dropConnection } = pool;

  let originCache: { identity: string | null; raw: string | null } | null = null;
  const projectOrigin = (): { identity: string | null; raw: string | null } => {
    if (!originCache) {
      const raw = readGitOriginUrl(options.projectRoot);
      originCache = { raw, identity: normalizeGitRemoteIdentity(raw) };
    }
    return originCache;
  };

  let rosterRefresh: Promise<unknown> | null = null;

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
    const records = await pool.listProjects(entry);
    // The same repository can be registered twice on one machine (two
    // checkouts). The one opened most recently is the one in use.
    const matches = records
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

  const requestOnMachine = async (
    machine: AdeAccountMachine,
    entry: PooledConnection,
    label: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> => pool.checkActionResponse(
    machineName(machine),
    label,
    await pool.request(machine, entry, label, "ade/actions/call", params, timeoutMs),
    machine.machineKey,
  );

  const callOnMachine = async (
    machine: AdeAccountMachine,
    call: CtoRemoteActionCall,
  ): Promise<unknown> => {
    const { entry, project } = await connectToProject(machine);
    const value = await requestOnMachine(machine, entry, `${call.domain}.${call.action}`, {
      projectId: project.projectId,
      name: "run_ade_action",
      arguments: runActionArguments(call),
    }, clampMachineCallTimeout(call.timeoutMs));
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
    }, MACHINE_BRIDGE_DEFAULT_CALL_TIMEOUT_MS);
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
    const timeoutMs = clampMachineCallTimeout(call.timeoutMs);
    const value = await withTimeout(
      caller("run_ade_action", runActionArguments(call)),
      timeoutMs,
      `${label} did not finish within ${Math.round(timeoutMs / 1000)}s on this machine. It may still be running.`,
    );
    return runActionResult(pool.checkActionResponse("This machine", label, value, null));
  };

  const listLocally = async (domain: string | null): Promise<{ count: number; actions: CtoMachineActionInfo[] }> => {
    const caller = await localCaller();
    const value = pool.checkActionResponse(
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
    const machine = await pool.selectMachine(trimmed);
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
    const listed = pool.peekDirectory()?.machines.find(isThisMachine) ?? null;
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
          state: error instanceof MachineAccountSignedOutError ? "signed_out" : "unavailable",
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
      const cached = pool.peekDirectory();
      if (!cached) return null;
      if (!isSignedIn()) {
        pool.clearDirectory();
        return null;
      }
      // Kept while off, so the home machine keeps its account name.
      if (!access().enabled) return null;
      if (Date.now() - cached.at >= ROSTER_REFRESH_MS && !rosterRefresh) {
        rosterRefresh = listAccountMachines(true)
          .catch(() => undefined)
          .finally(() => { rosterRefresh = null; });
      }
      return cached.machines.slice(0, ROSTER_MAX_MACHINES).map((machine) => {
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
