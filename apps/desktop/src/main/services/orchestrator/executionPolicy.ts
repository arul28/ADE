import type {
  MissionExecutionPolicy,
  MissionLevelSettings,
  PhaseCard,
  CompletionDiagnostic,
  RunCompletionEvaluation,
  RunCompletionValidation,
  RunCompletionBlocker,
  OrchestratorRun,
  OrchestratorRunStatus,
  OrchestratorStep,
  OrchestratorAttempt,
  OrchestratorClaim,
  OrchestratorTeamRuntimeState,
  OrchestratorWorkerRole,
  OrchestratorExecutorKind,
  RoleIsolationRule,
  RoleIsolationValidation,
  TeamManifest,
  RecoveryLoopPolicy,
  RecoveryLoopState,
  OrchestratorContextView,
  ExecutionPlanPreview,
  ExecutionPlanPhase,
  ExecutionPlanStepPreview
} from "../../../shared/types";

import {
  DEFAULT_ROLE_ISOLATION_RULES,
  DEFAULT_RECOVERY_LOOP_POLICY,
  DEFAULT_INTEGRATION_PR_POLICY
} from "./orchestratorConstants";

import { getModelById } from "../../../shared/modelRegistry";
import { TERMINAL_STEP_STATUSES } from "./orchestratorContext";

// ─────────────────────────────────────────────────────
// Default policy
// ─────────────────────────────────────────────────────

export const DEFAULT_EXECUTION_POLICY: MissionExecutionPolicy = {
  planning: { mode: "auto", model: "anthropic/claude-sonnet-4-6" },
  implementation: { model: "openai/gpt-5.3-codex" },
  testing: { mode: "post_implementation", model: "openai/gpt-5.3-codex" },
  validation: { mode: "optional", model: "openai/gpt-5.3-codex" },
  codeReview: { mode: "off" },
  testReview: { mode: "off" },
  prReview: { mode: "off" },
  merge: { mode: "off" },
  prStrategy: { kind: "manual" }
};

// ─────────────────────────────────────────────────────
// Resolution: merge partial policy with defaults
// ─────────────────────────────────────────────────────

function mergePhase<T extends Record<string, unknown>>(
  partial: Partial<T> | undefined,
  defaults: T
): T {
  if (!partial) return defaults;
  return { ...defaults, ...partial };
}

export function resolveExecutionPolicy(sources: {
  missionMetadata?: Partial<MissionExecutionPolicy> | null;
  projectConfig?: Partial<MissionExecutionPolicy> | null;
  fallback?: MissionExecutionPolicy;
}): MissionExecutionPolicy {
  // Priority: mission metadata > project config > fallback > DEFAULT
  const base = sources.fallback ?? DEFAULT_EXECUTION_POLICY;

  let resolved: MissionExecutionPolicy;

  if (sources.missionMetadata) {
    const p = sources.missionMetadata;
    resolved = {
      planning: mergePhase(p.planning, base.planning),
      implementation: mergePhase(p.implementation, base.implementation),
      testing: mergePhase(p.testing, base.testing),
      validation: mergePhase(p.validation, base.validation),
      codeReview: mergePhase(p.codeReview, base.codeReview),
      testReview: mergePhase(p.testReview, base.testReview),
      prReview: mergePhase(p.prReview, base.prReview),
      merge: base.merge,
      prStrategy: p.prStrategy ?? base.prStrategy,
      integrationPr: p.integrationPr ?? base.integrationPr,
      teamRuntime: p.teamRuntime ?? base.teamRuntime
    };
  } else if (sources.projectConfig) {
    const p = sources.projectConfig;
    resolved = {
      planning: mergePhase(p.planning, base.planning),
      implementation: mergePhase(p.implementation, base.implementation),
      testing: mergePhase(p.testing, base.testing),
      validation: mergePhase(p.validation, base.validation),
      codeReview: mergePhase(p.codeReview, base.codeReview),
      testReview: mergePhase(p.testReview, base.testReview),
      prReview: mergePhase(p.prReview, base.prReview),
      merge: base.merge,
      prStrategy: p.prStrategy ?? base.prStrategy,
      integrationPr: p.integrationPr ?? base.integrationPr,
      teamRuntime: p.teamRuntime ?? base.teamRuntime
    };
  } else {
    resolved = base;
  }

  return resolved;
}

// ─────────────────────────────────────────────────────
// Phase ↔ step type mapping
// ─────────────────────────────────────────────────────

export type ExecutionPhase =
  | "implementation"
  | "testing"
  | "validation"
  | "codeReview"
  | "testReview"
  | "integration";

