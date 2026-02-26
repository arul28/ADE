import { describe, expect, it, vi } from "vitest";
import {
  createAiDecisionService,
  DecisionFailure,
  type AiDecisionExecuteTaskResult,
  type AiDecisionIntegrationService,
  type DecideLaneStrategyArgs,
  type DecideParallelismArgs,
  type DecideRecoveryArgs,
  type DecideTransitionArgs,
  type ReplanMissionArgs
} from "./aiDecisionService";

const BASE_CONTEXT = {
  missionId: "mission-1",
  projectId: "project-1",
  runId: "run-1",
  stepId: "step-1",
  laneId: "lane-1",
  attemptId: "attempt-1"
} as const;

function createTaskResult(structuredOutput: unknown): AiDecisionExecuteTaskResult {
  return {
    text: JSON.stringify(structuredOutput),
    structuredOutput,
    provider: "claude",
    model: "sonnet",
    sessionId: null,
    inputTokens: 100,
    outputTokens: 40,
    durationMs: 125
  };
}

function createService(aiIntegrationService: AiDecisionIntegrationService) {
  return createAiDecisionService({
    aiIntegrationService,
    projectRoot: "/tmp/ade"
  });
}

function buildLaneStrategyArgs(): DecideLaneStrategyArgs {
  return {
    context: BASE_CONTEXT,
    missionObjective: "Ship lane-aware orchestration with safe parallelism.",
    laneSignals: {
      candidateSteps: 3,
      blockedSteps: 1,
      dependencyEdges: 2,
      currentParallelLanes: 1
    },
    stepDescriptors: [
      {
        stepKey: "step-a",
        title: "Implement API",
        stepType: "implementation",
        dependencyStepKeys: [],
        laneId: "lane-1"
      },
      {
        stepKey: "step-b",
        title: "Write tests",
        stepType: "test",
        dependencyStepKeys: ["step-a"],
        laneId: "lane-1"
      }
    ],
    constraints: {
      maxParallelLanes: 4
    }
  };
}

function buildTransitionArgs(): DecideTransitionArgs {
  return {
    context: BASE_CONTEXT,
    currentStatus: "running",
    unresolvedDependencies: ["step-a"],
    retryCount: 0,
    retryLimit: 2,
    missionModelConfig: {
      decisionTimeoutCapHours: 24
    },
    requestedTimeoutMs: 120_000,
    recentFailureSummary: null
  };
}

function buildParallelismArgs(): DecideParallelismArgs {
  return {
    context: BASE_CONTEXT,
    missionObjective: "Ship lane-aware orchestration with safe parallelism.",
    plannerParallelismCap: 4,
    laneStrategyParallelismCap: 3,
    runMode: "manual",
    stepCount: 8,
    laneCount: 3
  };
}

function buildRecoveryArgs(): DecideRecoveryArgs {
  return {
    context: BASE_CONTEXT,
    failureClass: "transient",
    failureMessage: "Command timed out",
    retryCount: 1,
    retryLimit: 2,
    qualityGateFailed: false
  };
}

function buildReplanArgs(): ReplanMissionArgs {
  return {
    context: BASE_CONTEXT,
    missionObjective: "Ship resilient orchestrator behavior",
    currentPlanSummary: "Implement, test, and roll out",
    failureDigest: "Repeated flaky integration failures in CI"
  };
}

