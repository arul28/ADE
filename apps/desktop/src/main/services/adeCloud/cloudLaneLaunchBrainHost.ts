/**
 * ADE Cloud lane launches owned by a brain (`ade serve`), for the CLI and
 * agents: `ade chat create --machine cloud`, through the `cloud.lane_launch*`
 * actions. The same core as the desktop app's (`cloudLaneLaunchService.ts`),
 * with brain deps:
 *
 * - The server launcher makes the computer with the brain's account token,
 *   and the computer signs itself in with its join key: no approval, no
 *   window, no link to tap.
 * - The hand-off reaches the new computer through this brain's agent machine
 *   bridge, by its account machine key: the path `--machine <name>` already
 *   takes. The bridge pairs on its own, so the "target id" is the machine key.
 *
 * The brain owns the launch, not the CLI process: a Ctrl-C in the terminal
 * stops only the following, and the launch goes on. Records sit in the
 * machine's ADE folder and resume when the brain starts again. One host per
 * process: two would resume the same records twice.
 */

import fs from "node:fs";
import path from "node:path";
import type { CloudAgentMaker } from "../../../shared/adeCloud";
import { isChatLaunchTerminal } from "../../../shared/chatLaunch";
import type { CloudGitPreflight } from "../../../shared/cloudGitCredential";
import type { CloudLaneLaunchStatus } from "../../../shared/cloudLaneLaunch";
import type {
  ChatLaunchArgs,
  ChatLaunchEvent,
  ChatLaunchSnapshot,
  OpenProjectBinding,
  RemoteRuntimeProjectRecord,
} from "../../../shared/types";
import { getErrorMessage, isRecord } from "../shared/utils";
import type { CloudBrainMakerBase } from "./cloudBrainMaker";
import { cloudLaneLaunchOutcomes, type CloudLaneAnalyticsCapture } from "./cloudLaneAnalytics";
import { createCloudLaneLaunchService, type CloudLaneLaunchService } from "./cloudLaneLaunchService";

type Logger = {
  info: (event: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, meta?: Record<string, unknown>) => void;
};

type RemoteBinding = OpenProjectBinding & { kind: "remote" };

/** Who the computer's brain sees asking: the agent's chat on this machine, if any. */
export type CloudLaneLaunchCaller = { chatSessionId: string | null; permissionLevel: string | null };

/**
 * This brain's way to the account's other machines (the agent machine
 * bridge). Set once by `ade serve`; unset elsewhere (the desktop app's main
 * process has its own launch owner).
 */
export type CloudLaneLaunchMachineTransport = {
  call(input: {
    machine: string;
    scope: { kind: "machine" } | { kind: "project"; selector: string };
    method: string;
    params?: Record<string, unknown>;
    caller: CloudLaneLaunchCaller;
    timeoutMs?: number;
  }): Promise<{ result: unknown }>;
};

let transport: CloudLaneLaunchMachineTransport | null = null;

export function setCloudLaneLaunchTransport(next: CloudLaneLaunchMachineTransport | null): void {
  transport = next;
}

/** Only a process with the transport (`ade serve`) owns launches: any other would resume the same records a second time. */
export function cloudLaneLaunchTransportSet(): boolean {
  return transport !== null;
}

const NO_TRANSPORT = "This ADE can't reach other computers, so it can't start a lane on ADE Cloud. Use the ADE app, or run this where ADE runs in the background.";

/** The folder for the brain's launch records. */
export function cloudLaneLaunchRecordsDir(adeDir: string): string {
  return path.join(adeDir, "cloud-lane-launches");
}

/** Whether a quit left launches here to resume. */
export function hasCloudLaneLaunchRecords(recordsDir: string, logger?: Pick<Logger, "warn">): boolean {
  try {
    return fs.readdirSync(recordsDir).some((entry) => entry.endsWith(".json"));
  } catch (error) {
    // No folder yet is the usual answer; anything else is worth a line.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger?.warn("cloud_lane_launch.records_dir_read_failed", { error: getErrorMessage(error) });
    }
    return false;
  }
}

/** How often a handed-off launch is read from the computer's brain (the bridge carries no event stream). */
const FOLLOW_POLL_MS = 5_000;
const PROBE_TIMEOUT_MS = 15_000;
const CHAT_ACTION_TIMEOUT_MS = 60_000;