export function stepTypeToPhase(stepType: string, taskType?: string): ExecutionPhase | null {
  const primary = (stepType || "").trim().toLowerCase();
  const secondary = (taskType || "").trim().toLowerCase();
  if (primary === "test_review" || secondary === "test_review" || primary === "review_test" || secondary === "review_test") {
    return "testReview";
  }

  if (primary === "analysis" || secondary === "analysis") return "implementation";
  if (primary === "code" || primary === "implementation" || secondary === "code" || secondary === "implementation") return "implementation";
  if (primary === "test" || primary === "validation" || secondary === "test" || secondary === "validation") return "testing";
  if (primary === "milestone" || secondary === "milestone") return "validation";
  if ((primary === "review" && (secondary === "test" || secondary === "validation")) || (secondary === "review" && primary === "test")) {
    return "testReview";
  }
  if (primary === "review" || secondary === "review") return "codeReview";
  if (primary === "integration" || secondary === "integration") return "integration";
  return null;
}

// ─────────────────────────────────────────────────────
// Completion evaluator
// ─────────────────────────────────────────────────────

export function evaluateRunCompletion(
  steps: OrchestratorStep[],
  policy: MissionExecutionPolicy
): RunCompletionEvaluation {
  const diagnostics: CompletionDiagnostic[] = [];
  const riskFactors: string[] = [];

  // Map steps to phases
  const phaseSteps = new Map<ExecutionPhase, OrchestratorStep[]>();
  for (const step of steps) {
    const stepType = typeof step.metadata?.stepType === "string" ? step.metadata.stepType : "";
    const taskType = typeof step.metadata?.taskType === "string" ? step.metadata.taskType : "";
    const phase = stepTypeToPhase(stepType, taskType);
    if (phase) {
      const bucket = phaseSteps.get(phase) ?? [];
      bucket.push(step);
      phaseSteps.set(phase, bucket);
    }
  }

  // Determine which phases are required
  // NOTE: "planning" is NOT an execution phase — the pre-mission planner runs before execution.
  const phaseRequired: Record<ExecutionPhase, boolean> = {
    implementation: true, // always required
    testing: policy.testing.mode !== "none",
    validation: policy.validation.mode === "required",
    codeReview: policy.codeReview.mode === "required",
    testReview: policy.testReview.mode === "required",
    integration: !!policy.integrationPr && hasMultipleLanes(steps)
  };

  const allPhases: ExecutionPhase[] = [
    "implementation",
    "testing",
    "validation",
    "codeReview",
    "testReview",
    "integration"
  ];

  for (const phase of allPhases) {
    const stepsInPhase = phaseSteps.get(phase) ?? [];
    const required = phaseRequired[phase];

    if (stepsInPhase.length === 0) {
      if (required) {
        diagnostics.push({
          phase,
          code: "phase_required_missing",
          message: `Required phase "${phase}" has no steps`,
          blocking: true
        });
        riskFactors.push(`${phase}_required_but_missing`);
      } else {
        diagnostics.push({
          phase,
          code: "phase_skipped_by_policy",
          message: `Phase "${phase}" skipped by policy`,
          blocking: false
        });
      }
      continue;
    }

    const statuses = stepsInPhase.map((s) => s.status);
    const allTerminal = statuses.every((s) => TERMINAL_STEP_STATUSES.has(s));
    const anyFailed = statuses.some((s) => s === "failed");
    const allSucceededOrSkipped = statuses.every((s) => s === "succeeded" || s === "skipped" || s === "superseded");
    const anyBlocked = statuses.some((s) => s === "blocked");
    const anyInProgress = statuses.some((s) => s === "running" || s === "ready" || s === "pending");

    if (allSucceededOrSkipped) {
      diagnostics.push({
        phase,
        code: "phase_succeeded",
        message: `Phase "${phase}" completed successfully`,
        blocking: false
      });
    } else if (anyFailed && allTerminal) {
      const blocking = required;
      diagnostics.push({
        phase,
        code: "phase_failed",
        message: `Phase "${phase}" has failed steps`,
        blocking
      });
      if (!blocking && required) {
        riskFactors.push(`${phase}_failed`);
      }
    } else if (anyBlocked || anyInProgress) {
      // In-progress is always blocking — can't complete while steps are running
      diagnostics.push({
        phase,
        code: "phase_in_progress",
        message: `Phase "${phase}" still in progress`,
        blocking: true
      });
    }
  }

  const requiredValidationMissingStepKeys = steps
    .filter((step) => step.status === "succeeded")
    .filter((step) => {
      const meta = step.metadata ?? {};
      const validationContract =
        typeof meta.validationContract === "object" && meta.validationContract
          ? (meta.validationContract as Record<string, unknown>)
          : null;
      if (validationContract?.required !== true) return false;

      const lastValidationReport =
        typeof meta.lastValidationReport === "object" && meta.lastValidationReport
          ? (meta.lastValidationReport as Record<string, unknown>)
          : null;
      const lastVerdict = typeof lastValidationReport?.verdict === "string" ? lastValidationReport.verdict.toLowerCase() : "";
      const validationState = typeof meta.validationState === "string" ? meta.validationState.toLowerCase() : "";
      const validationPassedAt = typeof meta.validationPassedAt === "string" ? meta.validationPassedAt.trim() : "";
      const hasPassingValidation = lastVerdict === "pass" || validationState === "pass" || validationPassedAt.length > 0;
      return !hasPassingValidation;
    })
    .map((step) => step.stepKey);

  if (requiredValidationMissingStepKeys.length > 0) {
    diagnostics.push({
      phase: "validation",
      code: "required_validation_missing",
      message: "Succeeded steps are missing a passing required validation contract.",
      blocking: true,
      details: { stepKeys: requiredValidationMissingStepKeys }
    });
    riskFactors.push(
      `required_validation_missing: ${requiredValidationMissingStepKeys.join(", ")}`
    );
  }

  // Compute overall status
  const hasBlockingDiagnostics = diagnostics.some((d) => d.blocking);
  const anyPhaseFailed = diagnostics.some((d) => d.code === "phase_failed");
  const anyPhaseInProgress = diagnostics.some((d) => d.code === "phase_in_progress");

  // Also check raw step statuses as a final status gate.
  const allStepStatuses = steps.map((s) => s.status);
  const allStepsTerminal = allStepStatuses.every((s) => TERMINAL_STEP_STATUSES.has(s));
  const anyStepBlocked = allStepStatuses.some((s) => s === "blocked");
  const anyStepRunning = allStepStatuses.some((s) => s === "running" || s === "ready" || s === "pending");

  let status: OrchestratorRunStatus;
  let completionReady: boolean;

  if (anyPhaseInProgress || anyStepRunning) {
    status = "active";
    completionReady = false;
  } else if (anyStepBlocked) {
    status = "paused";
    completionReady = false;
  } else if (anyPhaseFailed && hasBlockingDiagnostics) {
    status = "failed";
    completionReady = true;
  } else if (allStepsTerminal && !hasBlockingDiagnostics && riskFactors.length > 0) {
    status = "succeeded";
    completionReady = true;
  } else if (allStepsTerminal && !hasBlockingDiagnostics) {
    const allSucceeded = allStepStatuses.every((s) => s === "succeeded" || s === "skipped" || s === "superseded");
    status = allSucceeded ? "succeeded" : "failed";
    completionReady = true;
  } else {
    status = "active";
    completionReady = false;
  }

  return { status, diagnostics, riskFactors, completionReady };
}

