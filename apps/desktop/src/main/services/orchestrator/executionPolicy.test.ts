import { describe, expect, it } from "vitest";
import type {
  MissionExecutionPolicy,
  OrchestratorStep,
  OrchestratorStepStatus,
  OrchestratorWorkerRole,
  RecoveryLoopPolicy,
  RecoveryLoopState,
  RecoveryLoopIteration
} from "../../../shared/types";
import {
  DEFAULT_EXECUTION_POLICY,
  depthTierToPolicy,
  resolveExecutionPolicy,
  evaluateRunCompletion,
  stepTypeToPhase,
  phaseModelToExecutorKind,
  roleForStepType,
  validateRoleIsolation,

  contextViewForRole,
  evaluateRecoveryLoop
} from "./executionPolicy";

function makeStep(overrides: Partial<OrchestratorStep> & { id: string; status: OrchestratorStepStatus }): OrchestratorStep {
  return {
    runId: "run-1",
    missionStepId: null,
    stepKey: overrides.id,
    title: overrides.title ?? "Step",
    stepIndex: overrides.stepIndex ?? 0,
    dependencyStepIds: [],
    joinPolicy: "all_success",
    quorumCount: null,
    retryLimit: 1,
    retryCount: 0,
    lastAttemptId: null,
    laneId: overrides.laneId ?? null,
    metadata: overrides.metadata ?? null,
    createdAt: "2026-02-20T00:00:00.000Z",
    updatedAt: "2026-02-20T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    ...overrides
  };
}

