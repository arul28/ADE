import type {
  MissionDepthTier,
  MissionExecutionPolicy,
  CompletionDiagnostic,
  RunCompletionEvaluation,
  OrchestratorRunStatus,
  OrchestratorStep,
  OrchestratorStepStatus,
  OrchestratorWorkerRole,
  RoleIsolationRule,
  RoleIsolationValidation,
  TeamManifest,
  TeamComplexityAssessment,
  TeamWorkerAssignment,
  TeamDecisionEntry,
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
} from "../../../shared/types";

// ─────────────────────────────────────────────────────
// Default policy
// ─────────────────────────────────────────────────────

export const DEFAULT_EXECUTION_POLICY: MissionExecutionPolicy = {
  planning: { mode: "auto", model: "codex" },
  implementation: { model: "codex" },
  testing: { mode: "post_implementation", model: "codex" },
  validation: { mode: "optional", model: "codex" },
  codeReview: { mode: "off" },
  testReview: { mode: "off" },
  integration: { mode: "auto", model: "codex" },
  merge: { mode: "off" },
  completion: { allowCompletionWithRisk: true },
  prStrategy: { kind: "integration", targetBranch: "main", draft: true }
};

// ─────────────────────────────────────────────────────
// Depth tier → policy conversion (backward compat)
// ─────────────────────────────────────────────────────

export function depthTierToPolicy(tier: MissionDepthTier): MissionExecutionPolicy {
  switch (tier) {
    case "light":
      return {
        planning: { mode: "off" },
        implementation: { model: "codex" },
        testing: { mode: "none" },
        validation: { mode: "off" },
        codeReview: { mode: "off" },
        testReview: { mode: "off" },
        integration: { mode: "off" },
        merge: { mode: "off" },
        completion: { allowCompletionWithRisk: true }
      };
    case "deep":
      return {
        planning: { mode: "manual_review", model: "claude" },
        implementation: { model: "codex" },
        testing: { mode: "post_implementation", model: "codex" },
        validation: { mode: "required", model: "codex" },
        codeReview: { mode: "required", model: "claude" },
        testReview: { mode: "required", model: "codex" },
        integration: { mode: "auto", model: "codex" },
        merge: { mode: "off" },
        completion: { allowCompletionWithRisk: false }
      };
    case "standard":
    default:
      return {
        planning: { mode: "auto", model: "codex" },
        implementation: { model: "codex" },
        testing: { mode: "post_implementation", model: "codex" },
        validation: { mode: "optional", model: "codex" },
        codeReview: { mode: "off" },
        testReview: { mode: "off" },
        integration: { mode: "auto", model: "codex" },
        merge: { mode: "off" },
        completion: { allowCompletionWithRisk: true }
      };
  }
}

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
  missionDepthTier?: MissionDepthTier | null;
  projectConfig?: Partial<MissionExecutionPolicy> | null;
  fallback?: MissionExecutionPolicy;
}): MissionExecutionPolicy {
  // Priority: mission metadata > depth tier conversion > project config > fallback > DEFAULT
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
      integration: mergePhase(p.integration, base.integration),
      merge: { mode: "off" },
      completion: mergePhase(p.completion, base.completion),
      prStrategy: p.prStrategy ?? base.prStrategy
    };
  } else if (sources.missionDepthTier) {
    resolved = depthTierToPolicy(sources.missionDepthTier);
  } else if (sources.projectConfig) {
    const p = sources.projectConfig;
    resolved = {
      planning: mergePhase(p.planning, base.planning),
      implementation: mergePhase(p.implementation, base.implementation),
      testing: mergePhase(p.testing, base.testing),
      validation: mergePhase(p.validation, base.validation),
      codeReview: mergePhase(p.codeReview, base.codeReview),
      testReview: mergePhase(p.testReview, base.testReview),
      integration: mergePhase(p.integration, base.integration),
      merge: { mode: "off" },
      completion: mergePhase(p.completion, base.completion),
      prStrategy: p.prStrategy ?? base.prStrategy
    };
  } else {
    resolved = base;
  }

  // Always enforce merge off
  resolved.merge = { mode: "off" };

  return resolved;
}

