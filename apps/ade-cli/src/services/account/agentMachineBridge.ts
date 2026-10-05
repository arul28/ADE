/**
 * Ordinary agents (and a person's `ade` terminal) reaching the account's other
 * machines: `ade chat list --machine "Mac mini"` and friends.
 *
 * The CLI sends one JSON-RPC request it would otherwise send to this brain,
 * wrapped in `machines.call`. This bridge resolves the machine and the project
 * on it, attaches the caller's chat as a per-request claim, and forwards the
 * request unchanged over the agents' own paired connection. The TARGET decides:
 * it clamps the connection to `agent`, binds the claim to the paired device it
 * authenticated (`foreignCallerSessionId`), and applies its own action policy.
 * Nothing here widens what an agent may do; it only moves where it runs.
 *
 * Refused before anything is sent:
 * - methods outside `FORWARDABLE_METHODS` (machine administration, sync,
 *   account and project-registry writes stay with the person);
 * - secret-bearing actions, because the result lands in a transcript.
 */
import os from "node:os";
import { isSecretBearingAdeAction } from "../../../../desktop/src/main/services/adeActions/actionPolicy";
import { normalizeGitRemoteIdentity } from "../../../../desktop/src/shared/crossMachineHandoff";
import { accountMachinePresence } from "../../../../desktop/src/shared/machinePresence";
import { samePathOnPlatform } from "../../../../desktop/src/shared/pathContainment";
import type { ContainmentPlatform } from "../../../../desktop/src/shared/pathCase";
import {
  REMOTE_CALLER_PARAM,
  agentCallerInitializeParams,
  type RemoteCallerClaim,
} from "../../../../desktop/src/shared/runtimeClientNames";
import type { AdeAccountMachine } from "../../../../desktop/src/shared/types/account";
import { withTimeout } from "../../tuiClient/remoteLaunchBudget";
import type { ExternalWakeDeliveryResult } from "../../../../desktop/src/main/services/chat/externalChats";
import {
  MACHINE_BRIDGE_DEFAULT_CALL_TIMEOUT_MS,
  MachineAccountSignedOutError,
  clampMachineCallTimeout,
  createMachineConnectionPool,
  errorMessage,
  isRecord,
  machineName,
  resultByteLength,
  type MachineBridgeLogger,
  type RemoteProjectRecord,
} from "./machineBridge";
import { SYNC_REMOTE_COMMAND_RESULT_MAX_BYTES } from "../sync/syncProtocol";

const AGENT_PAIRED_STORE_FILE = "agent-paired-machines.json";

/** A first clone of a large repository over a slow link. */
const MACHINE_CLONE_TIMEOUT_MS = 180_000;
/** One slow machine must not hold the roster hostage. */
const LIST_PER_MACHINE_BUDGET_MS = 15_000;

/**
 * What another machine will take from an agent here. Everything else is
 * refused locally with a message naming the method.
 */
const FORWARDABLE_METHODS: ReadonlySet<string> = new Set([
  "ade/actions/call",
  "projects.list",
  "personalChats.call",
]);

/** Methods that run in a project on the target and need one resolved. */
const PROJECT_SCOPED_METHODS: ReadonlySet<string> = new Set(["ade/actions/call"]);

/**
 * A root path on the target compares by the TARGET's rules (a Windows host
 * folds case and separators), whatever this machine is. The directory reports
 * either a Node platform or the sync spelling.
 */
function targetPathPlatform(platform: string | null): ContainmentPlatform {
  const value = platform?.trim().toLowerCase() ?? "";
  if (value === "win32" || value === "windows") return "win32";
  if (value === "darwin" || value === "macos" || value === "mac") return "darwin";
  if (value === "linux") return "linux";
  return "posix";
}
export type MachineCallScope =
  /** The project on the target that has this git origin (the caller's repo). */
  | { kind: "repo"; originUrl: string }
  /** A project on the target named by id, display name, or root path. */
  | { kind: "project"; selector: string }
  /** Projectless personal chats on the target. */
  | { kind: "personal" }
  /** Machine-level methods (`projects.list`). */
  | { kind: "machine" };

export type MachineCallRequest = {
  machine: string;
  scope: MachineCallScope;
  method: string;
  params?: Record<string, unknown>;
  caller: RemoteCallerClaim;
  timeoutMs?: number;
  /**
   * When the repository is not on the target, set it up there first
   * (`--clone`). Only for the `repo` scope; the target applies its own rules.
   */
  clone?: boolean;
};

export type MachineCallResult = {
  machine: { machineKey: string; name: string };
  project: { projectId: string; name: string | null; rootPath: string } | null;
  result: unknown;
};

export type AgentMachineRosterEntry = {
  machineKey: string;
  name: string;
  isThisMachine: boolean;
  online: boolean;
  presence: string;
  platform: string | null;
  lastSeenAt: string | null;
  /** Present when projects were requested and the machine answered. */
  projects?: Array<{ projectId: string; name: string | null; rootPath: string; origin: string | null }>;
  /** Why `projects` is missing, when it was requested. */
  note?: string | null;
};

