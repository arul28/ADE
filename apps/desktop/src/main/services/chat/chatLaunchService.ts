import { randomUUID } from "node:crypto";
import type {
  AgentChatCreateArgs,
  AgentChatEventEnvelope,
  AgentChatSendArgs,
  AgentChatSession,
  AgentChatSuggestLaneNameArgs,
  AutoLaneIdentitySuggestion,
  ChatLaunchArgs,
  ChatLaunchChatArgs,
  ChatLaunchCompleteClientArgs,
  ChatLaunchEvent,
  ChatLaunchIdArgs,
  ChatLaunchPhase,
  ChatLaunchQueueMessageArgs,
  ChatLaunchSnapshot,
  ChatLaunchStage,
  ChatLaunchStageId,
  ChatLaunchStageStatus,
  DeleteLaneArgs,
  LaneEnvInitEvent,
  LaneEnvInitProgress,
  LaneSummary,
} from "../../../shared/types";
import type { AdeCardPayload } from "../../../shared/adeCard";
import { createChatLaunchSnapshot, isChatLaunchTerminal, toQueuedMessage } from "../../../shared/chatLaunch";
import {
  deriveDeterministicLaneNameFromPrompt,
  deriveDeterministicLaneTitleFromPrompt,
} from "../../../shared/laneNameFallback";
import { requireNormalizedUuid } from "../../../shared/uuid";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import type { LaneCreateRuntimeOptions } from "../lanes/laneService";
import type { ChatLaunchEnvironmentPlan } from "../lanes/laneEnvironmentSetup";
import { createChatLaunchRecordStore, type ChatLaunchRecord as LaunchRecord } from "./chatLaunchRecords";
import { createLaneSetupTranscriptCard, type LaneSetupCardState } from "./chatLaunchTranscriptCard";

/**
 * Brain-owned "launch a chat into a new lane".
 *
 * The client reserves the chat's session id (= launchId) and the lane id, calls
 * `start`, and opens the chat immediately. This service then walks the stages —
 * fetch base, check out files, lane environment (default template / project
 * env config), start agent — and publishes a full snapshot on every change.
 * Everything a client shows (thread card, sidebar row, slide-out, iOS) is
 * rendered from those snapshots, so every surface agrees. Records persist
 * across restarts (see `chatLaunchRecords.ts`).
 */

type LaneServiceLike = {
  create: (
    args: { name: string; baseBranch?: string; branchName?: string },
    options?: LaneCreateRuntimeOptions,
  ) => Promise<LaneSummary>;
  delete: (args: DeleteLaneArgs) => Promise<unknown>;
  /** Clear what an earlier, failed checkout left at the lane's reserved worktree path. */
  cleanupReservedWorktree?: (args: { laneId: string; name: string }) => Promise<void>;
  /** The live lane row with this id, or null (see `laneService.findLaneIdentity`). */
  findLaneIdentity?: (laneId: string) => ReservedLaneIdentity | null;
};

type ReservedLaneIdentity = Pick<LaneSummary, "id" | "name" | "branchRef" | "baseRef" | "worktreePath">;

type AgentChatServiceLike = {
  createSession: (args: AgentChatCreateArgs) => Promise<AgentChatSession>;
  sendMessage(args: AgentChatSendArgs, options: { awaitDispatch?: boolean; routeActiveToSteer: true }): Promise<unknown>;
  sendMessage(args: AgentChatSendArgs): Promise<unknown>;
  deleteSession: (args: { sessionId: string }) => Promise<void>;
  emitAdeCard: (args: { sessionId: string; card: AdeCardPayload }) => Promise<void>;
  subscribeToEvents: (callback: (event: AgentChatEventEnvelope) => void) => () => void;
  generateAutoLaneIdentity?: (args: AgentChatSuggestLaneNameArgs) => Promise<AutoLaneIdentitySuggestion>;
};

export type ChatLaunchBaseResolution = {
  /** The ref to branch from, or null for the lane service's default base. */
  baseRef: string | null;
  /** Remote fetch outcome: "ok", "failed" (last-known ref used), or "skipped" (local base). */
  fetch: "ok" | "failed" | "skipped";
};

export type ChatLaunchServiceDeps = {
  launchesDir: string;
  logger: Logger;
  laneService: LaneServiceLike;
  agentChatService: AgentChatServiceLike;
  /** True when the project creates lanes from the local base (no fetch stage). */
  usesLocalLaneBase: () => boolean;
  /** Fetch the remote and pick the base ref, the same way every base-less lane create does. */
  resolveBase: () => Promise<ChatLaunchBaseResolution>;
  /** Resolve a ref to its commit sha in the project checkout (for the stage detail). */
  resolveCommit: (ref: string) => Promise<string | null>;
  planEnvironment: () => ChatLaunchEnvironmentPlan;
  /**
   * Fill an empty chat `model` with the host's first available one — the same
   * auto-pick the sync host's `chat.create` applies. Every launch path (desktop
   * action, sync `chat.startLaunch`) goes through it.
   */
  resolveChatCreate?: (create: ChatLaunchChatArgs["create"]) => Promise<ChatLaunchChatArgs["create"]>;
  runEnvironment: (args: { laneId: string; templateId: string | null }) => Promise<LaneEnvInitProgress>;
  onEnvironmentEvent: (listener: (event: LaneEnvInitEvent) => void) => () => void;
  /** Stop a lane's in-flight environment setup and kill its running commands (Cancel). */
  abortEnvironment?: (args: { laneId: string; worktreePath: string | null }) => void;
  /**
   * A launch reached an outcome (once per outcome per launch in this process).
   * Product analytics hangs off this; the service itself stays analytics-free.
   */
  onOutcome?: (args: { outcome: "completed" | "cancelled" | "failed"; provider: string | null }) => void;
  emit: (event: ChatLaunchEvent) => void;
  now?: () => Date;
  /** How long a finished launch stays readable before it is dropped. */
  finishedRetentionMs?: number;
};

