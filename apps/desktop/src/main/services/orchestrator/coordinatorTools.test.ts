import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCoordinatorToolSet, type CoordinatorWorkerDeliveryStatus } from "./coordinatorTools";

function createTestDeps(args: {
  graph: any;
  sendWorkerMessageToSession?: (input: {
    sessionId: string;
    text: string;
    priority?: "normal" | "urgent";
  }) => Promise<CoordinatorWorkerDeliveryStatus>;
}) {
  const orchestratorService = {
    getRunGraph: vi.fn(() => args.graph),
    appendRuntimeEvent: vi.fn(),
    appendTimelineEvent: vi.fn(),
    emitRuntimeUpdate: vi.fn(),
    addReflection: vi.fn(() => ({
      id: "reflection-1",
      missionId: "mission-1",
      runId: "run-1"
    })),
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
  finalizeRunResult?: { finalized: boolean; blockers: string[]; finalStatus: string };
  missionLaneId?: string | null;
  getMissionBudgetStatus?: () => Promise<any>;
  onHardCapTriggered?: (detail: string) => void;
  onBudgetWarning?: (pressure: "warning" | "critical", detail: string) => void;
  projectRoot?: string;
}) {
  const runMetadata = {
    phaseRuntime: {
      currentPhaseModel: {
        modelId: "anthropic/claude-sonnet-4-6",
        thinkingLevel: "medium",
      },
    },
    ...(
      args.graph?.run?.metadata && typeof args.graph.run.metadata === "object" && !Array.isArray(args.graph.run.metadata)
        ? args.graph.run.metadata
        : {}
    ),
  };
  const graph = {
    run: { ...(args.graph?.run ?? {}) },
    steps: [],
    attempts: [],
    ...(args.graph ?? {}),
  };
  const graphRun = graph.run && typeof graph.run === "object" && !Array.isArray(graph.run) ? graph.run : {};
  const graphRunMetadata =
    graphRun.metadata && typeof graphRun.metadata === "object" && !Array.isArray(graphRun.metadata)
      ? graphRun.metadata
      : {};
  graph.run = {
    ...graphRun,
    metadata: {
      ...runMetadata,
      ...graphRunMetadata,
    },
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
    emitRuntimeUpdate: vi.fn(),
    finalizeRun: vi.fn(() => args.finalizeRunResult ?? {
      finalized: true,
      blockers: [],
      finalStatus: "succeeded",
    }),
    addReflection: vi.fn(() => ({
      id: "reflection-1",
      missionId: "mission-1",
      runId: "run-1"
    })),
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
    supersedeStep: vi.fn(
      ({
        stepId,
        replacementStepId,
        replacementStepKey,
      }: {
        stepId: string;
        replacementStepId?: string | null;
        replacementStepKey?: string | null;
      }) => {
        const step = graph.steps.find((entry: any) => entry.id === stepId);
        if (!step) return null;
        step.status = "superseded";
        step.metadata = {
          ...(step.metadata ?? {}),
          supersededByStepId: replacementStepId ?? null,
          supersededByStepKey: replacementStepKey ?? null,
        };
        return step;
      }
    ),
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
    projectRoot: args.projectRoot ?? "/tmp",
    onDagMutation,
    onRunFinalize: args.onRunFinalize,
    getMissionBudgetStatus: args.getMissionBudgetStatus,
    onHardCapTriggered: args.onHardCapTriggered,
    onBudgetWarning: args.onBudgetWarning,
    missionLaneId: args.missionLaneId ?? undefined,
  });

  return { tools, orchestratorService, db, graph, onDagMutation, missionService, mission, logger };
}

describe("coordinatorTools mission lane fallback", () => {
  it("uses missionLaneId when spawning workers without an explicit lane", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [],
      attempts: [],
    };
    const { tools, orchestratorService } = createCoordinatorHarness({
      graph,
      missionLaneId: "mission-lane-42",
    });

    const result = await (tools.spawn_worker as any).execute({
      name: "worker-no-lane",
      provider: "claude",
      prompt: "Do work",
      dependsOn: [],
    });

    expect(result).toMatchObject({
      ok: true,
      workerId: expect.stringContaining("worker_worker-no-lane_"),
    });
    expect(orchestratorService.addSteps).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            laneId: "mission-lane-42",
          }),
        ],
      })
    );
  });

  it("routes request_specialist workers to missionLaneId when no explicit lane is provided", async () => {
    const graph = {
      run: {
        metadata: {
          teamRuntime: {
            enabled: true,
            template: {
              roles: [
                {
                  name: "validator",
                  capabilities: ["validation"],
                }
              ]
            }
          }
        }
      },
      steps: [],
      attempts: [],
    };
    const { tools, orchestratorService } = createCoordinatorHarness({
      graph,
      missionLaneId: "mission-lane-42",
    });

    const result = await (tools.request_specialist as any).execute({
      role: "validator",
      objective: "Review implementation changes and test outcomes.",
      reason: "Need an independent validation pass.",
      dependsOn: [],
    });

    expect(result).toMatchObject({
      ok: true,
      role: "validator",
    });
    expect(orchestratorService.addSteps).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            laneId: "mission-lane-42",
          }),
        ],
      })
    );
  });
});

describe("coordinatorTools stop_worker safety", () => {
  it("rejects stop_worker calls without a cancellation reason", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [
        {
          id: "step-1",
          stepKey: "worker-1",
          stepIndex: 0,
          title: "Worker 1",
          status: "running",
          laneId: "lane-1",
          metadata: {},
        },
      ],
      attempts: [
        {
          id: "attempt-1",
          stepId: "step-1",
          status: "running",
        },
      ],
    };
    const { tools, orchestratorService } = createCoordinatorHarness({ graph });

    const result = await (tools.stop_worker as any).execute({
      workerId: "worker-1",
      reason: "   ",
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Cancellation reason is required."),
    });
    expect(orchestratorService.completeAttempt).not.toHaveBeenCalled();
  });
});

describe("coordinatorTools get_worker_output running workers", () => {
  it("warns against canceling quiet planning workers solely for lack of terminal output", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [
        {
          id: "step-1",
          runId: "run-1",
          missionStepId: null,
          stepKey: "worker_plan-test-tab_1",
          stepIndex: 0,
          title: "plan-test-tab",
          laneId: "lane-1",
          status: "running",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 0,
          retryCount: 0,
          lastAttemptId: "attempt-1",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          startedAt: "2026-03-02T00:00:00.000Z",
          completedAt: null,
          metadata: {
            phaseKey: "planning",
            stepType: "planning",
            readOnlyExecution: true,
          },
        },
      ],
      attempts: [
        {
          id: "attempt-1",
          stepId: "step-1",
          status: "running",
          createdAt: "2026-03-02T00:00:00.000Z",
        },
      ],
    };
    const { tools } = createCoordinatorHarness({ graph });

    const result = await (tools.get_worker_output as any).execute({
      workerId: "worker_plan-test-tab_1",
    });

    expect(result).toMatchObject({
      ok: true,
      status: "running",
      blockers: [],
      progressPct: null,
    });
    expect(String(result.summary)).toContain("Planning/research workers can stay quiet");
    expect(String(result.summary)).toContain("Do not cancel solely");
  });
});

