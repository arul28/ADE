import { randomUUID } from "node:crypto";
import {
  cloudCatalogOf,
  CLOUD_JOIN_WATCH_MS,
  CLOUD_MADE_BY_CHAT_METADATA,
  CLOUD_WAKE_PORT,
  CLOUD_WAKE_PORT_LABEL,
} from "../../../shared/adeCloud";
import {
  CHAT_LAUNCH_CLOUD_STAGE_IDS,
  createChatLaunchSnapshot,
  isChatLaunchCloudStageId,
  isChatLaunchTerminal,
  toQueuedMessage,
} from "../../../shared/chatLaunch";
import {
  CLOUD_LANE_ID_METADATA,
  CLOUD_LANE_NAME_METADATA,
  CLOUD_PROJECT_ORIGIN_METADATA,
  cloudLaneLaunchStartProblem as sharedCloudLaneLaunchStartProblem,
} from "../../../shared/cloudLaneLaunch";
import { cloudTier, type CloudTier } from "../../../shared/cloudTiers";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { deriveDeterministicLaneNameFromPrompt, deriveDeterministicLaneTitleFromPrompt } from "../../../shared/laneNameFallback";
import { DEFAULT_LANE_START } from "../../../shared/laneStart";
import { requireNormalizedUuid } from "../../../shared/uuid";
import type {
  ChatLaunchArgs,
  ChatLaunchCloudStageId,
  ChatLaunchEvent,
  ChatLaunchIdArgs,
  ChatLaunchLaneConfig,
  ChatLaunchQueueMessageArgs,
  ChatLaunchSnapshot,
  ChatLaunchStage,
  ChatLaunchStageId,
  ChatLaunchStageStatus,
  CloneProjectInput,
  OpenProjectBinding,
  RemoteRuntimeProjectRecord,
} from "../../../shared/types";
import { getErrorMessage } from "../shared/utils";
import {
  approveCloudMachineSignIn,
  cloudMinAdeVersion,
  CloudCreateCancelled,
  normalizeCloudMachineName,
  readCloudBoxAuth,
  startCloudBoxSignIn,
  waitForCloudAccountRow,
  waitForCloudBoxAuth,
  type CloudMachineCreatorDeps,
} from "./cloudMachineCreator";
import { createCloudLaneLaunchRecordStore, type CloudLaneLaunchRecord } from "./cloudLaneLaunchRecords";
import { deleteCloudInstanceConfirmed } from "./cloudPendingCreates";
import { CloudProviderError, type CloudInstance, type CloudProvider } from "./cloudProvider";
import { cloudHoldCommand, cloudReleaseHoldCommand, enableCloudSleep } from "./cloudSleep";

/**
 * "ADE Cloud" picked where a machine goes, then Send: one new cloud computer
 * for one new lane, and the chat starts there.
 *
 * One launch, two owners, one id. The launch id is the chat's session id and
 * the computer's create request id (`ade_request_id`).
 *
 * - Before the hand-off this service owns the launch. It runs `computer`
 *   (make the computer and wait for its ADE), `join` (sign it in to this
 *   account through the approval window and wait for its account row) and
 *   `clone` (pair, connect, and make the project exist there).
 * - The hand-off starts the same launch on the computer's brain
 *   (`chat.startLaunch`, same `launchId` and `laneId`, lane start forced to
 *   `on: "remote"`, the three finished stages as `priorStages`), then hands it
 *   the messages typed meanwhile, in order. From then on that brain owns the
 *   launch, and it finishes with this app closed.
 *
 * Routing: the renderer keeps one contract, `window.ade.chatLaunch.*`. A start
 * whose args carry `cloud` comes here (`IPC.cloudLaneLaunchCall`). Every later
 * call asks this service first by launch id: before the hand-off it answers
 * from its own record; after it, it forwards the call to the computer's brain
 * through the computer's pin and adds the `cloud` block to what comes back.
 * An id it does not own falls through to the ordinary runtime route. Events
 * leave on `IPC.cloudLaneLaunchEvent`; after the hand-off they are the
 * brain's own `chat_launch_event`s, followed here while the launch is live.
 *
 * Two hosts run this core: the desktop app's main process
 * (`registerCloudLaneLaunchIpc.ts`) for a Send in the app, and a brain
 * (`cloudLaneLaunchBrainHost.ts`, the `cloud.lane_launch*` actions) for
 * `ade chat create --machine cloud` and agents. Each keeps its own records.
 *
 * Not tied to a window: closing the window that pressed Send stops nothing.
 * Each stage is safe to run again (Retry, or ADE opening after a quit): a
 * create finds the computer by its request id first, pairing and connecting
 * repeat, a clone finds the project already there, and the brain's start
 * replays a known launch id. Nothing runs while no cloud launch is live.
 */

type Logger = {
  info: (event: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, meta?: Record<string, unknown>) => void;
  error?: (event: string, meta?: Record<string, unknown>) => void;
};

type RemoteBinding = OpenProjectBinding & { kind: "remote" };

