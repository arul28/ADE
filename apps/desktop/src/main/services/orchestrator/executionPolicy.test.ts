import { describe, expect, it } from "vitest";
import type {
  MissionExecutionPolicy,
  OrchestratorRun,
  OrchestratorStep,
  OrchestratorStepStatus,
  OrchestratorAttempt,
  OrchestratorClaim,
  OrchestratorTeamRuntimeState,
  OrchestratorWorkerRole,
  RecoveryLoopPolicy,
  RecoveryLoopState,
  RecoveryLoopIteration
} from "../../../shared/types";
import {
  DEFAULT_EXECUTION_POLICY,
  resolveExecutionPolicy,
  evaluateRunCompletion,
  validateRunCompletion,
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
  describe("resolveExecutionPolicy", () => {
    it("returns default when no sources provided", () => {
      const policy = resolveExecutionPolicy({});
      expect(policy).toEqual(DEFAULT_EXECUTION_POLICY);
    });

    it("mission metadata takes highest precedence", () => {
      const policy = resolveExecutionPolicy({
        missionMetadata: { testing: { mode: "tdd" } },
        projectConfig: { testing: { mode: "none" } }
      });
      expect(policy.testing.mode).toBe("tdd");
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
      expect(stepTypeToPhase("merge")).toBeNull(); // merge phase removed — always off
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
    it("succeeds when all required phases are satisfied", () => {
      const policy: MissionExecutionPolicy = {
        planning: { mode: "auto" },
        implementation: { model: "codex" },
        testing: { mode: "post_implementation" },
        validation: { mode: "optional" },
        codeReview: { mode: "off" },
        testReview: { mode: "off" },
        prReview: { mode: "off" },
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
        prReview: { mode: "off" },
        merge: { mode: "off" },
        completion: { allowCompletionWithRisk: true }
      };
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "analysis" } }),
        makeStep({ id: "s2", status: "succeeded", metadata: { stepType: "code" } })
      ];
      const result = evaluateRunCompletion(steps, policy);
      expect(result.status).toBe("succeeded");
      expect(result.completionReady).toBe(true);
    });

    it("treats missing required phases as advisory risk factors (coordinator is sole authority)", () => {
      const policy: MissionExecutionPolicy = {
        planning: { mode: "auto" },
        implementation: { model: "codex" },
        testing: { mode: "post_implementation" },
        validation: { mode: "required" },
        codeReview: { mode: "required" },
        testReview: { mode: "off" },
        prReview: { mode: "off" },
        merge: { mode: "off" },
        completion: { allowCompletionWithRisk: false }
      };
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "code" } })
      ];
      const result = evaluateRunCompletion(steps, policy);
      // Phase requirements are always advisory — coordinator decides completion
      expect(result.diagnostics.some((d) => d.code === "phase_required_missing")).toBe(true);
      expect(result.riskFactors.length).toBeGreaterThan(0);
    });

    it("returns succeeded_with_risk when required phase missing but risk allowed", () => {
      const policy: MissionExecutionPolicy = {
        planning: { mode: "off" },
        implementation: { model: "codex" },
        testing: { mode: "post_implementation" },
        validation: { mode: "off" },
        codeReview: { mode: "off" },
        testReview: { mode: "off" },
        prReview: { mode: "off" },
        merge: { mode: "off" },
        completion: { allowCompletionWithRisk: true }
      };
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "code" } })
      ];
      const result = evaluateRunCompletion(steps, policy);
      expect(result.status).toBe("succeeded_with_risk");
      expect(result.riskFactors).toContain("testing_required_but_missing");
      expect(result.completionReady).toBe(true);
    });

    it("merge phase is not evaluated (removed from execution phases)", () => {
      const policy: MissionExecutionPolicy = {
        ...DEFAULT_EXECUTION_POLICY,
        merge: { mode: "off" }
      };
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "code" } })
      ];
      const result = evaluateRunCompletion(steps, policy);
      // Merge is no longer an execution phase — no diagnostic emitted for it
      expect(result.diagnostics.some((d) => d.phase === "merge")).toBe(false);
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

    it("reports active when steps are still in progress", () => {
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "code" } }),
        makeStep({ id: "s2", status: "running", metadata: { stepType: "test" } })
      ];
      const result = evaluateRunCompletion(steps, DEFAULT_EXECUTION_POLICY);
      expect(result.status).toBe("active");
      expect(result.completionReady).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────