describe("coordinatorTools task planning", () => {
  it("spawn_worker tolerates omitted dependsOn arrays from provider tool calls", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [],
      attempts: [],
    };
    const { tools, orchestratorService } = createCoordinatorHarness({ graph, missionLaneId: "lane-mission" });

    const result = await (tools.spawn_worker as any).execute({
      name: "Implement sidebar tab",
      modelId: "openai/gpt-5.3-codex",
      prompt: "Add the sidebar tab.",
    });

    expect(result).toMatchObject({
      ok: true,
      workerId: expect.stringContaining("worker_Implement_sidebar_tab_"),
    });
    expect(orchestratorService.addSteps).toHaveBeenCalledWith(expect.objectContaining({
      steps: [
        expect.objectContaining({
          dependencyStepKeys: [],
        }),
      ],
    }));
  });

  it("spawn_worker infers the completed planning worker as an upstream dependency when development omits dependsOn", async () => {
    const graph = {
      run: {
        metadata: {
          phaseRuntime: {
            currentPhaseKey: "development",
            currentPhaseName: "Development",
            currentPhaseModel: {
              modelId: "openai/gpt-5.3-codex",
              provider: "openai",
            },
          },
          phaseConfiguration: {
            selectedPhases: [
              {
                id: "phase-planning",
                phaseKey: "planning",
                name: "Planning",
                description: "Research",
                instructions: "",
                model: { provider: "anthropic", modelId: "anthropic/claude-sonnet-4-6" },
                budget: {},
                orderingConstraints: { mustBeFirst: true },
                askQuestions: { enabled: false, mode: "never" },
                validationGate: { tier: "self", required: true },
                isBuiltIn: true,
                isCustom: false,
                position: 1,
                createdAt: "2026-03-02T00:00:00.000Z",
                updatedAt: "2026-03-02T00:00:00.000Z",
              },
              {
                id: "phase-development",
                phaseKey: "development",
                name: "Development",
                description: "Build",
                instructions: "",
                model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
                budget: {},
                orderingConstraints: { mustFollow: ["planning"] },
                askQuestions: { enabled: false, mode: "never" },
                validationGate: { tier: "dedicated", required: false },
                isBuiltIn: true,
                isCustom: false,
                position: 2,
                createdAt: "2026-03-02T00:00:00.000Z",
                updatedAt: "2026-03-02T00:00:00.000Z",
              },
            ],
          },
        },
      },
      steps: [
        {
          id: "step-plan",
          runId: "run-1",
          missionStepId: null,
          stepKey: "worker_plan-sidebar_1",
          stepIndex: 0,
          title: "Plan sidebar work",
          laneId: "lane-mission",
          status: "succeeded",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 0,
          retryCount: 0,
          lastAttemptId: null,
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-02T00:05:00.000Z",
          startedAt: "2026-03-02T00:00:00.000Z",
          completedAt: "2026-03-02T00:05:00.000Z",
          metadata: {
            phaseKey: "planning",
            phaseName: "Planning",
          },
        },
      ],
      attempts: [],
    };
    const { tools, orchestratorService } = createCoordinatorHarness({ graph, missionLaneId: "lane-mission" });

    const result = await (tools.spawn_worker as any).execute({
      name: "Implement sidebar tab",
      modelId: "openai/gpt-5.3-codex",
      prompt: "Add the sidebar tab.",
    });

    expect(result).toMatchObject({
      ok: true,
      workerId: expect.stringContaining("worker_Implement_sidebar_tab_"),
    });
    expect(orchestratorService.addSteps).toHaveBeenCalledWith(expect.objectContaining({
      steps: [
        expect.objectContaining({
          dependencyStepKeys: ["worker_plan-sidebar_1"],
          metadata: expect.objectContaining({
            requestedDependencyStepKeys: [],
            inferredDependencyStepKeys: ["worker_plan-sidebar_1"],
          }),
        }),
      ],
    }));
  });

  it("create_task creates a manual task step without placeholder metadata", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [],
      attempts: [],
    };
    const { tools, orchestratorService, graph: harnessGraph } = createCoordinatorHarness({ graph });

    const result = await (tools.create_task as any).execute({
      key: "plan-sidebar",
      title: "Plan sidebar work",
      description: "Understand the sidebar touchpoints before implementation.",
      dependsOn: [],
    });

    expect(result.ok).toBe(true);
    expect(orchestratorService.addSteps).toHaveBeenCalledTimes(1);
    expect(orchestratorService.addSteps).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      steps: [
        expect.objectContaining({
          stepKey: "plan-sidebar",
          executorKind: "manual",
          metadata: expect.objectContaining({
            stepType: "task",
          }),
        }),
      ],
    }));
    expect(harnessGraph.steps[0]?.metadata).toEqual(expect.objectContaining({
      stepType: "task",
      requestedDependencyStepKeys: [],
    }));
  });

  it("create_task infers the completed planning worker as an upstream dependency when development omits dependsOn", async () => {
    const graph = {
      run: {
        metadata: {
          phaseRuntime: {
            currentPhaseKey: "development",
            currentPhaseName: "Development",
          },
          phaseConfiguration: {
            selectedPhases: [
              {
                id: "phase-planning",
                phaseKey: "planning",
                name: "Planning",
                description: "Research",
                instructions: "",
                model: { provider: "anthropic", modelId: "anthropic/claude-sonnet-4-6" },
                budget: {},
                orderingConstraints: { mustBeFirst: true },
                askQuestions: { enabled: false, mode: "never" },
                validationGate: { tier: "self", required: true },
                isBuiltIn: true,
                isCustom: false,
                position: 1,
                createdAt: "2026-03-02T00:00:00.000Z",
                updatedAt: "2026-03-02T00:00:00.000Z",
              },
              {
                id: "phase-development",
                phaseKey: "development",
                name: "Development",
                description: "Build",
                instructions: "",
                model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
                budget: {},
                orderingConstraints: { mustFollow: ["planning"] },
                askQuestions: { enabled: false, mode: "never" },
                validationGate: { tier: "dedicated", required: false },
                isBuiltIn: true,
                isCustom: false,
                position: 2,
                createdAt: "2026-03-02T00:00:00.000Z",
                updatedAt: "2026-03-02T00:00:00.000Z",
              },
            ],
          },
        },
      },
      steps: [
        {
          id: "step-plan",
          runId: "run-1",
          missionStepId: null,
          stepKey: "worker_plan-sidebar_1",
          stepIndex: 0,
          title: "Plan sidebar work",
          laneId: "lane-mission",
          status: "succeeded",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 0,
          retryCount: 0,
          lastAttemptId: null,
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-02T00:05:00.000Z",
          startedAt: "2026-03-02T00:00:00.000Z",
          completedAt: "2026-03-02T00:05:00.000Z",
          metadata: {
            phaseKey: "planning",
            phaseName: "Planning",
          },
        },
      ],
      attempts: [],
    };
    const { tools, orchestratorService } = createCoordinatorHarness({ graph, missionLaneId: "lane-mission" });

    const result = await (tools.create_task as any).execute({
      key: "implement-sidebar",
      title: "Implement sidebar tab",
      description: "Add the new sidebar tab.",
      dependsOn: [],
    });

    expect(result).toMatchObject({
      ok: true,
      taskKey: "implement-sidebar",
    });
    expect(orchestratorService.addSteps).toHaveBeenCalledWith(expect.objectContaining({
      steps: [
        expect.objectContaining({
          stepKey: "implement-sidebar",
          dependencyStepKeys: ["worker_plan-sidebar_1"],
          metadata: expect.objectContaining({
            requestedDependencyStepKeys: [],
            inferredDependencyStepKeys: ["worker_plan-sidebar_1"],
          }),
        }),
      ],
    }));
  });

  it("create_task rejects missing text fields without throwing", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [],
      attempts: [],
    };
    const { tools, orchestratorService } = createCoordinatorHarness({ graph });

    const result = await (tools.create_task as any).execute({
      key: "plan-sidebar",
      dependsOn: undefined,
    });

    expect(result).toMatchObject({
      ok: false,
      error: "Task title is required.",
    });
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
  });

  it("create_task is blocked while the mission is still in planning", async () => {
    const graph = {
      run: {
        metadata: {
          phaseRuntime: {
            currentPhaseKey: "planning",
            currentPhaseName: "Planning",
          },
        },
      },
      steps: [],
      attempts: [],
    };
    const { tools, orchestratorService } = createCoordinatorHarness({
      graph,
      missionMetadata: {
        phaseConfiguration: {
          phases: [
            {
              phaseKey: "planning",
              name: "Planning",
              position: 0,
              instructions: "Plan first",
              validationGate: { tier: "self", required: false },
              budget: {},
            },
            {
              phaseKey: "development",
              name: "Development",
              position: 1,
              instructions: "Build second",
              validationGate: { tier: "self", required: false },
              budget: {},
            },
          ],
        },
      },
    });

    const result = await (tools.create_task as any).execute({
      key: "plan-sidebar",
      title: "Plan sidebar work",
      description: "Understand the sidebar touchpoints before implementation.",
      dependsOn: [],
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Planning should be represented by the planning worker itself."),
    });
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
  });

  it("report_status tolerates omitted optional arrays from runtime tool calls", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [
        {
          id: "worker-step-1",
          runId: "run-1",
          missionStepId: null,
          stepKey: "worker_implement-test-tab_1",
          stepIndex: 0,
          title: "implement-test-tab",
          laneId: "lane-1",
          status: "running",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 0,
          retryCount: 0,
          lastAttemptId: null,
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          startedAt: "2026-03-02T00:00:00.000Z",
          completedAt: null,
          metadata: {},
        },
      ],
      attempts: [],
    };
    const { tools, orchestratorService, graph: harnessGraph } = createCoordinatorHarness({ graph });

    const result = await (tools.report_status as any).execute({
      workerId: "worker_implement-test-tab_1",
      progressPct: 42,
      nextAction: "checking the existing routing pattern",
    });

    expect(result).toMatchObject({
      ok: true,
      report: {
        blockers: [],
        nextAction: "checking the existing routing pattern",
        progressPct: 42,
      },
    });
    expect(orchestratorService.updateStepMetadata).toHaveBeenCalledTimes(1);
    expect(harnessGraph.steps[0]?.metadata).toEqual(expect.objectContaining({
      lastStatusReport: expect.objectContaining({
        blockers: [],
        nextAction: "checking the existing routing pattern",
      }),
    }));
  });

  it("report_result tolerates omitted artifact and file arrays from runtime tool calls", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [
        {
          id: "worker-step-1",
          runId: "run-1",
          missionStepId: null,
          stepKey: "worker_implement-test-tab_1",
          stepIndex: 0,
          title: "implement-test-tab",
          laneId: "lane-1",
          status: "running",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 0,
          retryCount: 0,
          lastAttemptId: null,
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          startedAt: "2026-03-02T00:00:00.000Z",
          completedAt: null,
          metadata: {},
        },
      ],
      attempts: [],
    };
    const { tools, orchestratorService, graph: harnessGraph } = createCoordinatorHarness({ graph });

    const result = await (tools.report_result as any).execute({
      workerId: "worker_implement-test-tab_1",
      outcome: "succeeded",
      summary: "done with the read-only research pass",
    });

    expect(result).toMatchObject({
      ok: true,
      report: {
        artifacts: [],
        filesChanged: [],
        summary: "done with the read-only research pass",
      },
    });
    expect(orchestratorService.createHandoff).toHaveBeenCalledTimes(1);
    expect(harnessGraph.steps[0]?.metadata).toEqual(expect.objectContaining({
      lastResultReport: expect.objectContaining({
        artifacts: [],
        filesChanged: [],
      }),
    }));
  });

  it("spawn_worker resolves manual task dependencies onto executable workers", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [
        {
          id: "task-1",
          runId: "run-1",
          missionStepId: null,
          stepKey: "plan-sidebar",
          stepIndex: 0,
          title: "Plan sidebar work",
          laneId: null,
          status: "pending",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 0,
          retryCount: 0,
          lastAttemptId: null,
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          startedAt: null,
          completedAt: null,
          metadata: {
            isTask: true,
            stepType: "task",
            assignedTo: "research-sidebar",
          },
        },
        {
          id: "worker-1",
          runId: "run-1",
          missionStepId: null,
          stepKey: "research-sidebar",
          stepIndex: 1,
          title: "Research sidebar",
          laneId: "lane-mission",
          status: "succeeded",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 0,
          retryCount: 0,
          lastAttemptId: null,
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          startedAt: null,
          completedAt: "2026-03-02T00:05:00.000Z",
          metadata: {},
        },
      ],
      attempts: [],
    };
    const { tools, orchestratorService } = createCoordinatorHarness({ graph, missionLaneId: "lane-mission" });

    const result = await (tools.spawn_worker as any).execute({
      name: "Implement sidebar tab",
      modelId: "openai/gpt-5.3-codex",
      prompt: "Add the sidebar tab.",
      dependsOn: ["plan-sidebar"],
    });

    expect(result.ok).toBe(true);
    expect(orchestratorService.addSteps).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      steps: [
        expect.objectContaining({
          dependencyStepKeys: ["research-sidebar"],
          metadata: expect.objectContaining({
            requestedDependencyStepKeys: ["plan-sidebar"],
            planningTaskDependencies: ["plan-sidebar"],
          }),
        }),
      ],
    }));
  });

  it("read_mission_status excludes legacy task shells from execution counts", async () => {
    const graph = {
      run: { metadata: {}, status: "active" },
      steps: [
        {
          id: "task-1",
          runId: "run-1",
          missionStepId: null,
          stepKey: "plan-sidebar",
          stepIndex: 0,
          title: "Plan sidebar work",
          laneId: null,
          status: "pending",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 0,
          retryCount: 0,
          lastAttemptId: null,
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          startedAt: null,
          completedAt: null,
          metadata: {
            isTask: true,
            stepType: "task",
          },
        },
        {
          id: "worker-1",
          runId: "run-1",
          missionStepId: null,
          stepKey: "impl-sidebar",
          stepIndex: 1,
          title: "Implement sidebar",
          laneId: "lane-mission",
          status: "succeeded",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 0,
          retryCount: 0,
          lastAttemptId: null,
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          startedAt: "2026-03-02T00:01:00.000Z",
          completedAt: "2026-03-02T00:04:00.000Z",
          metadata: {
            spawnedByCoordinator: true,
            lastResultReport: { summary: "Done" },
          },
        },
      ],
      attempts: [],
    };
    const { tools } = createCoordinatorHarness({ graph });

    const result = await (tools.read_mission_status as any).execute({});

    expect(result.ok).toBe(true);
    expect(result.counts).toEqual(expect.objectContaining({
      total: 1,
      active: 0,
      completed: 1,
    }));
    expect(result.completedSteps).toEqual([
      expect.objectContaining({
        stepKey: "impl-sidebar",
        status: "succeeded",
      }),
    ]);
  });
});

