/**
 * workerDeliveryService.ts
 *
 * Worker message delivery: readWorkerDeliveryMetadata, resolveWorkerDeliveryContext,
 * deliverWorkerMessage, replayQueuedWorkerMessages, routeMessageToCoordinator,
 * routeMessageToWorker, and supporting delivery pipeline functions.
 *
 * Extracted from aiOrchestratorService.ts — pure refactor, no behavior changes.
 */

import type {
  OrchestratorContext,
  WorkerDeliveryContext,
  WorkerDeliverySessionResolution,
  AgentChatSessionSummaryEntry,
} from "./orchestratorContext";
import {
  nowIso,
  isRecord,
  toOptionalString,
  clipTextForContext,
  missionThreadId,
  parseWorkerProviderHint,
  WORKER_MESSAGE_RETRY_BUDGET,
  WORKER_MESSAGE_RETRY_INTERVENTION_COOLDOWN_MS,
  WORKER_MESSAGE_INFLIGHT_LEASE_MS,
  WORKER_MESSAGE_INFLIGHT_STALE_FAIL_MS,
  DEFAULT_CHAT_VISIBILITY,
  DEFAULT_WORKER_CHAT_VISIBILITY,
} from "./orchestratorContext";
import {
  emitThreadEvent,
  getThreadById,
  updateChatMessage,
  getChatMessageById,
  parseChatMessageRow,
  emitOrchestratorMessage,
  formatRecentChatContext,
  summarizeRunForChat,
} from "./chatMessageService";
import type { ChatMessageRow } from "./chatMessageService";
import {
  normalizeDeliveryError,
  isBusyDeliveryError,
  isNoActiveTurnError,
  computeWorkerRetryBackoffMs,
} from "./chatMessageService";
import {
  getTrackedSessionState,
} from "./recoveryService";
import { getErrorMessage } from "../shared/utils";
import type {
  OrchestratorChatMessage,
  OrchestratorChatTarget,
  OrchestratorChatDeliveryState,
  OrchestratorExecutorKind,
  SendOrchestratorChatArgs,
} from "../../../shared/types";

// ── Deps types for functions that need access to unextracted closure functions ──

export type WorkerDeliveryDeps = {
  appendChatMessage: (message: OrchestratorChatMessage) => OrchestratorChatMessage;
  recordRuntimeEvent: (...args: any[]) => void;
};

export type RouteToCoordinatorDeps = WorkerDeliveryDeps & {
  steerMission: (...args: any[]) => any;
  enqueueChatResponse: (chatArgs: SendOrchestratorChatArgs, recentChatContext: string) => void;
  runHealthSweep: (reason: string) => Promise<{ sweeps: number; staleRecovered: number }>;
};

export type WorkerSessionDeliveryStatus =
  | { ok: true; delivered: true; method: "send" | "steer" }
  | { ok: true; delivered: false; method: "steer"; reason: "worker_busy_steered" }
  | { ok: false; delivered: false; reason: "no_active_session" | "delivery_failed"; error?: string };

