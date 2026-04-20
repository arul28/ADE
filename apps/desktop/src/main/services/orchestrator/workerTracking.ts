/**
 * workerTracking.ts
 *
 * Worker state management: getWorkerStates, getWorkerDigest, listWorkerDigests,
 * getContextCheckpoint, listLaneDecisions, worker state update functions,
 * and updateWorkerStateFromEvent (attempt lifecycle handler).
 *
 * Extracted from aiOrchestratorService.ts — pure refactor, no behavior changes.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  OrchestratorContext,
} from "./orchestratorContext";
import {
  nowIso,
  isRecord,
  toOptionalString,
  clampLimit,
  MAX_THREAD_PAGE_SIZE,
} from "./orchestratorContext";
import {
  getMissionIdentity,
  emitThreadEvent,
  emitOrchestratorMessage,
  ensureThreadForTarget,
} from "./chatMessageService";
import {
  stepTitleForMessage,
  isRetryQueuedForStep,
  extractOutcomeTags,
  resolveActiveRuntimeProfile,
} from "./missionLifecycle";
import {
  recordMissionMetricSample,
} from "./metricsAndUsage";
import {
  deletePersistedAttemptRuntimeState,
} from "./recoveryService";
import {
  resolveCallTypeConfig,
} from "./modelConfigResolver";
import {
  PM_SYSTEM_PREAMBLE,
} from "./coordinatorSession";
import { getModelById } from "../../../shared/modelRegistry";
import type {
  OrchestratorWorkerState,
  OrchestratorWorkerStatus,
  OrchestratorWorkerDigest,
  OrchestratorContextCheckpoint,
  OrchestratorLaneDecision,
  OrchestratorExecutorKind,
  OrchestratorRunGraph,
  OrchestratorRuntimeEvent,
  OrchestratorArtifactKind,
  OrchestratorChatMessage,
  ListOrchestratorWorkerDigestsArgs,
  GetOrchestratorWorkerDigestArgs,
  GetOrchestratorContextCheckpointArgs,
  ListOrchestratorLaneDecisionsArgs,
} from "../../../shared/types";
import {
  resolveReportArtifactKey,
  resolveReportArtifactKind,
  resolveReportArtifactMissionType,
} from "../../../shared/proofArtifacts";

// ── Worker State Functions ───────────────────────────────────────

export function getWorkerStates(
  ctx: OrchestratorContext,
  args: { runId: string }
): OrchestratorWorkerState[] {
  const result: OrchestratorWorkerState[] = [];
  for (const state of ctx.workerStates.values()) {
    if (state.runId === args.runId) result.push(state);
  }
  return result;
}

function resolveEvaluationProvider(attempt: {
  metadata?: Record<string, unknown> | null;
}): "claude" | "codex" {
  const metadata = isRecord(attempt.metadata) ? attempt.metadata : null;
  const modelRef = typeof metadata?.modelId === "string" ? metadata.modelId : null;
  if (modelRef) {
    const descriptor = getModelById(modelRef);
    if (descriptor?.family === "openai") return "codex";
  }
  return "claude";
}

function resolveWorkerLifecyclePhaseLabel(step: OrchestratorRunGraph["steps"][number] | undefined): "planning" | "validation" | "implementation" {
  const stepMeta = isRecord(step?.metadata) ? step?.metadata : {};
  const phaseKey = typeof stepMeta.phaseKey === "string" ? stepMeta.phaseKey.trim().toLowerCase() : "";
  const stepType = typeof stepMeta.stepType === "string" ? stepMeta.stepType.trim().toLowerCase() : "";
  const readOnlyExecution = stepMeta.readOnlyExecution === true;
  if (phaseKey === "planning" || stepType === "planning" || readOnlyExecution) {
    return "planning";
  }
  if (phaseKey === "validation" || stepType === "validation") {
    return "validation";
  }
  return "implementation";
}

function buildWorkerLifecycleStartMessage(step: OrchestratorRunGraph["steps"][number] | undefined): string {
  const phaseLabel = resolveWorkerLifecyclePhaseLabel(step);
  if (phaseLabel === "planning") {
    return "I’m starting the planning pass now. I’m reviewing the relevant files and I’ll send a concrete plan back to the coordinator.";
  }
  if (phaseLabel === "validation") {
    return "I’m starting validation now. I’m checking the completed work against the mission requirements.";
  }
  return "I’m starting this task now. I’m making the requested changes and I’ll report back with what changed.";
}

function buildWorkerLifecycleCompletionMessage(
  step: OrchestratorRunGraph["steps"][number] | undefined,
  summary: string | null | undefined,
): string {
  const compactSummary = typeof summary === "string"
    ? summary.replace(/\s+/g, " ").trim()
    : "";
  const clippedSummary = compactSummary.length > 0 ? compactSummary.slice(0, 180) : "";
  const phaseLabel = resolveWorkerLifecyclePhaseLabel(step);
  if (phaseLabel === "planning") {
    return clippedSummary.length > 0
      ? `I finished the planning pass and reported back: ${clippedSummary}`
      : "I finished the planning pass and sent the coordinator a concrete plan.";
  }
  if (phaseLabel === "validation") {
    return clippedSummary.length > 0
      ? `I finished validation and reported back: ${clippedSummary}`
      : "I finished validation and reported the result back to the coordinator.";
  }
  return clippedSummary.length > 0
    ? `I finished this task and reported back: ${clippedSummary}`
    : "I finished this task and reported the outcome back to the coordinator.";
}

function buildWorkerLifecycleFailureMessage(attempt: {
  errorMessage: string | null;
}): string {
  const errorText = typeof attempt.errorMessage === "string"
    ? attempt.errorMessage.replace(/\s+/g, " ").trim()
    : "";
  if (!errorText.length) {
    return "I hit an issue while working on this task and reported it back to the coordinator.";
  }
  return `I hit an issue while working on this task and reported it back: ${errorText.slice(0, 180)}`;
}

function resolveRetryExhaustedIntervention(args: {
  attempt: OrchestratorRunGraph["attempts"][number];
  step: OrchestratorRunGraph["steps"][number];
  stepTitle: string;
}): {
  interventionType: "failed_step" | "provider_unreachable";
  title: string;
  body: string;
  requestedAction: string;
  reasonCode: string;
} {
  const attemptMeta = isRecord(args.attempt.metadata) ? args.attempt.metadata : {};
  const softFailureOverride = isRecord(attemptMeta.softFailureOverride) ? attemptMeta.softFailureOverride : {};
  const softCategory = typeof softFailureOverride.category === "string" ? softFailureOverride.category.trim().toLowerCase() : "";
  const providerHint = typeof args.attempt.executorKind === "string" ? args.attempt.executorKind.trim().toLowerCase() : "provider";
  const errorText = typeof args.attempt.errorMessage === "string" ? args.attempt.errorMessage.trim() : "";
  const lowerError = errorText.toLowerCase();
  const providerUnavailable =
    softCategory === "missing_auth"
    || /needs-auth|authentication required|authentication failed|unauthorized|forbidden|invalid api key|refresh_token_reused|refresh token|sign in again|log out and sign in/i.test(lowerError);

  if (providerUnavailable) {
    const providerLabel = providerHint.length > 0 ? providerHint : "provider";
    return {
      interventionType: "provider_unreachable",
      title: `${providerLabel} needs attention`,
      body: `Step ${args.step.stepKey} (${args.stepTitle}) could not continue because ${providerLabel} is unavailable or unauthenticated. Last error: ${errorText || "unknown"}`,
      requestedAction: `Restore ${providerLabel} access/authentication, then resume the mission run to retry this worker.`,
      reasonCode: "provider_auth_unavailable",
    };
  }

  return {
    interventionType: "failed_step",
    title: `Step "${args.stepTitle}" failed after ${args.step.retryCount} retries`,
    body: `Step ${args.step.stepKey} (${args.stepTitle}) exhausted all ${args.step.retryLimit} retries. Last error: ${errorText || "unknown"}`,
    requestedAction: "Review and decide whether to retry, skip, or add a workaround.",
    reasonCode: "retry_exhausted",
  };
}

function resolvePlannerPlanMissingIntervention(args: {
  attempt: OrchestratorRunGraph["attempts"][number];
  step: OrchestratorRunGraph["steps"][number];
  stepTitle: string;
}): {
  interventionType: "failed_step";
  title: string;
  body: string;
  requestedAction: string;
  reasonCode: "planner_plan_missing";
} {
  const errorText = typeof args.attempt.errorMessage === "string" ? args.attempt.errorMessage.trim() : "";
  return {
    interventionType: "failed_step",
    title: "Planner result missing plan",
    body:
      errorText ||
      `Step ${args.step.stepKey} (${args.stepTitle}) finished without returning report_result.plan.markdown, so ADE could not accept the planning attempt as successful.`,
    requestedAction:
      "Retry planning only after the planner can return report_result.plan.markdown. ADE will not advance until the canonical plan artifact exists.",
    reasonCode: "planner_plan_missing",
  };
}

function resolvePlannerPlanMissingInterventionsAfterPlanningSuccess(args: {
  ctx: OrchestratorContext;
  deps: UpdateWorkerStateDeps;
  missionId: string;
  attempt: OrchestratorRunGraph["attempts"][number];
  step: OrchestratorRunGraph["steps"][number];
}): void {
  const stepMeta = isRecord(args.step.metadata) ? args.step.metadata : {};
  const phaseKey = typeof stepMeta.phaseKey === "string" ? stepMeta.phaseKey.trim().toLowerCase() : "";
  const stepType = typeof stepMeta.stepType === "string" ? stepMeta.stepType.trim().toLowerCase() : "";
  // Match `extractAndRegisterArtifacts` planning detection: read-only implementation steps must not
  // auto-resolve `planner_plan_missing` unless ADE would persist the canonical plan artifact.
  const isPlanningStep = stepType === "planning" || stepType === "analysis" || phaseKey === "planning";
  if (!isPlanningStep) return;

  const lastResultReport = isRecord(stepMeta.lastResultReport) ? stepMeta.lastResultReport : null;
  const reportedPlan = lastResultReport && isRecord(lastResultReport.plan) ? lastResultReport.plan : null;
  const planMarkdown =
    reportedPlan && typeof reportedPlan.markdown === "string" ? reportedPlan.markdown.trim() : "";
  if (!planMarkdown.length) return;

  const mission = args.ctx.missionService.get(args.missionId);
  if (!mission) return;

  const resolvedAt = nowIso();
  for (const intervention of mission.interventions) {
    if (intervention.status !== "open" || intervention.interventionType !== "failed_step") continue;
    const meta = isRecord(intervention.metadata) ? intervention.metadata : {};
    const reasonCode = typeof meta.reasonCode === "string" ? meta.reasonCode.trim() : "";
    if (reasonCode !== "planner_plan_missing") continue;
    const interventionRunId = typeof meta.runId === "string" ? meta.runId.trim() : "";
    if (interventionRunId.length > 0 && interventionRunId !== args.attempt.runId) continue;

    try {
      args.ctx.missionService.resolveIntervention({
        missionId: args.missionId,
        interventionId: intervention.id,
        status: "resolved",
        note: `Auto-resolved after planner returned report_result.plan for step "${stepTitleForMessage(args.step)}".`,
      });
      args.deps.recordRuntimeEvent({
        runId: args.attempt.runId,
        stepId: args.step.id,
        attemptId: args.attempt.id,
        sessionId: args.attempt.executorSessionId,
        eventType: "intervention_resolved",
        eventKey: `intervention_resolved:${intervention.id}:planner_plan_recovered`,
        payload: {
          interventionId: intervention.id,
          reason: "planner_plan_recovered",
          recoveredByStepId: args.step.id,
          recoveredByStepKey: args.step.stepKey,
          resolvedAt,
        },
      });
    } catch (error) {
      args.ctx.logger.debug("ai_orchestrator.planner_plan_missing_resolve_failed", {
        missionId: args.missionId,
        runId: args.attempt.runId,
        stepId: args.step.id,
        interventionId: intervention.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function resolveRecoveredFailedStepInterventions(args: {
  ctx: OrchestratorContext;
  deps: UpdateWorkerStateDeps;
  missionId: string;
  attempt: OrchestratorRunGraph["attempts"][number];
  step: OrchestratorRunGraph["steps"][number];
}): void {
  const mission = args.ctx.missionService.get(args.missionId);
  if (!mission) return;

  const stepMeta = isRecord(args.step.metadata) ? args.step.metadata : {};
  const phaseKey = typeof stepMeta.phaseKey === "string" ? stepMeta.phaseKey.trim() : "";
  const stepType = typeof stepMeta.stepType === "string" ? stepMeta.stepType.trim() : "";
  const planningLike =
    stepMeta.readOnlyExecution === true
    || phaseKey.toLowerCase() === "planning"
    || stepType.toLowerCase() === "planning";
  const resolvedAt = nowIso();

  for (const intervention of mission.interventions) {
    if (intervention.status !== "open" || (intervention.interventionType !== "failed_step" && intervention.interventionType !== "provider_unreachable")) continue;

    const meta = isRecord(intervention.metadata) ? intervention.metadata : {};
    const interventionRunId = typeof meta.runId === "string" ? meta.runId.trim() : "";
    const interventionStepId = typeof meta.stepId === "string" ? meta.stepId.trim() : "";
    const interventionPhaseKey = typeof meta.phaseKey === "string" ? meta.phaseKey.trim() : "";
    const interventionStepType = typeof meta.stepType === "string" ? meta.stepType.trim() : "";
    const legacyPlanningFailure =
      planningLike
      && /planning worker exited without reporting a usable plan/i.test(
        `${intervention.title} ${intervention.body}`,
      );
    const sameRun = interventionRunId.length === 0 || interventionRunId === args.attempt.runId;
    const exactStepMatch = interventionStepId.length > 0 && interventionStepId === args.step.id;
    const replacementStepMatch =
      !exactStepMatch
      && sameRun
      && planningLike
      && interventionPhaseKey.length > 0
      && interventionStepType.length > 0
      && interventionPhaseKey === phaseKey
      && interventionStepType === stepType;

    if (!sameRun || (!exactStepMatch && !replacementStepMatch && !legacyPlanningFailure)) continue;

    try {
      args.ctx.missionService.resolveIntervention({
        missionId: args.missionId,
        interventionId: intervention.id,
        status: "resolved",
        note: `Auto-resolved after recovery step "${stepTitleForMessage(args.step)}" succeeded.`,
      });
      args.deps.recordRuntimeEvent({
        runId: args.attempt.runId,
        stepId: args.step.id,
        attemptId: args.attempt.id,
        sessionId: args.attempt.executorSessionId,
        eventType: "intervention_resolved",
        eventKey: `intervention_resolved:${intervention.id}:recovery_success`,
        payload: {
          interventionId: intervention.id,
          reason: "recovery_step_succeeded",
          recoveredByStepId: args.step.id,
          recoveredByStepKey: args.step.stepKey,
          resolvedAt,
        },
      });
    } catch (error) {
      args.ctx.logger.debug("ai_orchestrator.recovery_intervention_resolve_failed", {
        missionId: args.missionId,
        runId: args.attempt.runId,
        stepId: args.step.id,
        interventionId: intervention.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function appendWorkerThreadLifecycleMessage(args: {
  ctx: OrchestratorContext;
  deps: UpdateWorkerStateDeps;
  missionId: string;
  attempt: OrchestratorRunGraph["attempts"][number];
  step: OrchestratorRunGraph["steps"][number] | undefined;
  stepTitle: string;
  stepKey: string | null;
  content: string;
  metadataSource: string;
}): void {
  const thread = ensureThreadForTarget(args.ctx, {
    missionId: args.missionId,
    target: {
      kind: "worker",
      runId: args.attempt.runId,
      stepId: args.attempt.stepId,
      stepKey: args.stepKey,
      attemptId: args.attempt.id,
      sessionId: args.attempt.executorSessionId ?? null,
      laneId: args.step?.laneId ?? null,
    },
    fallbackTitle: `Worker: ${args.stepTitle}`,
  });

  args.deps.appendChatMessage({
    id: randomUUID(),
    missionId: args.missionId,
    threadId: thread.id,
    role: "worker",
    content: args.content,
    timestamp: nowIso(),
    stepKey: args.stepKey,
    target: {
      kind: "worker",
      runId: args.attempt.runId,
      stepId: args.attempt.stepId,
      stepKey: args.stepKey,
      attemptId: args.attempt.id,
      sessionId: args.attempt.executorSessionId ?? null,
      laneId: args.step?.laneId ?? null,
    },
    visibility: "full",
    deliveryState: "delivered",
    sourceSessionId: args.attempt.executorSessionId ?? null,
    attemptId: args.attempt.id,
    laneId: args.step?.laneId ?? null,
    runId: args.attempt.runId,
    metadata: {
      source: args.metadataSource,
    },
  });
}

export function upsertWorkerState(
  ctx: OrchestratorContext,
  attemptId: string,
  update: {
    stepId: string;
    runId: string;
    sessionId?: string | null;
    executorKind: OrchestratorExecutorKind;
    state: OrchestratorWorkerStatus;
    outcomeTags?: string[];
    completedAt?: string | null;
  }
): void {
  const now = nowIso();
  const existing = ctx.workerStates.get(attemptId);
  if (existing) {
    existing.state = update.state;
    existing.lastHeartbeatAt = now;
    if (update.sessionId !== undefined) existing.sessionId = update.sessionId;
    if (update.outcomeTags) existing.outcomeTags = update.outcomeTags;
    if (update.completedAt !== undefined) existing.completedAt = update.completedAt;
  } else {
    ctx.workerStates.set(attemptId, {
      attemptId,
      stepId: update.stepId,
      runId: update.runId,
      sessionId: update.sessionId ?? null,
      executorKind: update.executorKind,
      state: update.state,
      lastHeartbeatAt: now,
      spawnedAt: now,
      completedAt: update.completedAt ?? null,
      outcomeTags: update.outcomeTags ?? []
    });
  }
}

/**
 * Parse a worker digest row from the database.
 */