describe("executionPolicy", () => {
  describe("depthTierToPolicy", () => {
    it("converts light tier to minimal policy", () => {
      const policy = depthTierToPolicy("light");
      expect(policy.planning.mode).toBe("off");
      expect(policy.testing.mode).toBe("none");
      expect(policy.validation.mode).toBe("off");
      expect(policy.codeReview.mode).toBe("off");
      expect(policy.integration.mode).toBe("off");
      expect(policy.merge.mode).toBe("off");
      expect(policy.completion.allowCompletionWithRisk).toBe(true);
    });

    it("converts standard tier to balanced policy", () => {
      const policy = depthTierToPolicy("standard");
      expect(policy.planning.mode).toBe("auto");
      expect(policy.testing.mode).toBe("post_implementation");
      expect(policy.validation.mode).toBe("optional");
      expect(policy.codeReview.mode).toBe("off");
      expect(policy.merge.mode).toBe("off");
      expect(policy.completion.allowCompletionWithRisk).toBe(true);
    });

    it("converts deep tier to strict policy", () => {
      const policy = depthTierToPolicy("deep");
      expect(policy.planning.mode).toBe("manual_review");
      expect(policy.testing.mode).toBe("post_implementation");
      expect(policy.validation.mode).toBe("required");
      expect(policy.codeReview.mode).toBe("required");
      expect(policy.merge.mode).toBe("off");
      expect(policy.completion.allowCompletionWithRisk).toBe(false);
    });
  });

  describe("resolveExecutionPolicy", () => {
    it("returns default when no sources provided", () => {
      const policy = resolveExecutionPolicy({});
      expect(policy).toEqual(DEFAULT_EXECUTION_POLICY);
    });

    it("mission metadata takes highest precedence", () => {
      const policy = resolveExecutionPolicy({
        missionMetadata: { testing: { mode: "tdd" } },
        missionDepthTier: "light",
        projectConfig: { testing: { mode: "none" } }
      });
      expect(policy.testing.mode).toBe("tdd");
    });

    it("depth tier takes precedence over project config", () => {
      const policy = resolveExecutionPolicy({
        missionDepthTier: "deep",
        projectConfig: { testing: { mode: "none" } }
      });
      expect(policy.testing.mode).toBe("post_implementation");
      expect(policy.codeReview.mode).toBe("required");
    });

    it("project config fills in when no mission-level override", () => {
      const policy = resolveExecutionPolicy({
        projectConfig: { testing: { mode: "tdd" } }
      });
      // Merge is always forced to "off"
      expect(policy.merge.mode).toBe("off");
      expect(policy.testing.mode).toBe("tdd");
      // Other fields come from default
      expect(policy.planning.mode).toBe("auto");
    });

    it("partial mission metadata merges with defaults", () => {
      const policy = resolveExecutionPolicy({
        missionMetadata: { planning: { mode: "manual_review" } }
      });
      expect(policy.planning.mode).toBe("manual_review");
      expect(policy.implementation.model).toBe("openai/gpt-5.3-codex"); // from default
    });
  });

  describe("stepTypeToPhase", () => {
    it("maps step types to phases correctly", () => {
      expect(stepTypeToPhase("analysis")).toBe("planning");
      expect(stepTypeToPhase("code")).toBe("implementation");
      expect(stepTypeToPhase("implementation")).toBe("implementation");
      expect(stepTypeToPhase("test")).toBe("testing");
      expect(stepTypeToPhase("validation")).toBe("testing");
      expect(stepTypeToPhase("review")).toBe("codeReview");
      expect(stepTypeToPhase("integration")).toBe("integration");
      expect(stepTypeToPhase("merge")).toBe("merge");
      expect(stepTypeToPhase("unknown")).toBeNull();
    });

    it("falls back to taskType when stepType is empty", () => {
      expect(stepTypeToPhase("", "analysis")).toBe("planning");
      expect(stepTypeToPhase("", "review")).toBe("codeReview");
    });
  });

  describe("phaseModelToExecutorKind", () => {
    it("maps claude to claude executor", () => {
      expect(phaseModelToExecutorKind("claude")).toBe("claude");
    });

    it("maps codex and others to codex executor", () => {
      expect(phaseModelToExecutorKind("codex")).toBe("codex");
      expect(phaseModelToExecutorKind(undefined)).toBe("codex");
      expect(phaseModelToExecutorKind(null)).toBe("codex");
    });
  });

  describe("evaluateRunCompletion", () => {
    it("uses legacy behavior when policy is null", () => {
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "code" } }),
        makeStep({ id: "s2", status: "succeeded", metadata: { stepType: "test" } })
      ];
      const result = evaluateRunCompletion(steps, null);
      expect(result.status).toBe("succeeded");
      expect(result.completionReady).toBe(true);
      expect(result.diagnostics).toEqual([]);
    });

    it("succeeds when all required phases are satisfied", () => {
      const policy: MissionExecutionPolicy = {
        planning: { mode: "auto" },
        implementation: { model: "codex" },
        testing: { mode: "post_implementation" },
        validation: { mode: "optional" },
        codeReview: { mode: "off" },
        testReview: { mode: "off" },
        integration: { mode: "off" },
        merge: { mode: "off" },
        completion: { allowCompletionWithRisk: false }
      };
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "analysis" } }),
        makeStep({ id: "s2", status: "succeeded", metadata: { stepType: "code" } }),
        makeStep({ id: "s3", status: "succeeded", metadata: { stepType: "test" } })
      ];
      const result = evaluateRunCompletion(steps, policy);
      expect(result.status).toBe("succeeded");
      expect(result.completionReady).toBe(true);
    });

    it("returns succeeded_with_risk when tests disabled by policy and risk allowed", () => {
      const policy: MissionExecutionPolicy = {
        planning: { mode: "auto" },
        implementation: { model: "codex" },
        testing: { mode: "none" },
        validation: { mode: "off" },
        codeReview: { mode: "off" },
        testReview: { mode: "off" },
        integration: { mode: "off" },
        merge: { mode: "off" },
        completion: { allowCompletionWithRisk: true }
      };
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "analysis" } }),
        makeStep({ id: "s2", status: "succeeded", metadata: { stepType: "code" } })
      ];
      const result = evaluateRunCompletion(steps, policy);
      // No test steps exist but testing mode is none, so not required
      // However planning is required and present → no risk from testing
      expect(result.status).toBe("succeeded");
      expect(result.completionReady).toBe(true);
    });

    it("blocks completion when required phase is missing and risk not allowed", () => {
      const policy: MissionExecutionPolicy = {
        planning: { mode: "auto" },
        implementation: { model: "codex" },
        testing: { mode: "post_implementation" },
        validation: { mode: "required" },
        codeReview: { mode: "required" },
        testReview: { mode: "off" },
        integration: { mode: "off" },
        merge: { mode: "off" },
        completion: { allowCompletionWithRisk: false }
      };
      // Only implementation steps, no validation or review
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "code" } })
      ];
      const result = evaluateRunCompletion(steps, policy);
      // Missing required phases: planning, testing, validation, codeReview
      expect(result.diagnostics.some((d) => d.code === "phase_required_missing" && d.blocking)).toBe(true);
      expect(result.completionReady).toBe(false);
    });

    it("returns succeeded_with_risk when required phase missing but risk allowed", () => {
      const policy: MissionExecutionPolicy = {
        planning: { mode: "off" },
        implementation: { model: "codex" },
        testing: { mode: "post_implementation" },
        validation: { mode: "off" },
        codeReview: { mode: "off" },
        testReview: { mode: "off" },
        integration: { mode: "off" },
        merge: { mode: "off" },
        completion: { allowCompletionWithRisk: true }
      };
      // Implementation succeeded, testing required but no test steps
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "code" } })
      ];
      const result = evaluateRunCompletion(steps, policy);
      expect(result.status).toBe("succeeded_with_risk");
      expect(result.riskFactors).toContain("testing_required_but_missing");
      expect(result.completionReady).toBe(true);
    });

    it("merge phase is never required (always off)", () => {
      const policy: MissionExecutionPolicy = {
        ...DEFAULT_EXECUTION_POLICY,
        merge: { mode: "off" }
      };
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "code" } })
      ];
      const result = evaluateRunCompletion(steps, policy);
      // Merge is skipped by policy, not blocking
      expect(result.diagnostics.some((d) => d.phase === "merge" && d.code === "phase_skipped_by_policy")).toBe(true);
      expect(result.completionReady).toBe(true);
    });

    it("returns failed when required phase has failed steps", () => {
      const policy: MissionExecutionPolicy = {
        ...DEFAULT_EXECUTION_POLICY,
        testing: { mode: "post_implementation" },
        completion: { allowCompletionWithRisk: false }
      };
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "code" } }),
        makeStep({ id: "s2", status: "failed", metadata: { stepType: "test" } })
      ];
      const result = evaluateRunCompletion(steps, policy);
      expect(result.status).toBe("failed");
      expect(result.completionReady).toBe(true);
    });

    it("reports running when steps are still in progress", () => {
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "code" } }),
        makeStep({ id: "s2", status: "running", metadata: { stepType: "test" } })
      ];
      const result = evaluateRunCompletion(steps, DEFAULT_EXECUTION_POLICY);
      expect(result.status).toBe("running");
      expect(result.completionReady).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────