// ─────────────────────────────────────────────────────
// Explicit completion validator
// ─────────────────────────────────────────────────────

/**
 * Validates whether a run can be finalized. This is the gate that
 * the kernel's finalizeRun calls before transitioning a run to a
 * terminal status. Returns structured blockers when the run cannot
 * yet complete.
 */
export function validateRunCompletion(
  _run: OrchestratorRun,
  steps: OrchestratorStep[],
  attempts: OrchestratorAttempt[],
  claims: OrchestratorClaim[],
  _runState: OrchestratorTeamRuntimeState | null,
  interventions?: Array<{ status: string }>
): RunCompletionValidation {
  const blockers: RunCompletionBlocker[] = [];

  // (a) No running or queued attempts
  const activeAttempts = attempts.filter(
    (a) => a.status === "running" || a.status === "queued"
  );
  if (activeAttempts.length > 0) {
    blockers.push({
      code: "running_attempts",
      message: `${activeAttempts.length} attempt(s) still running or queued`,
      detail: { attemptIds: activeAttempts.map((a) => a.id) }
    });
  }

  // (b) No claimed-but-unstarted tasks
  // "claimed" comes from OrchestratorTaskStatus (team runtime); cast for
  // backward-compat with OrchestratorStepStatus which doesn't include it yet.
  const claimedSteps = steps.filter((s) => (s.status as string) === "claimed");
  const activeTaskClaims = claims.filter(
    (c) => c.state === "active" && c.scopeKind === "task"
  );
  if (claimedSteps.length > 0 || activeTaskClaims.length > 0) {
    blockers.push({
      code: "claimed_tasks",
      message: `${claimedSteps.length} claimed step(s) and ${activeTaskClaims.length} active task claim(s) pending`,
      detail: {
        claimedStepIds: claimedSteps.map((s) => s.stepKey),
        activeClaimIds: activeTaskClaims.map((c) => c.id)
      }
    });
  }

  // (c) No unresolved blocking interventions
  if (interventions) {
    const unresolved = interventions.filter((i) => i.status !== "resolved");
    if (unresolved.length > 0) {
      blockers.push({
        code: "unresolved_interventions",
        message: `${unresolved.length} unresolved intervention(s)`,
        detail: { count: unresolved.length }
      });
    }
  }

  // (d) completion_not_requested gate removed — the act of calling
  // finalizeRun or validateRunCompletion IS the completion request.
  // The coordinator is the sole authority on when a mission is complete.

  return {
    canComplete: blockers.length === 0,
    blockers,
    validatedAt: new Date().toISOString()
  };
}

