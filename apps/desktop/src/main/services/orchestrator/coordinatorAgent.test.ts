import { beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinatorAgent } from "./coordinatorAgent";
import { startOpenCodeSession } from "../opencode/openCodeRuntime";

const mockState = vi.hoisted(() => ({
  eventBatches: [] as Array<any[]>,
  promptAsync: vi.fn(async () => undefined),
  close: vi.fn(),
}));

vi.mock("../opencode/openCodeRuntime", () => ({
  buildOpenCodePromptParts: vi.fn(({ prompt }: { prompt: string }) => [{ type: "text", text: prompt }]),
  mapPermissionModeToOpenCodeAgent: vi.fn(() => "ade-plan"),
  refreshOpenCodeSessionToolSelection: vi.fn(async () => null),
  resolveOpenCodeModelSelection: vi.fn((descriptor: Record<string, unknown>) => ({
    providerID: String(descriptor.family ?? "anthropic"),
    modelID: String(descriptor.providerModelId ?? descriptor.id ?? "model"),
  })),
  startOpenCodeSession: vi.fn(async (args: { directory: string }) => ({
    client: {
      session: {
        promptAsync: mockState.promptAsync,
      },
    },
    server: { url: "http://127.0.0.1:4096", close: mockState.close },
    sessionId: "session-1",
    directory: args.directory,
    close: mockState.close,
    touch: vi.fn(),
    setBusy: vi.fn(),
    setEvictionHandler: vi.fn(),
  })),
  openCodeEventStream: vi.fn(async () => ({
    async *[Symbol.asyncIterator]() {
      const batch = mockState.eventBatches.shift() ?? [];
      for (const event of batch) {
        yield event;
      }
    },
  })),
}));

function createPlanningPhases() {
  return [
    {
      id: "phase-planning",
      phaseKey: "planning",
      name: "Planning",
      position: 0,
      instructions: "Plan first.",
      model: { modelId: "anthropic/claude-sonnet-4-6" },
      budget: {},
      askQuestions: { enabled: true, maxQuestions: 3 },
      validationGate: { tier: "none", required: false },
      orderingConstraints: { mustBeFirst: true },
      requiresApproval: false,
      isBuiltIn: true,
      isCustom: false,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:00.000Z",
    },
    {
      id: "phase-development",
      phaseKey: "development",
      name: "Development",
      position: 1,
      instructions: "Implement.",
      model: { modelId: "openai/gpt-5.3-codex" },
      budget: {},
      askQuestions: { enabled: false, maxQuestions: 0 },
      validationGate: { tier: "none", required: false },
      orderingConstraints: {},
      requiresApproval: false,
      isBuiltIn: true,
      isCustom: false,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:00.000Z",
    },
  ] as any;
}

function createCustomPlanningPhases() {
  return [
    {
      id: "phase-planning",
      phaseKey: "planning",
      name: "Planning",
      position: 0,
      instructions: "Plan first.",
      model: { modelId: "openai/gpt-5.3-codex-spark" },
      budget: {},
      askQuestions: { enabled: false, maxQuestions: 0 },
      validationGate: { tier: "none", required: false },
      orderingConstraints: { mustBeFirst: true },
      requiresApproval: false,
      isBuiltIn: true,
      isCustom: false,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:00.000Z",
    },
    {
      id: "phase-implementation-math",
      phaseKey: "implementation_math",
      name: "Implementation math",
      position: 1,
      instructions: "Implement math work.",
      model: { modelId: "openai/gpt-5.3-codex-spark" },
      budget: {},
      askQuestions: { enabled: false, maxQuestions: 0 },
      validationGate: { tier: "self", required: true },
      orderingConstraints: { mustFollow: ["planning"] },
      requiresApproval: false,
      isBuiltIn: false,
      isCustom: true,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:00.000Z",
    },
  ] as any;
}

function createTestCoordinatorAgent(args?: {
  onCoordinatorEvent?: (event: any) => void;
  onPlanningStartupFailure?: (failure: any) => void;
  onCoordinatorRuntimeFailure?: (failure: any) => void;
  onCoordinatorChatSessionStarted?: (args: any) => void;
  onCoordinatorChatRuntimeTurnStarted?: (args: any) => void;
  onCoordinatorChatRuntimeTurnFinished?: (args: any) => void;
  agentChatService?: any;
  coordinatorReasoningEffort?: string | null;
  missionLaneId?: string;
  phases?: any[];
  runStatus?: string;
  modelId?: string;
}) {
  const graph = {
    run: {
      id: "run-1",
      metadata: {
        phaseRuntime: {
          currentPhaseModel: {
            modelId: "anthropic/claude-sonnet-4-6",
            thinkingLevel: "medium",
          },
        },
      },
    },
    steps: [] as any[],
    attempts: [] as any[],
  };

  const agent = new CoordinatorAgent({
    orchestratorService: {
      getRunGraph: vi.fn(() => graph),
      addSteps: vi.fn(({ steps }: { steps: any[] }) =>
        steps.map((step, index) => {
          const created = {
            id: `step-created-${graph.steps.length + index + 1}`,
            runId: "run-1",
            missionStepId: null,
            stepKey: step.stepKey,
            stepIndex: step.stepIndex ?? graph.steps.length + index,
            title: step.title ?? step.stepKey,
            laneId: step.laneId ?? null,
            status: "pending",
            executorKind: step.executorKind ?? null,
            joinPolicy: step.joinPolicy ?? "all_success",
            quorumCount: null,
            dependencyStepIds: [],
            retryLimit: 1,
            retryCount: 0,
            lastAttemptId: null,
            createdAt: "2026-03-12T00:00:00.000Z",
            updatedAt: "2026-03-12T00:00:00.000Z",
            startedAt: null,
            completedAt: null,
            metadata: step.metadata ?? {},
          };
          graph.steps.push(created);
          return created;
        }),
      ),
      startReadyAutopilotAttempts: vi.fn(async () => 0),
      appendTimelineEvent: vi.fn(),
      emitRuntimeUpdate: vi.fn(),
      skipStep: vi.fn(({ stepId }: { stepId: string }) => {
        const step = graph.steps.find((entry) => entry.id === stepId);
        if (step) step.status = "skipped";
      }),
      completeAttempt: vi.fn(async () => undefined),
    } as any,
    runId: "run-1",
    missionId: "mission-1",
    missionGoal: "Test mission",
    modelId: args?.modelId ?? "anthropic/claude-sonnet-4-6",
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as any,
    db: {
      get: vi.fn((sql: string) => {
        if (sql.includes("SELECT status FROM orchestrator_runs")) {
          return { status: args?.runStatus ?? "active" };
        }
        return null;
      }),
      all: vi.fn(() => []),
      run: vi.fn(),
    } as any,
    projectId: "project-1",
    projectRoot: "/tmp/ade-project",
    workspaceRoot: "/tmp/ade-worktree",
    missionService: {
      get: vi.fn(() => ({ interventions: [] })),
    } as any,
    aiIntegrationService: {
      executeTask: vi.fn(async () => ({
        text: "Compacted summary",
        structuredOutput: null,
        provider: "claude",
        model: args?.modelId ?? "anthropic/claude-sonnet-4-6",
        sessionId: null,
        inputTokens: null,
        outputTokens: null,
        durationMs: 1,
      })),
    } as any,
    agentChatService: args?.agentChatService ?? null,
    coordinatorReasoningEffort: args?.coordinatorReasoningEffort ?? null,
    projectConfigService: {
      get: vi.fn(() => ({ effective: { ai: {} } })),
    } as any,
    onDagMutation: vi.fn(),
    onCoordinatorEvent: args?.onCoordinatorEvent,
    onCoordinatorChatSessionStarted: args?.onCoordinatorChatSessionStarted,
    onCoordinatorChatRuntimeTurnStarted: args?.onCoordinatorChatRuntimeTurnStarted,
    onCoordinatorChatRuntimeTurnFinished: args?.onCoordinatorChatRuntimeTurnFinished,
    onPlanningStartupFailure: args?.onPlanningStartupFailure,
    onCoordinatorRuntimeFailure: args?.onCoordinatorRuntimeFailure,
    missionLaneId: args?.missionLaneId,
    phases: args?.phases,
  });
  (agent as any).__graph = graph;
  return agent;
}

beforeEach(() => {
  mockState.eventBatches.length = 0;
  mockState.promptAsync.mockReset();
  mockState.close.mockReset();
});