export function parseWorkerDigestRow(row: {
  id: string;
  mission_id: string;
  run_id: string;
  step_id: string;
  attempt_id: string;
  lane_id: string | null;
  session_id: string | null;
  step_key: string | null;
  status: string;
  summary: string;
  files_changed_json: string | null;
  tests_run_json: string | null;
  warnings_json: string | null;
  tokens_json: string | null;
  cost_usd: number | null;
  suggested_next_actions_json: string | null;
  created_at: string;
}): OrchestratorWorkerDigest {
  const filesChanged: string[] = (() => {
    try { return JSON.parse(row.files_changed_json ?? "[]"); } catch { return []; }
  })();
  const testsRun = (() => {
    try {
      const parsed = JSON.parse(row.tests_run_json ?? "{}");
      return {
        passed: Number(parsed.passed ?? 0),
        failed: Number(parsed.failed ?? 0),
        skipped: Number(parsed.skipped ?? 0),
        ...(parsed.summary ? { summary: String(parsed.summary) } : {})
      };
    } catch {
      return { passed: 0, failed: 0, skipped: 0 };
    }
  })();
  const warnings: string[] = (() => {
    try { return JSON.parse(row.warnings_json ?? "[]"); } catch { return []; }
  })();
  const tokens = (() => {
    try { return JSON.parse(row.tokens_json ?? "null"); } catch { return null; }
  })();
  const suggestedNextActions: string[] = (() => {
    try { return JSON.parse(row.suggested_next_actions_json ?? "[]"); } catch { return []; }
  })();

  return {
    id: row.id,
    missionId: row.mission_id,
    runId: row.run_id,
    stepId: row.step_id,
    stepKey: row.step_key,
    attemptId: row.attempt_id,
    laneId: row.lane_id ?? null,
    sessionId: row.session_id ?? null,
    status: row.status as OrchestratorWorkerDigest["status"],
    summary: row.summary,
    filesChanged,
    testsRun,
    warnings,
    tokens,
    costUsd: row.cost_usd ?? null,
    suggestedNextActions,
    createdAt: row.created_at
  };
}