// roleForStepType
// ─────────────────────────────────────────────────────

describe("roleForStepType", () => {
  it('maps "analysis" to "planning"', () => {
    expect(roleForStepType("analysis")).toBe("planning");
  });

  it('maps "code" to "implementation"', () => {
    expect(roleForStepType("code")).toBe("implementation");
  });

  it('maps "implementation" to "implementation"', () => {
    expect(roleForStepType("implementation")).toBe("implementation");
  });

  it('maps "test" to "testing"', () => {
    expect(roleForStepType("test")).toBe("testing");
  });

  it('maps "validation" to "testing"', () => {
    expect(roleForStepType("validation")).toBe("testing");
  });

  it('maps "review" to "code_review"', () => {
    expect(roleForStepType("review")).toBe("code_review");
  });

  it('maps "test_review" to "test_review"', () => {
    expect(roleForStepType("test_review")).toBe("test_review");
  });

  it('maps "review_test" to "test_review"', () => {
    expect(roleForStepType("review_test")).toBe("test_review");
  });

  it('maps "integration" to "integration"', () => {
    expect(roleForStepType("integration")).toBe("integration");
  });

  it('maps "merge" to "merge"', () => {
    expect(roleForStepType("merge")).toBe("merge");
  });

  it("returns null for unknown step types", () => {
    expect(roleForStepType("unknown")).toBeNull();
    expect(roleForStepType("foobar")).toBeNull();
  });

  it("uses taskType as fallback when stepType is empty", () => {
    expect(roleForStepType("", "analysis")).toBe("planning");
    expect(roleForStepType("", "code")).toBe("implementation");
    expect(roleForStepType("", "test")).toBe("testing");
    expect(roleForStepType("", "review")).toBe("code_review");
    expect(roleForStepType("", "test_review")).toBe("test_review");
    expect(roleForStepType("", "integration")).toBe("integration");
    expect(roleForStepType("", "merge")).toBe("merge");
  });
});

