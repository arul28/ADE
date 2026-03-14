import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamText } from "ai";
import { buildCoordinatorCliOptions, CoordinatorAgent, shouldUseSdkTools } from "./coordinatorAgent";
import { buildCoordinatorMcpAllowedTools } from "./coordinatorTools";

vi.mock("ai", () => ({
  streamText: vi.fn(),
  stepCountIs: vi.fn(() => () => false),
  tool: vi.fn((definition: unknown) => definition),
}));

vi.mock("../ai/providerResolver", () => ({
  resolveModel: vi.fn(async () => ({ provider: "mock-sdk-model" })),
}));

vi.mock("../ai/authDetector", () => ({
  detectAllAuth: vi.fn(async () => []),
}));

const streamTextMock = vi.mocked(streamText);

function makeFullStream(parts: any[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const part of parts) {
        yield part;
      }
    },
  };
}

function createStreamResult(parts: any[]): ReturnType<typeof streamText> {
  return {
    fullStream: makeFullStream(parts),
    textStream: makeFullStream([]),
    response: Promise.resolve({ messages: [] }),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
  } as unknown as ReturnType<typeof streamText>;
}

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
  missionInterventions?: Array<{ metadata_json: string | null }>;
  onCoordinatorEvent?: (event: any) => void;
  onPlanningStartupFailure?: (failure: any) => void;
  phases?: any[];
  runStatus?: string;
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
    modelId: "anthropic/claude-sonnet-4-6",
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
      all: vi.fn((sql: string) => {
        if (sql.includes("from mission_interventions")) {
          return args?.missionInterventions ?? [];
        }
        return [];
      }),
      run: vi.fn((sql: string, params?: any[]) => {
        if (!sql.includes("update orchestrator_steps") || !Array.isArray(params)) return null;
        const [status, metadataJson, updatedAt, startedAt, completedAt, stepId] = params;
        const step = graph.steps.find((entry) => entry.id === stepId);
        if (!step) return null;
        step.status = status;
        step.metadata = typeof metadataJson === "string" ? JSON.parse(metadataJson) : metadataJson;
        step.updatedAt = updatedAt;
        step.startedAt = startedAt;
        step.completedAt = completedAt;
        return null;
      }),
    } as any,
    projectId: "project-1",
    projectRoot: "/tmp/ade-project",
    workspaceRoot: "/tmp/ade-worktree",
    missionService: {
      get: vi.fn(() => ({ interventions: [] })),
    } as any,
    onDagMutation: vi.fn(),
    onCoordinatorEvent: args?.onCoordinatorEvent,
    onPlanningStartupFailure: args?.onPlanningStartupFailure,
    phases: args?.phases,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

beforeEach(() => {
  streamTextMock.mockReset();
});

describe("shouldUseSdkTools", () => {
  it("keeps SDK tools enabled for Codex CLI models", () => {
    expect(shouldUseSdkTools("openai/gpt-5.3-codex")).toBe(true);
  });

  it("disables SDK tools for Claude CLI models", () => {
    expect(shouldUseSdkTools("anthropic/claude-sonnet-4-6")).toBe(false);
  });

  it("keeps SDK tools enabled for direct API models", () => {
    expect(shouldUseSdkTools("anthropic/claude-sonnet-4-6-api")).toBe(true);
  });
});

