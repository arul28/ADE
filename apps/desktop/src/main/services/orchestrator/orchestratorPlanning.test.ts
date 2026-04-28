import { describe, expect, it } from "vitest";
import type { DelegationContract, OrchestratorRunGraph, OrchestratorStep } from "../../../shared/types";
import {
  deriveMissionStatusFromRun,
  filterExecutionSteps,
  isDisplayOnlyTaskStep,
  parseChatTarget,
  sanitizeChatTarget,
  teammateThreadIdentity,
  deriveThreadTitle,
} from "./orchestratorContext";
import {
  checkCoordinatorToolPermission,
  createDelegationContract,
  createDelegationScope,
  deriveCoordinatorCapabilities,
  derivePlanningStartupStateFromContract,
  extractActiveDelegationContracts,
  hasConflictingDelegationContract,
} from "./delegationContracts";

describe("orchestratorContext teammate chat target handling", () => {
  it("parses teammate targets from persisted JSON payloads", () => {
    const parsed = parseChatTarget({
      kind: "teammate",
      runId: "run-1",
      teamMemberId: "tm-1",
      sessionId: "session-1",
    });

    expect(parsed).toEqual({
      kind: "teammate",
      runId: "run-1",
      teamMemberId: "tm-1",
      sessionId: "session-1",
    });
  });

  it("sanitizes teammate targets without dropping routing fields", () => {
    const sanitized = sanitizeChatTarget({
      kind: "teammate",
      runId: " run-1 ",
      teamMemberId: " tm-1 ",
      sessionId: " session-1 ",
    });

    expect(sanitized).toEqual({
      kind: "teammate",
      runId: "run-1",
      teamMemberId: "tm-1",
      sessionId: "session-1",
    });
  });

  it("builds teammate thread identity and title", () => {
    const target = {
      kind: "teammate" as const,
      runId: "run-1",
      teamMemberId: "tm-1",
      sessionId: "session-1",
    };

    expect(teammateThreadIdentity(target)).toBe("tm-1");
    expect(deriveThreadTitle({ target, step: null, lane: null })).toBe("Teammate: tm-1");
  });
});

describe("deriveMissionStatusFromRun", () => {
  it("keeps missions intervention_required while blocking manual input is open", () => {
    const status = deriveMissionStatusFromRun(
      {
        run: { status: "active" },
        steps: [],
        attempts: [],
        timeline: [],
        claims: [],
      } as any,
      {
        status: "in_progress",
        interventions: [
          {
            id: "iv-1",
            missionId: "mission-1",
            interventionType: "manual_input",
            status: "open",
            title: "Need answer",
            body: "Question",
            requestedAction: null,
            resolutionNote: null,
            laneId: null,
            createdAt: "",
            updatedAt: "",
            resolvedAt: null,
            metadata: { canProceedWithoutAnswer: false },
          },
        ],
      } as any
    );

    expect(status).toBe("intervention_required");
  });

  it("keeps active missions in progress when manual input is optional", () => {
    const status = deriveMissionStatusFromRun(
      {
        run: { status: "active" },
        steps: [],
        attempts: [],
        timeline: [],
        claims: [],
      } as any,
      {
        status: "in_progress",
        interventions: [
          {
            id: "iv-1",
            missionId: "mission-1",
            interventionType: "manual_input",
            status: "open",
            title: "Optional note",
            body: "Question",
            requestedAction: null,
            resolutionNote: null,
            laneId: null,
            createdAt: "",
            updatedAt: "",
            resolvedAt: null,
            metadata: { canProceedWithoutAnswer: true },
          },
        ],
      } as any
    );

    expect(status).toBe("in_progress");
  });

  it("maps canceled runs to canceled missions", () => {
    const status = deriveMissionStatusFromRun(
      {
        run: { status: "canceled" },
        steps: [],
        attempts: [],
        timeline: [],
        claims: [],
      } as any,
      {
        status: "in_progress",
        interventions: [],
      } as any
    );

    expect(status).toBe("canceled");
  });
});

describe("task step helpers", () => {
  it("filters legacy task shell steps without reviving display-only rendering", () => {
    const steps = [
      { id: "task-1", stepKey: "plan", metadata: { isTask: true, stepType: "task" } },
      { id: "step-1", stepKey: "impl", metadata: { stepType: "implementation" } },
    ] as any[];

    expect(isDisplayOnlyTaskStep(steps[0])).toBe(false);
    expect(isDisplayOnlyTaskStep(steps[1])).toBe(false);
    expect(filterExecutionSteps(steps).map((step) => step.stepKey)).toEqual(["impl"]);
  });
});

function createDelegationGraph(args?: {
  steps?: OrchestratorStep[];
}): OrchestratorRunGraph {
  return {
    run: {
      id: "run-1",
      metadata: {},
    },
    steps: args?.steps ?? [],
    attempts: [],
    claims: [],
    contextSnapshots: [],
    handoffs: [],
    timeline: [],
  } as unknown as OrchestratorRunGraph;
}

function createPlannerContract(overrides?: Partial<DelegationContract>): DelegationContract {
  return createDelegationContract({
    contractId: "contract-planner",
    runId: "run-1",
    workerIntent: "planner",
    mode: "exclusive",
    scope: createDelegationScope({
      kind: "phase",
      key: "phase:planning",
      label: "Planning",
    }),
    phaseKey: "planning",
    ...(overrides ?? {}),
  });
}