// ─────────────────────────────────────────────────────
// Phase ↔ step type mapping
// ─────────────────────────────────────────────────────

export type ExecutionPhase =
  | "planning"
  | "implementation"
  | "testing"
  | "validation"
  | "codeReview"
  | "testReview"
  | "integration"
  | "merge";

export function stepTypeToPhase(stepType: string, taskType?: string): ExecutionPhase | null {
  const primary = (stepType || "").trim().toLowerCase();
  const secondary = (taskType || "").trim().toLowerCase();
  if (primary === "test_review" || secondary === "test_review" || primary === "review_test" || secondary === "review_test") {
    return "testReview";
  }

  if (primary === "analysis" || secondary === "analysis") return "planning";
  if (primary === "code" || primary === "implementation" || secondary === "code" || secondary === "implementation") return "implementation";
  if (primary === "test" || primary === "validation" || secondary === "test" || secondary === "validation") return "testing";
  if ((primary === "review" && (secondary === "test" || secondary === "validation")) || (secondary === "review" && primary === "test")) {
    return "testReview";
  }
  if (primary === "review" || secondary === "review") return "codeReview";
  if (primary === "integration" || secondary === "integration") return "integration";
  if (primary === "merge" || secondary === "merge") return "merge";
  return null;
}

// ─────────────────────────────────────────────────────
// Completion evaluator
// ─────────────────────────────────────────────────────

const TERMINAL_STEP_STATUSES = new Set<OrchestratorStepStatus>(["succeeded", "failed", "skipped", "canceled"]);

export function evaluateRunCompletion(
  steps: OrchestratorStep[],
  policy: MissionExecutionPolicy | null
): RunCompletionEvaluation {
  // Null policy → legacy behavior
  if (policy === null) {
    return evaluateLegacy(steps);
  }

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
  const phaseRequired: Record<ExecutionPhase, boolean> = {
    planning: policy.planning.mode !== "off",
    implementation: true, // always required
    testing: policy.testing.mode !== "none",
    validation: policy.validation.mode === "required",
    codeReview: policy.codeReview.mode === "required",
    testReview: policy.testReview.mode === "required",
    integration: policy.integration.mode === "auto" && hasMultipleLanes(steps),
    merge: false
  };

  const allPhases: ExecutionPhase[] = [
    "planning",
    "implementation",
    "testing",
    "validation",
    "codeReview",
    "testReview",
    "integration",
    "merge"
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
          blocking: !policy.completion.allowCompletionWithRisk
        });
        if (policy.completion.allowCompletionWithRisk) {
          riskFactors.push(`${phase}_required_but_missing`);
        }
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
    const allSucceededOrSkipped = statuses.every((s) => s === "succeeded" || s === "skipped");
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
      diagnostics.push({
        phase,
        code: "phase_failed",
        message: `Phase "${phase}" has failed steps`,
        blocking: required
      });
    } else if (anyBlocked || anyInProgress) {
      diagnostics.push({
        phase,
        code: "phase_in_progress",
        message: `Phase "${phase}" still in progress`,
        blocking: true
      });
    }
  }

  // Compute overall status
  const hasBlockingDiagnostics = diagnostics.some((d) => d.blocking);
  const anyPhaseFailed = diagnostics.some((d) => d.code === "phase_failed");
  const anyPhaseInProgress = diagnostics.some((d) => d.code === "phase_in_progress");

  // Also check raw step statuses for legacy safety
  const allStepStatuses = steps.map((s) => s.status);
  const allStepsTerminal = allStepStatuses.every((s) => TERMINAL_STEP_STATUSES.has(s));
  const anyStepBlocked = allStepStatuses.some((s) => s === "blocked");
  const anyStepRunning = allStepStatuses.some((s) => s === "running" || s === "ready" || s === "pending");

  let status: OrchestratorRunStatus;
  let completionReady: boolean;

  if (anyPhaseInProgress || anyStepRunning) {
    status = "running";
    completionReady = false;
  } else if (anyStepBlocked) {
    status = "paused";
    completionReady = false;
  } else if (anyPhaseFailed && hasBlockingDiagnostics) {
    status = "failed";
    completionReady = true;
  } else if (allStepsTerminal && !hasBlockingDiagnostics && riskFactors.length > 0) {
    status = "succeeded_with_risk";
    completionReady = true;
  } else if (allStepsTerminal && !hasBlockingDiagnostics) {
    const allSucceeded = allStepStatuses.every((s) => s === "succeeded" || s === "skipped");
    status = allSucceeded ? "succeeded" : "failed";
    completionReady = true;
  } else if (hasBlockingDiagnostics && !policy.completion.allowCompletionWithRisk) {
    status = "running"; // not ready to complete
    completionReady = false;
  } else {
    status = "running";
    completionReady = false;
  }

  return { status, diagnostics, riskFactors, completionReady };
}

