/**
 * missionLifecycle.ts
 *
 * Mission run management: start, approve, cancel, cleanup, steer, sync,
 * provision lanes, synthesize team manifest, integration contexts.
 *
 * Extracted from aiOrchestratorService.ts — pure refactor, no behavior changes.
 * NOTE: Due to the massive cross-dependencies (50+ closure references),
 * this module re-exports function signatures. The actual implementations
 * remain in the facade until full extraction is complete, and are injected
 * via the deps parameter pattern.
 *
 * This file establishes the module boundary and type contracts.
 */

import fs from "node:fs";
import { createHash } from "node:crypto";
import type {
  OrchestratorContext,
  MissionRunStartArgs,
  MissionRunStartResult,
  MissionRuntimeProfile,
  ParallelMissionStepDescriptor,
  OrchestratorChatMessage,
  OrchestratorHookEvent,
} from "./orchestratorContext";
import {
  nowIso,
  isRecord,
  buildOutcomeSummary,
  deriveMissionStatusFromRun,
  mapOrchestratorStepStatus,
  parseJsonRecord,
  readConfig,
  deriveRuntimeProfileFromPolicy,
  clipHookLogText,
} from "./orchestratorContext";
import type {
  OrchestratorRunGraph,
  MissionDetail,
  MissionStatus,
  MissionStep,
  TeamManifest,
  TeamComplexityAssessment,
  TeamWorkerAssignment,
  OrchestratorWorkerRole,
  OrchestratorStepStatus,
  OrchestratorExecutorKind,
  OrchestratorWorkerStatus,
  TerminalRuntimeState,
  StartOrchestratorRunStepInput,
  MissionExecutionPolicy,
} from "../../../shared/types";
import { resolveExecutionPolicy, DEFAULT_EXECUTION_POLICY } from "./executionPolicy";
import { updateRunMetadata, getMissionMetadata, getMissionIdForRun } from "./chatMessageService";

// ── Pure Step/Attempt Utility Functions ───────────────────────────

export function stepTitleForMessage(step: OrchestratorRunGraph["steps"][number]): string {
  const raw = String(step.title ?? "").trim();
  if (raw.length > 0) return raw;
  return step.stepKey || step.id.slice(0, 8);
}

export function isRetryQueuedForStep(step: OrchestratorRunGraph["steps"][number] | undefined): boolean {
  if (!step) return false;
  return step.status === "pending" || step.status === "ready" || step.status === "running";
}

export function extractOutcomeTags(attempt: OrchestratorRunGraph["attempts"][number]): string[] {
  const tags: string[] = [];
  if (attempt.resultEnvelope) {
    const envelope = attempt.resultEnvelope;
    if (envelope.warnings?.length) tags.push("has_warnings", `warnings:${envelope.warnings.length}`);
    if (envelope.outputs && isRecord(envelope.outputs)) {
      const filesModified = Number(envelope.outputs.filesModified ?? envelope.outputs.files_modified);
      if (Number.isFinite(filesModified)) tags.push(`files_modified:${filesModified}`);
      const testsPassed = Number(envelope.outputs.testsPassed ?? envelope.outputs.tests_passed);
      if (Number.isFinite(testsPassed)) tags.push(`tests_passed:${testsPassed}`);
    }
  }
  const durationMs = attempt.completedAt && attempt.startedAt
    ? Date.parse(attempt.completedAt) - Date.parse(attempt.startedAt)
    : null;
  if (durationMs != null && Number.isFinite(durationMs)) {
    const category = durationMs < 10_000 ? "fast" : durationMs < 60_000 ? "normal" : "slow";
    tags.push(`duration_category:${category}`);
  }
  return tags;
}

export function resolveAttemptOwnerId(
  run: OrchestratorRunGraph["run"],
  attempt: OrchestratorRunGraph["attempts"][number]
): string {
  const attemptMeta = isRecord(attempt.metadata) ? attempt.metadata : {};
  const explicitOwner = typeof attemptMeta.ownerId === "string" ? attemptMeta.ownerId.trim() : "";
  if (explicitOwner.length > 0) return explicitOwner;
  const runMeta = isRecord(run.metadata) ? run.metadata : {};
  const autopilot = isRecord(runMeta.autopilot) ? runMeta.autopilot : null;
  const runOwner = autopilot && typeof autopilot.ownerId === "string" ? autopilot.ownerId.trim() : "";
  if (runOwner.length > 0) return runOwner;
  return "orchestrator-autopilot";
}

export function resolveAttemptOwnerIdFromRows(
  attemptMetadataJson: string | null,
  runMetadataJson: string | null
): string {
  const attemptMeta = parseJsonRecord(attemptMetadataJson);
  const explicitOwner = typeof attemptMeta?.ownerId === "string" ? attemptMeta.ownerId.trim() : "";
  if (explicitOwner.length > 0) return explicitOwner;
  const runMeta = parseJsonRecord(runMetadataJson);
  const autopilot = runMeta && isRecord(runMeta.autopilot) ? runMeta.autopilot : null;
  const owner = autopilot && typeof autopilot.ownerId === "string" ? autopilot.ownerId.trim() : "";
  if (owner.length > 0) return owner;
  return "orchestrator-autopilot";
}