function createDelegationStep(args?: {
  id?: string;
  stepKey?: string;
  status?: OrchestratorStep["status"];
  metadata?: Record<string, unknown>;
}): OrchestratorStep {
  return {
    id: args?.id ?? "step-1",
    runId: "run-1",
    missionStepId: null,
    stepIndex: 0,
    stepKey: args?.stepKey ?? "planner-worker",
    title: "Planner",
    detail: "Plan the work",
    kind: "planning",
    status: args?.status ?? "pending",
    laneId: null,
    joinPolicy: "all_success",
    quorumCount: null,
    approvalState: null,
    dependsOnStepIds: [],
    dependencyStepIds: [],
    artifactIds: [],
    claimIds: [],
    metadata: args?.metadata ?? {},
    createdAt: "2026-03-13T00:00:00.000Z",
    updatedAt: "2026-03-13T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
  } as unknown as OrchestratorStep;
}

describe("delegationContracts", () => {
  it("derives strict planner capabilities while the planner is active", () => {
    expect(
      deriveCoordinatorCapabilities({
        mode: "exclusive",
        workerIntent: "planner",
        status: "active",
        launchState: "waiting_on_worker",
      }),
    ).toEqual(["observe", "run_control", "update_mission_state"]);
  });

  it("keeps broader coordination capabilities for bounded parallel delegation", () => {
    expect(
      deriveCoordinatorCapabilities({
        mode: "bounded_parallel",
        workerIntent: "specialist",
        status: "active",
      }),
    ).toEqual(
      expect.arrayContaining([
        "observe",
        "read_repo",
        "spawn_top_level_worker",
        "spawn_nested_worker",
        "spawn_parallel_workers",
        "message_workers",
      ]),
    );
  });

  it("blocks coordinator repo exploration while an active planner contract owns planning", () => {
    const contract = createPlannerContract({
      status: "active",
      launchState: "waiting_on_worker",
    });
    const permission = checkCoordinatorToolPermission({
      toolName: "read_file",
      contracts: [contract],
    });
    expect(permission).toMatchObject({
      allowed: false,
      capability: "read_repo",
    });
  });

  it("allows startup-safe tools while planner launch is still in progress", () => {
    const contract = createPlannerContract({
      status: "launching",
      launchState: "fetching_context",
    });
    expect(
      checkCoordinatorToolPermission({
        toolName: "get_project_context",
        contracts: [contract],
      }),
    ).toEqual({ allowed: true });
    expect(
      checkCoordinatorToolPermission({
        toolName: "spawn_worker",
        contracts: [contract],
      }),
    ).toEqual({ allowed: true });
  });

  it("derives active planner contracts from worker step status", () => {
    const contract = createPlannerContract({
      activeWorkerIds: ["planner-worker"],
      status: "launching",
      launchState: "awaiting_worker_launch",
    });
    const graph = createDelegationGraph({
      steps: [
        createDelegationStep({
          id: "step-planner",
          stepKey: "planner-worker",
          status: "running",
          metadata: {
            delegationContract: contract,
          },
        }),
      ],
    });

    expect(extractActiveDelegationContracts(graph)).toEqual([
      expect.objectContaining({
        contractId: "contract-planner",
        status: "active",
        launchState: "waiting_on_worker",
      }),
    ]);
  });

  it("treats planner startup failure contracts as failed planning state", () => {
    const contract = createPlannerContract({
      status: "blocked",
      launchState: "blocked",
    });
    expect(derivePlanningStartupStateFromContract(contract)).toEqual({
      state: "failed",
      contract,
    });
  });

  it("flags conflicting exclusive delegation scopes and allows non-exclusive overlap", () => {
    const existing = createPlannerContract({
      contractId: "contract-existing",
      status: "active",
      launchState: "waiting_on_worker",
    });
    const graph = createDelegationGraph({
      steps: [
        createDelegationStep({
          id: "step-existing",
          stepKey: "planner-worker",
          status: "running",
          metadata: {
            delegationContract: existing,
          },
        }),
      ],
    });

    const exclusiveConflict = hasConflictingDelegationContract({
      graph,
      contract: createDelegationContract({
        contractId: "contract-next",
        runId: "run-1",
        workerIntent: "implementation",
        mode: "exclusive",
        scope: createDelegationScope({
          kind: "phase",
          key: "phase:planning",
        }),
      }),
    });
    expect(exclusiveConflict?.contractId).toBe("contract-existing");

    const boundedExisting = createDelegationContract({
      contractId: "contract-bounded-existing",
      runId: "run-1",
      workerIntent: "specialist",
      mode: "bounded_parallel",
      scope: createDelegationScope({
        kind: "phase",
        key: "phase:planning",
      }),
      activeWorkerIds: ["parallel-worker"],
      status: "active",
      launchState: "waiting_on_worker",
    });
    const boundedGraph = createDelegationGraph({
      steps: [
        createDelegationStep({
          id: "step-bounded",
          stepKey: "parallel-worker",
          status: "running",
          metadata: {
            delegationContract: boundedExisting,
          },
        }),
      ],
    });

    const boundedParallelOverlap = hasConflictingDelegationContract({
      graph: boundedGraph,
      contract: createDelegationContract({
        contractId: "contract-bounded",
        runId: "run-1",
        workerIntent: "specialist",
        mode: "bounded_parallel",
        scope: createDelegationScope({
          kind: "phase",
          key: "phase:planning",
        }),
      }),
    });
    expect(boundedParallelOverlap).toBeNull();
  });
});