export type AgentMachineRoster =
  | { state: "ok"; machines: AgentMachineRosterEntry[] }
  | { state: "signed_out" | "unavailable"; message: string; machines: AgentMachineRosterEntry[] };

/** Typed so the CLI can say "offline" without parsing prose. */
export class MachineOfflineError extends Error {
  readonly code = "machine_offline";
  constructor(readonly machineName: string, readonly lastSeenAt: string | null) {
    super(
      `${machineName} is offline${lastSeenAt ? ` (last seen ${lastSeenAt})` : ""}. Nothing was sent; try again when it is back.`,
    );
  }
}

export class MachineIsLocalError extends Error {
  readonly code = "machine_is_local";
  constructor(readonly machineName: string) {
    super(`${machineName} is this machine. Run the command without --machine.`);
  }
}

export type AgentMachineBridgeOptions = {
  appVersion: string;
  projectRoots: () => string[];
  logger?: MachineBridgeLogger | null;
};

export type AgentMachineBridge = ReturnType<typeof createAgentMachineBridge>;

export function createAgentMachineBridge(options: AgentMachineBridgeOptions) {
  const pool = createMachineConnectionPool({
    poolId: "agent",
    pairedStoreFile: AGENT_PAIRED_STORE_FILE,
    deviceName: () => `ADE agents on ${os.hostname()}`,
    initializeParams: agentCallerInitializeParams,
    appVersion: options.appVersion,
    projectRoots: options.projectRoots,
    who: "agents",
    requestNoun: "requests from other machines' agents",
    logPrefix: "agent_cross_machine",
    requiredCapability: "agentRemoteCallers",
    logger: options.logger ?? null,
  });

  const lastSeen = (machine: AdeAccountMachine): string | null =>
    machine.lastSeenAt ? new Date(machine.lastSeenAt).toISOString() : null;

  const projectSummary = (record: RemoteProjectRecord) => ({
    projectId: record.projectId,
    name: record.displayName,
    rootPath: record.rootPath,
  });

  const resolveProject = (
    machine: AdeAccountMachine,
    records: RemoteProjectRecord[],
    scope: MachineCallScope,
  ): RemoteProjectRecord => {
    if (scope.kind === "repo") {
      const origin = normalizeGitRemoteIdentity(scope.originUrl);
      if (!origin) {
        throw new Error(
          "This project has no git origin remote, so ADE can't find it on another machine. Pass --project <name|path|id>.",
        );
      }
      // Two checkouts of one repository: the one opened most recently is in use.
      const match = records
        .filter((record) => normalizeGitRemoteIdentity(record.gitOriginUrl) === origin)
        .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)[0];
      if (match) return match;
      throw new Error(
        `${machineName(machine)} doesn't have this repository (${origin}). Open it in ADE there once, or pass --project <name|path|id>.`,
      );
    }
    if (scope.kind !== "project") throw new Error("This request needs a project on the other machine.");
    const selector = scope.selector.trim();
    const needle = selector.toLowerCase();
    const byId = records.find((record) => record.projectId === selector);
    if (byId) return byId;
    const platform = targetPathPlatform(machine.platform ?? null);
    const byPath = records.find((record) => samePathOnPlatform(record.rootPath, selector, platform));
    if (byPath) return byPath;
    const byName = records.filter((record) => record.displayName?.toLowerCase() === needle);
    if (byName.length === 1) return byName[0]!;
    const known = records.map((record) => record.displayName ?? record.rootPath).join(", ");
    if (byName.length > 1) {
      throw new Error(
        `"${selector}" names ${byName.length} projects on ${machineName(machine)}. Pass a project id or root path: ${byName.map((record) => `${record.projectId} (${record.rootPath})`).join(", ")}.`,
      );
    }
    throw new Error(
      `${machineName(machine)} has no project "${selector}".${known ? ` Projects there: ${known}.` : ""}`,
    );
  };

  const assertForwardable = (method: string, params: Record<string, unknown>): void => {
    if (!FORWARDABLE_METHODS.has(method)) {
      throw new Error(`${method} can't run on another machine from here.`);
    }
    if (method !== "ade/actions/call") return;
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (
      params.name === "run_ade_action"
      && typeof args.domain === "string"
      && typeof args.action === "string"
      && isSecretBearingAdeAction(args.domain, args.action)
    ) {
      throw new Error(
        `${args.domain}.${args.action} returns secrets, so it can't run from another machine. Ask the user to read it in Settings.`,
      );
    }
  };

  const call = async (input: MachineCallRequest): Promise<MachineCallResult> => {
    const method = input.method.trim();
    const params = isRecord(input.params) ? { ...input.params } : {};
    assertForwardable(method, params);
    const machine = await pool.selectMachine(input.machine);
    if (pool.isThisMachine(machine)) throw new MachineIsLocalError(machineName(machine));
    if (!machine.online) throw new MachineOfflineError(machineName(machine), lastSeen(machine));

    const entry = await pool.acquire(machine);
    let project: RemoteProjectRecord | null = null;
    if (PROJECT_SCOPED_METHODS.has(method)) {
      if (input.scope.kind === "personal" || input.scope.kind === "machine") {
        throw new Error(`${method} runs in a project; pass --project, or use --personal commands.`);
      }
      let records = await pool.listProjects(entry);
      try {
        project = resolveProject(machine, records, input.scope);
      } catch (error) {
        // A project opened there in the last minute is not in the cache yet.
        records = await pool.listProjects(entry, true);
        try {
          project = resolveProject(machine, records, input.scope);
        } catch {
          if (!input.clone || input.scope.kind !== "repo") throw error;
          await pool.request(
            machine,
            entry,
            "machines.cloneForAgent",
            "machines.cloneForAgent",
            { originUrl: input.scope.originUrl },
            MACHINE_CLONE_TIMEOUT_MS,
          );
          records = await pool.listProjects(entry, true);
          project = resolveProject(machine, records, input.scope);
        }
      }
      params.projectId = project.projectId;
    } else {
      delete params.projectId;
    }
    const local = pool.thisMachine();
    const localListed = pool.peekDirectory()?.machines.find(pool.isThisMachine) ?? null;
    params[REMOTE_CALLER_PARAM] = {
      chatSessionId: input.caller.chatSessionId?.trim() || null,
      machineKey: local?.machineKey ?? localListed?.machineKey ?? null,
      machineName: localListed ? machineName(localListed) : os.hostname(),
      permissionLevel: input.caller.permissionLevel ?? null,
    } satisfies RemoteCallerClaim;

    const label = method === "ade/actions/call" && isRecord(params.arguments)
      && typeof params.arguments.domain === "string" && typeof params.arguments.action === "string"
      ? `${params.arguments.domain}.${params.arguments.action}`
      : method;
    const timeoutMs = clampMachineCallTimeout(input.timeoutMs);
    const raw = await pool.request(machine, entry, label, method, params, timeoutMs);
    // An action answer is checked (refusal and size) by the pool; any other
    // answer gets the same size cap here.
    const result = method === "ade/actions/call"
      ? pool.checkActionResponse(machineName(machine), label, raw, machine.machineKey)
      : raw;
    if (method !== "ade/actions/call") {
      const bytes = resultByteLength(result);
      if (bytes > SYNC_REMOTE_COMMAND_RESULT_MAX_BYTES) {
        throw new Error(
          `${machineName(machine)} returned ${label} at ${bytes} bytes, over the ${SYNC_REMOTE_COMMAND_RESULT_MAX_BYTES}-byte limit. Narrow the request.`,
        );
      }
    }
    return {
      machine: { machineKey: machine.machineKey, name: machineName(machine) },
      project: project ? projectSummary(project) : null,
      result,
    };
  };

  const listMachines = async (listOptions: { includeProjects?: boolean } = {}): Promise<AgentMachineRoster> => {
    let machines: AdeAccountMachine[];
    try {
      machines = await pool.listAccountMachines(true);
    } catch (error) {
      return {
        state: error instanceof MachineAccountSignedOutError ? "signed_out" : "unavailable",
        message: errorMessage(error),
        machines: [],
      };
    }
    const rows = await Promise.all(machines.map(async (machine): Promise<AgentMachineRosterEntry> => {
      const local = pool.isThisMachine(machine);
      const base: AgentMachineRosterEntry = {
        machineKey: machine.machineKey,
        name: machineName(machine),
        isThisMachine: local,
        online: local ? true : machine.online,
        presence: local ? "online" : accountMachinePresence(machine),
        platform: machine.platform ?? null,
        lastSeenAt: lastSeen(machine),
      };
      if (!listOptions.includeProjects || local) return base;
      if (!machine.online) return { ...base, note: "Offline; projects not checked." };
      try {
        const records = await withTimeout(
          pool.acquire(machine).then((entry) => pool.listProjects(entry)),
          LIST_PER_MACHINE_BUDGET_MS,
          `${machineName(machine)} did not answer in time.`,
        );
        return {
          ...base,
          projects: records.map((record) => ({
            ...projectSummary(record),
            origin: normalizeGitRemoteIdentity(record.gitOriginUrl),
          })),
        };
      } catch (error) {
        return { ...base, note: errorMessage(error) };
      }
    }));
    return { state: "ok", machines: rows };
  };

  /**
   * Wake a parent on another machine with a child's completion. The target
   * refuses unless its own brain started that child (see `crossScopeChats`).
   */
  const deliverWake = async (
    machineKey: string,
    payload: unknown,
  ): Promise<ExternalWakeDeliveryResult> => {
    const machine = await pool.selectMachine(machineKey);
    if (!machine.online) return "failed";
    const entry = await pool.acquire(machine);
    const answer = await pool.request(
      machine,
      entry,
      "machines.deliverWake",
      "machines.deliverWake",
      { payload },
      MACHINE_BRIDGE_DEFAULT_CALL_TIMEOUT_MS,
    );
    return answer === "delivered" || answer === "parent_gone" || answer === "refused" ? answer : "failed";
  };

  return { call, listMachines, deliverWake };
}