// validateRunCompletion
// ─────────────────────────────────────────────────────

function makeRun(overrides?: Partial<OrchestratorRun>): OrchestratorRun {
  return {
    id: "run-1",
    missionId: "m-1",
    projectId: "p-1",
    status: "active",
    contextProfile: "orchestrator_deterministic_v1",
    schedulerState: "running",
    createdAt: "2026-02-20T00:00:00.000Z",
    updatedAt: "2026-02-20T00:00:00.000Z",
    startedAt: "2026-02-20T00:00:00.000Z",
    completedAt: null,
    lastError: null,
    metadata: null,
    ...overrides
  };
}

function makeAttempt(overrides?: Partial<OrchestratorAttempt>): OrchestratorAttempt {
  return {
    id: "att-1",
    runId: "run-1",
    stepId: "step-1",
    attemptNumber: 1,
    status: "succeeded",
    executorKind: "codex",
    executorSessionId: null,
    trackedSessionEnforced: false,
    contextProfile: "orchestrator_deterministic_v1",
    contextSnapshotId: null,
    errorClass: "none",
    errorMessage: null,
    retryBackoffMs: 0,
    createdAt: "2026-02-20T00:00:00.000Z",
    startedAt: "2026-02-20T00:00:00.000Z",
    completedAt: "2026-02-20T00:01:00.000Z",
    resultEnvelope: null,
    metadata: null,
    ...overrides
  };
}

function makeClaim(overrides?: Partial<OrchestratorClaim>): OrchestratorClaim {
  return {
    id: "claim-1",
    runId: "run-1",
    stepId: null,
    attemptId: null,
    ownerId: "worker-1",
    scopeKind: "lane",
    scopeValue: "lane-1",
    state: "released",
    acquiredAt: "2026-02-20T00:00:00.000Z",
    heartbeatAt: "2026-02-20T00:00:00.000Z",
    expiresAt: "2026-02-20T01:00:00.000Z",
    releasedAt: "2026-02-20T00:01:00.000Z",
    policy: null,
    metadata: null,
    ...overrides
  };
}

function makeRunState(overrides?: Partial<OrchestratorTeamRuntimeState>): OrchestratorTeamRuntimeState {
  return {
    runId: "run-1",
    phase: "executing",
    completionRequested: true,
    completionValidated: false,
    lastValidationError: null,
    coordinatorSessionId: "sess-1",
    teammateIds: [],
    createdAt: "2026-02-20T00:00:00.000Z",
    updatedAt: "2026-02-20T00:00:00.000Z",
    ...overrides
  };
}