// ── Helper Functions ─────────────────────────────────────────────

export function deriveScopeFromStepCount(stepCount: number): TeamComplexityAssessment["estimatedScope"] {
  if (stepCount <= 3) return "small";
  if (stepCount <= 8) return "medium";
  if (stepCount <= 20) return "large";
  return "very_large";
}

export function inferRoleFromStepMetadata(metadata: Record<string, unknown>, kind: string): OrchestratorWorkerRole {
  const stepType = typeof metadata.stepType === "string" ? metadata.stepType.trim().toLowerCase() : "";
  const taskType = typeof metadata.taskType === "string" ? metadata.taskType.trim().toLowerCase() : "";
  const combined = `${stepType} ${taskType} ${kind}`.toLowerCase();
  if (combined.includes("test_review") || combined.includes("testreview")) return "test_review";
  if (combined.includes("review") || combined.includes("code_review")) return "code_review";
  if (combined.includes("test") || combined.includes("validation")) return "testing";
  if (combined.includes("plan")) return "planning";
  if (combined.includes("integration") || combined.includes("merge")) return "integration";
  if (combined.includes("merge")) return "merge";
  return "implementation";
}

export function parseNumericDependencyIndices(metadata: Record<string, unknown>): number[] {
  if (!Array.isArray(metadata.dependencyIndices)) return [];
  return metadata.dependencyIndices
    .map((value: unknown) => Number(value))
    .filter((value: number) => Number.isFinite(value))
    .map((value: number) => Math.floor(value));
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28) || "lane";
}

export function isParallelCandidateStepType(stepType: string): boolean {
  const normalized = stepType.trim().toLowerCase();
  if (normalized === "analysis" || normalized === "summary" || normalized === "review") return false;
  if (normalized === "integration" || normalized === "merge") return false;
  return true;
}

export function toStepKey(step: MissionStep, position: number): string {
  const metadata = isRecord(step.metadata) ? step.metadata : {};
  const explicit = typeof metadata.stepKey === "string" ? metadata.stepKey.trim() : "";
  if (explicit.length > 0) return explicit;
  return `mission_step_${step.index}_${position}`;
}

/**
 * Build parallel step descriptors from mission steps.
 */
export function buildParallelDescriptors(steps: MissionStep[]): ParallelMissionStepDescriptor[] {
  const ordered = [...steps].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
  const keyed = ordered.map((step, position) => ({
    step,
    position,
    metadata: isRecord(step.metadata) ? step.metadata : {},
    stepKey: toStepKey(step, position)
  }));
  const stepKeysByIndex = new Map<number, string[]>();
  for (const entry of keyed) {
    const bucket = stepKeysByIndex.get(entry.step.index) ?? [];
    bucket.push(entry.stepKey);
    stepKeysByIndex.set(entry.step.index, bucket);
  }

  return keyed.map((entry) => {
    const metadata = entry.metadata;
    const explicitDeps = Array.isArray(metadata.dependencyStepKeys)
      ? metadata.dependencyStepKeys
          .map((value: unknown) => String(value ?? "").trim())
          .filter(Boolean)
      : [];
    const indexedDeps = parseNumericDependencyIndices(metadata).flatMap((depIdx) => stepKeysByIndex.get(depIdx) ?? []);
    const depSet = new Set([...explicitDeps, ...indexedDeps].filter((dep) => dep !== entry.stepKey));
    const stepType =
      typeof metadata.stepType === "string" && metadata.stepType.trim().length
        ? metadata.stepType.trim()
        : entry.step.kind;
    return {
      id: entry.step.id,
      index: entry.step.index,
      title: entry.step.title,
      kind: entry.step.kind,
      laneId: entry.step.laneId,
      stepType,
      stepKey: entry.stepKey,
      dependencyStepKeys: [...depSet]
    };
  });
}

// ── AI Transition Types ──────────────────────────────────────────

export type AiTransitionDirectives = {
  parallelismCap: number | null;
  disableHeuristicParallelism: boolean;
  retryBackoffMs: number | null;
  timeoutBudgetMs: number | null;
  stagnationThresholdMs: number | null;
  stepPriorities: Array<{ stepKey: string; priority: number; reason: string | null; laneHint: string | null }>;
};

export type AiTransitionDecision = {
  actionType: "continue" | "retry" | "pause" | "replan" | "abort";
  missionStatus: MissionStatus;
  pauseRun: boolean;
  rationale: string;
  interventionTitle: string | null;
  interventionBody: string | null;
  directives: AiTransitionDirectives;
};

export type MissionReplanAnalysis = {
  shouldReplan: boolean;
  summary: string;
  planDelta: string[];
  confidence: number | null;
  error: string | null;
};