export function listWorkerDigests(
  ctx: OrchestratorContext,
  digestArgs: ListOrchestratorWorkerDigestsArgs
): OrchestratorWorkerDigest[] {
  const runId = toOptionalString(digestArgs.runId);
  const missionId = toOptionalString(digestArgs.missionId);
  const stepId = toOptionalString(digestArgs.stepId);
  const attemptId = toOptionalString(digestArgs.attemptId);
  const laneId = toOptionalString(digestArgs.laneId);
  const limit = clampLimit(digestArgs.limit, 50, MAX_THREAD_PAGE_SIZE);

  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (runId) {
    clauses.push("wd.run_id = ?");
    params.push(runId);
  }
  if (missionId) {
    clauses.push("wd.run_id IN (SELECT id FROM orchestrator_runs WHERE mission_id = ?)");
    params.push(missionId);
  }
  if (stepId) {
    clauses.push("wd.step_id = ?");
    params.push(stepId);
  }
  if (attemptId) {
    clauses.push("wd.attempt_id = ?");
    params.push(attemptId);
  }
  if (laneId) {
    clauses.push("wd.lane_id = ?");
    params.push(laneId);
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit);

  const rows = ctx.db.all(
    `SELECT * FROM orchestrator_worker_digests wd ${whereClause} ORDER BY wd.created_at DESC LIMIT ?`,
    params
  ) as Array<any>;

  return rows.map((row) => parseWorkerDigestRow(row));
}

export function getWorkerDigest(
  ctx: OrchestratorContext,
  digestArgs: GetOrchestratorWorkerDigestArgs
): OrchestratorWorkerDigest | null {
  const digestId = toOptionalString(digestArgs.digestId);
  const missionId = toOptionalString(digestArgs.missionId);
  if (!digestId || !missionId) return null;

  const row = ctx.db.get(
    `
      SELECT *
      FROM orchestrator_worker_digests
      WHERE id = ?
        AND run_id IN (SELECT id FROM orchestrator_runs WHERE mission_id = ?)
      LIMIT 1
    `,
    [digestId, missionId]
  ) as any;

  return row ? parseWorkerDigestRow(row) : null;
}

export function getContextCheckpoint(
  ctx: OrchestratorContext,
  checkpointArgs: GetOrchestratorContextCheckpointArgs
): OrchestratorContextCheckpoint | null {
  const missionId = toOptionalString(checkpointArgs.missionId);
  if (!missionId) return null;

  const checkpointId = toOptionalString(checkpointArgs.checkpointId);

  const row = ctx.db.get(
    checkpointId
      ? `SELECT * FROM orchestrator_context_checkpoints WHERE id = ? AND mission_id = ? LIMIT 1`
      : `SELECT * FROM orchestrator_context_checkpoints WHERE mission_id = ? ORDER BY created_at DESC LIMIT 1`,
    checkpointId ? [checkpointId, missionId] : [missionId]
  ) as any;

  if (!row) return null;

  const sourceData = (() => {
    try {
      const meta = JSON.parse(row.metadata_json ?? "{}");
      return {
        digestCount: Number(meta.digestCount ?? 0),
        chatMessageCount: Number(meta.chatMessageCount ?? 0),
        compressedMessageCount: Number(meta.compressedMessageCount ?? 0)
      };
    } catch {
      return { digestCount: 0, chatMessageCount: 0, compressedMessageCount: 0 };
    }
  })();

  return {
    id: row.id,
    missionId: row.mission_id,
    runId: row.run_id ?? null,
    trigger: (row.checkpoint_type ?? row.trigger ?? "manual") as OrchestratorContextCheckpoint["trigger"],
    summary: row.content ?? row.summary ?? "",
    source: sourceData,
    createdAt: row.created_at
  };
}

export function listLaneDecisions(
  ctx: OrchestratorContext,
  laneArgs: ListOrchestratorLaneDecisionsArgs
): OrchestratorLaneDecision[] {
  const missionId = toOptionalString(laneArgs.missionId);
  const runId = toOptionalString(laneArgs.runId);
  const limit = clampLimit(laneArgs.limit, 50, MAX_THREAD_PAGE_SIZE);

  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (missionId) {
    clauses.push("ld.mission_id = ?");
    params.push(missionId);
  }
  if (runId) {
    clauses.push("ld.run_id = ?");
    params.push(runId);
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit);

  const rows = ctx.db.all(
    `SELECT * FROM orchestrator_lane_decisions ld ${whereClause} ORDER BY ld.created_at DESC LIMIT ?`,
    params
  ) as Array<any>;

  return rows.map((row) => {
    const metadata = (() => {
      try { return JSON.parse(row.metadata_json ?? "null"); } catch { return null; }
    })();
    const ruleHits: string[] = (() => {
      try { return JSON.parse(row.rule_hits_json ?? "[]"); } catch { return []; }
    })();
    return {
      id: row.id,
      missionId: row.mission_id,
      runId: row.run_id ?? null,
      stepId: row.step_id ?? null,
      stepKey: row.step_key ?? null,
      laneId: row.lane_id ?? null,
      decisionType: (row.decision_type ?? "proposal") as OrchestratorLaneDecision["decisionType"],
      validatorOutcome: (row.validator_outcome ?? "pass") as OrchestratorLaneDecision["validatorOutcome"],
      ruleHits,
      rationale: row.rationale ?? row.reasoning ?? "",
      metadata,
      createdAt: row.created_at
    };
  });
}