/** An action's own result inside a forwarded `ade/actions/call` answer. */
function unwrapActionResult(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isRecord(current)) return current;
    if (Object.prototype.hasOwnProperty.call(current, "structuredContent")) {
      current = current.structuredContent;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(current, "result") && ("domain" in current || "action" in current)) {
      current = current.result;
      continue;
    }
    return current;
  }
  return current;
}

function toProjectRecord(value: unknown): RemoteRuntimeProjectRecord | null {
  if (!isRecord(value) || typeof value.projectId !== "string" || typeof value.rootPath !== "string") return null;
  return {
    projectId: value.projectId,
    rootPath: value.rootPath,
    displayName: typeof value.displayName === "string" ? value.displayName : path.basename(value.rootPath),
    addedAt: typeof value.addedAt === "number" ? value.addedAt : 0,
    lastOpenedAt: typeof value.lastOpenedAt === "number" ? value.lastOpenedAt : 0,
    gitOriginUrl: typeof value.gitOriginUrl === "string" ? value.gitOriginUrl : null,
    ...(typeof value.exists === "boolean" ? { exists: value.exists } : {}),
  };
}

function toProjectList(value: unknown): RemoteRuntimeProjectRecord[] {
  const list = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.projects) ? value.projects : [];
  return list.map(toProjectRecord).filter((project): project is RemoteRuntimeProjectRecord => project !== null);
}


export type CloudLaneLaunchBrainHost = {
  /** A launch here by id, or null. */
  status(launchId: string): Promise<CloudLaneLaunchStatus | null>;
  /** Starts a new launch, or answers the one with this id (a failed one is retried). */
  start(input: {
    args: ChatLaunchArgs;
    originUrl: string | null;
    madeByChat: string | null;
    /** The kind of agent that asked (written on the computer for the daily limit); null for a person. */
    madeByAgent?: CloudAgentMaker | null;
    caller: CloudLaneLaunchCaller;
  }): Promise<{ status: CloudLaneLaunchStatus; created: boolean }>;
  cancel(launchId: string): Promise<CloudLaneLaunchStatus | null>;
};