// ── Pure Transition/Validation Functions ─────────────────────────

export function isAllowedStepCompletionMissionStatus(value: string): value is MissionStatus {
  return (
    value === "in_progress" ||
    value === "intervention_required" ||
    value === "completed" ||
    value === "partially_completed" ||
    value === "failed" ||
    value === "canceled"
  );
}

export function validateTransitionDecisionSafety(
  graph: OrchestratorRunGraph,
  missionStatus: MissionStatus
): { ok: boolean; reason: string } {
  const runStatus = graph.run.status;
  const allTerminal = graph.steps.every((step) =>
    step.status === "succeeded" || step.status === "failed" || step.status === "skipped" || step.status === "canceled"
  );
  const hasFailures = graph.steps.some((step) => step.status === "failed" || step.status === "blocked");

  if (runStatus === "succeeded") {
    return missionStatus === "completed" || missionStatus === "partially_completed"
      ? { ok: true, reason: "terminal_success" }
      : { ok: false, reason: `Run is succeeded; mission status must be completed or partially_completed.` };
  }
  if (runStatus === "succeeded_with_risk") {
    return missionStatus === "partially_completed" || missionStatus === "completed"
      ? { ok: true, reason: "terminal_success_with_risk" }
      : { ok: false, reason: "Run is succeeded_with_risk; mission status must be partially_completed." };
  }
  if (runStatus === "failed") {
    return missionStatus === "failed" || missionStatus === "intervention_required"
      ? { ok: true, reason: "terminal_failure" }
      : { ok: false, reason: "Run is failed; mission status must be failed or intervention_required." };
  }
  if (runStatus === "canceled") {
    return missionStatus === "canceled"
      ? { ok: true, reason: "terminal_canceled" }
      : { ok: false, reason: "Run is canceled; mission status must be canceled." };
  }
  if (runStatus === "paused") {
    return missionStatus === "intervention_required"
      ? { ok: true, reason: "paused_requires_intervention" }
      : { ok: false, reason: "Run is paused; mission status must be intervention_required." };
  }

  if (missionStatus === "completed" || missionStatus === "partially_completed") {
    return allTerminal && !hasFailures
      ? { ok: true, reason: "all_steps_terminal_success" }
      : missionStatus === "partially_completed" && allTerminal
        ? { ok: true, reason: "all_steps_terminal_partial" }
        : { ok: false, reason: "Mission cannot be completed while run is still active or contains failures." };
  }
  if (missionStatus === "failed") {
    return allTerminal && hasFailures
      ? { ok: true, reason: "all_steps_terminal_failure" }
      : { ok: false, reason: "Mission cannot be failed while run is active without terminal failures." };
  }
  if (missionStatus === "canceled") {
    return { ok: false, reason: "Mission cannot be canceled from active run status without explicit cancel." };
  }

  return { ok: true, reason: "active_run_status_ok" };
}

export function deriveTransitionMissionStatus(args: {
  graph: OrchestratorRunGraph;
  mission: MissionDetail;
  actionType: "continue" | "retry" | "pause" | "replan" | "abort";
  nextStatus: string | null;
}): MissionStatus {
  const requested = typeof args.nextStatus === "string" ? args.nextStatus.trim() : "";
  if (requested && isAllowedStepCompletionMissionStatus(requested)) return requested;
  if (args.actionType === "pause" || args.actionType === "replan") return "intervention_required";
  if (args.actionType === "abort") return "failed";
  if (args.actionType === "retry") return "in_progress";
  return deriveMissionStatusFromRun(args.graph, args.mission);
}

export function summarizeCurrentPlanForReplan(graph: OrchestratorRunGraph): string {
  const preview = graph.steps
    .slice(0, 12)
    .map((step) => `${step.stepKey}:${step.status}`)
    .join(", ");
  const summary = `Run status=${graph.run.status}; stepCount=${graph.steps.length}; preview=[${preview}]`;
  return summary.slice(0, 4_000);
}

export const TERMINAL_PHASE_STEP_STATUSES = new Set<OrchestratorStepStatus>([
  "succeeded",
  "failed",
  "skipped",
  "superseded",
  "canceled"
]);

/**
 * Apply AI decision directives to run metadata and step metadata.
 */
