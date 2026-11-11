/**
 * ADE Cloud lane launches owned by a brain (`ade serve`), for the CLI and
 * agents: `ade chat create --machine cloud`, through the `cloud.lane_launch*`
 * actions. The same core as the desktop app's (`cloudLaneLaunchService.ts`),
 * with brain deps:
 *
 * - The computer and join stages use the brain's account, as `cloudBrainMaker`
 *   does. Nobody here has a window, so the join approval is the same rule as
 *   a brain's make: a link for the person (to the agent's chat and the CLI's
 *   status), or this brain approves itself when an unattended agent's yes
 *   allows it and a headless browser is here.
 * - The clone stage and the hand-off reach the new computer through this
 *   brain's agent machine bridge, by its account machine key: the path
 *   `--machine <name>` already takes. The bridge pairs on its own, so the
 *   "target id" is the machine key.
 *
 * The brain owns the launch, not the CLI process: a Ctrl-C in the terminal
 * stops only the following, and the launch goes on. Records sit in the
 * machine's ADE folder and resume when the brain starts again. One host per
 * process: two would resume the same records twice.
 */

import fs from "node:fs";
import path from "node:path";
import { isChatLaunchTerminal } from "../../../shared/chatLaunch";
import type {
  ChatLaunchArgs,
  ChatLaunchEvent,
  ChatLaunchSnapshot,
  OpenProjectBinding,
  RemoteRuntimeProjectRecord,
} from "../../../shared/types";
import { getErrorMessage } from "../shared/utils";
import { createCloudSelfApproval, type CloudBrainMakerBase } from "./cloudBrainMaker";
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
  /** Sets the GitHub repository up on that machine with its own Git sign-in; an existing checkout wins. */
  setUpRepository(input: { machine: string; originUrl: string }): Promise<unknown>;
  /**
   * The launch kinds that machine's brain advertised when this brain
   * connected (`chatLaunchKinds`; empty from an older brain). Unset: the
   * hand-off doesn't check them.
   */
  chatLaunchKinds?(machine: string): Promise<string[]>;
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
export function hasCloudLaneLaunchRecords(recordsDir: string): boolean {
  try {
    return fs.readdirSync(recordsDir).some((entry) => entry.endsWith(".json"));
  } catch {
    return false;
  }
}

/** How often a handed-off launch is read from the computer's brain (the bridge carries no event stream). */
const FOLLOW_POLL_MS = 5_000;
const PROBE_TIMEOUT_MS = 15_000;
const CHAT_ACTION_TIMEOUT_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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

/** What `cloud.lane_launch_status` answers. */
export type CloudLaneLaunchStatus = {
  launch: ChatLaunchSnapshot;
  /** The computer made for the lane, once it exists. */
  machine: { name: string; instanceId: string | null; machineKey: string | null };
  /** While the join waits for the person: the sign-in link to open. */
  approvalUrl: string | null;
  /** The agent's chat that started it, or null for a person's launch. */
  madeByChat: string | null;
};

export type CloudLaneLaunchBrainHost = {
  /** A launch here by id, or null. */
  status(launchId: string): Promise<CloudLaneLaunchStatus | null>;
  /** Starts a new launch, or answers the one with this id (a failed one is retried). */
  start(input: {
    args: ChatLaunchArgs;
    originUrl: string | null;
    madeByChat: string | null;
    /** The yes came from what the person lets unattended agents do. */
    selfApprove: boolean;
    caller: CloudLaneLaunchCaller;
    /** A line in the agent's chat (the approval link), or null. */
    notice: ((message: string) => void) | null;
  }): Promise<{ status: CloudLaneLaunchStatus; created: boolean }>;
  cancel(launchId: string): Promise<CloudLaneLaunchStatus | null>;
};

