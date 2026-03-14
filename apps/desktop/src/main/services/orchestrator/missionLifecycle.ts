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
import path from "node:path";
import type {
  OrchestratorContext,
  MissionRuntimeProfile,
  OrchestratorHookEvent,
} from "./orchestratorContext";
import {
  nowIso,
  isRecord,
  mapOrchestratorStepStatus,
  parseJsonRecord,
  readConfig,
  deriveRuntimeProfileFromPolicy,
  deriveRuntimeProfileFromPhases,
  clipHookLogText,
} from "./orchestratorContext";
import type {
  OrchestratorRunGraph,
  MissionStatus,
  MissionStepStatus,
  OrchestratorWorkerRole,
  OrchestratorStepStatus,
  OrchestratorWorkerStatus,
  TerminalRuntimeState,
  MissionExecutionPolicy,
  MissionLevelSettings,
  PhaseCard,
} from "../../../shared/types";
import { resolveExecutionPolicy, DEFAULT_EXECUTION_POLICY } from "./executionPolicy";
import { getMissionMetadata, getMissionIdForRun } from "./chatMessageService";
import { readDocPaths } from "./stepPolicyResolver";

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

export function inferRoleFromStepMetadata(metadata: Record<string, unknown>, kind: string): OrchestratorWorkerRole {
  const stepType = typeof metadata.stepType === "string" ? metadata.stepType.trim().toLowerCase() : "";
  const taskType = typeof metadata.taskType === "string" ? metadata.taskType.trim().toLowerCase() : "";
  const combined = `${stepType} ${taskType} ${kind}`.toLowerCase();
  if (combined.includes("test_review") || combined.includes("testreview")) return "test_review";
  if (combined.includes("review") || combined.includes("code_review")) return "code_review";
  if (combined.includes("test") || combined.includes("validation")) return "testing";
  if (combined.includes("plan")) return "implementation";
  if (combined.includes("integration") || combined.includes("merge")) return "integration";
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

// ── Orchestrator Constants ───────────────────────────────────────

export const TERMINAL_PHASE_STEP_STATUSES = new Set<OrchestratorStepStatus>([
  "succeeded",
  "failed",
  "skipped",
  "superseded",
  "canceled"
]);


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
      const apply = () => {
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
      apply();
    }
  }
}

/**
 * User-initiated mission step statuses that should propagate back to the
 * orchestrator run graph.  Only statuses that represent deliberate user
 * actions (cancel / skip) are synced — we never push running/pending back
 * because those are orchestrator-driven transitions.
 */
const USER_INITIATED_STEP_STATUSES = new Set<MissionStepStatus>([
  "canceled",
  "skipped",
]);

/**
 * Map a mission step status to the corresponding orchestrator step status.
 * This is the reverse of `mapOrchestratorStepStatus`.
 */
function mapMissionStepStatusToOrchestrator(
  status: MissionStepStatus
): OrchestratorStepStatus {
  switch (status) {
    case "canceled":
      return "canceled";
    case "skipped":
      return "skipped";
    default:
      return status as OrchestratorStepStatus;
  }
}

/**
 * Reverse sync: propagate user-initiated status changes (cancelled, skipped)
 * from mission steps back to the orchestrator run graph.
 *
 * This complements `syncMissionStepsFromRun` which only syncs orchestrator → mission.
 * The reverse direction ensures that when a user manually cancels or skips a
 * mission step in the UI, the orchestrator is aware and stops scheduling work
 * for that step.
 */
export function syncRunStepsFromMission(
  ctx: OrchestratorContext,
  graph: OrchestratorRunGraph
): { synced: number } {
  const missionId = graph.run.missionId;
  const mission = ctx.missionService.get(missionId);
  if (!mission) return { synced: 0 };

  let synced = 0;

  for (const missionStep of mission.steps) {
    // Only propagate user-initiated terminal statuses
    if (!USER_INITIATED_STEP_STATUSES.has(missionStep.status)) continue;

    // Find the matching orchestrator step via metadata linkage
    const msMeta = isRecord(missionStep.metadata) ? missionStep.metadata : {};
    const orchestratorStepId =
      typeof msMeta.orchestratorStepId === "string"
        ? msMeta.orchestratorStepId
        : null;
    const stepKey =
      typeof msMeta.stepKey === "string" ? msMeta.stepKey : null;

    const runStep = graph.steps.find((s) => {
      if (orchestratorStepId && s.id === orchestratorStepId) return true;
      if (stepKey && s.stepKey === stepKey) return true;
      return false;
    });

    if (!runStep) continue;

    // Don't overwrite if the orchestrator step is already in a terminal state
    const alreadyTerminal =
      runStep.status === "succeeded" ||
      runStep.status === "failed" ||
      runStep.status === "skipped" ||
      runStep.status === "superseded" ||
      runStep.status === "canceled";
    if (alreadyTerminal) continue;

    const targetStatus = mapMissionStepStatusToOrchestrator(missionStep.status);
    try {
      if (targetStatus === "skipped") {
        ctx.orchestratorService.skipStep({
          runId: graph.run.id,
          stepId: runStep.id,
          reason: `User ${missionStep.status} mission step "${missionStep.title}" via UI`,
        });
      } else {
        // For canceled: use skipStep with a cancel reason since orchestratorService
        // does not expose a dedicated cancelStep — skipStep is the closest equivalent
        // that properly handles downstream dependency refreshes.
        ctx.orchestratorService.skipStep({
          runId: graph.run.id,
          stepId: runStep.id,
          reason: `User canceled mission step "${missionStep.title}" via UI`,
        });
      }
      synced++;
    } catch {
      // Ignore failures (step may already be terminal in a race)
    }
  }

  return { synced };
}