export function applyAIDecisionDirectives(
  ctx: OrchestratorContext,
  args: {
    runId: string;
    graph: OrchestratorRunGraph;
    completedStepId: string;
    decision: AiTransitionDecision;
  }
): void {
  const directives = args.decision.directives;
  const disableHeuristicParallelism = directives.disableHeuristicParallelism || directives.parallelismCap != null;
  if (
    directives.parallelismCap == null &&
    directives.retryBackoffMs == null &&
    directives.timeoutBudgetMs == null &&
    directives.stagnationThresholdMs == null &&
    directives.stepPriorities.length === 0 &&
    !disableHeuristicParallelism
  ) {
    return;
  }

  updateRunMetadata(ctx, args.runId, (metadata) => {
    const aiDecisionMeta = isRecord(metadata.aiDecisions) ? { ...metadata.aiDecisions } : {};
    if (directives.parallelismCap != null) {
      aiDecisionMeta.parallelismCap = directives.parallelismCap;
    }
    if (directives.stagnationThresholdMs != null) {
      aiDecisionMeta.stagnationThresholdMs = directives.stagnationThresholdMs;
    }
    if (disableHeuristicParallelism) {
      aiDecisionMeta.disableHeuristicParallelism = true;
    }
    aiDecisionMeta.lastDecisionAt = nowIso();
    aiDecisionMeta.source = "ai_decision_service";
    metadata.aiDecisions = aiDecisionMeta;

    if (directives.parallelismCap != null) {
      const autopilot = isRecord(metadata.autopilot) ? { ...metadata.autopilot } : null;
      if (autopilot) {
        autopilot.parallelismCap = directives.parallelismCap;
        metadata.autopilot = autopilot;
      }
    }
  });

  if (directives.stepPriorities.length > 0) {
    for (const entry of directives.stepPriorities) {
      const step = args.graph.steps.find((candidate) => candidate.stepKey === entry.stepKey);
      if (!step) continue;
      const meta = isRecord(step.metadata) ? { ...step.metadata } : {};
      meta.priority = entry.priority;
      meta.aiPriority = entry.priority;
      if (entry.reason) {
        meta.aiPriorityReason = entry.reason;
      }
      if (entry.laneHint) {
        meta.aiPriorityLaneHint = entry.laneHint;
      } else if ("aiPriorityLaneHint" in meta) {
        delete meta.aiPriorityLaneHint;
      }
      ctx.db.run(
        `update orchestrator_steps set metadata_json = ?, updated_at = ? where id = ? and run_id = ?`,
        [JSON.stringify(meta), nowIso(), step.id, args.runId]
      );
    }
  }

  if (directives.retryBackoffMs != null) {
    const completedStep = args.graph.steps.find((step) => step.id === args.completedStepId);
    if (completedStep) {
      const meta = isRecord(completedStep.metadata) ? { ...completedStep.metadata } : {};
      meta.aiRetryBackoffMs = directives.retryBackoffMs;
      if (completedStep.status === "pending" || completedStep.status === "ready") {
        meta.lastRetryBackoffMs = directives.retryBackoffMs;
        meta.nextRetryAt = new Date(Date.now() + directives.retryBackoffMs).toISOString();
      }
      ctx.db.run(
        `update orchestrator_steps set metadata_json = ?, updated_at = ? where id = ? and run_id = ?`,
        [JSON.stringify(meta), nowIso(), completedStep.id, args.runId]
      );
    }
  }

  if (directives.timeoutBudgetMs != null) {
    const completedStep = args.graph.steps.find((step) => step.id === args.completedStepId);
    if (completedStep) {
      const meta = isRecord(completedStep.metadata) ? { ...completedStep.metadata } : {};
      meta.aiTimeoutMs = directives.timeoutBudgetMs;
      meta.ai_timeout_ms = directives.timeoutBudgetMs;
      ctx.db.run(
        `update orchestrator_steps set metadata_json = ?, updated_at = ? where id = ? and run_id = ?`,
        [JSON.stringify(meta), nowIso(), completedStep.id, args.runId]
      );
    }
  }
}

/**
 * Sync mission steps from an orchestrator run graph.
 */
export function syncMissionStepsFromRun(ctx: OrchestratorContext, graph: OrchestratorRunGraph): void {
  const missionId = graph.run.missionId;
  const mission = ctx.missionService.get(missionId);
  if (!mission) return;

  for (const step of graph.steps) {
    const missionStep = mission.steps.find((ms) => {
      const msMeta = isRecord(ms.metadata) ? ms.metadata : {};
      return msMeta.orchestratorStepId === step.id || msMeta.stepKey === step.stepKey;
    });
    if (missionStep) {
      const apply = (status: MissionStatus) => {
        try {
          ctx.missionService.updateStep({
            missionId,
            stepId: missionStep.id,
            status: mapOrchestratorStepStatus(step.status) as any
          });
        } catch {
          // ignore step update failures
        }
      };
      apply(mapOrchestratorStepStatus(step.status) as any);
    }
  }
}

/**
 * Discover project documentation files and return their contents.
 */
