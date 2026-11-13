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

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CloudAgentMaker } from "../../../shared/adeCloud";
import { isChatLaunchTerminal } from "../../../shared/chatLaunch";
import type { AdeCardPayload } from "../../../shared/adeCard";
import type { CloudGitPreflight } from "../../../shared/cloudGitCredential";
import { buildCloudJoinApprovalCard, isCloudJoinApprovalUrl } from "../../../shared/cloudLaneLife";
import type { CloudLaneLaunchStatus } from "../../../shared/cloudLaneLaunch";
import type {
  ChatLaunchArgs,
  ChatLaunchEvent,
  ChatLaunchSnapshot,
  OpenProjectBinding,
  RemoteRuntimeProjectRecord,
} from "../../../shared/types";
import { getErrorMessage, isRecord } from "../shared/utils";
import type { CloudDesktopBridge } from "./cloudAgentActions";
import { createCloudSelfApproval, type CloudBrainMakerBase } from "./cloudBrainMaker";
import type { CloudMachineCreatorDeps } from "./cloudMachineCreator";
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
    /** The yes came from what the person lets unattended agents do. */
    selfApprove: boolean;
    caller: CloudLaneLaunchCaller;
    /** A line in the agent's chat (the approval link), or null. */
    notice: ((message: string) => void) | null;
    /** A card in the agent's chat (the approval card, with its Approve button), or null where cards can't be posted. */
    card?: ((card: AdeCardPayload) => void) | null;
  }): Promise<{ status: CloudLaneLaunchStatus; created: boolean }>;
  cancel(launchId: string): Promise<CloudLaneLaunchStatus | null>;
};

/**
 * The attached desktop's approval window as the creator's `approveInWindow`,
 * or undefined with no desktop (or one too old to have it). Cancelling closes
 * the window there.
 */
function desktopApprovalWindow(desktop: CloudDesktopBridge | null, logger: Logger): CloudMachineCreatorDeps["approveInWindow"] {
  const open = desktop?.approveWindow;
  if (!desktop || !open) return undefined;
  return async ({ url, mode, title, signal }) => {
    const id = randomUUID();
    const close = () => {
      // The window also closes itself when its sign-in ends or after 5 minutes.
      void desktop.closeApprovalWindow?.({ id }).catch((error: unknown) => {
        logger.warn("cloud_lane_launch.approval_window_close_failed", { error: getErrorMessage(error) });
      });
    };
    signal.addEventListener("abort", close, { once: true });
    try {
      return await open.call(desktop, { id, url, mode, title });
    } finally {
      signal.removeEventListener("abort", close);
    }
  };
}

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
  /**
   * The desktop app attached to this brain, or null. While one is, a new
   * computer signs in through its approval window, as the app's own do;
   * otherwise (or when the window can't), the person approves from a link.
   */
  desktop?: () => CloudDesktopBridge | null;
}): CloudLaneLaunchBrainHost {
  const { logger } = deps;
  const countOutcome = cloudLaneLaunchOutcomes(deps.analytics, "api");
  const selfApproval = createCloudSelfApproval({ client: deps.base.client, account: deps.base.account, logger });
  /** Per launch, for this process only: a restart falls back to the safe side (a link, no notice). */
  const live = new Map<string, {
    selfApprove: boolean;
    startedAt: number;
    caller: CloudLaneLaunchCaller;
    notice: ((message: string) => void) | null;
    card: ((card: AdeCardPayload) => void) | null;
  }>();
  const approvalLinks = new Map<string, string>();
  /** Launches whose approval card is still live in the agent's chat: settled once the join ends. */
  const liveApprovalCards = new Set<string>();

  /** Marks the approval card joined, or ended when the launch stopped waiting another way. */
  const settleApprovalCard = (launch: ChatLaunchSnapshot): void => {
    const launchId = launch.launchId;
    if (!liveApprovalCards.has(launchId)) return;
    const join = launch.stages.find((stage) => stage.id === "join");
    const joined = join?.status === "done";
    if (!joined && join?.status === "running" && !isChatLaunchTerminal(launch.phase) && launch.phase !== "failed") return;
    liveApprovalCards.delete(launchId);
    const url = approvalLinks.get(launchId);
    const post = live.get(launchId)?.card;
    if (!url || !post) return;
    post(buildCloudJoinApprovalCard({ launchId, computerName: service.facts(launchId)?.computerName ?? "The new computer", url, state: joined ? "joined" : "ended" }));
  };

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
    // Nobody here listens for events (the CLI reads `status`), except the outcome count.
    emit: (event: ChatLaunchEvent) => {
      countOutcome(event);
      if (event.type === "launch-updated") settleApprovalCard(event.launch);
      if (event.type === "launch-removed") {
        approvalLinks.delete(event.launchId);
        liveApprovalCards.delete(event.launchId);
        live.delete(event.launchId);
      }
    },
    creator: {
      ...deps.base,
      // Read at each sign-in, so a desktop that attached or left since counts.
      get approveInWindow() {
        return desktopApprovalWindow(deps.desktop?.() ?? null, logger);
      },
      // The link reaches the person through `onApprovalLink`, which knows the launch.
      handOffApproval: () => undefined,
      selfApproval: async (input) => {
        const launch = live.get(input.requestId);
        return await selfApproval(input, { selfApprove: launch?.selfApprove === true, startedAt: launch?.startedAt ?? 0 });
      },
    },
    removeAccountMachine: deps.base.removeAccountMachine,
    ...(deps.onComputerCreated ? { onComputerCreated: deps.onComputerCreated } : {}),
    ...(deps.gitPreflight ? { gitPreflight: deps.gitPreflight } : {}),
    onApprovalLink: (launchId, url) => {
      approvalLinks.set(launchId, url);
      const name = service.facts(launchId)?.computerName ?? "the new computer";
      const caller = live.get(launchId);
      // A card with an Approve button where the chat takes cards; a line with the link otherwise.
      if (caller?.card && isCloudJoinApprovalUrl(url)) {
        liveApprovalCards.add(launchId);
        caller.card(buildCloudJoinApprovalCard({ launchId, computerName: name, url, state: "waiting" }));
        return;
      }
      caller?.notice?.(`Approve "${name}" joining your ADE account: open ${url} on your phone or in a browser signed in to ADE. The lane waits up to 10 minutes.`);
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
      const earlier = live.get(launchId);
      // A repeat keeps the first start's yes; it only adds a chat to tell when none is known.
      live.set(launchId, known && earlier
        ? { ...earlier, notice: earlier.notice ?? input.notice, card: earlier.card ?? input.card ?? null }
        : {
            selfApprove: known ? false : input.selfApprove,
            startedAt: Date.now(),
            caller: input.caller,
            notice: input.notice,
            card: input.card ?? null,
          });
      try {
        let launch = await service.start({ args: input.args, originUrl: input.originUrl, madeByChat: input.madeByChat, madeByAgent: input.madeByAgent ?? null });
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
