import { describe, expect, it } from "vitest";
import type {
  MissionDetail,
  OrchestratorArtifact,
  OrchestratorRunGraph,
  OrchestratorWorkerCheckpoint,
  PhaseCard,
} from "../../../shared/types";
import {
  buildMissionArtifactGroups,
  deriveActivePhaseViewModel,
} from "./missionControlViewModel";

function makePhase(overrides: Partial<PhaseCard> = {}): PhaseCard {
  return {
    id: "phase-planning",
    phaseKey: "planning",
    name: "Planning",
    description: "Plan the work",
    instructions: "Research before implementation.",
    model: { modelId: "anthropic/claude-sonnet-4-6", provider: "claude" },
    budget: {},
    orderingConstraints: {},
    askQuestions: { enabled: false, mode: "never" },
    validationGate: { tier: "none", required: false },
    isBuiltIn: true,
    isCustom: false,
    position: 1,
    createdAt: "2026-03-09T00:00:00.000Z",
    updatedAt: "2026-03-09T00:00:00.000Z",
    ...overrides,
  };
}

function makeMission(phases: PhaseCard[]): MissionDetail {
  return {
    id: "mission-1",
    title: "Mission",
    prompt: "Ship it",
    status: "in_progress",
    priority: "normal",
    executionMode: "local",
    targetMachineId: null,
    outcomeSummary: null,
    lastError: null,
    artifactCount: 0,
    openInterventions: 0,
    laneId: "lane-1",
    laneName: "mission/lane-1",
    totalSteps: 2,
    completedSteps: 0,
    startedAt: "2026-03-09T00:00:00.000Z",
    completedAt: null,
    createdAt: "2026-03-09T00:00:00.000Z",
    updatedAt: "2026-03-09T00:00:00.000Z",
    artifacts: [],
    interventions: [],
    steps: [],
    events: [],
    phaseConfiguration: {
      profile: null,
      override: null,
      selectedPhases: phases,
    },
  };
}

function makeRunGraph(phases: PhaseCard[]): OrchestratorRunGraph {
  return {
    run: {
      id: "run-1",
      missionId: "mission-1",
      projectId: "project-1",
      status: "active",
      contextProfile: "orchestrator_deterministic_v1",
      schedulerState: "active",
      createdAt: "2026-03-09T00:00:00.000Z",
      updatedAt: "2026-03-09T00:00:00.000Z",
      startedAt: "2026-03-09T00:00:00.000Z",
      completedAt: null,
      lastError: null,
      metadata: {
        missionGoal: "Ship it",
        phaseOverride: phases,
        phaseRuntime: {
          currentPhaseKey: "validation",
          currentPhaseName: "Validation",
        },
      },
    },
    steps: [
      {
        id: "step-plan",
        runId: "run-1",
        missionStepId: null,
        stepKey: "plan",
        stepIndex: 0,
        title: "Planning step",
        laneId: "lane-1",
        status: "succeeded",
        joinPolicy: "all_success",
        quorumCount: null,
        dependencyStepIds: [],
        retryLimit: 1,
        retryCount: 0,
        lastAttemptId: null,
        createdAt: "2026-03-09T00:00:00.000Z",
        updatedAt: "2026-03-09T00:00:00.000Z",
        startedAt: "2026-03-09T00:00:00.000Z",
        completedAt: "2026-03-09T00:01:00.000Z",
        metadata: { phaseKey: "planning", phaseName: "Planning", phasePosition: 1 },
      },
      {
        id: "step-validate",
        runId: "run-1",
        missionStepId: null,
        stepKey: "validate",
        stepIndex: 1,
        title: "Validation step",
        laneId: "lane-1",
        status: "running",
        joinPolicy: "all_success",
        quorumCount: null,
        dependencyStepIds: ["step-plan"],
        retryLimit: 1,
        retryCount: 0,
        lastAttemptId: null,
        createdAt: "2026-03-09T00:00:00.000Z",
        updatedAt: "2026-03-09T00:00:00.000Z",
        startedAt: "2026-03-09T00:01:00.000Z",
        completedAt: null,
        metadata: { phaseKey: "validation", phaseName: "Validation", phasePosition: 2 },
      },
    ],
    attempts: [],
    claims: [],
    contextSnapshots: [],
    handoffs: [],
    timeline: [],
    runtimeEvents: [],
  };
}