export function discoverProjectDocs(ctx: OrchestratorContext): {
  found: boolean;
  paths: string[];
  contents: Record<string, string>;
} {
  if (!ctx.projectRoot) return { found: false, paths: [], contents: {} };
  const candidatePaths = [
    "docs/PRD.md",
    "docs/prd.md",
    "PRD.md",
    "docs/architecture.md",
    "docs/ARCHITECTURE.md",
    "docs/architecture/README.md",
    "docs/final-plan.md",
    "docs/design.md",
    "ARCHITECTURE.md"
  ];
  const foundPaths: string[] = [];
  const contents: Record<string, string> = {};
  for (const candidate of candidatePaths) {
    const fullPath = `${ctx.projectRoot}/${candidate}`;
    try {
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, "utf-8");
        if (content.trim().length > 0) {
          foundPaths.push(candidate);
          // Cap at 8KB per doc to avoid bloating context
          contents[candidate] = content.slice(0, 8_192);
        }
      }
    } catch {
      // ignore read errors
    }
  }
  if (foundPaths.length > 0) {
    ctx.logger.debug("ai_orchestrator.project_docs_discovered", {
      count: foundPaths.length,
      paths: foundPaths
    });
  }
  return { found: foundPaths.length > 0, paths: foundPaths, contents };
}

/**
 * Build step inputs from the mission_steps DB table.
 */
export function buildStepInputsFromMissionSteps(
  ctx: OrchestratorContext,
  buildArgs: {
    missionId: string;
    plannerStepKey: string;
    defaultExecutorKind?: OrchestratorExecutorKind;
    defaultRetryLimit?: number;
  }
): StartOrchestratorRunStepInput[] {
  const missionSteps = ctx.db.all<{
    id: string;
    step_index: number;
    title: string;
    detail: string | null;
    kind: string;
    lane_id: string | null;
    metadata_json: string | null;
  }>(
    `select id, step_index, title, detail, kind, lane_id, metadata_json
     from mission_steps
     where mission_id = ?
     order by step_index asc, created_at asc`,
    [buildArgs.missionId]
  );

  if (!missionSteps.length) return [];

  const fallbackExecutor = buildArgs.defaultExecutorKind ?? "unified";
  const fallbackRetryLimit = buildArgs.defaultRetryLimit ?? 2;

  const descriptors = missionSteps.map((row, index) => {
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(row.metadata_json || "{}"); } catch { /* empty */ }
    const stepIndex = Number.isFinite(Number(row.step_index)) ? Number(row.step_index) : index;
    const explicitKey = typeof metadata.stepKey === "string" ? (metadata.stepKey as string).trim() : "";
    const stepKey = explicitKey.length ? explicitKey : `mission_step_${stepIndex}_${index}`;
    return { row, index, metadata, stepIndex, stepKey };
  });

  return descriptors.map((desc) => {
    const { row, metadata } = desc;

    // Resolve dependencies from metadata or default to sequential
    let dependencyStepKeys: string[] = [];
    const hasExplicitDeps =
      Array.isArray(metadata.dependencyStepKeys) || Array.isArray(metadata.dependencyIndices);
    if (Array.isArray(metadata.dependencyStepKeys)) {
      dependencyStepKeys = (metadata.dependencyStepKeys as unknown[])
        .map((e) => String(e ?? "").trim())
        .filter((e) => e.length > 0 && e !== desc.stepKey);
    }
    if (!dependencyStepKeys.length && Array.isArray(metadata.dependencyIndices)) {
      const indices = (metadata.dependencyIndices as unknown[])
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v >= 0);
      const stepKeysByIndex = new Map<number, string>();
      for (const d of descriptors) stepKeysByIndex.set(d.stepIndex, d.stepKey);
      dependencyStepKeys = indices
        .map((i) => stepKeysByIndex.get(i))
        .filter((k): k is string => k != null && k !== desc.stepKey);
    }
    if (!dependencyStepKeys.length && !hasExplicitDeps && desc.index > 0) {
      dependencyStepKeys = [descriptors[desc.index - 1]!.stepKey];
    }

    // Root steps (no other deps) depend on the planner step
    if (dependencyStepKeys.length === 0) {
      dependencyStepKeys = [buildArgs.plannerStepKey];
    }

    const executorKind: OrchestratorExecutorKind =
      typeof metadata.executorKind === "string"
        ? (metadata.executorKind as OrchestratorExecutorKind)
        : fallbackExecutor;

    const retryLimitRaw = Number(metadata.retryLimit);
    const retryLimit = Number.isFinite(retryLimitRaw)
      ? Math.max(0, Math.floor(retryLimitRaw))
      : Math.max(0, Math.floor(fallbackRetryLimit));

    const instructions =
      typeof metadata.instructions === "string" && metadata.instructions.trim().length
        ? metadata.instructions.trim()
        : typeof row.detail === "string" && row.detail.trim().length
          ? row.detail.trim()
          : "";

    return {
      missionStepId: row.id,
      stepKey: desc.stepKey,
      title: row.title,
      stepIndex: desc.stepIndex + 1, // offset: planner is step 0
      laneId: row.lane_id,
      dependencyStepKeys,
      retryLimit,
      executorKind,
      metadata: {
        ...metadata,
        instructions,
        stepType: String(metadata.stepType ?? row.kind ?? "manual"),
      }
    } as StartOrchestratorRunStepInput;
  });
}

// ── Policy & Runtime Profile Resolution ─────────────────────────