// ── Worker Digest Functions ──────────────────────────────────────

export function buildWorkerDigestFromAttempt(args: {
  graph: OrchestratorRunGraph;
  attempt: OrchestratorRunGraph["attempts"][number];
}): OrchestratorWorkerDigest {
  const step = args.graph.steps.find((entry) => entry.id === args.attempt.stepId);
  const envelope = args.attempt.resultEnvelope;
  const outputs = envelope?.outputs ?? null;
  const filesChangedRaw = outputs?.filesChanged ?? outputs?.files_changed ?? [];
  const filesChanged = Array.isArray(filesChangedRaw)
    ? filesChangedRaw.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  const testsRun = {
    passed: Math.max(0, Math.floor(Number(outputs?.testsPassed ?? outputs?.tests_passed) || 0)),
    failed: Math.max(0, Math.floor(Number(outputs?.testsFailed ?? outputs?.tests_failed) || 0)),
    skipped: Math.max(0, Math.floor(Number(outputs?.testsSkipped ?? outputs?.tests_skipped) || 0)),
    summary: typeof outputs?.testsSummary === "string"
      ? outputs.testsSummary
      : typeof outputs?.tests_summary === "string"
        ? outputs.tests_summary
        : null
  };
  const tokensInput = Number(outputs?.inputTokens ?? outputs?.input_tokens ?? outputs?.tokensInput ?? outputs?.tokens_input);
  const tokensOutput = Number(outputs?.outputTokens ?? outputs?.output_tokens ?? outputs?.tokensOutput ?? outputs?.tokens_output);
  const tokensTotal = Number(outputs?.totalTokens ?? outputs?.total_tokens ?? outputs?.tokensTotal ?? outputs?.tokens_total);
  const tokens =
    Number.isFinite(tokensInput) || Number.isFinite(tokensOutput) || Number.isFinite(tokensTotal)
      ? {
          input: Number.isFinite(tokensInput) ? Math.max(0, Math.floor(tokensInput)) : undefined,
          output: Number.isFinite(tokensOutput) ? Math.max(0, Math.floor(tokensOutput)) : undefined,
          total: Number.isFinite(tokensTotal) ? Math.max(0, Math.floor(tokensTotal)) : undefined
        }
      : null;
  const costUsdRaw = Number(outputs?.costUsd ?? outputs?.cost_usd ?? outputs?.usdCost ?? outputs?.usd_cost);
  const costUsd = Number.isFinite(costUsdRaw) ? costUsdRaw : null;
  const status =
    args.attempt.status === "running"
    || args.attempt.status === "succeeded"
    || args.attempt.status === "failed"
    || args.attempt.status === "blocked"
    || args.attempt.status === "queued"
      ? args.attempt.status
      : "queued";
  const summary =
    typeof envelope?.summary === "string" && envelope.summary.trim().length
      ? envelope.summary.trim()
      : args.attempt.status === "running"
        ? `Worker started on ${step ? stepTitleForMessage(step) : args.attempt.stepId}.`
        : args.attempt.errorMessage ?? `Step ${step?.stepKey ?? args.attempt.stepId} finished with status ${args.attempt.status}.`;
  const warnings = Array.isArray(envelope?.warnings)
    ? envelope.warnings.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  return {
    id: randomUUID(),
    missionId: args.graph.run.missionId,
    runId: args.attempt.runId,
    stepId: args.attempt.stepId,
    stepKey: step?.stepKey ?? null,
    attemptId: args.attempt.id,
    laneId: step?.laneId ?? null,
    sessionId: args.attempt.executorSessionId ?? null,
    status,
    summary,
    filesChanged,
    testsRun,
    warnings,
    tokens,
    costUsd,
    suggestedNextActions:
      args.attempt.status === "failed"
        ? ["Investigate failure", "Review logs", "Retry with guidance"]
        : args.attempt.status === "running"
          ? ["Monitor progress"]
          : [],
    createdAt: nowIso()
  };
}

