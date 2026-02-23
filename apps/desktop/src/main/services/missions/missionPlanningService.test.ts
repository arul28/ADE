import { describe, expect, it, vi } from "vitest";
import { planMissionOnce, plannerPlanToMissionSteps, validateAndCanonicalizePlannerPlan, MissionPlanningError } from "./missionPlanningService";
import { buildDeterministicMissionPlan } from "./missionPlanner";
import type { MissionExecutionPolicy } from "../../../shared/types";

describe("missionPlanningService planner contract", () => {
  it("accepts valid plans and canonicalizes step order", () => {
    const raw = {
      schemaVersion: "1.0",
      missionSummary: {
        title: "Ship feature",
        objective: "Implement and verify",
        domain: "backend",
        complexity: "medium",
        strategy: "parallel-lite",
        parallelismCap: 2
      },
      assumptions: [],
      risks: [],
      steps: [
        {
          stepId: "verify",
          name: "Verify",
          description: "Run tests",
          taskType: "test",
          executorHint: "either",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: ["implement"],
          artifactHints: [],
          claimPolicy: { lanes: ["backend"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: ["tests_pass"], completionCriteria: "tests_pass" }
        },
        {
          stepId: "implement",
          name: "Implement",
          description: "Write code",
          taskType: "code",
          executorHint: "either",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: [],
          artifactHints: [],
          claimPolicy: { lanes: ["backend"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: ["code_done"], completionCriteria: "code_done" }
        }
      ],
      handoffPolicy: {
        externalConflictDefault: "intervention"
      }
    };

    const { plan, validationErrors } = validateAndCanonicalizePlannerPlan(raw);
    expect(validationErrors).toEqual([]);
    expect(plan.steps.map((step) => step.stepId)).toEqual(["implement", "verify"]);
  });

  it("rejects duplicate step IDs, unresolved deps, and quorum mismatch", () => {
    const raw = {
      schemaVersion: "1.0",
      missionSummary: {
        title: "Invalid",
        objective: "Invalid",
        domain: "mixed",
        complexity: "low",
        strategy: "sequential",
        parallelismCap: 1
      },
      assumptions: [],
      risks: [],
      steps: [
        {
          stepId: "same",
          name: "Step A",
          description: "A",
          taskType: "analysis",
          executorHint: "either",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: ["missing"],
          artifactHints: [],
          claimPolicy: { lanes: ["analysis"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: [], completionCriteria: "done" }
        },
        {
          stepId: "same",
          name: "Step B",
          description: "B",
          taskType: "code",
          executorHint: "either",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: [],
          joinPolicy: "quorum",
          artifactHints: [],
          claimPolicy: { lanes: ["backend"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: [], completionCriteria: "done" }
        }
      ],
      handoffPolicy: {
        externalConflictDefault: "intervention"
      }
    };

    const { validationErrors } = validateAndCanonicalizePlannerPlan(raw);
    expect(validationErrors.some((entry) => entry.includes("Duplicate stepId"))).toBe(true);
    expect(validationErrors.some((entry) => entry.includes("Unresolved dependency"))).toBe(true);
    expect(validationErrors.some((entry) => entry.includes("joinPolicy=quorum"))).toBe(true);
  });

  it("rejects dependency cycles and max-attempt bounds", () => {
    const raw = {
      schemaVersion: "1.0",
      missionSummary: {
        title: "Cycle",
        objective: "Cycle",
        domain: "mixed",
        complexity: "medium",
        strategy: "parallel-lite",
        parallelismCap: 2
      },
      assumptions: [],
      risks: [],
      steps: [
        {
          stepId: "a",
          name: "A",
          description: "A",
          taskType: "analysis",
          executorHint: "either",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: ["b"],
          artifactHints: [],
          claimPolicy: { lanes: ["analysis"] },
          maxAttempts: 0,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: [], completionCriteria: "done" }
        },
        {
          stepId: "b",
          name: "B",
          description: "B",
          taskType: "code",
          executorHint: "either",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: ["a"],
          artifactHints: [],
          claimPolicy: { lanes: ["backend"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: [], completionCriteria: "done" }
        }
      ],
      handoffPolicy: {
        externalConflictDefault: "intervention"
      }
    };

    const { validationErrors } = validateAndCanonicalizePlannerPlan(raw);
    expect(validationErrors.some((entry) => entry.includes("maxAttempts outside bounds"))).toBe(true);
    expect(validationErrors.some((entry) => entry.includes("Dependency cycle detected"))).toBe(true);
  });

  it("maps executor defaults deterministically for mission steps", () => {
    const { plan } = validateAndCanonicalizePlannerPlan({
      schemaVersion: "1.0",
      missionSummary: {
        title: "Routing",
        objective: "Route executors",
        domain: "mixed",
        complexity: "medium",
        strategy: "parallel-lite",
        parallelismCap: 2
      },
      assumptions: [],
      risks: [],
      steps: [
        {
          stepId: "analysis",
          name: "Analyze",
          description: "Analyze",
          taskType: "analysis",
          executorHint: "either",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: [],
          artifactHints: [],
          claimPolicy: { lanes: ["analysis"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: [], completionCriteria: "done" }
        },
        {
          stepId: "code",
          name: "Code",
          description: "Code",
          taskType: "code",
          executorHint: "either",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: ["analysis"],
          artifactHints: [],
          claimPolicy: { lanes: ["backend"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: [], completionCriteria: "done" }
        }
      ],
      handoffPolicy: {
        externalConflictDefault: "intervention"
      }
    });

    const steps = plannerPlanToMissionSteps({
      plan,
      requestedEngine: "auto",
      resolvedEngine: "claude_cli",
      executorPolicy: "both",
      degraded: false,
      reasonCode: null,
      validationErrors: []
    });
    expect(steps).toHaveLength(2);
    expect(steps[0]?.metadata.executorKind).toBe("claude");
    expect(steps[1]?.metadata.executorKind).toBe("codex");

    const codexOnly = plannerPlanToMissionSteps({
      plan,
      requestedEngine: "auto",
      resolvedEngine: "claude_cli",
      executorPolicy: "codex",
      degraded: false,
      reasonCode: null,
      validationErrors: []
    });
    expect(codexOnly.every((step) => step.metadata.executorKind === "codex")).toBe(true);

    const claudeOnly = plannerPlanToMissionSteps({
      plan,
      requestedEngine: "auto",
      resolvedEngine: "claude_cli",
      executorPolicy: "claude",
      degraded: false,
      reasonCode: null,
      validationErrors: []
    });
    expect(claudeOnly.every((step) => step.metadata.executorKind === "claude")).toBe(true);
  });

  it("rejects generic step labels from AI planner output", () => {
    const { validationErrors } = validateAndCanonicalizePlannerPlan({
      schemaVersion: "1.0",
      missionSummary: {
        title: "Generic",
        objective: "Should fail generic labels",
        domain: "mixed",
        complexity: "medium",
        strategy: "parallel-lite",
        parallelismCap: 2
      },
      assumptions: [],
      risks: [],
      steps: [
        {
          stepId: "s1",
          name: "Step 1",
          description: "Execute mission work for this step.",
          taskType: "code",
          executorHint: "either",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: [],
          artifactHints: [],
          claimPolicy: { lanes: ["backend"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: [], completionCriteria: "done" }
        }
      ],
      handoffPolicy: {
        externalConflictDefault: "intervention"
      }
    });

    expect(validationErrors.some((entry) => entry.includes("generic name"))).toBe(true);
    expect(validationErrors.some((entry) => entry.includes("uninformative description"))).toBe(true);
  });

  it("parallelismCap up to 32 is preserved from planner output", () => {
    const { plan } = validateAndCanonicalizePlannerPlan({
      schemaVersion: "1.0",
      missionSummary: {
        title: "Big Parallel Mission",
        objective: "Test parallelism",
        domain: "backend",
        complexity: "high",
        strategy: "parallel-first",
        parallelismCap: 24,
        parallelismRationale: "24 independent microservices"
      },
      assumptions: [],
      risks: [],
      steps: [{
        stepId: "s1",
        name: "Build services",
        description: "Build all microservices in parallel",
        taskType: "code",
        executorHint: "codex",
        preferredScope: "project",
        requiresContextProfiles: [],
        dependencies: [],
        artifactHints: [],
        claimPolicy: { scope: "lane" },
        maxAttempts: 3,
        retryPolicy: "same_worker",
        outputContract: { expectedSignals: ["code_written"], handoffTo: [] }
      }],
      handoffPolicy: { externalConflictDefault: "intervention" }
    });
    expect(plan.missionSummary.parallelismCap).toBe(24);
    expect(plan.missionSummary.parallelismRationale).toBe("24 independent microservices");
  });

  it("does not translate abstract planner lane hints into coarse claim locks", () => {
    const { plan } = validateAndCanonicalizePlannerPlan({
      schemaVersion: "1.0",
      missionSummary: {
        title: "Claims",
        objective: "Avoid accidental serialization",
        domain: "backend",
        complexity: "medium",
        strategy: "parallel-lite",
        parallelismCap: 3
      },
      assumptions: [],
      risks: [],
      steps: [
        {
          stepId: "code-a",
          name: "Implement endpoint",
          description: "Add endpoint implementation and unit tests.",
          taskType: "code",
          executorHint: "either",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: [],
          artifactHints: [],
          claimPolicy: { lanes: ["backend"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: ["endpoint_added"], completionCriteria: "endpoint_added" }
        }
      ],
      handoffPolicy: {
        externalConflictDefault: "intervention"
      }
    });

    const steps = plannerPlanToMissionSteps({
      plan,
      requestedEngine: "auto",
      resolvedEngine: "claude_cli",
      executorPolicy: "both",
      degraded: false,
      reasonCode: null,
      validationErrors: []
    });
    const policy = steps[0]?.metadata?.policy as { claimScopes?: unknown[] } | undefined;
    expect(policy?.claimScopes ?? []).toHaveLength(0);
  });

  it("throws MissionPlanningError when AI planner returns malformed JSON", async () => {
    const aiIntegrationService = {
      getAvailability: () => ({ claude: true, codex: false }),
      getMode: () => "ready",
      planMission: vi.fn().mockResolvedValue({
        text: "{ invalid_json: true, }",
        structuredOutput: null
      })
    };

    await expect(planMissionOnce({
      title: "Malformed plan",
      prompt: "Plan a deterministic migration rollout.",
      laneId: null,
      plannerEngine: "auto",
      projectRoot: "/Users/arul/ADE/apps/desktop",
      aiIntegrationService: aiIntegrationService as never
    })).rejects.toThrow(MissionPlanningError);

    try {
      await planMissionOnce({
        title: "Malformed plan",
        prompt: "Plan a deterministic migration rollout.",
        laneId: null,
        plannerEngine: "auto",
        projectRoot: "/Users/arul/ADE/apps/desktop",
        aiIntegrationService: aiIntegrationService as never
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MissionPlanningError);
      const planError = error as MissionPlanningError;
      expect(planError.reasonCode).toBe("planner_parse_error");
      expect(planError.attempts).toBe(1);
    }
  });

  it("throws MissionPlanningError with planner_unavailable when no planner adapter is available", async () => {
    await expect(planMissionOnce({
      title: "Unavailable planner",
      prompt: "Create rollout plan.",
      laneId: null,
      plannerEngine: "auto",
      projectRoot: "/Users/arul/ADE/apps/desktop",
      aiIntegrationService: {
        getAvailability: () => ({ claude: false, codex: false }),
        getMode: () => "ready"
      } as never
    })).rejects.toThrow(MissionPlanningError);

    try {
      await planMissionOnce({
        title: "Unavailable planner",
        prompt: "Create rollout plan.",
        laneId: null,
        plannerEngine: "auto",
        projectRoot: "/Users/arul/ADE/apps/desktop",
        aiIntegrationService: {
          getAvailability: () => ({ claude: false, codex: false }),
          getMode: () => "ready"
        } as never
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MissionPlanningError);
      const planError = error as MissionPlanningError;
      expect(planError.reasonCode).toBe("planner_unavailable");
      expect(planError.reasonDetail).toContain("unavailable");
      expect(planError.attempts).toBe(0);
    }
  });

  it("forwards explicit planner model overrides to aiIntegrationService.planMission", async () => {
    const planMissionMock = vi.fn().mockResolvedValue({
      text: "",
      structuredOutput: {
        schemaVersion: "1.0",
        missionSummary: {
          title: "Model override",
          objective: "Verify model forwarding",
          domain: "mixed",
          complexity: "medium",
          strategy: "sequential",
          parallelismCap: 1
        },
        assumptions: [],
        risks: [],
        steps: [
          {
            stepId: "implement",
            name: "Implement feature",
            description: "Write code and verify completion criteria.",
            taskType: "code",
            executorHint: "either",
            preferredScope: "lane",
            requiresContextProfiles: ["deterministic"],
            dependencies: [],
            artifactHints: [],
            claimPolicy: { lanes: ["backend"] },
            maxAttempts: 2,
            retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
            outputContract: { expectedSignals: ["code_done"], completionCriteria: "code_done" }
          }
        ],
        handoffPolicy: {
          externalConflictDefault: "intervention"
        }
      }
    });

    const aiIntegrationService = {
      getAvailability: () => ({ claude: true, codex: false }),
      getMode: () => "ready",
      planMission: planMissionMock
    };

    await planMissionOnce({
      title: "Model override mission",
      prompt: "Implement feature with explicit planner model.",
      laneId: null,
      plannerEngine: "claude_cli",
      projectRoot: "/Users/arul/ADE/apps/desktop",
      model: "opus",
      aiIntegrationService: aiIntegrationService as never
    });

    expect(planMissionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude",
        model: "opus"
      })
    );
  });
});

describe("policy-driven planner DAG", () => {
  const BASE_POLICY: MissionExecutionPolicy = {
    planning: { mode: "auto", model: "codex" },
    implementation: { model: "codex" },
    testing: { mode: "post_implementation", model: "codex" },
    validation: { mode: "optional" },
    codeReview: { mode: "off" },
    testReview: { mode: "off" },
    integration: { mode: "auto", model: "codex" },
    merge: { mode: "off" },
    completion: { allowCompletionWithRisk: true }
  };

  it("testing.mode=none omits validation step", () => {
    const plan = buildDeterministicMissionPlan({
      prompt: "Add a new API endpoint for users",
      policy: { ...BASE_POLICY, testing: { mode: "none" } }
    });
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds).not.toContain("validation");
    expect(kinds).toContain("implementation");
  });

  it("testing.mode=tdd emits test step before implementation", () => {
    const plan = buildDeterministicMissionPlan({
      prompt: "Add a new API endpoint for users",
      policy: { ...BASE_POLICY, testing: { mode: "tdd" } }
    });
    const steps = plan.steps;
    // TDD test step has kind=validation with stepType/taskType=test
    const tddStep = steps.find((s) => s.kind === "validation" && s.metadata?.taskType === "test");
    const implStep = steps.find((s) => s.kind === "implementation");
    expect(tddStep).toBeTruthy();
    expect(implStep).toBeTruthy();
    // TDD test step index must be less than implementation step index
    expect(tddStep!.index).toBeLessThan(implStep!.index);
    // Implementation must depend on TDD step
    const implDeps = implStep!.metadata?.dependencyIndices as number[] ?? [];
    expect(implDeps).toContain(tddStep!.index);
  });

  it("testing.mode=post_implementation has implementation before validation", () => {
    const plan = buildDeterministicMissionPlan({
      prompt: "Add a new API endpoint for users",
      policy: { ...BASE_POLICY, testing: { mode: "post_implementation" } }
    });
    const steps = plan.steps;
    const implStep = steps.find((s) => s.kind === "implementation");
    const valStep = steps.find((s) => s.kind === "validation");
    expect(implStep).toBeTruthy();
    expect(valStep).toBeTruthy();
    expect(implStep!.index).toBeLessThan(valStep!.index);
  });

  it("codeReview.mode=required emits review step", () => {
    const plan = buildDeterministicMissionPlan({
      prompt: "Add a new API endpoint for users",
      policy: { ...BASE_POLICY, codeReview: { mode: "required", model: "claude" } }
    });
    const reviewStep = plan.steps.find((s) => s.metadata?.taskType === "review");
    expect(reviewStep).toBeTruthy();
    expect(reviewStep!.metadata?.executorKind).toBe("claude");
  });

  it("codeReview.mode=off does not emit review step", () => {
    const plan = buildDeterministicMissionPlan({
      prompt: "Add a new API endpoint for users",
      policy: { ...BASE_POLICY, codeReview: { mode: "off" } }
    });
    const reviewStep = plan.steps.find((s) => s.metadata?.taskType === "review");
    expect(reviewStep).toBeUndefined();
  });

  it("merge phase is always off — no merge step emitted", () => {
    const plan = buildDeterministicMissionPlan({
      prompt: "Add a new API endpoint for users",
      policy: { ...BASE_POLICY, merge: { mode: "off" } }
    });
    const mergeStep = plan.steps.find((s) => s.kind === "merge");
    expect(mergeStep).toBeUndefined();
  });

  it("merge.mode=off does not emit merge step", () => {
    const plan = buildDeterministicMissionPlan({
      prompt: "Add a new API endpoint for users",
      policy: { ...BASE_POLICY, merge: { mode: "off" } }
    });
    const mergeStep = plan.steps.find((s) => s.kind === "merge");
    expect(mergeStep).toBeUndefined();
  });

  it("integration.mode=off skips integration step even with parallel branches", () => {
    const plan = buildDeterministicMissionPlan({
      prompt: "1. Add API endpoint\n2. Add database migration\n3. Update documentation",
      policy: { ...BASE_POLICY, integration: { mode: "off" } }
    });
    const integrationStep = plan.steps.find((s) => s.kind === "integration");
    expect(integrationStep).toBeUndefined();
  });

  it("executor assignment matches policy model preferences", () => {
    const plan = buildDeterministicMissionPlan({
      prompt: "Add a new API endpoint for users",
      policy: {
        ...BASE_POLICY,
        implementation: { model: "claude" },
        testing: { mode: "post_implementation", model: "claude" }
      }
    });
    const implStep = plan.steps.find((s) => s.kind === "implementation");
    const valStep = plan.steps.find((s) => s.kind === "validation");
    expect(implStep?.metadata?.executorKind).toBe("claude");
    expect(valStep?.metadata?.executorKind).toBe("claude");
  });

  it("DAG is acyclic for all testing modes", () => {
    for (const testingMode of ["none", "tdd", "post_implementation"] as const) {
      const plan = buildDeterministicMissionPlan({
        prompt: "Add a new API endpoint",
        policy: { ...BASE_POLICY, testing: { mode: testingMode } }
      });
      // Verify no cycles by topological sort
      const stepsByIndex = new Map(plan.steps.map((s) => [s.index, s]));
      const visited = new Set<number>();
      const inStack = new Set<number>();
      function hasCycle(index: number): boolean {
        if (inStack.has(index)) return true;
        if (visited.has(index)) return false;
        visited.add(index);
        inStack.add(index);
        const deps = (stepsByIndex.get(index)?.metadata?.dependencyIndices as number[]) ?? [];
        for (const dep of deps) {
          if (hasCycle(dep)) return true;
        }
        inStack.delete(index);
        return false;
      }
      for (const step of plan.steps) {
        expect(hasCycle(step.index)).toBe(false);
      }
    }
  });

  it("slash commands are detected and emitted as steps", () => {
    const plan = buildDeterministicMissionPlan({
      prompt: "Fix the login bug\n/commit\n/deploy staging",
      policy: BASE_POLICY
    });
    const commandSteps = plan.steps.filter((s) => s.metadata?.stepType === "command");
    expect(commandSteps.length).toBe(2);
    expect(commandSteps[0]!.metadata?.startupCommand).toBe("/commit");
    expect(commandSteps[1]!.metadata?.startupCommand).toBe("/deploy staging");
  });
});