describe("coordinatorTools planning manual-input blocking", () => {
  it("blocks ask_user outside the planning phase", async () => {
    const { tools } = createCoordinatorHarness({
      graph: {
        run: {
          metadata: {
            phaseRuntime: {
              currentPhaseKey: "development",
              currentPhaseName: "Development",
              currentPhaseModel: {
                modelId: "openai/gpt-5.4-codex",
                thinkingLevel: "medium",
              },
            },
          },
        },
        steps: [],
        attempts: [],
      },
      missionMetadata: {
        phaseConfiguration: {
          selectedPhases: [
            {
              id: "phase-planning",
              phaseKey: "planning",
              name: "Planning",
              description: "Plan the work.",
              instructions: "Plan first.",
              model: { modelId: "anthropic/claude-sonnet-4-6", provider: "claude", thinkingLevel: "medium" },
              budget: {},
              orderingConstraints: { mustBeFirst: true },
              askQuestions: { enabled: true, mode: "auto_if_uncertain" },
              validationGate: { tier: "none", required: false },
              isBuiltIn: true,
              isCustom: false,
              position: 0,
              createdAt: "2026-03-02T00:00:00.000Z",
              updatedAt: "2026-03-02T00:00:00.000Z",
            },
            {
              id: "phase-development",
              phaseKey: "development",
              name: "Development",
              description: "Ship the code.",
              instructions: "Implement the work.",
              model: { modelId: "openai/gpt-5.4-codex", provider: "openai", thinkingLevel: "medium" },
              budget: {},
              orderingConstraints: {},
              askQuestions: { enabled: false, mode: "never" },
              validationGate: { tier: "none", required: false },
              isBuiltIn: true,
              isCustom: false,
              position: 1,
              createdAt: "2026-03-02T00:00:00.000Z",
              updatedAt: "2026-03-02T00:00:00.000Z",
            },
          ],
        },
      },
    });

    const result = await (tools.ask_user as any).execute({
      questions: [{ question: "Should I refactor the settings dialog too?" }],
      phase: "development",
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Ask Questions is disabled for the current phase"),
    });
  });

  it("blocks coordinator-side file reads during planning", async () => {
    const { tools } = createCoordinatorHarness({
      graph: {
        run: {
          metadata: {
            phaseRuntime: {
              currentPhaseKey: "planning",
              currentPhaseName: "Planning",
              currentPhaseModel: {
                modelId: "anthropic/claude-sonnet-4-6",
                thinkingLevel: "medium",
              },
            },
          },
        },
        steps: [],
        attempts: [],
      },
      missionMetadata: {
        phaseConfiguration: {
          selectedPhases: [
            {
              id: "phase-planning",
              phaseKey: "planning",
              name: "Planning",
              description: "Plan the work.",
              instructions: "Plan first.",
              model: { modelId: "anthropic/claude-sonnet-4-6", provider: "claude", thinkingLevel: "medium" },
              budget: {},
              orderingConstraints: { mustBeFirst: true },
              askQuestions: { enabled: true, mode: "auto_if_uncertain" },
              validationGate: { tier: "none", required: false },
              isBuiltIn: true,
              isCustom: false,
              position: 0,
              createdAt: "2026-03-02T00:00:00.000Z",
              updatedAt: "2026-03-02T00:00:00.000Z",
            },
          ],
        },
      },
    });

    const result = await (tools.read_file as any).execute({
      filePath: "package.json",
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("disabled during Planning"),
    });
  });

  it("blocks planning actions when a blocking request_user_input intervention is open", async () => {
    const { tools } = createCoordinatorHarness({
      graph: {
        run: {
          metadata: {
            phaseRuntime: {
              currentPhaseKey: "planning",
              currentPhaseName: "Planning",
              currentPhaseModel: {
                modelId: "anthropic/claude-sonnet-4-6",
                thinkingLevel: "medium",
              },
            },
          },
        },
        steps: [],
        attempts: [],
      },
      missionMetadata: {
        phaseConfiguration: {
          selectedPhases: [
            {
              id: "phase-planning",
              phaseKey: "planning",
              name: "Planning",
              description: "Plan the work.",
              instructions: "Plan first.",
              model: { modelId: "anthropic/claude-sonnet-4-6", provider: "claude", thinkingLevel: "medium" },
              budget: {},
              orderingConstraints: {},
              askQuestions: { enabled: true, mode: "auto_if_uncertain" },
              validationGate: { tier: "none", required: false },
              isBuiltIn: true,
              isCustom: false,
              position: 0,
              createdAt: "2026-03-02T00:00:00.000Z",
              updatedAt: "2026-03-02T00:00:00.000Z",
            },
          ],
        },
      },
    });

    const request = await (tools.request_user_input as any).execute({
      question: "Should the new tab be navigable or a placeholder?",
      canProceedWithoutAnswer: false,
      urgency: "normal",
    });
    expect(request).toMatchObject({ ok: true });

    const result = await (tools.spawn_worker as any).execute({
      name: "planning-worker",
      prompt: "Sketch the planning DAG.",
      dependsOn: [],
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Planning input is still pending"),
    });
  });

  it("allows planning actions to continue when manual input is explicitly optional", async () => {
    const { tools } = createCoordinatorHarness({
      graph: {
        run: {
          metadata: {
            phaseRuntime: {
              currentPhaseKey: "planning",
              currentPhaseName: "Planning",
              currentPhaseModel: {
                modelId: "anthropic/claude-sonnet-4-6",
                thinkingLevel: "medium",
              },
            },
          },
        },
        steps: [],
        attempts: [],
      },
      missionMetadata: {
        phaseConfiguration: {
          selectedPhases: [
            {
              id: "phase-planning",
              phaseKey: "planning",
              name: "Planning",
              description: "Plan the work.",
              instructions: "Plan first.",
              model: { modelId: "anthropic/claude-sonnet-4-6", provider: "claude", thinkingLevel: "medium" },
              budget: {},
              orderingConstraints: {},
              askQuestions: { enabled: true, mode: "auto_if_uncertain" },
              validationGate: { tier: "none", required: false },
              isBuiltIn: true,
              isCustom: false,
              position: 0,
              createdAt: "2026-03-02T00:00:00.000Z",
              updatedAt: "2026-03-02T00:00:00.000Z",
            },
          ],
        },
      },
    });

    const request = await (tools.request_user_input as any).execute({
      question: "Any preference on naming?",
      canProceedWithoutAnswer: true,
      urgency: "low",
    });
    expect(request).toMatchObject({ ok: true });

    const result = await (tools.spawn_worker as any).execute({
      name: "planning-worker",
      prompt: "Sketch the planning DAG.",
      dependsOn: [],
    });

    expect(result).toMatchObject({
      ok: true,
      workerId: expect.stringContaining("worker_planning-worker_"),
    });
  });

  it("requires a phase transition before spawning more workers after planning completes", async () => {
    const { tools, orchestratorService } = createCoordinatorHarness({
      graph: {
        run: {
          metadata: {
            phaseRuntime: {
              currentPhaseKey: "planning",
              currentPhaseName: "Planning",
              currentPhaseModel: {
                modelId: "anthropic/claude-sonnet-4-6",
                thinkingLevel: "medium",
              },
            },
          },
        },
        steps: [
          {
            id: "step-plan-1",
            stepKey: "worker-plan",
            stepIndex: 0,
            title: "Planning worker",
            laneId: null,
            status: "succeeded",
            dependencyStepIds: [],
            retryLimit: 1,
            retryCount: 0,
            metadata: {
              phaseKey: "planning",
              phaseName: "Planning",
              stepType: "planning",
              readOnlyExecution: true,
            },
          },
        ],
        attempts: [],
      },
      missionMetadata: {
        phaseConfiguration: {
          selectedPhases: [
            {
              id: "phase-planning",
              phaseKey: "planning",
              name: "Planning",
              description: "Plan the work.",
              instructions: "Plan first.",
              model: { modelId: "anthropic/claude-sonnet-4-6", provider: "claude", thinkingLevel: "medium" },
              budget: {},
              orderingConstraints: {},
              askQuestions: { enabled: false, mode: "never" },
              validationGate: { tier: "self", required: false },
              isBuiltIn: true,
              isCustom: false,
              position: 0,
              createdAt: "2026-03-02T00:00:00.000Z",
              updatedAt: "2026-03-02T00:00:00.000Z",
            },
            {
              id: "phase-development",
              phaseKey: "development",
              name: "Development",
              description: "Build the feature.",
              instructions: "Implement the planned changes.",
              model: { modelId: "openai/gpt-5.3-codex", provider: "codex", thinkingLevel: "medium" },
              budget: {},
              orderingConstraints: { mustFollow: ["planning"] },
              askQuestions: { enabled: false, mode: "never" },
              validationGate: { tier: "self", required: false },
              isBuiltIn: true,
              isCustom: false,
              position: 1,
              createdAt: "2026-03-02T00:00:00.000Z",
              updatedAt: "2026-03-02T00:00:00.000Z",
            },
          ],
        },
      },
    });

    const result = await (tools.spawn_worker as any).execute({
      name: "implementation-worker",
      prompt: "Implement the feature now.",
      dependsOn: [],
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'Planning phase already produced a completed worker result. Call set_current_phase with phaseKey "development" before spawning more workers.',
    });
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
  });

  it("blocks phase transitions when the planning phase only failed", async () => {
    const planningPhase = {
      id: "phase-planning",
      phaseKey: "planning",
      name: "Planning",
      description: "Plan the work.",
      instructions: "Plan first.",
      model: { modelId: "anthropic/claude-sonnet-4-6", provider: "claude", thinkingLevel: "medium" },
      budget: {},
      orderingConstraints: { mustBeFirst: true, mustBeLast: false, mustFollow: [], mustPrecede: [], canLoop: false, loopTarget: null },
      askQuestions: { enabled: false, mode: "never" },
      validationGate: { tier: "self", required: false },
      isBuiltIn: true,
      isCustom: false,
      position: 0,
      createdAt: "2026-03-02T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
    };
    const developmentPhase = {
      ...planningPhase,
      id: "phase-development",
      phaseKey: "development",
      name: "Development",
      description: "Build the feature.",
      instructions: "Implement the planned changes.",
      model: { modelId: "openai/gpt-5.3-codex", provider: "codex", thinkingLevel: "medium" },
      orderingConstraints: { mustBeFirst: false, mustBeLast: false, mustFollow: ["planning"], mustPrecede: [], canLoop: false, loopTarget: null },
      position: 1,
    };

    const { tools, db } = createCoordinatorHarness({
      graph: {
        run: {
          metadata: {
            phaseRuntime: {
              currentPhaseKey: "planning",
              currentPhaseName: "Planning",
              currentPhaseModel: planningPhase.model,
            },
          },
        },
        steps: [
          {
            id: "step-plan-1",
            stepKey: "worker-plan",
            stepIndex: 0,
            title: "Planning worker",
            laneId: null,
            status: "failed",
            dependencyStepIds: [],
            retryLimit: 1,
            retryCount: 0,
            metadata: {
              phaseKey: "planning",
              phaseName: "Planning",
              stepType: "planning",
              readOnlyExecution: true,
            },
          },
        ],
        attempts: [],
      },
      missionMetadata: {
        phaseConfiguration: {
          selectedPhases: [planningPhase, developmentPhase],
        },
      },
    });

    const result = await (tools.set_current_phase as any).execute({
      phaseKey: "development",
    });

    expect(result).toMatchObject({
      ok: false,
      error: "Planning phase has not completed yet. Wait for a planning worker to succeed before transitioning."
    });
    expect(db.run).not.toHaveBeenCalled();
  });

  it("blocks required phase transitions when the predecessor only skipped", async () => {
    const planningPhase = {
      id: "phase-planning",
      phaseKey: "planning",
      name: "Planning",
      description: "Plan the work.",
      instructions: "Plan first.",
      model: { modelId: "anthropic/claude-sonnet-4-6", provider: "claude", thinkingLevel: "medium" },
      budget: {},
      orderingConstraints: { mustBeFirst: true, mustBeLast: false, mustFollow: [], mustPrecede: [], canLoop: false, loopTarget: null },
      askQuestions: { enabled: false, mode: "never" },
      validationGate: { tier: "self", required: false },
      isBuiltIn: true,
      isCustom: false,
      position: 0,
      createdAt: "2026-03-02T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
    };
    const developmentPhase = {
      ...planningPhase,
      id: "phase-development",
      phaseKey: "development",
      name: "Development",
      description: "Build the feature.",
      instructions: "Implement the planned changes.",
      model: { modelId: "openai/gpt-5.3-codex", provider: "codex", thinkingLevel: "medium" },
      validationGate: { tier: "dedicated", required: true },
      position: 1,
    };
    const validationPhase = {
      ...planningPhase,
      id: "phase-validation",
      phaseKey: "validation",
      name: "Validation",
      description: "Validate the feature.",
      instructions: "Validate the planned changes.",
      model: { modelId: "anthropic/claude-sonnet-4-6", provider: "claude", thinkingLevel: "medium" },
      orderingConstraints: { mustBeFirst: false, mustBeLast: true, mustFollow: ["development"], mustPrecede: [], canLoop: false, loopTarget: null },
      validationGate: { tier: "dedicated", required: true },
      position: 2,
    };

    const { tools, db } = createCoordinatorHarness({
      graph: {
        run: {
          metadata: {
            phaseRuntime: {
              currentPhaseKey: "development",
              currentPhaseName: "Development",
              currentPhaseModel: developmentPhase.model,
            },
          },
        },
        steps: [
          {
            id: "step-plan-1",
            stepKey: "worker-plan",
            stepIndex: 0,
            title: "Planning worker",
            laneId: null,
            status: "succeeded",
            dependencyStepIds: [],
            retryLimit: 1,
            retryCount: 0,
            metadata: {
              phaseKey: "planning",
              phaseName: "Planning",
              stepType: "planning",
              readOnlyExecution: true,
            },
          },
          {
            id: "step-dev-1",
            stepKey: "implement",
            stepIndex: 1,
            title: "Implementation worker",
            laneId: null,
            status: "skipped",
            dependencyStepIds: [],
            retryLimit: 1,
            retryCount: 0,
            metadata: {
              phaseKey: "development",
              phaseName: "Development",
              stepType: "implementation",
            },
          },
        ],
        attempts: [],
      },
      missionMetadata: {
        phaseConfiguration: {
          selectedPhases: [planningPhase, developmentPhase, validationPhase],
        },
      },
    });

    const result = await (tools.set_current_phase as any).execute({
      phaseKey: "validation",
    });

    expect(result).toMatchObject({
      ok: false,
      error: "Cannot enter phase 'Validation' before 'Development' has succeeded."
    });
    expect(db.run).not.toHaveBeenCalled();
  });

  it("rejects explicit model overrides that do not match the active phase model", async () => {
    const planningPhase = {
      id: "phase-planning",
      phaseKey: "planning",
      name: "Planning",
      description: "Plan the work.",
      instructions: "Plan first.",
      model: { modelId: "anthropic/claude-sonnet-4-6", provider: "claude", thinkingLevel: "medium" },
      budget: {},
      orderingConstraints: { mustBeFirst: true, mustBeLast: false, mustFollow: [], mustPrecede: [], canLoop: false, loopTarget: null },
      askQuestions: { enabled: false, mode: "never" },
      validationGate: { tier: "self", required: false },
      isBuiltIn: true,
      isCustom: false,
      position: 0,
      createdAt: "2026-03-02T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
    };
    const developmentPhase = {
      id: "phase-development",
      phaseKey: "development",
      name: "Development",
      description: "Build the feature.",
      instructions: "Implement the planned changes.",
      model: { modelId: "openai/gpt-5.3-codex", provider: "codex", thinkingLevel: "medium" },
      budget: {},
      orderingConstraints: { mustBeFirst: false, mustBeLast: false, mustFollow: ["planning"], mustPrecede: [], canLoop: false, loopTarget: null },
      askQuestions: { enabled: false, mode: "never" },
      validationGate: { tier: "self", required: false },
      isBuiltIn: true,
      isCustom: false,
      position: 1,
      createdAt: "2026-03-02T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
    };

    const { tools, orchestratorService } = createCoordinatorHarness({
      graph: {
        run: {
          metadata: {
            phaseRuntime: {
              currentPhaseKey: "planning",
              currentPhaseName: "Planning",
              currentPhaseModel: planningPhase.model,
            },
          },
        },
        steps: [],
        attempts: [],
      },
      missionMetadata: {
        phaseConfiguration: {
          selectedPhases: [planningPhase, developmentPhase],
        },
      },
    });

    const result = await (tools.spawn_worker as any).execute({
      name: "implementation-worker",
      modelId: "openai/gpt-5.3-codex",
      prompt: "Implement the feature now.",
      dependsOn: [],
    });

    expect(result).toMatchObject({
      ok: false,
      error:
        'Current phase "Planning" is configured for model "anthropic/claude-sonnet-4-6". Omit modelId to use the phase model, or call set_current_phase before switching models.',
    });
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
  });

  it("rejects implementation-style prompts while the current phase is planning", async () => {
    const planningPhase = {
      id: "phase-planning",
      phaseKey: "planning",
      name: "Planning",
      description: "Plan the work.",
      instructions: "Plan first.",
      model: { modelId: "anthropic/claude-sonnet-4-6", provider: "claude", thinkingLevel: "medium" },
      budget: {},
      orderingConstraints: { mustBeFirst: true, mustBeLast: false, mustFollow: [], mustPrecede: [], canLoop: false, loopTarget: null },
      askQuestions: { enabled: false, mode: "never" },
      validationGate: { tier: "self", required: false },
      isBuiltIn: true,
      isCustom: false,
      position: 0,
      createdAt: "2026-03-02T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
    };

    const { tools, orchestratorService } = createCoordinatorHarness({
      graph: {
        run: {
          metadata: {
            phaseRuntime: {
              currentPhaseKey: "planning",
              currentPhaseName: "Planning",
              currentPhaseModel: planningPhase.model,
            },
          },
        },
        steps: [],
        attempts: [],
      },
      missionMetadata: {
        phaseConfiguration: {
          selectedPhases: [planningPhase],
        },
      },
    });

    const result = await (tools.spawn_worker as any).execute({
      name: "planning-worker",
      prompt: [
        "## Worktree Path",
        "You are working in: /tmp/worktree",
        "",
        "All file edits MUST be made in the worktree path above.",
        "",
        "## Files to Edit",
        "### 1. Create NEW file: `src/TestPage.tsx`",
        "Run `git add -A` and `git commit -m \"feat: add test page\"`."
      ].join("\n"),
      dependsOn: [],
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('Current phase is "planning". Planning workers must stay read-only'),
    });
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
  });

  it("blocks validation-like workers before the validation phase opens", async () => {
    const { tools, orchestratorService } = createCoordinatorHarness({
      graph: {
        run: {
          metadata: {
            phaseRuntime: {
              currentPhaseKey: "development",
              currentPhaseName: "Development",
              currentPhaseModel: {
                modelId: "openai/gpt-5.3-codex",
                thinkingLevel: "medium",
              },
            },
          },
        },
        steps: [],
        attempts: [],
      },
      missionMetadata: {
        phaseConfiguration: {
          selectedPhases: [
            {
              id: "phase-development",
              phaseKey: "development",
              name: "Development",
              description: "Build",
              instructions: "Implement the work.",
              model: { modelId: "openai/gpt-5.3-codex", provider: "codex", thinkingLevel: "medium" },
              budget: {},
              orderingConstraints: {},
              askQuestions: { enabled: false, mode: "never" },
              validationGate: { tier: "self", required: false },
              isBuiltIn: true,
              isCustom: false,
              position: 1,
              createdAt: "2026-03-02T00:00:00.000Z",
              updatedAt: "2026-03-02T00:00:00.000Z",
            },
            {
              id: "phase-validation",
              phaseKey: "validation",
              name: "Validation",
              description: "Validate",
              instructions: "Validate the completed work.",
              model: { modelId: "anthropic/claude-sonnet-4-6", provider: "claude", thinkingLevel: "medium" },
              budget: {},
              orderingConstraints: {},
              askQuestions: { enabled: false, mode: "never" },
              validationGate: { tier: "dedicated", required: true },
              isBuiltIn: true,
              isCustom: false,
              position: 2,
              createdAt: "2026-03-02T00:00:00.000Z",
              updatedAt: "2026-03-02T00:00:00.000Z",
            },
          ],
        },
      },
    });

    const result = await (tools.spawn_worker as any).execute({
      name: "validate-test-tab",
      prompt: "You are a validation worker. Use report_validation with verdict \"pass\" or \"fail\".",
      dependsOn: [],
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('Validation workers can only be spawned during the "validation" phase.'),
    });
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
  });
});

