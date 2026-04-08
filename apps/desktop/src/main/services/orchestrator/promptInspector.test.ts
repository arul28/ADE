import { describe, expect, it } from "vitest";
import type {
  OrchestratorAttempt,
  OrchestratorContextSnapshot,
  OrchestratorRunGraph,
  OrchestratorStep,
  OrchestratorStepStatus,
  PhaseCard,
} from "../../../shared/types";
import {
  buildWorkerPromptInspector,
  buildCoordinatorPromptInspector,
  buildPlanningPromptPreview,
} from "./promptInspector";

function makeStep(overrides: Partial<OrchestratorStep> & { id: string }): OrchestratorStep {
  return {
    runId: "run-1",
    missionStepId: null,
    stepKey: overrides.stepKey ?? overrides.id,
    title: overrides.title ?? "Test step",
    status: ("pending" as OrchestratorStepStatus),
    stepIndex: overrides.stepIndex ?? 0,
    dependencyStepIds: [],
    joinPolicy: "all_success",
    quorumCount: null,
    retryLimit: 1,
    retryCount: 0,
    lastAttemptId: null,
    laneId: null,
    metadata: overrides.metadata ?? null,
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<OrchestratorAttempt> & { id: string; stepId: string }): OrchestratorAttempt {
  return {
    runId: "run-1",
    status: "queued",
    executorKind: "opencode",
    executorSessionId: null,
    metadata: {},
    resultEnvelope: null,
    errorMessage: null,
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    ...overrides,
  } as OrchestratorAttempt;
}

function makeRunGraph(overrides: {
  steps?: OrchestratorStep[];
  attempts?: OrchestratorAttempt[];
  contextSnapshots?: OrchestratorContextSnapshot[];
  metadata?: Record<string, unknown>;
} = {}): OrchestratorRunGraph {
  return {
    run: {
      id: "run-1",
      missionId: "mission-1",
      status: "active",
      metadata: {
        missionGoal: "Build the test feature",
        ...overrides.metadata,
      },
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
      startedAt: "2026-03-25T00:00:00.000Z",
      completedAt: null,
    } as unknown as OrchestratorRunGraph["run"],
    steps: overrides.steps ?? [makeStep({ id: "step-1" })],
    attempts: overrides.attempts ?? [],
    claims: [],
    contextSnapshots: overrides.contextSnapshots ?? [],
    handoffs: [],
    timeline: [],
  };
}

function makePhaseCard(overrides: Partial<PhaseCard> = {}): PhaseCard {
  return {
    id: "phase-dev",
    phaseKey: "development",
    name: "Development",
    description: "Implement features",
    instructions: "Write clean code and tests.",
    model: { modelId: "openai/gpt-5.4-codex", thinkingLevel: "medium" },
    budget: {},
    orderingConstraints: {},
    askQuestions: { enabled: false },
    validationGate: { tier: "none", required: false },
    isBuiltIn: true,
    isCustom: false,
    position: 1,
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildWorkerPromptInspector", () => {
  it("returns inspector for a basic step with base guidance and mission goal layers", () => {
    const step = makeStep({ id: "step-1", title: "Implement auth" });
    const graph = makeRunGraph({ steps: [step] });

    const inspector = buildWorkerPromptInspector({ graph, stepId: "step-1" });

    expect(inspector.target).toBe("worker");
    expect(inspector.runId).toBe("run-1");
    expect(inspector.missionId).toBe("mission-1");
    expect(inspector.stepId).toBe("step-1");
    expect(inspector.title).toBe("Implement auth prompt");
    expect(inspector.layers.length).toBeGreaterThanOrEqual(2);

    const baseLayer = inspector.layers.find((l) => l.label === "Base worker system guidance");
    expect(baseLayer).toBeDefined();
    expect(baseLayer!.source).toBe("system_owned");
    expect(baseLayer!.editable).toBe(false);
    expect(baseLayer!.text).toContain('step "Implement auth"');

    const goalLayer = inspector.layers.find((l) => l.label === "Mission goal");
    expect(goalLayer).toBeDefined();
    expect(goalLayer!.text).toBe("Build the test feature");
  });

  it("includes step and phase instructions when present in metadata", () => {
    const step = makeStep({
      id: "step-1",
      metadata: {
        instructions: "Implement the auth module carefully.",
        phaseInstructions: "Follow the development phase rules.",
        phaseKey: "development",
        phaseName: "Development",
      },
    });
    const graph = makeRunGraph({ steps: [step] });

    const inspector = buildWorkerPromptInspector({ graph, stepId: "step-1" });

    const stepLayer = inspector.layers.find((l) => l.label === "Step instructions");
    expect(stepLayer).toBeDefined();
    expect(stepLayer!.text).toBe("Implement the auth module carefully.");

    const phaseLayer = inspector.layers.find((l) => l.label === "Phase instructions");
    expect(phaseLayer).toBeDefined();
    expect(phaseLayer!.text).toBe("Follow the development phase rules.");
  });

  it("includes read-only overlay for readOnlyExecution", () => {
    const step = makeStep({
      id: "step-1",
      metadata: { readOnlyExecution: true },
    });
    const graph = makeRunGraph({ steps: [step] });

    const inspector = buildWorkerPromptInspector({ graph, stepId: "step-1" });

    const overlayLayer = inspector.layers.find((l) => l.label === "Runtime overlays and constraints");
    expect(overlayLayer).toBeDefined();
    expect(overlayLayer!.text).toContain("READ-ONLY");
  });

  it("includes file ownership overlay when filePatterns are present", () => {
    const step = makeStep({
      id: "step-1",
      metadata: { filePatterns: ["src/auth/**", "src/middleware/**"] },
    });
    const graph = makeRunGraph({ steps: [step] });

    const inspector = buildWorkerPromptInspector({ graph, stepId: "step-1" });

    const overlayLayer = inspector.layers.find((l) => l.label === "Runtime overlays and constraints");
    expect(overlayLayer).toBeDefined();
    expect(overlayLayer!.text).toContain("File ownership fence: src/auth/**, src/middleware/**");
  });

  it("includes handoff summaries in overlays", () => {
    const step = makeStep({
      id: "step-1",
      metadata: {
        handoffSummaries: ["Auth module created", "Config updated"],
      },
    });
    const graph = makeRunGraph({ steps: [step] });

    const inspector = buildWorkerPromptInspector({ graph, stepId: "step-1" });

    const overlayLayer = inspector.layers.find((l) => l.label === "Runtime overlays and constraints");
    expect(overlayLayer).toBeDefined();
    expect(overlayLayer!.text).toContain("Auth module created");
    expect(overlayLayer!.text).toContain("Config updated");
  });

  it("includes steering directives layer", () => {
    const step = makeStep({
      id: "step-1",
      metadata: {
        steeringDirectives: [
          { directive: "Prioritize test coverage", priority: "must", targetStepKey: "step-2" },
          { directive: "Use TypeScript strict mode", priority: "suggestion" },
        ],
      },
    });
    const graph = makeRunGraph({ steps: [step] });

    const inspector = buildWorkerPromptInspector({ graph, stepId: "step-1" });

    const steeringLayer = inspector.layers.find((l) => l.label === "Operator steering");
    expect(steeringLayer).toBeDefined();
    expect(steeringLayer!.text).toContain("[must] Prioritize test coverage (target: step-2)");
    expect(steeringLayer!.text).toContain("[suggestion] Use TypeScript strict mode");
  });

  it("includes recovery context from latest attempt error", () => {
    const step = makeStep({ id: "step-1" });
    const attempt = makeAttempt({
      id: "attempt-1",
      stepId: "step-1",
      errorMessage: "Timeout after 5 minutes",
      createdAt: "2026-03-25T01:00:00.000Z",
    });
    const graph = makeRunGraph({ steps: [step], attempts: [attempt] });

    const inspector = buildWorkerPromptInspector({ graph, stepId: "step-1" });

    const overlayLayer = inspector.layers.find((l) => l.label === "Runtime overlays and constraints");
    expect(overlayLayer).toBeDefined();
    expect(overlayLayer!.text).toContain("Timeout after 5 minutes");
  });

  it("includes context snapshot references", () => {
    const step = makeStep({ id: "step-1" });
    const snapshot: OrchestratorContextSnapshot = {
      id: "snap-1",
      runId: "run-1",
      stepId: "step-1",
      attemptId: null,
      snapshotType: "step",
      contextProfile: "implementation",
      cursor: {
        projectPackKey: "project-pack-1",
        projectPackVersionNumber: 3,
        lanePackKey: "lane-pack-1",
        lanePackVersionNumber: 1,
        docs: [{ path: "docs/ARCHITECTURE.md" }],
        contextSources: ["prd", "architecture"],
      },
      createdAt: "2026-03-25T00:00:00.000Z",
    } as OrchestratorContextSnapshot;
    const graph = makeRunGraph({ steps: [step], contextSnapshots: [snapshot] });

    const inspector = buildWorkerPromptInspector({ graph, stepId: "step-1" });

    const contextLayer = inspector.layers.find((l) => l.label === "Runtime context references");
    expect(contextLayer).toBeDefined();
    expect(contextLayer!.text).toContain("project-pack-1");
    expect(contextLayer!.text).toContain("lane-pack-1");
    expect(contextLayer!.text).toContain("docs/ARCHITECTURE.md");
  });

  it("throws when step is not found", () => {
    const graph = makeRunGraph({ steps: [] });
    expect(() => buildWorkerPromptInspector({ graph, stepId: "missing-step" })).toThrow(
      "Step not found for prompt inspector",
    );
  });

  it("generates fullPrompt as concatenation of all layers", () => {
    const step = makeStep({ id: "step-1", title: "Auth worker" });
    const graph = makeRunGraph({ steps: [step] });

    const inspector = buildWorkerPromptInspector({ graph, stepId: "step-1" });

    for (const layer of inspector.layers) {
      expect(inspector.fullPrompt).toContain(`## ${layer.label}`);
      expect(inspector.fullPrompt).toContain(layer.text.slice(0, 50));
    }
  });

  it("assigns sequential layer IDs", () => {
    const step = makeStep({
      id: "step-1",
      metadata: {
        instructions: "Do X",
        phaseInstructions: "Phase rules",
        phaseKey: "development",
        phaseName: "Development",
      },
    });
    const graph = makeRunGraph({ steps: [step] });

    const inspector = buildWorkerPromptInspector({ graph, stepId: "step-1" });

    for (let i = 0; i < inspector.layers.length; i++) {
      expect(inspector.layers[i].id).toBe(`layer-${i + 1}`);
    }
  });

  it("includes team runtime overlay when enabled", () => {
    const step = makeStep({ id: "step-1" });
    const graph = makeRunGraph({
      steps: [step],
      metadata: {
        missionGoal: "Build X",
        teamRuntime: { enabled: true },
      },
    });

    const inspector = buildWorkerPromptInspector({ graph, stepId: "step-1" });

    const overlayLayer = inspector.layers.find((l) => l.label === "Runtime overlays and constraints");
    expect(overlayLayer).toBeDefined();
    expect(overlayLayer!.text).toContain("TEAM RUNTIME (ACTIVE)");
  });
});

describe("buildCoordinatorPromptInspector", () => {
  it("returns inspector with identity, protocol, and guardrail layers", () => {
    const inspector = buildCoordinatorPromptInspector({
      runId: "run-1",
      missionId: "mission-1",
      missionGoal: "Build feature X",
    });

    expect(inspector.target).toBe("coordinator");
    expect(inspector.runId).toBe("run-1");
    expect(inspector.missionId).toBe("mission-1");
    expect(inspector.title).toBe("Coordinator prompt");

    const identityLayer = inspector.layers.find((l) => l.label === "Coordinator identity and autonomy contract");
    expect(identityLayer).toBeDefined();
    expect(identityLayer!.text).toContain("Build feature X");
    expect(identityLayer!.text).toContain("team lead");

    const protocolLayer = inspector.layers.find((l) => l.label === "Planning and validation protocol");
    expect(protocolLayer).toBeDefined();
    expect(protocolLayer!.text).toContain("Phase ordering is enforced");

    const guardrailLayer = inspector.layers.find((l) => l.label === "Lane and delegation guardrails");
    expect(guardrailLayer).toBeDefined();
  });

  it("includes user rules layer when rules are provided", () => {
    const inspector = buildCoordinatorPromptInspector({
      runId: "run-1",
      missionId: "mission-1",
      missionGoal: "Build X",
      userRules: {
        providerPreference: "claude",
        costMode: "balanced",
        maxParallelWorkers: 4,
        allowParallelAgents: true,
        allowSubAgents: false,
        laneStrategy: "single",
        customInstructions: "Always run tests before committing",
        coordinatorModel: "anthropic/claude-sonnet-4-6",
        budgetLimitUsd: 10.5,
      },
    });

    const rulesLayer = inspector.layers.find((l) => l.label === "User-configured rules");
    expect(rulesLayer).toBeDefined();
    expect(rulesLayer!.text).toContain("Provider preference: claude");
    expect(rulesLayer!.text).toContain("Cost mode: balanced");
    expect(rulesLayer!.text).toContain("Maximum parallel workers: 4");
    expect(rulesLayer!.text).toContain("Parallel agents: enabled");
    expect(rulesLayer!.text).toContain("Sub-agents: disabled");
    expect(rulesLayer!.text).toContain("Always run tests before committing");
    expect(rulesLayer!.text).toContain("$10.50 USD");
  });

  it("includes phase configuration snapshot", () => {
    const phases = [
      makePhaseCard({ phaseKey: "planning", name: "Planning", position: 0, isCustom: false }),
      makePhaseCard({ phaseKey: "development", name: "Development", position: 1, isCustom: true }),
    ];

    const inspector = buildCoordinatorPromptInspector({
      runId: "run-1",
      missionId: "mission-1",
      missionGoal: "Build X",
      phases,
    });

    const phasesLayer = inspector.layers.find((l) => l.label === "Phase configuration snapshot");
    expect(phasesLayer).toBeDefined();
    expect(phasesLayer!.text).toContain("PLANNING");
    expect(phasesLayer!.text).toContain("[CUSTOM] DEVELOPMENT");
  });

  it("includes available providers section", () => {
    const inspector = buildCoordinatorPromptInspector({
      runId: "run-1",
      missionId: "mission-1",
      missionGoal: "Build X",
      availableProviders: [
        { name: "claude", available: true },
        { name: "codex", available: true },
        { name: "local-ollama", available: false },
      ],
    });

    const providersLayer = inspector.layers.find((l) => l.label === "Available worker/runtime surface");
    expect(providersLayer).toBeDefined();
    expect(providersLayer!.text).toContain("claude, codex");
    expect(providersLayer!.text).not.toContain("local-ollama");
  });

  it("handles no available providers gracefully", () => {
    const inspector = buildCoordinatorPromptInspector({
      runId: "run-1",
      missionId: "mission-1",
      missionGoal: "Build X",
    });

    const providersLayer = inspector.layers.find((l) => l.label === "Available worker/runtime surface");
    expect(providersLayer).toBeDefined();
    expect(providersLayer!.text).toContain("provider availability was not persisted");
  });

  it("includes project context section", () => {
    const inspector = buildCoordinatorPromptInspector({
      runId: "run-1",
      missionId: "mission-1",
      missionGoal: "Build X",
      projectContext: {
        projectRoot: "/Users/dev/myproject",
        projectDocPaths: ["docs/ARCHITECTURE.md", "docs/PRD.md"],
        projectKnowledge: ["Uses TypeScript with strict mode"],
        fileTree: "src/\n  main/\n  renderer/",
      },
    });

    const contextLayer = inspector.layers.find((l) => l.label === "Project context");
    expect(contextLayer).toBeDefined();
    expect(contextLayer!.text).toContain("/Users/dev/myproject");
    expect(contextLayer!.text).toContain("docs/ARCHITECTURE.md");
    expect(contextLayer!.text).toContain("Uses TypeScript with strict mode");
    expect(contextLayer!.text).toContain("src/\n  main/");
  });

  it("populates phaseKey and phaseName from args", () => {
    const inspector = buildCoordinatorPromptInspector({
      runId: "run-1",
      missionId: "mission-1",
      missionGoal: "Build X",
      currentPhaseKey: "development",
      currentPhaseName: "Development",
    });

    expect(inspector.phaseKey).toBe("development");
    expect(inspector.phaseName).toBe("Development");
  });

  it("defaults phaseKey and phaseName to null", () => {
    const inspector = buildCoordinatorPromptInspector({
      runId: "run-1",
      missionId: "mission-1",
      missionGoal: "Build X",
    });

    expect(inspector.phaseKey).toBeNull();
    expect(inspector.phaseName).toBeNull();
  });

  it("includes notes about hidden coordinator behavior", () => {
    const inspector = buildCoordinatorPromptInspector({
      runId: "run-1",
      missionId: "mission-1",
      missionGoal: "Build X",
    });

    expect(inspector.notes.length).toBeGreaterThanOrEqual(1);
    expect(inspector.notes.some((n) => n.includes("hidden planning"))).toBe(true);
  });
});

describe("buildPlanningPromptPreview", () => {
  it("returns a preview inspector with a single composed prompt layer", () => {
    const phase = makePhaseCard({
      phaseKey: "planning",
      name: "Planning",
      instructions: "Research and plan carefully.",
      model: { modelId: "anthropic/claude-sonnet-4-6", thinkingLevel: "medium" },
    });

    const inspector = buildPlanningPromptPreview({
      missionPrompt: "Implement authentication module",
      phase,
      phases: [phase, makePhaseCard()],
    });

    expect(inspector.target).toBe("worker");
    expect(inspector.runId).toBe("preview-run");
    expect(inspector.missionId).toBe("preview-mission");
    expect(inspector.phaseKey).toBe("planning");
    expect(inspector.phaseName).toBe("Planning");
    expect(inspector.title).toBe("Planning worker prompt");
    expect(inspector.layers).toHaveLength(1);
    expect(inspector.layers[0].label).toBe("Exact composed planner prompt");
    expect(inspector.fullPrompt).toContain("Implement authentication module");
  });

  it("uses provided runId and missionId when available", () => {
    const phase = makePhaseCard({ phaseKey: "planning", name: "Planning" });

    const inspector = buildPlanningPromptPreview({
      missionPrompt: "Build X",
      phase,
      phases: [phase],
      runId: "custom-run",
      missionId: "custom-mission",
    });

    expect(inspector.runId).toBe("custom-run");
    expect(inspector.missionId).toBe("custom-mission");
  });

  it("includes notes about read-only preview", () => {
    const phase = makePhaseCard({ phaseKey: "planning", name: "Planning" });

    const inspector = buildPlanningPromptPreview({
      missionPrompt: "Build X",
      phase,
      phases: [phase],
    });

    expect(inspector.notes.some((n) => n.includes("Read-only"))).toBe(true);
  });

  it("trims the mission prompt", () => {
    const phase = makePhaseCard({ phaseKey: "planning", name: "Planning" });

    const inspector = buildPlanningPromptPreview({
      missionPrompt: "  Build X  ",
      phase,
      phases: [phase],
    });

    expect(inspector.fullPrompt).toContain("Build X");
  });
});