/**
 * Discover project documentation files and return their contents.
 */
export function discoverProjectDocs(ctx: OrchestratorContext): {
  found: boolean;
  paths: string[];
  docs: Array<{ path: string; bytes: number; sha256: string }>;
} {
  if (!ctx.projectRoot) return { found: false, paths: [], docs: [] };
  const projectRoot = ctx.projectRoot;
  const candidatePaths = [
    ...new Set(
      [
        ".ade/context/PRD.ade.md",
        ".ade/context/ARCHITECTURE.ade.md",
        "README.md",
        "CLAUDE.md",
        "AGENTS.md",
        ...readDocPaths(projectRoot).map((absPath) => path.relative(projectRoot, absPath).replace(/\\/g, "/"))
      ].map((value) => value.replace(/\\/g, "/"))
    )
  ];
  const foundPaths: string[] = [];
  const docs: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const candidate of candidatePaths) {
    const fullPath = path.join(projectRoot, candidate.replace(/^\/+/, ""));
    try {
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath);
        if (content.byteLength > 0) {
          foundPaths.push(candidate);
          docs.push({
            path: candidate,
            bytes: content.byteLength,
            sha256: createHash("sha256").update(content).digest("hex")
          });
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
  return { found: foundPaths.length > 0, paths: foundPaths, docs };
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

  // Try phase-based derivation first
  const { phases, settings } = resolveActivePhaseSettings(ctx, missionId);
  if (phases.length > 0) {
    return deriveRuntimeProfileFromPhases(phases, settings, config);
  }

  // Fall back to old policy-based derivation
  const policy = resolveActivePolicy(ctx, missionId);
  return deriveRuntimeProfileFromPolicy(policy, config);
}

// ── Phase-based Settings Resolution ──────────────────────────────

const DEFAULT_MISSION_LEVEL_SETTINGS: MissionLevelSettings = {
  prStrategy: { kind: "manual" }
};

/**
 * Resolves the active phase cards and mission-level settings for a mission.
 * Reads from mission metadata with fallback chain.
 */
export function resolveActivePhaseSettings(
  ctx: OrchestratorContext,
  missionId: string
): { phases: PhaseCard[]; settings: MissionLevelSettings } {
  const metadata = getMissionMetadata(ctx, missionId);

  // 1) Read phases from phaseConfiguration in metadata
  let phases: PhaseCard[] = [];
  if (isRecord(metadata.phaseConfiguration)) {
    const config = metadata.phaseConfiguration as Record<string, unknown>;
    if (Array.isArray(config.selectedPhases)) {
      phases = config.selectedPhases as PhaseCard[];
    } else if (Array.isArray(config.phases)) {
      phases = config.phases as PhaseCard[];
    }
  }

  // 2) Read mission-level settings
  let settings: MissionLevelSettings;
  if (isRecord(metadata.missionLevelSettings)) {
    settings = metadata.missionLevelSettings as MissionLevelSettings;
  } else {
    settings = { ...DEFAULT_MISSION_LEVEL_SETTINGS };
  }

  return { phases, settings };
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

  // VAL-STATE-001: Before transitioning to intervention_required, pause all
  // active runs for this mission so we never have an active run while the
  // mission is in the intervention_required state.
  if (next === "intervention_required") {
    const runs = ctx.orchestratorService.listRuns({ missionId });
    for (const run of runs) {
      if (run.status === "active" || run.status === "bootstrapping") {
        try {
          ctx.orchestratorService.pauseRun({
            runId: run.id,
            reason: "Mission transitioning to intervention_required",
          });
        } catch (pauseError) {
          ctx.logger.debug("ai_orchestrator.pause_run_before_intervention_failed", {
            missionId,
            runId: run.id,
            error: pauseError instanceof Error ? pauseError.message : String(pauseError),
          });
        }
      }
    }
  }

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
