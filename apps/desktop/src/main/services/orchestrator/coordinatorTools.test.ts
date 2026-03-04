import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    emitRuntimeUpdate: vi.fn(),
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
  it("emits status_changed DAG events when complete_mission skips pending/ready/blocked steps", async () => {
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
    const { tools, onDagMutation } = createCoordinatorHarness({ graph });

    const result = await (tools.complete_mission as any).execute({ summary: "Mission complete" });

    expect(result.ok).toBe(true);
    const skipEvents = onDagMutation.mock.calls
      .map((call) => call[0]?.mutation)
      .filter((mutation: any) => mutation?.type === "status_changed" && mutation?.newStatus === "skipped");
    expect(skipEvents).toHaveLength(3);
    expect(skipEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepKey: "pending-step" }),
        expect.objectContaining({ stepKey: "ready-step" }),
        expect.objectContaining({ stepKey: "blocked-step" }),
      ])
    );
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