describe("buildCoordinatorCliOptions", () => {
  it("includes coordinator observation tools in the Claude allowlist", () => {
    const allowlist = buildCoordinatorMcpAllowedTools("ade");
    expect(allowlist).toEqual(expect.arrayContaining([
      "mcp__ade__get_run_graph",
      "mcp__ade__get_step_output",
      "mcp__ade__get_timeline",
      "mcp__ade__stream_events",
      "mcp__ade__memory_search",
      "mcp__ade__memory_add",
    ]));
  });

  it("configures Claude coordinators for headless MCP execution", () => {
    const cli = buildCoordinatorCliOptions({
      modelId: "anthropic/claude-sonnet-4-6",
      projectRoot: "/tmp/ade-project",
      runId: "run-123",
      mcpServers: {
        ade: {
          command: "node",
          args: ["/tmp/mcp-server.js"],
        },
      },
    });

    expect(cli).toEqual({
      mcpServers: {
        ade: {
          command: "node",
          args: ["/tmp/mcp-server.js"],
        },
      },
      claude: {
        permissionMode: "plan",
        allowedTools: buildCoordinatorMcpAllowedTools("ade"),
        settingSources: [],
        debugFile: "/tmp/ade-project/.ade/transcripts/logs/coordinator-run-123.claude.log",
      },
    });
  });

  it("does not inject Claude-only settings for Codex coordinators", () => {
    const cli = buildCoordinatorCliOptions({
      modelId: "openai/gpt-5.3-codex",
      projectRoot: "/tmp/ade-project",
      runId: "run-456",
      mcpServers: {
        ade: {
          command: "node",
          args: ["/tmp/mcp-server.js"],
        },
      },
    });

    expect(cli).toEqual({
      mcpServers: {
        ade: {
          command: "node",
          args: ["/tmp/mcp-server.js"],
        },
      },
    });
  });
});

describe("CoordinatorAgent planning clarification gating", () => {
  it("ignores runtime event polling while a planning clarification is open", () => {
    const agent = createTestCoordinatorAgent({
      missionInterventions: [
        {
          metadata_json: JSON.stringify({ source: "ask_user", phase: "planning" }),
        },
      ],
    }) as any;

    agent.injectEvent({
      type: "status_report",
      runId: "run-1",
    } as any, "scheduler tick");

    expect(agent.eventQueue).toHaveLength(0);
    agent.shutdown();
  });

  it("still accepts direct user messages while a planning clarification is open", () => {
    const agent = createTestCoordinatorAgent({
      missionInterventions: [
        {
          metadata_json: JSON.stringify({ source: "ask_user", phase: "planning" }),
        },
      ],
    }) as any;

    agent.injectMessage("Place the tab in the main navigation group.");

    expect(agent.eventQueue).toHaveLength(1);
    agent.shutdown();
  });
});

describe("CoordinatorAgent planning-startup guardrails", () => {
  it("retries planner launch once on transient provider failures, then surfaces structured failure", async () => {
    streamTextMock
      .mockImplementationOnce(() =>
        createStreamResult([
          { type: "tool-call", toolName: "spawn_worker", input: { name: "planner" }, toolCallId: "tool-1" },
          { type: "tool-error", toolName: "spawn_worker", error: new Error("Model provider timeout"), toolCallId: "tool-1" },
        ]))
      .mockImplementationOnce(() =>
        createStreamResult([
          { type: "tool-call", toolName: "spawn_worker", input: { name: "planner" }, toolCallId: "tool-2" },
          { type: "tool-error", toolName: "spawn_worker", error: new Error("Model provider timeout"), toolCallId: "tool-2" },
        ]));

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

      expect(streamTextMock).toHaveBeenCalledTimes(2);
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
      expect(agent.planningStartupState).toBe("failed");
      expect(agent.eventQueue).toHaveLength(0);
    } finally {
      agent.shutdown();
    }
  });

  it("blocks coordinator repo exploration after planner launch and opens explicit recovery", async () => {
    streamTextMock.mockImplementationOnce(() =>
      createStreamResult([
        { type: "tool-call", toolName: "spawn_worker", input: { name: "planner" }, toolCallId: "tool-1" },
        {
          type: "tool-result",
          toolName: "spawn_worker",
          output: { ok: true, launched: true, stepId: "planner-step-1" },
          toolCallId: "tool-1",
        },
        {
          type: "tool-call",
          toolName: "read_file",
          input: { path: "apps/desktop/src/App.tsx" },
          toolCallId: "tool-2",
        },
      ]));

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

      await waitFor(() => onPlanningStartupFailure.mock.calls.length === 1);

      expect(onCoordinatorEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "status",
        message: "The planning agent is running. I’m waiting for its result.",
      }));
      expect(onPlanningStartupFailure).toHaveBeenCalledWith(expect.objectContaining({
        category: "native_tool_violation",
        toolName: "read_file",
        interventionType: "policy_block",
        recoveryOptions: ["cancel_run"],
      }));
      expect(agent.planningStartupState).toBe("failed");
    } finally {
      agent.shutdown();
    }
  });
});