describe("CoordinatorAgent", () => {
  it("respects phase decks that intentionally skip planning", () => {
    const developmentPhase = {
      id: "phase-development",
      phaseKey: "development",
      name: "Development",
      position: 0,
      instructions: "Implement directly.",
      model: { modelId: "openai/gpt-5.5" },
      budget: {},
      askQuestions: { enabled: false, maxQuestions: 0 },
      validationGate: { tier: "none", required: false },
      orderingConstraints: {},
      requiresApproval: false,
      isBuiltIn: true,
      isCustom: false,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:00.000Z",
    };
    const agent = createTestCoordinatorAgent({ phases: [developmentPhase] }) as any;

    try {
      expect(agent.deps.phases.map((phase: any) => phase.phaseKey)).toEqual(["development"]);
      expect(agent.systemPrompt).toContain("1. DEVELOPMENT (model: openai/gpt-5.5)");
      expect(agent.systemPrompt).not.toContain("PLANNING (model:");
      expect(agent.__graph.steps.some((step: any) => step.stepKey === "planner-launch-tracker")).toBe(false);
    } finally {
      agent.shutdown();
    }
  });

  it("labels runtime-created testing phase workers as testing even when dedicated validation is required", () => {
    const agent = createTestCoordinatorAgent() as any;
    try {
      const metadata = agent.buildRuntimePhaseStepMetadata({
        id: "phase-testing",
        phaseKey: "testing",
        name: "Testing",
        position: 2,
        instructions: "Run the test suite.",
        model: { modelId: "openai/gpt-5.3-codex-spark" },
        budget: {},
        askQuestions: { enabled: false, maxQuestions: 0 },
        validationGate: { tier: "dedicated", required: true },
        orderingConstraints: { mustFollow: ["development"] },
        requiresApproval: false,
        isBuiltIn: true,
        isCustom: false,
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      }, "openai/gpt-5.3-codex-spark", "testing-worker");

      expect(metadata.stepType).toBe("testing");
      expect(metadata.taskType).toBe("testing");
      expect(metadata.modelProviderHint).toBe("codex");
    } finally {
      agent.shutdown();
    }
  });

  it("accepts a completed ADE-prefixed planner spawn as the startup success path", async () => {
    const plannerToolOutput = {
      ok: true,
      workerId: "worker-planner-1",
      launched: true,
      stepId: "step-planner-1",
      delegationContract: {
        schemaVersion: 1,
        contractId: "contract-planner-1",
        runId: "run-1",
        ownerKind: "coordinator",
        workerIntent: "planner",
        mode: "exclusive",
        scope: { kind: "phase", key: "phase:planning", label: "Planning" },
        phaseKey: "planning",
        status: "active",
        launchState: "waiting_on_worker",
        activeWorkerIds: ["worker-planner-1"],
        coordinatorCapabilities: ["observe", "run_control", "update_mission_state"],
        launchPolicy: { maxLaunchAttempts: 2 },
        failurePolicy: { retryLimit: 1, escalation: "intervention" },
        batchId: null,
        parentContractId: null,
        failure: null,
        metadata: {},
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:01.000Z",
        startedAt: "2026-03-12T00:00:01.000Z",
        completedAt: null,
      },
    };

    mockState.eventBatches.push([
      {
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "session-1",
            id: "tool-planner",
            callID: "call-planner",
            type: "tool",
            tool: "ade_spawn_worker",
            state: {
              status: "completed",
              input: { name: "planning-readonly" },
              output: {
                content: [{ type: "text", text: JSON.stringify(plannerToolOutput) }],
              },
            },
          },
          delta: null,
        },
      },
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ]);

    const onCoordinatorEvent = vi.fn();
    const onPlanningStartupFailure = vi.fn();
    const agent = createTestCoordinatorAgent({
      onCoordinatorEvent,
      onPlanningStartupFailure,
      phases: createPlanningPhases(),
    }) as any;

    try {
      agent.injectMessage("Kick off planning.");
      await agent.processBatch();

      expect(onPlanningStartupFailure).not.toHaveBeenCalled();
      expect(onCoordinatorEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "status",
        message: "The planning agent is running. I’m waiting for its result.",
      }));
      expect(agent.isAlive).toBe(true);
    } finally {
      agent.shutdown();
    }
  });

  it("retries planner launch once on transient provider failures, then surfaces structured failure", async () => {
    mockState.eventBatches.push(
      [
        {
          type: "message.part.updated",
          properties: {
            part: {
              sessionID: "session-1",
              id: "tool-1",
              callID: "call-1",
              type: "tool",
              tool: "spawn_worker",
              state: {
                status: "error",
                error: "Model provider timeout",
                input: { name: "planner" },
              },
            },
            delta: null,
          },
        },
        { type: "session.idle", properties: { sessionID: "session-1" } },
      ],
      [
        {
          type: "message.part.updated",
          properties: {
            part: {
              sessionID: "session-1",
              id: "tool-2",
              callID: "call-2",
              type: "tool",
              tool: "spawn_worker",
              state: {
                status: "error",
                error: "Model provider timeout",
                input: { name: "planner" },
              },
            },
            delta: null,
          },
        },
        { type: "session.idle", properties: { sessionID: "session-1" } },
      ],
    );

    const onCoordinatorEvent = vi.fn();
    const onPlanningStartupFailure = vi.fn();
    const agent = createTestCoordinatorAgent({
      onCoordinatorEvent,
      onPlanningStartupFailure,
      phases: createPlanningPhases(),
    }) as any;

    try {
      agent.injectMessage("Kick off planning.");
      await agent.processBatch();
      await agent.processBatch();

      expect(onCoordinatorEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "status",
        turnStatus: "interrupted",
        message: "The planner hit a launch issue, so I’m retrying once.",
      }));
      expect(onPlanningStartupFailure).toHaveBeenCalledWith(expect.objectContaining({
        category: "provider_unreachable",
        retryable: true,
        retryCount: 1,
        recoveryOptions: ["retry", "switch_to_fallback_model", "cancel_run"],
      }));
    } finally {
      agent.shutdown();
    }
  });

  it("promotes short provider failure replies to the primary runtime failure", async () => {
    mockState.eventBatches.push([
      {
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "session-1",
            id: "text-1",
            type: "text",
            text: "Your account does not have access to Claude. Please login again or contact your administrator.",
          },
          delta: "Your account does not have access to Claude. Please login again or contact your administrator.",
        },
      },
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ]);

    const onCoordinatorRuntimeFailure = vi.fn();
    const agent = createTestCoordinatorAgent({
      onCoordinatorRuntimeFailure,
      phases: createPlanningPhases(),
    }) as any;

    try {
      agent.injectMessage("Start the run.");
      await agent.processBatch();

      expect(onCoordinatorRuntimeFailure).toHaveBeenCalledWith(expect.objectContaining({
        category: "provider_unreachable",
        reasonCode: "coordinator_runtime_provider_auth_failed",
        interventionType: "provider_unreachable",
        turnId: "coord-turn-1",
      }));
    } finally {
      agent.shutdown();
    }
  });

  it("classifies missing coordinator models as recoverable provider configuration failures", async () => {
    mockState.eventBatches.push([
      {
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "session-1",
            id: "text-model-not-found",
            type: "text",
            text: "Model not found: openai/gpt-5.3-codex-spark",
          },
          delta: "Model not found: openai/gpt-5.3-codex-spark",
        },
      },
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ]);

    const onCoordinatorRuntimeFailure = vi.fn();
    const agent = createTestCoordinatorAgent({
      onCoordinatorRuntimeFailure,
      phases: createPlanningPhases(),
    }) as any;

    try {
      agent.injectMessage("Start the run.");
      await agent.processBatch();

      expect(onCoordinatorRuntimeFailure).toHaveBeenCalledWith(expect.objectContaining({
        category: "provider_unreachable",
        reasonCode: "coordinator_runtime_model_unavailable",
        interventionType: "provider_unreachable",
        retryable: true,
        recoveryOptions: ["retry", "switch_to_fallback_model", "cancel_run"],
      }));
    } finally {
      agent.shutdown();
    }
  });

  it("pauses the turn when a blocking ask-user tool result arrives", async () => {
    mockState.eventBatches.push([
      {
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "session-1",
            id: "ask-1",
            callID: "call-ask-1",
            type: "tool",
            tool: "ask_user",
            state: {
              status: "completed",
              input: { title: "Clarify" },
              output: { awaitingUserResponse: true, blocking: true },
            },
          },
          delta: null,
        },
      },
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ]);

    const onCoordinatorEvent = vi.fn();
    const agent = createTestCoordinatorAgent({
      onCoordinatorEvent,
    }) as any;

    try {
      agent.injectMessage("Ask the user.");
      await agent.processBatch();

      expect(onCoordinatorEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "status",
        turnStatus: "interrupted",
        turnId: "coord-turn-1",
      }));
    } finally {
      agent.shutdown();
    }
  });

  it("retries planning startup once when the coordinator does not create the planner", async () => {
    const plannerToolOutput = {
      ok: true,
      workerId: "worker-planner-retry",
      launched: true,
      stepId: "step-planner-retry",
      delegationContract: {
        schemaVersion: 1,
        contractId: "contract-planner-retry",
        runId: "run-1",
        ownerKind: "coordinator",
        workerIntent: "planner",
        mode: "exclusive",
        scope: { kind: "phase", key: "phase:planning", label: "Planning" },
        phaseKey: "planning",
        status: "active",
        launchState: "waiting_on_worker",
        activeWorkerIds: ["worker-planner-retry"],
        coordinatorCapabilities: ["observe", "run_control", "update_mission_state"],
        launchPolicy: { maxLaunchAttempts: 2 },
        failurePolicy: { retryLimit: 1, escalation: "intervention" },
        batchId: null,
        parentContractId: null,
        failure: null,
        metadata: {},
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:01.000Z",
        startedAt: "2026-03-12T00:00:01.000Z",
        completedAt: null,
      },
    };

    mockState.eventBatches.push(
      [
        {
          type: "message.part.updated",
          properties: {
            part: {
              sessionID: "session-1",
              id: "synthetic-prompt",
              type: "text",
              text: "PLANNING STARTUP REQUIRED: echoed prompt",
              synthetic: true,
            },
            delta: "PLANNING STARTUP REQUIRED: echoed prompt",
          },
        },
        { type: "session.idle", properties: { sessionID: "session-1" } },
      ],
      [
        {
          type: "message.part.updated",
          properties: {
            part: {
              sessionID: "session-1",
              id: "tool-planner-retry",
              callID: "call-planner-retry",
              type: "tool",
              tool: "ade_spawn_worker",
              state: {
                status: "completed",
                input: { name: "planning-readonly" },
                output: plannerToolOutput,
              },
            },
            delta: null,
          },
        },
        { type: "session.idle", properties: { sessionID: "session-1" } },
      ],
    );

    const onCoordinatorEvent = vi.fn();
    const onPlanningStartupFailure = vi.fn();
    const agent = createTestCoordinatorAgent({
      onCoordinatorEvent,
      onPlanningStartupFailure,
      phases: createPlanningPhases(),
    }) as any;

    try {
      agent.injectMessage("Kick off planning.");
      await agent.processBatch();
      await agent.processBatch();

      expect(onPlanningStartupFailure).not.toHaveBeenCalled();
      expect(onCoordinatorEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "status",
        message: "The coordinator did not start the planner, so I’m retrying the startup turn once.",
      }));
      const promptCalls = mockState.promptAsync.mock.calls as any[];
      expect(promptCalls[1]?.[0]?.body?.parts?.[0]?.text).toContain("PLANNING STARTUP RETRY REQUIRED");
      expect(onCoordinatorEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "status",
        message: "The planning agent is running. I’m waiting for its result.",
      }));
    } finally {
      agent.shutdown();
    }
  });

  it("launches the required planner through mission control after startup retry is ignored", async () => {
    mockState.eventBatches.push(
      [{ type: "session.idle", properties: { sessionID: "session-1" } }],
      [{ type: "session.idle", properties: { sessionID: "session-1" } }],
    );

    const onCoordinatorEvent = vi.fn();
    const onPlanningStartupFailure = vi.fn();
    const agent = createTestCoordinatorAgent({
      onCoordinatorEvent,
      onPlanningStartupFailure,
      phases: createPlanningPhases(),
    }) as any;
    const runtimeSpawn = vi.fn(async () => ({
      ok: true,
      workerId: "worker-runtime-planner",
      launched: true,
      stepId: "step-runtime-planner",
      delegationContract: {
        schemaVersion: 1,
        contractId: "contract-runtime-planner",
        runId: "run-1",
        ownerKind: "coordinator",
        workerIntent: "planner",
        mode: "exclusive",
        scope: { kind: "phase", key: "phase:planning", label: "Planning" },
        phaseKey: "planning",
        status: "active",
        launchState: "waiting_on_worker",
        activeWorkerIds: ["worker-runtime-planner"],
        coordinatorCapabilities: ["observe", "run_control", "update_mission_state"],
        launchPolicy: { maxLaunchAttempts: 2 },
        failurePolicy: { retryLimit: 1, escalation: "intervention" },
        batchId: null,
        parentContractId: null,
        failure: null,
        metadata: {},
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:01.000Z",
        startedAt: "2026-03-12T00:00:01.000Z",
        completedAt: null,
      },
    }));
    agent.tools.spawn_worker.execute = runtimeSpawn;

    try {
      agent.injectMessage("Kick off planning.");
      await agent.processBatch();
      await agent.processBatch();

      expect(runtimeSpawn).toHaveBeenCalledWith(expect.objectContaining({
        name: "planning-worker",
        dependsOn: [],
      }));
      expect(onPlanningStartupFailure).not.toHaveBeenCalled();
      expect(onCoordinatorEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "status",
        message: "The coordinator did not start the planner, so ADE is launching the required planning worker through mission control.",
      }));
      expect(onCoordinatorEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "status",
        message: "The planning agent is running. I’m waiting for its result.",
      }));
    } finally {
      agent.shutdown();
    }
  });

  it("re-drives the coordinator when a tool reports a required phase transition", async () => {
    mockState.eventBatches.push(
      [
        {
          type: "message.part.updated",
          properties: {
            part: {
              sessionID: "session-1",
              id: "tool-spawn-blocked",
              callID: "call-spawn-blocked",
              type: "tool",
              tool: "spawn_worker",
              state: {
                status: "completed",
                input: { name: "implementation-worker" },
                output: {
                  ok: false,
                  error: "Planning phase already produced a completed worker result. Call set_current_phase with phaseKey \"implementation_math\" before spawning more workers.",
                  blockedByPhaseOrdering: true,
                  phaseTransitionRequired: {
                    phaseKey: "implementation_math",
                    reason: "planning_complete",
                  },
                  requiredTool: {
                    name: "set_current_phase",
                    args: {
                      phaseKey: "implementation_math",
                      reason: "planning_complete",
                    },
                  },
                },
              },
            },
            delta: null,
          },
        },
        { type: "session.idle", properties: { sessionID: "session-1" } },
      ],
      [
        { type: "session.idle", properties: { sessionID: "session-1" } },
      ],
    );

    const agent = createTestCoordinatorAgent({ phases: [] }) as any;

    try {
      agent.injectMessage("Continue after planning.");
      await agent.processBatch();
      await agent.processBatch();

      expect(mockState.promptAsync).toHaveBeenCalledTimes(2);
      const promptCalls = mockState.promptAsync.mock.calls as any[];
      const secondPrompt = promptCalls[1]?.[0]?.body?.parts?.[0]?.text;
      expect(secondPrompt).toContain("RUNTIME CORRECTION:");
      expect(secondPrompt).toContain('call set_current_phase with phaseKey "implementation_math"');
    } finally {
      agent.shutdown();
    }
  });

  it("re-drives the coordinator when planning succeeded but the phase was not advanced", async () => {
    mockState.eventBatches.push([
      {
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "session-1",
            id: "text-post-planning",
            type: "text",
            text: 'Step: Set the current planning phase to "implementation_math" as requested.',
          },
          delta: 'Step: Set the current planning phase to "implementation_math" as requested.',
        },
      },
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ]);

    const agent = createTestCoordinatorAgent({ phases: createCustomPlanningPhases() }) as any;
    const graph = agent.__graph;
    graph.run.metadata.phaseRuntime.currentPhaseKey = "planning";
    graph.run.metadata.phaseRuntime.currentPhaseName = "Planning";
    graph.steps.push({
      id: "step-planner-succeeded",
      runId: "run-1",
      missionStepId: null,
      stepKey: "worker_planning_1",
      stepIndex: 0,
      title: "planning-worker",
      laneId: null,
      status: "succeeded",
      joinPolicy: "all_success",
      quorumCount: null,
      dependencyStepIds: [],
      retryLimit: 1,
      retryCount: 0,
      lastAttemptId: null,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:01.000Z",
      startedAt: "2026-03-12T00:00:00.000Z",
      completedAt: "2026-03-12T00:00:01.000Z",
      metadata: {
        phaseKey: "planning",
        phaseName: "Planning",
        stepType: "planning",
      },
    });

    try {
      agent.injectMessage("Planner finished; continue.");
      await agent.processBatch();

      expect(agent.eventQueue[0]?.message).toContain("RUNTIME CORRECTION:");
      expect(agent.eventQueue[0]?.message).toContain('call set_current_phase with phaseKey "implementation_math"');
    } finally {
      agent.shutdown();
    }
  });

  it("applies the required post-planning phase transition when the correction is ignored", async () => {
    mockState.eventBatches.push(
      [
        {
          type: "message.part.updated",
          properties: {
            part: {
              sessionID: "session-1",
              id: "text-post-planning",
              type: "text",
              text: 'Step: Set the current planning phase to "implementation_math" as requested.',
            },
            delta: 'Step: Set the current planning phase to "implementation_math" as requested.',
          },
        },
        { type: "session.idle", properties: { sessionID: "session-1" } },
      ],
      [
        { type: "session.idle", properties: { sessionID: "session-1" } },
      ],
    );

    const onCoordinatorEvent = vi.fn();
    const agent = createTestCoordinatorAgent({
      onCoordinatorEvent,
      phases: createCustomPlanningPhases(),
    }) as any;
    const graph = agent.__graph;
    graph.run.metadata.phaseRuntime.currentPhaseKey = "planning";
    graph.run.metadata.phaseRuntime.currentPhaseName = "Planning";
    graph.steps.push({
      id: "step-planner-succeeded",
      runId: "run-1",
      missionStepId: null,
      stepKey: "worker_planning_1",
      stepIndex: 0,
      title: "planning-worker",
      laneId: null,
      status: "succeeded",
      joinPolicy: "all_success",
      quorumCount: null,
      dependencyStepIds: [],
      retryLimit: 1,
      retryCount: 0,
      lastAttemptId: null,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:01.000Z",
      startedAt: "2026-03-12T00:00:00.000Z",
      completedAt: "2026-03-12T00:00:01.000Z",
      metadata: {
        phaseKey: "planning",
        phaseName: "Planning",
        stepType: "planning",
      },
    });
    const setCurrentPhase = vi.fn(async () => ({
      ok: true,
      changed: true,
      previousPhaseKey: "planning",
      previousPhaseName: "Planning",
      currentPhaseKey: "implementation_math",
      currentPhaseName: "Implementation math",
    }));
    agent.tools.set_current_phase.execute = setCurrentPhase;

    try {
      agent.injectMessage("Planner finished; continue.");
      await agent.processBatch();
      await agent.processBatch();

      expect(setCurrentPhase).toHaveBeenCalledWith({
        phaseKey: "implementation_math",
        reason: "planning_complete",
      });
      expect(onCoordinatorEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "status",
        message: 'The coordinator did not enter phase "implementation_math", so ADE is applying the required phase transition through mission control.',
      }));
      expect(agent.eventQueue[0]?.message).toContain("PHASE TRANSITION COMPLETE:");
    } finally {
      agent.shutdown();
    }
  });

  it("replays markdown pseudo tool calls through real coordinator tools", async () => {
    mockState.eventBatches.push([
      {
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "session-1",
            id: "text-pseudo-tools",
            type: "text",
            text: [
              "```json",
              "// multi_tool_use.parallel",
              "[",
              "  {\"name\":\"ade_spawn_worker\",\"arguments\":{\"name\":\"math-worker\",\"modelId\":\"openai/gpt-5.3-codex-spark\",\"lane\":\"lane-1\",\"prompt\":\"Implement math utilities.\",\"dependsOn\":[]}},",
              "  {\"name\":\"ade_spawn_worker\",\"arguments\":{\"name\":\"strings-worker\",\"modelId\":\"openai/gpt-5.3-codex-spark\",\"prompt\":\"Implement string utilities.\",\"dependsOn\":[]}}",
              "]",
              "```",
            ].join("\n"),
          },
          delta: [
            "```json",
            "// multi_tool_use.parallel",
            "[",
            "  {\"name\":\"ade_spawn_worker\",\"arguments\":{\"name\":\"math-worker\",\"modelId\":\"openai/gpt-5.3-codex-spark\",\"lane\":\"lane-1\",\"prompt\":\"Implement math utilities.\",\"dependsOn\":[]}},",
            "  {\"name\":\"ade_spawn_worker\",\"arguments\":{\"name\":\"strings-worker\",\"modelId\":\"openai/gpt-5.3-codex-spark\",\"prompt\":\"Implement string utilities.\",\"dependsOn\":[]}}",
            "]",
            "```",
          ].join("\n"),
        },
      },
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ]);

    const onCoordinatorEvent = vi.fn();
    const agent = createTestCoordinatorAgent({
      onCoordinatorEvent,
      phases: createCustomPlanningPhases(),
    }) as any;
    const graph = agent.__graph;
    graph.run.metadata.phaseRuntime.currentPhaseKey = "implementation_math";
    graph.run.metadata.phaseRuntime.currentPhaseName = "Implementation math";
    graph.steps.push({
      id: "step-planner-succeeded",
      runId: "run-1",
      missionStepId: null,
      stepKey: "worker_planning_1",
      stepIndex: 0,
      title: "planning-worker",
      laneId: null,
      status: "succeeded",
      joinPolicy: "all_success",
      quorumCount: null,
      dependencyStepIds: [],
      retryLimit: 1,
      retryCount: 0,
      lastAttemptId: null,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:01.000Z",
      startedAt: "2026-03-12T00:00:00.000Z",
      completedAt: "2026-03-12T00:00:01.000Z",
      metadata: {
        phaseKey: "planning",
        phaseName: "Planning",
        stepType: "planning",
      },
    });
    const spawnWorker = vi.fn(async () => ({
      ok: true,
      workerId: "worker-replayed",
      launched: true,
      stepId: "step-replayed",
    }));
    agent.tools.spawn_worker.execute = spawnWorker;

    try {
      agent.injectMessage("Continue implementation.");
      await agent.processBatch();

      expect(spawnWorker).toHaveBeenCalledTimes(2);
      expect(spawnWorker).toHaveBeenNthCalledWith(1, expect.objectContaining({
        name: "math-worker",
        laneId: "lane-1",
      }));
      expect(spawnWorker).toHaveBeenNthCalledWith(2, expect.objectContaining({
        name: "strings-worker",
      }));
      expect(onCoordinatorEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "status",
        message: "The coordinator wrote mission-control calls as text, so ADE is replaying those calls through the real mission-control tools.",
      }));
    } finally {
      agent.shutdown();
    }
  });

  it("suppresses recovered spawn_worker calls while existing workers are running", async () => {
    const onCoordinatorEvent = vi.fn();
    const agent = createTestCoordinatorAgent({
      onCoordinatorEvent,
      phases: [],
    }) as any;
    const graph = agent.__graph;
    graph.steps.push(
      {
        id: "step-running",
        runId: "run-1",
        missionStepId: null,
        stepKey: "dev_end_to_end_tests",
        stepIndex: 1,
        title: "Create end-to-end Vitest coverage",
        laneId: null,
        status: "running",
        joinPolicy: "all_success",
        quorumCount: null,
        dependencyStepIds: [],
        retryLimit: 1,
        retryCount: 0,
        lastAttemptId: null,
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:01.000Z",
        startedAt: "2026-03-12T00:00:00.000Z",
        completedAt: null,
        metadata: {
          phaseKey: "implementation_math",
          phaseName: "Implementation math",
          stepType: "implementation",
        },
      },
      {
        id: "step-pending",
        runId: "run-1",
        missionStepId: null,
        stepKey: "validation_worker",
        stepIndex: 2,
        title: "Validation worker",
        laneId: null,
        status: "pending",
        joinPolicy: "all_success",
        quorumCount: null,
        dependencyStepIds: ["step-running"],
        retryLimit: 1,
        retryCount: 0,
        lastAttemptId: null,
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:01.000Z",
        startedAt: null,
        completedAt: null,
        metadata: {
          phaseKey: "validation",
          phaseName: "Validation",
          stepType: "validation",
        },
      },
    );
    const spawnWorker = vi.fn(async () => ({
      ok: true,
      workerId: "worker-stale",
      launched: true,
      stepId: "step-stale",
    }));
    agent.tools.spawn_worker.execute = spawnWorker;

    try {
      const handled = await agent.replayRecoveredMissionControlText([
        "```json",
        "// spawn_worker",
        "{\"name\":\"Development worker\",\"prompt\":\"Continue implementation.\"}",
        "```",
      ].join("\n"), "stale-spawn-turn");

      expect(handled).toBe(1);
      expect(spawnWorker).not.toHaveBeenCalled();
      expect(onCoordinatorEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "status",
        message: "ADE ignored a recovered spawn_worker call because workers are already running and no actionable step needs a new worker.",
      }));
    } finally {
      agent.shutdown();
    }
  });

  it("skips recovered status probes while an exclusive planner delegation is active", async () => {
    const onCoordinatorEvent = vi.fn();
    const onPlanningStartupFailure = vi.fn();
    const agent = createTestCoordinatorAgent({
      onCoordinatorEvent,
      onPlanningStartupFailure,
      phases: createPlanningPhases(),
    }) as any;
    const graph = agent.__graph;
    graph.steps.push({
      id: "step-planner-recovery",
      runId: "run-1",
      missionStepId: null,
      stepKey: "worker_planning_recovery",
      stepIndex: 0,
      title: "planning-worker-recovery",
      laneId: null,
      status: "ready",
      joinPolicy: "all_success",
      quorumCount: null,
      dependencyStepIds: [],
      retryLimit: 1,
      retryCount: 0,
      lastAttemptId: null,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:01.000Z",
      startedAt: null,
      completedAt: null,
      metadata: {
        phaseKey: "planning",
        phaseName: "Planning",
        stepType: "planning",
        delegationContract: {
          schemaVersion: 1,
          contractId: "contract-planner-active",
          runId: "run-1",
          ownerKind: "coordinator",
          workerIntent: "planner",
          mode: "exclusive",
          scope: { kind: "phase", key: "phase:planning", label: "Planning" },
          phaseKey: "planning",
          status: "active",
          launchState: "waiting_on_worker",
          activeWorkerIds: ["worker_planning_recovery"],
          coordinatorCapabilities: ["observe", "run_control", "update_mission_state"],
          launchPolicy: { maxLaunchAttempts: 2 },
          failurePolicy: { retryLimit: 1, escalation: "intervention" },
          batchId: null,
          parentContractId: null,
          failure: null,
          metadata: { launched: false, launchNote: "step_queued_not_yet_started" },
          createdAt: "2026-03-12T00:00:00.000Z",
          updatedAt: "2026-03-12T00:00:01.000Z",
          startedAt: null,
          completedAt: null,
        },
      },
    });
    const sendMessage = vi.fn(async () => ({ ok: true }));
    agent.tools.send_message.execute = sendMessage;

    try {
      const executed = await agent.replayRecoveredMissionControlText([
        "```json",
        "// send_message",
        "{\"workerId\":\"worker_planning_recovery\",\"message\":\"Please hurry.\"}",
        "```",
      ].join("\n"), "manual-recovery-turn");

      expect(executed).toBe(0);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(onPlanningStartupFailure).not.toHaveBeenCalled();
      expect(onCoordinatorEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "status",
        turnStatus: "interrupted",
        message: expect.stringContaining("Planner delegation is active"),
      }));
    } finally {
      agent.shutdown();
    }
  });

  it("does not self-reprompt after recovered observation tools while workers are already running", async () => {
    const agent = createTestCoordinatorAgent({ phases: [] }) as any;
    const graph = agent.__graph;
    graph.steps.push(
      {
        id: "step-running",
        runId: "run-1",
        missionStepId: null,
        stepKey: "implementation_worker",
        stepIndex: 1,
        title: "implementation-worker",
        laneId: null,
        status: "running",
        joinPolicy: "all_success",
        quorumCount: null,
        dependencyStepIds: [],
        retryLimit: 1,
        retryCount: 0,
        lastAttemptId: null,
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:01.000Z",
        startedAt: "2026-03-12T00:00:00.000Z",
        completedAt: null,
        metadata: {
          phaseKey: "development",
          phaseName: "Development",
          stepType: "implementation",
        },
      },
      {
        id: "step-pending",
        runId: "run-1",
        missionStepId: null,
        stepKey: "testing_worker",
        stepIndex: 2,
        title: "testing-worker",
        laneId: null,
        status: "pending",
        joinPolicy: "all_success",
        quorumCount: null,
        dependencyStepIds: ["step-running"],
        retryLimit: 1,
        retryCount: 0,
        lastAttemptId: null,
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:01.000Z",
        startedAt: null,
        completedAt: null,
        metadata: {
          phaseKey: "testing",
          phaseName: "Testing",
          stepType: "testing",
        },
      },
    );
    agent.tools.list_workers.execute = vi.fn(async () => ({
      ok: true,
      workers: [{ workerId: "implementation_worker", state: "working" }],
    }));

    try {
      const executed = await agent.replayRecoveredMissionControlText([
        "```json",
        "// list_workers",
        "{}",
        "```",
      ].join("\n"), "manual-observation-turn");

      expect(executed).toBe(1);
      expect(agent.eventQueue).toEqual([]);
    } finally {
      agent.shutdown();
    }
  });

  it("keeps re-drive guidance after recovered tools when a step is actionable", async () => {
    const agent = createTestCoordinatorAgent({ phases: [] }) as any;
    const graph = agent.__graph;
    graph.steps.push(
      {
        id: "step-running",
        runId: "run-1",
        missionStepId: null,
        stepKey: "implementation_worker",
        stepIndex: 1,
        title: "implementation-worker",
        laneId: null,
        status: "running",
        joinPolicy: "all_success",
        quorumCount: null,
        dependencyStepIds: [],
        retryLimit: 1,
        retryCount: 0,
        lastAttemptId: null,
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:01.000Z",
        startedAt: "2026-03-12T00:00:00.000Z",
        completedAt: null,
        metadata: {
          phaseKey: "development",
          phaseName: "Development",
          stepType: "implementation",
        },
      },
      {
        id: "step-ready",
        runId: "run-1",
        missionStepId: null,
        stepKey: "ready_worker",
        stepIndex: 2,
        title: "ready-worker",
        laneId: null,
        status: "ready",
        joinPolicy: "all_success",
        quorumCount: null,
        dependencyStepIds: [],
        retryLimit: 1,
        retryCount: 0,
        lastAttemptId: null,
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:01.000Z",
        startedAt: null,
        completedAt: null,
        metadata: {
          phaseKey: "development",
          phaseName: "Development",
          stepType: "implementation",
        },
      },
    );
    agent.tools.list_workers.execute = vi.fn(async () => ({
      ok: true,
      workers: [{ workerId: "implementation_worker", state: "working" }],
    }));

    try {
      const executed = await agent.replayRecoveredMissionControlText([
        "```json",
        "// list_workers",
        "{}",
        "```",
      ].join("\n"), "manual-actionable-turn");

      expect(executed).toBe(1);
      expect(agent.eventQueue[0]?.message).toContain("RECOVERED TOOL CALLS EXECUTED:");
    } finally {
      agent.shutdown();
    }
  });

  it("starts the configured phase worker when an implementation phase has no executable work", async () => {
    mockState.eventBatches.push([
      {
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "session-1",
            id: "text-no-action",
            type: "text",
            text: "Implementing changes now.",
          },
          delta: "Implementing changes now.",
        },
      },
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ]);

    const onCoordinatorEvent = vi.fn();
    const agent = createTestCoordinatorAgent({
      onCoordinatorEvent,
      phases: createCustomPlanningPhases(),
    }) as any;
    const graph = agent.__graph;
    graph.run.metadata.phaseRuntime.currentPhaseKey = "implementation_math";
    graph.run.metadata.phaseRuntime.currentPhaseName = "Implementation math";
    graph.steps.push({
      id: "step-planner-succeeded",
      runId: "run-1",
      missionStepId: null,
      stepKey: "worker_planning_1",
      stepIndex: 0,
      title: "planning-worker",
      laneId: null,
      status: "succeeded",
      joinPolicy: "all_success",
      quorumCount: null,
      dependencyStepIds: [],
      retryLimit: 1,
      retryCount: 0,
      lastAttemptId: null,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:01.000Z",
      startedAt: "2026-03-12T00:00:00.000Z",
      completedAt: "2026-03-12T00:00:01.000Z",
      metadata: {
        phaseKey: "planning",
        phaseName: "Planning",
        stepType: "planning",
      },
    });
    const spawnWorker = vi.fn(async () => ({
      ok: true,
      workerId: "worker-runtime-phase",
      launched: true,
      stepId: "step-runtime-phase",
    }));
    agent.tools.spawn_worker.execute = spawnWorker;

    try {
      agent.injectMessage("Continue implementation.");
      await agent.processBatch();

      expect(spawnWorker).toHaveBeenCalledWith(expect.objectContaining({
        name: "implementation-math-worker",
        modelId: "openai/gpt-5.3-codex-spark",
        prompt: expect.stringContaining("Phase instructions:"),
      }));
      expect(onCoordinatorEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "status",
        message: 'The coordinator did not start work for phase "implementation_math", so ADE is starting the configured phase worker through mission control.',
      }));
    } finally {
      agent.shutdown();
    }
  });

  it("starts ready sibling custom phase workers while current phase work is running", async () => {
    mockState.eventBatches.push([
      {
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "session-1",
            id: "text-parallel-ready-phase",
            type: "text",
            text: "The math worker is running; continue the implementation DAG.",
          },
          delta: "The math worker is running; continue the implementation DAG.",
        },
      },
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ]);

    const phases = [
      ...createCustomPlanningPhases(),
      {
        id: "phase-implementation-strings",
        phaseKey: "implementation_strings",
        name: "Implementation strings",
        position: 2,
        instructions: "Implement string work.",
        model: { modelId: "openai/gpt-5.3-codex-spark" },
        budget: {},
        askQuestions: { enabled: false, maxQuestions: 0 },
        validationGate: { tier: "self", required: true },
        orderingConstraints: { mustFollow: ["planning"] },
        requiresApproval: false,
        isBuiltIn: false,
        isCustom: true,
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ];
    const onCoordinatorEvent = vi.fn();
    const agent = createTestCoordinatorAgent({ onCoordinatorEvent, phases }) as any;
    const graph = agent.__graph;
    graph.run.metadata.phaseRuntime.currentPhaseKey = "implementation_math";
    graph.run.metadata.phaseRuntime.currentPhaseName = "Implementation math";
    graph.steps.push(
      {
        id: "step-planner-succeeded",
        runId: "run-1",
        missionStepId: null,
        stepKey: "worker_planning_1",
        stepIndex: 0,
        title: "planning-worker",
        laneId: null,
        status: "succeeded",
        joinPolicy: "all_success",
        quorumCount: null,
        dependencyStepIds: [],
        retryLimit: 1,
        retryCount: 0,
        lastAttemptId: null,
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:01.000Z",
        startedAt: "2026-03-12T00:00:00.000Z",
        completedAt: "2026-03-12T00:00:01.000Z",
        metadata: {
          phaseKey: "planning",
          phaseName: "Planning",
          stepType: "planning",
        },
      },
      {
        id: "step-math-running",
        runId: "run-1",
        missionStepId: null,
        stepKey: "worker_implementation_math_1",
        stepIndex: 1,
        title: "implementation-math-worker",
        laneId: null,
        status: "running",
        joinPolicy: "all_success",
        quorumCount: null,
        dependencyStepIds: ["step-planner-succeeded"],
        retryLimit: 1,
        retryCount: 0,
        lastAttemptId: null,
        createdAt: "2026-03-12T00:00:01.000Z",
        updatedAt: "2026-03-12T00:00:02.000Z",
        startedAt: "2026-03-12T00:00:01.000Z",
        completedAt: null,
        metadata: {
          phaseKey: "implementation_math",
          phaseName: "Implementation math",
          stepType: "implementation",
        },
      },
    );

    try {
      agent.injectMessage("Keep going.");
      await agent.processBatch();

      const stringStep = graph.steps.find((step: any) => step.metadata?.phaseKey === "implementation_strings");
      expect(stringStep).toEqual(expect.objectContaining({
        title: "implementation-strings-worker",
        executorKind: "codex",
      }));
      expect(stringStep?.metadata).toEqual(expect.objectContaining({
        modelId: "openai/gpt-5.3-codex-spark",
        modelProviderHint: "codex",
        workerName: "implementation-strings-worker",
      }));
      expect((agent as any).deps.orchestratorService.startReadyAutopilotAttempts).toHaveBeenCalledWith(expect.objectContaining({
        runId: "run-1",
        reason: "ready_phase_parallel_runtime_spawn",
      }));
      expect(onCoordinatorEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "status",
        message: 'ADE is starting ready phase "implementation_strings" in parallel because its phase dependencies are satisfied.',
      }));
    } finally {
      agent.shutdown();
    }
  });

  it("records self-validation from a successful worker result before advancing phases", async () => {
    mockState.eventBatches.push([
      {
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "session-1",
            id: "text-self-validate",
            type: "text",
            text: "Math work is done; moving on.",
          },
          delta: "Math work is done; moving on.",
        },
      },
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ]);

    const phases = [
      ...createCustomPlanningPhases(),
      {
        id: "phase-implementation-strings",
        phaseKey: "implementation_strings",
        name: "Implementation strings",
        position: 2,
        instructions: "Implement string work.",
        model: { modelId: "openai/gpt-5.3-codex-spark" },
        budget: {},
        askQuestions: { enabled: false, maxQuestions: 0 },
        validationGate: { tier: "self", required: true },
        orderingConstraints: { mustFollow: ["implementation_math"] },
        requiresApproval: false,
        isBuiltIn: false,
        isCustom: true,
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ];
    const agent = createTestCoordinatorAgent({ phases }) as any;
    const graph = agent.__graph;
    graph.run.metadata.phaseRuntime.currentPhaseKey = "implementation_math";
    graph.run.metadata.phaseRuntime.currentPhaseName = "Implementation math";
    graph.steps.push({
      id: "step-planner-succeeded",
      runId: "run-1",
      missionStepId: null,
      stepKey: "worker_planning_1",
      stepIndex: 0,
      title: "planning-worker",
      laneId: null,
      status: "succeeded",
      joinPolicy: "all_success",
      quorumCount: null,
      dependencyStepIds: [],
      retryLimit: 1,
      retryCount: 0,
      lastAttemptId: null,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:01.000Z",
      startedAt: "2026-03-12T00:00:00.000Z",
      completedAt: "2026-03-12T00:00:01.000Z",
      metadata: {
        phaseKey: "planning",
        phaseName: "Planning",
        stepType: "planning",
      },
    }, {
      id: "step-math-succeeded",
      runId: "run-1",
      missionStepId: null,
      stepKey: "implementation-math-worker",
      stepIndex: 1,
      title: "implementation-math-worker",
      laneId: "lane-1",
      status: "succeeded",
      joinPolicy: "all_success",
      quorumCount: null,
      dependencyStepIds: [],
      retryLimit: 1,
      retryCount: 0,
      lastAttemptId: null,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:02.000Z",
      startedAt: "2026-03-12T00:00:01.000Z",
      completedAt: "2026-03-12T00:00:02.000Z",
      metadata: {
        phaseKey: "implementation_math",
        phaseName: "Implementation math",
        stepType: "implementation",
        validationContract: {
          level: "step",
          tier: "self",
          required: true,
          criteria: "Math changes must pass tests.",
          evidence: [],
          maxRetries: 2,
        },
        lastResultReport: {
          outcome: "succeeded",
          summary: "Added math helpers and tests.",
          filesChanged: ["src/math.js", "test/math.test.js"],
          testsRun: { passed: 9, failed: 0, skipped: 0 },
        },
      },
    });
    const reportValidation = vi.fn(async () => ({ ok: true }));
    const setCurrentPhase = vi.fn(async () => ({ ok: true, currentPhaseName: "Implementation strings" }));
    agent.tools.report_validation.execute = reportValidation;
    agent.tools.set_current_phase.execute = setCurrentPhase;

    try {
      agent.injectMessage("Continue implementation.");
      await agent.processBatch();

      expect(reportValidation).toHaveBeenCalledWith(expect.objectContaining({
        targetWorkerId: "implementation-math-worker",
        verdict: "pass",
        summary: expect.stringContaining("Added math helpers and tests."),
      }));
      expect(setCurrentPhase).not.toHaveBeenCalled();
    } finally {
      agent.shutdown();
    }
  });

  it("defers transient failed tests from parallel implementation self-validation to final testing", async () => {
    mockState.eventBatches.push([
      {
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "session-1",
            id: "text-self-validate-transient",
            type: "text",
            text: "String work is done; the full suite will be clean once the math sibling lands.",
          },
          delta: "String work is done; the full suite will be clean once the math sibling lands.",
        },
      },
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ]);

    const phases = [
      ...createCustomPlanningPhases(),
      {
        id: "phase-implementation-strings",
        phaseKey: "implementation_strings",
        name: "Implementation strings",
        position: 2,
        instructions: "Implement string work.",
        model: { modelId: "openai/gpt-5.3-codex-spark" },
        budget: {},
        askQuestions: { enabled: false, maxQuestions: 0 },
        validationGate: { tier: "self", required: true },
        orderingConstraints: { mustFollow: ["planning"] },
        requiresApproval: false,
        isBuiltIn: false,
        isCustom: true,
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
      {
        id: "phase-testing",
        phaseKey: "testing",
        name: "Testing",
        position: 3,
        instructions: "Run final integration tests.",
        model: { modelId: "openai/gpt-5.3-codex-spark" },
        budget: {},
        askQuestions: { enabled: false, maxQuestions: 0 },
        validationGate: { tier: "self", required: true },
        orderingConstraints: { mustFollow: ["implementation_math", "implementation_strings"] },
        requiresApproval: false,
        isBuiltIn: false,
        isCustom: true,
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ];
    const agent = createTestCoordinatorAgent({ phases }) as any;
    const graph = agent.__graph;
    graph.run.metadata.phaseRuntime.currentPhaseKey = "implementation_strings";
    graph.run.metadata.phaseRuntime.currentPhaseName = "Implementation strings";
    graph.steps.push({
      id: "step-planner-succeeded",
      runId: "run-1",
      missionStepId: null,
      stepKey: "worker_planning_1",
      stepIndex: 0,
      title: "planning-worker",
      laneId: null,
      status: "succeeded",
      joinPolicy: "all_success",
      quorumCount: null,
      dependencyStepIds: [],
      retryLimit: 1,
      retryCount: 0,
      lastAttemptId: null,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:01.000Z",
      startedAt: "2026-03-12T00:00:00.000Z",
      completedAt: "2026-03-12T00:00:01.000Z",
      metadata: {
        phaseKey: "planning",
        phaseName: "Planning",
        stepType: "planning",
      },
    }, {
      id: "step-strings-succeeded",
      runId: "run-1",
      missionStepId: null,
      stepKey: "implementation-strings-worker",
      stepIndex: 2,
      title: "implementation-strings-worker",
      laneId: "lane-1",
      status: "succeeded",
      joinPolicy: "all_success",
      quorumCount: null,
      dependencyStepIds: [],
      retryLimit: 1,
      retryCount: 0,
      lastAttemptId: null,
      createdAt: "2026-03-12T00:00:01.000Z",
      updatedAt: "2026-03-12T00:00:02.000Z",
      startedAt: "2026-03-12T00:00:01.000Z",
      completedAt: "2026-03-12T00:00:02.000Z",
      metadata: {
        phaseKey: "implementation_strings",
        phaseName: "Implementation strings",
        stepType: "implementation",
        validationContract: {
          level: "step",
          tier: "self",
          required: true,
          criteria: "String changes must pass final tests.",
          evidence: [],
          maxRetries: 2,
        },
        lastResultReport: {
          outcome: "succeeded",
          summary: "Added string helpers; the remaining failure is from the parallel math phase.",
          filesChanged: ["src/strings.js", "test/strings.test.js"],
          testsRun: { passed: 9, failed: 1, skipped: 0 },
        },
      },
    });
    const reportValidation = vi.fn(async () => ({ ok: true }));
    agent.tools.report_validation.execute = reportValidation;

    try {
      agent.injectMessage("Continue implementation.");
      await agent.processBatch();

      expect(reportValidation).toHaveBeenCalledWith(expect.objectContaining({
        targetWorkerId: "implementation-strings-worker",
        verdict: "pass",
        summary: expect.stringContaining("deferred to the final validation phase"),
        findings: [expect.objectContaining({ code: "integration_tests_deferred" })],
      }));
    } finally {
      agent.shutdown();
    }
  });

  it("does not advance a phase while a succeeded step still needs required validation", async () => {
    mockState.eventBatches.push([
      {
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "session-1",
            id: "text-dedicated-validation",
            type: "text",
            text: "Implementation is complete; moving to strings.",
          },
          delta: "Implementation is complete; moving to strings.",
        },
      },
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ]);

    const phases = [
      ...createCustomPlanningPhases(),
      {
        id: "phase-implementation-strings",
        phaseKey: "implementation_strings",
        name: "Implementation strings",
        position: 2,
        instructions: "Implement string work.",
        model: { modelId: "openai/gpt-5.3-codex-spark" },
        budget: {},
        askQuestions: { enabled: false, maxQuestions: 0 },
        validationGate: { tier: "self", required: true },
        orderingConstraints: { mustFollow: ["implementation_math"] },
        requiresApproval: false,
        isBuiltIn: false,
        isCustom: true,
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ];
    const agent = createTestCoordinatorAgent({ phases }) as any;
    const graph = agent.__graph;
    graph.run.metadata.phaseRuntime.currentPhaseKey = "implementation_math";
    graph.run.metadata.phaseRuntime.currentPhaseName = "Implementation math";
    graph.steps.push({
      id: "step-planner-succeeded",
      runId: "run-1",
      missionStepId: null,
      stepKey: "worker_planning_1",
      stepIndex: 0,
      title: "planning-worker",
      laneId: null,
      status: "succeeded",
      joinPolicy: "all_success",
      quorumCount: null,
      dependencyStepIds: [],
      retryLimit: 1,
      retryCount: 0,
      lastAttemptId: null,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:01.000Z",
      startedAt: "2026-03-12T00:00:00.000Z",
      completedAt: "2026-03-12T00:00:01.000Z",
      metadata: {
        phaseKey: "planning",
        phaseName: "Planning",
        stepType: "planning",
      },
    }, {
      id: "step-math-needs-validator",
      runId: "run-1",
      missionStepId: null,
      stepKey: "implementation-math-worker",
      stepIndex: 1,
      title: "implementation-math-worker",
      laneId: "lane-1",
      status: "succeeded",
      joinPolicy: "all_success",
      quorumCount: null,
      dependencyStepIds: [],
      retryLimit: 1,
      retryCount: 0,
      lastAttemptId: null,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:02.000Z",
      startedAt: "2026-03-12T00:00:01.000Z",
      completedAt: "2026-03-12T00:00:02.000Z",
      metadata: {
        phaseKey: "implementation_math",
        phaseName: "Implementation math",
        stepType: "implementation",
        validationContract: {
          level: "step",
          tier: "dedicated",
          required: true,
          criteria: "Dedicated validation must pass.",
          evidence: [],
          maxRetries: 2,
        },
        lastResultReport: {
          outcome: "succeeded",
          summary: "Added math helpers and tests.",
          testsRun: { passed: 9, failed: 0, skipped: 0 },
        },
      },
    });
    const setCurrentPhase = vi.fn(async () => ({ ok: true, currentPhaseName: "Implementation strings" }));
    agent.tools.set_current_phase.execute = setCurrentPhase;

    try {
      agent.injectMessage("Continue implementation.");
      await agent.processBatch();

      expect(setCurrentPhase).not.toHaveBeenCalled();
    } finally {
      agent.shutdown();
    }
  });

  it("calls complete_mission when the final configured phase is terminal and validated", async () => {
    mockState.eventBatches.push([
      {
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "session-1",
            id: "text-final-phase-complete",
            type: "text",
            text: "Closeout is done.",
          },
          delta: "Closeout is done.",
        },
      },
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ]);

    const phases = [
      ...createCustomPlanningPhases(),
      {
        id: "phase-closeout",
        phaseKey: "closeout",
        name: "Closeout",
        position: 2,
        instructions: "Summarize the completed lane and tests.",
        model: { modelId: "openai/gpt-5.3-codex-spark" },
        budget: {},
        askQuestions: { enabled: false, maxQuestions: 0 },
        validationGate: { tier: "self", required: true },
        orderingConstraints: { mustFollow: ["implementation_math"] },
        requiresApproval: false,
        isBuiltIn: false,
        isCustom: true,
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ];
    const agent = createTestCoordinatorAgent({ phases }) as any;
    const graph = agent.__graph;
    graph.run.metadata.phaseRuntime.currentPhaseKey = "closeout";
    graph.run.metadata.phaseRuntime.currentPhaseName = "Closeout";
    graph.steps.push(
      {
        id: "step-planner-succeeded",
        runId: "run-1",
        missionStepId: null,
        stepKey: "worker_planning_1",
        stepIndex: 0,
        title: "planning-worker",
        laneId: null,
        status: "succeeded",
        joinPolicy: "all_success",
        quorumCount: null,
        dependencyStepIds: [],
        retryLimit: 1,
        retryCount: 0,
        lastAttemptId: null,
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:01.000Z",
        startedAt: "2026-03-12T00:00:00.000Z",
        completedAt: "2026-03-12T00:00:01.000Z",
        metadata: {
          phaseKey: "planning",
          phaseName: "Planning",
          stepType: "planning",
        },
      },
      {
        id: "step-impl-succeeded",
        runId: "run-1",
        missionStepId: null,
        stepKey: "implementation-math-worker",
        stepIndex: 1,
        title: "implementation-math-worker",
        laneId: "lane-1",
        status: "succeeded",
        joinPolicy: "all_success",
        quorumCount: null,
        dependencyStepIds: [],
        retryLimit: 1,
        retryCount: 0,
        lastAttemptId: null,
        createdAt: "2026-03-12T00:00:01.000Z",
        updatedAt: "2026-03-12T00:00:02.000Z",
        startedAt: "2026-03-12T00:00:01.000Z",
        completedAt: "2026-03-12T00:00:02.000Z",
        metadata: {
          phaseKey: "implementation_math",
          phaseName: "Implementation math",
          stepType: "implementation",
          validationContract: {
            level: "step",
            tier: "self",
            required: true,
            criteria: "Implementation must pass.",
            evidence: [],
            maxRetries: 2,
          },
          validationState: "pass",
          lastValidationReport: { verdict: "pass" },
          validationPassedAt: "2026-03-12T00:00:02.000Z",
          lastResultReport: {
            outcome: "succeeded",
            summary: "Implemented the requested utility.",
          },
        },
      },
      {
        id: "step-closeout-succeeded",
        runId: "run-1",
        missionStepId: null,
        stepKey: "closeout-worker",
        stepIndex: 2,
        title: "closeout-worker",
        laneId: "lane-1",
        status: "succeeded",
        joinPolicy: "all_success",
        quorumCount: null,
        dependencyStepIds: [],
        retryLimit: 1,
        retryCount: 0,
        lastAttemptId: null,
        createdAt: "2026-03-12T00:00:02.000Z",
        updatedAt: "2026-03-12T00:00:03.000Z",
        startedAt: "2026-03-12T00:00:02.000Z",
        completedAt: "2026-03-12T00:00:03.000Z",
        metadata: {
          phaseKey: "closeout",
          phaseName: "Closeout",
          stepType: "implementation",
          validationContract: {
            level: "step",
            tier: "self",
            required: true,
            criteria: "Closeout must summarize the lane.",
            evidence: [],
            maxRetries: 2,
          },
          validationState: "pass",
          lastValidationReport: { verdict: "pass" },
          validationPassedAt: "2026-03-12T00:00:03.000Z",
          lastResultReport: {
            outcome: "succeeded",
            summary: "Closeout verified the lane and npm test passed.",
          },
        },
      },
    );
    const completeMission = vi.fn(async () => ({ ok: true, runId: "run-1", finalStatus: "succeeded" }));
    agent.tools.complete_mission.execute = completeMission;

    try {
      agent.injectMessage("Finalize if ready.");
      await agent.processBatch();

      expect(completeMission).toHaveBeenCalledWith({
        summary: "Closeout verified the lane and npm test passed.",
      });
    } finally {
      agent.shutdown();
    }
  });

  it("does not call complete_mission while final phase validation is still pending", async () => {
    mockState.eventBatches.push([
      {
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "session-1",
            id: "text-final-phase-validation-pending",
            type: "text",
            text: "Closeout is waiting on validation.",
          },
          delta: "Closeout is waiting on validation.",
        },
      },
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ]);

    const phases = [
      ...createCustomPlanningPhases(),
      {
        id: "phase-closeout",
        phaseKey: "closeout",
        name: "Closeout",
        position: 2,
        instructions: "Summarize the completed lane and tests.",
        model: { modelId: "openai/gpt-5.3-codex-spark" },
        budget: {},
        askQuestions: { enabled: false, maxQuestions: 0 },
        validationGate: { tier: "dedicated", required: true },
        orderingConstraints: { mustFollow: ["implementation_math"] },
        requiresApproval: false,
        isBuiltIn: false,
        isCustom: true,
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ];
    const agent = createTestCoordinatorAgent({ phases }) as any;
    const graph = agent.__graph;
    graph.run.metadata.phaseRuntime.currentPhaseKey = "closeout";
    graph.run.metadata.phaseRuntime.currentPhaseName = "Closeout";
    graph.steps.push({
      id: "step-closeout-succeeded",
      runId: "run-1",
      missionStepId: null,
      stepKey: "closeout-worker",
      stepIndex: 0,
      title: "closeout-worker",
      laneId: "lane-1",
      status: "succeeded",
      joinPolicy: "all_success",
      quorumCount: null,
      dependencyStepIds: [],
      retryLimit: 1,
      retryCount: 0,
      lastAttemptId: null,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:01.000Z",
      startedAt: "2026-03-12T00:00:00.000Z",
      completedAt: "2026-03-12T00:00:01.000Z",
      metadata: {
        phaseKey: "closeout",
        phaseName: "Closeout",
        stepType: "implementation",
        validationContract: {
          level: "step",
          tier: "dedicated",
          required: true,
          criteria: "Closeout needs dedicated validation.",
          evidence: [],
          maxRetries: 2,
        },
        lastResultReport: {
          outcome: "succeeded",
          summary: "Closeout wrote the summary.",
        },
      },
    });
    const completeMission = vi.fn(async () => ({ ok: true, runId: "run-1", finalStatus: "succeeded" }));
    agent.tools.complete_mission.execute = completeMission;

    try {
      agent.injectMessage("Do not finalize until validation passes.");
      await agent.processBatch();

      expect(completeMission).not.toHaveBeenCalled();
    } finally {
      agent.shutdown();
    }
  });

  it("releases idle coordinator sessions without shutting the agent down", async () => {
    vi.useFakeTimers();
    mockState.eventBatches.push([
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ]);

    const agent = createTestCoordinatorAgent() as any;

    try {
      const initialStartCalls = vi.mocked(startOpenCodeSession).mock.calls.length;
      agent.injectMessage("Start planning.");
      await vi.advanceTimersByTimeAsync(250);

      const afterFirstBatchCalls = vi.mocked(startOpenCodeSession).mock.calls.length;
      expect(afterFirstBatchCalls).toBeGreaterThan(initialStartCalls);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(mockState.close.mock.calls.length).toBeGreaterThan(0);

      expect(agent.isAlive).toBe(true);
    } finally {
      agent.shutdown();
      vi.useRealTimers();
    }
  });

  it("releases paused OpenCode coordinator sessions when the idle timer fires", async () => {
    vi.useFakeTimers();
    const agent = createTestCoordinatorAgent({
      runStatus: "paused",
    }) as any;

    try {
      const handle = await agent.ensureOpenCodeCoordinatorSession();
      expect(handle.setEvictionHandler).toHaveBeenCalledWith(expect.any(Function));

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(handle.setEvictionHandler).toHaveBeenCalledWith(null);
      expect(handle.setBusy).toHaveBeenCalledWith(false);
      expect(handle.close).toHaveBeenCalledWith("paused_run");
    } finally {
      agent.shutdown();
      vi.useRealTimers();
    }
  });

  it("maps an attach_failed eviction reason to handle_close when releasing the coordinator session", async () => {
    const agent = createTestCoordinatorAgent() as any;

    try {
      const handle = await agent.ensureOpenCodeCoordinatorSession();
      const evictionHandler = (handle.setEvictionHandler as any).mock.calls[0]?.[0] as ((reason: string) => void) | undefined;
      expect(evictionHandler).toBeTypeOf("function");

      evictionHandler?.("attach_failed");

      expect(handle.close).toHaveBeenCalledWith("handle_close");
      expect(handle.close).not.toHaveBeenCalledWith("attach_failed");
    } finally {
      agent.shutdown();
    }
  });

  it("keeps OpenCode eviction handlers bound to the handle instance that registered them", async () => {
    const agent = createTestCoordinatorAgent() as any;

    try {
      const firstHandle = await agent.ensureOpenCodeCoordinatorSession();
      const firstEvictionHandler = (firstHandle.setEvictionHandler as any).mock.calls[0]?.[0] as ((reason: string) => void) | undefined;
      expect(firstEvictionHandler).toBeTypeOf("function");

      (agent as any).releaseOpenCodeCoordinatorSession("handle_close");
      const secondHandle = await agent.ensureOpenCodeCoordinatorSession();
      const secondCloseCallCount = secondHandle.close.mock.calls.length;

      firstEvictionHandler?.("error");

      expect(secondHandle.close.mock.calls.length).toBe(secondCloseCallCount);
      expect(firstHandle.close).toHaveBeenCalledWith("handle_close");
    } finally {
      agent.shutdown();
    }
  });

  it("runs GPT-5.5 coordinators through the shared agent chat runtime", async () => {
    const initialStartCalls = vi.mocked(startOpenCodeSession).mock.calls.length;
    const createSession = vi.fn(async () => ({ id: "chat-coordinator-1" }));
    const runSessionTurn = vi.fn(async (_args: any) => ({ outputText: "Coordinator acknowledged." }));
    const interrupt = vi.fn(async () => undefined);
    const dispose = vi.fn(async () => undefined);
    const onCoordinatorChatSessionStarted = vi.fn();
    const onCoordinatorChatRuntimeTurnStarted = vi.fn();
    const onCoordinatorChatRuntimeTurnFinished = vi.fn();
    const agent = createTestCoordinatorAgent({
      modelId: "openai/gpt-5.5",
      missionLaneId: "lane-mission-1",
      coordinatorReasoningEffort: "low",
      onCoordinatorChatSessionStarted,
      onCoordinatorChatRuntimeTurnStarted,
      onCoordinatorChatRuntimeTurnFinished,
      agentChatService: {
        createSession,
        runSessionTurn,
        interrupt,
        dispose,
      },
    }) as any;

    try {
      agent.injectMessage("Start the mission with the selected model.");
      await agent.processBatch();

      expect(vi.mocked(startOpenCodeSession).mock.calls.length).toBe(initialStartCalls);
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-mission-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
        title: "Mission coordinator",
        sessionProfile: "workflow",
        surface: "mission",
        reasoningEffort: "low",
        permissionMode: "plan",
      }));
      expect(onCoordinatorChatSessionStarted).toHaveBeenCalledWith({
        sessionId: "chat-coordinator-1",
        missionId: "mission-1",
        runId: "run-1",
        laneId: "lane-mission-1",
      });
      expect(onCoordinatorChatRuntimeTurnStarted).toHaveBeenCalledWith({
        sessionId: "chat-coordinator-1",
        missionId: "mission-1",
        runId: "run-1",
        laneId: "lane-mission-1",
      });
      expect(onCoordinatorChatRuntimeTurnFinished).toHaveBeenCalledWith({
        sessionId: "chat-coordinator-1",
        missionId: "mission-1",
        runId: "run-1",
        laneId: "lane-mission-1",
      });
      expect(runSessionTurn).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "chat-coordinator-1",
        displayText: "ADE coordinator start: initialize the mission.",
        reasoningEffort: "low",
        text: expect.stringContaining("ADE Mission-Control Tool Transport"),
      }));
      expect(runSessionTurn.mock.calls[0]?.[0]?.text).toContain("Start the mission with the selected model.");
    } finally {
      agent.shutdown();
    }
  });

  it("replays chat-runtime fenced mission-control calls and keeps recovery guidance transport-aware", async () => {
    const createSession = vi.fn(async () => ({ id: "chat-coordinator-1" }));
    const runSessionTurn = vi.fn(async (_args: any) => ({
      outputText: [
        "```json",
        "// read_mission_status",
        "{}",
        "```",
      ].join("\n"),
    }));
    const agent = createTestCoordinatorAgent({
      modelId: "openai/gpt-5.5",
      missionLaneId: "lane-mission-1",
      agentChatService: {
        createSession,
        runSessionTurn,
        interrupt: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
      },
    }) as any;
    const readMissionStatus = vi.fn(async () => ({ ok: true, status: "active" }));
    agent.tools.read_mission_status.execute = readMissionStatus;

    try {
      agent.injectMessage("Call read_mission_status immediately after resume.");
      await agent.processBatch();

      expect(readMissionStatus).toHaveBeenCalledTimes(1);
      expect(runSessionTurn.mock.calls[0]?.[0]?.text).toContain(
        "do not report that tools are unavailable",
      );
      expect(agent.eventQueue[0]?.message).toContain(
        "Recovered tool outputs:",
      );
      expect(agent.eventQueue[0]?.message).toContain(
        '"status":"active"',
      );
      expect(agent.eventQueue[0]?.message).toContain(
        "Do not repeat the same read-only status probes",
      );
      expect(agent.eventQueue[0]?.message).not.toContain(
        "Do not describe tool calls in markdown/code fences",
      );
    } finally {
      agent.shutdown();
    }
  });

  it("replays recovered skip_step calls that use stepKey or stepId aliases", async () => {
    const agent = createTestCoordinatorAgent() as any;
    const graph = agent.__graph;
    graph.steps.push({
      id: "step-validation",
      runId: "run-1",
      missionStepId: null,
      stepKey: "validate-mission-output",
      stepIndex: 1,
      title: "Validate mission output",
      laneId: null,
      status: "failed",
      joinPolicy: "all_success",
      quorumCount: null,
      dependencyStepIds: [],
      retryLimit: 1,
      retryCount: 1,
      lastAttemptId: null,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:01.000Z",
      startedAt: "2026-03-12T00:00:00.000Z",
      completedAt: "2026-03-12T00:00:01.000Z",
      metadata: {},
    });

    try {
      const executed = await agent.replayRecoveredMissionControlText([
        "```json",
        "// skip_step",
        "{\"stepKey\":\"validate-mission-output\",\"reason\":\"stale validation worker already covered\"}",
        "```",
      ].join("\n"), "turn-skip-alias");

      expect(executed).toBe(1);
      expect(graph.steps.find((step: { stepKey: string }) => step.stepKey === "validate-mission-output")?.status).toBe("skipped");
      expect(agent.eventQueue[0]?.message).toContain('"newStatus":"skipped"');
    } finally {
      agent.shutdown();
    }
  });

  it("recovers a startup spawn_worker block whose prompt contains nested markdown fences", async () => {
    const agent = createTestCoordinatorAgent({ phases: createPlanningPhases() }) as any;
    const getProjectContext = vi.fn(async () => ({ ok: true, projectRoot: "./" }));
    const spawnWorker = vi.fn(async () => ({
      ok: true,
      workerId: "worker-nested-fence-planner",
      launched: true,
      stepId: "step-nested-fence-planner",
      delegationContract: {
        schemaVersion: 1,
        contractId: "contract-nested-fence-planner",
        runId: "run-1",
        ownerKind: "coordinator",
        workerIntent: "planner",
        mode: "exclusive",
        scope: { kind: "phase", key: "phase:planning", label: "Planning" },
        phaseKey: "planning",
        status: "active",
        launchState: "waiting_on_worker",
        activeWorkerIds: ["worker-nested-fence-planner"],
        coordinatorCapabilities: ["observe", "run_control", "update_mission_state"],
        launchPolicy: { maxLaunchAttempts: 2 },
        failurePolicy: { retryLimit: 1, escalation: "intervention" },
        batchId: null,
        parentContractId: null,
        failure: null,
        metadata: {},
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:01.000Z",
        startedAt: "2026-03-12T00:00:01.000Z",
        completedAt: null,
      },
    }));
    agent.tools.get_project_context.execute = getProjectContext;
    agent.tools.spawn_worker.execute = spawnWorker;

    try {
      const spawnArgs = {
        laneId: "lane-1",
        modelId: "openai/gpt-5.5",
        phase: "planning",
        readOnly: true,
        prompt: [
          "Plan this implementation.",
          "```ts",
          "function example(): string { return \"ok\"; }",
          "```",
        ].join("\n"),
      };
      const executed = await agent.replayRecoveredMissionControlText([
        "```json",
        "// get_project_context",
        "{\"includeFileTree\":true}",
        "```",
        "",
        "```json",
        "// spawn_worker",
        JSON.stringify(spawnArgs, null, 2),
        "```",
      ].join("\n"), "turn-nested-fence-startup");

      expect(executed).toBe(2);
      expect(getProjectContext).toHaveBeenCalledTimes(1);
      expect(spawnWorker).toHaveBeenCalledTimes(1);
      expect(spawnWorker).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-1",
        modelId: "openai/gpt-5.5",
        prompt: expect.stringContaining("```ts"),
      }));
    } finally {
      agent.shutdown();
    }
  });

  it("starts the OpenCode coordinator through the shared runtime lease", async () => {
    mockState.eventBatches.push([
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ]);

    const agent = createTestCoordinatorAgent({
      phases: createPlanningPhases(),
    }) as any;

    try {
      agent.injectMessage("Start planning.");
      await agent.processBatch();

      const startCalls = vi.mocked(startOpenCodeSession).mock.calls;
      expect(startCalls.length).toBeGreaterThan(0);
      expect(startCalls[0]?.[0]?.leaseKind).toBe("shared");
      expect(Object.keys(startCalls[0]?.[0] ?? {}).sort()).toEqual(expect.arrayContaining(["directory", "leaseKind", "ownerId", "ownerKind"]));
      expect(mockState.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          agent: "ade-plan",
          tools: expect.objectContaining({ task: false }),
          parts: [expect.objectContaining({
            text: expect.stringContaining("PLANNING STARTUP REQUIRED"),
          })],
        }),
      }));
    } finally {
      agent.shutdown();
    }
  });
});