describe("aiDecisionService", () => {
  it("uses executeTaskWithTools for lane strategy when tool-capable path exists", async () => {
    const executeTask = vi.fn();
    const executeTaskWithTools = vi.fn().mockResolvedValue(
      createTaskResult({
        strategy: "dependency_parallel",
        maxParallelLanes: 3,
        rationale: "Independent steps can run in parallel lanes safely.",
        confidence: 0.9,
        stepAssignments: [
          { stepKey: "step-a", laneLabel: "base" },
          { stepKey: "step-b", laneLabel: "lane-2", rationale: "Can run after step-a completes." }
        ]
      })
    );
    const service = createService({ executeTask, executeTaskWithTools });

    const decision = await service.decideLaneStrategy(buildLaneStrategyArgs());

    expect(executeTaskWithTools).toHaveBeenCalledTimes(1);
    expect(executeTask).not.toHaveBeenCalled();
    const request = executeTaskWithTools.mock.calls[0]?.[0] as {
      tools?: { payload?: { decisionName?: string } };
    };
    expect(request.tools?.payload?.decisionName).toBe("decideLaneStrategy");
    expect(request.tools).toMatchObject({
      mode: "if_available",
      deterministicFallback: "none",
      toolset: "orchestrator_complex_decision_v1"
    });
    expect(decision.strategy).toBe("dependency_parallel");
    expect(decision.maxParallelLanes).toBe(3);
    expect(decision.stepAssignments).toHaveLength(2);
  });

  it("forwards typed transition tools payload via executeTask when no executeTaskWithTools exists", async () => {
    const executeTask = vi.fn().mockResolvedValue(
      createTaskResult({
        actionType: "continue",
        reason: "Proceed to next step.",
        rationale: "No hard blockers.",
        nextStatus: null,
        retryDelayMs: null,
        timeoutBudgetMs: 180_000,
        confidence: 0.86
      })
    );
    const service = createService({ executeTask });

    const decision = await service.decideTransition(buildTransitionArgs());

    expect(executeTask).toHaveBeenCalledTimes(1);
    const request = executeTask.mock.calls[0]?.[0] as {
      tools?: { payload?: { decisionName?: string } };
    };
    expect(request.tools?.payload?.decisionName).toBe("decideTransition");
    expect(decision.action.type).toBe("pause");
    expect(decision.validationNotes).toContain("dependency_safe_override:blocking_dependencies");
  });

  it("uses structured path for parallelism decisions and maps call type", async () => {
    const executeTask = vi.fn().mockResolvedValue(
      createTaskResult({
        parallelismCap: 5,
        rationale: "Planner and lane strategy both support higher safe fanout.",
        confidence: 0.84
      })
    );
    const service = createService({ executeTask });

    const decision = await service.decideParallelism(buildParallelismArgs());

    expect(executeTask).toHaveBeenCalledTimes(1);
    const request = executeTask.mock.calls[0]?.[0] as { prompt?: string; tools?: unknown };
    expect(String(request.prompt)).toContain("Decision: parallelism cap");
    expect(request.tools).toBeUndefined();
    expect(decision.parallelismCap).toBe(5);
  });

  it("does not fall back when tool-capable recovery execution fails", async () => {
    const executeTask = vi.fn();
    const executeTaskWithTools = vi.fn().mockRejectedValue(new Error("tool transport unavailable"));
    const service = createService({ executeTask, executeTaskWithTools });

    let thrown: unknown = null;
    try {
      await service.decideRecovery(buildRecoveryArgs());
    } catch (error) {
      thrown = error;
    }

    expect(executeTaskWithTools).toHaveBeenCalledTimes(1);
    expect(executeTask).not.toHaveBeenCalled();
    expect(thrown).toBeInstanceOf(DecisionFailure);
    const failure = thrown as DecisionFailure;
    expect(failure.decisionName).toBe("decideRecovery");
    expect(failure.message).toContain("tool transport unavailable");
  });

  it("uses tool payload for mission replan and still parses structured output", async () => {
    const executeTask = vi.fn();
    const executeTaskWithTools = vi.fn().mockResolvedValue(
      createTaskResult({
        shouldReplan: true,
        summary: "Dependencies changed, plan needs reordering.",
        planDelta: ["Prioritize integration tests", 42, "Add rollback validation"],
        confidence: 0.72
      })
    );
    const service = createService({ executeTask, executeTaskWithTools });

    const decision = await service.replanMission(buildReplanArgs());

    expect(executeTaskWithTools).toHaveBeenCalledTimes(1);
    const request = executeTaskWithTools.mock.calls[0]?.[0] as {
      tools?: { payload?: { decisionName?: string } };
    };
    expect(request.tools?.payload?.decisionName).toBe("replanMission");
    expect(decision.shouldReplan).toBe(true);
    expect(decision.planDelta).toEqual(["Prioritize integration tests", "Add rollback validation"]);
  });

  it("keeps non-complex decisions on structured path without tools payload", async () => {
    const executeTask = vi.fn().mockResolvedValue(
      createTaskResult({
        shouldRetry: true,
        delayMs: 5_000,
        reason: "Transient network blip",
        adjustedHint: null,
        confidence: 0.8
      })
    );
    const executeTaskWithTools = vi.fn();
    const service = createService({ executeTask, executeTaskWithTools });

    await service.decideRetry({
      context: BASE_CONTEXT,
      errorClass: "transient",
      errorMessage: "network timeout",
      retryCount: 0,
      retryLimit: 2,
      lastAttemptSummary: null
    });

    expect(executeTaskWithTools).not.toHaveBeenCalled();
    const request = executeTask.mock.calls[0]?.[0] as { tools?: unknown };
    expect(request.tools).toBeUndefined();
  });
});