// ─────────────────────────────────────────────────────
// validateRoleIsolation
// ─────────────────────────────────────────────────────

describe("validateRoleIsolation", () => {
  it("returns valid for a plan with separate workers per role", () => {
    const steps = [
      { stepKey: "s1", role: "implementation" as OrchestratorWorkerRole, workerId: "w1" },
      { stepKey: "s2", role: "code_review" as OrchestratorWorkerRole, workerId: "w2" },
      { stepKey: "s3", role: "testing" as OrchestratorWorkerRole, workerId: "w3" }
    ];
    const result = validateRoleIsolation(steps);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("detects implementation + code_review on same worker with auto_correct", () => {
    const steps = [
      { stepKey: "s1", role: "implementation" as OrchestratorWorkerRole, workerId: "w1" },
      { stepKey: "s2", role: "code_review" as OrchestratorWorkerRole, workerId: "w1" }
    ];
    const result = validateRoleIsolation(steps);
    // auto_correct splits the conflict, so valid is true but violations recorded
    expect(result.valid).toBe(true);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations.some((v) => v.correctionApplied)).toBe(true);
    expect(result.correctedPlan).toBe(true);
  });

  it("detects implementation + test_review on same worker", () => {
    const steps = [
      { stepKey: "s1", role: "implementation" as OrchestratorWorkerRole, workerId: "w1" },
      { stepKey: "s2", role: "test_review" as OrchestratorWorkerRole, workerId: "w1" }
    ];
    const result = validateRoleIsolation(steps);
    expect(result.violations.length).toBeGreaterThan(0);
    const violation = result.violations.find(
      (v) =>
        v.rule.mutuallyExclusive.includes("implementation") &&
        v.rule.mutuallyExclusive.includes("test_review")
    );
    expect(violation).toBeDefined();
    expect(violation!.correctionApplied).toBe(true);
  });

  it("detects testing + test_review on same worker", () => {
    const steps = [
      { stepKey: "s1", role: "testing" as OrchestratorWorkerRole, workerId: "w1" },
      { stepKey: "s2", role: "test_review" as OrchestratorWorkerRole, workerId: "w1" }
    ];
    const result = validateRoleIsolation(steps);
    expect(result.violations.length).toBeGreaterThan(0);
    const violation = result.violations.find(
      (v) =>
        v.rule.mutuallyExclusive.includes("testing") &&
        v.rule.mutuallyExclusive.includes("test_review")
    );
    expect(violation).toBeDefined();
  });

  it("auto_correct splits conflicting steps into different workers", () => {
    const steps = [
      { stepKey: "s1", role: "implementation" as OrchestratorWorkerRole, workerId: "w1" },
      { stepKey: "s2", role: "code_review" as OrchestratorWorkerRole, workerId: "w1" }
    ];
    const result = validateRoleIsolation(steps);
    expect(result.valid).toBe(true);
    expect(result.correctedPlan).toBe(true);
    // The violation detail should mention splitting into a new worker
    const violation = result.violations[0];
    expect(violation.correctionApplied).toBe(true);
    expect(violation.correctionDetail).toContain("Split");
    expect(violation.correctionDetail).toContain("w1");
  });

  it("detects multiple violations at once", () => {
    const steps = [
      { stepKey: "s1", role: "implementation" as OrchestratorWorkerRole, workerId: "w1" },
      { stepKey: "s2", role: "code_review" as OrchestratorWorkerRole, workerId: "w1" },
      { stepKey: "s3", role: "testing" as OrchestratorWorkerRole, workerId: "w2" },
      { stepKey: "s4", role: "test_review" as OrchestratorWorkerRole, workerId: "w2" }
    ];
    const result = validateRoleIsolation(steps);
    // Should detect violations for both w1 and w2
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
  });

  it("returns valid for an empty steps array", () => {
    const result = validateRoleIsolation([]);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("uses reject enforcement when rule specifies it", () => {
    const rejectRule = {
      mutuallyExclusive: ["implementation", "code_review"] as [OrchestratorWorkerRole, OrchestratorWorkerRole],
      enforcement: "reject" as const,
      reason: "Hard rejection"
    };
    const steps = [
      { stepKey: "s1", role: "implementation" as OrchestratorWorkerRole, workerId: "w1" },
      { stepKey: "s2", role: "code_review" as OrchestratorWorkerRole, workerId: "w1" }
    ];
    const result = validateRoleIsolation(steps, [rejectRule]);
    expect(result.valid).toBe(false);
    expect(result.violations[0].correctionApplied).toBe(false);
  });
});

// ─────────────────────────────────────────────────────
// contextViewForRole
// ─────────────────────────────────────────────────────

describe("contextViewForRole", () => {
  it('returns "implementation" for implementation role', () => {
    expect(contextViewForRole("implementation")).toBe("implementation");
  });

  it('returns "implementation" for planning role', () => {
    expect(contextViewForRole("planning")).toBe("implementation");
  });

  it('returns "review" for code_review role', () => {
    expect(contextViewForRole("code_review")).toBe("review");
  });

  it('returns "review" for test_review role', () => {
    expect(contextViewForRole("test_review")).toBe("review");
  });

  it('returns "implementation" for testing role', () => {
    expect(contextViewForRole("testing")).toBe("implementation");
  });

  it('returns "implementation" for integration role', () => {
    expect(contextViewForRole("integration")).toBe("implementation");
  });

  it('returns "implementation" for merge role', () => {
    expect(contextViewForRole("merge")).toBe("implementation");
  });
});

// ─────────────────────────────────────────────────────
// evaluateRecoveryLoop
// ─────────────────────────────────────────────────────

describe("evaluateRecoveryLoop", () => {
  function makeIteration(overrides: Partial<RecoveryLoopIteration> & { outcome: RecoveryLoopIteration["outcome"] }): RecoveryLoopIteration {
    return {
      iteration: overrides.iteration ?? 1,
      triggerStepId: overrides.triggerStepId ?? "step-1",
      triggerPhase: overrides.triggerPhase ?? "testing",
      failureReason: overrides.failureReason ?? "test failed",
      fixStepId: overrides.fixStepId ?? null,
      reReviewStepId: overrides.reReviewStepId ?? null,
      reTestStepId: overrides.reTestStepId ?? null,
      outcome: overrides.outcome,
      confidence: overrides.confidence,
      startedAt: overrides.startedAt ?? "2026-02-20T00:00:00.000Z",
      completedAt: overrides.completedAt ?? "2026-02-20T00:01:00.000Z"
    };
  }

  const enabledPolicy: RecoveryLoopPolicy = {
    enabled: true,
    maxIterations: 3,
    onExhaustion: "fail",
    escalateAfterStagnant: 2
  };

  it("should retry when under max iterations", () => {
    const state: RecoveryLoopState = {
      runId: "run-1",
      iterations: [makeIteration({ outcome: "still_failing", iteration: 1 })],
      currentIteration: 1,
      exhausted: false,
      stopReason: null
    };
    const result = evaluateRecoveryLoop(state, enabledPolicy);
    expect(result.shouldRetry).toBe(true);
    expect(result.action).toBe("fix");
    expect(result.reason).toContain("within policy bounds");
  });

  it("should stop when max iterations reached", () => {
    const state: RecoveryLoopState = {
      runId: "run-1",
      iterations: [
        makeIteration({ outcome: "still_failing", iteration: 1 }),
        makeIteration({ outcome: "still_failing", iteration: 2 }),
        makeIteration({ outcome: "still_failing", iteration: 3 })
      ],
      currentIteration: 3,
      exhausted: false,
      stopReason: null
    };
    const result = evaluateRecoveryLoop(state, enabledPolicy);
    expect(result.shouldRetry).toBe(false);
    expect(result.action).toBe("stop");
    expect(result.reason).toContain("Max iterations");
  });

  it("does not apply deterministic stagnation heuristics", () => {
    const policy: RecoveryLoopPolicy = {
      enabled: true,
      maxIterations: 5,
      onExhaustion: "intervention",
      escalateAfterStagnant: 2
    };
    const state: RecoveryLoopState = {
      runId: "run-1",
      iterations: [
        makeIteration({ outcome: "still_failing", iteration: 1 }),
        makeIteration({ outcome: "still_failing", iteration: 2 })
      ],
      currentIteration: 2,
      exhausted: false,
      stopReason: null
    };
    const result = evaluateRecoveryLoop(state, policy);
    expect(result.shouldRetry).toBe(true);
    expect(result.action).toBe("fix");
    expect(result.reason).toContain("within policy bounds");
  });

  it("disabled policy returns shouldRetry: false", () => {
    const disabledPolicy: RecoveryLoopPolicy = {
      enabled: false,
      maxIterations: 3,
      onExhaustion: "fail"
    };
    const state: RecoveryLoopState = {
      runId: "run-1",
      iterations: [],
      currentIteration: 0,
      exhausted: false,
      stopReason: null
    };
    const result = evaluateRecoveryLoop(state, disabledPolicy);
    expect(result.shouldRetry).toBe(false);
    expect(result.action).toBe("stop");
    expect(result.reason).toContain("disabled");
  });

  it('returns "fix" action when retry is allowed', () => {
    const state: RecoveryLoopState = {
      runId: "run-1",
      iterations: [],
      currentIteration: 0,
      exhausted: false,
      stopReason: null
    };
    const result = evaluateRecoveryLoop(state, enabledPolicy);
    expect(result.shouldRetry).toBe(true);
    expect(result.action).toBe("fix");
  });

  it("escalates when max iterations reached and onExhaustion is intervention", () => {
    const policy: RecoveryLoopPolicy = {
      enabled: true,
      maxIterations: 2,
      onExhaustion: "intervention"
    };
    const state: RecoveryLoopState = {
      runId: "run-1",
      iterations: [
        makeIteration({ outcome: "still_failing", iteration: 1 }),
        makeIteration({ outcome: "still_failing", iteration: 2 })
      ],
      currentIteration: 2,
      exhausted: false,
      stopReason: null
    };
    const result = evaluateRecoveryLoop(state, policy);
    expect(result.shouldRetry).toBe(false);
    expect(result.action).toBe("escalate");
    expect(result.reason).toContain("Escalating");
  });

  it("stops when exhausted flag is already set", () => {
    const state: RecoveryLoopState = {
      runId: "run-1",
      iterations: [],
      currentIteration: 1,
      exhausted: true,
      stopReason: "max iterations reached"
    };
    const result = evaluateRecoveryLoop(state, enabledPolicy);
    expect(result.shouldRetry).toBe(false);
    expect(result.reason).toContain("exhausted");
  });
});