describe("deriveActivePhaseViewModel", () => {
  it("resolves the active phase from the run snapshot and exposes exit requirements", () => {
    const phases = [
      makePhase(),
      makePhase({
        id: "phase-validation",
        phaseKey: "validation",
        name: "Validation",
        position: 2,
        validationGate: {
          tier: "dedicated",
          required: true,
          evidenceRequirements: ["screenshot"],
          capabilityFallback: "block",
        },
      }),
    ];
    const vm = deriveActivePhaseViewModel({
      mission: makeMission(phases),
      runGraph: makeRunGraph(phases),
      modelCapabilities: { profiles: [] },
    });

    expect(vm?.phase?.phaseKey).toBe("validation");
    expect(vm?.position).toBe(2);
    expect(vm?.validationRequired).toBe(true);
    expect(vm?.exitRequirements.some((entry) => entry.includes("remaining validation step"))).toBe(true);
    expect(vm?.capabilityWarnings[0]).toContain("screenshot");
  });
});

describe("buildMissionArtifactGroups", () => {
  it("merges mission artifacts, orchestrator artifacts, checkpoints, and missing expected evidence", () => {
    const phases = [
      makePhase({
        id: "phase-validation",
        phaseKey: "validation",
        name: "Validation",
        validationGate: {
          tier: "dedicated",
          required: true,
          evidenceRequirements: ["screenshot", "console_logs"],
          capabilityFallback: "block",
        },
      }),
    ];
    const mission = makeMission(phases);
    mission.artifacts = [
      {
        id: "mission-artifact-1",
        missionId: "mission-1",
        artifactType: "summary",
        title: "Planning summary",
        description: "Planner notes",
        uri: null,
        laneId: "lane-1",
        createdBy: "planner",
        createdAt: "2026-03-09T00:00:00.000Z",
        updatedAt: "2026-03-09T00:00:00.000Z",
        metadata: { phaseKey: "planning", phaseName: "Planning" },
      },
    ];
    const runGraph = makeRunGraph(phases);
    const orchestratorArtifacts: OrchestratorArtifact[] = [
      {
        id: "orch-artifact-1",
        missionId: "mission-1",
        runId: "run-1",
        stepId: "step-validate",
        attemptId: "attempt-1",
        artifactKey: "console_logs",
        kind: "custom",
        value: "Console captured",
        metadata: {},
        declared: true,
        createdAt: "2026-03-09T00:02:00.000Z",
      },
    ];
    const checkpoints: OrchestratorWorkerCheckpoint[] = [
      {
        id: "checkpoint-1",
        missionId: "mission-1",
        runId: "run-1",
        stepId: "step-validate",
        attemptId: "attempt-1",
        stepKey: "validate",
        content: "Checkpoint body",
        filePath: "/tmp/checkpoint.md",
        createdAt: "2026-03-09T00:03:00.000Z",
        updatedAt: "2026-03-09T00:03:00.000Z",
      },
    ];

    const grouped = buildMissionArtifactGroups({
      mission,
      runGraph,
      orchestratorArtifacts,
      checkpoints,
    });

    expect(grouped.all.some((entry) => entry.source === "mission")).toBe(true);
    expect(grouped.all.some((entry) => entry.source === "checkpoint")).toBe(true);
    expect(grouped.all.some((entry) => entry.artifactType === "console_logs")).toBe(true);
    expect(grouped.all.some((entry) => entry.artifactType === "screenshot" && entry.missingExpectedEvidence)).toBe(true);
  });

  it("prefers orchestrator artifact metadata titles when present", () => {
    const phases = [makePhase()];
    const runGraph = makeRunGraph(phases);
    const grouped = buildMissionArtifactGroups({
      mission: makeMission(phases),
      runGraph,
      orchestratorArtifacts: [
        {
          id: "orch-artifact-2",
          missionId: "mission-1",
          runId: "run-1",
          stepId: "step-plan",
          attemptId: "attempt-2",
          artifactKey: "step_summary",
          kind: "custom",
          value: "Planner discovered two workstreams.",
          metadata: {
            title: "Planner output",
            summary: "Planner discovered two workstreams.",
          },
          declared: false,
          createdAt: "2026-03-09T00:04:00.000Z",
        },
      ],
      checkpoints: [],
    });

    expect(grouped.all[0]?.title).toBe("Planner output");
    expect(grouped.all[0]?.description).toBe("Planner discovered two workstreams.");
  });
});