describe("coordinatorTools budget hard-cap guards", () => {
  it("spawn_worker allows API/local phase models and creates unified worker steps", async () => {
    const { tools, orchestratorService } = createCoordinatorHarness({
      graph: {
        run: {
          metadata: {
            phaseRuntime: {
              currentPhaseModel: {
                modelId: "openai/gpt-4.1",
                provider: "openai"
              }
            }
          }
        },
        steps: [],
        attempts: [],
      },
    });

    const result = await (tools.spawn_worker as any).execute({
      name: "blocked-api-worker",
      prompt: "Attempt API worker spawn",
      dependsOn: [],
    });

    expect(result).toMatchObject({
      ok: true,
      modelId: "openai/gpt-4.1",
    });
    expect(orchestratorService.addSteps).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            executorKind: "unified",
          }),
        ],
      })
    );
  });

  it("spawn_worker blocks and reports hard caps before mutating the DAG", async () => {
    const getMissionBudgetStatus = vi.fn(async () => ({
      perProvider: [
        {
          provider: "claude",
          fiveHour: { usedPct: 96 },
          weekly: { usedPct: 32 },
        },
      ],
      hardCaps: {
        fiveHourTriggered: true,
        weeklyTriggered: false,
        apiKeyTriggered: false,
        fiveHourHardStopPercent: 95,
        weeklyHardStopPercent: 90,
        apiKeySpentUsd: 0,
        apiKeyMaxSpendUsd: null,
      },
    }));
    const onHardCapTriggered = vi.fn();
    const { tools, orchestratorService } = createCoordinatorHarness({
      graph: { run: { metadata: {} }, steps: [], attempts: [] },
      getMissionBudgetStatus,
      onHardCapTriggered,
    });

    const result = await (tools.spawn_worker as any).execute({
      name: "blocked-worker",
      provider: "claude",
      prompt: "Do work",
      dependsOn: [],
    });

    expect(result).toMatchObject({
      ok: false,
      hardCapTriggered: true,
    });
    expect(String(result.error)).toContain("Cannot spawn worker:");
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
    expect(onHardCapTriggered).toHaveBeenCalledTimes(1);
    expect(String(onHardCapTriggered.mock.calls[0]?.[0] ?? "")).toContain("5hr usage");
  });

  it("request_specialist blocks on hard caps before worker creation", async () => {
    const getMissionBudgetStatus = vi.fn(async () => ({
      perProvider: [
        {
          provider: "codex",
          fiveHour: { usedPct: 12 },
          weekly: { usedPct: 91 },
        },
      ],
      hardCaps: {
        fiveHourTriggered: false,
        weeklyTriggered: true,
        apiKeyTriggered: false,
        fiveHourHardStopPercent: 95,
        weeklyHardStopPercent: 90,
        apiKeySpentUsd: 0,
        apiKeyMaxSpendUsd: null,
      },
    }));
    const { tools, orchestratorService } = createCoordinatorHarness({
      graph: {
        run: {
          metadata: {
            teamRuntime: {
              enabled: true,
              template: {
                roles: [
                  {
                    name: "validator",
                    capabilities: ["validation"],
                  }
                ]
              }
            }
          }
        },
        steps: [],
        attempts: [],
      },
      getMissionBudgetStatus,
    });

    const result = await (tools.request_specialist as any).execute({
      role: "validator",
      objective: "Validate test integrity.",
      reason: "Independent verifier required.",
      dependsOn: [],
    });

    expect(result).toMatchObject({
      ok: false,
      hardCapTriggered: true,
    });
    expect(String(result.error)).toContain("Cannot spawn specialist:");
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
  });

  it("revise_plan blocks replacement worker spawning when hard caps are active", async () => {
    const getMissionBudgetStatus = vi.fn(async () => ({
      perProvider: [],
      hardCaps: {
        fiveHourTriggered: false,
        weeklyTriggered: false,
        apiKeyTriggered: true,
        fiveHourHardStopPercent: 95,
        weeklyHardStopPercent: 90,
        apiKeySpentUsd: 51.25,
        apiKeyMaxSpendUsd: 50,
      },
    }));
    const { tools, orchestratorService, onDagMutation, graph } = createCoordinatorHarness({
      graph: {
        run: { metadata: {} },
        steps: [
          {
            id: "step-legacy",
            stepKey: "legacy",
            stepIndex: 0,
            title: "Legacy",
            laneId: null,
            status: "pending",
            dependencyStepIds: [],
            retryLimit: 1,
            retryCount: 0,
            metadata: {}
          }
        ],
        attempts: [],
      },
      getMissionBudgetStatus,
    });

    const result = await (tools.revise_plan as any).execute({
      mode: "partial",
      replaceStepKeys: ["legacy"],
      replacementMap: [],
      dependencyPatches: [],
      reason: "Need better plan.",
      newSteps: [
        {
          key: "replacement",
          title: "Replacement",
          description: "Implement replacement task.",
          dependsOn: [],
          provider: "claude",
          replaces: ["legacy"]
        }
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      hardCapTriggered: true,
    });
    expect(String(result.error)).toContain("Cannot revise plan");
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
    expect(orchestratorService.supersedeStep).not.toHaveBeenCalled();
    expect(orchestratorService.updateStepDependencies).not.toHaveBeenCalled();
    expect(orchestratorService.appendRuntimeEvent).not.toHaveBeenCalled();
    expect(orchestratorService.appendTimelineEvent).not.toHaveBeenCalled();
    expect(onDagMutation).not.toHaveBeenCalled();
    expect(graph.steps.find((entry: any) => entry.id === "step-legacy")?.status).toBe("pending");
  });
});

