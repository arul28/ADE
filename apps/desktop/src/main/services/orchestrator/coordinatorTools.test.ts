import { describe, expect, it, vi } from "vitest";
import { createCoordinatorToolSet, type CoordinatorWorkerDeliveryStatus } from "./coordinatorTools";

function createTestDeps(args: {
  graph: any;
  sendWorkerMessageToSession?: (input: { sessionId: string; text: string }) => Promise<CoordinatorWorkerDeliveryStatus>;
}) {
  const orchestratorService = {
    getRunGraph: vi.fn(() => args.graph),
    appendRuntimeEvent: vi.fn(),
    appendTimelineEvent: vi.fn(),
  } as any;

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;

  const tools = createCoordinatorToolSet({
    orchestratorService,
    missionService: {} as any,
    runId: "run-1",
    missionId: "mission-1",
    logger,
    db: {} as any,
    projectRoot: "/tmp",
    onDagMutation: vi.fn(),
    sendWorkerMessageToSession: args.sendWorkerMessageToSession,
  });

  return { tools, orchestratorService };
}

function createCoordinatorHarness(args: {
  graph: any;
  missionMetadata?: Record<string, unknown> | null;
  onRunFinalize?: (input: { runId: string; succeeded: boolean; summary?: string; reason?: string }) => void;
}) {
  const graph = {
    run: { metadata: {}, ...(args.graph?.run ?? {}) },
    steps: [],
    attempts: [],
    ...(args.graph ?? {}),
  };
  const onDagMutation = vi.fn();

  const db = {
    run: vi.fn(),
    get: vi.fn((query: string) => {
      if (query.includes("from missions") && args.missionMetadata) {
        return { metadata_json: JSON.stringify(args.missionMetadata) };
      }
      return null;
    }),
  } as any;

  const orchestratorService = {
    getRunGraph: vi.fn(() => graph),
    appendRuntimeEvent: vi.fn(),
    appendTimelineEvent: vi.fn(),
    createHandoff: vi.fn(),
    startReadyAutopilotAttempts: vi.fn(async () => 0),
    completeAttempt: vi.fn(),
    updateStepMetadata: vi.fn(({ stepId, metadata }: { stepId: string; metadata: Record<string, unknown> }) => {
      const step = graph.steps.find((entry: any) => entry.id === stepId);
      if (!step) return null;
      step.metadata = metadata;
      return step;
    }),
    skipStep: vi.fn(({ stepId }: { stepId: string }) => {
      const step = graph.steps.find((entry: any) => entry.id === stepId);
      if (step) step.status = "skipped";
    }),
    addSteps: vi.fn(({ steps }: { steps: any[] }) => {
      const idByKey = new Map(graph.steps.map((entry: any) => [entry.stepKey, entry.id]));
      const created = steps.map((input, index) => {
        const step = {
          id: `step-created-${graph.steps.length + index + 1}`,
          runId: "run-1",
          missionStepId: null,
          stepKey: input.stepKey,
          stepIndex: input.stepIndex ?? graph.steps.length + index,
          title: input.title ?? input.stepKey,
          laneId: input.laneId ?? null,
          status: "pending",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: Array.isArray(input.dependencyStepKeys)
            ? input.dependencyStepKeys
              .map((entry: string) => idByKey.get(entry))
              .filter((entry: string | undefined): entry is string => typeof entry === "string" && entry.length > 0)
            : [],
          retryLimit: 1,
          retryCount: 0,
          lastAttemptId: null,
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          startedAt: null,
          completedAt: null,
          metadata: input.metadata ?? {},
        };
        graph.steps.push(step);
        return step;
      });
      return created;
    }),
    updateStepDependencies: vi.fn(({ stepId, dependencyStepKeys }: { stepId: string; dependencyStepKeys: string[] }) => {
      const idByKey = new Map(graph.steps.map((entry: any) => [entry.stepKey, entry.id]));
      const step = graph.steps.find((entry: any) => entry.id === stepId);
      if (!step) return null;
      step.dependencyStepIds = dependencyStepKeys
        .map((entry) => idByKey.get(entry))
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
      return step;
    }),
  } as any;

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;

  const mission = {
    id: "mission-1",
    interventions: [] as any[],
  };
  const missionService = {
    get: vi.fn((missionId: string) => (missionId === mission.id ? mission : null)),
    addIntervention: vi.fn((input: any) => {
      const intervention = {
        id: `intervention-${mission.interventions.length + 1}`,
        interventionType: input.interventionType ?? "manual_input",
        status: "open",
        title: input.title ?? "",
        body: input.body ?? "",
        metadata: input.metadata ?? null,
      };
      mission.interventions.push(intervention);
      return intervention;
    }),
  } as any;

  const tools = createCoordinatorToolSet({
    orchestratorService,
    missionService,
    runId: "run-1",
    missionId: "mission-1",
    logger,
    db,
    projectRoot: "/tmp",
    onDagMutation,
    onRunFinalize: args.onRunFinalize,
  });

  return { tools, orchestratorService, db, graph, onDagMutation, missionService, mission };
}