type EnvironmentOutcome = "ok" | "failed" | "empty";

type LaunchRuntime = LaneSetupCardState & {
  abort: AbortController;
  /** The running pipeline; Retry/Start anyway re-enter through it, Cancel awaits it. */
  pipeline: Promise<void> | null;
  /** The in-flight environment setup, reused when the pipeline re-enters. */
  environment: Promise<EnvironmentOutcome> | null;
  /** The in-flight queued-message delivery. */
  delivery: Promise<void> | null;
  deliveryAttempts: number;
  deliveryTimer: ReturnType<typeof setTimeout> | null;
  startNow: (() => void) | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  lastProgressEmitAt: number;
  progressTimer: ReturnType<typeof setTimeout> | null;
};

class LaunchCancelledError extends Error {
  constructor() { super("Launch cancelled."); }
}

const MAX_QUEUED_MESSAGES = 10;
/** `ensureManagedSession`'s wording when the chat no longer exists. */
const CHAT_SESSION_GONE_PATTERN = /Chat session '[^']*' was not found|is not an agent chat session/;
/** Automatic re-delivery attempts for a queued message after its first send failed (queueMessage retries too). */
const QUEUED_DELIVERY_BACKOFF_MS = [2_000, 10_000, 30_000];
const CANCEL_PIPELINE_WAIT_MS = 15_000;
const PROGRESS_EMIT_INTERVAL_MS = 120;
const DEFAULT_FINISHED_RETENTION_MS = 10 * 60_000;

const requireLaunchId = (value: unknown): string => requireNormalizedUuid(value, "launchId must be a UUID.");

/** Cancel is for setup only; once the agent runs, the lane is the user's to delete. */
export const CHAT_LAUNCH_ALREADY_STARTED_ERROR = "This chat already started — delete its lane from the lane menu instead.";

