import type {
  MissionDepthTier,
  MissionExecutionPolicy,
  CompletionDiagnostic,
  RunCompletionEvaluation,
  OrchestratorRunStatus,
  OrchestratorStep,
  OrchestratorStepStatus
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
  merge: { mode: "manual" },
  completion: { allowCompletionWithRisk: true }
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
        merge: { mode: "manual" },
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
        merge: { mode: "manual" },
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
      merge: mergePhase(p.merge, base.merge),
      completion: mergePhase(p.completion, base.completion)
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
      merge: mergePhase(p.merge, base.merge),
      completion: mergePhase(p.completion, base.completion)
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
    merge: policy.merge.mode !== "off"
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