describe("coordinatorTools delivery status", () => {
  it("send_message returns delivered send status when worker session accepts message", async () => {
    const sendWorkerMessageToSession = vi.fn(async () => ({
      ok: true,
      delivered: true,
      method: "send",
    } as const));
    const graph = {
      steps: [{ id: "step-1", stepKey: "worker-1" }],
      attempts: [{ id: "attempt-1", stepId: "step-1", status: "running", executorSessionId: "session-1" }],
    };
    const { tools } = createTestDeps({ graph, sendWorkerMessageToSession });

    const result = await (tools.send_message as any).execute({
      workerId: "worker-1",
      content: "Please focus on tests first."
    });

    expect(sendWorkerMessageToSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      text: "Please focus on tests first."
    });
    expect(result).toMatchObject({
      ok: true,
      delivered: true,
      method: "send",
      workerId: "worker-1",
      sessionId: "session-1"
    });
  });

  it("send_message returns queued steer status when worker is busy", async () => {
    const sendWorkerMessageToSession = vi.fn(async () => ({
      ok: true,
      delivered: false,
      method: "steer",
      reason: "worker_busy_steered",
    } as const));
    const graph = {
      steps: [{ id: "step-1", stepKey: "worker-1" }],
      attempts: [{ id: "attempt-1", stepId: "step-1", status: "running", executorSessionId: "session-1" }],
    };
    const { tools } = createTestDeps({ graph, sendWorkerMessageToSession });

    const result = await (tools.send_message as any).execute({
      workerId: "worker-1",
      content: "Status?"
    });

    expect(result).toMatchObject({
      ok: true,
      delivered: false,
      method: "steer",
      reason: "worker_busy_steered",
      workerId: "worker-1"
    });
  });

  it("message_worker surfaces no_active_session for recipients without a running session", async () => {
    const graph = {
      steps: [
        { id: "step-from", stepKey: "worker-from" },
        { id: "step-to", stepKey: "worker-to" },
      ],
      attempts: [{ id: "attempt-from", stepId: "step-from", status: "running", executorSessionId: "session-from" }],
    };
    const { tools } = createTestDeps({ graph });

    const result = await (tools.message_worker as any).execute({
      fromWorkerId: "worker-from",
      toWorkerId: "worker-to",
      content: "Can you validate this?",
      priority: "normal"
    });

    expect(result).toMatchObject({
      ok: false,
      delivered: false,
      reason: "no_active_session"
    });
  });

  it("broadcast reports per-session delivery status across running attempts", async () => {
    const sendWorkerMessageToSession = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === "session-1") {
        return { ok: true, delivered: true, method: "send" } as const;
      }
      return {
        ok: true,
        delivered: false,
        method: "steer",
        reason: "worker_busy_steered",
      } as const;
    });
    const graph = {
      steps: [
        { id: "step-1", stepKey: "worker-1" },
        { id: "step-2", stepKey: "worker-2" },
        { id: "step-3", stepKey: "worker-3" },
      ],
      attempts: [
        { id: "attempt-1", stepId: "step-1", status: "running", executorSessionId: "session-1" },
        { id: "attempt-2", stepId: "step-2", status: "running", executorSessionId: "session-2" },
        { id: "attempt-3", stepId: "step-3", status: "running", executorSessionId: null },
      ],
    };
    const { tools } = createTestDeps({ graph, sendWorkerMessageToSession });

    const result = await (tools.broadcast as any).execute({
      content: "Please pause and summarize your current state."
    });

    expect(result).toMatchObject({
      ok: true,
      recipientCount: 3,
      delivered: 1,
      queued: 1,
      failed: 1,
    });
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workerId: "worker-1",
          ok: true,
          delivered: true,
          method: "send",
        }),
        expect.objectContaining({
          workerId: "worker-2",
          ok: true,
          delivered: false,
          method: "steer",
          reason: "worker_busy_steered",
        }),
        expect.objectContaining({
          workerId: "worker-3",
          ok: false,
          delivered: false,
          reason: "no_active_session",
        }),
      ])
    );
    expect(sendWorkerMessageToSession).toHaveBeenCalledTimes(2);
  });
});