export function createCloudLaneLaunchBrainHost(deps: {
  base: CloudBrainMakerBase;
  recordsDir: string;
  logger: Logger;
  /** A launch made a new cloud computer (the brain tells the sign-in renewal). */
  onComputerCreated?: () => void;
  /** How each launch ends, one coarse outcome (cloudLaneAnalytics.ts). */
  analytics?: CloudLaneAnalyticsCapture;
  /** C4: can a new cloud computer clone the repository (`cloudGitPreflight`)? Unset: no check. */
  gitPreflight?: (originUrl: string) => Promise<CloudGitPreflight>;
  /** This machine's update track: a launch's computer follows the same one. */
  updateChannel?: () => "stable" | "beta" | null;
}): CloudLaneLaunchBrainHost {
  const { logger } = deps;
  const countOutcome = cloudLaneLaunchOutcomes(deps.analytics, "api");
  /** Who asked, per launch, for this process only: after a restart only the record's chat is known. */
  const callers = new Map<string, CloudLaneLaunchCaller>();

  const requireTransport = (): CloudLaneLaunchMachineTransport => {
    if (!transport) throw new Error(NO_TRANSPORT);
    return transport;
  };
  // After a restart only the record's chat is known, not its permission level.
  const callerFor = (launchId: string | null): CloudLaneLaunchCaller =>
    (launchId ? callers.get(launchId) : null)
    ?? { chatSessionId: launchId ? service.facts(launchId)?.madeByChat ?? null : null, permissionLevel: null };

  const probe = async (machine: string): Promise<unknown> => (await requireTransport().call({
    machine,
    scope: { kind: "machine" },
    method: "projects.list",
    params: {},
    caller: { chatSessionId: null, permissionLevel: null },
    timeoutMs: PROBE_TIMEOUT_MS,
  })).result;

  const callChat = async (binding: RemoteBinding, action: string, args: unknown): Promise<unknown> => {
    const launchId = isRecord(args) && typeof args.launchId === "string" ? args.launchId : null;
    const answer = await requireTransport().call({
      machine: binding.targetId,
      scope: { kind: "project", selector: binding.projectId },
      method: "ade/actions/call",
      params: { name: "run_ade_action", arguments: { domain: "chat", action, args } },
      caller: callerFor(launchId),
      timeoutMs: CHAT_ACTION_TIMEOUT_MS,
    });
    return unwrapActionResult(answer.result);
  };

  const service: CloudLaneLaunchService = createCloudLaneLaunchService({
    recordsDir: deps.recordsDir,
    logger,
    // Nobody here listens for events (the CLI reads `status`), except the outcome count.
    emit: (event: ChatLaunchEvent) => {
      countOutcome(event);
      if (event.type === "launch-removed") callers.delete(event.launchId);
    },
    creator: deps.base,
    ...(deps.updateChannel ? { updateChannel: deps.updateChannel } : {}),
    removeAccountMachine: deps.base.removeAccountMachine,
    ...(deps.onComputerCreated ? { onComputerCreated: deps.onComputerCreated } : {}),
    ...(deps.gitPreflight ? { gitPreflight: deps.gitPreflight } : {}),
    // The bridge pairs with an account machine on its own and addresses it by key.
    pairMachine: async (machineKey) => ({ targetId: machineKey }),
    connect: async (targetId) => {
      await probe(targetId);
      return true;
    },
    listProjects: async (targetId) => toProjectList(await probe(targetId)),
    resolveBinding: async (targetId, projectId, rootPath) => ({
      kind: "remote",
      key: `cloud-lane:${targetId}:${projectId}`,
      targetId,
      runtimeName: "ADE Cloud",
      transport: "paired",
      projectId,
      rootPath,
      displayName: path.basename(rootPath),
    }),
    callChatAction: (binding, action, request) => callChat(binding, action, request.args),
    // The bridge has no event stream: read the project's launches now and then.
    subscribeChatLaunchEvents: async (binding, onEvent) => {
      let stopped = false;
      let failures = 0;
      const tick = async () => {
        try {
          const launches = await callChat(binding, "listLaunches", {});
          failures = 0;
          for (const launch of Array.isArray(launches) ? launches : []) {
            if (isRecord(launch) && typeof launch.launchId === "string") onEvent({ type: "launch-updated", launch: launch as ChatLaunchSnapshot });
          }
        } catch (error) {
          failures += 1;
          if (failures === 1) logger.warn("cloud_lane_launch.brain_poll_failed", { error: getErrorMessage(error) });
        }
      };
      const timer = setInterval(() => {
        if (!stopped) void tick();
      }, FOLLOW_POLL_MS);
      timer.unref?.();
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
  });

  const statusOf = (launch: ChatLaunchSnapshot): CloudLaneLaunchStatus => {
    const launchId = launch.launchId;
    const facts = service.facts(launchId);
    return {
      launch,
      machine: {
        name: facts?.computerName ?? launch.laneName,
        instanceId: launch.cloud?.instanceId ?? null,
        machineKey: launch.cloud?.machineKey ?? null,
      },
      approvalUrl: !isChatLaunchTerminal(launch.phase) ? facts?.approvalUrl ?? null : null,
      madeByChat: facts?.madeByChat ?? null,
      madeByAgent: facts?.madeByAgent ?? null,
    };
  };

  return {
    async status(launchId) {
      if (!service.owns(launchId)) return null;
      const launch = await service.get({ launchId });
      return launch ? statusOf(launch) : null;
    },

    async start(input) {
      requireTransport();
      const launchId = String(input.args.launchId ?? "").trim().toLowerCase();
      const known = Boolean(launchId) && service.owns(launchId);
      // A repeat keeps the first start's caller.
      if (!known || !callers.has(launchId)) callers.set(launchId, input.caller);
      try {
        let launch = await service.start({ args: input.args, originUrl: input.originUrl, madeByChat: input.madeByChat, madeByAgent: input.madeByAgent ?? null });
        // The same command again retries a launch that failed.
        // An unattended agent's retry whose limits now hold it at Small says so ("capped").
        if (known && launch.phase === "failed") {
          launch = (await service.retry({ launchId: launch.launchId }, { sizeChoice: input.args.cloud?.sizeChoice })) ?? launch;
        }
        return { status: statusOf(launch), created: !known };
      } catch (error) {
        if (!known) callers.delete(launchId);
        throw error;
      }
    },

    async cancel(launchId) {
      if (!service.owns(launchId)) return null;
      const launch = await service.cancel({ launchId });
      return launch ? statusOf(launch) : null;
    },
  };
}