describe("coordinatorTools delegate_parallel", () => {
  it("creates a batch of sub-agents under one parent with dependency and lane inheritance", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [
        {
          id: "step-parent",
          stepKey: "parent-worker",
          stepIndex: 0,
          title: "Parent Worker",
          laneId: "lane-parent",
          status: "running",
          dependencyStepIds: [],
          retryLimit: 2,
          retryCount: 0,
          metadata: { modelId: "anthropic/claude-sonnet-4-6" },
        },
      ],
      attempts: [],
    };
    const { tools, orchestratorService } = createCoordinatorHarness({ graph });

    const result = await (tools.delegate_parallel as any).execute({
      parentWorkerId: "parent-worker",
      tasks: [
        { name: "child-a", prompt: "Implement API changes." },
        { name: "child-b", prompt: "Write tests for API changes." },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      parentWorkerId: "parent-worker",
      total: 2,
      children: [
        expect.objectContaining({ name: "child-a" }),
        expect.objectContaining({ name: "child-b" }),
      ],
    });
    expect(orchestratorService.addSteps).toHaveBeenCalledTimes(2);
    for (const call of orchestratorService.addSteps.mock.calls) {
      expect(call[0]).toMatchObject({
        runId: "run-1",
        steps: [
          expect.objectContaining({
            laneId: "lane-parent",
            dependencyStepKeys: ["parent-worker"],
          }),
        ],
      });
    }
    expect(orchestratorService.updateStepMetadata).toHaveBeenCalledTimes(2);
    for (const call of orchestratorService.updateStepMetadata.mock.calls) {
      expect(call[0]).toMatchObject({
        runId: "run-1",
        metadata: expect.objectContaining({
          parentWorkerId: "parent-worker",
          parentStepId: "step-parent",
          isSubAgent: true,
        }),
      });
    }
    expect(orchestratorService.startReadyAutopilotAttempts).toHaveBeenCalledTimes(1);
    expect(orchestratorService.startReadyAutopilotAttempts).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        reason: "coordinator_delegate_parallel",
      })
    );
  });

  it("rejects batch delegation when allowSubAgents=false", async () => {
    const graph = {
      run: {
        metadata: {
          teamRuntime: {
            enabled: true,
            allowSubAgents: false,
          },
        },
      },
      steps: [
        {
          id: "step-parent",
          stepKey: "parent-worker",
          stepIndex: 0,
          title: "Parent Worker",
          laneId: null,
          status: "running",
          dependencyStepIds: [],
          retryLimit: 2,
          retryCount: 0,
          metadata: {},
        },
      ],
      attempts: [],
    };
    const { tools, orchestratorService } = createCoordinatorHarness({ graph });

    const result = await (tools.delegate_parallel as any).execute({
      parentWorkerId: "parent-worker",
      tasks: [{ name: "child-a", prompt: "Do work." }],
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("allowSubAgents=false"),
    });
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
    expect(orchestratorService.startReadyAutopilotAttempts).not.toHaveBeenCalled();
  });

  it("rejects batch delegation when allowParallelAgents=false", async () => {
    const graph = {
      run: {
        metadata: {
          teamRuntime: {
            enabled: true,
            allowParallelAgents: false,
          },
        },
      },
      steps: [
        {
          id: "step-parent",
          stepKey: "parent-worker",
          stepIndex: 0,
          title: "Parent Worker",
          laneId: null,
          status: "running",
          dependencyStepIds: [],
          retryLimit: 2,
          retryCount: 0,
          metadata: {},
        },
      ],
      attempts: [],
    };
    const { tools, orchestratorService } = createCoordinatorHarness({ graph });

    const result = await (tools.delegate_parallel as any).execute({
      parentWorkerId: "parent-worker",
      tasks: [{ name: "child-a", prompt: "Do work." }],
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("allowParallelAgents=false"),
    });
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
    expect(orchestratorService.startReadyAutopilotAttempts).not.toHaveBeenCalled();
  });

  it("applies model cascade per task (explicit -> phase model)", async () => {
    const graph = {
      run: {
        metadata: {
          teamRuntime: {
            enabled: true,
            template: {
              roles: [
                {
                  name: "validator",
                  capabilities: ["validation"],
                }
              ]
            }
          },
          phaseRuntime: {
            currentPhaseModel: {
              modelId: "openai/gpt-4.1",
              provider: "openai",
            },
          },
        },
      },
      steps: [
        {
          id: "step-parent-model",
          stepKey: "parent-model",
          stepIndex: 0,
          title: "Parent With Model",
          laneId: null,
          status: "running",
          dependencyStepIds: [],
          retryLimit: 2,
          retryCount: 0,
          metadata: { modelId: "anthropic/claude-sonnet-4-6" },
        },
        {
          id: "step-parent-phase",
          stepKey: "parent-phase",
          stepIndex: 1,
          title: "Parent Without Model",
          laneId: null,
          status: "running",
          dependencyStepIds: [],
          retryLimit: 2,
          retryCount: 0,
          metadata: {},
        },
      ],
      attempts: [],
    };
    const { tools } = createCoordinatorHarness({ graph });

    const firstBatch = await (tools.delegate_parallel as any).execute({
      parentWorkerId: "parent-model",
      tasks: [
        { name: "explicit-model", prompt: "Task A", modelId: "openai/gpt-5.3-codex" },
        { name: "role-default", prompt: "Task B", role: "validator" },
        { name: "parent-fallback", prompt: "Task C" },
      ],
    });

    expect(firstBatch).toMatchObject({
      ok: true,
      children: [
        expect.objectContaining({ name: "explicit-model", modelId: "openai/gpt-5.3-codex" }),
        expect.objectContaining({ name: "role-default", modelId: "openai/gpt-4.1" }),
        expect.objectContaining({ name: "parent-fallback", modelId: "openai/gpt-4.1" }),
      ],
    });

    const secondBatch = await (tools.delegate_parallel as any).execute({
      parentWorkerId: "parent-phase",
      tasks: [{ name: "phase-fallback", prompt: "Task D" }],
    });

    expect(secondBatch).toMatchObject({
      ok: true,
      children: [
        expect.objectContaining({ name: "phase-fallback", modelId: "openai/gpt-4.1" }),
      ],
    });
  });

  it("blocks delegate_parallel on hard caps before mutating the DAG", async () => {
    const getMissionBudgetStatus = vi.fn(async () => ({
      perProvider: [
        {
          provider: "claude",
          fiveHour: { usedPct: 98 },
          weekly: { usedPct: 35 },
        },
      ],
      hardCaps: {
        fiveHourTriggered: true,
        weeklyTriggered: false,
        apiKeyTriggered: false,
        fiveHourHardStopPercent: 95,
        weeklyHardStopPercent: 90,
        apiKeySpentUsd: 0,
        apiKeyMaxSpendUsd: null,
      },
    }));
    const { tools, orchestratorService } = createCoordinatorHarness({
      graph: {
        run: { metadata: {} },
        steps: [
          {
            id: "step-parent",
            stepKey: "parent-worker",
            stepIndex: 0,
            title: "Parent Worker",
            laneId: null,
            status: "running",
            dependencyStepIds: [],
            retryLimit: 2,
            retryCount: 0,
            metadata: {},
          },
        ],
        attempts: [],
      },
      getMissionBudgetStatus,
    });

    const result = await (tools.delegate_parallel as any).execute({
      parentWorkerId: "parent-worker",
      tasks: [
        { name: "child-a", prompt: "Task A" },
        { name: "child-b", prompt: "Task B" },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      hardCapTriggered: true,
    });
    expect(String(result.error)).toContain("Cannot delegate sub-agents:");
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
    expect(orchestratorService.updateStepMetadata).not.toHaveBeenCalled();
    expect(orchestratorService.startReadyAutopilotAttempts).not.toHaveBeenCalled();
  });
});