function hasMultipleLanes(steps: OrchestratorStep[]): boolean {
  const laneIds = new Set<string>();
  for (const step of steps) {
    if (step.laneId) laneIds.add(step.laneId);
  }
  return laneIds.size > 1;
}

// ─────────────────────────────────────────────────────
// Model/executor helpers
// ─────────────────────────────────────────────────────

export function phaseModelToExecutorKind(model?: string | null, fallback: OrchestratorExecutorKind = "unified"): OrchestratorExecutorKind {
  if (!model) return fallback;
  const descriptor = getModelById(model);
  if (descriptor) return "unified";
  return fallback;
}

// ─────────────────────────────────────────────────────
// Goal 1: Role isolation
// ─────────────────────────────────────────────────────

/**
 * Maps a step type (and optional task type) to an OrchestratorWorkerRole.
 * Returns null if no mapping is found.
 */
export function roleForStepType(
  stepType: string,
  taskType?: string
): OrchestratorWorkerRole | null {
  const primary = (stepType || "").trim().toLowerCase();
  const secondary = (taskType || "").trim().toLowerCase();

  // Check compound types first (test_review / review_test)
  if (
    primary === "test_review" ||
    primary === "review_test" ||
    secondary === "test_review" ||
    secondary === "review_test"
  ) {
    return "test_review";
  }

  if (primary === "analysis" || secondary === "analysis") return "implementation";
  if (
    primary === "code" ||
    primary === "implementation" ||
    secondary === "code" ||
    secondary === "implementation"
  ) {
    return "implementation";
  }
  if (
    primary === "test" ||
    primary === "validation" ||
    secondary === "test" ||
    secondary === "validation"
  ) {
    return "testing";
  }
  if (primary === "review" || secondary === "review") return "code_review";
  if (primary === "integration" || secondary === "integration") return "integration";
  return null;
}

/**
 * Validates that no worker holds conflicting roles as defined
 * by the role isolation rules. When a rule's enforcement is
 * "auto_correct", conflicting steps are split to new workers.
 */
export function validateRoleIsolation(
  steps: Array<{ stepKey: string; role: OrchestratorWorkerRole; workerId?: string }>,
  rules: RoleIsolationRule[] = DEFAULT_ROLE_ISOLATION_RULES
): RoleIsolationValidation {
  // Build a mutable copy so we can assign workerIds during correction
  const mutableSteps = steps.map((s) => ({
    stepKey: s.stepKey,
    role: s.role,
    workerId: s.workerId ?? "default-worker"
  }));

  const violations: RoleIsolationValidation["violations"] = [];
  let anyCorrected = false;

  for (const rule of rules) {
    const [roleA, roleB] = rule.mutuallyExclusive;

    // Group steps by workerId, then check whether any worker holds both roles
    const workerRoles = new Map<string, Array<{ stepKey: string; role: OrchestratorWorkerRole }>>();
    for (const step of mutableSteps) {
      const bucket = workerRoles.get(step.workerId) ?? [];
      bucket.push({ stepKey: step.stepKey, role: step.role });
      workerRoles.set(step.workerId, bucket);
    }

    for (const [workerId, workerSteps] of workerRoles) {
      const rolesInWorker = new Set(workerSteps.map((s) => s.role));
      if (rolesInWorker.has(roleA) && rolesInWorker.has(roleB)) {
        // This worker has conflicting roles
        const affectedStepIds = workerSteps
          .filter((s) => s.role === roleA || s.role === roleB)
          .map((s) => s.stepKey);

        if (rule.enforcement === "auto_correct") {
          // Split: reassign the roleB steps to a new worker
          const roleBSteps = workerSteps.filter((s) => s.role === roleB);
          const newWorkerId = `${workerId}__isolated_${roleB}`;
          for (const rbStep of roleBSteps) {
            const mutable = mutableSteps.find((s) => s.stepKey === rbStep.stepKey);
            if (mutable) {
              mutable.workerId = newWorkerId;
            }
          }
          violations.push({
            rule,
            affectedStepIds,
            correctionApplied: true,
            correctionDetail: `Split ${roleB} steps from worker "${workerId}" into new worker "${newWorkerId}".`
          });
          anyCorrected = true;
        } else {
          // reject — record the violation, do not correct
          violations.push({
            rule,
            affectedStepIds,
            correctionApplied: false,
            correctionDetail: `Worker "${workerId}" holds conflicting roles [${roleA}, ${roleB}]. Rejected.`
          });
        }
      }
    }
  }

  return {
    valid: violations.length === 0 || violations.every((v) => v.correctionApplied),
    violations,
    correctedPlan: anyCorrected ? true : undefined
  };
}