describe("validateRunCompletion", () => {
  it("returns canComplete: true when all conditions are met", () => {
    const run = makeRun();
    const steps = [makeStep({ id: "s1", status: "succeeded" })];
    const attempts = [makeAttempt({ status: "succeeded" })];
    const claims: OrchestratorClaim[] = [];
    const runState = makeRunState({ completionRequested: true });

    const result = validateRunCompletion(run, steps, attempts, claims, runState);
    expect(result.canComplete).toBe(true);
    expect(result.blockers).toHaveLength(0);
    expect(result.validatedAt).toBeTruthy();
  });

  it("blocks when attempts are still running", () => {
    const run = makeRun();
    const steps = [makeStep({ id: "s1", status: "running" })];
    const attempts = [makeAttempt({ id: "att-1", status: "running" })];
    const runState = makeRunState({ completionRequested: true });

    const result = validateRunCompletion(run, steps, attempts, [], runState);
    expect(result.canComplete).toBe(false);
    expect(result.blockers.some((b) => b.code === "running_attempts")).toBe(true);
  });

  it("blocks when attempts are queued", () => {
    const run = makeRun();
    const attempts = [makeAttempt({ id: "att-1", status: "queued" })];
    const runState = makeRunState({ completionRequested: true });

    const result = validateRunCompletion(run, [], attempts, [], runState);
    expect(result.canComplete).toBe(false);
    expect(result.blockers.some((b) => b.code === "running_attempts")).toBe(true);
  });

  it("blocks when steps are in claimed status", () => {
    const run = makeRun();
    const steps = [makeStep({ id: "s1", status: "claimed" as OrchestratorStepStatus })];
    const runState = makeRunState({ completionRequested: true });

    const result = validateRunCompletion(run, steps, [], [], runState);
    expect(result.canComplete).toBe(false);
    expect(result.blockers.some((b) => b.code === "claimed_tasks")).toBe(true);
  });

  it("blocks when there are active task claims", () => {
    const run = makeRun();
    const claims = [makeClaim({ state: "active", scopeKind: "task" })];
    const runState = makeRunState({ completionRequested: true });

    const result = validateRunCompletion(run, [], [], claims, runState);
    expect(result.canComplete).toBe(false);
    expect(result.blockers.some((b) => b.code === "claimed_tasks")).toBe(true);
  });

  it("does not block on active lane claims (only task claims)", () => {
    const run = makeRun();
    const claims = [makeClaim({ state: "active", scopeKind: "lane" })];
    const runState = makeRunState({ completionRequested: true });

    const result = validateRunCompletion(run, [], [], claims, runState);
    expect(result.blockers.some((b) => b.code === "claimed_tasks")).toBe(false);
  });

  it("blocks when there are unresolved interventions", () => {
    const run = makeRun();
    const runState = makeRunState({ completionRequested: true });
    const interventions = [{ status: "pending" }, { status: "resolved" }];

    const result = validateRunCompletion(run, [], [], [], runState, interventions);
    expect(result.canComplete).toBe(false);
    expect(result.blockers.some((b) => b.code === "unresolved_interventions")).toBe(true);
  });

  it("does not block when all interventions are resolved", () => {
    const run = makeRun();
    const runState = makeRunState({ completionRequested: true });
    const interventions = [{ status: "resolved" }, { status: "resolved" }];

    const result = validateRunCompletion(run, [], [], [], runState, interventions);
    expect(result.blockers.some((b) => b.code === "unresolved_interventions")).toBe(false);
  });

  it("allows completion when completionRequested is false (coordinator is sole authority)", () => {
    const run = makeRun();
    const runState = makeRunState({ completionRequested: false });

    const result = validateRunCompletion(run, [], [], [], runState);
    // completion_not_requested gate removed — calling finalizeRun IS the completion request
    expect(result.canComplete).toBe(true);
    expect(result.blockers.some((b) => b.code === "completion_not_requested")).toBe(false);
  });

  it("allows completion when runState is null (coordinator is sole authority)", () => {
    const run = makeRun();

    const result = validateRunCompletion(run, [], [], [], null);
    // completion_not_requested gate removed — the coordinator decides
    expect(result.canComplete).toBe(true);
    expect(result.blockers.some((b) => b.code === "completion_not_requested")).toBe(false);
  });

  it("returns multiple blockers when multiple conditions fail", () => {
    const run = makeRun();
    const attempts = [makeAttempt({ status: "running" })];
    const claims = [makeClaim({ state: "active", scopeKind: "task" })];
    const interventions = [{ status: "pending" }];

    const result = validateRunCompletion(run, [], attempts, claims, null, interventions);
    expect(result.canComplete).toBe(false);
    expect(result.blockers.length).toBeGreaterThanOrEqual(2);
    const codes = result.blockers.map((b) => b.code);
    expect(codes).toContain("running_attempts");
    expect(codes).toContain("unresolved_interventions");
    // completion_not_requested gate removed — coordinator is sole authority
    expect(codes).not.toContain("completion_not_requested");
  });

  it("does not check interventions when not provided", () => {
    const run = makeRun();
    const runState = makeRunState({ completionRequested: true });

    const result = validateRunCompletion(run, [], [], [], runState);
    expect(result.canComplete).toBe(true);
    expect(result.blockers.some((b) => b.code === "unresolved_interventions")).toBe(false);
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

  it('returns null for "merge" (merge phase removed)', () => {
    expect(roleForStepType("merge")).toBeNull();
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
    expect(roleForStepType("", "merge")).toBeNull(); // merge phase removed
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
