import { randomUUID } from "node:crypto";
import {
  CHAT_LAUNCH_CLOUD_STAGE_IDS,
  chatLaunchAlreadyStartedMessage,
  chatLaunchKindOf,
  chatLaunchKindUnknownToBrain,
  createChatLaunchSnapshot,
  isChatLaunchCloudStageId,
  isChatLaunchTerminal,
  toQueuedMessage,
} from "../../../shared/chatLaunch";
import { CLOUD_LANE_BRANCH_METADATA, cloudLaneLaunchStartRefusal } from "../../../shared/cloudLaneLaunch";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { deriveDeterministicLaneNameFromPrompt, deriveDeterministicLaneTitleFromPrompt } from "../../../shared/laneNameFallback";
import { requireNormalizedUuid } from "../../../shared/uuid";
import type {
  ChatLaunchArgs,
  ChatLaunchCloudStageId,
  ChatLaunchCompleteClientArgs,
  ChatLaunchEvent,
  ChatLaunchIdArgs,
  ChatLaunchQueueMessageArgs,
  ChatLaunchSnapshot,
  ChatLaunchStage,
  ChatLaunchStageId,
  ChatLaunchStageStatus,
  AgentChatFileRef,
} from "../../../shared/types";
import { getErrorMessage } from "../shared/utils";
import { CloudCreateCancelled, normalizeCloudMachineName } from "./cloudMachineCreator";
import { createCloudLaneComputerStages } from "./cloudLaneComputerStages";
import { createCloudLaneLaunchRecordStore, type CloudLaneLaunchRecord } from "./cloudLaneLaunchRecords";
import {
  BRAIN_TOO_OLD,
  CANCEL_PIPELINE_WAIT_MS,
  CANCELLED_CREATE_FOLLOW_MS,
  CANCELLED_CREATE_FOLLOW_POLL_MS,
  CANT_CARRY_FILES,
  cantDeleteComputer,
  DEFAULT_FINISHED_RETENTION_MS,
  DEFAULT_RESUME_DELAY_MS,
  LaunchCancelled,
  LaunchStepError,
  MAX_QUEUED_MESSAGES,
  RESUBSCRIBE_ATTEMPTS,
  RESUBSCRIBE_MS,
  clip,
  cloudLaneConfig,
  cloudLaneLaunchFailureSentence,
  githubClone,
  hasLocalAttachments,
  isFinished,
  requireLaunchId,
  type CloudLaneLaunchDeps,
  type CloudLaneLaunchStartInput,
} from "./cloudLaneLaunchSteps";