// ─────────────────────────────────────────────────────
// Context view for roles
// ─────────────────────────────────────────────────────

/**
 * Returns the context view appropriate for a given worker role.
 *
 * - implementation, planning, integration → "implementation"
 * - code_review → "review"
 * - test_review → "review"
 * - testing → "implementation"
 */
export function contextViewForRole(role: OrchestratorWorkerRole): OrchestratorContextView {
  switch (role) {
    case "implementation":
    case "planning":
    case "integration":
    case "testing":
      return "implementation";
    case "code_review":
    case "test_review":
      return "review";
    default: {
      // Exhaustiveness guard — should never reach here
      const _exhaustive: never = role;
      void _exhaustive;
      return "implementation";
    }
  }
}

// ─────────────────────────────────────────────────────
// Recovery loop evaluator
// ─────────────────────────────────────────────────────

/**
 * Applies hard guardrails to recovery-loop progression.
 * AI decides recovery action; this function only enforces policy bounds.
 */
export function evaluateRecoveryLoop(
  state: RecoveryLoopState,
  policy: RecoveryLoopPolicy
): { shouldRetry: boolean; reason: string; action: "fix" | "escalate" | "stop" } {
  // If recovery loops are disabled in policy, always stop
  if (!policy.enabled) {
    return { shouldRetry: false, reason: "Recovery loops disabled by policy.", action: "stop" };
  }

  // If exhausted flag is already set
  if (state.exhausted) {
    return {
      shouldRetry: false,
      reason: `Recovery loop exhausted: ${state.stopReason ?? "max iterations reached"}.`,
      action: policy.onExhaustion === "intervention" ? "escalate" : "stop"
    };
  }

  // Hard limit on max iterations
  if (state.currentIteration >= policy.maxIterations) {
    if (policy.onExhaustion === "fail") {
      return {
        shouldRetry: false,
        reason: `Max iterations (${policy.maxIterations}) reached. Failing.`,
        action: "stop"
      };
    }
    if (policy.onExhaustion === "intervention") {
      return {
        shouldRetry: false,
        reason: `Max iterations (${policy.maxIterations}) reached. Escalating for intervention.`,
        action: "escalate"
      };
    }
    // complete_with_risk
    return {
      shouldRetry: false,
      reason: `Max iterations (${policy.maxIterations}) reached. Completing with risk.`,
      action: "stop"
    };
  }

  // Guardrails permit another AI-directed recovery attempt.
  return {
    shouldRetry: true,
    reason: `Recovery attempt ${state.currentIteration + 1} of ${policy.maxIterations} is within policy bounds.`,
    action: "fix"
  };
}

// ─────────────────────────────────────────────────────
// Execution plan preview builder
// ─────────────────────────────────────────────────────

/**
 * Builds an ExecutionPlanPreview for UI display from the
 * resolved plan steps, policy, and team manifest.
 */