function evaluateLegacy(steps: OrchestratorStep[]): RunCompletionEvaluation {
  if (!steps.length) {
    return { status: "succeeded", diagnostics: [], riskFactors: [], completionReady: true };
  }
  const statuses = steps.map((s) => s.status);
  const allTerminal = statuses.every((s) => TERMINAL_STEP_STATUSES.has(s));
  let status: OrchestratorRunStatus;

  if (allTerminal && statuses.every((s) => s === "succeeded" || s === "skipped")) {
    status = "succeeded";
  } else if (allTerminal && statuses.every((s) => s === "canceled")) {
    status = "canceled";
  } else if (allTerminal && statuses.some((s) => s === "failed")) {
    status = "failed";
  } else if (allTerminal && statuses.some((s) => s === "blocked")) {
    status = "paused";
  } else if (statuses.some((s) => s === "running")) {
    status = "running";
  } else if (statuses.some((s) => s === "ready" || s === "pending")) {
    status = "running";
  } else if (statuses.some((s) => s === "blocked")) {
    status = "paused";
  } else {
    status = "running";
  }

  return {
    status,
    diagnostics: [],
    riskFactors: [],
    completionReady: TERMINAL_RUN_STATUSES_SET.has(status)
  };
}

const TERMINAL_RUN_STATUSES_SET = new Set<OrchestratorRunStatus>([
  "succeeded", "succeeded_with_risk", "failed", "canceled"
]);

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