describe("coordinatorTools validation enforcement", () => {
  it("mark_step_complete rejects required validation when state is not pass", async () => {
    const graph = {
      run: { metadata: { teamRuntime: { policyOverrides: { requireValidatorPass: true } } } },
      steps: [
        {
          id: "step-1",
          stepKey: "worker-1",
          stepIndex: 0,
          title: "Worker 1",
          laneId: null,
          status: "ready",
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          metadata: {
            validationContract: {
              level: "step",
              tier: "dedicated",
              required: true,
              criteria: "Tests and review must pass",
              evidence: [],
              maxRetries: 2
            },
            validationState: "pending"
          }
        }
      ],
      attempts: []
    };
    const { tools, db, orchestratorService } = createCoordinatorHarness({ graph });

    const result = await (tools.mark_step_complete as any).execute({
      workerId: "worker-1"
    });

    expect(result).toMatchObject({
      ok: false,
      validation: {
        state: "pending"
      }
    });
    expect(String(result.error)).toContain("requires validator pass");
    expect(String(result.hint)).toContain("report_validation");
    expect(db.run).not.toHaveBeenCalled();
    expect(orchestratorService.completeAttempt).not.toHaveBeenCalled();
  });

  it("mark_step_complete allows bypass when requireValidatorPass is false", async () => {
    const graph = {
      run: { metadata: { teamRuntime: { policyOverrides: { requireValidatorPass: false } } } },
      steps: [
        {
          id: "step-1",
          stepKey: "worker-1",
          stepIndex: 0,
          title: "Worker 1",
          laneId: null,
          status: "ready",
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          metadata: {
            validationContract: {
              level: "step",
              tier: "dedicated",
              required: true,
              criteria: "Tests and review must pass",
              evidence: [],
              maxRetries: 2
            },
            validationState: "fail"
          }
        }
      ],
      attempts: []
    };
    const { tools, db } = createCoordinatorHarness({ graph });

    const result = await (tools.mark_step_complete as any).execute({
      workerId: "worker-1"
    });

    expect(result).toMatchObject({
      ok: true,
      workerId: "worker-1",
      newStatus: "succeeded"
    });
    expect(db.run).toHaveBeenCalled();
  });

  it("complete_mission blocks when required validation is not pass on succeeded/non-terminal steps", async () => {
    const onRunFinalize = vi.fn();
    const graph = {
      run: { metadata: { teamRuntime: { policyOverrides: { requireValidatorPass: true } } } },
      steps: [
        {
          id: "step-succeeded",
          stepKey: "impl",
          stepIndex: 0,
          title: "Implementation",
          laneId: null,
          status: "succeeded",
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          metadata: {
            validationContract: {
              level: "step",
              tier: "dedicated",
              required: true,
              criteria: "Validation pass is required",
              evidence: [],
              maxRetries: 2
            },
            validationState: "fail"
          }
        },
        {
          id: "step-skipped",
          stepKey: "docs",
          stepIndex: 1,
          title: "Docs",
          laneId: null,
          status: "skipped",
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          metadata: {
            validationContract: {
              level: "step",
              tier: "dedicated",
              required: true,
              criteria: "Should be ignored when skipped",
              evidence: [],
              maxRetries: 2
            },
            validationState: "fail"
          }
        }
      ],
      attempts: []
    };
    const { tools, orchestratorService } = createCoordinatorHarness({ graph, onRunFinalize });

    const result = await (tools.complete_mission as any).execute({
      summary: "Done"
    });

    expect(result).toMatchObject({
      ok: false,
      blockers: [
        expect.objectContaining({ stepKey: "impl", validationState: "fail" })
      ]
    });
    expect(String(result.error)).toContain("cannot be completed");
    expect(onRunFinalize).not.toHaveBeenCalled();
    expect(orchestratorService.appendRuntimeEvent).not.toHaveBeenCalled();
  });

  it("complete_mission allows bypass when requireValidatorPass is false", async () => {
    const onRunFinalize = vi.fn();
    const graph = {
      run: { metadata: { teamRuntime: { policyOverrides: { requireValidatorPass: false } } } },
      steps: [
        {
          id: "step-succeeded",
          stepKey: "impl",
          stepIndex: 0,
          title: "Implementation",
          laneId: null,
          status: "succeeded",
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          metadata: {
            validationContract: {
              level: "step",
              tier: "dedicated",
              required: true,
              criteria: "Validation pass is required",
              evidence: [],
              maxRetries: 2
            },
            validationState: "fail"
          }
        }
      ],
      attempts: []
    };
    const { tools, orchestratorService } = createCoordinatorHarness({ graph, onRunFinalize });

    const result = await (tools.complete_mission as any).execute({
      summary: "Done"
    });

    expect(result).toMatchObject({
      ok: true,
      runId: "run-1",
      summary: "Done"
    });
    expect(onRunFinalize).toHaveBeenCalledWith({
      runId: "run-1",
      succeeded: true,
      summary: "Done"
    });
    expect(orchestratorService.appendRuntimeEvent).toHaveBeenCalled();
  });
});