export function buildExecutionPlanPreview(args: {
  runId: string;
  missionId: string;
  steps: Array<{
    stepKey: string;
    title: string;
    role: OrchestratorWorkerRole;
    executorKind: string;
    model: string;
    laneId: string | null;
    dependencies: string[];
    phase: string;
  }>;
  policy: MissionExecutionPolicy;
  teamManifest: TeamManifest;
}): ExecutionPlanPreview {
  const { runId, missionId, steps, policy, teamManifest } = args;
  const now = new Date().toISOString();

  // ── Group steps by phase ──
  const phaseMap = new Map<string, typeof steps>();
  for (const step of steps) {
    const bucket = phaseMap.get(step.phase) ?? [];
    bucket.push(step);
    phaseMap.set(step.phase, bucket);
  }

  // ── Determine recovery policy ──
  const recoveryPolicy: RecoveryLoopPolicy =
    policy.recoveryLoop ?? DEFAULT_RECOVERY_LOOP_POLICY;

  // ── Build phase details ──
  const phases: ExecutionPlanPhase[] = [];
  const phaseOrder = [
    "implementation",
    "testing",
    "validation",
    "codeReview",
    "testReview",
    "integration"
  ];

  for (const phaseName of phaseOrder) {
    const phaseSteps = phaseMap.get(phaseName);
    if (!phaseSteps || phaseSteps.length === 0) continue;

    // Determine gate policy string for this phase
    let gatePolicy = "none";
    const phaseConfig = (policy as Record<string, any>)[phaseName];
    if (phaseConfig && typeof phaseConfig === "object" && "mode" in phaseConfig) {
      gatePolicy = phaseConfig.mode;
    }

    // Determine whether recovery is enabled for this phase
    const recoveryPhases = new Set(["testing", "codeReview", "testReview", "validation"]);
    const recoveryEnabled = recoveryPolicy.enabled && recoveryPhases.has(phaseName);

    const model = phaseSteps[0]?.model ?? "default";
    const executorKind = phaseSteps[0]?.executorKind ?? "unified";

    const stepPreviews: ExecutionPlanStepPreview[] = phaseSteps.map((step) => ({
      stepKey: step.stepKey,
      title: step.title,
      role: step.role,
      executorKind: step.executorKind as ExecutionPlanStepPreview["executorKind"],
      model: step.model,
      laneId: step.laneId,
      dependencies: step.dependencies,
      gateType: recoveryPhases.has(phaseName) ? phaseName : null,
      recoveryOnFailure: recoveryEnabled
    }));

    phases.push({
      phase: phaseName,
      enabled: true,
      stepCount: phaseSteps.length,
      steps: stepPreviews,
      model,
      executorKind: executorKind as ExecutionPlanPhase["executorKind"],
      gatePolicy,
      recoveryEnabled
    });
  }

  // ── Team summary ──
  const roles = [...new Set(teamManifest.workers.map((w) => w.role))];

  // ── Integration PR plan ──
  const integrationPrPlan = policy.integrationPr ?? DEFAULT_INTEGRATION_PR_POLICY;

  // ── Determine strategy label ──
  const laneCount = teamManifest.parallelLanes.flat().length;
  let strategy: string;
  if (laneCount > 1) {
    strategy = `Parallel execution across ${laneCount} lanes with ${teamManifest.workers.length} workers.`;
  } else if (teamManifest.workers.length > 1) {
    strategy = `Sequential multi-worker execution with ${teamManifest.workers.length} workers.`;
  } else {
    strategy = "Single-worker sequential execution.";
  }

  return {
    runId,
    missionId,
    generatedAt: now,
    strategy,
    phases,
    teamSummary: {
      workerCount: teamManifest.workers.length,
      parallelLanes: teamManifest.parallelLanes.length,
      roles
    },
    recoveryPolicy,
    integrationPrPlan,
    aligned: true,
    driftNotes: []
  };
}

// ─────────────────────────────────────────────────────
// Phase-card-based evaluation (replaces policy-based)
// ─────────────────────────────────────────────────────

/** Maps a phaseKey from PhaseCard to an ExecutionPhase */
function phaseKeyToExecutionPhase(phaseKey: string): ExecutionPhase | null {
  const key = phaseKey.trim().toLowerCase();
  if (key === "planning" || key === "analysis") return "implementation";
  if (key === "implementation" || key === "code") return "implementation";
  if (key === "testing" || key === "test") return "testing";
  if (key === "validation") return "validation";
  if (key === "code_review" || key === "codereview" || key === "review") return "codeReview";
  if (key === "test_review" || key === "testreview") return "testReview";
  if (key === "integration") return "integration";
  return null;
}

/**
 * Evaluates run completion using PhaseCard[] + MissionLevelSettings.
 * Phase present in array = enabled. validationGate.required = required.
 */
