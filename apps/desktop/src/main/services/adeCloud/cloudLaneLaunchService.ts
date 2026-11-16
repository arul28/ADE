import { randomUUID } from "node:crypto";
import {
  CHAT_LAUNCH_CLOUD_STAGE_IDS,
  chatLaunchAlreadyStartedMessage,
  chatLaunchKindOf,
  createChatLaunchSnapshot,
  isChatLaunchCloudStageId,
  isChatLaunchTerminal,
  toQueuedMessage,
} from "../../../shared/chatLaunch";
import type { CloudAgentMaker } from "../../../shared/adeCloud";
import { CLOUD_LANE_BRANCH_METADATA, cloudLaneLaunchStartRefusal } from "../../../shared/cloudLaneLaunch";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { deriveDeterministicLaneNameFromPrompt, deriveDeterministicLaneTitleFromPrompt } from "../../../shared/laneNameFallback";
import { requireNormalizedUuid } from "../../../shared/uuid";
import { getDefaultModelDescriptor, isModelProviderGroup } from "../../../shared/modelRegistry";
import { resolveMachineAdeDir } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { readPresetLaunchTarget } from "../chat/chatLaunchRoute";
import type {
  ChatLaunchChatArgs,
  ChatLaunchCloudStageId,
  ChatLaunchCloudState,
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
import { AdeExpectedError } from "../../../shared/expectedError";
import { getErrorMessage } from "../shared/utils";
import { CloudCreateCancelled, normalizeCloudMachineName } from "./cloudMachineCreator";
import { createCloudLaneComputerStages } from "./cloudLaneComputerStages";
import { CLOUD_AUTO_SIZE, cloudAutoSizeSentence } from "../../../../../account-directory/src/cloud/contract";
import { createCloudLaneLaunchRecordStore, type CloudLaneLaunchRecord } from "./cloudLaneLaunchRecords";
import {
  CANCEL_PIPELINE_WAIT_MS,
  CANCELLED_CREATE_FOLLOW_MS,
  CANCELLED_CREATE_FOLLOW_POLL_MS,
  CANT_CARRY_FILES,
  COMPUTER_DELETED_SENTENCE,
  COMPUTER_GONE_CHECK_MS,
  cantDeleteComputer,
  DEFAULT_FINISHED_RETENTION_MS,
  DEFAULT_RESUME_DELAY_MS,
  LaunchCancelled,
  LaunchStepError,
  MAX_QUEUED_MESSAGES,
  RESUBSCRIBE_ATTEMPTS,
  RESUBSCRIBE_MS,
  clip,
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
 * One launch, two owners, one id. The launch id is the chat's session id,
 * the server launch's id and the computer's create request id
 * (`ade_request_id`).
 *
 * - Before the hand-off this service owns the launch here, and ADE's server
 *   launcher (`/cloud/launches`) runs it there (`cloudLaneComputerStages.ts`):
 *   the server makes the computer with a one-time join key, and the computer
 *   signs itself in (no device approval), clones the repository and starts
 *   the same launch on its own brain from this app's args (same `launchId`
 *   and `laneId`, lane start forced to `on: "remote"`). The `computer`,
 *   `join` and `clone` rows show the server's stages.
 * - The hand-off: once the computer is in the account, this app pairs with
 *   it, finds the brain's launch there and follows it, and hands it the
 *   messages typed meanwhile, in order. From then on that brain owns the
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
 * Each step is safe to run again (Retry, or ADE opening after a quit): the
 * same launch id answers the same server launch (a Retry of one whose
 * computer failed begins again on a new computer), and pairing and
 * connecting repeat. Nothing runs while no cloud launch is live.
 */

/**
 * A chat launch that names no model (`ade chat create --machine cloud` without
 * `--model`) takes the model a chat on this computer would run: its preset's
 * (presets follow the account, so the computer reads the same one), else its
 * provider's default. ADE Cloud refuses a chat launch with no model, so
 * without this it failed at "Make computer".
 */
function withChatModel<T extends { chat?: ChatLaunchChatArgs }>(launch: T): T {
  const create = launch.chat?.create;
  if (!launch.chat || !create || create.modelId?.trim() || create.model?.trim()) return launch;
  const presetId = create.presetId?.trim();
  const preset = presetId ? readPresetLaunchTarget(presetId, resolveMachineAdeDir()) : null;
  // A preset this computer doesn't know: say so, never run another model under its name.
  if (presetId && !preset) throw new AdeExpectedError(`ADE can't find the preset ${presetId} on this computer, so it can't tell which model the lane should run. Pick the model, or the preset again.`, "user");
  const provider = preset?.harness ?? create.provider;
  const model = preset?.model || (isModelProviderGroup(provider) ? getDefaultModelDescriptor(provider)?.id : undefined);
  return model ? { ...launch, chat: { ...launch.chat, create: { ...create, model, modelId: model } } } : launch;
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
    /** A read of the brain failed and none worked since: repeats log at info. */
    readFailing: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    expiry: ReturnType<typeof setTimeout> | null;
  };
  const runtimes = new Map<string, Runtime>();
  let disposed = false;

  const runtimeFor = (launchId: string): Runtime => {
    let runtime = runtimes.get(launchId);
    if (!runtime) {
      runtime = { abort: new AbortController(), pipeline: null, delivering: null, unsubscribe: null, subscribing: false, resubscribeAttempts: 0, readFailing: false, timer: null, expiry: null };
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
      // A step resumed after ADE restarted keeps the start it had (`resume`
      // left it on the pending row); a new or retried step starts now.
      stage.startedAt = stage.status === "pending" && stage.startedAt ? stage.startedAt : at;
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
   * Whether the brain's event stream is followed: a launch still running, or
   * a finished one whose AI lane name has not landed yet (the name can arrive
   * after the chat started). Following stops once the record expires.
   */
  const followed = (record: CloudLaneLaunchRecord): boolean =>
    !isSettled(record) || (record.snapshot.laneNaming && isChatLaunchTerminal(record.snapshot.phase));

  /**
   * The brain's snapshot, served as this launch: its sequence above the local
   * one, the `cloud` block on it, and any message still waiting here behind
   * the ones the brain already holds.
   */
  /** The brain's sequence each launch last took (an event, a read or an action's answer). */
  const brainSequences = new Map<string, number>();
  /** A read the brain answered before an event this app already took: it would put an older state back. */
  const isStaleRead = (launchId: string, brain: ChatLaunchSnapshot): boolean =>
    brain.sequence < (brainSequences.get(launchId) ?? Number.NEGATIVE_INFINITY);

  const adoptBrainSnapshot = (record: CloudLaneLaunchRecord, brain: ChatLaunchSnapshot): void => {
    brainSequences.set(record.snapshot.launchId, brain.sequence);
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
      // An older ADE on the computer has no picked settings to show: keep this launch's.
      chatSettings: next.chatSettings ?? local.chatSettings ?? null,
      sequence: Math.max(local.sequence, record.sequenceBase + brain.sequence),
      queuedMessages: [...clone(brain.queuedMessages), ...pending],
      cloud: { ...local.cloud, handedOff: true },
    };
    // The computer's brain renames its computer with the lane (cloudLaneNameSync.ts):
    // this launch's sentences name it the same, never the placeholder it started on.
    const laneName = next.laneName?.trim();
    if (laneName) record.computerName = normalizeCloudMachineName(laneName);
    // The brain's rows are the ones it was handed: the computer's row says the size this app knows now.
    showComputerSize(record);
    // Setup moved the computer up (the brain's sentence for it): the size comes from the server, once.
    const environment = next.stages.find((stage) => stage.id === "environment");
    if (environment?.detail === cloudAutoSizeSentence("setup_memory") && record.snapshot.cloud.sizeId !== CLOUD_AUTO_SIZE.to) {
      void refreshServerSize(record).then((changed) => {
        if (!changed || records.get(record.snapshot.launchId) !== record) return;
        showComputerSize(record);
        publish(record);
      });
    }
  };

  /** The computer row's words, once the size is bigger than the one asked for (`sizeNote`). */
  const showComputerSize = (record: CloudLaneLaunchRecord): void => {
    if (!record.snapshot.cloud.sizeNote) return;
    const computer = record.snapshot.stages.find((stage) => stage.id === "computer");
    const words = computerWords(record);
    if (computer && words) computer.detail = words;
  };

  /**
   * Writes the lane's branch into its computer's metadata once the brain
   * named it, so a lane that outlives its computer (the 30-day rule) knows
   * where to start again. Metadata writes replace, so it merges first. One
   * write at a time per launch, and a write a newer name replaced is skipped,
   * so a slow placeholder write can never land after the AI-named branch.
   */
  const branchWrites = new Map<string, Promise<void>>();
  const recordBranch = (record: CloudLaneLaunchRecord): void => {
    const branchRef = record.snapshot.branchRef?.trim() || null;
    const instanceId = record.snapshot.cloud.instanceId;
    if (!branchRef || !instanceId || record.branchRecorded === branchRef || record.snapshot.phase === "cancelled") return;
    record.branchRecorded = branchRef;
    const launchId = record.snapshot.launchId;
    const write = (branchWrites.get(launchId) ?? Promise.resolve()).then(async () => {
      if (record.branchRecorded !== branchRef) return;
      const client = await providerClient();
      const instance = await client.getInstance(instanceId);
      if (instance.metadata[CLOUD_LANE_BRANCH_METADATA] === branchRef) return;
      await client.setInstanceMetadata(instanceId, { ...instance.metadata, [CLOUD_LANE_BRANCH_METADATA]: branchRef });
    }).catch((error: unknown) => {
      // Tried again on the next snapshot that names it.
      if (record.branchRecorded === branchRef) record.branchRecorded = null;
      logger.warn("cloud_lane_launch.branch_metadata_failed", { launchId, error: getErrorMessage(error) });
    });
    branchWrites.set(launchId, write);
    void write.finally(() => {
      if (branchWrites.get(launchId) === write) branchWrites.delete(launchId);
    });
  };

  /** What a reader gets: the record's snapshot, unshared. */
  const served = (record: CloudLaneLaunchRecord): ChatLaunchSnapshot => clone(record.snapshot);

  // ---------------------------------------------------------------------------
  // The computer, through the server launcher (cloudLaneComputerStages.ts)
  // ---------------------------------------------------------------------------

  const { providerClient, runServerLaunch, cancelOnServer, deleteOwnComputers, refreshServerSize, computerWords } = createCloudLaneComputerStages(
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
    if (!record || !isHandedOff(record) || record.snapshot.cloud.computerGone) return;
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
    // A finished launch is followed until its AI name lands (`followed`), so
    // the lane's name and renamed branch reach the card and the computer's
    // metadata.
    if (!followed(record)) stopFollowing(launchId);
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
    if (disposed || !binding || runtime.unsubscribe || runtime.subscribing || !followed(record)) return;
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
      if (records.get(launchId) !== record || disposed || !followed(record)) {
        unsubscribe();
        return;
      }
      runtime.unsubscribe = unsubscribe;
      runtime.resubscribeAttempts = 0;
      // One read once subscribed: a change between the hand-off's read (or
      // the last stream) and this subscribe never comes as an event.
      void refreshFromBrain(record);
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
    if (disposed || !record || !runtime || runtime.timer || !followed(record)) return;
    if (runtime.resubscribeAttempts >= RESUBSCRIBE_ATTEMPTS) {
      // `get` still reads the brain on demand.
      logger.warn("cloud_lane_launch.follow_gave_up", { launchId });
      return;
    }
    runtime.resubscribeAttempts += 1;
    runtime.timer = setTimeout(() => {
      runtime.timer = null;
      if (!followed(record)) return;
      void refreshFromBrain(record).finally(() => void follow(record));
    }, RESUBSCRIBE_MS);
    runtime.timer.unref?.();
  };

  /**
   * A launch whose computer was deleted before it finished (from ADE, the web
   * page, the phone, a cleanup) has no brain left to read, so its last
   * snapshot ("running") would stay up for good. While the brain can't be
   * read, ADE Cloud is asked whether the computer is still there, at most once
   * a minute per launch; a gone computer ends the launch with a plain sentence.
   */
  const computerGoneCheckedAt = new Map<string, number>();
  const endIfComputerGone = async (record: CloudLaneLaunchRecord): Promise<void> => {
    const launchId = record.snapshot.launchId;
    const instanceId = record.snapshot.cloud.instanceId;
    if (!instanceId || isSettled(record)) return;
    const now = Date.now();
    if (now - (computerGoneCheckedAt.get(launchId) ?? 0) < COMPUTER_GONE_CHECK_MS) return;
    computerGoneCheckedAt.set(launchId, now);
    // The account's list, not a read of the one computer: a 404 also comes
    // when the account has lost ADE Cloud, while a list that answers and
    // leaves it out means it is gone. A list that fails proves nothing.
    const instances = await (await providerClient()).listInstances();
    const gone = !instances.some((instance) => instance.id === instanceId && instance.status !== "deleted");
    if (!gone || records.get(launchId) !== record || isSettled(record)) return;
    record.snapshot.cloud.computerGone = true;
    stopFollowing(launchId);
    const stage = record.snapshot.stages.find((entry) => entry.status === "running")?.id ?? "agent";
    fail(record, stage, new LaunchStepError(COMPUTER_DELETED_SENTENCE));
  };

  /** One read of the brain's snapshot. Null answers mean the brain dropped a finished launch. */
  const refreshFromBrain = async (record: CloudLaneLaunchRecord): Promise<void> => {
    const binding = record.snapshot.cloud.binding;
    if (!binding || !isHandedOff(record)) return;
    const launchId = record.snapshot.launchId;
    try {
      const brain = await deps.callChatAction(binding, "getLaunch", { args: { launchId } }) as ChatLaunchSnapshot | null;
      const reading = runtimes.get(launchId);
      if (reading) reading.readFailing = false;
      // A read that was out when the computer was found gone never brings "running" back.
      if (records.get(launchId) !== record || record.snapshot.cloud.computerGone) return;
      if (!brain) {
        markRemoved(launchId);
        return;
      }
      if (isStaleRead(launchId, brain)) return;
      adoptBrainSnapshot(record, brain);
      recordBranch(record);
      publish(record);
    } catch (error) {
      // The follow loop reads each few seconds: one warn for each outage.
      const reading = runtimes.get(launchId);
      const repeat = reading?.readFailing === true;
      if (reading) reading.readFailing = true;
      logger[repeat ? "info" : "warn"]("cloud_lane_launch.brain_read_failed", { launchId, error: getErrorMessage(error) });
      await endIfComputerGone(record).catch((goneError: unknown) => {
        logger.info("cloud_lane_launch.computer_gone_check_failed", { launchId, error: getErrorMessage(goneError) });
      });
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
              // A retried hand-off (the reply was lost) is queued and sent once.
              clientSendId: next.id,
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

  /** The computer's brain holds the launch: from here on it is followed, and the messages typed meanwhile go to it. */
  const handOff = async (record: CloudLaneLaunchRecord, brain: ChatLaunchSnapshot): Promise<void> => {
    record.sequenceBase = record.snapshot.sequence;
    delete record.snapshot.cloud.approvalUrl;
    // Queued here and not yet sent stay ahead of nothing: the brain's queue is empty at its start.
    adoptBrainSnapshot(record, brain);
    publish(record);
    logger.info("cloud_lane_launch.handed_off", {
      launchId: record.snapshot.launchId,
      instanceId: record.snapshot.cloud.instanceId,
      queued: record.pendingMessageIds.length,
    });
    void follow(record);
    await deliverQueued(record);
  };

  // ---------------------------------------------------------------------------
  // The pipeline
  // ---------------------------------------------------------------------------

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
  };

  /**
   * A launch from an ADE before the server launcher: its computer was made
   * here and never joins by itself. That computer is deleted, and the launch
   * starts again on the server, under the same id.
   */
  const startOverOnServer = async (record: CloudLaneLaunchRecord): Promise<void> => {
    const launchId = record.snapshot.launchId;
    if (record.snapshot.cloud.instanceId || record.snapshot.stages.some((stage) => stage.id === "computer" && stage.startedAt)) {
      const { found, deleted } = await deleteOwnComputers(record);
      if (found > deleted) throw new LaunchStepError(cantDeleteComputer(record.computerName));
    }
    record.snapshot.cloud.instanceId = null;
    record.snapshot.cloud.machineKey = null;
    record.snapshot.cloud.binding = null;
    record.targetId = null;
    for (const id of CHAT_LAUNCH_CLOUD_STAGE_IDS) setStage(record, id, "pending");
    record.via = "server";
    store.persist(record);
    logger.info("cloud_lane_launch.moved_to_server", { launchId });
  };

  /** The row a failure lands on: the first cloud step not done, else the brain's first step. */
  const failingStage = (record: CloudLaneLaunchRecord): ChatLaunchStageId =>
    record.snapshot.stages.find((stage) => isChatLaunchCloudStageId(stage.id) && !isFinished(stage))?.id
    ?? record.snapshot.stages.find((stage) => !isChatLaunchCloudStageId(stage.id))?.id
    ?? "agent";

  const runPipelineOnce = async (record: CloudLaneLaunchRecord): Promise<void> => {
    const signal = runtimeFor(record.snapshot.launchId).abort.signal;
    try {
      record.snapshot.phase = "running";
      record.snapshot.error = null;
      if (record.via !== "server") await startOverOnServer(record);
      assertActive(record, signal);
      const brain = await runServerLaunch(record, signal);
      assertActive(record, signal);
      await handOff(record, brain);
    } catch (error) {
      if (error instanceof LaunchCancelled || error instanceof CloudCreateCancelled || record.snapshot.phase === "cancelled" || disposed) return;
      fail(record, failingStage(record), error);
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
  const cleanUp = async (record: CloudLaneLaunchRecord, options: { serverCancelled?: boolean } = {}): Promise<void> => {
    const launchId = record.snapshot.launchId;
    try {
      // The server's cancel first: it deletes the computer, also one its create
      // is still making. `cancel` already asked (`serverCancelled`); this is ADE
      // opening again on a cancel whose delete didn't finish, which the server
      // tries once more.
      if (!options.serverCancelled && !isHandedOff(record) && record.via === "server") {
        const answer = await cancelOnServer(record);
        if (answer === "started") {
          // Its agent runs there (a cancel from before the server was asked first): that computer stays.
          logger.warn("cloud_lane_launch.cancelled_launch_running", { launchId });
          record.cleanupDone = true;
          publish(record);
          return;
        }
        if (answer === "unreached") {
          // Nobody knows yet whether its agent started: nothing is deleted, and ADE opening again asks again.
          logger.warn("cloud_lane_launch.cleanup_waits_for_server", { launchId });
          publish(record);
          return;
        }
      }
      const { found, deleted, accountRowLeft } = await deleteOwnComputers(record);
      if (found > deleted) {
        record.snapshot.error = cantDeleteComputer(record.computerName);
        publish(record);
        return;
      }
      if (accountRowLeft) {
        // The computers are gone; its account row is tried again when ADE opens again.
        record.snapshot.error = null;
        record.snapshot.cloud.instanceId = null;
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
    // The launch the person asked for can't run on ADE Cloud (no GitHub
    // origin, no size, uncommitted start): the sentence says why.
    if (problem) throw new AdeExpectedError(problem, "user");
    if (!deps.uploadAttachment && (hasLocalAttachments(args.attachments) || hasLocalAttachments(args.chat?.message?.attachments))) {
      throw new Error(CANT_CARRY_FILES);
    }
    // The refusal above already asked for both; this narrows them.
    const project = githubClone(input.originUrl);
    const cloud = args.cloud;
    if (!project || !cloud) throw new Error("ADE Cloud can't start this launch.");
    // C4: a private repository needs a GitHub sign-in that follows the
    // account, checked before any computer is made (and hours spent).
    // No answer from GitHub goes on, and the card says what may happen.
    let gitWarning: string | null = null;
    if (deps.gitPreflight && input.originUrl) {
      const git = await deps.gitPreflight(input.originUrl);
      if (!git.ok) {
        logger.info("cloud_lane_launch.git_refused", { launchId, reason: git.reason });
        throw new AdeExpectedError(git.message, "user");
      }
      if (git.via === "unknown") {
        logger.warn("cloud_lane_launch.git_check_unknown", { launchId });
        gitWarning = git.warning;
      }
      // A second start of the same launch while GitHub answered: the first one owns it.
      const raced = records.get(launchId);
      if (raced) return served(raced);
    }
    // A chat, a tracked CLI session the launching window starts after the
    // hand-off (as on this computer), or the lane alone.
    const kind = chatLaunchKindOf(args.kind);
    const laneId = args.laneId?.trim() ? requireNormalizedUuid(args.laneId, "laneId must be a UUID.") : randomUUID();
    const prompt = String(args.prompt ?? "");
    const laneName = args.laneName?.trim()
      || deriveDeterministicLaneTitleFromPrompt(prompt)
      || deriveDeterministicLaneNameFromPrompt(prompt, { genericSuffix: launchId.slice(0, 8) });
    const { cloud: _cloud, priorStages: _priorStages, ...asked } = args;
    const launch = withChatModel(asked);
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
        cloud: {
          sizeId: cloud.sizeId,
          ...(cloud.sizeChoice ? { sizeChoice: cloud.sizeChoice } : {}),
          projectOrigin: project.identity,
          instanceId: null,
          machineKey: null,
          binding: null,
          handedOff: false,
          ...(gitWarning ? { warning: gitWarning } : {}),
        },
      },
      launch: { ...launch, launchId, kind, laneId, laneName },
      project,
      tier: null,
      computerName: normalizeCloudMachineName(laneName),
      targetId: null,
      via: "server",
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

  /** What the record knows beyond the snapshot: the computer's name, the agent's chat that started it, a page waiting for the person. */
  const facts = (launchId: string): CloudLaneLaunchFacts | null => {
    const record = records.get(launchId.trim().toLowerCase());
    return record
      ? {
        computerName: record.computerName,
        madeByChat: record.madeByChat ?? null,
        madeByAgent: record.madeByAgent ?? null,
        approvalUrl: isHandedOff(record) || record.snapshot.phase !== "running" ? null : record.snapshot.cloud.approvalUrl ?? null,
      }
      : null;
  };

  const recordFor = (args: ChatLaunchIdArgs | ChatLaunchQueueMessageArgs): CloudLaneLaunchRecord | null =>
    records.get(requireLaunchId(args?.launchId)) ?? null;

  const get = async (args: ChatLaunchIdArgs): Promise<ChatLaunchSnapshot | null> => {
    const record = recordFor(args);
    if (!record) return null;
    // Followed launches only: a finished one still naming its lane is read too, so the final name lands.
    if (isHandedOff(record) && followed(record)) await refreshFromBrain(record);
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
    const computerGone = record.snapshot.cloud.computerGone === true;
    if (computerGone) {
      // No brain to ask: the server's launch row is closed too, as far as it answers.
      await cancelOnServer(record);
    } else if (isHandedOff(record)) {
      const binding = record.snapshot.cloud.binding!;
      // The brain refuses once the agent runs; then nothing here is deleted.
      const brain = await deps.callChatAction(binding, "cancelLaunch", { args: { launchId } }) as ChatLaunchSnapshot | null;
      if (!brain) throw new Error(chatLaunchAlreadyStartedMessage(record.snapshot.kind));
      adoptBrainSnapshot(record, brain);
    } else if (record.via === "server") {
      // The server's word first: the computer can start its agent before this
      // app has paired and read it, and then its work is never deleted here.
      const answer = await cancelOnServer(record);
      if (answer === "started") throw new Error(chatLaunchAlreadyStartedMessage(record.snapshot.kind));
      if (answer === "unreached") throw new Error("ADE can't reach ADE Cloud to cancel this launch. Try again in a moment.");
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
    await cleanUp(record, { serverCancelled: computerGone || (!isHandedOff(record) && record.via === "server") });
    return served(record);
  };

  /**
   * `options.sizeChoice` "capped": the retry's caller is held to a size limit
   * that no longer allows the one step up (an unattended agent whose limits
   * were lowered since the first start), so a default size becomes "capped"
   * in the saved launch and in the request the server keeps.
   */
  const retry = async (args: ChatLaunchIdArgs, options: { sizeChoice?: ChatLaunchCloudState["sizeChoice"] } = {}): Promise<ChatLaunchSnapshot | null> => {
    const record = recordFor(args);
    if (!record) return null;
    // Nothing is left to retry on: the prompt starts again on a new computer.
    if (record.snapshot.cloud.computerGone) throw new AdeExpectedError(COMPUTER_DELETED_SENTENCE, "user");
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
    if (options.sizeChoice === "capped" && record.snapshot.cloud.sizeChoice === "default") record.snapshot.cloud.sizeChoice = "capped";
    const runtime = runtimeFor(record.snapshot.launchId);
    if (runtime.abort.signal.aborted) runtime.abort = new AbortController();
    // A computer that failed on its own side begins again on a new one; the server leaves any other launch as it is.
    record.retryOnServer = true;
    for (const stage of record.snapshot.stages) {
      if (stage.status === "failed") setStage(record, stage.id, "pending");
    }
    record.snapshot.phase = "running";
    record.snapshot.error = null;
    // A retry is a new attempt: its clock starts now, not at the first one
    // (finished steps keep their own durations), and the brain is handed this start.
    record.snapshot.startedAt = nowIso();
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
    // A failed environment step stopped the follow loop: the launch runs again.
    void follow(record);
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
          // A finished launch still waiting on its AI lane name is followed again.
          if (!followed(record)) continue;
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
        if (stage.status === "running") setStage(record, stage.id, "pending", { startedAt: stage.startedAt });
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

export type CloudLaneLaunchFacts = {
  computerName: string;
  madeByChat: string | null;
  madeByAgent: CloudAgentMaker | null;
  /** While the computer's sign-in waits on a page a person must confirm (rare): that page. */
  approvalUrl: string | null;
};