export function resolveActivePolicy(
  ctx: OrchestratorContext,
  missionId: string
): MissionExecutionPolicy {
  const metadata = getMissionMetadata(ctx, missionId);
  const config = readConfig(ctx.projectConfigService);

  // 1) Mission metadata explicit policy
  if (isRecord(metadata.executionPolicy)) {
    return resolveExecutionPolicy({
      missionMetadata: metadata.executionPolicy as Partial<MissionExecutionPolicy>
    });
  }

  // 2) Project default execution policy
  if (config.defaultExecutionPolicy) {
    return resolveExecutionPolicy({
      projectConfig: config.defaultExecutionPolicy
    });
  }

  // 3) Built-in default policy
  return DEFAULT_EXECUTION_POLICY;
}

export function resolveActiveRuntimeProfile(
  ctx: OrchestratorContext,
  missionId: string
): MissionRuntimeProfile {
  const config = readConfig(ctx.projectConfigService);
  const policy = resolveActivePolicy(ctx, missionId);
  return deriveRuntimeProfileFromPolicy(policy, config);
}

// ── Mission Parallelism Resolution ──────────────────────────────

export function resolveMissionParallelismCap(
  ctx: OrchestratorContext,
  missionId: string
): number | null {
  const row = ctx.db.get<{ metadata_json: string | null }>(
    `
      select metadata_json
      from missions
      where id = ?
      limit 1
    `,
    [missionId]
  );
  if (!row?.metadata_json) return null;
  try {
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    const plannerPlan = isRecord(metadata.plannerPlan) ? (metadata.plannerPlan as Record<string, unknown>) : null;
    const missionSummary = plannerPlan && isRecord(plannerPlan.missionSummary)
      ? (plannerPlan.missionSummary as Record<string, unknown>)
      : null;
    const cap = Number(missionSummary?.parallelismCap ?? NaN);
    return Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : null;
  } catch {
    return null;
  }
}

export function resolveMissionLaneStrategyParallelismCap(
  ctx: OrchestratorContext,
  missionId: string
): number | null {
  const metadata = getMissionMetadata(ctx, missionId);
  const parallelLanes = isRecord(metadata.parallelLanes) ? metadata.parallelLanes : null;
  const cap = Number(parallelLanes?.maxParallelLanes ?? Number.NaN);
  return Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : null;
}

// ── Mission Status Transition ───────────────────────────────────