describe("coordinatorTools revise_plan failure atomicity", () => {
  it("returns validation errors before applying supersede or dependency mutations", async () => {
    const { tools, orchestratorService, onDagMutation, graph } = createCoordinatorHarness({
      graph: {
        run: { metadata: {} },
        steps: [
          {
            id: "step-legacy",
            stepKey: "legacy",
            stepIndex: 0,
            title: "Legacy",
            laneId: null,
            status: "pending",
            dependencyStepIds: [],
            retryLimit: 1,
            retryCount: 0,
            metadata: {}
          }
        ],
        attempts: [],
      },
    });

    const result = await (tools.revise_plan as any).execute({
      mode: "partial",
      replaceStepKeys: ["legacy"],
      replacementMap: [],
      dependencyPatches: [],
      reason: "Plan rewrite requested.",
      newSteps: [
        {
          key: "replacement",
          title: "Replacement",
          description: "Implement replacement task.",
          dependsOn: [],
          provider: "claude",
          replaces: ["legacy"],
          validationContract: {
            level: "step",
            tier: "dedicated",
            required: true,
            criteria: "",
            evidence: [],
            maxRetries: 2
          }
        }
      ],
    });

    expect(result).toMatchObject({
      ok: false,
    });
    expect(String(result.error)).toContain("Invalid validation contract");
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
    expect(orchestratorService.supersedeStep).not.toHaveBeenCalled();
    expect(orchestratorService.updateStepDependencies).not.toHaveBeenCalled();
    expect(orchestratorService.appendRuntimeEvent).not.toHaveBeenCalled();
    expect(orchestratorService.appendTimelineEvent).not.toHaveBeenCalled();
    expect(onDagMutation).not.toHaveBeenCalled();
    expect(graph.steps.find((entry: any) => entry.id === "step-legacy")?.status).toBe("pending");
  });
});

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
      text: "Please focus on tests first.",
      priority: "normal"
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

  it("message_worker forwards urgent priority to worker delivery", async () => {
    const sendWorkerMessageToSession = vi.fn(async () => ({
      ok: true,
      delivered: true,
      method: "steer",
    } as const));
    const graph = {
      steps: [
        { id: "step-from", stepKey: "worker-from" },
        { id: "step-to", stepKey: "worker-to" },
      ],
      attempts: [
        { id: "attempt-from", stepId: "step-from", status: "running", executorSessionId: "session-from" },
        { id: "attempt-to", stepId: "step-to", status: "running", executorSessionId: "session-to" },
      ],
    };
    const { tools } = createTestDeps({ graph, sendWorkerMessageToSession });

    const result = await (tools.message_worker as any).execute({
      fromWorkerId: "worker-from",
      toWorkerId: "worker-to",
      content: "Drop what you're doing and validate this now.",
      priority: "urgent"
    });

    expect(result).toMatchObject({
      ok: true,
      delivered: true,
      method: "steer",
      priority: "urgent"
    });
    expect(sendWorkerMessageToSession).toHaveBeenCalledWith({
      sessionId: "session-to",
      text: "Drop what you're doing and validate this now.",
      priority: "urgent"
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

  it("mark_step_complete remains blocked when validation state is fail", async () => {
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
      ok: false,
      validation: {
        state: "fail"
      }
    });
    expect(String(result.error)).toContain("requires validator pass");
    expect(db.run).not.toHaveBeenCalled();
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

  it("complete_mission remains blocked when required validation is missing", async () => {
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
      ok: false,
      blockers: [
        expect.objectContaining({ stepKey: "impl", validationState: "fail" })
      ]
    });
    expect(String(result.error)).toContain("cannot be completed");
    expect(onRunFinalize).not.toHaveBeenCalled();
    expect(orchestratorService.appendRuntimeEvent).not.toHaveBeenCalled();
  });

  it("spawn_worker blocks phase transition when earlier required phase validation is missing", async () => {
    const phaseCards = [
      {
        id: "phase-build",
        phaseKey: "implementation",
        name: "Implementation",
        description: "Build",
        instructions: "",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: {},
        askQuestions: { enabled: false, mode: "never" },
        validationGate: { tier: "dedicated", required: true, criteria: "Validator must pass" },
        isBuiltIn: true,
        isCustom: false,
        position: 1,
        createdAt: "2026-03-04T00:00:00.000Z",
        updatedAt: "2026-03-04T00:00:00.000Z",
      },
      {
        id: "phase-test",
        phaseKey: "testing",
        name: "Testing",
        description: "Test",
        instructions: "",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: { mustFollow: ["implementation"] },
        askQuestions: { enabled: false, mode: "never" },
        validationGate: { tier: "self", required: false },
        isBuiltIn: true,
        isCustom: false,
        position: 2,
        createdAt: "2026-03-04T00:00:00.000Z",
        updatedAt: "2026-03-04T00:00:00.000Z",
      },
    ];
    const graph = {
      run: {
        metadata: {
          phaseRuntime: {
            currentPhaseKey: "testing",
            currentPhaseName: "Testing",
            currentPhaseModel: {
              provider: "openai",
              modelId: "openai/gpt-5.3-codex",
            },
          }
        }
      },
      steps: [
        {
          id: "step-build",
          stepKey: "build-api",
          stepIndex: 0,
          title: "Build API",
          laneId: null,
          status: "succeeded",
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          metadata: {
            phaseKey: "implementation",
            phaseName: "Implementation",
            validationContract: {
              level: "step",
              tier: "dedicated",
              required: true,
              criteria: "Validator must pass",
              evidence: [],
              maxRetries: 2,
            },
            validationState: "pending",
          },
        }
      ],
      attempts: [],
    };
    const { tools, orchestratorService } = createCoordinatorHarness({
      graph,
      missionMetadata: {
        phaseConfiguration: {
          selectedPhases: phaseCards,
        }
      }
    });

    const result = await (tools.spawn_worker as any).execute({
      name: "test-followup",
      prompt: "Run the testing phase follow-up",
      dependsOn: ["build-api"],
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'Phase "Implementation" validation gate has not passed. 1 step(s) are missing required validation.',
    });
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
    expect(orchestratorService.appendTimelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        eventType: "validation_gate_blocked",
        reason: "required_validation_gate_blocked",
      })
    );
    expect(orchestratorService.appendRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        eventType: "validation_gate_blocked",
      })
    );
    expect(orchestratorService.emitRuntimeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        reason: "validation_gate_blocked",
      })
    );
  });

  it("spawn_worker reads phase cards from run metadata when blocking validation workers outside the validation phase", async () => {
    const phaseCards = [
      {
        id: "phase-planning",
        phaseKey: "planning",
        name: "Planning",
        description: "Research",
        instructions: "",
        model: { provider: "anthropic", modelId: "anthropic/claude-sonnet-4-6" },
        budget: {},
        orderingConstraints: { mustBeFirst: true },
        askQuestions: { enabled: false, mode: "never" },
        validationGate: { tier: "self", required: true },
        isBuiltIn: true,
        isCustom: false,
        position: 1,
        createdAt: "2026-03-02T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      },
      {
        id: "phase-development",
        phaseKey: "development",
        name: "Development",
        description: "Build",
        instructions: "",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: { mustFollow: ["planning"] },
        askQuestions: { enabled: false, mode: "never" },
        validationGate: { tier: "dedicated", required: false },
        isBuiltIn: true,
        isCustom: false,
        position: 2,
        createdAt: "2026-03-02T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      },
      {
        id: "phase-validation",
        phaseKey: "validation",
        name: "Validation",
        description: "Verify",
        instructions: "",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: { mustFollow: ["development"] },
        askQuestions: { enabled: false, mode: "never" },
        validationGate: { tier: "self", required: false },
        isBuiltIn: true,
        isCustom: false,
        position: 3,
        createdAt: "2026-03-02T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      },
    ];
    const { tools, orchestratorService } = createCoordinatorHarness({
      graph: {
        run: {
          metadata: {
            phaseRuntime: {
              currentPhaseKey: "development",
              currentPhaseName: "Development",
              currentPhaseModel: {
                modelId: "openai/gpt-5.3-codex",
                provider: "openai",
              },
            },
            phaseConfiguration: {
              selectedPhases: phaseCards,
            },
          },
        },
        steps: [],
        attempts: [],
      },
    });

    const result = await (tools.spawn_worker as any).execute({
      name: "validate-test-tab",
      prompt: "You are a validation worker. Use report_validation with verdict \"pass\" or \"fail\".",
      dependsOn: [],
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('Validation workers can only be spawned during the "validation" phase.'),
    });
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
  });

  it("spawn_worker reads raw phaseOverride arrays from run metadata", async () => {
    const phaseCards = [
      {
        id: "phase-development",
        phaseKey: "development",
        name: "Development",
        description: "Build",
        instructions: "",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: {},
        askQuestions: { enabled: false, mode: "never" },
        validationGate: { tier: "dedicated", required: false },
        isBuiltIn: true,
        isCustom: false,
        position: 1,
        createdAt: "2026-03-02T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      },
      {
        id: "phase-validation",
        phaseKey: "validation",
        name: "Validation",
        description: "Verify",
        instructions: "",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: { mustFollow: ["development"] },
        askQuestions: { enabled: false, mode: "never" },
        validationGate: { tier: "self", required: false },
        isBuiltIn: true,
        isCustom: false,
        position: 2,
        createdAt: "2026-03-02T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      },
    ];
    const { tools, orchestratorService } = createCoordinatorHarness({
      graph: {
        run: {
          metadata: {
            phaseRuntime: {
              currentPhaseKey: "development",
              currentPhaseName: "Development",
              currentPhaseModel: {
                modelId: "openai/gpt-5.3-codex",
                provider: "openai",
              },
            },
            phaseOverride: phaseCards,
          },
        },
        steps: [],
        attempts: [],
      },
    });

    const result = await (tools.spawn_worker as any).execute({
      name: "validate-tab",
      prompt: "You are a validation worker. Use report_validation with verdict \"pass\" or \"fail\".",
      dependsOn: [],
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('Validation workers can only be spawned during the "validation" phase.'),
    });
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
  });

  it("request_specialist fails closed when mission phases are configured but current phase is unset", async () => {
    const phaseCards = [
      {
        id: "phase-development",
        phaseKey: "development",
        name: "Development",
        description: "Build",
        instructions: "",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: {},
        askQuestions: { enabled: false, mode: "never" },
        validationGate: { tier: "dedicated", required: false },
        isBuiltIn: true,
        isCustom: false,
        position: 1,
        createdAt: "2026-03-02T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      },
    ];
    const { tools, orchestratorService } = createCoordinatorHarness({
      graph: {
        run: {
          metadata: {
            phaseConfiguration: {
              selectedPhases: phaseCards,
            },
            teamRuntime: {
              enabled: true,
              template: {
                roles: [
                  {
                    name: "validator",
                    capabilities: ["validation"],
                  }
                ]
              }
            }
          }
        },
        steps: [],
        attempts: [],
      },
    });

    const result = await (tools.request_specialist as any).execute({
      role: "validator",
      objective: "Validate the implementation.",
      reason: "Need an independent pass.",
      dependsOn: [],
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("current phase is unset"),
    });
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
  });

  it("delegate_to_subagent enforces the current phase model on explicit overrides", async () => {
    const phaseCards = [
      {
        id: "phase-development",
        phaseKey: "development",
        name: "Development",
        description: "Build",
        instructions: "",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: {},
        askQuestions: { enabled: false, mode: "never" },
        validationGate: { tier: "dedicated", required: false },
        isBuiltIn: true,
        isCustom: false,
        position: 1,
        createdAt: "2026-03-02T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      },
    ];
    const { tools, orchestratorService } = createCoordinatorHarness({
      graph: {
        run: {
          metadata: {
            phaseConfiguration: {
              selectedPhases: phaseCards,
            },
            phaseRuntime: {
              currentPhaseKey: "development",
              currentPhaseName: "Development",
              currentPhaseModel: {
                modelId: "openai/gpt-5.3-codex",
                provider: "openai",
              },
            },
          },
        },
        steps: [
          {
            id: "step-parent",
            stepKey: "parent-worker",
            stepIndex: 0,
            title: "Parent Worker",
            laneId: "lane-parent",
            status: "running",
            dependencyStepIds: [],
            retryLimit: 1,
            retryCount: 0,
            metadata: {},
          },
        ],
        attempts: [],
      },
    });

    const result = await (tools.delegate_to_subagent as any).execute({
      parentWorkerId: "parent-worker",
      name: "security-reviewer",
      prompt: "Review auth edge cases.",
      modelId: "anthropic/claude-sonnet-4-6",
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('Current phase "Development" is configured for model "openai/gpt-5.3-codex".'),
    });
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
  });

  it("delegate_parallel enforces the current phase model on explicit overrides", async () => {
    const phaseCards = [
      {
        id: "phase-development",
        phaseKey: "development",
        name: "Development",
        description: "Build",
        instructions: "",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: {},
        askQuestions: { enabled: false, mode: "never" },
        validationGate: { tier: "dedicated", required: false },
        isBuiltIn: true,
        isCustom: false,
        position: 1,
        createdAt: "2026-03-02T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      },
    ];
    const { tools, orchestratorService } = createCoordinatorHarness({
      graph: {
        run: {
          metadata: {
            phaseConfiguration: {
              selectedPhases: phaseCards,
            },
            phaseRuntime: {
              currentPhaseKey: "development",
              currentPhaseName: "Development",
              currentPhaseModel: {
                modelId: "openai/gpt-5.3-codex",
                provider: "openai",
              },
            },
          },
        },
        steps: [
          {
            id: "step-parent",
            stepKey: "parent-worker",
            stepIndex: 0,
            title: "Parent Worker",
            laneId: "lane-parent",
            status: "running",
            dependencyStepIds: [],
            retryLimit: 1,
            retryCount: 0,
            metadata: {},
          },
        ],
        attempts: [],
      },
    });

    const result = await (tools.delegate_parallel as any).execute({
      parentWorkerId: "parent-worker",
      tasks: [
        { name: "mismatch", prompt: "Review auth edge cases.", modelId: "anthropic/claude-sonnet-4-6" },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('Current phase "Development" is configured for model "openai/gpt-5.3-codex".'),
    });
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
  });

  it("revise_plan enforces the current phase model on new replacement steps", async () => {
    const phaseCards = [
      {
        id: "phase-development",
        phaseKey: "development",
        name: "Development",
        description: "Build",
        instructions: "",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: {},
        askQuestions: { enabled: false, mode: "never" },
        validationGate: { tier: "dedicated", required: false },
        isBuiltIn: true,
        isCustom: false,
        position: 1,
        createdAt: "2026-03-02T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      },
    ];
    const { tools, orchestratorService } = createCoordinatorHarness({
      graph: {
        run: {
          metadata: {
            phaseConfiguration: {
              selectedPhases: phaseCards,
            },
            phaseRuntime: {
              currentPhaseKey: "development",
              currentPhaseName: "Development",
              currentPhaseModel: {
                modelId: "openai/gpt-5.3-codex",
                provider: "openai",
              },
            },
          },
        },
        steps: [
          {
            id: "step-legacy",
            stepKey: "legacy",
            stepIndex: 0,
            title: "Legacy",
            laneId: null,
            status: "pending",
            dependencyStepIds: [],
            retryLimit: 1,
            retryCount: 0,
            metadata: {}
          }
        ],
        attempts: [],
      },
    });

    const result = await (tools.revise_plan as any).execute({
      mode: "partial",
      replaceStepKeys: ["legacy"],
      replacementMap: [],
      dependencyPatches: [],
      reason: "Need better plan.",
      newSteps: [
        {
          key: "replacement",
          title: "Replacement",
          description: "Implement replacement task.",
          dependsOn: [],
          modelId: "anthropic/claude-sonnet-4-6",
          replaces: ["legacy"]
        }
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('Current phase "Development" is configured for model "openai/gpt-5.3-codex".'),
    });
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
  });
});

describe("coordinatorTools live coordinator report notifications", () => {
  it("report_status emits a runtime update for the coordinator live path", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [
        {
          id: "step-1",
          stepKey: "worker-1",
          stepIndex: 0,
          title: "Worker 1",
          status: "running",
          laneId: "lane-1",
          metadata: {},
        },
      ],
      attempts: [],
    };
    const { tools, orchestratorService } = createCoordinatorHarness({ graph });

    const result = await (tools.report_status as any).execute({
      workerId: "worker-1",
      progressPct: 55,
      blockers: ["waiting on integration detail"],
      confidence: 0.7,
      nextAction: "finish the adapter",
      details: "Worker is halfway through the adapter rewrite.",
    });

    expect(result).toMatchObject({ ok: true });
    expect(orchestratorService.emitRuntimeUpdate).toHaveBeenCalledWith({
      runId: "run-1",
      stepId: "step-1",
      reason: "worker_status_report",
    });
  });

  it("report_result emits a runtime update for the coordinator live path", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [
        {
          id: "step-1",
          stepKey: "worker-1",
          stepIndex: 0,
          title: "Worker 1",
          status: "running",
          laneId: "lane-1",
          metadata: {},
        },
      ],
      attempts: [],
    };
    const { tools, orchestratorService } = createCoordinatorHarness({ graph });

    const result = await (tools.report_result as any).execute({
      workerId: "worker-1",
      outcome: "succeeded",
      summary: "Finished the adapter rewrite and updated tests.",
      artifacts: [],
      filesChanged: ["src/adapter.ts", "src/adapter.test.ts"],
      testsRun: {
        command: "npm test -- adapter",
        passed: 4,
        failed: 0,
        skipped: 0,
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(orchestratorService.emitRuntimeUpdate).toHaveBeenCalledWith({
      runId: "run-1",
      stepId: "step-1",
      reason: "worker_result_report",
    });
  });

  it("report_validation emits a runtime update for the coordinator live path", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [
        {
          id: "step-target",
          stepKey: "worker-target",
          stepIndex: 0,
          title: "Target worker",
          status: "succeeded",
          laneId: "lane-1",
          metadata: {
            validationContract: {
              level: "step",
              tier: "dedicated",
              required: true,
              criteria: "Validation must pass.",
              evidence: [],
              maxRetries: 2,
            },
          },
        },
        {
          id: "step-validator",
          stepKey: "validator-1",
          stepIndex: 1,
          title: "Validator",
          status: "running",
          laneId: "lane-1",
          metadata: {},
        },
      ],
      attempts: [],
    };
    const { tools, orchestratorService } = createCoordinatorHarness({ graph });

    const result = await (tools.report_validation as any).execute({
      validatorWorkerId: "validator-1",
      targetWorkerId: "worker-target",
      verdict: "pass",
      summary: "Validation passed cleanly.",
      findings: [],
      remediationInstructions: [],
    });

    expect(result).toMatchObject({ ok: true });
    expect(orchestratorService.emitRuntimeUpdate).toHaveBeenCalledWith({
      runId: "run-1",
      stepId: "step-target",
      reason: "validation_report",
    });
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

  it("tolerates omitted dependency arrays from provider tool calls", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [],
      attempts: []
    };
    const { tools, orchestratorService } = createCoordinatorHarness({ graph });

    const result = await (tools.insert_milestone as any).execute({
      name: "API Milestone",
      validationCriteria: "Integration tests pass and validator signs off",
    });

    expect(result).toMatchObject({
      ok: true,
      milestone: expect.objectContaining({
        name: "API Milestone",
      }),
      dependsOn: [],
      gatesStepsPatched: [],
    });
    expect(orchestratorService.addSteps).toHaveBeenCalledTimes(1);
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

describe("coordinatorTools reflection_add", () => {
  it("records reflection entries with inferred worker scope", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [
        {
          id: "step-impl",
          stepKey: "impl-worker",
          stepIndex: 0,
          title: "Implementation",
          laneId: null,
          status: "running",
          dependencyStepIds: [],
          retryLimit: 2,
          retryCount: 0,
          metadata: {},
        },
      ],
      attempts: [
        {
          id: "attempt-running",
          stepId: "step-impl",
          status: "running",
          createdAt: "2026-03-05T00:00:00.000Z",
          completedAt: null,
        },
      ],
    };
    const { tools, orchestratorService } = createCoordinatorHarness({ graph });

    const result = await (tools.reflection_add as any).execute({
      workerId: "impl-worker",
      phase: "development",
      signalType: "frustration",
      observation: "Typecheck loop is slow",
      recommendation: "Use incremental mode",
      context: "editing auth flow",
    });

    expect(result).toMatchObject({
      ok: true,
      reflection: expect.objectContaining({ id: "reflection-1" })
    });
    expect(orchestratorService.addReflection).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: "mission-1",
        runId: "run-1",
        stepId: "step-impl",
        attemptId: "attempt-running",
        phase: "development",
        signalType: "frustration",
        observation: "Typecheck loop is slow",
        recommendation: "Use incremental mode",
        context: "editing auth flow",
        agentRole: "coordinator"
      })
    );
  });
});

describe("coordinatorTools retry_step safety", () => {
  it("rejects retry when an attempt is still running to prevent overlapping execution", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [
        {
          id: "step-1",
          stepKey: "worker-1",
          stepIndex: 0,
          title: "Worker 1",
          laneId: null,
          status: "failed",
          dependencyStepIds: [],
          retryLimit: 2,
          retryCount: 1,
          metadata: { instructions: "old" },
        },
      ],
      attempts: [
        {
          id: "attempt-running",
          stepId: "step-1",
          status: "running",
          executorSessionId: "session-1",
        },
      ],
    };
    const { tools, db } = createCoordinatorHarness({ graph });

    const result = await (tools.retry_step as any).execute({
      workerId: "worker-1",
      adjustedInstructions: "Try again with stricter validation.",
    });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("still running");
    expect(db.run).not.toHaveBeenCalled();
  });

  it("requires a failed or terminal source step before retrying", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [
        {
          id: "step-1",
          stepKey: "worker-1",
          stepIndex: 0,
          title: "Worker 1",
          laneId: null,
          status: "ready",
          dependencyStepIds: [],
          retryLimit: 2,
          retryCount: 0,
          metadata: { instructions: "old" },
        },
      ],
      attempts: [],
    };
    const { tools, db } = createCoordinatorHarness({ graph });

    const result = await (tools.retry_step as any).execute({
      workerId: "worker-1",
      adjustedInstructions: "Retry instructions.",
    });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("failed or terminal");
    expect(db.run).not.toHaveBeenCalled();
  });
});

describe("coordinatorTools revise_plan validation atomicity", () => {
  it("tolerates omitted replacement and dependency arrays from provider tool calls", async () => {
    const { tools, orchestratorService } = createCoordinatorHarness({
      graph: {
        run: { metadata: {} },
        steps: [],
        attempts: [],
      },
      missionLaneId: "lane-mission",
    });

    const result = await (tools.revise_plan as any).execute({
      mode: "partial",
      reason: "Need a minimal plan revision.",
      newSteps: [
        {
          key: "implement-sidebar",
          title: "Implement sidebar",
          description: "Add the test tab and placeholder screen.",
        }
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      newStepKeys: ["implement-sidebar"],
    });
    expect(orchestratorService.addSteps).toHaveBeenCalled();
  });

  it("validates replacementMap targets before creating any new steps", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [
        {
          id: "step-old",
          stepKey: "old-worker",
          stepIndex: 0,
          title: "Old worker",
          laneId: null,
          status: "pending",
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          metadata: {},
        },
      ],
      attempts: [],
    };
    const { tools, orchestratorService, graph: mutableGraph, onDagMutation } = createCoordinatorHarness({ graph });

    const result = await (tools.revise_plan as any).execute({
      mode: "partial",
      replaceStepKeys: ["old-worker"],
      replacementMap: [{ oldStepKey: "old-worker", newStepKey: "missing-new-step" }],
      dependencyPatches: [],
      reason: "Need a better worker split",
      newSteps: [
        {
          key: "new-worker",
          title: "New worker",
          description: "Implement replacement flow",
          dependsOn: [],
          replaces: ["old-worker"],
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("replacementMap references unknown newStepKey");
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
    expect(mutableGraph.steps).toHaveLength(1);
    expect(onDagMutation).not.toHaveBeenCalled();
  });

  it("validates dependency patches before mutating the graph", async () => {
    const graph = {
      run: { metadata: {} },
      steps: [
        {
          id: "step-old",
          stepKey: "old-worker",
          stepIndex: 0,
          title: "Old worker",
          laneId: null,
          status: "pending",
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          metadata: {},
        },
      ],
      attempts: [],
    };
    const { tools, orchestratorService, graph: mutableGraph } = createCoordinatorHarness({ graph });

    const result = await (tools.revise_plan as any).execute({
      mode: "partial",
      replaceStepKeys: ["old-worker"],
      replacementMap: [],
      dependencyPatches: [
        {
          stepKey: "new-worker",
          dependencyStepKeys: ["unknown-dependency"],
        },
      ],
      reason: "Rewire dependencies",
      newSteps: [
        {
          key: "new-worker",
          title: "New worker",
          description: "Implement replacement flow",
          dependsOn: [],
          replaces: ["old-worker"],
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("unknown dependency keys");
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
    expect(mutableGraph.steps).toHaveLength(1);
  });
});

describe("coordinatorTools hard-cap fail-closed behavior", () => {
  it("blocks spawn_worker when budget telemetry fails", async () => {
    const onHardCapTriggered = vi.fn();
    const { tools, orchestratorService } = createCoordinatorHarness({
      graph: { run: { metadata: {} }, steps: [], attempts: [] },
      getMissionBudgetStatus: async () => {
        throw new Error("telemetry offline");
      },
      onHardCapTriggered,
    });

    const result = await (tools.spawn_worker as any).execute({
      name: "blocked-worker",
      provider: "claude",
      prompt: "Do work",
      dependsOn: [],
    });

    expect(result).toMatchObject({
      ok: false,
      hardCapTriggered: true,
    });
    expect(String(result.error)).toContain("Budget telemetry unavailable");
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
    expect(onHardCapTriggered).toHaveBeenCalledWith(expect.stringContaining("Budget telemetry unavailable"));
  });

  it("blocks revise_plan spawning when budget telemetry fails", async () => {
    const { tools, orchestratorService } = createCoordinatorHarness({
      graph: {
        run: { metadata: {} },
        steps: [
          {
            id: "step-old",
            stepKey: "old-worker",
            stepIndex: 0,
            title: "Old worker",
            laneId: null,
            status: "pending",
            dependencyStepIds: [],
            retryLimit: 1,
            retryCount: 0,
            metadata: {},
          },
        ],
        attempts: [],
      },
      getMissionBudgetStatus: async () => {
        throw new Error("telemetry unavailable");
      },
    });

    const result = await (tools.revise_plan as any).execute({
      mode: "partial",
      replaceStepKeys: ["old-worker"],
      replacementMap: [],
      dependencyPatches: [],
      reason: "Need alternate approach",
      newSteps: [
        {
          key: "new-worker",
          title: "New worker",
          description: "Replacement implementation",
          dependsOn: [],
          replaces: ["old-worker"],
        },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      hardCapTriggered: true,
    });
    expect(String(result.error)).toContain("Budget telemetry unavailable");
    expect(orchestratorService.addSteps).not.toHaveBeenCalled();
  });
});

describe("coordinatorTools file path containment", () => {
  it("read_file rejects absolute paths that only share a root prefix", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-read-root-"));
    const siblingRoot = `${projectRoot}-evil`;
    fs.mkdirSync(siblingRoot, { recursive: true });
    const outsideFile = path.join(siblingRoot, "secret.txt");
    fs.writeFileSync(outsideFile, "leak", "utf-8");
    const { tools } = createCoordinatorHarness({
      graph: { run: { metadata: {} }, steps: [], attempts: [] },
      projectRoot,
    });

    const result = await (tools.read_file as any).execute({
      filePath: outsideFile,
    });

    expect(result).toMatchObject({
      ok: false,
      error: "Path is outside project root",
    });
  });

  it("read_step_output sanitizes traversal-like keys and reads only project-scoped output", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-step-output-root-"));
    const maliciousKey = "../../sensitive";
    const sanitized = maliciousKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    const outputDir = path.join(projectRoot, ".ade");
    fs.mkdirSync(outputDir, { recursive: true });
    const scopedFile = path.join(outputDir, `step-output-${sanitized}.md`);
    fs.writeFileSync(scopedFile, "scoped output", "utf-8");

    const { tools } = createCoordinatorHarness({
      graph: { run: { metadata: {} }, steps: [], attempts: [] },
      projectRoot,
    });

    const result = await (tools.read_step_output as any).execute({
      stepKey: maliciousKey,
    });

    expect(result).toMatchObject({
      ok: true,
      stepKey: maliciousKey,
      content: "scoped output",
    });
  });
});

describe("coordinatorTools completion DAG events", () => {
  it("does not skip pending/ready/blocked steps when complete_mission is blocked by runtime gates", async () => {
    const graph = {
      run: { metadata: { teamRuntime: { policyOverrides: { requireValidatorPass: false } } } },
      steps: [
        {
          id: "step-pending",
          stepKey: "pending-step",
          stepIndex: 0,
          title: "Pending",
          laneId: null,
          status: "pending",
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          metadata: {},
        },
        {
          id: "step-ready",
          stepKey: "ready-step",
          stepIndex: 1,
          title: "Ready",
          laneId: null,
          status: "ready",
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          metadata: {},
        },
        {
          id: "step-blocked",
          stepKey: "blocked-step",
          stepIndex: 2,
          title: "Blocked",
          laneId: null,
          status: "blocked",
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          metadata: {},
        },
      ],
      attempts: [],
    };
    const { tools, onDagMutation, orchestratorService } = createCoordinatorHarness({
      graph,
      finalizeRunResult: {
        finalized: false,
        blockers: ["Required phase \"Development\" has not succeeded yet."],
        finalStatus: "completing",
      },
    });

    const result = await (tools.complete_mission as any).execute({ summary: "Mission complete" });

    expect(result).toMatchObject({
      ok: false,
      blockers: ["Required phase \"Development\" has not succeeded yet."],
    });
    const skipEvents = onDagMutation.mock.calls
      .map((call) => call[0]?.mutation)
      .filter((mutation: any) => mutation?.type === "status_changed" && mutation?.newStatus === "skipped");
    expect(skipEvents).toHaveLength(0);
    expect(orchestratorService.finalizeRun).toHaveBeenCalledWith({ runId: "run-1" });
  });
});

describe("coordinatorTools autopilot scheduling logging", () => {
  it("logs debug context when retry_step autopilot scheduling fails", async () => {
    vi.useFakeTimers();
    try {
      const graph = {
        run: { metadata: {} },
        steps: [
          {
            id: "step-1",
            stepKey: "worker-1",
            stepIndex: 0,
            title: "Worker 1",
            laneId: null,
            status: "failed",
            dependencyStepIds: [],
            retryLimit: 2,
            retryCount: 1,
            metadata: { instructions: "old" },
          },
        ],
        attempts: [],
      };
      const { tools, orchestratorService, logger } = createCoordinatorHarness({ graph });
      orchestratorService.startReadyAutopilotAttempts.mockRejectedValueOnce(new Error("queue unavailable"));

      const result = await (tools.retry_step as any).execute({
        workerId: "worker-1",
        adjustedInstructions: "Retry with safer ordering.",
      });

      expect(result.ok).toBe(true);
      await vi.runAllTimersAsync();
      expect(logger.debug).toHaveBeenCalledWith(
        "coordinator.retry_step.autopilot_schedule_failed",
        expect.objectContaining({
          runId: "run-1",
          workerId: "worker-1",
          error: "queue unavailable",
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