function isCoordinatorStatusQuery(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized.length) return false;

  if (/^(status|progress|heartbeat|what'?s happening|what is happening)$/i.test(normalized)) {
    return true;
  }

  const statusTerms = /\b(status|progress|stuck|heartbeat|doing|working on|worker|agent|lane|phase|running)\b/i;
  if (!statusTerms.test(normalized)) return false;

  // Imperative status requests like "status update please", "give me a status update"
  const imperativeStatusRequest =
    /\b(status\s+update|progress\s+update|status\s+report|progress\s+report|give\s+.*(status|progress|update))\b/i;
  if (imperativeStatusRequest.test(normalized)) return true;

  const questionLead =
    /^(what|what's|what is|how|how's|how is|where|where's|where is|which|who|when|why|are|is|do|does|did|can|could|would|will)\b/i;
  const looksLikeQuestion = normalized.includes("?") || questionLead.test(normalized);
  if (!looksLikeQuestion) return false;

  const directiveLead =
    /^(please\s+)?(tell|ask|send|pause|stop|cancel|retry|resume|spawn|create|change|fix|update|switch|use|move|delegate|start|finish|mark|set)\b/i;
  const explicitWorkerCommand = /\b(tell|ask|send)\s+(the\s+)?(worker|agent|coordinator)\b/i;
  return !directiveLead.test(normalized) && !explicitWorkerCommand.test(normalized);
}

function buildCoordinatorStatusReply(
  ctx: OrchestratorContext,
  missionId: string,
  content: string,
): string {
  const runs = ctx.orchestratorService.listRuns({ missionId });
  if (!runs.length) return "No run has started yet.";
  const byCreatedDesc = [...runs].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const targetRun = byCreatedDesc.find((entry) =>
    entry.status === "active" || entry.status === "bootstrapping" || entry.status === "queued" || entry.status === "paused"
  ) ?? byCreatedDesc[0] ?? null;
  if (!targetRun) return "No run has started yet.";

  try {
    const graph = ctx.orchestratorService.getRunGraph({ runId: targetRun.id, timelineLimit: 0 });
    const normalizedContent = content.trim().toLowerCase();
    const runningSteps = graph.steps.filter((step) => step.status === "running");
    const targetStep =
      graph.steps.find((step) => {
        const title = (step.title ?? "").trim().toLowerCase();
        const stepKey = (step.stepKey ?? "").trim().toLowerCase();
        return (title.length > 0 && normalizedContent.includes(title)) || (stepKey.length > 0 && normalizedContent.includes(stepKey));
      })
      ?? (runningSteps.length === 1 ? runningSteps[0] : null);

    if (!targetStep) {
      return summarizeRunForChat(ctx, missionId);
    }

    const latestAttempt = graph.attempts
      .filter((attempt) => attempt.stepId === targetStep.id)
      .sort((left, right) => {
        const leftTs = Date.parse(left.startedAt ?? left.createdAt);
        const rightTs = Date.parse(right.startedAt ?? right.createdAt);
        return rightTs - leftTs;
      })[0] ?? null;
    const sessionSignal =
      latestAttempt?.executorSessionId ? ctx.sessionRuntimeSignals.get(latestAttempt.executorSessionId) ?? null : null;
    const workerLabel = targetStep.title?.trim().length ? targetStep.title.trim() : targetStep.stepKey;
    const startedAtMs = Date.parse(latestAttempt?.startedAt ?? latestAttempt?.createdAt ?? "");
    const elapsedSeconds = Number.isFinite(startedAtMs)
      ? Math.max(0, Math.round((Date.now() - startedAtMs) / 1000))
      : null;
    const latestSignal = sessionSignal?.lastOutputPreview?.trim().length
      ? sessionSignal.lastOutputPreview.trim()
      : latestAttempt?.resultEnvelope?.summary?.trim().length
        ? latestAttempt.resultEnvelope.summary.trim()
        : null;
    const signalState = sessionSignal?.runtimeState ?? (latestAttempt?.status === "running" ? "running" : null);

    return [
      `${workerLabel} (${targetStep.stepKey}) is ${targetStep.status}.`,
      signalState ? `Runtime state: ${signalState}.` : null,
      elapsedSeconds != null ? `Elapsed: ${elapsedSeconds}s.` : null,
      latestSignal ? `Latest signal: ${clipTextForContext(latestSignal, 220)}.` : null,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join(" ");
  } catch {
    return summarizeRunForChat(ctx, missionId);
  }
}

// ── readWorkerDeliveryMetadata ──────────────────────────────────

export function readWorkerDeliveryMetadataCtx(
  _ctx: OrchestratorContext,
  message: OrchestratorChatMessage
): {
  metadata: Record<string, unknown>;
  workerDelivery: Record<string, unknown>;
  retries: number;
  maxRetries: number;
  nextRetryAtMs: number | null;
  interventionId: string | null;
  agentSessionId: string | null;
  inFlightAttemptId: string | null;
  inFlightAtMs: number | null;
  inFlightSessionId: string | null;
} {
  const metadata = isRecord(message.metadata) ? { ...message.metadata } : {};
  const workerDelivery = isRecord(metadata.workerDelivery) ? { ...(metadata.workerDelivery as Record<string, unknown>) } : {};
  const retries = Number.isFinite(Number(workerDelivery.retries))
    ? Math.max(0, Math.floor(Number(workerDelivery.retries)))
    : 0;
  const maxRetries = Number.isFinite(Number(workerDelivery.maxRetries))
    ? Math.max(1, Math.floor(Number(workerDelivery.maxRetries)))
    : WORKER_MESSAGE_RETRY_BUDGET;
  const nextRetryAtRaw = typeof workerDelivery.nextRetryAt === "string" ? workerDelivery.nextRetryAt : "";
  const parsedNextRetryAt = nextRetryAtRaw ? Date.parse(nextRetryAtRaw) : Number.NaN;
  const interventionId = typeof workerDelivery.interventionId === "string" && workerDelivery.interventionId.trim().length > 0
    ? workerDelivery.interventionId.trim()
    : null;
  const agentSessionId = typeof workerDelivery.agentSessionId === "string" && workerDelivery.agentSessionId.trim().length > 0
    ? workerDelivery.agentSessionId.trim()
    : null;
  const inFlightAttemptId = typeof workerDelivery.inFlightAttemptId === "string" && workerDelivery.inFlightAttemptId.trim().length > 0
    ? workerDelivery.inFlightAttemptId.trim()
    : null;
  const inFlightAtRaw = typeof workerDelivery.inFlightAt === "string" ? workerDelivery.inFlightAt : "";
  const parsedInFlightAt = inFlightAtRaw ? Date.parse(inFlightAtRaw) : Number.NaN;
  const inFlightSessionId = typeof workerDelivery.inFlightSessionId === "string" && workerDelivery.inFlightSessionId.trim().length > 0
    ? workerDelivery.inFlightSessionId.trim()
    : null;
  return {
    metadata,
    workerDelivery,
    retries,
    maxRetries,
    nextRetryAtMs: Number.isFinite(parsedNextRetryAt) ? parsedNextRetryAt : null,
    interventionId,
    agentSessionId,
    inFlightAttemptId,
    inFlightAtMs: Number.isFinite(parsedInFlightAt) ? parsedInFlightAt : null,
    inFlightSessionId
  };
}

// ── selectAttemptDeliveryContext ─────────────────────────────────

export function selectAttemptDeliveryContextCtx(
  ctx: OrchestratorContext,
  whereClause: string,
  params: Array<string | null>
): {
  attempt_id: string;
  run_id: string;
  step_id: string;
  step_key: string | null;
  lane_id: string | null;
  session_id: string | null;
  session_status: string | null;
  session_tool_type: string | null;
  executor_kind: string | null;
} | null {
  return ctx.db.get<{
    attempt_id: string;
    run_id: string;
    step_id: string;
    step_key: string | null;
    lane_id: string | null;
    session_id: string | null;
    session_status: string | null;
    session_tool_type: string | null;
    executor_kind: string | null;
  }>(
    `
      select
        a.id as attempt_id,
        a.run_id as run_id,
        a.step_id as step_id,
        s.step_key as step_key,
        s.lane_id as lane_id,
        a.executor_session_id as session_id,
        ts.status as session_status,
        ts.tool_type as session_tool_type,
        a.executor_kind as executor_kind
      from orchestrator_attempts a
      left join orchestrator_steps s on s.id = a.step_id
      left join terminal_sessions ts on ts.id = a.executor_session_id
      where ${whereClause}
      order by
        case a.status
          when 'running' then 0
          when 'queued' then 1
          when 'blocked' then 2
          else 3
        end,
        a.attempt_number desc,
        a.created_at desc
      limit 1
    `,
    params
  );
}

// ── resolveWorkerDeliveryContext ─────────────────────────────────

export function resolveWorkerDeliveryContextCtx(
  ctx: OrchestratorContext,
  message: OrchestratorChatMessage
): WorkerDeliveryContext | null {
  const thread = message.threadId ? getThreadById(ctx, message.missionId, message.threadId) : null;
  const baseTarget = message.target?.kind === "worker"
    ? message.target
    : thread?.threadType === "worker"
      ? {
          kind: "worker" as const,
          runId: thread.runId ?? null,
          stepId: thread.stepId ?? null,
          stepKey: thread.stepKey ?? null,
          attemptId: thread.attemptId ?? null,
          sessionId: thread.sessionId ?? null,
          laneId: thread.laneId ?? null
        }
      : null;
  if (!baseTarget) return null;

  const attemptCandidates = [
    toOptionalString(baseTarget.attemptId),
    toOptionalString(message.attemptId),
    toOptionalString(thread?.attemptId)
  ].filter((value): value is string => !!value);
  let attemptContext: ReturnType<typeof selectAttemptDeliveryContextCtx> = null;
  for (const attemptId of attemptCandidates) {
    attemptContext = selectAttemptDeliveryContextCtx(ctx, `a.id = ?`, [attemptId]);
    if (attemptContext) break;
  }

  const sessionCandidates = [
    toOptionalString(baseTarget.sessionId),
    toOptionalString(message.sourceSessionId),
    toOptionalString(thread?.sessionId)
  ].filter((value): value is string => !!value);
  if (!attemptContext) {
    for (const sessionId of sessionCandidates) {
      attemptContext = selectAttemptDeliveryContextCtx(ctx, `a.executor_session_id = ?`, [sessionId]);
      if (attemptContext) break;
    }
  }
  if (!attemptContext) {
    const runId = toOptionalString(baseTarget.runId) ?? toOptionalString(thread?.runId) ?? toOptionalString(message.runId);
    const stepId = toOptionalString(baseTarget.stepId) ?? toOptionalString(thread?.stepId);
    if (runId && stepId) {
      attemptContext = selectAttemptDeliveryContextCtx(ctx, `a.run_id = ? and a.step_id = ?`, [runId, stepId]);
    }
    if (!attemptContext && runId) {
      const stepKey = toOptionalString(baseTarget.stepKey) ?? toOptionalString(thread?.stepKey) ?? toOptionalString(message.stepKey);
      if (stepKey) {
        attemptContext = selectAttemptDeliveryContextCtx(ctx, `a.run_id = ? and s.step_key = ?`, [runId, stepKey]);
      }
    }
  }
  if (!attemptContext) {
    const laneId = toOptionalString(baseTarget.laneId) ?? toOptionalString(thread?.laneId) ?? toOptionalString(message.laneId);
    if (laneId) {
      attemptContext = selectAttemptDeliveryContextCtx(ctx, `s.lane_id = ? and a.executor_session_id is not null`, [laneId]);
    }
  }

  const runId =
    toOptionalString(baseTarget.runId)
    ?? toOptionalString(thread?.runId)
    ?? toOptionalString(message.runId)
    ?? toOptionalString(attemptContext?.run_id)
    ?? null;
  const stepId =
    toOptionalString(baseTarget.stepId)
    ?? toOptionalString(thread?.stepId)
    ?? toOptionalString(attemptContext?.step_id)
    ?? null;
  const stepKey =
    toOptionalString(baseTarget.stepKey)
    ?? toOptionalString(thread?.stepKey)
    ?? toOptionalString(message.stepKey)
    ?? toOptionalString(attemptContext?.step_key)
    ?? null;
  const attemptId =
    toOptionalString(baseTarget.attemptId)
    ?? toOptionalString(message.attemptId)
    ?? toOptionalString(thread?.attemptId)
    ?? toOptionalString(attemptContext?.attempt_id)
    ?? null;
  const laneId =
    toOptionalString(baseTarget.laneId)
    ?? toOptionalString(thread?.laneId)
    ?? toOptionalString(message.laneId)
    ?? toOptionalString(attemptContext?.lane_id)
    ?? null;
  const sessionId =
    toOptionalString(baseTarget.sessionId)
    ?? toOptionalString(message.sourceSessionId)
    ?? toOptionalString(thread?.sessionId)
    ?? toOptionalString(attemptContext?.session_id)
    ?? null;
  const sessionStatusFromDb = toOptionalString(attemptContext?.session_status)?.toLowerCase() ?? null;
  const trackedSessionStatus = sessionId
    ? toOptionalString(getTrackedSessionState(ctx, sessionId)?.status)?.toLowerCase() ?? null
    : null;
  const sessionStatus = sessionStatusFromDb ?? trackedSessionStatus;
  const sessionToolType = toOptionalString(attemptContext?.session_tool_type) ?? null;
  const executorKindRaw = toOptionalString(attemptContext?.executor_kind);
  const executorKind: OrchestratorExecutorKind | null =
    executorKindRaw === "unified" || executorKindRaw === "shell" || executorKindRaw === "manual"
      ? executorKindRaw
      : null;
  const resolvedTarget: Extract<OrchestratorChatTarget, { kind: "worker" }> = {
    kind: "worker",
    runId,
    stepId,
    stepKey,
    attemptId,
    sessionId,
    laneId
  };
  return {
    missionId: message.missionId,
    threadId: message.threadId ?? missionThreadId(message.missionId),
    target: resolvedTarget,
    runId,
    stepId,
    stepKey,
    attemptId,
    laneId,
    sessionId,
    sessionStatus,
    sessionToolType,
    executorKind
  };
}

// ── persistThreadWorkerLinks ────────────────────────────────────

export function persistThreadWorkerLinksCtx(
  ctx: OrchestratorContext,
  context: WorkerDeliveryContext
): void {
  ctx.db.run(
    `
      update orchestrator_chat_threads
      set
        run_id = coalesce(?, run_id),
        step_id = coalesce(?, step_id),
        step_key = coalesce(?, step_key),
        attempt_id = coalesce(?, attempt_id),
        session_id = coalesce(?, session_id),
        lane_id = coalesce(?, lane_id),
        updated_at = ?
      where mission_id = ?
        and id = ?
    `,
    [
      context.runId,
      context.stepId,
      context.stepKey,
      context.attemptId,
      context.sessionId,
      context.laneId,
      nowIso(),
      context.missionId,
      context.threadId
    ]
  );
}

// ── upsertWorkerDeliveryIntervention ────────────────────────────

export function upsertWorkerDeliveryInterventionCtx(
  ctx: OrchestratorContext,
  args: {
    message: OrchestratorChatMessage;
    context: WorkerDeliveryContext | null;
    retries: number;
    error: string;
  },
  deps: WorkerDeliveryDeps
): string | null {
  const cooldownKey = args.message.id;
  const nowMs = Date.now();
  const lastMs = ctx.workerDeliveryInterventionCooldowns.get(cooldownKey) ?? 0;
  if (nowMs - lastMs < WORKER_MESSAGE_RETRY_INTERVENTION_COOLDOWN_MS) {
    return null;
  }
  const mission = ctx.missionService.get(args.message.missionId);
  if (!mission) return null;
  if (mission.status === "queued") {
    try {
      ctx.missionService.update({
        missionId: args.message.missionId,
        status: "in_progress"
      });
    } catch (error) {
      ctx.logger.debug("ai_orchestrator.worker_delivery_promote_mission_failed", {
        missionId: args.message.missionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const existing = mission.interventions.find((entry) => {
    if (entry.status !== "open") return false;
    if (!isRecord(entry.metadata)) return false;
    return entry.metadata.sourceMessageId === args.message.id;
  });
  if (existing) {
    ctx.workerDeliveryInterventionCooldowns.set(cooldownKey, nowMs);
    return existing.id;
  }

  const workerLabel =
    toOptionalString(args.context?.stepKey)
    ?? toOptionalString(args.context?.attemptId)
    ?? toOptionalString(args.context?.sessionId)
    ?? "worker";
  const intervention = ctx.missionService.addIntervention({
    missionId: args.message.missionId,
    interventionType: "manual_input",
    title: `Worker delivery blocked: ${workerLabel}`,
    body: `Could not deliver operator guidance to ${workerLabel} after ${args.retries} retries. Latest error: ${args.error}`,
    requestedAction: "Open the worker thread and resend guidance once the worker session is available.",
    laneId: args.context?.laneId ?? args.message.laneId ?? null,
    pauseMission: false,
    metadata: {
      sourceMessageId: args.message.id,
      threadId: args.message.threadId ?? null,
      attemptId: args.context?.attemptId ?? args.message.attemptId ?? null,
      sessionId: args.context?.sessionId ?? args.message.sourceSessionId ?? null,
      runId: args.context?.runId ?? args.message.runId ?? null,
      workerDeliveryFailure: true
    }
  });
  ctx.workerDeliveryInterventionCooldowns.set(cooldownKey, nowMs);
  if (args.context?.runId) {
    deps.recordRuntimeEvent({
      runId: args.context.runId,
      stepId: args.context.stepId,
      attemptId: args.context.attemptId,
      sessionId: args.context.sessionId,
      eventType: "intervention_opened",
      eventKey: `worker_delivery_intervention:${intervention.id}`,
      payload: {
        interventionId: intervention.id,
        sourceMessageId: args.message.id,
        retries: args.retries,
        error: args.error
      }
    });
  }
  emitOrchestratorMessage(
    ctx,
    args.message.missionId,
    `Worker guidance could not be delivered after ${args.retries} retries. I opened intervention "${intervention.title}" so you can recover it deterministically.`,
    args.context?.stepKey ?? args.message.stepKey ?? null,
    {
      sourceMessageId: args.message.id,
      interventionId: intervention.id,
      retries: args.retries
    },
    { appendChatMessage: deps.appendChatMessage }
  );
  return intervention.id;
}

// ── updateWorkerDeliveryState ───────────────────────────────────

export function updateWorkerDeliveryStateCtx(
  ctx: OrchestratorContext,
  args: {
    message: OrchestratorChatMessage;
    context: WorkerDeliveryContext | null;
    state: OrchestratorChatDeliveryState;
    retries: number;
    maxRetries: number;
    error: string | null;
    method: "send" | "steer" | "queued" | "failed";
    nextRetryAt: string | null;
    interventionId?: string | null;
    deliverySessionId?: string | null;
  }
): OrchestratorChatMessage {
  const updated = updateChatMessage(ctx, args.message.id, (current) => {
    const deliveryMeta = readWorkerDeliveryMetadataCtx(ctx, current);
    const metadata = deliveryMeta.metadata;
    metadata.workerDelivery = {
      ...(deliveryMeta.workerDelivery ?? {}),
      retries: args.retries,
      maxRetries: args.maxRetries,
      lastAttemptAt: nowIso(),
      lastMethod: args.method,
      lastError: args.error,
      nextRetryAt: args.nextRetryAt,
      deliveredAt: args.state === "delivered" ? nowIso() : null,
      interventionId: args.interventionId ?? deliveryMeta.interventionId ?? null,
      agentSessionId: args.deliverySessionId ?? deliveryMeta.agentSessionId ?? null,
      inFlightAttemptId: null,
      inFlightAt: null,
      inFlightSessionId: null
    };
    const contextTarget = args.context?.target ?? (current.target?.kind === "worker" ? current.target : null);
    const target =
      contextTarget && contextTarget.kind === "worker"
        ? {
            ...contextTarget,
            sessionId: args.deliverySessionId ?? contextTarget.sessionId ?? null
          }
        : contextTarget;
    return {
      ...current,
      target,
      deliveryState: args.state,
      sourceSessionId: args.deliverySessionId ?? args.context?.sessionId ?? current.sourceSessionId ?? null,
      attemptId: args.context?.attemptId ?? current.attemptId ?? null,
      laneId: args.context?.laneId ?? current.laneId ?? null,
      runId: args.context?.runId ?? current.runId ?? null,
      stepKey: args.context?.stepKey ?? current.stepKey ?? null,
      metadata
    };
  });
  return updated ?? args.message;
}

// ── markWorkerDeliveryInFlight ──────────────────────────────────

export function markWorkerDeliveryInFlightCtx(
  ctx: OrchestratorContext,
  args: {
    message: OrchestratorChatMessage;
    context: WorkerDeliveryContext | null;
    retries: number;
    maxRetries: number;
    deliverySessionId: string;
  }
): OrchestratorChatMessage {
  const inFlightAttemptId = `${args.message.id}:attempt:${args.retries + 1}`;
  const updated = updateChatMessage(ctx, args.message.id, (current) => {
    const deliveryMeta = readWorkerDeliveryMetadataCtx(ctx, current);
    const metadata = deliveryMeta.metadata;
    metadata.workerDelivery = {
      ...(deliveryMeta.workerDelivery ?? {}),
      retries: args.retries,
      maxRetries: args.maxRetries,
      lastAttemptAt: nowIso(),
      lastMethod: "attempt",
      lastError: null,
      nextRetryAt: null,
      deliveredAt: null,
      interventionId: deliveryMeta.interventionId ?? null,
      agentSessionId: args.deliverySessionId,
      inFlightAttemptId,
      inFlightAt: nowIso(),
      inFlightSessionId: args.deliverySessionId
    };
    const contextTarget = args.context?.target ?? (current.target?.kind === "worker" ? current.target : null);
    const target =
      contextTarget && contextTarget.kind === "worker"
        ? {
            ...contextTarget,
            sessionId: args.deliverySessionId
          }
        : contextTarget;
    return {
      ...current,
      target,
      deliveryState: "queued",
      sourceSessionId: args.deliverySessionId,
      attemptId: args.context?.attemptId ?? current.attemptId ?? null,
      laneId: args.context?.laneId ?? current.laneId ?? null,
      runId: args.context?.runId ?? current.runId ?? null,
      stepKey: args.context?.stepKey ?? current.stepKey ?? null,
      metadata
    };
  });
  return updated ?? args.message;
}

// ── failWorkerDeliveryStaleInFlight ─────────────────────────────

export function failWorkerDeliveryStaleInFlightCtx(
  ctx: OrchestratorContext,
  args: {
    message: OrchestratorChatMessage;
    context: WorkerDeliveryContext | null;
    retries: number;
    maxRetries: number;
    ageMs: number;
  },
  deps: WorkerDeliveryDeps
): OrchestratorChatMessage {
  const ageSeconds = Math.max(1, Math.floor(args.ageMs / 1_000));
  const error = `Delivery attempt remained in-flight for ${ageSeconds}s without confirmation; marking failed to avoid duplicate worker injection.`;
  const interventionId = upsertWorkerDeliveryInterventionCtx(
    ctx,
    {
      message: args.message,
      context: args.context,
      retries: Math.max(args.retries, args.maxRetries),
      error
    },
    deps
  );
  const failed = updateWorkerDeliveryStateCtx(ctx, {
    message: args.message,
    context: args.context,
    state: "failed",
    retries: Math.max(args.retries, args.maxRetries),
    maxRetries: args.maxRetries,
    error,
    method: "failed",
    nextRetryAt: null,
    interventionId
  });
  emitThreadEvent(ctx, {
    type: "worker_replay",
    missionId: failed.missionId,
    threadId: failed.threadId ?? missionThreadId(failed.missionId),
    messageId: failed.id,
    runId: failed.runId ?? null,
    reason: "stale_inflight_failed"
  });
  return failed;
}

// ── resolveWorkerDeliverySession ────────────────────────────────

export async function resolveWorkerDeliverySessionCtx(
  ctx: OrchestratorContext,
  args: {
    message: OrchestratorChatMessage;
    context: WorkerDeliveryContext | null;
    deliveryMeta: ReturnType<typeof readWorkerDeliveryMetadataCtx>;
  }
): Promise<WorkerDeliverySessionResolution> {
  const providerHint =
    parseWorkerProviderHint(args.context?.executorKind)
    ?? parseWorkerProviderHint(args.context?.sessionToolType)
    ?? parseWorkerProviderHint(args.message.target?.kind === "worker" ? args.message.target.sessionId : null)
    ?? parseWorkerProviderHint(args.message.sourceSessionId)
    ?? null;
  if (!ctx.agentChatService) {
    return {
      sessionId: null,
      source: "mapped",
      providerHint,
      summary: null,
      error: "Agent chat service unavailable."
    };
  }
  const laneId = toOptionalString(args.context?.laneId) ?? toOptionalString(args.message.laneId);
  const sessions = await ctx.agentChatService.listSessions(laneId ?? undefined);
  const byId = new Map<string, AgentChatSessionSummaryEntry>();
  for (const summary of sessions) {
    const sessionId = toOptionalString(summary.sessionId);
    if (!sessionId) continue;
    byId.set(sessionId, summary);
  }

  const stickySessionId = toOptionalString(args.deliveryMeta.agentSessionId);
  if (stickySessionId) {
    const sticky = byId.get(stickySessionId);
    if (sticky) {
      return {
        sessionId: sticky.sessionId,
        source: "sticky",
        providerHint: parseWorkerProviderHint(sticky.provider) ?? providerHint,
        summary: sticky,
        error: null
      };
    }
  }

  const directCandidates = [
    toOptionalString(args.context?.sessionId),
    toOptionalString(args.message.sourceSessionId)
  ].filter((value): value is string => !!value);
  for (const candidate of directCandidates) {
    const summary = byId.get(candidate);
    if (!summary) continue;
    return {
      sessionId: summary.sessionId,
      source: "mapped",
      providerHint: parseWorkerProviderHint(summary.provider) ?? providerHint,
      summary,
      error: null
    };
  }

  if (!laneId) {
    return {
      sessionId: null,
      source: "lane_fallback",
      providerHint,
      summary: null,
      error: "No lane is mapped for this worker thread, so fallback delivery cannot choose a safe chat session."
    };
  }

  const providerScoped = providerHint
    ? sessions.filter((entry) => entry.provider === providerHint)
    : sessions;
  const activeProviderScoped = providerScoped.filter((entry) => entry.status !== "ended");
  if (activeProviderScoped.length === 1) {
    return {
      sessionId: activeProviderScoped[0].sessionId,
      source: "lane_fallback",
      providerHint,
      summary: activeProviderScoped[0],
      error: null
    };
  }
  if (activeProviderScoped.length > 1) {
    return {
      sessionId: null,
      source: "lane_fallback",
      providerHint,
      summary: null,
      error: "Multiple active worker chat sessions are available for this lane; specify a worker session target to avoid misdelivery."
    };
  }
  if (providerScoped.length === 1) {
    return {
      sessionId: providerScoped[0].sessionId,
      source: "lane_fallback",
      providerHint,
      summary: providerScoped[0],
      error: null
    };
  }
  if (providerScoped.length > 1) {
    return {
      sessionId: null,
      source: "lane_fallback",
      providerHint,
      summary: null,
      error: "Multiple worker chat sessions were found, but none are active. Resume a specific session or target one directly."
    };
  }

  return {
    sessionId: null,
    source: "lane_fallback",
    providerHint,
    summary: null,
    error: "No worker agent-chat session is currently mapped to this thread."
  };
}

// ── sendWorkerMessageToSession ──────────────────────────────────

function inferSessionDeliveryFailureReason(errorText: string): "no_active_session" | "delivery_failed" {
  const lower = errorText.toLowerCase();
  if (
    lower.includes("no active turn")
    || lower.includes("session not found")
    || lower.includes("does not have a live runtime")
    || lower.includes("no worker session")
  ) {
    return "no_active_session";
  }
  return "delivery_failed";
}

async function isSteerLikelyQueuedForSession(
  ctx: OrchestratorContext,
  sessionId: string
): Promise<boolean> {
  if (!ctx.agentChatService) return true;
  try {
    const sessions = await ctx.agentChatService.listSessions();
    const session = sessions.find((entry) => entry.sessionId === sessionId) ?? null;
    if (!session) return true;
    // Codex turn steering is injected into the current turn; Claude/Unified steers are queued.
    return session.provider !== "codex";
  } catch {
    // Conservative default: assume steer is queued if we cannot resolve provider.
    return true;
  }
}

export async function sendWorkerMessageToSessionWithStatusCtx(
  ctx: OrchestratorContext,
  sessionId: string,
  text: string
): Promise<WorkerSessionDeliveryStatus> {
  if (!ctx.agentChatService) {
    return {
      ok: false,
      delivered: false,
      reason: "delivery_failed",
      error: "Agent chat service unavailable."
    };
  }
  try {
    await ctx.agentChatService.sendMessage({
      sessionId,
      text
    });
    return { ok: true, delivered: true, method: "send" };
  } catch (error) {
    const sendError = normalizeDeliveryError(error);
    if (!isBusyDeliveryError(sendError)) {
      return {
        ok: false,
        delivered: false,
        reason: inferSessionDeliveryFailureReason(sendError),
        error: sendError
      };
    }
    try {
      await ctx.agentChatService.steer({
        sessionId,
        text
      });
      const steerQueued = await isSteerLikelyQueuedForSession(ctx, sessionId);
      if (steerQueued) {
        return {
          ok: true,
          delivered: false,
          reason: "worker_busy_steered",
          method: "steer"
        };
      }
      return { ok: true, delivered: true, method: "steer" };
    } catch (steerError) {
      const steerText = normalizeDeliveryError(steerError);
      if (isNoActiveTurnError(steerText)) {
        try {
          await ctx.agentChatService.sendMessage({
            sessionId,
            text
          });
          return { ok: true, delivered: true, method: "send" };
        } catch (retryError) {
          const retryText = normalizeDeliveryError(retryError);
          return {
            ok: false,
            delivered: false,
            reason: inferSessionDeliveryFailureReason(retryText),
            error: retryText
          };
        }
      }
      return {
        ok: false,
        delivered: false,
        reason: inferSessionDeliveryFailureReason(steerText),
        error: steerText
      };
    }
  }
}

export async function sendWorkerMessageToSessionCtx(
  ctx: OrchestratorContext,
  sessionId: string,
  text: string
): Promise<"send" | "steer"> {
  const status = await sendWorkerMessageToSessionWithStatusCtx(ctx, sessionId, text);
  if (!status.ok) {
    throw new Error(status.error ?? status.reason);
  }
  return status.method;
}

// ── deliverWorkerMessage ────────────────────────────────────────

export async function deliverWorkerMessageCtx(
  ctx: OrchestratorContext,
  message: OrchestratorChatMessage,
  deps: WorkerDeliveryDeps,
  options?: { ignoreBackoff?: boolean }
): Promise<OrchestratorChatMessage> {
  if (ctx.disposed.current) return message;
  const contextBase = resolveWorkerDeliveryContextCtx(ctx, message);
  if (contextBase) {
    persistThreadWorkerLinksCtx(ctx, contextBase);
  }
  const deliveryMeta = readWorkerDeliveryMetadataCtx(ctx, message);
  if (!options?.ignoreBackoff && deliveryMeta.nextRetryAtMs != null && Date.now() < deliveryMeta.nextRetryAtMs) {
    return message;
  }
  if (deliveryMeta.inFlightAttemptId && deliveryMeta.inFlightAtMs != null) {
    const inFlightAgeMs = Date.now() - deliveryMeta.inFlightAtMs;
    if (inFlightAgeMs < WORKER_MESSAGE_INFLIGHT_LEASE_MS) {
      return message;
    }
    if (inFlightAgeMs >= WORKER_MESSAGE_INFLIGHT_STALE_FAIL_MS) {
      return failWorkerDeliveryStaleInFlightCtx(
        ctx,
        {
          message,
          context: contextBase,
          retries: Math.max(deliveryMeta.retries + 1, deliveryMeta.maxRetries),
          maxRetries: deliveryMeta.maxRetries,
          ageMs: inFlightAgeMs
        },
        deps
      );
    }
  }

  if (!ctx.agentChatService) {
    ctx.logger.warn("ai_orchestrator.worker_delivery_no_chat_service", {
      messageId: message.id,
      missionId: message.missionId,
      threadId: message.threadId ?? null
    });
    return updateWorkerDeliveryStateCtx(ctx, {
      message,
      context: contextBase,
      state: "queued",
      retries: deliveryMeta.retries,
      maxRetries: deliveryMeta.maxRetries,
      error: "Agent chat service is unavailable.",
      method: "queued",
      nextRetryAt: null
    });
  }

  let context: WorkerDeliveryContext | null = contextBase;
  let workingMessage = message;
  try {
    const sessionResolution = await resolveWorkerDeliverySessionCtx(ctx, {
      message,
      context: contextBase,
      deliveryMeta
    });
    const resolvedSessionId = toOptionalString(sessionResolution.sessionId);
    context =
      contextBase && resolvedSessionId
        ? {
            ...contextBase,
            sessionId: resolvedSessionId,
            target: {
              ...contextBase.target,
              sessionId: resolvedSessionId
            }
          }
        : contextBase;

    if (contextBase && resolvedSessionId && contextBase.sessionId !== resolvedSessionId && context) {
      persistThreadWorkerLinksCtx(ctx, context);
    }
    if (resolvedSessionId && sessionResolution.summary?.status === "ended") {
      try {
        await ctx.agentChatService.resumeSession({ sessionId: resolvedSessionId });
      } catch {
        // Best-effort resume path; final delivery attempt below determines state.
      }
    }

    const sessionId = resolvedSessionId;
    if (!sessionId) {
      throw new Error(sessionResolution.error ?? "No worker session is currently mapped to this thread.");
    }
    workingMessage = markWorkerDeliveryInFlightCtx(ctx, {
      message,
      context,
      retries: deliveryMeta.retries,
      maxRetries: deliveryMeta.maxRetries,
      deliverySessionId: sessionId
    });
    const deliveryMethod = await sendWorkerMessageToSessionCtx(ctx, sessionId, message.content);
    const delivered = updateWorkerDeliveryStateCtx(ctx, {
      message: workingMessage,
      context,
      state: "delivered",
      retries: deliveryMeta.retries,
      maxRetries: deliveryMeta.maxRetries,
      error: null,
      method: deliveryMethod,
      nextRetryAt: null,
      deliverySessionId: sessionId
    });
    if (message.deliveryState === "queued" && delivered.deliveryState === "delivered") {
      const workerLabel =
        toOptionalString(context?.stepKey)
        ?? toOptionalString(context?.attemptId)
        ?? toOptionalString(context?.sessionId)
        ?? "worker";
      emitOrchestratorMessage(
        ctx,
        delivered.missionId,
        `Delivered queued worker guidance to ${workerLabel}.`,
        context?.stepKey ?? delivered.stepKey ?? null,
        {
          sourceMessageId: delivered.id,
          threadId: delivered.threadId ?? null,
          deliveryMethod
        },
        { appendChatMessage: deps.appendChatMessage }
      );
    }
    return delivered;
  } catch (error) {
    const failure = normalizeDeliveryError(error);
    const nextRetries = deliveryMeta.retries + 1;
    const exhausted = nextRetries >= deliveryMeta.maxRetries;
    if (exhausted) {
      const interventionId = upsertWorkerDeliveryInterventionCtx(
        ctx,
        {
          message: workingMessage,
          context,
          retries: nextRetries,
          error: failure
        },
        deps
      );
      return updateWorkerDeliveryStateCtx(ctx, {
        message: workingMessage,
        context,
        state: "failed",
        retries: nextRetries,
        maxRetries: deliveryMeta.maxRetries,
        error: failure,
        method: "failed",
        nextRetryAt: null,
        interventionId
      });
    }
    const nextRetryAt = new Date(Date.now() + computeWorkerRetryBackoffMs(nextRetries)).toISOString();
    ctx.logger.warn("ai_orchestrator.worker_delivery_retry_queued", {
      messageId: workingMessage.id,
      missionId: workingMessage.missionId,
      retries: nextRetries,
      maxRetries: deliveryMeta.maxRetries,
      error: failure,
      nextRetryAt
    });
    return updateWorkerDeliveryStateCtx(ctx, {
      message: workingMessage,
      context,
      state: "queued",
      retries: nextRetries,
      maxRetries: deliveryMeta.maxRetries,
      error: failure,
      method: "queued",
      nextRetryAt
    });
  }
}

// ── replayQueuedWorkerMessages ──────────────────────────────────

export async function replayQueuedWorkerMessagesCtx(
  ctx: OrchestratorContext,
  args: {
    reason: string;
    missionId?: string | null;
    threadId?: string | null;
    sessionId?: string | null;
  },
  deps: WorkerDeliveryDeps
): Promise<{ delivered: number; failed: number; queued: number }> {
  if (ctx.disposed.current) return { delivered: 0, failed: 0, queued: 0 };
  const rows = ctx.db.all<ChatMessageRow & { thread_type: string | null; created_at: string }>(
    `
      select
        m.id as id,
        m.mission_id as mission_id,
        m.role as role,
        m.content as content,
        m.timestamp as timestamp,
        m.step_key as step_key,
        m.thread_id as thread_id,
        t.thread_type as thread_type,
        m.target_json as target_json,
        m.visibility as visibility,
        m.delivery_state as delivery_state,
        m.source_session_id as source_session_id,
        m.attempt_id as attempt_id,
        m.lane_id as lane_id,
        m.run_id as run_id,
        m.metadata_json as metadata_json,
        m.created_at as created_at
      from orchestrator_chat_messages m
      left join orchestrator_chat_threads t on t.id = m.thread_id
      where m.role = 'user'
        and m.delivery_state = 'queued'
        and (? is null or m.mission_id = ?)
        and (? is null or m.thread_id = ?)
      order by m.timestamp asc, m.created_at asc, m.id asc
    `,
    [
      args.missionId ?? null,
      args.missionId ?? null,
      args.threadId ?? null,
      args.threadId ?? null
    ]
  );

  const grouped = new Map<string, OrchestratorChatMessage[]>();
  for (const row of rows) {
    const parsed = parseChatMessageRow(row);
    if (!parsed) continue;
    const isWorkerThread = row.thread_type === "worker";
    if (parsed.target?.kind !== "worker" && !isWorkerThread) continue;
    const key = parsed.threadId ?? missionThreadId(parsed.missionId);
    const bucket = grouped.get(key) ?? [];
    bucket.push(parsed);
    grouped.set(key, bucket);
  }

  let delivered = 0;
  let failed = 0;
  let queued = 0;

  const threadEntries = Array.from(grouped.entries());
  const maxParallelThreads = 8;
  for (let batchIndex = 0; batchIndex < threadEntries.length; batchIndex += maxParallelThreads) {
    const batch = threadEntries.slice(batchIndex, batchIndex + maxParallelThreads);
    await Promise.all(
      batch.map(async ([threadId, messages]) => {
        const ignoreBackoff = args.reason.startsWith("runtime_signal") || args.reason.startsWith("agent_chat");
        const previous = ctx.workerDeliveryThreadQueues.get(threadId) ?? Promise.resolve();
        const next = previous
          .catch((error) => { ctx.logger.warn("ai_orchestrator.worker_delivery_queue_previous_failed", { threadId, error: getErrorMessage(error) }); })
          .then(async () => {
            if (ctx.disposed.current) return;
            for (const candidate of messages) {
              if (ctx.disposed.current) return;
              const fresh = getChatMessageById(ctx, candidate.id);
              if (!fresh || fresh.deliveryState !== "queued") continue;
              const context = resolveWorkerDeliveryContextCtx(ctx, fresh);
              if (args.sessionId) {
                const signalSessionId = args.sessionId.trim();
                if (signalSessionId.length > 0) {
                  const mapped = toOptionalString(context?.sessionId) ?? toOptionalString(fresh.sourceSessionId);
                  if (!mapped || mapped !== signalSessionId) continue;
                }
              }
              const updated = await deliverWorkerMessageCtx(ctx, fresh, deps, {
                ignoreBackoff
              });
              if (updated.deliveryState === "delivered") {
                delivered += 1;
                continue;
              }
              if (updated.deliveryState === "failed") {
                failed += 1;
                continue;
              }
              queued += 1;
              break;
            }
          })
          .catch((error) => {
            ctx.logger.debug("ai_orchestrator.worker_delivery_replay_failed", {
              reason: args.reason,
              threadId,
              error: error instanceof Error ? error.message : String(error)
            });
          })
          .finally(() => {
            if (ctx.workerDeliveryThreadQueues.get(threadId) === next) {
              ctx.workerDeliveryThreadQueues.delete(threadId);
            }
          });
        ctx.workerDeliveryThreadQueues.set(threadId, next);
        await next;
      })
    );
  }

  if ((delivered > 0 || failed > 0 || queued > 0) && args.missionId) {
    emitThreadEvent(ctx, {
      type: "worker_replay",
      missionId: args.missionId,
      threadId: args.threadId ?? null,
      runId: null,
      reason: args.reason,
      metadata: {
        delivered,
        failed,
        queued,
        sessionId: args.sessionId ?? null
      }
    });
  }

  return { delivered, failed, queued };
}

// ── routeMessageToCoordinator ───────────────────────────────────

export function routeMessageToCoordinatorCtx(
  ctx: OrchestratorContext,
  message: OrchestratorChatMessage,
  deps: RouteToCoordinatorDeps
): void {
  const chatArgs: SendOrchestratorChatArgs = {
    missionId: message.missionId,
    content: message.content,
    threadId: message.threadId ?? missionThreadId(message.missionId),
    target: {
      kind: "coordinator",
      runId: message.runId ?? null
    },
    visibilityMode: message.visibility ?? DEFAULT_CHAT_VISIBILITY,
    metadata: message.metadata ?? null
  };
  const recentChatContext = formatRecentChatContext(ctx.chatMessages.get(message.missionId) ?? [message]);
  const statusIntent = isCoordinatorStatusQuery(message.content);
  if (statusIntent) {
    void (async () => {
      if (ctx.disposed.current) return;
      try {
        const sweep = await deps.runHealthSweep("chat_status");
        if (ctx.disposed.current) return;
        const summary = buildCoordinatorStatusReply(ctx, message.missionId, message.content);
        const recoveryNote =
          sweep.staleRecovered > 0
            ? ` Recovered ${sweep.staleRecovered} stale attempt${sweep.staleRecovered === 1 ? "" : "s"} during health sweep.`
            : "";
        emitOrchestratorMessage(ctx, message.missionId, `${summary}${recoveryNote}`.trim(), undefined, undefined, { appendChatMessage: deps.appendChatMessage });
      } catch {
        if (ctx.disposed.current) return;
        emitOrchestratorMessage(
          ctx,
          message.missionId,
          buildCoordinatorStatusReply(ctx, message.missionId, message.content),
          undefined,
          undefined,
          { appendChatMessage: deps.appendChatMessage }
        );
      }
    })();
    return;
  }

  try {
    deps.steerMission({
      missionId: message.missionId,
      directive: message.content,
      priority: "instruction",
      targetStepKey: message.target?.kind === "worker" ? message.target.stepKey ?? null : null
    });
  } catch {
    // Ignore missing mission / invalid status transitions and preserve chat UX.
  }

  if (ctx.aiIntegrationService && ctx.projectRoot) {
    deps.enqueueChatResponse(chatArgs, recentChatContext);
  } else if (!statusIntent) {
    emitOrchestratorMessage(
      ctx,
      message.missionId,
      "Directive received. I will apply it at the next planning/evaluation decision point.",
      undefined,
      undefined,
      { appendChatMessage: deps.appendChatMessage }
    );
  }
}

// ── maybeEmitWorkerQueuedNotice ─────────────────────────────────

export function maybeEmitWorkerQueuedNoticeCtx(
  ctx: OrchestratorContext,
  message: OrchestratorChatMessage,
  workerLabel: string,
  stepKey: string | null,
  deps: WorkerDeliveryDeps
): void {
  if (message.deliveryState !== "queued") return;
  void (async () => {
    if (ctx.disposed.current) return;
    let canResolveImmediately = false;
    if (ctx.agentChatService) {
      try {
        const latest = getChatMessageById(ctx, message.id) ?? message;
        if (latest.deliveryState !== "queued") return;
        const context = resolveWorkerDeliveryContextCtx(ctx, latest);
        const deliveryMeta = readWorkerDeliveryMetadataCtx(ctx, latest);
        const sessionResolution = await resolveWorkerDeliverySessionCtx(ctx, {
          message: latest,
          context,
          deliveryMeta
        });
        canResolveImmediately = !!toOptionalString(sessionResolution.sessionId);
      } catch (error) {
        ctx.logger.debug("ai_orchestrator.worker_delivery_queue_probe_failed", {
          missionId: message.missionId,
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const fresh = getChatMessageById(ctx, message.id);
    if (!fresh || fresh.deliveryState !== "queued") return;
    if (canResolveImmediately) return;

    emitOrchestratorMessage(
      ctx,
      fresh.missionId,
      `Worker message queued for ${workerLabel}; delivery will resume once the worker session is available.`,
      stepKey ?? fresh.stepKey ?? null,
      undefined,
      { appendChatMessage: deps.appendChatMessage }
    );
  })();
}

// ── routeMessageToWorker ────────────────────────────────────────

export function routeMessageToWorkerCtx(
  ctx: OrchestratorContext,
  message: OrchestratorChatMessage,
  deps: WorkerDeliveryDeps
): void {
  const target = message.target && message.target.kind === "worker" ? message.target : null;
  const workerLabel =
    toOptionalString(target?.stepKey)
    ?? toOptionalString(target?.stepId)
    ?? toOptionalString(target?.attemptId)
    ?? toOptionalString(target?.sessionId)
    ?? "worker";
  const coordinatorDigest =
    message.visibility === "full"
      ? `User sent worker guidance to ${workerLabel}: ${clipTextForContext(message.content, 300)}`
      : `User sent worker guidance to ${workerLabel}.`;
  emitOrchestratorMessage(
    ctx,
    message.missionId,
    coordinatorDigest,
    target?.stepKey ?? null,
    {
      threadId: message.threadId ?? null,
      sourceMessageId: message.id,
      visibility: message.visibility ?? DEFAULT_WORKER_CHAT_VISIBILITY,
      deliveryState: message.deliveryState ?? "queued",
      target
    },
    { appendChatMessage: deps.appendChatMessage }
  );
  if (message.deliveryState === "queued") {
    maybeEmitWorkerQueuedNoticeCtx(ctx, message, workerLabel, target?.stepKey ?? null, deps);
  } else if (message.deliveryState === "failed") {
    emitOrchestratorMessage(
      ctx,
      message.missionId,
      `Worker message to ${workerLabel} failed delivery and needs intervention.`,
      target?.stepKey ?? null,
      undefined,
      { appendChatMessage: deps.appendChatMessage }
    );
  }
}