export function transitionMissionStatus(
  ctx: OrchestratorContext,
  missionId: string,
  next: MissionStatus,
  args?: { outcomeSummary?: string | null; lastError?: string | null }
): void {
  const mission = ctx.missionService.get(missionId);
  if (!mission) return;
  if (mission.status === next && args?.outcomeSummary == null && args?.lastError == null) return;
  try {
    ctx.missionService.update({
      missionId,
      status: next,
      ...(args?.outcomeSummary !== undefined ? { outcomeSummary: args.outcomeSummary } : {}),
      ...(args?.lastError !== undefined ? { lastError: args.lastError } : {})
    });
  } catch (error) {
    ctx.logger.debug("ai_orchestrator.mission_status_transition_skipped", {
      missionId,
      from: mission.status,
      to: next,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}

// ── Mission Objective Resolution ────────────────────────────────

export function resolveMissionObjectiveForReplan(
  ctx: OrchestratorContext,
  missionId: string,
  mission: MissionDetail | null
): string {
  const metadata = getMissionMetadata(ctx, missionId);
  const plannerPlan = isRecord(metadata.plannerPlan) ? metadata.plannerPlan : null;
  const missionSummary = plannerPlan && isRecord(plannerPlan.missionSummary)
    ? plannerPlan.missionSummary
    : null;
  const objective = typeof missionSummary?.objective === "string" ? missionSummary.objective.trim() : "";
  if (objective.length > 0) return objective;
  const prompt = typeof mission?.prompt === "string" ? mission.prompt.trim() : "";
  if (prompt.length > 0) return prompt;
  const title = typeof mission?.title === "string" ? mission.title.trim() : "";
  return title.length > 0 ? title : "Mission objective unavailable.";
}

// ── Max Coordinator Recoveries ──────────────────────────────────

const DEFAULT_MAX_COORDINATOR_RECOVERIES = 3;

export function getMaxCoordinatorRecoveries(
  ctx: OrchestratorContext,
  missionId?: string | null
): number {
  // Check mission-specific metadata first
  if (missionId) {
    try {
      const metadata = getMissionMetadata(ctx, missionId);
      const missionMax = (metadata as Record<string, unknown>)?.maxCoordinatorRecoveries;
      if (typeof missionMax === "number" && Number.isFinite(missionMax) && missionMax >= 0) {
        return missionMax;
      }
    } catch { /* fall through */ }
  }
  // Then project config
  try {
    const config = readConfig(ctx.projectConfigService);
    const execPolicy = config.defaultExecutionPolicy;
    const policyMax = (execPolicy as Record<string, unknown> | null)?.maxCoordinatorRecoveries;
    if (typeof policyMax === "number" && Number.isFinite(policyMax) && policyMax >= 0) {
      return policyMax;
    }
  } catch { /* use default */ }
  return DEFAULT_MAX_COORDINATOR_RECOVERIES;
}

// ── Replan Analysis ─────────────────────────────────────────────

export async function requestMissionReplanAnalysis(
  ctx: OrchestratorContext,
  args: {
    missionId: string;
    runId: string;
    stepId?: string | null;
    stepKey?: string | null;
    reason: string;
    failureDigest: string;
    graph: OrchestratorRunGraph;
  }
): Promise<MissionReplanAnalysis> {
  const mission = ctx.missionService.get(args.missionId);
  const failureDigest = args.failureDigest.slice(0, 4_000);
  const missionObjective = resolveMissionObjectiveForReplan(ctx, args.missionId, mission);
  const currentPlanSummary = summarizeCurrentPlanForReplan(args.graph);

  // Replan analysis is now handled by the coordinator agent via injectEvent().
  // This path provides a deterministic fallback that always triggers replan.
  const analysis: MissionReplanAnalysis = {
    shouldReplan: true,
    summary: args.reason,
    planDelta: [],
    confidence: null,
    error: null
  };

  updateRunMetadata(ctx, args.runId, (metadata) => {
    const aiDecisions = isRecord(metadata.aiDecisions) ? { ...metadata.aiDecisions } : {};
    aiDecisions.lastReplanRequest = {
      requestedAt: nowIso(),
      missionId: args.missionId,
      stepId: args.stepId ?? null,
      stepKey: args.stepKey ?? null,
      reason: args.reason,
      failureDigest,
      shouldReplan: analysis.shouldReplan,
      summary: analysis.summary,
      planDelta: analysis.planDelta,
      confidence: analysis.confidence,
      error: analysis.error
    };
    metadata.aiDecisions = aiDecisions;
  });

  return analysis;
}

export function formatReplanInterventionBody(args: {
  reason: string;
  analysis: MissionReplanAnalysis;
}): string {
  const lines = [
    args.reason,
    `Replan summary: ${args.analysis.summary}`,
    args.analysis.planDelta.length > 0
      ? `Proposed plan deltas:\n- ${args.analysis.planDelta.join("\n- ")}`
      : null,
    args.analysis.error ? `Replan analysis warning: ${args.analysis.error}` : null
  ];
  return lines.filter((line): line is string => typeof line === "string" && line.trim().length > 0).join("\n\n");
}

// ── Hook Dispatch ───────────────────────────────────────────────

export type HookDispatchDeps = {
  recordRuntimeEvent: (...args: any[]) => void;
};

export function dispatchOrchestratorHookCtx(
  ctx: OrchestratorContext,
  hookArgs: {
    event: OrchestratorHookEvent;
    runId: string;
    stepId?: string | null;
    attemptId?: string | null;
    sessionId?: string | null;
    reason: string;
    triggerSource: string;
    eventAt?: string | null;
    metadata?: Record<string, unknown> | null;
  },
  deps: HookDispatchDeps
): void {
  const config = readConfig(ctx.projectConfigService);
  const hook = config.hooks[hookArgs.event];
  if (!hook?.command) return;
  const missionId = getMissionIdForRun(ctx, hookArgs.runId);
  const commandPreview = clipHookLogText(hook.command);
  const commandDigest = createHash("sha256").update(hook.command).digest("hex").slice(0, 16);
  const occurredAt = hookArgs.eventAt && hookArgs.eventAt.trim().length > 0 ? hookArgs.eventAt : nowIso();
  const runtimeEventBase = {
    source: "orchestrator_hook",
    hookEvent: hookArgs.event,
    missionId,
    reason: hookArgs.reason,
    triggerSource: hookArgs.triggerSource,
    commandDigest,
    commandPreview,
    timeoutMs: hook.timeoutMs
  };
  deps.recordRuntimeEvent({
    runId: hookArgs.runId,
    stepId: hookArgs.stepId ?? null,
    attemptId: hookArgs.attemptId ?? null,
    sessionId: hookArgs.sessionId ?? null,
    eventType: "progress",
    eventKey: `hook_dispatch:${hookArgs.event}:${hookArgs.attemptId ?? hookArgs.stepId ?? "none"}:${Date.now()}`,
    occurredAt,
    payload: {
      ...runtimeEventBase,
      phase: "started",
      ...(hookArgs.metadata ?? {})
    }
  });
  ctx.logger.info("ai_orchestrator.hook_dispatch_started", {
    runId: hookArgs.runId,
    stepId: hookArgs.stepId ?? null,
    attemptId: hookArgs.attemptId ?? null,
    sessionId: hookArgs.sessionId ?? null,
    ...runtimeEventBase
  });

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.ADE_HOOK_EVENT = hookArgs.event;
  env.ADE_HOOK_RUN_ID = hookArgs.runId;
  env.ADE_HOOK_STEP_ID = hookArgs.stepId ?? "";
  env.ADE_HOOK_ATTEMPT_ID = hookArgs.attemptId ?? "";
  env.ADE_HOOK_SESSION_ID = hookArgs.sessionId ?? "";
  env.ADE_HOOK_REASON = hookArgs.reason;
  env.ADE_HOOK_TRIGGER = hookArgs.triggerSource;
  env.ADE_HOOK_MISSION_ID = missionId ?? "";
  env.ADE_HOOK_METADATA_JSON = JSON.stringify({
    event: hookArgs.event,
    runId: hookArgs.runId,
    stepId: hookArgs.stepId ?? null,
    attemptId: hookArgs.attemptId ?? null,
    sessionId: hookArgs.sessionId ?? null,
    missionId,
    reason: hookArgs.reason,
    triggerSource: hookArgs.triggerSource,
    occurredAt,
    ...(hookArgs.metadata ?? {})
  });

  void ctx.hookCommandRunner({
    command: hook.command,
    cwd: ctx.projectRoot ?? process.cwd(),
    timeoutMs: hook.timeoutMs,
    env
  }).then((result) => {
    const stdoutPreview = clipHookLogText(result.stdout);
    const stderrPreview = clipHookLogText(result.stderr);
    const success = result.spawnError == null && !result.timedOut && result.exitCode === 0;
    const logPayload = {
      runId: hookArgs.runId,
      stepId: hookArgs.stepId ?? null,
      attemptId: hookArgs.attemptId ?? null,
      sessionId: hookArgs.sessionId ?? null,
      ...runtimeEventBase,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdoutPreview,
      stderrPreview,
      spawnError: result.spawnError
    };
    if (success) {
      ctx.logger.info("ai_orchestrator.hook_execution_succeeded", logPayload);
    } else {
      ctx.logger.warn("ai_orchestrator.hook_execution_failed", logPayload);
    }
    deps.recordRuntimeEvent({
      runId: hookArgs.runId,
      stepId: hookArgs.stepId ?? null,
      attemptId: hookArgs.attemptId ?? null,
      sessionId: hookArgs.sessionId ?? null,
      eventType: "progress",
      eventKey: `hook_result:${hookArgs.event}:${hookArgs.attemptId ?? hookArgs.stepId ?? "none"}:${Date.now()}`,
      payload: {
        ...runtimeEventBase,
        phase: success ? "succeeded" : "failed",
        success,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdoutPreview,
        stderrPreview,
        spawnError: result.spawnError,
        ...(hookArgs.metadata ?? {})
      }
    });
  }).catch((error) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    ctx.logger.warn("ai_orchestrator.hook_execution_failed", {
      runId: hookArgs.runId,
      stepId: hookArgs.stepId ?? null,
      attemptId: hookArgs.attemptId ?? null,
      sessionId: hookArgs.sessionId ?? null,
      ...runtimeEventBase,
      error: errorMessage
    });
    deps.recordRuntimeEvent({
      runId: hookArgs.runId,
      stepId: hookArgs.stepId ?? null,
      attemptId: hookArgs.attemptId ?? null,
      sessionId: hookArgs.sessionId ?? null,
      eventType: "progress",
      eventKey: `hook_result:${hookArgs.event}:${hookArgs.attemptId ?? hookArgs.stepId ?? "none"}:${Date.now()}`,
      payload: {
        ...runtimeEventBase,
        phase: "failed",
        success: false,
        error: errorMessage,
        ...(hookArgs.metadata ?? {})
      }
    });
  });
}

export function maybeDispatchTeammateIdleHookCtx(
  ctx: OrchestratorContext,
  idleArgs: {
    runId: string;
    stepId: string;
    attemptId: string;
    sessionId?: string | null;
    previousState: OrchestratorWorkerStatus | null;
    nextState: OrchestratorWorkerStatus;
    reason: string;
    triggerSource: "runtime_signal" | "health_sweep";
    runtimeState?: TerminalRuntimeState | null;
    preview?: string | null;
    laneId?: string | null;
  },
  deps: HookDispatchDeps
): void {
  if (idleArgs.nextState !== "idle" && idleArgs.nextState !== "waiting_input") return;
  if (idleArgs.previousState === idleArgs.nextState) return;
  dispatchOrchestratorHookCtx(ctx, {
    event: "TeammateIdle",
    runId: idleArgs.runId,
    stepId: idleArgs.stepId,
    attemptId: idleArgs.attemptId,
    sessionId: idleArgs.sessionId ?? null,
    reason: idleArgs.reason,
    triggerSource: idleArgs.triggerSource,
    metadata: {
      previousState: idleArgs.previousState,
      nextState: idleArgs.nextState,
      runtimeState: idleArgs.runtimeState ?? null,
      laneId: idleArgs.laneId ?? null,
      preview: clipHookLogText(idleArgs.preview)
    }
  }, deps);
}