export function emitWorkerDigest(
  ctx: OrchestratorContext,
  digest: OrchestratorWorkerDigest
): OrchestratorWorkerDigest {
  const missionIdentity = getMissionIdentity(ctx, digest.missionId);
  if (!missionIdentity) return digest;
  ctx.db.run(
    `
      insert into orchestrator_worker_digests(
        id,
        project_id,
        mission_id,
        run_id,
        step_id,
        step_key,
        attempt_id,
        lane_id,
        session_id,
        status,
        summary,
        files_changed_json,
        tests_run_json,
        warnings_json,
        tokens_json,
        cost_usd,
        suggested_next_actions_json,
        created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      digest.id,
      missionIdentity.projectId,
      digest.missionId,
      digest.runId,
      digest.stepId,
      digest.stepKey,
      digest.attemptId,
      digest.laneId,
      digest.sessionId,
      digest.status,
      digest.summary,
      JSON.stringify(digest.filesChanged ?? []),
      JSON.stringify(digest.testsRun ?? { passed: 0, failed: 0, skipped: 0 }),
      JSON.stringify(digest.warnings ?? []),
      digest.tokens ? JSON.stringify(digest.tokens) : null,
      digest.costUsd ?? null,
      JSON.stringify(digest.suggestedNextActions ?? []),
      digest.createdAt
    ]
  );
  emitThreadEvent(ctx, {
    type: "worker_digest_updated",
    missionId: digest.missionId,
    runId: digest.runId,
    threadId: null,
    reason: "worker_digest",
    metadata: {
      digestId: digest.id,
      attemptId: digest.attemptId,
      stepId: digest.stepId
    }
  });
  return digest;
}

// ── Artifact Extraction ──────────────────────────────────────────

export function extractAndRegisterArtifacts(
  ctx: OrchestratorContext,
  args: {
    graph: OrchestratorRunGraph;
    attempt: OrchestratorRunGraph["attempts"][number];
  }
): void {
  try {
    const { graph, attempt } = args;
    const envelope = attempt.resultEnvelope;
    if (!envelope) return;
    const outputs = isRecord(envelope.outputs) ? envelope.outputs : {};

    const step = graph.steps.find((s) => s.id === attempt.stepId);
    const stepMeta = step && isRecord(step.metadata) ? step.metadata : {};
    const planStep = isRecord(stepMeta.planStep) ? stepMeta.planStep : null;
    const lastResultReport = isRecord(stepMeta.lastResultReport) ? stepMeta.lastResultReport : null;
    const artifactHints: string[] = Array.isArray(planStep?.artifactHints)
      ? (planStep!.artifactHints as unknown[]).map((h) => String(h ?? "").trim()).filter(Boolean)
      : [];
    const declaredKeySet = new Set(artifactHints);
    const registeredKeys = new Set<string>();

    const register = (artifactKey: string, kind: OrchestratorArtifactKind, value: string, metadata?: Record<string, unknown>) => {
      const isDeclared = declaredKeySet.has(artifactKey);
      ctx.orchestratorService.registerArtifact({
        missionId: graph.run.missionId,
        runId: attempt.runId,
        stepId: attempt.stepId,
        attemptId: attempt.id,
        artifactKey,
        kind,
        value,
        metadata: metadata ?? {},
        declared: isDeclared
      });
      registeredKeys.add(artifactKey);
      ctx.logger.debug("ai_orchestrator.artifact_registered", {
        runId: attempt.runId,
        stepId: attempt.stepId,
        attemptId: attempt.id,
        artifactKey,
        kind,
        declared: isDeclared
      });
    };

    const registerMissionArtifact = (args: {
      artifactType: "plan" | "summary" | "note" | "patch" | "link" | "pr" | "test_report" | "screenshot" | "browser_verification" | "browser_trace" | "video_recording" | "console_logs";
      title: string;
      description?: string | null;
      uri?: string | null;
      metadata?: Record<string, unknown>;
    }) => {
      try {
        ctx.missionService.addArtifact({
          missionId: graph.run.missionId,
          artifactType: args.artifactType,
          title: args.title,
          description: args.description,
          uri: args.uri,
          laneId: step?.laneId ?? null,
          metadata: {
            runId: attempt.runId,
            stepId: attempt.stepId,
            stepKey: step?.stepKey ?? null,
            attemptId: attempt.id,
            source: "orchestrator_worker_tracking",
            ...(args.metadata ?? {}),
          },
          createdBy: "system",
          actor: "system",
        });
      } catch (error) {
        ctx.logger.debug("ai_orchestrator.mission_artifact_register_failed", {
          missionId: graph.run.missionId,
          runId: attempt.runId,
          stepId: attempt.stepId,
          attemptId: attempt.id,
          title: args.title,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const reportedSummary =
      typeof lastResultReport?.summary === "string" ? lastResultReport.summary.trim() : "";
    const stepSummary = reportedSummary || (typeof envelope.summary === "string" ? envelope.summary.trim() : "");
    if (stepSummary.length > 0) {
      register("step_summary", "custom", stepSummary, {
        title: "Step summary",
        summary: stepSummary,
      });
    }

    // Extract file artifacts from filesChanged / filesModified
    const filesChangedRaw = outputs.filesChanged ?? outputs.files_changed ?? outputs.filesModified ?? outputs.files_modified;
    if (Array.isArray(filesChangedRaw) && filesChangedRaw.length > 0) {
      const files = filesChangedRaw.map((f) => String(f ?? "").trim()).filter(Boolean);
      if (files.length > 0) {
        register("files_changed", "file", files.join(", "), { fileCount: files.length, files: files.slice(0, 50) });
      }
    }

    // Extract test report artifacts
    const testsPassed = Number(outputs.testsPassed ?? outputs.tests_passed);
    const testsFailed = Number(outputs.testsFailed ?? outputs.tests_failed);
    const testsSkipped = Number(outputs.testsSkipped ?? outputs.tests_skipped);
    if (Number.isFinite(testsPassed) || Number.isFinite(testsFailed)) {
      const testSummary = typeof outputs.testsSummary === "string"
        ? outputs.testsSummary
        : typeof outputs.tests_summary === "string"
          ? outputs.tests_summary
          : `passed: ${testsPassed || 0}, failed: ${testsFailed || 0}, skipped: ${testsSkipped || 0}`;
      register("test_results", "test_report", testSummary, {
        passed: Number.isFinite(testsPassed) ? testsPassed : 0,
        failed: Number.isFinite(testsFailed) ? testsFailed : 0,
        skipped: Number.isFinite(testsSkipped) ? testsSkipped : 0
      });
    }

    // Extract branch artifact
    const branchName = outputs.branchName ?? outputs.branch_name ?? outputs.branch;
    if (typeof branchName === "string" && branchName.trim().length > 0) {
      register("feature_branch", "branch", branchName.trim());
    }

    // Extract PR artifact
    const prUrl = outputs.prUrl ?? outputs.pr_url ?? outputs.pullRequestUrl ?? outputs.pull_request_url;
    if (typeof prUrl === "string" && prUrl.trim().length > 0) {
      register("implementation_pr", "pr", prUrl.trim());
    }

    const reportArtifacts = Array.isArray(lastResultReport?.artifacts) ? lastResultReport.artifacts : [];
    reportArtifacts.forEach((entry, index) => {
      const artifact = isRecord(entry) ? entry : null;
      const rawTitle = artifact && typeof artifact.title === "string" ? artifact.title.trim() : "";
      const rawType = artifact && typeof artifact.type === "string" ? artifact.type.trim().toLowerCase() : "";
      const rawUri = artifact && typeof artifact.uri === "string" ? artifact.uri.trim() : "";
      const title = rawTitle || `Worker artifact ${index + 1}`;
      const metadata = isRecord(artifact?.metadata) ? artifact.metadata : {};
      const artifactKey = resolveReportArtifactKey({
        type: rawType,
        title: title,
        metadata,
        index,
      });
      const kind = resolveReportArtifactKind({
        type: rawType,
        artifactKey,
        uri: rawUri,
        metadata,
      });
      const value = rawUri.length
        ? rawUri
        : artifact?.metadata != null
          ? JSON.stringify(artifact.metadata)
          : title;
      register(artifactKey, kind, value, {
        title,
        type: rawType || "artifact",
        ...(metadata ?? {}),
      });
      const missionArtifactType = resolveReportArtifactMissionType({
        type: rawType,
        artifactKey,
        metadata,
      });
      if (missionArtifactType) {
        registerMissionArtifact({
          artifactType: missionArtifactType,
          title,
          description: rawUri.length > 0 ? null : title,
          uri: rawUri.length > 0 ? rawUri : null,
          metadata: {
            artifactKey,
            kind,
            sourceType: rawType || "artifact",
            ...metadata,
          },
        });
      }
    });

    // Match remaining output keys against declared artifactHints
    for (const hintKey of artifactHints) {
      if (registeredKeys.has(hintKey)) continue;
      // Check if outputs has a matching key (camelCase or snake_case)
      const value = outputs[hintKey] ?? outputs[hintKey.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
      if (value != null) {
        const strValue = typeof value === "string" ? value : JSON.stringify(value);
        register(hintKey, "custom", strValue, { raw: value });
      }
    }

    // Register planning artifact for planning steps
    const stepType = typeof stepMeta.stepType === "string" ? stepMeta.stepType.trim().toLowerCase() : "";
    const phaseKey = typeof stepMeta.phaseKey === "string" ? stepMeta.phaseKey.trim().toLowerCase() : "";
    const isPlanningStep = stepType === "planning" || stepType === "analysis" || phaseKey === "planning";
    if (isPlanningStep && !registeredKeys.has("plan")) {
      const reportedPlan = isRecord(lastResultReport?.plan) ? lastResultReport.plan : null;
      const planSummary =
        typeof reportedPlan?.summary === "string" && reportedPlan.summary.trim().length > 0
          ? reportedPlan.summary.trim()
          : typeof envelope.summary === "string" && envelope.summary.trim().length > 0
          ? envelope.summary.trim()
          : "Planning step completed.";
      const planMarkdown =
        typeof reportedPlan?.markdown === "string" && reportedPlan.markdown.trim().length > 0
          ? reportedPlan.markdown.trim()
          : "";
      const requestedPlanPath =
        typeof reportedPlan?.artifactPath === "string" && reportedPlan.artifactPath.trim().length > 0
          ? reportedPlan.artifactPath.trim()
          : typeof outputs.planPath === "string" && outputs.planPath.trim().length > 0
            ? outputs.planPath.trim()
            : "";
      const planValue =
        requestedPlanPath.startsWith(".ade/plans/")
          ? requestedPlanPath
          : ".ade/plans/mission-plan.md";
      const laneWorktreeRow = step?.laneId
        ? ctx.db.get<{ worktree_path: string | null }>(
            `select worktree_path from lanes where id = ? limit 1`,
            [step.laneId]
          )
        : null;
      const worktreePath = typeof laneWorktreeRow?.worktree_path === "string" && laneWorktreeRow.worktree_path.trim().length > 0
        ? laneWorktreeRow.worktree_path.trim()
        : ctx.projectRoot ?? null;
      const absolutePlanPath = worktreePath
        ? (path.isAbsolute(planValue) ? planValue : path.join(worktreePath, planValue))
        : (path.isAbsolute(planValue) ? planValue : null);
      if (absolutePlanPath && planMarkdown.length > 0) {
        fs.mkdirSync(path.dirname(absolutePlanPath), { recursive: true });
        fs.writeFileSync(absolutePlanPath, planMarkdown.endsWith("\n") ? planMarkdown : `${planMarkdown}\n`, "utf8");
        register("plan", "custom", planValue, {
          planType: "mission_plan",
          source: "ade_persisted_plan",
          summary: planSummary,
          absolutePath: absolutePlanPath,
        });
        registerMissionArtifact({
          artifactType: "plan",
          title: "Mission plan",
          description: planSummary,
          uri: planValue,
          metadata: {
            planType: "mission_plan",
            absolutePath: absolutePlanPath,
          },
        });
      } else {
        const missingPlanDetail = "Planning worker completed without returning a usable plan payload in report_result.plan.markdown.";
        ctx.logger.warn("ai_orchestrator.plan_artifact_missing", {
          missionId: graph.run.missionId,
          runId: attempt.runId,
          stepId: attempt.stepId,
          attemptId: attempt.id,
          expectedPlanPath: planValue,
          absolutePlanPath,
        });
        ctx.orchestratorService.appendTimelineEvent({
          runId: attempt.runId,
          stepId: attempt.stepId,
          attemptId: attempt.id,
          eventType: "planning_artifact_missing",
          reason: "plan_payload_missing",
          detail: {
            expectedPlanPath: planValue,
            absolutePlanPath,
            summary: planSummary,
          },
        });
        const intervention = ctx.missionService.addIntervention({
          missionId: graph.run.missionId,
          interventionType: "failed_step",
          title: "Planner result missing plan",
          body: missingPlanDetail,
          requestedAction: "Retry planning only after the planner can return report_result.plan.markdown. ADE will persist the canonical plan artifact after completion.",
          metadata: {
            runId: attempt.runId,
            stepId: step?.id ?? attempt.stepId,
            stepKey: step?.stepKey ?? null,
            ...(phaseKey.length > 0 ? { phaseKey } : {}),
            ...(stepType.length > 0 ? { stepType } : {}),
            reasonCode: "planner_plan_missing",
            expectedPlanPath: planValue,
          },
        });
        ctx.orchestratorService.appendRuntimeEvent({
          runId: attempt.runId,
          stepId: attempt.stepId,
          attemptId: attempt.id,
          sessionId: attempt.executorSessionId ?? null,
          eventType: "intervention_opened",
          eventKey: `intervention_opened:${intervention.id}`,
          payload: {
            interventionId: intervention.id,
            interventionType: intervention.interventionType,
            reason: "planner_plan_missing",
            expectedPlanPath: planValue,
          },
        });
      }
    }

    // Validate: warn for any declared hints that were not produced
    const missingHints = artifactHints.filter((hint) => !registeredKeys.has(hint));
    if (missingHints.length > 0) {
      ctx.logger.info("ai_orchestrator.artifact_hints_missing", {
        runId: attempt.runId,
        stepId: attempt.stepId,
        attemptId: attempt.id,
        stepKey: step?.stepKey ?? null,
        missingHints,
        producedKeys: Array.from(registeredKeys)
      });
      // Record a timeline event for the missing artifacts
      ctx.orchestratorService.appendTimelineEvent({
        runId: attempt.runId,
        stepId: attempt.stepId,
        attemptId: attempt.id,
        eventType: "artifact_hints_missing",
        reason: "artifact_validation",
        detail: {
          missingHints,
          producedKeys: Array.from(registeredKeys),
          totalDeclared: artifactHints.length,
          totalProduced: registeredKeys.size
        }
      });
    }
  } catch (error) {
    ctx.logger.debug("ai_orchestrator.artifact_extraction_failed", {
      runId: args.attempt.runId,
      stepId: args.attempt.stepId,
      attemptId: args.attempt.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// ── updateWorkerStateFromEvent ───────────────────────────────────

export type UpdateWorkerStateDeps = {
  recordRuntimeEvent: (...args: any[]) => void;
  evaluateWorkerPlan: (...args: any[]) => Promise<any>;
  propagateHandoffContext: (...args: any[]) => void;
  steerMission: (...args: any[]) => any;
  handleInterventionWithAI: (...args: any[]) => Promise<any>;
  appendChatMessage: (message: OrchestratorChatMessage) => OrchestratorChatMessage;
};

export function updateWorkerStateFromEventCtx(
  ctx: OrchestratorContext,
  event: OrchestratorRuntimeEvent,
  deps: UpdateWorkerStateDeps
): void {
  if (event.type !== "orchestrator-attempt-updated" || !event.attemptId || !event.runId) return;

  try {
    const graph = ctx.orchestratorService.getRunGraph({ runId: event.runId, timelineLimit: 0 });
    const attempt = graph.attempts.find((a) => a.id === event.attemptId);
    if (!attempt) return;

    const stepForAttempt = graph.steps.find((s) => s.id === attempt.stepId);
    const stepTitle = stepForAttempt?.title ?? stepForAttempt?.stepKey ?? attempt.stepId.slice(0, 8);
    const stepKey = stepForAttempt?.stepKey ?? null;

    if (attempt.status === "running") {
      const attemptMeta = isRecord(attempt.metadata) ? attempt.metadata : {};
      const workerSessionKind = typeof attemptMeta.workerSessionKind === "string" ? attemptMeta.workerSessionKind.trim() : "";
      const nextWorkerState = workerSessionKind === "managed_chat" ? "initializing" : "working";
      const existing = ctx.workerStates.get(attempt.id);
      const shouldAnnounceStart = !existing || (existing.state !== "working" && existing.state !== "initializing");
      upsertWorkerState(ctx, attempt.id, {
        stepId: attempt.stepId,
        runId: attempt.runId,
        sessionId: attempt.executorSessionId,
        executorKind: attempt.executorKind,
        state: nextWorkerState
      });
      if (shouldAnnounceStart) {
        emitOrchestratorMessage(
          ctx,
          graph.run.missionId,
          `Started worker "${stepTitle}". It is now working on this step.`,
          stepKey,
          null,
          { appendChatMessage: deps.appendChatMessage }
        );
        emitWorkerDigest(ctx, buildWorkerDigestFromAttempt({ graph, attempt }));

        try {
          ensureThreadForTarget(ctx, {
            missionId: graph.run.missionId,
            target: {
              kind: "worker",
              runId: attempt.runId,
              stepId: attempt.stepId,
              stepKey: stepKey,
              attemptId: attempt.id,
              sessionId: attempt.executorSessionId ?? null,
              laneId: stepForAttempt?.laneId ?? null,
            },
            fallbackTitle: `Worker: ${stepTitle}`,
          });
        } catch (_threadErr) {
          /* best-effort */
        }
        appendWorkerThreadLifecycleMessage({
          ctx,
          deps,
          missionId: graph.run.missionId,
          attempt,
          step: stepForAttempt,
          stepTitle,
          stepKey,
          content: buildWorkerLifecycleStartMessage(stepForAttempt),
          metadataSource: "worker_lifecycle_started",
        });
      }
      recordMissionMetricSample(ctx, {
        missionId: graph.run.missionId,
        runId: attempt.runId,
        attemptId: attempt.id,
        metric: "implementation",
        value: 1,
        unit: "attempt",
        metadata: {
          status: attempt.status,
          executorKind: attempt.executorKind
        }
      });
    } else if (attempt.status === "succeeded") {
      ctx.attemptRuntimeTrackers.delete(attempt.id);
      deletePersistedAttemptRuntimeState(ctx, attempt.id);
      const outcomeTags = extractOutcomeTags(attempt);
      const digest = emitWorkerDigest(ctx, buildWorkerDigestFromAttempt({ graph, attempt }));
      const existing = ctx.workerStates.get(attempt.id);
      const shouldAnnounceCompletion = !existing || existing.state !== "completed";
      upsertWorkerState(ctx, attempt.id, {
        stepId: attempt.stepId,
        runId: attempt.runId,
        sessionId: attempt.executorSessionId,
        executorKind: attempt.executorKind,
        state: "completed",
        outcomeTags,
        completedAt: attempt.completedAt ?? nowIso()
      });
      const resultSummary = attempt.resultEnvelope?.summary
        ? ` — ${attempt.resultEnvelope.summary.slice(0, 120)}`
        : "";
      if (shouldAnnounceCompletion) {
        emitOrchestratorMessage(
          ctx,
          graph.run.missionId,
          `Finished "${stepTitle}"${resultSummary}`,
          stepKey,
          null,
          { appendChatMessage: deps.appendChatMessage }
        );
        appendWorkerThreadLifecycleMessage({
          ctx,
          deps,
          missionId: graph.run.missionId,
          attempt,
          step: stepForAttempt,
          stepTitle,
          stepKey,
          content: buildWorkerLifecycleCompletionMessage(stepForAttempt, attempt.resultEnvelope?.summary),
          metadataSource: "worker_lifecycle_completed",
        });
      }
      if (digest.tokens?.total != null) {
        recordMissionMetricSample(ctx, {
          missionId: graph.run.missionId,
          runId: attempt.runId,
          attemptId: attempt.id,
          metric: "tokens",
          value: digest.tokens.total,
          unit: "tokens"
        });
      }
      if (digest.costUsd != null) {
        recordMissionMetricSample(ctx, {
          missionId: graph.run.missionId,
          runId: attempt.runId,
          attemptId: attempt.id,
          metric: "cost",
          value: digest.costUsd,
          unit: "usd"
        });
      }

      // Extract and register artifacts from the worker result envelope.
      extractAndRegisterArtifacts(ctx, { graph, attempt });

      // Evaluation loop: evaluate step based on active runtime profile.
      const step = graph.steps.find((s) => s.id === attempt.stepId);
      if (step) {
        resolveRecoveredFailedStepInterventions({
          ctx,
          deps,
          missionId: graph.run.missionId,
          attempt,
          step,
        });
        resolvePlannerPlanMissingInterventionsAfterPlanningSuccess({
          ctx,
          deps,
          missionId: graph.run.missionId,
          attempt,
          step,
        });
      }
      if (step && ctx.aiIntegrationService) {
        const runtimeProfile = ctx.runRuntimeProfiles.get(attempt.runId) ?? resolveActiveRuntimeProfile(ctx, graph.run.missionId);
        const isFinalStep = graph.steps.every(
          (s) => s.id === step.id || s.status === "succeeded" || s.status === "failed" || s.status === "skipped"
        );
        const stepMeta = isRecord(step.metadata) ? step.metadata : {};
        const completionCriteria = typeof stepMeta.completionCriteria === "string" ? stepMeta.completionCriteria : "";
        const hasCriteria = completionCriteria.length > 0 && completionCriteria !== "step_done";

        const coordForEval = ctx.coordinatorAgents.get(attempt.runId);
        if (!coordForEval?.isAlive && hasCriteria && (runtimeProfile.evaluation.evaluateEveryStep || isFinalStep)) {
          deps.evaluateWorkerPlan({
            attemptId: attempt.id,
            workerPlan: {
              stepKey: step.stepKey,
              status: step.status,
              outcomeTags,
              completionCriteria,
              resultSummary: attempt.resultEnvelope?.summary ?? null
            },
            provider: resolveEvaluationProvider(attempt)
          }).then((evalResult: any) => {
            emitOrchestratorMessage(
              ctx,
              graph.run.missionId,
              evalResult.approved
                ? `Step "${stepTitleForMessage(step)}" passed evaluation. ${evalResult.feedback}`
                : `Step "${stepTitleForMessage(step)}" failed evaluation: ${evalResult.feedback}.`,
              step.stepKey,
              null,
              { appendChatMessage: deps.appendChatMessage }
            );
            if (!evalResult.approved) {
              ctx.logger.info("ai_orchestrator.step_evaluation_rejected", {
                runId: attempt.runId,
                stepId: step.id,
                feedback: evalResult.feedback
              });
            }
          }).catch((error: unknown) => {
            ctx.logger.debug("ai_orchestrator.step_evaluation_failed", {
              runId: attempt.runId,
              stepId: step.id,
              error: error instanceof Error ? error.message : String(error)
            });
          });
        }
      }

      // Propagate structured handoff context to downstream steps
      deps.propagateHandoffContext({
        runId: attempt.runId,
        completedStepId: attempt.stepId,
        digest
      });

      // Transition handling is AI-driven via runtime attempt_completed events.
    } else if (attempt.status === "failed") {
      ctx.attemptRuntimeTrackers.delete(attempt.id);
      deletePersistedAttemptRuntimeState(ctx, attempt.id);
      const outcomeTags = extractOutcomeTags(attempt);
      const digest = emitWorkerDigest(ctx, buildWorkerDigestFromAttempt({ graph, attempt }));
      const existing = ctx.workerStates.get(attempt.id);
      const shouldAnnounceFailure = !existing || existing.state !== "failed";
      upsertWorkerState(ctx, attempt.id, {
        stepId: attempt.stepId,
        runId: attempt.runId,
        sessionId: attempt.executorSessionId,
        executorKind: attempt.executorKind,
        state: "failed",
        outcomeTags,
        completedAt: attempt.completedAt ?? nowIso()
      });

      // Check for retry exhaustion → create real intervention then trigger AI
      const step = graph.steps.find((s) => s.id === attempt.stepId);
      const retryQueued = isRetryQueuedForStep(step);
      const retriesLeft = step ? Math.max(0, step.retryLimit - step.retryCount) : 0;
      if (shouldAnnounceFailure) {
        emitOrchestratorMessage(
          ctx,
          graph.run.missionId,
          `Step "${stepTitle}" failed: ${attempt.errorMessage ?? "unknown error"}. ${
            retryQueued
              ? `Retry scheduled${retriesLeft > 0 ? ` (${retriesLeft} retries left).` : "."}`
              : "No retries remaining."
          }`,
          stepKey,
          null,
          { appendChatMessage: deps.appendChatMessage }
        );
        appendWorkerThreadLifecycleMessage({
          ctx,
          deps,
          missionId: graph.run.missionId,
          attempt,
          step: stepForAttempt,
          stepTitle,
          stepKey,
          content: buildWorkerLifecycleFailureMessage(attempt),
          metadataSource: "worker_lifecycle_failed",
        });
      }
      recordMissionMetricSample(ctx, {
        missionId: graph.run.missionId,
        runId: attempt.runId,
        attemptId: attempt.id,
        metric: "retries",
        value: step?.retryCount ?? 0,
        unit: "count",
        metadata: {
          retryLimit: step?.retryLimit ?? null
        }
      });
      if (digest.tokens?.total != null) {
        recordMissionMetricSample(ctx, {
          missionId: graph.run.missionId,
          runId: attempt.runId,
          attemptId: attempt.id,
          metric: "tokens",
          value: digest.tokens.total,
          unit: "tokens"
        });
      }
      if (digest.costUsd != null) {
        recordMissionMetricSample(ctx, {
          missionId: graph.run.missionId,
          runId: attempt.runId,
          attemptId: attempt.id,
          metric: "cost",
          value: digest.costUsd,
          unit: "usd"
        });
      }
      if (step && step.status === "failed") {
        try {
          const stepMetadata = isRecord(step.metadata) ? step.metadata : {};
          const phaseKey = typeof stepMetadata.phaseKey === "string" ? stepMetadata.phaseKey.trim() : "";
          const stepType = typeof stepMetadata.stepType === "string" ? stepMetadata.stepType.trim() : "";
          const plannerContractFailure = attempt.errorClass === "planner_contract_violation";
          const retryExhausted = step.retryCount >= step.retryLimit;
          let openedInterventionId: string | null = null;
          if (plannerContractFailure || retryExhausted) {
            const interventionSpec = plannerContractFailure
              ? resolvePlannerPlanMissingIntervention({
                  attempt,
                  step,
                  stepTitle: stepTitleForMessage(step),
                })
              : resolveRetryExhaustedIntervention({
                  attempt,
                  step,
                  stepTitle: stepTitleForMessage(step),
                });
            if (!plannerContractFailure) {
              deps.recordRuntimeEvent({
                runId: attempt.runId,
                stepId: step.id,
                attemptId: attempt.id,
                sessionId: attempt.executorSessionId,
                eventType: "retry_exhausted",
                eventKey: `retry_exhausted:${step.id}`,
                payload: {
                  retryCount: step.retryCount,
                  retryLimit: step.retryLimit,
                  lastError: attempt.errorMessage ?? "unknown"
                }
              });
            }
            const intervention = ctx.missionService.addIntervention({
              missionId: graph.run.missionId,
              interventionType: interventionSpec.interventionType,
              title: interventionSpec.title,
              body: interventionSpec.body,
              requestedAction: interventionSpec.requestedAction,
              metadata: {
                runId: attempt.runId,
                stepId: step.id,
                stepKey: step.stepKey,
                ...(phaseKey.length > 0 ? { phaseKey } : {}),
                ...(stepType.length > 0 ? { stepType } : {}),
                reasonCode: interventionSpec.reasonCode,
              }
            });
            deps.recordRuntimeEvent({
              runId: attempt.runId,
              stepId: step.id,
              attemptId: attempt.id,
              sessionId: attempt.executorSessionId,
              eventType: "intervention_opened",
              eventKey: `intervention_opened:${intervention.id}`,
              payload: {
                interventionId: intervention.id,
                interventionType: intervention.interventionType,
                reason: interventionSpec.reasonCode,
                ...(plannerContractFailure ? { expectedPlanPath: ".ade/plans/mission-plan.md" } : {}),
              }
            });
            openedInterventionId = intervention.id;
          }

          const coordForDiag = ctx.coordinatorAgents.get(attempt.runId);
          if (!coordForDiag?.isAlive && ctx.aiIntegrationService && ctx.projectRoot) {
            // AI failure diagnosis that DECIDES and ACTS, not just describes (one-shot fallback when no coordinator)
            const diagConfig = resolveCallTypeConfig(ctx, graph.run.missionId, "coordinator");
            void (async () => {
              try {
                const fullGraph = ctx.orchestratorService.getRunGraph({ runId: attempt.runId, timelineLimit: 5 });
                const succeededContext = fullGraph.steps
                  .filter((s) => s.status === "succeeded")
                  .slice(0, 5)
                  .map((s) => {
                    const lastAttempt = fullGraph.attempts
                      .filter((a) => a.stepId === s.id && a.status === "succeeded")
                      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
                    return `  - ${s.stepKey}: ${lastAttempt?.resultEnvelope?.summary?.slice(0, 150) ?? "completed"}`;
                  });
                const blockedByThis = fullGraph.steps.filter((s) =>
                  s.dependencyStepIds.includes(step.id) && s.status === "blocked"
                );

                const diagPrompt = [
                  PM_SYSTEM_PREAMBLE,
                  "Your current role: FAILURE DIAGNOSTICIAN AND DECISION MAKER.",
                  "A step has exhausted all retries. You must DECIDE and ACT, not just describe the problem.",
                  "",
                  `Failed step: "${stepTitleForMessage(step)}" (key: ${step.stepKey})`,
                  `Retries: ${step.retryCount}/${step.retryLimit}`,
                  `Last error: ${attempt.errorMessage ?? "unknown"}`,
                  `Step instructions: ${(isRecord(step.metadata) && typeof step.metadata.instructions === "string") ? step.metadata.instructions.slice(0, 500) : "N/A"}`,
                  succeededContext.length > 0 ? `\nCompleted steps for context:\n${succeededContext.join("\n")}` : "",
                  blockedByThis.length > 0 ? `\nSteps BLOCKED by this failure: ${blockedByThis.map((s) => `"${s.title}"`).join(", ")}` : "",
                  "",
                  "Choose ONE action:",
                  "- skip: Non-critical step. Provide downstreamGuidance for blocked steps.",
                  "- workaround: Add a new step achieving the same goal differently. Provide workaroundStep details.",
                  "- retry: Provide revisedInstructions addressing the root cause.",
                  "- escalate: ONLY if you truly need human input. Explain exactly what's needed.",
                  "",
                  "BIAS TOWARD ACTION. 'workaround' or 'skip' is almost always better than 'escalate'."
                ].join("\n");

                const diagSchema = {
                  type: "object",
                  properties: {
                    rootCause: { type: "string" },
                    category: { type: "string", enum: ["code", "environment", "design", "dependency", "unknown"] },
                    recommendation: { type: "string", enum: ["retry", "skip", "workaround", "escalate"] },
                    details: { type: "string" },
                    revisedInstructions: { type: "string" },
                    workaroundStep: {
                      type: "object",
                      properties: {
                        title: { type: "string" },
                        instructions: { type: "string" },
                        executorKind: { type: "string", enum: ["claude", "codex", "cursor", "opencode", "manual"] }
                      }
                    },
                    downstreamGuidance: { type: "string" }
                  },
                  required: ["rootCause", "category", "recommendation", "details"]
                };

                const diagResult = await ctx.aiIntegrationService!.executeTask({
                  feature: "orchestrator",
                  taskType: "review",
                  prompt: diagPrompt,
                  cwd: ctx.projectRoot!,
                  provider: diagConfig.provider,
                  reasoningEffort: diagConfig.reasoningEffort,
                  jsonSchema: diagSchema,
                  oneShot: true,
                  timeoutMs: 45_000
                });

                const diagParsed = isRecord(diagResult.structuredOutput) ? diagResult.structuredOutput : null;
                const recommendation = String(diagParsed?.recommendation ?? "escalate");
                const rootCause = String(diagParsed?.rootCause ?? diagResult.text?.slice(0, 500) ?? "Unknown");

                ctx.logger.info("ai_orchestrator.failure_diagnosis_completed", {
                  runId: attempt.runId,
                  stepId: step.id,
                  recommendation,
                  rootCause: rootCause.slice(0, 200)
                });
                emitOrchestratorMessage(
                  ctx,
                  graph.run.missionId,
                  `[FAILURE DIAGNOSIS] "${stepTitleForMessage(step)}": ${rootCause.slice(0, 300)} → Action: ${recommendation}`,
                  step.stepKey,
                  null,
                  { appendChatMessage: deps.appendChatMessage }
                );

                // ACT on the diagnosis
                if (recommendation === "skip") {
                  try {
                    ctx.orchestratorService.skipStep({
                      runId: attempt.runId,
                      stepId: step.id,
                      reason: `AI diagnosis: ${rootCause.slice(0, 200)}`
                    });
                    if (typeof diagParsed?.downstreamGuidance === "string" && blockedByThis.length > 0) {
                      for (const blocked of blockedByThis) {
                        deps.steerMission({
                          missionId: graph.run.missionId,
                          directive: `Previous step "${stepTitleForMessage(step)}" was skipped. Guidance: ${diagParsed.downstreamGuidance}`,
                          priority: "instruction",
                          targetStepKey: blocked.stepKey
                        });
                      }
                    }
                    emitOrchestratorMessage(ctx, graph.run.missionId, `AI auto-skipped failed step "${stepTitleForMessage(step)}"`, step.stepKey, null, { appendChatMessage: deps.appendChatMessage });
                    void ctx.orchestratorService.startReadyAutopilotAttempts({ runId: attempt.runId, reason: "ai_diagnosis_skip" }).catch(() => {});
                  } catch (skipErr) {
                    ctx.logger.debug("ai_orchestrator.diagnosis_skip_failed", { error: skipErr instanceof Error ? skipErr.message : String(skipErr) });
                  }
                } else if (recommendation === "workaround" && isRecord(diagParsed?.workaroundStep)) {
                  try {
                    const ws = diagParsed.workaroundStep;
                    const workaroundKey = `workaround-${step.stepKey}-${Date.now()}`;
                    ctx.orchestratorService.addSteps({
                      runId: attempt.runId,
                      steps: [{
                        stepKey: workaroundKey,
                        title: typeof ws.title === "string" ? ws.title : `Workaround for ${stepTitleForMessage(step)}`,
                        stepIndex: step.stepIndex + 1,
                        dependencyStepKeys: [],
                        executorKind: (
                          typeof ws.executorKind === "string"
                          && ["claude", "codex", "cursor", "opencode", "manual"].includes(ws.executorKind)
                            ? ws.executorKind
                            : "opencode"
                        ) as OrchestratorExecutorKind,
                        retryLimit: 2,
                        metadata: {
                          instructions: typeof ws.instructions === "string" ? ws.instructions : "",
                          aiGenerated: true,
                          generationReason: `workaround for failed ${step.stepKey}: ${rootCause.slice(0, 200)}`
                        }
                      }]
                    });
                    // Remap blocked steps to depend on workaround instead
                    for (const blocked of blockedByThis) {
                      try {
                        const currentDeps = blocked.dependencyStepIds
                          .map((depId) => fullGraph.steps.find((d) => d.id === depId)?.stepKey)
                          .filter((k): k is string => !!k);
                        const newDeps = currentDeps.map((k) => k === step.stepKey ? workaroundKey : k);
                        ctx.orchestratorService.updateStepDependencies({
                          runId: attempt.runId,
                          stepId: blocked.id,
                          dependencyStepKeys: newDeps
                        });
                      } catch {
                        // Best-effort dependency remap
                      }
                    }
                    emitOrchestratorMessage(ctx, graph.run.missionId, `AI added workaround for "${stepTitleForMessage(step)}"`, workaroundKey, null, { appendChatMessage: deps.appendChatMessage });
                    void ctx.orchestratorService.startReadyAutopilotAttempts({ runId: attempt.runId, reason: "ai_diagnosis_workaround" }).catch(() => {});
                  } catch (workaroundErr) {
                    ctx.logger.debug("ai_orchestrator.diagnosis_workaround_failed", { error: workaroundErr instanceof Error ? workaroundErr.message : String(workaroundErr) });
                  }
                }
                // retry and escalate fall through to intervention handling below
              } catch (diagError) {
                ctx.logger.debug("ai_orchestrator.failure_diagnosis_failed", {
                  runId: attempt.runId,
                  stepId: step.id,
                  error: diagError instanceof Error ? diagError.message : String(diagError)
                });
              }
            })();

            // Also attempt auto-resolution if configured
            const runtimeProfile = ctx.runRuntimeProfiles.get(attempt.runId) ?? resolveActiveRuntimeProfile(ctx, graph.run.missionId);
            if (openedInterventionId && runtimeProfile.evaluation.autoResolveInterventions) {
              deps.handleInterventionWithAI({
                missionId: graph.run.missionId,
                interventionId: openedInterventionId,
                provider: resolveEvaluationProvider(attempt)
              }).catch((error: unknown) => {
                ctx.logger.debug("ai_orchestrator.auto_intervention_failed", {
                  runId: event.runId,
                  stepId: step.id,
                  error: error instanceof Error ? error.message : String(error)
                });
              });
            }
          }
        } catch (interventionError) {
          ctx.logger.debug("ai_orchestrator.create_intervention_failed", {
            runId: event.runId,
            stepId: step.id,
            error: interventionError instanceof Error ? interventionError.message : String(interventionError)
          });
        }
      }
    }
  } catch (error) {
    ctx.logger.debug("ai_orchestrator.worker_state_update_failed", {
      attemptId: event.attemptId,
      runId: event.runId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