function autoLaneGenericSuffix(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

const temporaryAutoLaneBranch = (): string => `ade/${randomUUID().replace(/-/g, "").slice(0, 8)}`;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

export function createChatLaunchService(deps: ChatLaunchServiceDeps) {
  const { logger } = deps;
  const now = () => deps.now?.() ?? new Date();
  const nowIso = () => now().toISOString();
  const finishedRetentionMs = deps.finishedRetentionMs ?? DEFAULT_FINISHED_RETENTION_MS;
  const records = new Map<string, LaunchRecord>();
  const runtimes = new Map<string, LaunchRuntime>();
  const listeners = new Set<(event: ChatLaunchEvent) => void>();
  let disposed = false;

  /** Runtime event stream first, then in-process observers (the sync host's phone fan-out). */
  const emit = (event: ChatLaunchEvent): void => {
    deps.emit(event);
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        logger.warn("chat_launch.listener_failed", { error: getErrorMessage(error) });
      }
    }
  };

  const store = createChatLaunchRecordStore({ launchesDir: deps.launchesDir, logger });

  // ---------------------------------------------------------------------------
  // Snapshot plumbing
  // ---------------------------------------------------------------------------

  const newRuntime = (): LaunchRuntime => ({
    abort: new AbortController(),
    pipeline: null,
    environment: null,
    delivery: null,
    deliveryAttempts: 0,
    deliveryTimer: null,
    startNow: null,
    cardEmitted: false,
    cardTimer: null,
    unsubscribeChat: null,
    expiryTimer: null,
    lastProgressEmitAt: 0,
    progressTimer: null,
  });

  const runtimeFor = (launchId: string): LaunchRuntime => {
    let runtime = runtimes.get(launchId);
    if (!runtime) {
      runtime = newRuntime();
      if (disposed) {
        // After dispose nothing registers again: a pipeline still unwinding
        // gets an already-aborted, untracked runtime (no timers to leak).
        runtime.abort.abort();
        return runtime;
      }
      runtimes.set(launchId, runtime);
    }
    return runtime;
  };

  const cloneSnapshot = (snapshot: ChatLaunchSnapshot): ChatLaunchSnapshot => JSON.parse(JSON.stringify(snapshot));

  /** Undelivered queued messages keep a completed record (and its Retry) around; a cancelled one owes nothing. */
  const owesQueuedMessages = (snapshot: ChatLaunchSnapshot): boolean =>
    snapshot.phase !== "cancelled" && snapshot.queuedMessages.length > 0;

  const scheduleExpiry = (record: LaunchRecord): void => {
    if (disposed || owesQueuedMessages(record.snapshot)) return;
    const runtime = runtimeFor(record.snapshot.launchId);
    if (runtime.expiryTimer) clearTimeout(runtime.expiryTimer);
    runtime.expiryTimer = setTimeout(() => {
      const launchId = record.snapshot.launchId;
      const current = records.get(launchId);
      if (!current || !isChatLaunchTerminal(current.snapshot.phase) || owesQueuedMessages(current.snapshot)) return;
      records.delete(launchId);
      disposeRuntime(launchId);
      store.unpersist(launchId);
      emit({ type: "launch-removed", launchId });
    }, finishedRetentionMs);
    runtime.expiryTimer.unref?.();
  };

  /** Publish the record's current state. Every mutation funnels through here. */
  const reportedOutcomes = new Map<string, ChatLaunchPhase>();
  const reportOutcome = (record: LaunchRecord): void => {
    const phase = record.snapshot.phase;
    if (phase !== "completed" && phase !== "cancelled" && phase !== "failed") return;
    const launchId = record.snapshot.launchId;
    if (reportedOutcomes.get(launchId) === phase) return;
    reportedOutcomes.set(launchId, phase);
    try {
      deps.onOutcome?.({ outcome: phase, provider: record.provider });
    } catch (error) {
      logger.warn("chat_launch.outcome_hook_failed", { launchId, error: getErrorMessage(error) });
    }
  };

  const publish = (record: LaunchRecord, options: { persist?: boolean } = {}): void => {
    // Disposed: the host is shutting down and the persisted record is what the
    // next start revives; late pipeline work must not emit or re-arm timers.
    if (disposed) return;
    const snapshot = record.snapshot;
    snapshot.sequence += 1;
    snapshot.updatedAt = nowIso();
    if (options.persist !== false) store.persist(record);
    emit({ type: "launch-updated", launch: cloneSnapshot(snapshot) });
    reportOutcome(record);
    if (isChatLaunchTerminal(snapshot.phase)) scheduleExpiry(record);
    void transcriptCard.sync(record);
  };

  /** Checkout progress arrives many times a second; coalesce it. */
  const publishProgress = (record: LaunchRecord): void => {
    if (disposed) return;
    const runtime = runtimeFor(record.snapshot.launchId);
    const elapsed = Date.now() - runtime.lastProgressEmitAt;
    if (elapsed >= PROGRESS_EMIT_INTERVAL_MS) {
      runtime.lastProgressEmitAt = Date.now();
      publish(record, { persist: false });
      return;
    }
    if (runtime.progressTimer) return;
    runtime.progressTimer = setTimeout(() => {
      runtime.progressTimer = null;
      runtime.lastProgressEmitAt = Date.now();
      publish(record, { persist: false });
    }, PROGRESS_EMIT_INTERVAL_MS - elapsed);
  };

  const stageOf = (record: LaunchRecord, id: ChatLaunchStageId): ChatLaunchStage | null =>
    record.snapshot.stages.find((stage) => stage.id === id) ?? null;

  const setStage = (
    record: LaunchRecord,
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
      stage.percent = id === "checkout" ? 0 : null;
    } else if (status !== "pending") {
      stage.startedAt ??= at;
      stage.endedAt = at;
    } else {
      stage.startedAt = null;
      stage.endedAt = null;
      stage.error = null;
      stage.percent = null;
    }
    stage.status = status;
    Object.assign(stage, patch);
  };

  const failLaunch = (record: LaunchRecord, stageId: ChatLaunchStageId, message: string): void => {
    setStage(record, stageId, "failed", { error: message });
    record.snapshot.phase = "failed";
    record.snapshot.error = message;
    publish(record);
  };

  const assertActive = (record: LaunchRecord): void => {
    if (disposed || record.snapshot.phase === "cancelled" || runtimeFor(record.snapshot.launchId).abort.signal.aborted) {
      throw new LaunchCancelledError();
    }
  };

  const transcriptCard = createLaneSetupTranscriptCard({
    agentChatService: deps.agentChatService,
    logger,
    now,
    stateFor: runtimeFor,
    isDisposed: () => disposed,
  });

  // ---------------------------------------------------------------------------
  // Stages
  // ---------------------------------------------------------------------------

  const runFetchStage = async (record: LaunchRecord): Promise<string | null> => {
    if (record.baseBranch) return record.baseBranch;
    const stage = stageOf(record, "fetch");
    if (!stage) return null;
    setStage(record, "fetch", "running");
    publish(record, { persist: false });
    const resolution = await deps.resolveBase();
    assertActive(record);
    const sha = resolution.baseRef ? await deps.resolveCommit(resolution.baseRef).catch(() => null) : null;
    // A base that does not resolve (a configured upstream whose remote ref is
    // gone) must not fail the checkout; fall back to the lane service default.
    const baseRef = sha ? resolution.baseRef : null;
    record.snapshot.baseRef = baseRef;
    const at = sha ? ` at ${sha.slice(0, 7)}` : "";
    if (!baseRef) {
      setStage(record, "fetch", "skipped", { detail: "No remote base; using the local base" });
    } else if (resolution.fetch === "failed") {
      setStage(record, "fetch", "warning", { detail: `Fetch failed; using last-known ${baseRef}${at}` });
    } else {
      setStage(record, "fetch", "done", { detail: `${baseRef}${at}` });
    }
    publish(record);
    return baseRef;
  };

  const startLaneNaming = (record: LaunchRecord, lane: Pick<LaneSummary, "id" | "name" | "branchRef">): void => {
    const generate = deps.agentChatService.generateAutoLaneIdentity;
    const prompt = record.snapshot.prompt.text.trim();
    if (!generate || !prompt) return;
    record.snapshot.laneNaming = true;
    const launchId = record.snapshot.launchId;
    void generate({
      laneId: lane.id,
      prompt,
      modelId: record.snapshot.modelId ?? record.chat?.create.modelId ?? "",
      ...(record.snapshot.modelId ? { chatModelId: record.snapshot.modelId } : {}),
      ...(record.provider ? { provider: record.provider } : {}),
      fallbackName: lane.name,
      temporaryBranch: lane.branchRef,
      ...(record.snapshot.prompt.attachments.length ? { attachments: record.snapshot.prompt.attachments.slice(0, 8) } : {}),
    })
      .then((identity) => {
        const current = records.get(launchId);
        if (!current || current.snapshot.phase === "cancelled") return;
        if (identity.laneRenameOutcome === "renamed" && identity.laneTitle.trim()) {
          current.snapshot.laneName = identity.laneTitle.trim();
        }
        if (identity.branchRef?.trim()) current.snapshot.branchRef = identity.branchRef.trim();
      })
      .catch((error) => {
        logger.warn("chat_launch.lane_naming_failed", { launchId, error: getErrorMessage(error) });
      })
      .finally(() => {
        const current = records.get(launchId);
        if (!current) return;
        current.snapshot.laneNaming = false;
        publish(current);
      });
  };

  /**
   * The lane row a previous checkout of this launch inserted, if any. The row
   * lands before `laneService.create` returns, so ADE restarting in that
   * window leaves a real lane the record does not know about yet.
   */
  const findInterruptedLane = (record: LaunchRecord): ReservedLaneIdentity | null =>
    record.checkoutAttempted ? deps.laneService.findLaneIdentity?.(record.snapshot.laneId) ?? null : null;

  const adoptLane = (record: LaunchRecord, lane: ReservedLaneIdentity): void => {
    record.snapshot.laneCreated = true;
    record.snapshot.laneId = lane.id;
    record.snapshot.laneName = lane.name;
    record.snapshot.branchRef = lane.branchRef;
    record.snapshot.worktreePath = lane.worktreePath ?? null;
    record.snapshot.baseRef ??= lane.baseRef ?? null;
  };

  const runCheckoutStage = async (record: LaunchRecord, baseRef: string | null): Promise<void> => {
    const runtime = runtimeFor(record.snapshot.launchId);
    const interrupted = findInterruptedLane(record);
    if (interrupted) {
      adoptLane(record, interrupted);
      setStage(record, "checkout", "done", { percent: 100, detail: "Recovered after restart" });
      publish(record);
      assertActive(record);
      startLaneNaming(record, interrupted);
      return;
    }
    if (record.checkoutAttempted && deps.laneService.cleanupReservedWorktree) {
      // An earlier attempt (failed, or killed by a restart) may have left a
      // worktree at the reserved path; every retry would fail on it.
      await deps.laneService.cleanupReservedWorktree({ laneId: record.snapshot.laneId, name: record.snapshot.laneName });
      assertActive(record);
    }
    record.checkoutAttempted = true;
    setStage(record, "checkout", "running");
    publish(record);
    let totalFiles = 0;
    const lane = await deps.laneService.create(
      {
        name: record.snapshot.laneName,
        branchName: temporaryAutoLaneBranch(),
        ...(baseRef ? { baseBranch: baseRef } : {}),
      },
      {
        laneId: record.snapshot.laneId,
        signal: runtime.abort.signal,
        onCheckoutProgress: (progress) => {
          const stage = stageOf(record, "checkout");
          if (!stage || stage.status !== "running") return;
          if (stage.percent === progress.percent) return;
          stage.percent = progress.percent;
          totalFiles = progress.total;
          publishProgress(record);
        },
      },
    );
    adoptLane(record, lane);
    if (runtime.progressTimer) {
      clearTimeout(runtime.progressTimer);
      runtime.progressTimer = null;
    }
    setStage(record, "checkout", "done", {
      percent: 100,
      detail: totalFiles > 0 ? `${totalFiles.toLocaleString("en-US")} files` : null,
    });
    publish(record);
    // A cancel that raced the checkout's last moments still owns this lane.
    assertActive(record);
    startLaneNaming(record, lane);
  };

  /** Resolves when the environment settles (ok or failed); never throws. */
  const runEnvironmentStage = async (record: LaunchRecord): Promise<EnvironmentOutcome> => {
    const laneId = record.snapshot.laneId;
    setStage(record, "environment", "running", { detail: record.snapshot.templateName, steps: [] });
    publish(record, { persist: false });
    const unsubscribe = deps.onEnvironmentEvent((event) => {
      if (event.progress.laneId !== laneId) return;
      const stage = stageOf(record, "environment");
      if (!stage || stage.status !== "running") return;
      stage.steps = event.progress.steps.map((step) => ({ ...step }));
      publish(record, { persist: false });
    });
    try {
      const progress = await deps.runEnvironment({ laneId, templateId: record.templateId });
      if (record.snapshot.phase === "cancelled") return "failed";
      if (progress.steps.length === 0) {
        record.snapshot.stages = record.snapshot.stages.filter((stage) => stage.id !== "environment");
        publish(record);
        return "empty";
      }
      if (progress.overallStatus === "failed") {
        const failedStep = progress.steps.find((step) => step.status === "failed");
        const message = failedStep ? `${failedStep.label}: ${failedStep.error ?? "failed"}` : "Lane environment setup failed.";
        setStage(record, "environment", "failed", { steps: progress.steps.map((step) => ({ ...step })), error: message });
        return "failed";
      }
      setStage(record, "environment", "done", { steps: progress.steps.map((step) => ({ ...step })) });
      publish(record);
      return "ok";
    } catch (error) {
      if (record.snapshot.phase === "cancelled") return "failed";
      setStage(record, "environment", "failed", { error: getErrorMessage(error) });
      return "failed";
    } finally {
      unsubscribe();
    }
  };

  /** One environment run per launch, however often the pipeline re-enters (Start now, then Retry). */
  const ensureEnvironment = (record: LaunchRecord): Promise<EnvironmentOutcome> => {
    const runtime = runtimeFor(record.snapshot.launchId);
    if (!runtime.environment) {
      const run = runEnvironmentStage(record);
      runtime.environment = run;
      void run.finally(() => {
        if (runtime.environment === run) runtime.environment = null;
      });
    }
    return runtime.environment;
  };

  const sendChatMessage = (
    sessionId: string,
    message: Pick<ChatLaunchQueueMessageArgs, "text" | "displayText" | "attachments">,
  ): Promise<unknown> => deps.agentChatService.sendMessage(
    {
      sessionId,
      text: message.text,
      ...(message.displayText ? { displayText: message.displayText } : {}),
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    },
    { awaitDispatch: false, routeActiveToSteer: true },
  );

  /**
   * Deliver queued messages in order. A failed send keeps the message (with
   * `deliveryError` set so clients can show it), stops the queue so order is
   * preserved, and retries on a bounded backoff — and again on every
   * queueMessage. Messages are never dropped.
   */
  const deliverQueuedMessages = (record: LaunchRecord): Promise<void> => {
    const runtime = runtimeFor(record.snapshot.launchId);
    if (runtime.delivery) return runtime.delivery;
    if (runtime.deliveryTimer) {
      clearTimeout(runtime.deliveryTimer);
      runtime.deliveryTimer = null;
    }
    const run = (async () => {
      const sessionId = record.snapshot.sessionId;
      if (!sessionId) return;
      while (record.snapshot.queuedMessages.length > 0 && record.snapshot.phase !== "cancelled" && !disposed) {
        const next = record.snapshot.queuedMessages[0]!;
        try {
          await sendChatMessage(sessionId, next);
        } catch (error) {
          const message = getErrorMessage(error);
          logger.warn("chat_launch.queued_message_failed", { launchId: record.snapshot.launchId, attempt: runtime.deliveryAttempts, error: message });
          if (CHAT_SESSION_GONE_PATTERN.test(message)) {
            // The chat itself is gone (deleted after it started): nothing can
            // ever deliver these, so say so once and let the launch expire
            // instead of pinning it and every later send behind a dead head.
            const undelivered = record.snapshot.queuedMessages.length;
            record.snapshot.queuedMessages = [];
            record.snapshot.error = `The chat was deleted before ${undelivered === 1 ? "a queued message" : `${undelivered} queued messages`} could be sent.`;
            publish(record);
            return;
          }
          next.deliveryError = message;
          publish(record);
          const backoff = QUEUED_DELIVERY_BACKOFF_MS[runtime.deliveryAttempts];
          runtime.deliveryAttempts += 1;
          if (backoff != null && !disposed) {
            runtime.deliveryTimer = setTimeout(() => {
              runtime.deliveryTimer = null;
              void deliverQueuedMessages(record);
            }, backoff);
            runtime.deliveryTimer.unref?.();
          }
          return;
        }
        runtime.deliveryAttempts = 0;
        record.snapshot.queuedMessages.shift();
        publish(record);
      }
    })();
    runtime.delivery = run;
    void run.finally(() => {
      if (runtime.delivery === run) runtime.delivery = null;
    });
    return run;
  };

  const runChatAgentStage = async (record: LaunchRecord): Promise<void> => {
    const chat = record.chat;
    if (!chat) throw new Error("Chat launch is missing its chat arguments.");
    setStage(record, "agent", "running");
    publish(record, { persist: false });
    const sessionId = record.snapshot.launchId;
    if (!record.snapshot.sessionCreated) {
      await deps.agentChatService.createSession({
        ...chat.create,
        laneId: record.snapshot.laneId,
        sessionId,
      });
      record.snapshot.sessionCreated = true;
      record.snapshot.sessionId = sessionId;
      publish(record);
    }
    assertActive(record);
    if (!record.messageSent) {
      transcriptCard.arm(record);
      await deps.agentChatService.sendMessage({ ...chat.message, sessionId });
      record.messageSent = true;
    }
    record.snapshot.agentStarted = true;
    setStage(record, "agent", "done");
    publish(record);
    await deliverQueuedMessages(record);
  };

  /** Complete the launch once the agent runs and no stage is still open. Returns whether it did. */
  const finishIfSettled = (record: LaunchRecord): boolean => {
    const snapshot = record.snapshot;
    if (snapshot.phase !== "running" || !snapshot.agentStarted) return false;
    if (snapshot.stages.some((stage) => stage.status === "pending" || stage.status === "running")) return false;
    snapshot.phase = "completed";
    snapshot.endedAt = nowIso();
    publish(record);
    return true;
  };

  /**
   * The pipeline. Re-entrant by design: every stage checks what already
   * happened, so Retry simply runs it again from the first unfinished stage.
   */
  const runPipelineOnce = async (record: LaunchRecord): Promise<void> => {
    const launchId = record.snapshot.launchId;
    const runtime = runtimeFor(launchId);
    let activeStage: ChatLaunchStageId = "fetch";
    try {
      record.snapshot.phase = "running";
      record.snapshot.error = null;
      if (!record.snapshot.laneCreated) {
        activeStage = "fetch";
        const baseRef = await runFetchStage(record);
        assertActive(record);
        activeStage = "checkout";
        await runCheckoutStage(record, baseRef);
      }
      assertActive(record);

      const environment = stageOf(record, "environment");
      let environmentDone: Promise<EnvironmentOutcome> | null = null;
      if (environment && (environment.status === "pending" || environment.status === "running")) {
        activeStage = "environment";
        environmentDone = ensureEnvironment(record);
        const startNow = new Promise<"start-now">((resolve) => {
          runtime.startNow = () => resolve("start-now");
          if (record.startNowRequested) resolve("start-now");
        });
        const first = await Promise.race([environmentDone, startNow]);
        runtime.startNow = null;
        assertActive(record);
        if (first === "failed") {
          record.snapshot.phase = "failed";
          record.snapshot.error = stageOf(record, "environment")?.error ?? "Lane environment setup failed.";
          publish(record);
          return;
        }
      }

      activeStage = "agent";
      if (record.snapshot.kind === "chat") {
        await runChatAgentStage(record);
      } else if (!record.snapshot.agentStarted) {
        setStage(record, "agent", "running");
        record.snapshot.phase = "awaiting-client";
        publish(record);
      }

      if (environmentDone) {
        // Started early (Start now): the environment keeps running and its
        // outcome still lands on the card, but it no longer gates anything.
        void environmentDone.then((outcome) => {
          const current = records.get(launchId);
          if (!current || current.snapshot.phase === "cancelled") return;
          if (outcome === "failed") current.snapshot.error = stageOf(current, "environment")?.error ?? null;
          if (!finishIfSettled(current) && outcome === "failed") publish(current);
        });
      }
      finishIfSettled(record);
    } catch (error) {
      if (error instanceof LaunchCancelledError || record.snapshot.phase === "cancelled") return;
      const message = getErrorMessage(error);
      logger.warn("chat_launch.stage_failed", { launchId, stage: activeStage, error: message });
      failLaunch(record, activeStage, message);
    }
  };

  const runPipeline = (record: LaunchRecord): Promise<void> => {
    const runtime = runtimeFor(record.snapshot.launchId);
    if (runtime.pipeline) return runtime.pipeline;
    const run = runPipelineOnce(record);
    runtime.pipeline = run;
    void run.finally(() => {
      if (runtime.pipeline === run) runtime.pipeline = null;
    });
    return run;
  };

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const start = async (args: ChatLaunchArgs): Promise<ChatLaunchSnapshot> => {
    if (disposed) throw new Error("Chat launch service is shutting down.");
    const launchId = requireLaunchId(args?.launchId);
    const existing = records.get(launchId);
    if (existing) return cloneSnapshot(existing.snapshot);

    const kind = args.kind === "cli" ? "cli" : "chat";
    let chat: ChatLaunchChatArgs | null = null;
    if (kind === "chat") {
      // Untrusted payloads were already parsed by `parseChatLaunchArgs` (chatLaunchArgs.ts).
      if (!args.chat) throw new Error("A chat launch needs its chat create and message arguments.");
      chat = args.chat;
      if (deps.resolveChatCreate) chat = { ...chat, create: await deps.resolveChatCreate(chat.create) };
      // Idempotent even across the model lookup above.
      const raced = records.get(launchId);
      if (raced) return cloneSnapshot(raced.snapshot);
    }
    const laneId = args.laneId?.trim() ? requireNormalizedUuid(args.laneId, "laneId must be a UUID.") : randomUUID();
    const prompt = String(args.prompt ?? "");
    const laneName = args.laneName?.trim()
      || deriveDeterministicLaneTitleFromPrompt(prompt)
      || deriveDeterministicLaneNameFromPrompt(prompt, { genericSuffix: autoLaneGenericSuffix(now()) });
    const baseBranch = args.baseBranch?.trim() || null;
    const environment = deps.planEnvironment();
    const snapshot = createChatLaunchSnapshot({
      launch: { ...args, launchId, kind, ...(chat ? { chat } : {}) },
      laneId,
      laneName,
      includeFetch: !baseBranch && !deps.usesLocalLaneBase(),
      includeEnvironment: environment.hasEnvironment,
      templateName: environment.templateName,
      nowIso: nowIso(),
    });
    const record: LaunchRecord = {
      snapshot,
      chat,
      baseBranch,
      provider: args.provider ?? chat?.create.provider ?? null,
      templateId: environment.templateId,
      messageSent: false,
      startNowRequested: false,
      checkoutAttempted: false,
    };
    records.set(launchId, record);
    publish(record);
    logger.info("chat_launch.started", { launchId, kind, laneId, stages: snapshot.stages.map((stage) => stage.id) });
    void runPipeline(record);
    return cloneSnapshot(record.snapshot);
  };

  const get = (args: ChatLaunchIdArgs): ChatLaunchSnapshot | null => {
    const record = records.get(requireLaunchId(args?.launchId));
    return record ? cloneSnapshot(record.snapshot) : null;
  };

  const list = (): ChatLaunchSnapshot[] =>
    [...records.values()]
      .map((record) => cloneSnapshot(record.snapshot))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  /** Delete whatever a cancelled launch created. Flags flip only once their deletion succeeded. */
  const cleanupCancelled = async (record: LaunchRecord): Promise<string[]> => {
    const failures: string[] = [];
    const sessionId = record.snapshot.sessionId;
    if (record.snapshot.sessionCreated && sessionId) {
      try {
        await deps.agentChatService.deleteSession({ sessionId });
        record.snapshot.sessionCreated = false;
      } catch (error) {
        failures.push(`chat: ${getErrorMessage(error)}`);
      }
    }
    // A lane whose create inserted its row but never returned (restart
    // mid-checkout) is this launch's too, even though laneCreated is false.
    if (record.snapshot.laneCreated || findInterruptedLane(record)) {
      try {
        await deps.laneService.delete({
          laneId: record.snapshot.laneId,
          force: true,
          deleteBranch: true,
          deleteRemoteBranch: true,
          requireRemoteBranchDelete: false,
        });
        record.snapshot.laneCreated = false;
      } catch (error) {
        failures.push(`lane: ${getErrorMessage(error)}`);
      }
    }
    if (failures.length) {
      logger.error("chat_launch.cancel_cleanup_incomplete", { launchId: record.snapshot.launchId, failures });
    }
    return failures;
  };

  const cancel = async (args: ChatLaunchIdArgs): Promise<ChatLaunchSnapshot | null> => {
    const launchId = requireLaunchId(args?.launchId);
    const record = records.get(launchId);
    if (!record) return null;
    if (record.snapshot.phase === "cancelled") return cloneSnapshot(record.snapshot);
    if (record.snapshot.agentStarted || record.snapshot.phase === "completed") {
      throw new Error(CHAT_LAUNCH_ALREADY_STARTED_ERROR);
    }
    const runtime = runtimeFor(launchId);
    const pipeline = runtime.pipeline;
    record.snapshot.phase = "cancelled";
    record.snapshot.error = null;
    // Messages queued for a chat that will never exist have nowhere to go.
    record.snapshot.queuedMessages = [];
    runtime.abort.abort();
    runtime.startNow?.();
    if (runtime.deliveryTimer) clearTimeout(runtime.deliveryTimer);
    runtime.deliveryTimer = null;
    if (record.snapshot.laneCreated) {
      try {
        deps.abortEnvironment?.({ laneId: record.snapshot.laneId, worktreePath: record.snapshot.worktreePath });
      } catch (error) {
        logger.warn("chat_launch.abort_environment_failed", { launchId, error: getErrorMessage(error) });
      }
    }
    for (const stage of record.snapshot.stages) {
      if (stage.status === "running" || stage.status === "pending") {
        stage.status = "skipped";
        stage.endedAt = nowIso();
      }
    }
    publish(record);
    // Give an in-flight checkout a beat to observe the abort and clean up its
    // own half-written worktree before the lane is deleted underneath it.
    let pipelineSettled = !pipeline;
    if (pipeline) {
      await Promise.race([pipeline.then(() => { pipelineSettled = true; }), delay(CANCEL_PIPELINE_WAIT_MS)]);
    }
    const failures = await cleanupCancelled(record);
    record.snapshot.error = failures.length ? `Cleanup incomplete — ${failures.join("; ")}` : null;
    record.snapshot.endedAt = nowIso();
    publish(record);
    if (!pipelineSettled && pipeline) {
      // The pipeline outlived the wait; whatever it creates from here on (a
      // lane whose checkout finished, a chat) is still this cancel's to delete.
      void pipeline.then(async () => {
        if (!record.snapshot.laneCreated && !record.snapshot.sessionCreated) return;
        const late = await cleanupCancelled(record);
        record.snapshot.error = late.length ? `Cleanup incomplete — ${late.join("; ")}` : null;
        publish(record);
      });
    }
    logger.info("chat_launch.cancelled", { launchId });
    return cloneSnapshot(record.snapshot);
  };

  const retry = async (args: ChatLaunchIdArgs): Promise<ChatLaunchSnapshot | null> => {
    const record = records.get(requireLaunchId(args?.launchId));
    if (!record) return null;
    if (record.snapshot.phase !== "failed") return cloneSnapshot(record.snapshot);
    const runtime = runtimeFor(record.snapshot.launchId);
    if (runtime.abort.signal.aborted) runtime.abort = new AbortController();
    for (const stage of record.snapshot.stages) {
      if (stage.status === "failed") setStage(record, stage.id, "pending");
    }
    if (record.snapshot.kind === "cli" && record.snapshot.laneCreated) {
      // The lane is fine; hand the CLI start back to the launching client.
      const environment = stageOf(record, "environment");
      if (!environment || environment.status === "done" || environment.status === "skipped") {
        setStage(record, "agent", "running");
        record.snapshot.phase = "awaiting-client";
        record.snapshot.error = null;
        publish(record);
        return cloneSnapshot(record.snapshot);
      }
    }
    record.snapshot.phase = "running";
    record.snapshot.error = null;
    publish(record);
    void runPipeline(record);
    return cloneSnapshot(record.snapshot);
  };

  const startNow = async (args: ChatLaunchIdArgs): Promise<ChatLaunchSnapshot | null> => {
    const record = records.get(requireLaunchId(args?.launchId));
    if (!record) return null;
    const environment = stageOf(record, "environment");
    if (!record.snapshot.laneCreated || !environment) return cloneSnapshot(record.snapshot);
    record.startNowRequested = true;
    const runtime = runtimeFor(record.snapshot.launchId);
    if (record.snapshot.phase === "running" && environment.status === "running") {
      runtime.startNow?.();
      return cloneSnapshot(record.snapshot);
    }
    if (record.snapshot.phase === "failed" && environment.status === "failed") {
      // "Start anyway": keep the failed step visible, move on to the agent.
      setStage(record, "environment", "warning", { detail: environment.error ?? "Setup failed; started anyway" });
      record.snapshot.phase = "running";
      record.snapshot.error = null;
      publish(record);
      void runPipeline(record);
    }
    return cloneSnapshot(record.snapshot);
  };

  const queueMessage = async (args: ChatLaunchQueueMessageArgs): Promise<ChatLaunchSnapshot> => {
    const launchId = requireLaunchId(args?.launchId);
    const record = records.get(launchId);
    // Throw rather than return null: a caller holding a message must never
    // mistake "no such launch" for "queued".
    if (!record) throw new Error(`Launch not found: ${launchId}`);
    const text = String(args.text ?? "");
    if (!text.trim() && !args.attachments?.length) throw new Error("A queued message needs text or an attachment.");
    if (record.snapshot.phase === "cancelled") throw new Error("This launch was cancelled.");
    const delivering = record.snapshot.agentStarted && Boolean(record.snapshot.sessionId);
    if (delivering && record.snapshot.queuedMessages.length === 0) {
      // Too late to queue here and nothing waits ahead of it: a normal send.
      await sendChatMessage(record.snapshot.sessionId!, { ...args, text });
      return cloneSnapshot(record.snapshot);
    }
    if (record.snapshot.queuedMessages.length >= MAX_QUEUED_MESSAGES) {
      throw new Error(`At most ${MAX_QUEUED_MESSAGES} messages can wait for the lane.`);
    }
    record.snapshot.queuedMessages.push(toQueuedMessage({ ...args, text }, { id: randomUUID(), createdAt: nowIso() }));
    publish(record);
    if (delivering) {
      // Earlier messages failed to deliver: this one waits behind them, and
      // the user acting again is the cue to retry them all now.
      runtimeFor(record.snapshot.launchId).deliveryAttempts = 0;
      await deliverQueuedMessages(record);
    }
    return cloneSnapshot(record.snapshot);
  };

  const completeClient = async (args: ChatLaunchCompleteClientArgs): Promise<ChatLaunchSnapshot | null> => {
    const record = records.get(requireLaunchId(args?.launchId));
    if (!record) return null;
    if (record.snapshot.kind !== "cli" || record.snapshot.phase !== "awaiting-client") {
      return cloneSnapshot(record.snapshot);
    }
    const error = args.error?.trim();
    if (error) {
      failLaunch(record, "agent", error);
      return cloneSnapshot(record.snapshot);
    }
    record.snapshot.sessionId = args.sessionId?.trim() || null;
    record.snapshot.sessionCreated = Boolean(record.snapshot.sessionId);
    record.snapshot.agentStarted = true;
    setStage(record, "agent", "done");
    record.snapshot.phase = "running";
    publish(record);
    finishIfSettled(record);
    return cloneSnapshot(record.snapshot);
  };

  const disposeRuntime = (launchId: string): void => {
    const runtime = runtimes.get(launchId);
    if (!runtime) return;
    if (runtime.cardTimer) clearTimeout(runtime.cardTimer);
    if (runtime.expiryTimer) clearTimeout(runtime.expiryTimer);
    if (runtime.progressTimer) clearTimeout(runtime.progressTimer);
    if (runtime.deliveryTimer) clearTimeout(runtime.deliveryTimer);
    runtime.unsubscribeChat?.();
    runtimes.delete(launchId);
  };

  const dispose = (): void => {
    disposed = true;
    for (const [launchId, runtime] of runtimes) {
      runtime.abort.abort();
      disposeRuntime(launchId);
    }
  };

  for (const record of store.loadAll(nowIso())) {
    records.set(record.snapshot.launchId, record);
    // A completed launch reloaded with undelivered queued messages resumes delivery.
    if (record.snapshot.phase === "completed") void deliverQueuedMessages(record);
  }

  const subscribe = (listener: (event: ChatLaunchEvent) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    start,
    get,
    list,
    cancel,
    retry,
    startNow,
    queueMessage,
    completeClient,
    subscribe,
    dispose,
  };
}

export type ChatLaunchService = ReturnType<typeof createChatLaunchService>;