export function phaseModelToExecutorKind(model?: string | null): "claude" | "codex" {
  if (model === "claude") return "claude";
  return "codex";
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

  if (primary === "analysis" || secondary === "analysis") return "planning";
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
  if (primary === "merge" || secondary === "merge") return "merge";
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
// Goal 2: Team synthesis
// ─────────────────────────────────────────────────────

/**
 * Creates a team manifest from the plan steps.
 *
 * Groups steps by (role + laneId), assigns unique workers,
 * assesses complexity, computes parallelism cap, and
 * generates a decision log.
 */
export function synthesizeTeam(args: {
  steps: Array<{
    stepKey: string;
    title: string;
    role: OrchestratorWorkerRole;
    laneId: string | null;
    executorKind: string;
  }>;
  policy: MissionExecutionPolicy;
  promptHints: {
    domain?: string;
    complexity?: string;
    thoroughness?: boolean;
    parallelismCap?: number;
    plannerCap?: number;
  };
}): TeamManifest {
  const { steps, policy, promptHints } = args;
  const now = new Date().toISOString();
  const decisionLog: TeamDecisionEntry[] = [];

  // ── Group steps by (role, laneId) ──
  const groupKey = (role: OrchestratorWorkerRole, laneId: string | null) =>
    `${role}::${laneId ?? "__default__"}`;

  const groups = new Map<
    string,
    { role: OrchestratorWorkerRole; laneId: string | null; stepKeys: string[]; executorKind: string }
  >();

  for (const step of steps) {
    const key = groupKey(step.role, step.laneId);
    const existing = groups.get(key);
    if (existing) {
      existing.stepKeys.push(step.stepKey);
    } else {
      groups.set(key, {
        role: step.role,
        laneId: step.laneId,
        stepKeys: [step.stepKey],
        executorKind: step.executorKind
      });
    }
  }

  // ── Build worker assignments ──
  const workers: TeamWorkerAssignment[] = [];
  let workerIndex = 0;
  for (const [, group] of groups) {
    const workerId = `worker-${group.role}-${workerIndex++}`;
    workers.push({
      workerId,
      role: group.role,
      assignedStepKeys: group.stepKeys,
      laneId: group.laneId,
      executorKind: group.executorKind as TeamWorkerAssignment["executorKind"]
    });
  }

  decisionLog.push({
    timestamp: now,
    decision: `Created ${workers.length} workers from ${groups.size} step groups.`,
    reason: "Each unique (role, laneId) combination maps to one worker.",
    source: "dag_shape"
  });

  // ── Detect parallel lanes ──
  const laneIds = new Set<string>();
  for (const step of steps) {
    if (step.laneId) laneIds.add(step.laneId);
  }
  const laneIdList = [...laneIds];

  // Group parallel lanes: lanes are parallel if different workers operate in them
  const parallelLanes: string[][] = [];
  if (laneIdList.length > 1) {
    // All distinct lanes are considered parallel (no explicit dependency info at this level)
    parallelLanes.push(laneIdList);
  }

  // ── Complexity assessment ──
  const domainRaw = (promptHints.domain ?? "mixed").toLowerCase();
  const domainMap: Record<string, TeamComplexityAssessment["domain"]> = {
    frontend: "frontend",
    backend: "backend",
    fullstack: "fullstack",
    infra: "infra"
  };
  const domain: TeamComplexityAssessment["domain"] = domainMap[domainRaw] ?? "mixed";

  const stepCount = steps.length;
  let estimatedScope: TeamComplexityAssessment["estimatedScope"];
  if (stepCount <= 3) {
    estimatedScope = "small";
  } else if (stepCount <= 8) {
    estimatedScope = "medium";
  } else if (stepCount <= 20) {
    estimatedScope = "large";
  } else {
    estimatedScope = "very_large";
  }

  // Allow prompt hint to override
  if (promptHints.complexity) {
    const hint = promptHints.complexity.toLowerCase();
    if (hint === "small" || hint === "medium" || hint === "large" || hint === "very_large") {
      estimatedScope = hint as TeamComplexityAssessment["estimatedScope"];
      decisionLog.push({
        timestamp: now,
        decision: `Overrode scope to "${hint}" from prompt hint.`,
        reason: "Prompt explicitly specified complexity.",
        source: "prompt"
      });
    }
  }

  const requiresIntegration =
    policy.integration.mode === "auto" && laneIdList.length > 1;

  const complexity: TeamComplexityAssessment = {
    domain,
    estimatedScope,
    parallelizable: laneIdList.length > 1,
    requiresIntegration,
    fileZoneCount: laneIdList.length || 1,
    thoroughnessRequested: promptHints.thoroughness ?? false
  };

  decisionLog.push({
    timestamp: now,
    decision: `Complexity: scope=${estimatedScope}, domain=${domain}, parallel=${complexity.parallelizable}.`,
    reason: `Step count=${stepCount}, lanes=${laneIdList.length}.`,
    source: "complexity"
  });

  // ── Parallelism cap ──
  const scopeToParallelism: Record<TeamComplexityAssessment["estimatedScope"], number> = {
    small: 2,
    medium: 4,
    large: 8,
    very_large: 16
  };
  let parallelismCap: number;

  // AI planner cap takes priority over scope heuristic
  if (promptHints.plannerCap !== undefined && promptHints.plannerCap >= 1 && promptHints.plannerCap <= 32) {
    parallelismCap = promptHints.plannerCap;
    decisionLog.push({
      timestamp: now,
      decision: `Parallelism cap set to ${parallelismCap} from AI planner.`,
      reason: "AI planner recommended parallelism cap.",
      source: "override"
    });
  } else {
    parallelismCap = scopeToParallelism[estimatedScope];
  }

  if (promptHints.thoroughness) {
    parallelismCap += 2;
    decisionLog.push({
      timestamp: now,
      decision: `Increased parallelismCap by 2 for thoroughness.`,
      reason: "Prompt requested thoroughness.",
      source: "prompt"
    });
  }

  if (promptHints.parallelismCap !== undefined) {
    parallelismCap = promptHints.parallelismCap;
    decisionLog.push({
      timestamp: now,
      decision: `Overrode parallelismCap to ${parallelismCap}.`,
      reason: "Explicit parallelismCap from prompt hints.",
      source: "override"
    });
  }

  // Safety ceiling
  parallelismCap = Math.min(parallelismCap, 32);

  decisionLog.push({
    timestamp: now,
    decision: `Final parallelismCap = ${parallelismCap}.`,
    reason: `Based on scope "${estimatedScope}" with hint adjustments.`,
    source: "policy"
  });

  // ── Rationale ──
  const roleList = [...new Set(workers.map((w) => w.role))];
  const rationale =
    `Team of ${workers.length} worker(s) covering roles [${roleList.join(", ")}]. ` +
    `Scope: ${estimatedScope}, domain: ${domain}. ` +
    `${parallelLanes.length > 0 ? `Parallel lanes: ${laneIdList.join(", ")}.` : "Sequential execution."}`;

  return {
    runId: "",
    missionId: "",
    synthesizedAt: now,
    rationale,
    complexity,
    workers,
    parallelismCap,
    parallelLanes,
    decisionLog
  };
}

// ─────────────────────────────────────────────────────
// Context view for roles
// ─────────────────────────────────────────────────────

/**
 * Returns the context view appropriate for a given worker role.
 *
 * - implementation, planning, integration, merge → "implementation"
 * - code_review → "review"
 * - test_review → "review"
 * - testing → "implementation"
 */
export function contextViewForRole(role: OrchestratorWorkerRole): OrchestratorContextView {
  switch (role) {
    case "implementation":
    case "planning":
    case "integration":
    case "merge":
    case "testing":
      return "implementation";
    case "code_review":
    case "test_review":
      return "review";
    default: {
      // Exhaustiveness guard — should never reach here
      const _exhaustive: never = role;
      return "implementation";
    }
  }
}

// ─────────────────────────────────────────────────────
// Recovery loop evaluator
// ─────────────────────────────────────────────────────

/**
 * Evaluates whether a recovery loop should continue, escalate,
 * or stop based on the current state and policy.
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

  // Check max iterations
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

  // Anti-thrash: check stagnation (consecutive failures without progress)
  if (policy.escalateAfterStagnant !== undefined && state.iterations.length > 0) {
    const recentIterations = state.iterations.slice(-policy.escalateAfterStagnant);
    if (recentIterations.length >= policy.escalateAfterStagnant) {
      const allStillFailing = recentIterations.every(
        (iter) => iter.outcome === "still_failing"
      );
      if (allStillFailing) {
        return {
          shouldRetry: false,
          reason: `Stagnation detected: ${policy.escalateAfterStagnant} consecutive failures with no progress.`,
          action: "escalate"
        };
      }
    }
  }

  // Anti-thrash: minimum confidence delta
  if (
    policy.minConfidenceDelta !== undefined &&
    state.iterations.length >= 2
  ) {
    const lastTwo = state.iterations.slice(-2);
    const prevConfidence = lastTwo[0].confidence;
    const currConfidence = lastTwo[1].confidence;
    if (
      prevConfidence !== undefined &&
      currConfidence !== undefined &&
      currConfidence - prevConfidence < policy.minConfidenceDelta
    ) {
      return {
        shouldRetry: false,
        reason: `Confidence delta (${(currConfidence - prevConfidence).toFixed(2)}) below threshold (${policy.minConfidenceDelta}).`,
        action: "escalate"
      };
    }
  }

  // Otherwise, retry
  return {
    shouldRetry: true,
    reason: `Iteration ${state.currentIteration + 1} of ${policy.maxIterations} — retrying.`,
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
    "planning",
    "implementation",
    "testing",
    "validation",
    "codeReview",
    "testReview",
    "integration",
    "merge"
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

    const model = phaseSteps[0]?.model ?? "codex";
    const executorKind = phaseSteps[0]?.executorKind ?? "codex";

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
