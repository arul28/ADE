/**
 * Brain -> brain calls for the CTO.
 *
 * The CTO runs on one home machine. This lets its tools run ONE ADE action on
 * another machine on the same ADE account, in that machine's checkout of the
 * same repository.
 *
 * Transport: the paired runtime channel (`openPairedCandidate` ->
 * `RuntimeRpcClient`), over LAN, Tailscale or ADE Relay. Authentication is the
 * account's: the pairing is created by the same account-authenticated hello
 * the desktop and `ade machines connect` use (`pairListedMachine`),
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
 * Cost: the roster reads nothing on its own. A CTO turn's live-state read
 * (`peekRemoteWork`) reads the account's machines and each online machine's
 * lanes and working chats in the background, at most once a minute and only
 * while CTO turns happen: never on a timer, never while signed out or turned
 * off, and never waking an asleep machine.
 *
 * The user's switch (Settings › CTO, "Let the CTO reach my other machines")
 * turns all of it off.
 */
import os from "node:os";
import { isPairedRuntimeSupersededError } from "../../../../desktop/src/main/services/remoteRuntime/pairedRuntimeErrors";
import { normalizeGitRemoteIdentity, pickLiveCheckout } from "../../../../desktop/src/shared/crossMachineHandoff";
import { accountMachinePresence } from "../../../../desktop/src/shared/machinePresence";
import {
  CTO_REMOTE_CLIENT_NAME,
  ctoCallerInitializeParams,
} from "../../../../desktop/src/shared/runtimeClientNames";
import type { AdeAccountMachine } from "../../../../desktop/src/shared/types/account";
import { isChatToolType } from "../../../../desktop/src/shared/sessionSpawnNesting";
import { isTerminalSessionDone, isTrackedAgentCliToolType, sessionRestedAt } from "../../../../desktop/src/shared/types/sessions";
import {
  CTO_CROSS_MACHINE_DISABLED_MESSAGE,
  type CtoCrossMachineDeps,
  type CtoMachineListResult,
  type CtoMachineSummary,
  type CtoMachineActionInfo,
  type CtoMachineTarget,
  type CtoRemoteActionCall,
  type CtoRemoteChat,
  type CtoRemoteMachineWork,
} from "../../../../desktop/src/main/services/ai/tools/ctoCrossMachine";
import { isSecretBearingAdeAction } from "../../../../desktop/src/main/services/adeActions/actionPolicy";
import type { CtoActionCaller } from "../../adeRpcServer";
import { withTimeout } from "../../lib/remoteLaunchBudget";
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
/** How often a CTO turn may re-read the other machines' lanes and chats. */
const REMOTE_WORK_REFRESH_MS = 60_000;
/** One slow machine must not hold the others' rows back. */
const REMOTE_WORK_PER_MACHINE_BUDGET_MS = 12_000;
/** Working chats kept per machine; the rest are a count. */
const REMOTE_WORK_MAX_CHATS = 8;
/** Lanes kept per machine, for matching open PRs to the lane that opened them. */
const REMOTE_WORK_MAX_LANES = 200;
/** Linked chats looked up by id per machine read, beyond its chat list. */
const REMOTE_WORK_MAX_LINKED_LOOKUPS = 10;
/** How long a machine found without this project is left out of work reads. */
const REMOTE_WORK_NO_PROJECT_RECHECK_MS = 10 * 60_000;
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
  /**
   * Chats on other machines that open work items link to. Each machine's work
   * read looks these up by id when its chat list does not carry them (archived,
   * or settled long ago), so the item still learns the chat is done.
   */
  getLinkedRemoteChats?: () => Array<{ machineId: string; sessionId: string }>;
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
    // The same repository can be registered several times on one machine
    // (checkouts, temp copies); route to the live one, as every caller does.
    const matches = records.filter((record) => normalizeGitRemoteIdentity(record.gitOriginUrl) === origin);
    hasProjectByMachine.set(machine.machineKey, matches.length > 0);
    return pickLiveCheckout(matches);
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

  /** A session row as a linked work item needs it, or null for a row without an id. */
  const knownChat = (row: Record<string, unknown>): NonNullable<CtoRemoteMachineWork["known"]>[number] | null => {
    const sessionId = typeof row.id === "string" ? row.id : "";
    if (!sessionId) return null;
    const statusLine = typeof row.statusNote === "string" ? row.statusNote.trim() : "";
    return { sessionId, done: isTerminalSessionDone(row), restedAt: sessionRestedAt(row), statusLine: statusLine || null };
  };

  /** When each machine was last found without this project (work reads skip it for a while). */
  const noProjectSeenAt = new Map<string, number>();

  /**
   * One machine's lanes and working chats, or null when it has no checkout of
   * this project. Two light reads: lane rows without git status, and session
   * rows (title, lane, runtime state, status line) rather than chat summaries.
   */
  const readMachineWork = async (machine: AdeAccountMachine): Promise<CtoRemoteMachineWork | null> => {
    const base = { machineId: machine.machineKey, name: machineName(machine), readAt: new Date().toISOString() };
    // The switch may have been turned off while this read waited its turn.
    if (!access().enabled) return null;
    try {
      const [lanes, sessions] = await Promise.all([
        callOnMachine(machine, {
          domain: "lane",
          action: "list",
          args: { includeArchived: false, includeStatus: false },
          timeoutMs: 10_000,
        }),
        callOnMachine(machine, {
          domain: "session",
          action: "list",
          // The newest 80 unsettled chats and 30 settled ones: enough for the
          // working list (8 shown). A linked chat outside them is read by id
          // below.
          args: { includeArchived: false, limit: 80, settledLimit: 30 },
          timeoutMs: 10_000,
        }),
      ]);
      const laneRows = Array.isArray(lanes) ? lanes.filter(isRecord) : [];
      const laneNameById = new Map<string, string>();
      const laneList: CtoRemoteMachineWork["lanes"] = [];
      for (const lane of laneRows) {
        const id = typeof lane.id === "string" ? lane.id : "";
        const name = typeof lane.name === "string" ? lane.name : "";
        const branch = typeof lane.branchRef === "string" ? lane.branchRef.replace(/^refs\/heads\//, "") : "";
        if (id && name) laneNameById.set(id, name);
        if (name && branch && laneList.length < REMOTE_WORK_MAX_LANES) laneList.push({ name, branch });
      }
      const working: CtoRemoteChat[] = [];
      const known: NonNullable<CtoRemoteMachineWork["known"]> = [];
      for (const row of Array.isArray(sessions) ? sessions.filter(isRecord) : []) {
        const toolType = typeof row.toolType === "string" ? row.toolType : null;
        if (!isChatToolType(toolType) && !isTrackedAgentCliToolType(toolType as never)) continue;
        const entry = knownChat(row);
        if (!entry) continue;
        known.push(entry);
        if (entry.done || row.status !== "running") continue;
        const runtimeState = row.runtimeState;
        if (runtimeState !== "running" && runtimeState !== "waiting-input") continue;
        const laneId = typeof row.laneId === "string" ? row.laneId : "";
        working.push({
          sessionId: entry.sessionId,
          title: (typeof row.title === "string" ? row.title.trim() : "") || "Untitled chat",
          laneName: laneNameById.get(laneId) ?? (typeof row.laneName === "string" ? row.laneName : null),
          state: runtimeState === "waiting-input" ? "needs input" : "working",
          statusLine: entry.statusLine,
        });
      }
      // Linked chats the list left out (archived, or settled long ago): by id.
      const listed = new Set(known.map((entry) => entry.sessionId));
      const missing = (options.getLinkedRemoteChats?.() ?? [])
        .filter((link) => link.machineId === machine.machineKey && !listed.has(link.sessionId))
        .slice(0, REMOTE_WORK_MAX_LINKED_LOOKUPS);
      const lookedUp = await Promise.all(missing.map((link) => callOnMachine(machine, {
        domain: "session",
        action: "get",
        args: { sessionId: link.sessionId },
        timeoutMs: 10_000,
      }).then((row) => (isRecord(row) ? knownChat(row) : null), (error: unknown) => {
        // The machine answered its lists, so this one read failing is news.
        logger?.warn("cto_cross_machine.linked_chat_read_failed", { error: errorMessage(error) });
        return null;
      })));
      for (const entry of lookedUp) if (entry) known.push(entry);
      noProjectSeenAt.delete(machine.machineKey);
      return {
        ...base,
        lanes: laneList,
        chats: working.slice(0, REMOTE_WORK_MAX_CHATS),
        chatsTotal: working.length,
        known,
      };
    } catch (error) {
      // `connectToProject` recorded a machine without this project; leave it
      // out, and look again in a while (it may open the project later).
      if (hasProjectByMachine.get(machine.machineKey) === false) {
        noProjectSeenAt.set(machine.machineKey, Date.now());
        return null;
      }
      return { ...base, lanes: [], chats: [], chatsTotal: 0, error: errorMessage(error) };
    }
  };

  let remoteWork: { machines: CtoRemoteMachineWork[] } | null = null;
  let remoteWorkAttemptAt = 0;
  let remoteWorkRefresh: Promise<void> | null = null;
  const refreshRemoteWork = async (): Promise<void> => {
    const machines = await listAccountMachines();
    if (!access().enabled) {
      remoteWork = null;
      return;
    }
    const targets = machines
      .filter((machine) => !isThisMachine(machine)
        && machine.online
        && (hasProjectByMachine.get(machine.machineKey) !== false
          || Date.now() - (noProjectSeenAt.get(machine.machineKey) ?? 0) >= REMOTE_WORK_NO_PROJECT_RECHECK_MS))
      .slice(0, ROSTER_MAX_MACHINES);
    const read = await Promise.all(targets.map((machine) => withTimeout(
      readMachineWork(machine),
      REMOTE_WORK_PER_MACHINE_BUDGET_MS,
      `${machineName(machine)} did not answer in time.`,
    ).catch((error): CtoRemoteMachineWork => ({
      machineId: machine.machineKey,
      name: machineName(machine),
      readAt: new Date().toISOString(),
      lanes: [],
      chats: [],
      chatsTotal: 0,
      error: errorMessage(error),
    }))));
    // Turned off mid-read: keep nothing it learned.
    remoteWork = access().enabled
      ? { machines: read.filter((entry): entry is CtoRemoteMachineWork => entry != null) }
      : null;
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

    peekRemoteWork() {
      if (!access().enabled || !isSignedIn()) {
        remoteWork = null;
        return null;
      }
      // Spaced by attempt, not success: a failing directory read is retried a
      // minute later, not on every turn.
      if (!remoteWorkRefresh && Date.now() - remoteWorkAttemptAt >= REMOTE_WORK_REFRESH_MS) {
        remoteWorkAttemptAt = Date.now();
        remoteWorkRefresh = refreshRemoteWork()
          .catch((error) => {
            logger?.info("cto_cross_machine.remote_work_read_failed", { error: errorMessage(error) });
          })
          .finally(() => { remoteWorkRefresh = null; });
      }
      return remoteWork?.machines ?? null;
    },

    peekRemoteChat(machineId, sessionId) {
      if (!access().enabled || !isSignedIn()) return null;
      const machine = remoteWork?.machines.find((entry) => entry.machineId === machineId);
      const seen = machine?.known?.find((entry) => entry.sessionId === sessionId);
      return seen ? { done: seen.done, restedAt: seen.restedAt, statusLine: seen.statusLine } : null;
    },
  };
}
