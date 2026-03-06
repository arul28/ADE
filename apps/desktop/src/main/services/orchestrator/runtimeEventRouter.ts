/**
 * runtimeEventRouter.ts
 *
 * Event dispatch helpers: onSessionRuntimeSignal, onAgentChatEvent,
 * buildRunStateSnapshot, routeEventToCoordinator.
 *
 * Extracted from aiOrchestratorService.ts — pure refactor, no behavior changes.
 */

import type {
  OrchestratorContext,
  SessionRuntimeSignal,
  AgentChatEventEnvelope,
  OrchestratorRuntimeEvent,
  OrchestratorRunGraph,
} from "./orchestratorContext";
import {
  nowIso,
  parseTerminalRuntimeState,
  SESSION_SIGNAL_RETENTION_MS,
} from "./orchestratorContext";
import type { MetaReasonerRunState } from "./metaReasoner";

// ── Session Runtime Signal Processing ────────────────────────────

/**
 * Queue a session runtime signal for serial processing.
 * The actual signal processing is delegated to the provided handler.
 */
export function onSessionRuntimeSignal(
  ctx: OrchestratorContext,
  signal: SessionRuntimeSignal,
  deps: {
    processSessionRuntimeSignal: (signal: SessionRuntimeSignal) => Promise<void>;
  }
): void {
  const sessionId = String(signal.sessionId ?? "").trim();
  if (!sessionId.length) return;
  const runtimeState = parseTerminalRuntimeState(signal.runtimeState) ?? "running";
  const normalizedSignal: SessionRuntimeSignal = {
    ...signal,
    sessionId,
    runtimeState,
    lastOutputPreview: typeof signal.lastOutputPreview === "string" ? signal.lastOutputPreview : null,
    at: signal.at ?? nowIso()
  };

  ctx.sessionRuntimeSignals.set(sessionId, normalizedSignal);

  const previous = ctx.sessionSignalQueues.get(sessionId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => {
      if (ctx.disposed.current) return;
      return deps.processSessionRuntimeSignal(normalizedSignal);
    })
    .catch((error) => {
      ctx.logger.debug("ai_orchestrator.session_signal_processing_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  ctx.sessionSignalQueues.set(sessionId, next);
}

/**
 * Handle a generic agent chat event.
 */
export function onAgentChatEvent(
  ctx: OrchestratorContext,
  envelope: AgentChatEventEnvelope,
  deps: {
    replayQueuedWorkerMessages: (args: { reason: string; missionId?: string | null }) => Promise<void>;
  }
): void {
  const sessionId = String(envelope.sessionId ?? "").trim();
  if (!sessionId.length) return;

  const event = envelope.event;
  const shouldReplay =
    event.type === "done" ||
    (event.type === "status" && (event as any).turnStatus === "completed");

  const previous = ctx.sessionSignalQueues.get(sessionId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => {
      if (ctx.disposed.current) return;
      if (shouldReplay) {
        return deps.replayQueuedWorkerMessages({ reason: `agent_chat_event:${event.type}` }).catch((error: unknown) => {
          ctx.logger.debug("ai_orchestrator.worker_delivery_chat_event_replay_failed", {
            sessionId,
            eventType: event.type,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    })
    .catch((error) => {
      ctx.logger.debug("ai_orchestrator.agent_chat_event_processing_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  ctx.sessionSignalQueues.set(sessionId, next);
}

/**
 * Build a run state snapshot for meta-reasoner fan-out analysis.
 */
export function buildRunStateSnapshot(ctx: OrchestratorContext, runId: string): MetaReasonerRunState {
  const graph = ctx.orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
  const activeAgentCount = graph.attempts.filter((a) => a.status === "running").length;
  const runMeta = graph.run.metadata ?? {};
  const autopilot = typeof runMeta.autopilot === "object" && runMeta.autopilot && !Array.isArray(runMeta.autopilot)
    ? (runMeta.autopilot as Record<string, unknown>)
    : {};
  const rawParallelismCap = Number(autopilot.parallelismCap ?? 4);
  const normalizedParallelismCap = Number.isFinite(rawParallelismCap) ? Math.floor(rawParallelismCap) : 4;
  const parallelismCap = Math.max(1, Math.min(32, normalizedParallelismCap));

  const runningLaneIds = new Set(
    graph.steps.filter((s) => s.status === "running" && s.laneId).map((s) => s.laneId!)
  );
  const allLaneIds = [...new Set(graph.steps.map((s) => s.laneId).filter((id): id is string => id != null))];
  const availableLanes = allLaneIds.filter((id) => !runningLaneIds.has(id));

  const fileOwnershipMap: Record<string, string> = {};
  for (const claim of graph.claims) {
    if (claim.state === "active" && claim.scopeKind === "file") {
      fileOwnershipMap[claim.scopeValue] = claim.ownerId;
    }
  }

  return { activeAgentCount, parallelismCap, availableLanes, fileOwnershipMap };
}

/**
 * Prune stale session runtime signals.
 */
export function pruneSessionRuntimeSignals(ctx: OrchestratorContext): void {
  const now = Date.now();
  for (const [sessionId, signal] of ctx.sessionRuntimeSignals.entries()) {
    const atMs = Date.parse(signal.at);
    if (!Number.isFinite(atMs) || now - atMs > SESSION_SIGNAL_RETENTION_MS) {
      ctx.sessionRuntimeSignals.delete(sessionId);
    }
  }
}

// ── Coordinator Agent Event Routing ──────────────────────────────

import type { CoordinatorAgent } from "./coordinatorAgent";
import { formatRuntimeEvent, formatStepCompletion, formatStepFailure } from "./coordinatorEventFormatter";

const MAX_ROUTED_COORDINATOR_MESSAGE_CHARS = 6000;
const COORDINATOR_EVENT_DEDUPE_WINDOW_MS = 750;
const COORDINATOR_ROUTE_RATE_WINDOW_MS = 1_000;
const COORDINATOR_ROUTE_RATE_LIMIT = 24;
const COORDINATOR_ROUTING_CRITICAL_REASONS = new Set([
  "finalized",
  "attempt_completed",
  "completed",
  "failed",
  "skipped",
  "intervention_opened",
  "intervention_resolved",
]);
const COORDINATOR_IMPORTANT_RUNTIME_REASONS = new Set([
  "attempt_completed",
  "completed",
  "failed",
  "skipped",
  "finalized",
  "delivery_failed",
  "manual_intervention_required",
  "manual_pause",
  "manual_pause_for_review",
  "manual_step_requires_operator",
  "milestone_ready_validation_required",
  "no_output_after_startup",
  "question_answered_resume",
  "required_validation_gate_blocked",
  "required_validation_missing",
  "resume_recovered",
  "retry_exhausted",
  "run_reopened",
  "startup_verification_warning",
  "validation_auto_spawned",
  "validation_contract_unfulfilled",
  "validation_gate_blocked",
  "validation_retry_exhausted",
  "validation_self_check_reminder",
]);

type CoordinatorRouteGuardState = {
  lastFingerprint: string | null;
  lastFingerprintAtMs: number;
  routeWindowStartedAtMs: number;
  routedInWindow: number;
  suppressedCount: number;
};

const coordinatorRouteGuards = new WeakMap<CoordinatorAgent, CoordinatorRouteGuardState>();

function getCoordinatorRouteGuardState(coordinator: CoordinatorAgent): CoordinatorRouteGuardState {
  const existing = coordinatorRouteGuards.get(coordinator);
  if (existing) return existing;
  const created: CoordinatorRouteGuardState = {
    lastFingerprint: null,
    lastFingerprintAtMs: 0,
    routeWindowStartedAtMs: 0,
    routedInWindow: 0,
    suppressedCount: 0,
  };
  coordinatorRouteGuards.set(coordinator, created);
  return created;
}

function clipRoutedCoordinatorMessage(message: string): string {
  const normalized = message.trim();
  if (normalized.length <= MAX_ROUTED_COORDINATOR_MESSAGE_CHARS) return normalized;
  const suffix = "\n[router-truncated]";
  return `${normalized.slice(0, MAX_ROUTED_COORDINATOR_MESSAGE_CHARS - suffix.length)}${suffix}`;
}

/**
 * Route a runtime event to a CoordinatorAgent instance.
 * Formats the event into tiered context and injects it.
 */
export function routeEventToCoordinator(
  coordinator: CoordinatorAgent,
  event: OrchestratorRuntimeEvent,
  context?: { graph?: OrchestratorRunGraph },
): void {
  const normalizedReason = String(event.reason ?? "").trim().toLowerCase();
  if (event.type === "orchestrator-claim-updated") {
    return;
  }
  if (normalizedReason.length > 0 && !COORDINATOR_IMPORTANT_RUNTIME_REASONS.has(normalizedReason)) {
    return;
  }
  const resolvedStep =
    context?.graph && event.stepId
      ? context.graph.steps.find((candidate) => candidate.id === event.stepId)
      : undefined;
  const resolvedAttempt =
    context?.graph && event.attemptId
      ? context.graph.attempts.find((candidate) => candidate.id === event.attemptId)
      : undefined;
  const formatted =
    context?.graph && resolvedStep && (event.reason === "attempt_completed" || event.reason === "skipped")
      ? formatStepCompletion(resolvedStep, resolvedAttempt ?? null, context.graph)
      : context?.graph && resolvedStep && event.reason === "failed"
        ? formatStepFailure(resolvedStep, resolvedAttempt ?? null, resolvedAttempt?.errorMessage ?? "unknown error")
        : formatRuntimeEvent(event, {
          graph: context?.graph,
          step: resolvedStep,
          attempt: resolvedAttempt,
        });
  let message = formatted.digest
    ? `${formatted.summary}\n${formatted.digest}`
    : formatted.summary;
  const nowMs = Date.now();
  const state = getCoordinatorRouteGuardState(coordinator);
  const fingerprint = `${event.type}:${event.reason}:${event.stepId ?? ""}:${event.attemptId ?? ""}:${message.slice(0, 220)}`;
  const isCritical = COORDINATOR_ROUTING_CRITICAL_REASONS.has(String(event.reason ?? "").trim().toLowerCase());
  const isDuplicate =
    state.lastFingerprint === fingerprint
    && nowMs - state.lastFingerprintAtMs < COORDINATOR_EVENT_DEDUPE_WINDOW_MS;
  if (isDuplicate && !isCritical) {
    state.lastFingerprint = fingerprint;
    state.lastFingerprintAtMs = nowMs;
    state.suppressedCount += 1;
    return;
  }

  if (nowMs - state.routeWindowStartedAtMs >= COORDINATOR_ROUTE_RATE_WINDOW_MS) {
    state.routeWindowStartedAtMs = nowMs;
    state.routedInWindow = 0;
  }
  if (state.routedInWindow >= COORDINATOR_ROUTE_RATE_LIMIT && !isCritical) {
    state.lastFingerprint = fingerprint;
    state.lastFingerprintAtMs = nowMs;
    state.suppressedCount += 1;
    return;
  }

  state.lastFingerprint = fingerprint;
  state.lastFingerprintAtMs = nowMs;
  state.routedInWindow += 1;

  if (state.suppressedCount > 0) {
    message += `\n[router] Suppressed ${state.suppressedCount} repetitive runtime event(s).`;
    state.suppressedCount = 0;
  }

  coordinator.injectEvent(event, clipRoutedCoordinatorMessage(message));
}