describe("coordinatorTools insert_milestone", () => {
  it("creates a milestone step and gates requested steps without auto-starting workers", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [
        {
          id: "step-a",
          stepKey: "impl-a",
          stepIndex: 0,
          title: "Implementation A",
          laneId: null,
          status: "succeeded",
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          metadata: {}
        },
        {
          id: "step-b",
          stepKey: "impl-b",
          stepIndex: 1,
          title: "Implementation B",
          laneId: null,
          status: "pending",
          dependencyStepIds: ["step-a"],
          retryLimit: 1,
          retryCount: 0,
          metadata: {}
        }
      ],
      attempts: []
    };
    const { tools, orchestratorService } = createCoordinatorHarness({ graph });

    const result = await (tools.insert_milestone as any).execute({
      name: "API Milestone",
      dependsOn: ["impl-a"],
      validationCriteria: "Integration tests pass and validator signs off",
      gatesSteps: ["impl-b"]
    });

    expect(result).toMatchObject({
      ok: true,
      milestone: {
        name: "API Milestone",
        validationContract: {
          level: "milestone",
          tier: "dedicated",
          required: true,
          criteria: "Integration tests pass and validator signs off",
          maxRetries: 2,
          evidence: []
        }
      },
      gatesStepsPatched: [
        expect.objectContaining({ stepKey: "impl-b" })
      ]
    });
    expect(orchestratorService.addSteps).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      steps: [
        expect.objectContaining({
          executorKind: "manual",
          metadata: expect.objectContaining({
            stepType: "milestone",
            isMilestone: true,
            milestoneValidationCriteria: "Integration tests pass and validator signs off",
            validationContract: expect.objectContaining({
              level: "milestone",
              tier: "dedicated",
              required: true
            })
          })
        })
      ]
    }));
    expect(orchestratorService.updateStepDependencies).toHaveBeenCalledWith({
      runId: "run-1",
      stepId: "step-b",
      dependencyStepKeys: ["impl-a", result.milestone.stepKey]
    });
    expect(orchestratorService.startReadyAutopilotAttempts).not.toHaveBeenCalled();
  });
});

describe("coordinatorTools report_validation milestone behavior", () => {
  it("marks milestone step succeeded when validation passes", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [
        {
          id: "step-ms",
          stepKey: "milestone-auth",
          stepIndex: 2,
          title: "Auth milestone",
          laneId: null,
          status: "ready",
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          metadata: {
            isMilestone: true,
            validationContract: {
              level: "milestone",
              tier: "dedicated",
              required: true,
              criteria: "Auth tests pass",
              evidence: [],
              maxRetries: 2,
            },
          },
        },
      ],
      attempts: [],
    };
    const { tools, db, onDagMutation } = createCoordinatorHarness({ graph });

    const result = await (tools.report_validation as any).execute({
      targetWorkerId: "milestone-auth",
      contract: {
        level: "milestone",
        tier: "dedicated",
        required: true,
        criteria: "Auth tests pass",
        evidence: [],
        maxRetries: 2,
      },
      verdict: "pass",
      summary: "Milestone validation passed",
      findings: [],
      remediationInstructions: [],
    });

    expect(result).toMatchObject({
      ok: true,
      maxRetriesExceeded: false,
      milestoneMarkedComplete: true,
    });
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("update orchestrator_steps set status = 'succeeded'"),
      expect.any(Array),
    );
    expect(onDagMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        mutation: expect.objectContaining({
          type: "status_changed",
          stepKey: "milestone-auth",
          newStatus: "succeeded",
        }),
      }),
    );
  });

  it("opens intervention when required validation retries are exhausted", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [
        {
          id: "step-api",
          stepKey: "api-contracts",
          stepIndex: 3,
          title: "API contracts",
          laneId: null,
          status: "running",
          dependencyStepIds: [],
          retryLimit: 2,
          retryCount: 1,
          metadata: {
            validationContract: {
              level: "step",
              tier: "dedicated",
              required: true,
              criteria: "Contract tests pass",
              evidence: [],
              maxRetries: 1,
            },
          },
        },
      ],
      attempts: [],
    };
    const { tools, missionService } = createCoordinatorHarness({ graph });

    const result = await (tools.report_validation as any).execute({
      targetWorkerId: "api-contracts",
      contract: {
        level: "step",
        tier: "dedicated",
        required: true,
        criteria: "Contract tests pass",
        evidence: [],
        maxRetries: 1,
      },
      verdict: "fail",
      summary: "Contract checks failed",
      findings: [
        {
          code: "contracts.broken",
          severity: "high",
          message: "Breaking response schema change detected",
        },
      ],
      remediationInstructions: ["Restore backwards-compatible API schema"],
      retriesUsed: 1,
    });

    expect(result).toMatchObject({
      ok: true,
      maxRetriesExceeded: true,
      recommendedAction: "escalate_human_or_replan",
    });
    expect(result.interventionId).toBeTruthy();
    expect(missionService.addIntervention).toHaveBeenCalledTimes(1);
  });
});