export function evaluateRunCompletionFromPhases(
  steps: OrchestratorStep[],
  phases: PhaseCard[],
  settings: MissionLevelSettings
): RunCompletionEvaluation {
  const diagnostics: CompletionDiagnostic[] = [];
  const riskFactors: string[] = [];

  // Map steps to phases
  const phaseSteps = new Map<ExecutionPhase, OrchestratorStep[]>();
  for (const step of steps) {
    const stepType = typeof step.metadata?.stepType === "string" ? step.metadata.stepType : "";
    const taskType = typeof step.metadata?.taskType === "string" ? step.metadata.taskType : "";
    const phase = stepTypeToPhase(stepType, taskType);
    if (phase) {
      const bucket = phaseSteps.get(phase) ?? [];
      bucket.push(step);
      phaseSteps.set(phase, bucket);
    }
  }

  // Derive which phases are required from the phase cards
  const enabledPhases = new Set<ExecutionPhase>();
  const requiredPhases = new Set<ExecutionPhase>();

  for (const card of phases) {
    const ep = phaseKeyToExecutionPhase(card.phaseKey);
    if (ep) {
      enabledPhases.add(ep);
      if (card.validationGate.required) {
        requiredPhases.add(ep);
      }
    }
  }

  // Implementation is always required
  enabledPhases.add("implementation");
  requiredPhases.add("implementation");

  // Integration is conditional on multi-lane
  if (settings.integrationPr && hasMultipleLanes(steps)) {
    enabledPhases.add("integration");
  }

  const allPhases: ExecutionPhase[] = [
    "implementation", "testing", "validation",
    "codeReview", "testReview", "integration"
  ];

  for (const phase of allPhases) {
    const stepsInPhase = phaseSteps.get(phase) ?? [];
    const required = requiredPhases.has(phase);
    const enabled = enabledPhases.has(phase);

    if (stepsInPhase.length === 0) {
      if (required) {
        diagnostics.push({
          phase,
          code: "phase_required_missing",
          message: `Required phase "${phase}" has no steps`,
          blocking: true
        });
        riskFactors.push(`${phase}_required_but_missing`);
      } else if (!enabled) {
        diagnostics.push({
          phase,
          code: "phase_skipped_by_policy",
          message: `Phase "${phase}" not included in phase cards`,
          blocking: false
        });
      }
      continue;
    }

    const statuses = stepsInPhase.map((s) => s.status);
    const allTerminal = statuses.every((s) => TERMINAL_STEP_STATUSES.has(s));
    const anyFailed = statuses.some((s) => s === "failed");
    const allSucceededOrSkipped = statuses.every((s) => s === "succeeded" || s === "skipped" || s === "superseded");
    const anyBlocked = statuses.some((s) => s === "blocked");
    const anyInProgress = statuses.some((s) => s === "running" || s === "ready" || s === "pending");

    if (allSucceededOrSkipped) {
      diagnostics.push({
        phase,
        code: "phase_succeeded",
        message: `Phase "${phase}" completed successfully`,
        blocking: false
      });
    } else if (anyFailed && allTerminal) {
      const blocking = required;
      diagnostics.push({
        phase,
        code: "phase_failed",
        message: `Phase "${phase}" has failed steps`,
        blocking
      });
      if (!blocking && required) {
        riskFactors.push(`${phase}_failed`);
      }
    } else if (anyBlocked || anyInProgress) {
      diagnostics.push({
        phase,
        code: "phase_in_progress",
        message: `Phase "${phase}" still in progress`,
        blocking: true
      });
    }
  }

  // Check validation contracts
  const requiredValidationMissingStepKeys = steps
    .filter((step) => step.status === "succeeded")
    .filter((step) => {
      const meta = step.metadata ?? {};
      const validationContract =
        typeof meta.validationContract === "object" && meta.validationContract
          ? (meta.validationContract as Record<string, unknown>)
          : null;
      if (validationContract?.required !== true) return false;
      const lastValidationReport =
        typeof meta.lastValidationReport === "object" && meta.lastValidationReport
          ? (meta.lastValidationReport as Record<string, unknown>)
          : null;
      const lastVerdict = typeof lastValidationReport?.verdict === "string" ? lastValidationReport.verdict.toLowerCase() : "";
      const validationState = typeof meta.validationState === "string" ? meta.validationState.toLowerCase() : "";
      const validationPassedAt = typeof meta.validationPassedAt === "string" ? meta.validationPassedAt.trim() : "";
      return !(lastVerdict === "pass" || validationState === "pass" || validationPassedAt.length > 0);
    })
    .map((step) => step.stepKey);

  if (requiredValidationMissingStepKeys.length > 0) {
    diagnostics.push({
      phase: "validation",
      code: "required_validation_missing",
      message: "Succeeded steps are missing a passing required validation contract.",
      blocking: true,
      details: { stepKeys: requiredValidationMissingStepKeys }
    });
    riskFactors.push(`required_validation_missing: ${requiredValidationMissingStepKeys.join(", ")}`);
  }

  // Compute overall status
  const hasBlockingDiagnostics = diagnostics.some((d) => d.blocking);
  const anyPhaseFailed = diagnostics.some((d) => d.code === "phase_failed");
  const anyPhaseInProgress = diagnostics.some((d) => d.code === "phase_in_progress");

  const allStepStatuses = steps.map((s) => s.status);
  const allStepsTerminal = allStepStatuses.every((s) => TERMINAL_STEP_STATUSES.has(s));
  const anyStepBlocked = allStepStatuses.some((s) => s === "blocked");
  const anyStepRunning = allStepStatuses.some((s) => s === "running" || s === "ready" || s === "pending");

  let status: OrchestratorRunStatus;
  let completionReady: boolean;

  if (anyPhaseInProgress || anyStepRunning) {
    status = "active";
    completionReady = false;
  } else if (anyStepBlocked) {
    status = "paused";
    completionReady = false;
  } else if (anyPhaseFailed && hasBlockingDiagnostics) {
    status = "failed";
    completionReady = true;
  } else if (allStepsTerminal && !hasBlockingDiagnostics && riskFactors.length > 0) {
    status = "succeeded";
    completionReady = true;
  } else if (allStepsTerminal && !hasBlockingDiagnostics) {
    const allSucceeded = allStepStatuses.every((s) => s === "succeeded" || s === "skipped" || s === "superseded");
    status = allSucceeded ? "succeeded" : "failed";
    completionReady = true;
  } else {
    status = "active";
    completionReady = false;
  }

  return { status, diagnostics, riskFactors, completionReady };
}