export type { CloudLaneLaunchDeps, CloudLaneLaunchStartInput } from "./cloudLaneLaunchSteps";

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
   * Whether the brain is followed (and read on `get`). A failed launch is not:
   * it waits for Retry, and every read reaches the computer and can wake it.
   */
  const isSettled = (record: CloudLaneLaunchRecord): boolean =>
    isChatLaunchTerminal(record.snapshot.phase) || record.snapshot.phase === "failed";

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

  /**
   * Writes the lane's branch into its computer's metadata once the brain
   * named it, so a lane that outlives its computer (the 30-day rule) knows
   * where to start again. Metadata writes replace, so it merges first.
   */
  const recordBranch = (record: CloudLaneLaunchRecord): void => {
    const branchRef = record.snapshot.branchRef?.trim() || null;
    const instanceId = record.snapshot.cloud.instanceId;
    if (!branchRef || !instanceId || record.branchRecorded === branchRef || record.snapshot.phase === "cancelled") return;
    record.branchRecorded = branchRef;
    void (async () => {
      const client = await providerClient();
      const instance = await client.getInstance(instanceId);
      if (instance.metadata[CLOUD_LANE_BRANCH_METADATA] === branchRef) return;
      await client.setInstanceMetadata(instanceId, { ...instance.metadata, [CLOUD_LANE_BRANCH_METADATA]: branchRef });
    })().catch((error: unknown) => {
      // Tried again on the next snapshot that names it.
      if (record.branchRecorded === branchRef) record.branchRecorded = null;
      logger.warn("cloud_lane_launch.branch_metadata_failed", { launchId: record.snapshot.launchId, error: getErrorMessage(error) });
    });
  };

  /** What a reader gets: the record's snapshot, unshared. */
  const served = (record: CloudLaneLaunchRecord): ChatLaunchSnapshot => clone(record.snapshot);

  // ---------------------------------------------------------------------------
  // The computer (cloudLaneComputerStages.ts)
  // ---------------------------------------------------------------------------

  const { providerClient, runComputerStage, runJoinStage, runCloneStage, releaseHold, deleteOwnComputers } = createCloudLaneComputerStages(
    deps,
    { stageOf, setStage, finishStage, publish, persist: (record) => store.persist(record), assertActive },
    { logger, sleep },
  );

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
    recordBranch(record);
    // Progress ticks are many; only settled changes are written down.
    const settled = !event.launch.stages.some((stage) => stage.status === "running") || isChatLaunchTerminal(event.launch.phase);
    publish(record, { persist: settled });
    if (isSettled(record)) stopFollowing(launchId);
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
    if (disposed || !binding || runtime.unsubscribe || runtime.subscribing || isSettled(record)) return;
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
      if (records.get(launchId) !== record || disposed || isSettled(record)) {
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
    if (disposed || !record || !runtime || runtime.timer || isSettled(record)) return;
    if (runtime.resubscribeAttempts >= RESUBSCRIBE_ATTEMPTS) {
      // `get` still reads the brain on demand.
      logger.warn("cloud_lane_launch.follow_gave_up", { launchId });
      return;
    }
    runtime.resubscribeAttempts += 1;
    runtime.timer = setTimeout(() => {
      runtime.timer = null;
      if (isSettled(record)) return;
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
      recordBranch(record);
      publish(record);
    } catch (error) {
      logger.warn("cloud_lane_launch.brain_read_failed", { launchId, error: getErrorMessage(error) });
    }
  };

  /**
   * Files from this computer named in the launch, sent to the project on the
   * new computer: the same list with each file's path there. Each file goes
   * once per launch (`record.carriedFiles`), so a Retry sends none twice.
   * Links and files already there pass as they are.
   */
  const carryAttachments = async (record: CloudLaneLaunchRecord, list: AgentChatFileRef[] | undefined): Promise<AgentChatFileRef[] | undefined> => {
    if (!list?.length || !hasLocalAttachments(list)) return list;
    const binding = record.snapshot.cloud.binding;
    const upload = deps.uploadAttachment;
    if (!binding || !upload) throw new LaunchStepError(CANT_CARRY_FILES);
    const carried = (record.carriedFiles ??= {});
    const out: AgentChatFileRef[] = [];
    for (const attachment of list) {
      if (attachment.type === "image-url") {
        out.push(attachment);
        continue;
      }
      const there = carried[attachment.path];
      if (there) {
        out.push({ ...attachment, path: there });
        continue;
      }
      const filename = attachment.path.split(/[\\/]/).pop() || "attachment";
      try {
        const uploaded = await upload(binding, { sourcePath: attachment.path, filename });
        carried[attachment.path] = uploaded.path;
        store.persist(record);
        out.push({ ...attachment, path: uploaded.path });
      } catch (error) {
        throw new LaunchStepError(`ADE couldn't send ${filename} to the new computer: ${getErrorMessage(error).replace(/\.$/, "")}. Retry to send it again.`);
      }
    }
    return out;
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
          const attachments = await carryAttachments(record, next.attachments);
          const brain = await deps.callChatAction(binding, "queueLaunchMessage", {
            args: {
              launchId,
              text: next.text,
              ...(next.displayText ? { displayText: next.displayText } : {}),
              ...(attachments?.length ? { attachments } : {}),
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
    // An older brain reads a CLI or lane launch as a chat and fails for "no
    // chat". Refused here with what to do; Retry runs this step again.
    if (record.snapshot.kind !== "chat" && deps.brainLaunchKinds) {
      const kinds = await deps.brainLaunchKinds(record.targetId).catch((error: unknown) => {
        logger.warn("cloud_lane_launch.brain_kinds_failed", { launchId, error: getErrorMessage(error) });
        return null;
      });
      assertActive(record, signal);
      if (chatLaunchKindUnknownToBrain(record.snapshot.kind, kinds)) {
        logger.warn("cloud_lane_launch.brain_too_old", { launchId, kind: record.snapshot.kind, kinds });
        throw new LaunchStepError(BRAIN_TOO_OLD);
      }
    }
    // Files picked on this computer go to the clone there before the start
    // names them. The bubble keeps showing the names picked here.
    const attachments = await carryAttachments(record, record.launch.attachments);
    const chat = record.launch.chat
      ? { ...record.launch.chat, message: { ...record.launch.chat.message, attachments: await carryAttachments(record, record.launch.chat.message.attachments) } }
      : record.launch.chat;
    assertActive(record, signal);
    const priorStages = record.snapshot.stages.filter((stage) => isChatLaunchCloudStageId(stage.id)).map((stage) => ({ ...stage }));
    const args: ChatLaunchArgs = {
      ...record.launch,
      ...(attachments ? { attachments } : {}),
      ...(chat ? { chat } : {}),
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
    // Nothing is followed until Retry: a start the brain never took has nothing
    // there, and a failed one only waits (each read could wake the computer).
    stopFollowing(record.snapshot.launchId);
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

  /** Cancel's cleanup; a create still in flight is followed until its computer shows up and is deleted. */
  const cleanUp = async (record: CloudLaneLaunchRecord): Promise<void> => {
    const launchId = record.snapshot.launchId;
    try {
      const { found, deleted } = await deleteOwnComputers(record);
      if (found > deleted) {
        record.snapshot.error = cantDeleteComputer(record.computerName);
        publish(record);
        return;
      }
      record.snapshot.error = null;
      record.snapshot.cloud.instanceId = null;
      // No computer yet, but a create may still land: watch for it a while.
      if (found === 0 && !record.cleanupDone && record.snapshot.stages.some((stage) => stage.id === "computer" && stage.startedAt)) {
        const followUntil = Date.now() + CANCELLED_CREATE_FOLLOW_MS;
        void (async () => {
          // A late computer counts as cleaned up only once it is deleted; one
          // that is still starting refuses the delete, so it is tried again.
          let left: "none" | "computer" | "unknown" = "none";
          while (Date.now() < followUntil && !disposed && records.get(launchId) === record) {
            await sleep(CANCELLED_CREATE_FOLLOW_POLL_MS);
            const late = await deleteOwnComputers(record).catch((error: unknown) => {
              logger.warn("cloud_lane_launch.cleanup_failed", { launchId, error: getErrorMessage(error) });
              return null;
            });
            if (!late) {
              left = left === "computer" ? "computer" : "unknown";
              continue;
            }
            if (late.found === 0) {
              // None yet, or one seen before is gone now.
              left = "none";
              continue;
            }
            if (late.deleted === late.found) {
              left = "none";
              break;
            }
            left = "computer";
          }
          if (disposed || records.get(launchId) !== record) return;
          if (left === "none") {
            record.cleanupDone = true;
            record.snapshot.error = null;
          } else {
            // Kept open: ADE opening again tries the delete once more.
            logger.warn("cloud_lane_launch.cancelled_computer_left", { launchId, left });
            record.snapshot.error = cantDeleteComputer(record.computerName);
          }
          publish(record);
        })();
        return;
      }
      record.cleanupDone = true;
      publish(record);
    } catch (error) {
      logger.warn("cloud_lane_launch.cleanup_failed", { launchId, error: getErrorMessage(error) });
      record.snapshot.error = cantDeleteComputer(record.computerName);
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
    const problem = cloudLaneLaunchStartRefusal(input)?.message;
    if (problem) throw new Error(problem);
    if (!deps.uploadAttachment && (hasLocalAttachments(args.attachments) || hasLocalAttachments(args.chat?.message?.attachments))) {
      throw new Error(CANT_CARRY_FILES);
    }
    // The refusal above already asked for both; this narrows them.
    const project = githubClone(input.originUrl);
    const cloud = args.cloud;
    if (!project || !cloud) throw new Error("ADE Cloud can't start this launch.");
    // A chat, a tracked CLI session the launching window starts after the
    // hand-off (as on this computer), or the lane alone.
    const kind = chatLaunchKindOf(args.kind);
    const laneId = args.laneId?.trim() ? requireNormalizedUuid(args.laneId, "laneId must be a UUID.") : randomUUID();
    const prompt = String(args.prompt ?? "");
    const laneName = args.laneName?.trim()
      || deriveDeterministicLaneTitleFromPrompt(prompt)
      || deriveDeterministicLaneNameFromPrompt(prompt, { genericSuffix: launchId.slice(0, 8) });
    const { cloud: _cloud, priorStages: _priorStages, ...launch } = args;
    const snapshot = createChatLaunchSnapshot({
      launch: { ...launch, launchId, kind },
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
      launch: { ...launch, launchId, kind, laneId, laneName },
      project,
      tier: null,
      computerName: normalizeCloudMachineName(laneName),
      targetId: null,
      joinAttempts: 0,
      sequenceBase: 0,
      pendingMessageIds: [],
      cleanupDone: false,
      madeByChat: input.madeByChat?.trim() || null,
      madeByAgent: input.madeByAgent ?? null,
    };
    records.set(launchId, record);
    publish(record);
    logger.info("cloud_lane_launch.started", { launchId, laneId, kind, sizeId: cloud.sizeId });
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
    if (isHandedOff(record) && !isSettled(record)) await refreshFromBrain(record);
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
    if (record.snapshot.agentStarted || record.snapshot.phase === "completed") throw new Error(chatLaunchAlreadyStartedMessage(record.snapshot.kind));
    if (isHandedOff(record)) {
      const binding = record.snapshot.cloud.binding!;
      // The brain refuses once the agent runs; then nothing here is deleted.
      const brain = await deps.callChatAction(binding, "cancelLaunch", { args: { launchId } }) as ChatLaunchSnapshot | null;
      if (!brain) throw new Error(chatLaunchAlreadyStartedMessage(record.snapshot.kind));
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
    if (record.snapshot.kind === "lane") throw new Error("This lane starts no chat, so it can't take messages.");
    if (hasLocalAttachments(args.attachments) && !deps.uploadAttachment) throw new Error(CANT_CARRY_FILES);
    const waitingHere = record.pendingMessageIds.length > 0;
    if (isHandedOff(record) && !waitingHere) {
      const attachments = await carryAttachments(record, args.attachments);
      const brain = await deps.callChatAction(record.snapshot.cloud.binding!, "queueLaunchMessage", {
        args: { launchId: record.snapshot.launchId, text, ...(args.displayText ? { displayText: args.displayText } : {}), ...(attachments?.length ? { attachments } : {}) },
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

  /**
   * A CLI launch: the launching window started the CLI session on the
   * computer (through `snapshot.cloud.binding`) and reports it, or reports why
   * it couldn't. Only the computer's brain waits on it, so before the
   * hand-off there is nothing to complete.
   */
  const completeClient = async (args: ChatLaunchCompleteClientArgs): Promise<ChatLaunchSnapshot | null> => {
    const record = recordFor(args);
    if (!record) return null;
    if (record.snapshot.kind !== "cli" || !isHandedOff(record)) return served(record);
    const brain = await deps.callChatAction(record.snapshot.cloud.binding!, "completeLaunchClient", {
      args: {
        launchId: record.snapshot.launchId,
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        ...(args.error ? { error: args.error } : {}),
      },
    }) as ChatLaunchSnapshot | null;
    if (brain?.launchId === record.snapshot.launchId) {
      adoptBrainSnapshot(record, brain);
      publish(record);
    }
    return served(record);
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
        // A failed launch waits for Retry, which reads and follows the brain again.
        if (record.snapshot.phase === "failed") continue;
        void (async () => {
          if (record.targetId) {
            await deps.connect(record.targetId).catch((error: unknown) => {
              logger.warn("cloud_lane_launch.resume_connect_failed", { launchId, error: getErrorMessage(error) });
            });
          }
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