export function createCloudLaneLaunchBrainHost(deps: {
  base: CloudBrainMakerBase;
  recordsDir: string;
  logger: Logger;
}): CloudLaneLaunchBrainHost {
  const { logger } = deps;
  const selfApproval = createCloudSelfApproval({ client: deps.base.client, account: deps.base.account, logger });
  /** Per launch, for this process only: a restart falls back to the safe side (a link, no notice). */
  const live = new Map<string, {
    selfApprove: boolean;
    startedAt: number;
    caller: CloudLaneLaunchCaller;
    notice: ((message: string) => void) | null;
  }>();
  const approvalLinks = new Map<string, string>();

  const requireTransport = (): CloudLaneLaunchMachineTransport => {
    if (!transport) throw new Error(NO_TRANSPORT);
    return transport;
  };
  // After a restart only the record's chat is known, not its permission level.
  const callerFor = (launchId: string | null): CloudLaneLaunchCaller =>
    (launchId ? live.get(launchId)?.caller : null)
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
    // Nobody here listens for events: the CLI reads `status`.
    emit: (event: ChatLaunchEvent) => {
      if (event.type === "launch-removed") {
        approvalLinks.delete(event.launchId);
        live.delete(event.launchId);
      }
    },
    creator: {
      ...deps.base,
      // The link reaches the person through `onApprovalLink`, which knows the launch.
      handOffApproval: () => undefined,
      selfApproval: async (input) => {
        const launch = live.get(input.requestId);
        return await selfApproval(input, { selfApprove: launch?.selfApprove === true, startedAt: launch?.startedAt ?? 0 });
      },
    },
    removeAccountMachine: deps.base.removeAccountMachine,
    onApprovalLink: (launchId, url) => {
      approvalLinks.set(launchId, url);
      const name = service.facts(launchId)?.computerName ?? "the new computer";
      live.get(launchId)?.notice?.(`Approve "${name}" joining your ADE account: open ${url} on your phone or in a browser signed in to ADE. The lane waits up to 10 minutes.`);
    },
    // The bridge pairs with an account machine on its own and addresses it by key.
    pairMachine: async (machineKey) => ({ targetId: machineKey }),
    connect: async (targetId) => {
      await probe(targetId);
      return true;
    },
    listProjects: async (targetId) => toProjectList(await probe(targetId)),
    brainLaunchKinds: async (targetId) => (transport?.chatLaunchKinds ? await transport.chatLaunchKinds(targetId) : null),
    // The computer picks its own projects folder for a clone it is asked for.
    defaultParentDir: async () => "",
    cloneProject: async (targetId, input) => {
      const project = toProjectRecord(await requireTransport().setUpRepository({ machine: targetId, originUrl: input.url }));
      if (!project) throw new Error("The new computer set the repository up but didn't say where.");
      return project;
    },
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
    const joinWaiting = launch.stages.some((stage) => stage.id === "join" && stage.status === "running");
    return {
      launch,
      machine: {
        name: facts?.computerName ?? launch.laneName,
        instanceId: launch.cloud?.instanceId ?? null,
        machineKey: launch.cloud?.machineKey ?? null,
      },
      approvalUrl: joinWaiting && !isChatLaunchTerminal(launch.phase) ? approvalLinks.get(launchId) ?? null : null,
      madeByChat: facts?.madeByChat ?? null,
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
      const earlier = live.get(launchId);
      // A repeat keeps the first start's yes; it only adds a chat to tell when none is known.
      live.set(launchId, known && earlier
        ? { ...earlier, notice: earlier.notice ?? input.notice }
        : {
            selfApprove: known ? false : input.selfApprove,
            startedAt: Date.now(),
            caller: input.caller,
            notice: input.notice,
          });
      try {
        let launch = await service.start({ args: input.args, originUrl: input.originUrl, madeByChat: input.madeByChat });
        // The same command again resumes a launch that failed, on the same computer.
        if (known && launch.phase === "failed") launch = (await service.retry({ launchId: launch.launchId })) ?? launch;
        return { status: statusOf(launch), created: !known };
      } catch (error) {
        if (!known) live.delete(launchId);
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