/**
 * Builds an ExecutionPlanPreview from phase cards instead of policy.
 */
export function buildExecutionPlanPreviewFromPhases(args: {
  runId: string;
  missionId: string;
  steps: Array<{
    stepKey: string;
    title: string;
    role: OrchestratorWorkerRole;
    executorKind: string;
    model: string;
    laneId: string | null;
    dependencies: string[];
    phase: string;
  }>;
  phases: PhaseCard[];
  settings: MissionLevelSettings;
  teamManifest: TeamManifest;
}): ExecutionPlanPreview {
  const { runId, missionId, steps, phases, settings, teamManifest } = args;
  const now = new Date().toISOString();

  // Group steps by phase
  const phaseMap = new Map<string, typeof steps>();
  for (const step of steps) {
    const bucket = phaseMap.get(step.phase) ?? [];
    bucket.push(step);
    phaseMap.set(step.phase, bucket);
  }

  // Determine recovery policy
  const recoveryPolicy: RecoveryLoopPolicy =
    settings.recoveryLoop ?? DEFAULT_RECOVERY_LOOP_POLICY;

  // Build phase details from phase cards
  const phaseDetails: ExecutionPlanPhase[] = [];
  const cardsByPhaseKey = new Map<string, PhaseCard>();
  for (const card of phases) {
    const ep = phaseKeyToExecutionPhase(card.phaseKey);
    if (ep) cardsByPhaseKey.set(ep, card);
  }

  const phaseOrder = [
    "implementation", "testing", "validation",
    "codeReview", "testReview", "integration"
  ];

  for (const phaseName of phaseOrder) {
    const phaseSteps = phaseMap.get(phaseName);
    if (!phaseSteps || phaseSteps.length === 0) continue;

    const card = cardsByPhaseKey.get(phaseName);
    const gatePolicy = card?.validationGate.required ? "required" : (card?.validationGate.tier ?? "none");

    const recoveryPhases = new Set(["testing", "codeReview", "testReview", "validation"]);
    const recoveryEnabled = recoveryPolicy.enabled && recoveryPhases.has(phaseName);

    const model = phaseSteps[0]?.model ?? "default";
    const executorKind = phaseSteps[0]?.executorKind ?? "unified";

    const stepPreviews: ExecutionPlanStepPreview[] = phaseSteps.map((step) => ({
      stepKey: step.stepKey,
      title: step.title,
      role: step.role,
      executorKind: step.executorKind as ExecutionPlanStepPreview["executorKind"],
      model: step.model,
      laneId: step.laneId,
      dependencies: step.dependencies,
      gateType: recoveryPhases.has(phaseName) ? phaseName : null,
      recoveryOnFailure: recoveryEnabled
    }));

    phaseDetails.push({
      phase: phaseName,
      enabled: true,
      stepCount: phaseSteps.length,
      steps: stepPreviews,
      model,
      executorKind: executorKind as ExecutionPlanPhase["executorKind"],
      gatePolicy,
      recoveryEnabled
    });
  }

  // Team summary
  const roles = [...new Set(teamManifest.workers.map((w) => w.role))];

  // Integration PR plan
  const integrationPrPlan = settings.integrationPr ?? DEFAULT_INTEGRATION_PR_POLICY;

  // Strategy label
  const laneCount = teamManifest.parallelLanes.flat().length;
  let strategy: string;
  if (laneCount > 1) {
    strategy = `Parallel execution across ${laneCount} lanes with ${teamManifest.workers.length} workers.`;
  } else if (teamManifest.workers.length > 1) {
    strategy = `Sequential multi-worker execution with ${teamManifest.workers.length} workers.`;
  } else {
    strategy = "Single-worker sequential execution.";
  }

  return {
    runId,
    missionId,
    generatedAt: now,
    strategy,
    phases: phaseDetails,
    teamSummary: {
      workerCount: teamManifest.workers.length,
      parallelLanes: teamManifest.parallelLanes.length,
      roles
    },
    recoveryPolicy,
    integrationPrPlan,
    aligned: true,
    driftNotes: []
  };
}
