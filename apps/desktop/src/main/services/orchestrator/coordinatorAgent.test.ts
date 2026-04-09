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

function createTestCoordinatorAgent(args?: {
  onCoordinatorEvent?: (event: any) => void;
  onPlanningStartupFailure?: (failure: any) => void;
  onCoordinatorRuntimeFailure?: (failure: any) => void;
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

  return new CoordinatorAgent({
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
      appendTimelineEvent: vi.fn(),
      emitRuntimeUpdate: vi.fn(),
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
    projectConfigService: {
      get: vi.fn(() => ({ effective: { ai: {} } })),
    } as any,
    onDagMutation: vi.fn(),
    onCoordinatorEvent: args?.onCoordinatorEvent,
    onPlanningStartupFailure: args?.onPlanningStartupFailure,
    onCoordinatorRuntimeFailure: args?.onCoordinatorRuntimeFailure,
    phases: args?.phases,
  });
}

beforeEach(() => {
  mockState.eventBatches.length = 0;
  mockState.promptAsync.mockReset();
  mockState.close.mockReset();
});

describe("CoordinatorAgent", () => {
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

  it("uses project-root workspace binding for the OpenCode coordinator MCP launch", async () => {
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
      const launch = startCalls[0]?.[0]?.dynamicMcpLaunch as {
        cmdArgs?: string[];
        env?: Record<string, string>;
      };
      expect(Array.isArray(launch?.cmdArgs)).toBe(true);
      const workspaceFlagIndex = launch.cmdArgs!.indexOf("--workspace-root");
      expect(workspaceFlagIndex).toBeGreaterThanOrEqual(0);
      expect(launch.cmdArgs![workspaceFlagIndex + 1]).toBe("/tmp/ade-project");
      expect(launch.env?.ADE_WORKSPACE_ROOT).toBe("/tmp/ade-project");
      expect(launch.env?.ADE_RUN_ID).toBe("run-1");
      expect(launch.env?.ADE_MISSION_ID).toBeFalsy();
    } finally {
      agent.shutdown();
    }
  });
});