export type CloudLaneLaunchDeps = {
  /** The folder that holds one record per launch (in the app's data folder). */
  recordsDir: string;
  logger: Logger;
  /** Every snapshot change, as a renderer's `chatLaunch.onEvent` expects it. */
  emit: (event: ChatLaunchEvent) => void;
  /** The computer and join stages: the provider, the account and the approval window. */
  creator: Omit<CloudMachineCreatorDeps, "pendingCreates">;
  removeAccountMachine: (machineKey: string) => Promise<unknown>;
  /** Pairs this app with an account machine; this app's remote target id for it. */
  pairMachine: (machineKey: string) => Promise<{ targetId: string }>;
  /** Connects to a saved remote target (waking a sleeping cloud computer). Truthy once connected. */
  connect: (targetId: string) => Promise<unknown>;
  listProjects: (targetId: string) => Promise<RemoteRuntimeProjectRecord[]>;
  defaultParentDir: (targetId: string) => Promise<string>;
  /** Clones with the computer's own Git sign-in: no credential from this computer goes with it. */
  cloneProject: (targetId: string, input: CloneProjectInput) => Promise<RemoteRuntimeProjectRecord>;
  resolveBinding: (targetId: string, projectId: string, rootPath: string) => Promise<RemoteBinding>;
  /** One `chat` action on the computer's brain, through its pin. */
  callChatAction: (binding: RemoteBinding, action: string, args: Record<string, unknown>) => Promise<unknown>;
  /** The brain's `chat_launch_event`s while subscribed. `onEnded` fires when the stream stops by itself. */
  subscribeChatLaunchEvents: (
    binding: RemoteBinding,
    onEvent: (event: ChatLaunchEvent) => void,
    onEnded: () => void,
  ) => Promise<() => void>;
  /**
   * The join stage handed the approval to a person (a brain with no window):
   * the one-time link they open. The owner passes it on (a chat notice, the
   * CLI's status). Unset where a window approves.
   */
  onApprovalLink?: (launchId: string, url: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** How long after creation the service resumes launches a quit left behind. */
  resumeDelayMs?: number;
  /** How long a finished launch stays readable here. */
  finishedRetentionMs?: number;
};

export type CloudLaneLaunchStartInput = {
  args: ChatLaunchArgs;
  /** The git origin of the project the person pressed Send in. */
  originUrl: string | null;
  /** An agent's chat that started it: written on the computer, so the agent limits count it. */
  madeByChat?: string | null;
};

const MAX_QUEUED_MESSAGES = 10;
const CANCEL_PIPELINE_WAIT_MS = 15_000;
const DEFAULT_RESUME_DELAY_MS = 15_000;
const DEFAULT_FINISHED_RETENTION_MS = 10 * 60_000;
/** A create the server still holds (409 `create_in_progress`) is asked again this often, this long. */
const CREATE_IN_PROGRESS_POLL_MS = 5_000;
const CREATE_IN_PROGRESS_WAIT_MS = 6 * 60_000;
/** A create whose answer was lost: how long the provider list is searched for its computer. */
const LOST_CREATE_LOOK_MS = 2 * 60_000;
/** A cancel that found no computer yet keeps looking this long in case ADE Cloud still makes it. */
const CANCELLED_CREATE_FOLLOW_MS = 10 * 60_000;
const CANCELLED_CREATE_FOLLOW_POLL_MS = 15_000;
const CONNECT_RETRY_MS = 3_000;
/** Holds the computer awake from join to the hand-off; it expires on its own if ADE quits. */
const LANE_LAUNCH_HOLD = "lane_launch";
const LANE_LAUNCH_HOLD_MS = 30 * 60_000;
/** After the hand-off, how often a dropped event stream is followed again, and how many times. */
const RESUBSCRIBE_MS = 15_000;
const RESUBSCRIBE_ATTEMPTS = 20;

const CANT_MAKE_COMPUTER = "ADE Cloud can't make a computer right now. Try again soon.";
const CANT_DELETE_YET = "ADE couldn't delete the computer it made yet. It tries again when ADE next opens, or delete it in Settings › ADE Cloud.";
const LANE_ALREADY_STARTED = "This chat already started — delete its lane from the lane menu instead.";

class LaunchCancelled extends Error {
  constructor() { super("Launch cancelled."); }
}

/** A failure whose message is already the plain sentence to show. */
class LaunchStepError extends Error {}

const requireLaunchId = (value: unknown): string => requireNormalizedUuid(value, "launchId must be a UUID.");

function isFinished(stage: ChatLaunchStage | null | undefined): boolean {
  return stage?.status === "done" || stage?.status === "skipped" || stage?.status === "warning";
}

function clip(text: string, max = 240): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** `https://github.com/owner/repo.git` for a GitHub origin, else null: only GitHub repositories are cloned on another computer. */
function githubClone(originUrl: string | null): { identity: string; cloneUrl: string; repoName: string } | null {
  const identity = normalizeGitRemoteIdentity(originUrl);
  const match = identity ? /^github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i.exec(identity) : null;
  if (!identity || !match) return null;
  // The identity is lowercased; the folder keeps the repository's own spelling.
  const spelled = /([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(originUrl).trim().replace(/[?#].*$/, ""))?.[1];
  const repoName = spelled && spelled.toLowerCase() === match[2]!.toLowerCase() ? spelled : match[2]!;
  return { identity, cloneUrl: `https://github.com/${match[1]}/${match[2]}.git`, repoName };
}

/**
 * The lane recipe the computer's brain gets: always from the pushed copy of
 * its branch. A lane on an existing branch keeps that branch.
 */
export function cloudLaneConfig(config: ChatLaunchLaneConfig | null | undefined): ChatLaunchLaneConfig {
  if (config?.mode === "existing") return config;
  const base: ChatLaunchLaneConfig = config ?? { mode: "new", autoName: true };
  return { ...base, mode: "new", start: { ...(base.start ?? DEFAULT_LANE_START), on: "remote" } };
}

/** A local file on this computer means nothing on the new one. Links are fine. */
function hasLocalAttachments(attachments: ChatLaunchArgs["attachments"]): boolean {
  return (attachments ?? []).some((attachment) => attachment.type !== "image-url");
}

/** A provider error that may hide a computer made anyway: no answer, or the server broke mid-way. */
function mayHaveMadeComputer(error: unknown): boolean {
  if (!(error instanceof CloudProviderError)) return true;
  return error.status === 0 || error.status >= 500;
}

/**
 * The one plain sentence for a failed stage. ADE's own cloud steps and the
 * server already say what happened in plain words; raw git or connection
 * errors are mapped, and the raw text stays in the log.
 */
export function cloudLaneLaunchFailureSentence(stage: ChatLaunchStageId, error: unknown): string {
  if (error instanceof LaunchStepError) return error.message;
  const raw = getErrorMessage(error);
  if (/no space left on device|ENOSPC|disk is full/i.test(raw)) {
    return "The computer's disk is full. Pick a bigger size or free up space on it, then retry.";
  }
  if (stage === "computer" || stage === "join") {
    return clip(raw) || (stage === "computer" ? CANT_MAKE_COMPUTER : "The new computer couldn't join your account.");
  }
  if (stage === "clone") {
    if (/repository not found|authentication failed|could not read username|permission denied|access denied|returned error: 40[34]/i.test(raw)) {
      return "The new computer can't read this repository. Check that ADE Cloud can sign in to GitHub for it, then retry.";
    }
    if (error instanceof CloudProviderError) return clip(raw);
    return "ADE couldn't clone the repository on the new computer.";
  }
  return "ADE couldn't start setting up the lane on the new computer.";
}

/**
 * Why a new launch can't start, in the sentence the person reads, or null.
 * `start` refuses with it; a caller that asks the person first (the brain's
 * `cloud.lane_launch`) checks it before the question. It lives in shared so
 * the composer shows the same sentence before Send.
 */
export function cloudLaneLaunchStartProblem(input: CloudLaneLaunchStartInput): string | null {
  return sharedCloudLaneLaunchStartProblem(input);
}

export function createCloudLaneLaunchService(deps: CloudLaneLaunchDeps) {
  const { logger } = deps;
  const now = () => deps.now?.() ?? new Date();
  const nowIso = () => now().toISOString();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
  const finishedRetentionMs = deps.finishedRetentionMs ?? DEFAULT_FINISHED_RETENTION_MS;
  const store = createCloudLaneLaunchRecordStore({ recordsDir: deps.recordsDir, logger });
  const records = new Map<string, CloudLaneLaunchRecord>();

  type Runtime = {
    abort: AbortController;
    pipeline: Promise<void> | null;
    delivering: Promise<void> | null;
    unsubscribe: (() => void) | null;
    subscribing: boolean;
    resubscribeAttempts: number;
    timer: ReturnType<typeof setTimeout> | null;
    expiry: ReturnType<typeof setTimeout> | null;
  };
  const runtimes = new Map<string, Runtime>();
  let disposed = false;

  const runtimeFor = (launchId: string): Runtime => {
    let runtime = runtimes.get(launchId);
    if (!runtime) {
      runtime = { abort: new AbortController(), pipeline: null, delivering: null, unsubscribe: null, subscribing: false, resubscribeAttempts: 0, timer: null, expiry: null };
      if (disposed) runtime.abort.abort();
      else runtimes.set(launchId, runtime);
    }
    return runtime;
  };

  const disposeRuntime = (launchId: string): void => {
    const runtime = runtimes.get(launchId);
    if (!runtime) return;
    runtime.unsubscribe?.();
    if (runtime.timer) clearTimeout(runtime.timer);
    if (runtime.expiry) clearTimeout(runtime.expiry);
    runtimes.delete(launchId);
  };

  const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  // ---------------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------------

  const scheduleExpiry = (record: CloudLaneLaunchRecord): void => {
    const launchId = record.snapshot.launchId;
    const snapshot = record.snapshot;
    if (disposed || !isChatLaunchTerminal(snapshot.phase) || record.pendingMessageIds.length > 0) return;
    if (snapshot.phase === "cancelled" && !record.cleanupDone) return;
    const runtime = runtimeFor(launchId);
    if (runtime.expiry) clearTimeout(runtime.expiry);
    runtime.expiry = setTimeout(() => {
      if (records.get(launchId) !== record) return;
      records.delete(launchId);
      disposeRuntime(launchId);
      store.unpersist(launchId);
      deps.emit({ type: "launch-removed", launchId });
    }, finishedRetentionMs);
    runtime.expiry.unref?.();
  };

  /** Every change goes out through here: count up, save, tell every window. */
  const publish = (record: CloudLaneLaunchRecord, options: { persist?: boolean } = {}): void => {
    if (disposed) return;
    record.snapshot.sequence += 1;
    record.snapshot.updatedAt = nowIso();
    if (options.persist !== false) store.persist(record);
    deps.emit({ type: "launch-updated", launch: clone(record.snapshot) });
    scheduleExpiry(record);
  };

  const stageOf = (record: CloudLaneLaunchRecord, id: ChatLaunchStageId): ChatLaunchStage | null =>
    record.snapshot.stages.find((stage) => stage.id === id) ?? null;

  const setStage = (
    record: CloudLaneLaunchRecord,
    id: ChatLaunchStageId,
    status: ChatLaunchStageStatus,
    patch: Partial<Omit<ChatLaunchStage, "id" | "status">> = {},
  ): void => {
    const stage = stageOf(record, id);
    if (!stage) return;
    const at = nowIso();
    if (status === "running") {
      stage.startedAt = at;
      stage.endedAt = null;
      stage.error = null;
      stage.percent = null;
    } else if (status === "pending") {
      stage.startedAt = null;
      stage.endedAt = null;
      stage.error = null;
      stage.percent = null;
    } else {
      stage.startedAt ??= at;
      stage.endedAt = at;
    }
    stage.status = status;
    Object.assign(stage, patch);
  };

  const stageDurationMs = (record: CloudLaneLaunchRecord, id: ChatLaunchStageId): number | null => {
    const stage = stageOf(record, id);
    if (!stage?.startedAt || !stage.endedAt) return null;
    return Math.max(0, Date.parse(stage.endedAt) - Date.parse(stage.startedAt));
  };

  const finishStage = (record: CloudLaneLaunchRecord, id: ChatLaunchCloudStageId, detail: string | null): void => {
    setStage(record, id, "done", { detail });
    publish(record);
    logger.info("cloud_lane_launch.stage_done", {
      launchId: record.snapshot.launchId,
      stage: id,
      durationMs: stageDurationMs(record, id),
    });
  };

  const assertActive = (record: CloudLaneLaunchRecord, signal: AbortSignal): void => {
    if (disposed || signal.aborted || record.snapshot.phase === "cancelled") throw new LaunchCancelled();
  };

  const isHandedOff = (record: CloudLaneLaunchRecord): boolean => record.snapshot.cloud.handedOff;

  /**
   * The brain's snapshot, served as this launch: its sequence above the local
   * one, the `cloud` block on it, and any message still waiting here behind
   * the ones the brain already holds.
   */
  const adoptBrainSnapshot = (record: CloudLaneLaunchRecord, brain: ChatLaunchSnapshot): void => {
    const local = record.snapshot;
    const pending = local.queuedMessages.filter((message) => record.pendingMessageIds.includes(message.id));
    const next = clone(brain);
    // An older ADE on the computer drops `priorStages`. Keep this launch's own
    // rows first, so the card never loses the steps that already ran here.
    if (!next.stages.some((stage) => isChatLaunchCloudStageId(stage.id))) {
      next.stages = [...clone(local.stages.filter((stage) => isChatLaunchCloudStageId(stage.id))), ...next.stages];
    }
    record.snapshot = {
      ...next,
      sequence: Math.max(local.sequence, record.sequenceBase + brain.sequence),
      queuedMessages: [...clone(brain.queuedMessages), ...pending],
      cloud: { ...local.cloud, handedOff: true },
    };
  };

  /** What a reader gets: the record's snapshot, unshared. */
  const served = (record: CloudLaneLaunchRecord): ChatLaunchSnapshot => clone(record.snapshot);

  // ---------------------------------------------------------------------------
  // The computer
  // ---------------------------------------------------------------------------

  const providerClient = async (): Promise<CloudProvider> => await deps.creator.client();

  /** The size picked at Send, read from the server's catalog (rates included). */
  const resolveTier = async (client: CloudProvider, sizeId: string): Promise<CloudTier> => {
    const account = await client.getAccount();
    const tier = cloudTier(cloudCatalogOf(account), sizeId);
    if (!tier) throw new LaunchStepError("ADE Cloud doesn't offer that size right now. Pick another one.");
    return tier;
  };

  /** A computer this launch made: the one on the record, else the one carrying its request id. */
  const findOwnComputer = async (client: CloudProvider, record: CloudLaneLaunchRecord): Promise<CloudInstance | null> => {
    const launchId = record.snapshot.launchId;
    const known = record.snapshot.cloud.instanceId;
    if (known) {
      try {
        const instance = await client.getInstance(known);
        if (instance.status !== "deleted" && instance.metadata.ade_request_id === launchId) return instance;
      } catch (error) {
        if (!(error instanceof CloudProviderError && error.status === 404)) throw error;
      }
      record.snapshot.cloud.instanceId = null;
      store.persist(record);
    }
    const listed = await client.listInstances();
    return listed.find((instance) => instance.metadata.ade_request_id === launchId && instance.status !== "deleted") ?? null;
  };

  const createComputer = async (
    client: CloudProvider,
    record: CloudLaneLaunchRecord,
    tier: CloudTier,
    signal: AbortSignal,
  ): Promise<CloudInstance> => {
    const launchId = record.snapshot.launchId;
    const signInEnv = await (async () => (await deps.creator.machineEnv?.()) ?? {})().catch((error: unknown) => {
      // Only the error's name: its message could quote a vault value.
      logger.warn("cloud_lane_launch.machine_env_read_failed", { launchId, error: error instanceof Error ? error.name : typeof error });
      return {} as Record<string, string>;
    });
    const minAdeVersion = cloudMinAdeVersion(deps.creator.minAdeVersion?.() ?? null);
    const env = { ...signInEnv, ...(minAdeVersion ? { ADE_MIN_VERSION: minAdeVersion } : {}) };
    assertActive(record, signal);
    const input = {
      name: record.computerName,
      type: tier.type,
      resources: { cpu: tier.cpu, memory: tier.memoryGb },
      metadata: {
        [CLOUD_LANE_ID_METADATA]: record.snapshot.laneId,
        [CLOUD_LANE_NAME_METADATA]: record.snapshot.laneName.slice(0, 200),
        [CLOUD_PROJECT_ORIGIN_METADATA]: record.project.identity,
        ...(record.madeByChat ? { [CLOUD_MADE_BY_CHAT_METADATA]: record.madeByChat } : {}),
        created_by: "ade",
        ade_request_id: launchId,
      },
      ...(Object.keys(env).length ? { env } : {}),
      // The wake URL: the computer's brain requests it while it works (cloudSleep.ts).
      publicPorts: [{ port: CLOUD_WAKE_PORT, label: CLOUD_WAKE_PORT_LABEL }],
    };
    const waitUntil = Date.now() + CREATE_IN_PROGRESS_WAIT_MS;
    for (;;) {
      try {
        return await client.createInstance(input, signal);
      } catch (error) {
        assertActive(record, signal);
        // The server is still making it for this request id: ask again, never twice at once.
        if (error instanceof CloudProviderError && error.code === "create_in_progress" && Date.now() < waitUntil) {
          await sleep(CREATE_IN_PROGRESS_POLL_MS);
          continue;
        }
        if (!mayHaveMadeComputer(error)) throw error;
        // The answer was lost, but the computer may exist: look for its tag
        // instead of asking again, so an older server never makes two.
        logger.warn("cloud_lane_launch.create_answer_lost", { launchId, error: getErrorMessage(error) });
        const lookUntil = Date.now() + LOST_CREATE_LOOK_MS;
        while (Date.now() < lookUntil) {
          assertActive(record, signal);
          const found = await findOwnComputer(client, record).catch(() => null);
          if (found) return found;
          await sleep(CREATE_IN_PROGRESS_POLL_MS);
        }
        throw error;
      }
    }
  };

  const runComputerStage = async (record: CloudLaneLaunchRecord, signal: AbortSignal): Promise<void> => {
    setStage(record, "computer", "running", { detail: null });
    publish(record);
    const client = await providerClient();
    if (!deps.creator.directoryBaseUrl()) {
      throw new LaunchStepError("ADE's account service isn't set up on this computer, so it can't add a computer to your account.");
    }
    if (!(await deps.creator.getAccountToken())) throw new LaunchStepError("Sign in to ADE on this computer first. The new computer joins your account.");
    record.tier ??= await resolveTier(client, record.snapshot.cloud.sizeId);
    const tier = record.tier;
    assertActive(record, signal);
    let instance = await findOwnComputer(client, record);
    // A computer ADE Cloud gave up on never answers: delete it and make a new one.
    if (instance?.status === "failed") {
      logger.warn("cloud_lane_launch.failed_computer_replaced", { launchId: record.snapshot.launchId, instanceId: instance.id });
      await deleteCloudInstanceConfirmed(client, instance.id, { logger, sleep, reason: "lane_launch_failed_computer" });
      instance = null;
    }
    if (!instance) {
      if (!(await client.hasTemplate())) throw new LaunchStepError(CANT_MAKE_COMPUTER);
      const stage = stageOf(record, "computer");
      if (stage) stage.detail = `${tier.label} · ${tier.cpu} CPU, ${tier.memoryGb} GB`;
      publish(record, { persist: false });
      instance = await createComputer(client, record, tier, signal);
      logger.info("cloud_lane_launch.computer_created", { launchId: record.snapshot.launchId, instanceId: instance.id, tier: tier.id });
    }
    record.snapshot.cloud.instanceId = instance.id;
    publish(record);
    assertActive(record, signal);
    // The computer counts as made once its ADE answers.
    await waitForCloudBoxAuth(client, instance.id, { signal, sleep, machine: "the new computer" });
    finishStage(record, "computer", `${tier.label} · ${tier.cpu} CPU, ${tier.memoryGb} GB`);
  };

  const runJoinStage = async (record: CloudLaneLaunchRecord, signal: AbortSignal): Promise<void> => {
    const launchId = record.snapshot.launchId;
    const instanceId = record.snapshot.cloud.instanceId;
    if (!instanceId) throw new LaunchStepError("ADE lost track of the new computer. Cancel and send again.");
    setStage(record, "join", "running", { detail: null });
    publish(record);
    const client = await providerClient();
    const directory = deps.creator.directoryBaseUrl();
    if (!directory) throw new LaunchStepError("ADE's account service isn't set up on this computer, so it can't add a computer to your account.");
    const name = record.computerName;
    // Wakes a computer a failure put to sleep.
    const auth = await waitForCloudBoxAuth(client, instanceId, { signal, sleep, machine: "the new computer" });
    assertActive(record, signal);
    if (auth.signedIn !== true) {
      // A code an earlier attempt sent for approval may be used up: start a fresh one.
      const fresh = record.joinAttempts > 0;
      record.joinAttempts += 1;
      store.persist(record);
      const started = await startCloudBoxSignIn(client, instanceId, "login", signal, { fresh });
      assertActive(record, signal);
      if (!started.userCode) {
        logger.warn("cloud_lane_launch.sign_in_no_code", { launchId, instanceId, exitCode: started.exitCode });
        throw new LaunchStepError("The new computer didn't start its sign-in.");
      }
      await approveCloudMachineSignIn(deps.creator, {
        userCode: started.userCode,
        name,
        instanceId,
        requestId: launchId,
        restartSignIn: async () => (await startCloudBoxSignIn(client, instanceId, "login", signal, { fresh: true })).userCode,
        directory,
        signal,
        readSignedIn: async () => (await readCloudBoxAuth(client, instanceId, signal))?.signedIn === true,
        onApprovalSent: () => undefined,
        progress: (stage, message, _instanceId, approvalUrl) => {
          if (stage === "approve_elsewhere" && approvalUrl) deps.onApprovalLink?.(launchId, approvalUrl);
          // Only the steps that ask something of the person reach the row.
          const row = stageOf(record, "join");
          if (!row || row.status !== "running") return;
          row.detail = stage === "confirm_in_window" || stage === "approve_elsewhere" ? clip(message, 160) : null;
          publish(record, { persist: false });
        },
      });
    }
    assertActive(record, signal);
    const joinRow = stageOf(record, "join");
    if (joinRow) joinRow.detail = "Adding it to your computers…";
    publish(record, { persist: false });
    const row = await waitForCloudAccountRow(deps.creator, { client, instanceId, name, requestId: launchId, signal });
    if (!row.machineKey) throw new LaunchStepError("The new computer signed in, but ADE couldn't tell which computer it is.");
    record.snapshot.cloud.machineKey = row.machineKey;
    store.persist(record);
    // Signed in, so its brain keeps itself awake while it works; let ADE Cloud sleep it otherwise.
    const sleepResult = await enableCloudSleep(client, instanceId, { logger });
    if (sleepResult.state !== "on") logger.warn("cloud_lane_launch.sleep_not_enabled", { launchId, instanceId, state: sleepResult.state });
    // Nothing on its busy list sees the pairing and clone ahead: hold it awake until the hand-off.
    await client.exec(instanceId, cloudHoldCommand(LANE_LAUNCH_HOLD, LANE_LAUNCH_HOLD_MS), { timeoutMs: 30_000 }).catch((error: unknown) => {
      logger.warn("cloud_lane_launch.hold_failed", { launchId, instanceId, error: getErrorMessage(error) });
    });
    finishStage(record, "join", row.joined ? null : "Still starting");
  };

  const releaseHold = async (record: CloudLaneLaunchRecord): Promise<void> => {
    const instanceId = record.snapshot.cloud.instanceId;
    if (!instanceId) return;
    try {
      await (await providerClient()).exec(instanceId, cloudReleaseHoldCommand(LANE_LAUNCH_HOLD), { timeoutMs: 30_000 });
    } catch (error) {
      // It expires on its own.
      logger.warn("cloud_lane_launch.hold_release_failed", { launchId: record.snapshot.launchId, error: getErrorMessage(error) });
    }
  };

  /** Pairs and connects, retrying while the computer's account row and relay route come up. */
  const pairAndConnect = async (record: CloudLaneLaunchRecord, machineKey: string, signal: AbortSignal): Promise<string> => {
    const startedAt = Date.now();
    let lastError: unknown = null;
    for (;;) {
      assertActive(record, signal);
      try {
        const targetId = record.targetId ?? (await deps.pairMachine(machineKey)).targetId;
        record.targetId = targetId;
        if (await deps.connect(targetId)) return targetId;
      } catch (error) {
        lastError = error;
        // A saved target that is gone is paired again on the next try.
        if (/target was not found/i.test(getErrorMessage(error))) record.targetId = null;
      }
      if (Date.now() - startedAt >= CLOUD_JOIN_WATCH_MS) break;
      await sleep(CONNECT_RETRY_MS);
    }
    logger.warn("cloud_lane_launch.connect_timed_out", {
      launchId: record.snapshot.launchId,
      error: lastError ? getErrorMessage(lastError) : null,
    });
    throw new LaunchStepError("ADE couldn't connect to the new computer in time.");
  };

  const runCloneStage = async (record: CloudLaneLaunchRecord, signal: AbortSignal): Promise<void> => {
    const machineKey = record.snapshot.cloud.machineKey;
    if (!machineKey) throw new LaunchStepError("ADE lost track of the new computer. Cancel and send again.");
    setStage(record, "clone", "running", { detail: record.project.identity.replace(/^github\.com\//i, "") });
    publish(record);
    const targetId = await pairAndConnect(record, machineKey, signal);
    store.persist(record);
    assertActive(record, signal);
    const identity = record.project.identity;
    const sameRepo = (project: RemoteRuntimeProjectRecord) =>
      project.exists !== false && normalizeGitRemoteIdentity(project.gitOriginUrl) === identity;
    let project = (await deps.listProjects(targetId)).find(sameRepo) ?? null;
    if (!project) {
      const parentDir = await deps.defaultParentDir(targetId);
      assertActive(record, signal);
      // The computer's own brain joins a second request for the same folder
      // and answers with a checkout that is already there.
      project = await deps.cloneProject(targetId, { url: record.project.cloneUrl, parentDir, name: record.project.repoName });
    }
    assertActive(record, signal);
    record.snapshot.cloud.binding = await deps.resolveBinding(targetId, project.projectId, project.rootPath);
    finishStage(record, "clone", record.project.identity.replace(/^github\.com\//i, ""));
  };

  // ---------------------------------------------------------------------------
  // Hand-off, and following the brain after it
  // ---------------------------------------------------------------------------

  const markRemoved = (launchId: string): void => {
    if (!records.has(launchId)) return;
    records.delete(launchId);
    disposeRuntime(launchId);
    store.unpersist(launchId);
    deps.emit({ type: "launch-removed", launchId });
  };

  const onBrainEvent = (launchId: string, event: ChatLaunchEvent): void => {
    const record = records.get(launchId);
    if (!record || !isHandedOff(record)) return;
    if (event.type === "launch-removed") {
      if (event.launchId === launchId) markRemoved(launchId);
      return;
    }
    if (event.launch.launchId !== launchId) return;
    adoptBrainSnapshot(record, event.launch);
    // Progress ticks are many; only settled changes are written down.
    const settled = !event.launch.stages.some((stage) => stage.status === "running") || isChatLaunchTerminal(event.launch.phase);
    publish(record, { persist: settled });
    if (isChatLaunchTerminal(record.snapshot.phase)) stopFollowing(launchId);
  };

  const stopFollowing = (launchId: string): void => {
    const runtime = runtimes.get(launchId);
    if (!runtime) return;
    runtime.unsubscribe?.();
    runtime.unsubscribe = null;
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = null;
  };

  /** Follows the brain's events for a live, handed-off launch; tries again if the stream drops. */
  const follow = async (record: CloudLaneLaunchRecord): Promise<void> => {
    const launchId = record.snapshot.launchId;
    const binding = record.snapshot.cloud.binding;
    const runtime = runtimeFor(launchId);
    if (disposed || !binding || runtime.unsubscribe || runtime.subscribing || isChatLaunchTerminal(record.snapshot.phase)) return;
    runtime.subscribing = true;
    try {
      const unsubscribe = await deps.subscribeChatLaunchEvents(
        binding,
        (event) => onBrainEvent(launchId, event),
        () => {
          runtime.unsubscribe = null;
          scheduleFollowAgain(launchId);
        },
      );
      if (records.get(launchId) !== record || disposed || isChatLaunchTerminal(record.snapshot.phase)) {
        unsubscribe();
        return;
      }
      runtime.unsubscribe = unsubscribe;
      runtime.resubscribeAttempts = 0;
    } catch (error) {
      logger.warn("cloud_lane_launch.follow_failed", { launchId, error: getErrorMessage(error) });
      scheduleFollowAgain(launchId);
    } finally {
      runtime.subscribing = false;
    }
  };

  const scheduleFollowAgain = (launchId: string): void => {
    const record = records.get(launchId);
    const runtime = runtimes.get(launchId);
    if (disposed || !record || !runtime || runtime.timer || isChatLaunchTerminal(record.snapshot.phase)) return;
    if (runtime.resubscribeAttempts >= RESUBSCRIBE_ATTEMPTS) {
      // `get` still reads the brain on demand.
      logger.warn("cloud_lane_launch.follow_gave_up", { launchId });
      return;
    }
    runtime.resubscribeAttempts += 1;
    runtime.timer = setTimeout(() => {
      runtime.timer = null;
      void refreshFromBrain(record).finally(() => void follow(record));
    }, RESUBSCRIBE_MS);
    runtime.timer.unref?.();
  };

  /** One read of the brain's snapshot. Null answers mean the brain dropped a finished launch. */
  const refreshFromBrain = async (record: CloudLaneLaunchRecord): Promise<void> => {
    const binding = record.snapshot.cloud.binding;
    if (!binding || !isHandedOff(record)) return;
    const launchId = record.snapshot.launchId;
    try {
      const brain = await deps.callChatAction(binding, "getLaunch", { args: { launchId } }) as ChatLaunchSnapshot | null;
      if (records.get(launchId) !== record) return;
      if (!brain) {
        markRemoved(launchId);
        return;
      }
      adoptBrainSnapshot(record, brain);
      publish(record);
    } catch (error) {
      logger.warn("cloud_lane_launch.brain_read_failed", { launchId, error: getErrorMessage(error) });
    }
  };

  /** Messages typed before the brain had the launch, to the brain in order. Stops at the first that fails. */
  const deliverQueued = (record: CloudLaneLaunchRecord): Promise<void> => {
    const runtime = runtimeFor(record.snapshot.launchId);
    if (runtime.delivering) return runtime.delivering;
    const run = (async () => {
      const binding = record.snapshot.cloud.binding;
      if (!binding) return;
      const launchId = record.snapshot.launchId;
      for (;;) {
        // The brain's own queue holds what it got; only messages still here are sent.
        const nextId = record.pendingMessageIds[0];
        const next = nextId ? record.snapshot.queuedMessages.find((message) => message.id === nextId) : undefined;
        if (nextId && !next) {
          record.pendingMessageIds.shift();
          continue;
        }
        if (!next || disposed || record.snapshot.phase === "cancelled") return;
        try {
          const brain = await deps.callChatAction(binding, "queueLaunchMessage", {
            args: {
              launchId,
              text: next.text,
              ...(next.displayText ? { displayText: next.displayText } : {}),
              ...(next.attachments?.length ? { attachments: next.attachments } : {}),
            },
          }) as ChatLaunchSnapshot;
          record.pendingMessageIds = record.pendingMessageIds.filter((id) => id !== next.id);
          record.snapshot.queuedMessages = record.snapshot.queuedMessages.filter((message) => message.id !== next.id);
          // Written before the next send, so a quit now never sends this one twice.
          store.persist(record);
          if (brain?.launchId === launchId) adoptBrainSnapshot(record, brain);
          publish(record);
        } catch (error) {
          const message = clip(getErrorMessage(error), 200);
          logger.warn("cloud_lane_launch.queued_delivery_failed", { launchId, error: getErrorMessage(error) });
          next.deliveryError = message || "Couldn't send.";
          publish(record);
          return;
        }
      }
    })().finally(() => {
      if (runtime.delivering === run) runtime.delivering = null;
    });
    runtime.delivering = run;
    return run;
  };

  const handOff = async (record: CloudLaneLaunchRecord, signal: AbortSignal): Promise<void> => {
    const launchId = record.snapshot.launchId;
    const binding = record.snapshot.cloud.binding;
    if (!binding || !record.targetId) throw new LaunchStepError("ADE lost track of the project on the new computer. Retry to set it up again.");
    await deps.connect(record.targetId);
    assertActive(record, signal);
    const priorStages = record.snapshot.stages.filter((stage) => isChatLaunchCloudStageId(stage.id)).map((stage) => ({ ...stage }));
    const args: ChatLaunchArgs = {
      ...record.launch,
      launchId,
      laneId: record.snapshot.laneId,
      laneName: record.snapshot.laneName,
      laneConfig: cloudLaneConfig(record.launch.laneConfig),
      priorStages,
    };
    // Subscribed first, so no event between the start and the stream is missed.
    void follow(record);
    const brain = await deps.callChatAction(binding, "startLaunch", { args }) as ChatLaunchSnapshot;
    if (!brain || brain.launchId !== launchId) throw new Error("The computer's ADE answered the start with another launch.");
    record.sequenceBase = record.snapshot.sequence;
    // Queued here and not yet sent stay ahead of nothing: the brain's queue is empty at its start.
    adoptBrainSnapshot(record, brain);
    publish(record);
    logger.info("cloud_lane_launch.handed_off", {
      launchId,
      instanceId: record.snapshot.cloud.instanceId,
      queued: record.pendingMessageIds.length,
    });
    void releaseHold(record);
    await deliverQueued(record);
    void follow(record);
  };

  // ---------------------------------------------------------------------------
  // The pipeline
  // ---------------------------------------------------------------------------

  /** A computer that failed before it joined has no sleep of its own yet: sleep it while the launch waits. */
  const restWhileFailed = async (record: CloudLaneLaunchRecord, stage: ChatLaunchStageId): Promise<void> => {
    const instanceId = record.snapshot.cloud.instanceId;
    if (!instanceId) return;
    try {
      const client = await providerClient();
      if (stage === "computer" || stage === "join") await client.sleepInstance(instanceId);
      else await releaseHold(record);
    } catch (error) {
      logger.warn("cloud_lane_launch.rest_failed", { launchId: record.snapshot.launchId, error: getErrorMessage(error) });
    }
  };

  const fail = (record: CloudLaneLaunchRecord, stageId: ChatLaunchStageId, error: unknown): void => {
    const sentence = cloudLaneLaunchFailureSentence(stageId, error);
    setStage(record, stageId, "failed", { error: sentence });
    record.snapshot.phase = "failed";
    record.snapshot.error = sentence;
    publish(record);
    logger.warn("cloud_lane_launch.failed", {
      launchId: record.snapshot.launchId,
      stage: stageId,
      instanceId: record.snapshot.cloud.instanceId,
      error: getErrorMessage(error),
    });
    // A start the brain never took leaves nothing there to follow until Retry.
    if (!isHandedOff(record)) stopFollowing(record.snapshot.launchId);
    void restWhileFailed(record, stageId);
  };

  const runPipelineOnce = async (record: CloudLaneLaunchRecord): Promise<void> => {
    const signal = runtimeFor(record.snapshot.launchId).abort.signal;
    let active: ChatLaunchStageId = "computer";
    try {
      record.snapshot.phase = "running";
      record.snapshot.error = null;
      for (const id of CHAT_LAUNCH_CLOUD_STAGE_IDS) {
        if (isFinished(stageOf(record, id))) continue;
        active = id;
        assertActive(record, signal);
        if (id === "computer") await runComputerStage(record, signal);
        else if (id === "join") await runJoinStage(record, signal);
        else await runCloneStage(record, signal);
      }
      assertActive(record, signal);
      // The next row: the brain's first stage, which is what fails if it can't start.
      active = record.snapshot.stages.find((stage) => !isChatLaunchCloudStageId(stage.id))?.id ?? "agent";
      await handOff(record, signal);
    } catch (error) {
      if (error instanceof LaunchCancelled || error instanceof CloudCreateCancelled || record.snapshot.phase === "cancelled" || disposed) return;
      fail(record, active, error);
    }
  };

  const runPipeline = (record: CloudLaneLaunchRecord): Promise<void> => {
    const runtime = runtimeFor(record.snapshot.launchId);
    if (runtime.pipeline) return runtime.pipeline;
    const run = runPipelineOnce(record).finally(() => {
      if (runtime.pipeline === run) runtime.pipeline = null;
    });
    runtime.pipeline = run;
    return run;
  };

  // ---------------------------------------------------------------------------
  // Cancel cleanup
  // ---------------------------------------------------------------------------

  /** Deletes only computers made for this launch (its request id), then takes a joined one off the account. */
  const deleteOwnComputers = async (record: CloudLaneLaunchRecord): Promise<{ found: number; deleted: number }> => {
    const launchId = record.snapshot.launchId;
    const client = await providerClient();
    const own = new Map<string, CloudInstance>();
    const known = record.snapshot.cloud.instanceId;
    if (known) {
      try {
        const instance = await client.getInstance(known);
        if (instance.metadata.ade_request_id === launchId && instance.status !== "deleted") own.set(instance.id, instance);
      } catch (error) {
        if (!(error instanceof CloudProviderError && error.status === 404)) throw error;
      }
    }
    for (const instance of await client.listInstances()) {
      if (instance.metadata.ade_request_id === launchId && instance.status !== "deleted") own.set(instance.id, instance);
    }
    let deleted = 0;
    for (const instance of own.values()) {
      if (await deleteCloudInstanceConfirmed(client, instance.id, { logger, sleep, reason: "lane_launch_cancelled" })) {
        deleted += 1;
        logger.info("cloud_lane_launch.computer_deleted", { launchId, instanceId: instance.id });
      }
    }
    const machineKey = record.snapshot.cloud.machineKey;
    if (machineKey && deleted === own.size && own.size > 0) {
      await deps.removeAccountMachine(machineKey).catch((error: unknown) => {
        logger.warn("cloud_lane_launch.account_row_left", { launchId, error: getErrorMessage(error) });
      });
    }
    return { found: own.size, deleted };
  };

  /** Cancel's cleanup; a create still in flight is followed until its computer shows up and is deleted. */
  const cleanUp = async (record: CloudLaneLaunchRecord): Promise<void> => {
    const launchId = record.snapshot.launchId;
    try {
      const { found, deleted } = await deleteOwnComputers(record);
      if (found > deleted) {
        record.snapshot.error = CANT_DELETE_YET;
        publish(record);
        return;
      }
      record.snapshot.error = null;
      record.snapshot.cloud.instanceId = null;
      // No computer yet, but a create may still land: watch for it a while.
      if (found === 0 && !record.cleanupDone && record.snapshot.stages.some((stage) => stage.id === "computer" && stage.startedAt)) {
        const followUntil = Date.now() + CANCELLED_CREATE_FOLLOW_MS;
        void (async () => {
          while (Date.now() < followUntil && !disposed && records.get(launchId) === record) {
            await sleep(CANCELLED_CREATE_FOLLOW_POLL_MS);
            const late = await deleteOwnComputers(record).catch(() => ({ found: 0, deleted: 0 }));
            if (late.found > 0) break;
          }
          record.cleanupDone = true;
          publish(record);
        })();
        return;
      }
      record.cleanupDone = true;
      publish(record);
    } catch (error) {
      logger.warn("cloud_lane_launch.cleanup_failed", { launchId, error: getErrorMessage(error) });
      record.snapshot.error = CANT_DELETE_YET;
      publish(record);
    }
  };

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const start = async (input: CloudLaneLaunchStartInput): Promise<ChatLaunchSnapshot> => {
    if (disposed) throw new Error("ADE is shutting down.");
    const args = input.args;
    const launchId = requireLaunchId(args?.launchId);
    const existing = records.get(launchId);
    if (existing) return served(existing);
    const problem = cloudLaneLaunchStartProblem(input);
    if (problem) throw new Error(problem);
    const project = githubClone(input.originUrl)!;
    if (!args.chat || !args.cloud) throw new Error("An ADE Cloud lane starts with a chat.");
    const laneId = args.laneId?.trim() ? requireNormalizedUuid(args.laneId, "laneId must be a UUID.") : randomUUID();
    const prompt = String(args.prompt ?? "");
    const laneName = args.laneName?.trim()
      || deriveDeterministicLaneTitleFromPrompt(prompt)
      || deriveDeterministicLaneNameFromPrompt(prompt, { genericSuffix: launchId.slice(0, 8) });
    const { cloud, priorStages: _priorStages, ...launch } = args;
    const snapshot = createChatLaunchSnapshot({
      launch: { ...launch, launchId, kind: "chat" },
      laneId,
      laneName,
      includeCloud: true,
      // The brain decides these; the rows show until its snapshot arrives.
      includeFetch: true,
      includeEnvironment: true,
      nowIso: nowIso(),
    });
    const record: CloudLaneLaunchRecord = {
      v: 1,
      snapshot: {
        ...snapshot,
        cloud: { sizeId: cloud.sizeId, projectOrigin: project.identity, instanceId: null, machineKey: null, binding: null, handedOff: false },
      },
      launch: { ...launch, launchId, kind: "chat", laneId, laneName },
      project,
      tier: null,
      computerName: normalizeCloudMachineName(laneName),
      targetId: null,
      joinAttempts: 0,
      sequenceBase: 0,
      pendingMessageIds: [],
      cleanupDone: false,
      madeByChat: input.madeByChat?.trim() || null,
    };
    records.set(launchId, record);
    publish(record);
    logger.info("cloud_lane_launch.started", { launchId, laneId, sizeId: cloud.sizeId });
    void runPipeline(record);
    return served(record);
  };

  const owns = (launchId: unknown): boolean => typeof launchId === "string" && records.has(launchId.trim().toLowerCase());

  /** What the record knows beyond the snapshot: the computer's name and the agent's chat that started it. */
  const facts = (launchId: string): { computerName: string; madeByChat: string | null } | null => {
    const record = records.get(launchId.trim().toLowerCase());
    return record ? { computerName: record.computerName, madeByChat: record.madeByChat ?? null } : null;
  };

  const recordFor = (args: ChatLaunchIdArgs | ChatLaunchQueueMessageArgs): CloudLaneLaunchRecord | null =>
    records.get(requireLaunchId(args?.launchId)) ?? null;

  const get = async (args: ChatLaunchIdArgs): Promise<ChatLaunchSnapshot | null> => {
    const record = recordFor(args);
    if (!record) return null;
    if (isHandedOff(record) && !isChatLaunchTerminal(record.snapshot.phase)) await refreshFromBrain(record);
    const current = records.get(record.snapshot.launchId);
    return current ? served(current) : null;
  };

  /** Every cloud launch here, or only those from one project (its normalized origin). */
  const list = (filter: { originUrl?: string | null } = {}): ChatLaunchSnapshot[] => {
    const identity = filter.originUrl ? normalizeGitRemoteIdentity(filter.originUrl) : null;
    return [...records.values()]
      .filter((record) => !identity || record.project.identity === identity)
      .map(served)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  };

  const cancel = async (args: ChatLaunchIdArgs): Promise<ChatLaunchSnapshot | null> => {
    const record = recordFor(args);
    if (!record) return null;
    const launchId = record.snapshot.launchId;
    if (record.snapshot.phase === "cancelled") return served(record);
    if (record.snapshot.agentStarted || record.snapshot.phase === "completed") throw new Error(LANE_ALREADY_STARTED);
    if (isHandedOff(record)) {
      const binding = record.snapshot.cloud.binding!;
      // The brain refuses once the agent runs; then nothing here is deleted.
      const brain = await deps.callChatAction(binding, "cancelLaunch", { args: { launchId } }) as ChatLaunchSnapshot | null;
      if (!brain) throw new Error(LANE_ALREADY_STARTED);
      adoptBrainSnapshot(record, brain);
    }
    const runtime = runtimeFor(launchId);
    const pipeline = runtime.pipeline;
    record.snapshot.phase = "cancelled";
    record.snapshot.error = null;
    record.snapshot.queuedMessages = [];
    record.pendingMessageIds = [];
    for (const stage of record.snapshot.stages) {
      if (stage.status === "running" || stage.status === "pending") {
        stage.status = "skipped";
        stage.endedAt = nowIso();
      }
    }
    record.snapshot.endedAt = nowIso();
    runtime.abort.abort();
    stopFollowing(launchId);
    publish(record);
    logger.info("cloud_lane_launch.cancelled", { launchId, handedOff: isHandedOff(record), instanceId: record.snapshot.cloud.instanceId });
    if (pipeline) {
      await Promise.race([pipeline, sleep(CANCEL_PIPELINE_WAIT_MS)]);
    }
    await cleanUp(record);
    return served(record);
  };

  const retry = async (args: ChatLaunchIdArgs): Promise<ChatLaunchSnapshot | null> => {
    const record = recordFor(args);
    if (!record) return null;
    if (isHandedOff(record)) {
      const brain = await deps.callChatAction(record.snapshot.cloud.binding!, "retryLaunch", { args: { launchId: record.snapshot.launchId } }) as ChatLaunchSnapshot | null;
      if (brain) {
        adoptBrainSnapshot(record, brain);
        publish(record);
      }
      void deliverQueued(record);
      void follow(record);
      return served(record);
    }
    if (record.snapshot.phase !== "failed") return served(record);
    const runtime = runtimeFor(record.snapshot.launchId);
    if (runtime.abort.signal.aborted) runtime.abort = new AbortController();
    for (const stage of record.snapshot.stages) {
      if (stage.status === "failed") setStage(record, stage.id, "pending");
    }
    record.snapshot.phase = "running";
    record.snapshot.error = null;
    record.snapshot.endedAt = null;
    publish(record);
    logger.info("cloud_lane_launch.retried", { launchId: record.snapshot.launchId });
    void runPipeline(record);
    return served(record);
  };

  const startNow = async (args: ChatLaunchIdArgs): Promise<ChatLaunchSnapshot | null> => {
    const record = recordFor(args);
    if (!record) return null;
    // Before the hand-off there is no environment to skip yet.
    if (!isHandedOff(record)) return served(record);
    const brain = await deps.callChatAction(record.snapshot.cloud.binding!, "startLaunchNow", { args: { launchId: record.snapshot.launchId } }) as ChatLaunchSnapshot | null;
    if (brain) {
      adoptBrainSnapshot(record, brain);
      publish(record);
    }
    return served(record);
  };

  const queueMessage = async (args: ChatLaunchQueueMessageArgs): Promise<ChatLaunchSnapshot> => {
    const record = recordFor(args);
    // Throw rather than answer: a caller holding a message must never read "no launch" as "queued".
    if (!record) throw new Error(`Launch not found: ${String(args?.launchId)}`);
    const text = String(args.text ?? "");
    if (!text.trim() && !args.attachments?.length) throw new Error("A queued message needs text or an attachment.");
    if (record.snapshot.phase === "cancelled") throw new Error("This launch was cancelled.");
    if (hasLocalAttachments(args.attachments) && !isHandedOff(record)) {
      throw new Error("Files from this computer can't go to the new ADE Cloud computer yet. Send this once the chat starts.");
    }
    const waitingHere = record.pendingMessageIds.length > 0;
    if (isHandedOff(record) && !waitingHere) {
      const brain = await deps.callChatAction(record.snapshot.cloud.binding!, "queueLaunchMessage", {
        args: { launchId: record.snapshot.launchId, text, ...(args.displayText ? { displayText: args.displayText } : {}), ...(args.attachments?.length ? { attachments: args.attachments } : {}) },
      }) as ChatLaunchSnapshot;
      if (brain?.launchId === record.snapshot.launchId) {
        adoptBrainSnapshot(record, brain);
        publish(record);
      }
      return served(record);
    }
    if (record.pendingMessageIds.length >= MAX_QUEUED_MESSAGES) {
      throw new Error(`At most ${MAX_QUEUED_MESSAGES} messages can wait for the lane.`);
    }
    const queued = toQueuedMessage({ ...args, text }, { id: randomUUID(), createdAt: nowIso() });
    record.snapshot.queuedMessages.push(queued);
    record.pendingMessageIds.push(queued.id);
    publish(record);
    // Waiting behind an earlier one that failed to send: this is the cue to try them all again.
    if (isHandedOff(record)) {
      for (const message of record.snapshot.queuedMessages) {
        if (record.pendingMessageIds.includes(message.id)) delete message.deliveryError;
      }
      void deliverQueued(record);
    }
    return served(record);
  };

  /** Only a CLI launch waits on its client, and a cloud launch is always a chat. */
  const completeClient = async (args: ChatLaunchIdArgs): Promise<ChatLaunchSnapshot | null> => {
    const record = recordFor(args);
    return record ? served(record) : null;
  };

  /** Picks up what a quit left: setup goes on, a handed-off launch is followed again, a cancel finishes its cleanup. */
  const resume = (): void => {
    for (const record of records.values()) {
      const launchId = record.snapshot.launchId;
      if (record.snapshot.phase === "cancelled") {
        if (!record.cleanupDone) void cleanUp(record);
        continue;
      }
      if (isHandedOff(record)) {
        if (isChatLaunchTerminal(record.snapshot.phase) && record.pendingMessageIds.length === 0) {
          scheduleExpiry(record);
          continue;
        }
        void (async () => {
          if (record.targetId) await deps.connect(record.targetId).catch(() => undefined);
          await refreshFromBrain(record);
          await deliverQueued(record);
          void follow(record);
        })();
        continue;
      }
      if (record.snapshot.phase !== "running") continue;
      // The step that was running when ADE quit runs again; each one checks what it already did.
      for (const stage of record.snapshot.stages) {
        if (stage.status === "running") setStage(record, stage.id, "pending");
      }
      logger.info("cloud_lane_launch.resumed", { launchId });
      publish(record);
      void runPipeline(record);
    }
  };

  for (const record of store.loadAll()) {
    // A reloaded snapshot jumps ahead, so a window that kept an older copy takes it.
    record.snapshot.sequence += 1_000;
    records.set(record.snapshot.launchId, record);
  }
  const resumeTimer = records.size > 0
    ? setTimeout(() => resume(), deps.resumeDelayMs ?? DEFAULT_RESUME_DELAY_MS)
    : null;
  resumeTimer?.unref?.();

  const dispose = (): void => {
    disposed = true;
    if (resumeTimer) clearTimeout(resumeTimer);
    for (const [launchId, runtime] of runtimes) {
      runtime.abort.abort();
      disposeRuntime(launchId);
    }
  };

  return { start, owns, facts, get, list, cancel, retry, startNow, queueMessage, completeClient, dispose };
}

export type CloudLaneLaunchService = ReturnType<typeof createCloudLaneLaunchService>;
