import {
  compactText,
  buildCompactPlanView,
  buildFullPrompt,
} from "./baseOrchestratorAdapter";
import {
  DEFAULT_CONTEXT_VIEW_POLICIES,
  SLASH_COMMAND_TRANSLATIONS,
} from "./orchestratorConstants";
import type {
  CoordinatorAvailableProvider,
  CoordinatorProjectContext,
  CoordinatorUserRules,
} from "./coordinatorAgent";
import type {
  OrchestratorAttempt,
  OrchestratorContextSnapshot,
  GetPlanningPromptPreviewArgs,
  OrchestratorPromptInspector,
  OrchestratorPromptLayer,
  OrchestratorRunGraph,
  OrchestratorStep,
  OrchestratorStepStatus,
  OrchestratorWorkerRole,
  PhaseCard,
  TeamRuntimeConfig,
} from "../../../shared/types";
import { isRecord, toOptionalString } from "../shared/utils";

function pushLayer(
  layers: OrchestratorPromptLayer[],
  layer: Omit<OrchestratorPromptLayer, "id">,
): void {
  layers.push({
    id: `layer-${layers.length + 1}`,
    ...layer,
  });
}

function formatContextSnapshotLayer(snapshot: OrchestratorContextSnapshot | null): string | null {
  if (!snapshot) return null;
  const cursor = snapshot.cursor;
  const lines: string[] = [
    `Snapshot type: ${snapshot.snapshotType}`,
    `Context profile: ${snapshot.contextProfile}`,
  ];
  if (cursor.projectPackKey) {
    lines.push(
      `Project export: ${cursor.projectPackKey}${cursor.projectPackVersionNumber != null ? ` v${cursor.projectPackVersionNumber}` : ""}`,
    );
  }
  if (cursor.lanePackKey) {
    lines.push(
      `Lane export: ${cursor.lanePackKey}${cursor.lanePackVersionNumber != null ? ` v${cursor.lanePackVersionNumber}` : ""}`,
    );
  }
  if (Array.isArray(cursor.docs) && cursor.docs.length > 0) {
    lines.push(`Docs refs: ${cursor.docs.map((doc) => doc.path).join(", ")}`);
  }
  if (Array.isArray(cursor.contextSources) && cursor.contextSources.length > 0) {
    lines.push(`Context sources: ${cursor.contextSources.join(", ")}`);
  }
  return lines.join("\n");
}

function buildExactWorkerPrompt(args: {
  runId: string;
  missionId: string;
  missionGoal: string;
  phase: PhaseCard;
}): string {
  const syntheticRun = {
    id: args.runId,
    missionId: args.missionId,
    status: "queued",
    metadata: {
      missionGoal: args.missionGoal,
      phaseRuntime: {
        currentPhaseKey: args.phase.phaseKey,
        currentPhaseName: args.phase.name,
        currentPhaseInstructions: args.phase.instructions,
        currentPhaseModel: args.phase.model,
        currentPhaseValidation: args.phase.validationGate,
      },
    },
  } as unknown as OrchestratorRunGraph["run"];
  const syntheticStep = {
    id: `preview-step:${args.phase.phaseKey}`,
    stepKey: `planning_${args.phase.phaseKey}`,
    title: `${args.phase.name} worker`,
    status: "pending" as OrchestratorStepStatus,
    stepIndex: 0,
    laneId: null,
    dependencyStepIds: [],
    joinPolicy: "blocking",
    metadata: {
      role: "planner",
      modelId: args.phase.model.modelId,
      reasoningEffort: args.phase.model.thinkingLevel,
      instructions: args.phase.instructions,
      phaseInstructions: args.phase.instructions,
      phaseKey: args.phase.phaseKey,
      phaseName: args.phase.name,
      phaseModel: args.phase.model,
      phaseValidation: args.phase.validationGate,
      readOnlyExecution: true,
      stepType: "planning",
      taskType: "planning",
    },
  } as unknown as OrchestratorStep;
  const syntheticAttempt = {
    id: `preview-attempt:${args.phase.phaseKey}`,
    runId: args.runId,
    stepId: syntheticStep.id,
    status: "queued",
    executorKind: "unified",
    executorSessionId: null,
    metadata: {},
  } as unknown as OrchestratorAttempt;

  return buildFullPrompt({
    run: syntheticRun,
    step: syntheticStep,
    attempt: syntheticAttempt,
    allSteps: [syntheticStep],
    contextProfile: null as never,
    laneExport: null,
    projectExport: {} as never,
    docsRefs: [],
    fullDocs: [],
    createTrackedSession: async () => ({ ptyId: "preview", sessionId: "preview" }),
  }).prompt;
}

function findLatestAttemptForStep(graph: OrchestratorRunGraph, stepId: string): OrchestratorAttempt | null {
  const attempts = graph.attempts
    .filter((attempt) => attempt.stepId === stepId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return attempts[0] ?? null;
}

function findBestSnapshot(graph: OrchestratorRunGraph, stepId: string, attemptId: string | null): OrchestratorContextSnapshot | null {
  if (attemptId) {
    const attemptSnapshot = graph.contextSnapshots.find(
      (snapshot) => snapshot.attemptId === attemptId,
    );
    if (attemptSnapshot) return attemptSnapshot;
  }
  const stepSnapshot = graph.contextSnapshots.find(
    (snapshot) => snapshot.stepId === stepId && snapshot.snapshotType !== "run",
  );
  if (stepSnapshot) return stepSnapshot;
  return graph.contextSnapshots.find((snapshot) => snapshot.snapshotType === "run") ?? null;
}

function buildWorkerBaseGuidance(step: OrchestratorStep, graph: OrchestratorRunGraph): string {
  const run = graph.run;
  const missionGoal =
    typeof run.metadata?.missionGoal === "string" ? run.metadata.missionGoal.trim() : "";
  const role = typeof step.metadata?.role === "string" ? step.metadata.role : step.stepKey;
  const laneLabel = step.laneId ?? "unassigned";
  const sections: string[] = [];
  sections.push(`You are an ADE orchestrator worker executing step "${step.title}".`);
  sections.push(
    [
      `Role: ${role}`,
      `Step: "${step.title}" (key: ${step.stepKey})`,
      `Mission: ${missionGoal || "(no goal)"} (mission: ${run.missionId}, run: ${run.id})`,
      `Lane: ${laneLabel}`,
    ].join("\n"),
  );
  sections.push(
    "EXECUTION PROTOCOL: Execute immediately. Do not ask for confirmation or propose a plan and wait for approval. Do not summarize your instructions back. If you encounter a blocker you cannot work around, fail with a clear error message describing the blocker. Never wait for human input — make the best decision you can and document your reasoning.",
  );
  const planView = buildCompactPlanView(step, graph.steps);
  if (planView) sections.push(planView);
  sections.push(
    [
      "Work style:",
      "- If you discover information relevant to other steps (API changes, schema updates, config requirements), include it in your output summary.",
      "- If you hit a blocker you can work around safely, work around it and note what you did.",
      "- Structure your output: lead with what you accomplished, then what you changed, then risks or notes for downstream steps.",
      "- If your step depends on upstream work, check the handoff context before starting — don't redo completed work.",
    ].join("\n"),
  );
  sections.push(
    [
      "COMMUNICATION STYLE:",
      "You are part of a team. When you make progress, share brief updates in natural, casual English.",
      "Write like a teammate in a Slack channel — short blurbs, not formal reports.",
      'Examples of good updates: "looking at the existing code first to understand the patterns"',
      'Examples of good updates: "implementing the auth middleware now, using JWT approach"',
      'Examples of good updates: "tests passing, moving on to the edge cases"',
      'Examples of good updates: "hit an issue with the import path, working around it"',
      'Examples of good updates: "done — changed 3 files, all tests green"',
      "DO NOT dump full file contents, raw errors, or tool output into your updates.",
      "Keep each update to 1-2 sentences max.",
    ].join("\n"),
  );
  sections.push(
    [
      "RESULT REPORTING:",
      "- Use `report_status` for short progress updates when you make meaningful progress or hit a blocker.",
      "- Before you exit, ALWAYS call `report_result` with your outcome, summary, filesChanged, and testsRun fields filled in as accurately as possible.",
    ].join("\n"),
  );
  sections.push(
    "You are working within ADE (Autonomous Development Environment), an Electron-based multi-agent development tool. ADE manages lanes (git worktrees), missions (task orchestration), PRs, and agent sessions. You have access to the project's full context including PRD and architecture docs when provided.",
  );
  sections.push(
    [
      "ADE MCP TOOLS: You have access to the ADE MCP server which provides team collaboration tools.",
      "Your worker identity (mission, run, step, attempt IDs) is automatically resolved — you don't need to pass IDs to observation tools.",
      "Key tools available:",
      "- get_worker_states",
      "- get_run_graph",
      "- get_mission",
      "- get_pending_messages",
      "- get_timeline",
      "- stream_events",
    ].join("\n"),
  );
  sections.push(
    [
      "Before finishing, write a HANDOFF SUMMARY (3-5 bullets):",
      "1. What you accomplished (files created/modified)",
      "2. What downstream steps need to know (API changes, new deps, config updates)",
      "3. Any risks or known issues (edge cases not covered, flaky tests)",
    ].join("\n"),
  );
  return sections.join("\n\n");
}

export function buildWorkerPromptInspector(args: {
  graph: OrchestratorRunGraph;
  stepId: string;
}): OrchestratorPromptInspector {
  const { graph, stepId } = args;
  const step = graph.steps.find((entry) => entry.id === stepId);
  if (!step) {
    throw new Error(`Step not found for prompt inspector: ${stepId}`);
  }
  const latestAttempt = findLatestAttemptForStep(graph, step.id);
  const latestSnapshot = findBestSnapshot(graph, step.id, latestAttempt?.id ?? null);
  const run = graph.run;
  const phaseKey = toOptionalString(step.metadata?.phaseKey)
    ?? toOptionalString(run.metadata?.phaseRuntime && isRecord(run.metadata.phaseRuntime) ? run.metadata.phaseRuntime.currentPhaseKey : null);
  const phaseName = toOptionalString(step.metadata?.phaseName)
    ?? toOptionalString(run.metadata?.phaseRuntime && isRecord(run.metadata.phaseRuntime) ? run.metadata.phaseRuntime.currentPhaseName : null);
  const missionGoal =
    typeof run.metadata?.missionGoal === "string" ? run.metadata.missionGoal.trim() : "";

  const layers: OrchestratorPromptLayer[] = [];
  const notes = [
    "Phase instructions are only one layer. Worker behavior is still shaped by system-owned guidance, step runtime metadata, overlays, steering, and context snapshots.",
    "Context export bodies are not persisted verbatim in the run graph. This inspector shows the runtime context references that were persisted with the attempt.",
  ];

  pushLayer(layers, {
    label: "Base worker system guidance",
    source: "system_owned",
    sourceKind: "system_owned",
    editable: false,
    text: buildWorkerBaseGuidance(step, graph),
    description: "System-owned worker contract from ADE. Editing phase text does not replace this layer.",
  });

  if (missionGoal.length > 0) {
    pushLayer(layers, {
      label: "Mission goal",
      source: "mission_goal",
      sourceKind: "run_snapshot",
      editable: false,
      text: missionGoal,
      description: "Mission goal frozen onto the run.",
    });
  }

  const stepInstructions = toOptionalString(step.metadata?.instructions);
  if (stepInstructions) {
    pushLayer(layers, {
      label: "Step instructions",
      source: "step_runtime",
      sourceKind: "run_snapshot",
      editable: false,
      text: stepInstructions,
      description: "Step-level runtime framing for this executable step.",
    });
  }

  const phaseInstructions = toOptionalString(step.metadata?.phaseInstructions);
  if (phaseInstructions) {
    pushLayer(layers, {
      label: "Phase instructions",
      source: "phase_snapshot",
      sourceKind: "run_snapshot",
      editable: false,
      text: phaseInstructions,
      description: "Frozen phase-card instructions captured on the run snapshot.",
    });
  }

  const runtimeOverlays: string[] = [];
  const requiresPlanApproval =
    step.metadata?.requiresPlanApproval === true || step.metadata?.coordinationPattern === "plan_then_implement";
  const readOnlyExecution = step.metadata?.readOnlyExecution === true || requiresPlanApproval;
  if (readOnlyExecution) {
    runtimeOverlays.push("IMPORTANT: This step is READ-ONLY. Do NOT modify files, stage changes, or run write operations. Research, review, and return findings or a plan only.");
  }

  const filePatternsFromMetadata = Array.isArray(step.metadata?.filePatterns)
    ? step.metadata.filePatterns.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  if (filePatternsFromMetadata.length > 0) {
    runtimeOverlays.push(`File ownership fence: ${filePatternsFromMetadata.join(", ")}`);
  }

  const handoffSummaries = Array.isArray(step.metadata?.handoffSummaries)
    ? step.metadata.handoffSummaries.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  if (handoffSummaries.length > 0) {
    runtimeOverlays.push(`Handoff context:\n${handoffSummaries.map((entry) => `- ${entry}`).join("\n")}`);
  }

  const rawStartup = toOptionalString(step.metadata?.startupCommand);
  const slashBase = rawStartup ? rawStartup.split(/\s/)[0] : null;
  const slashTranslation = slashBase ? SLASH_COMMAND_TRANSLATIONS[slashBase] : undefined;
  if (slashTranslation?.prompt) {
    runtimeOverlays.push(`Slash command instructions:\n${slashTranslation.prompt}`);
  }

  const workerRole = toOptionalString(step.metadata?.role) as OrchestratorWorkerRole | null;
  const contextView = workerRole
    ? DEFAULT_CONTEXT_VIEW_POLICIES[
        workerRole === "code_review" ? "review" : workerRole === "test_review" ? "test_review" : "implementation"
      ]
    : null;
  if (contextView?.readOnly) {
    runtimeOverlays.push("IMPORTANT: You are in a READ-ONLY review role. Do NOT modify any files. Only analyze and provide feedback on the code/tests you are reviewing.");
  }

  const teamRuntime = isRecord(run.metadata) ? (run.metadata.teamRuntime as TeamRuntimeConfig | undefined) : undefined;
  if (teamRuntime?.enabled) {
    runtimeOverlays.push(
      [
        "TEAM RUNTIME (ACTIVE): You are part of an ADE agent team with shared task management.",
        "- You can claim tasks from the shared task list",
        "- You can send messages to other teammates via the coordinator",
        "- You can report progress, blockers, and discoveries",
      ].join("\n"),
    );
  }

  if (latestAttempt && (latestAttempt.errorMessage || latestAttempt.resultEnvelope?.summary || latestSnapshot)) {
    const recoveryParts: string[] = [];
    if (latestAttempt.errorMessage) {
      recoveryParts.push(`Latest attempt error: ${latestAttempt.errorMessage}`);
    }
    if (latestAttempt.resultEnvelope?.summary) {
      recoveryParts.push(`Latest attempt summary: ${latestAttempt.resultEnvelope.summary}`);
    }
    const checkpointPreview = toOptionalString(step.metadata?.lastCheckpointSummary);
    if (checkpointPreview) {
      recoveryParts.push(`Checkpoint summary: ${compactText(checkpointPreview, 400)}`);
    }
    if (recoveryParts.length > 0) {
      runtimeOverlays.push(`Recovery / continuity context:\n${recoveryParts.join("\n")}`);
    }
  }

  if (runtimeOverlays.length > 0) {
    pushLayer(layers, {
      label: "Runtime overlays and constraints",
      source: "runtime_overlay",
      sourceKind: "live_effective_prompt",
      editable: false,
      text: runtimeOverlays.join("\n\n"),
      description: "Read-only, review, ownership, recovery, and team-runtime overlays applied at execution time.",
    });
  }

  const steeringDirectives = Array.isArray(step.metadata?.steeringDirectives)
    ? step.metadata.steeringDirectives
        .map((entry) => {
          if (!isRecord(entry)) return null;
          const directive = toOptionalString(entry.directive);
          if (!directive) return null;
          const priority = toOptionalString(entry.priority) ?? "suggestion";
          const targetStepKey = toOptionalString(entry.targetStepKey);
          return `- [${priority}] ${directive}${targetStepKey ? ` (target: ${targetStepKey})` : ""}`;
        })
        .filter((entry): entry is string => Boolean(entry))
    : [];
  if (steeringDirectives.length > 0) {
    pushLayer(layers, {
      label: "Operator steering",
      source: "user_steering",
      sourceKind: "live_effective_prompt",
      editable: false,
      text: steeringDirectives.join("\n"),
      description: "Live operator directives layered on top of the frozen run snapshot.",
    });
  }

  const runtimeContextSections: string[] = [];
  const contextLayer = formatContextSnapshotLayer(latestSnapshot);
  if (contextLayer) runtimeContextSections.push(contextLayer);
  const runtimePhase = isRecord(run.metadata?.phaseRuntime) ? run.metadata.phaseRuntime : null;
  if (runtimePhase) {
    const runtimeLines = [
      toOptionalString(runtimePhase.currentPhaseKey) ? `Current phase key: ${runtimePhase.currentPhaseKey}` : null,
      toOptionalString(runtimePhase.currentPhaseName) ? `Current phase name: ${runtimePhase.currentPhaseName}` : null,
    ].filter((entry): entry is string => Boolean(entry));
    if (runtimeLines.length > 0) {
      runtimeContextSections.push(runtimeLines.join("\n"));
    }
  }
  if (runtimeContextSections.length > 0) {
    pushLayer(layers, {
      label: "Runtime context references",
      source: "runtime_context",
      sourceKind: "live_effective_prompt",
      editable: false,
      text: runtimeContextSections.join("\n\n"),
      description: "Persisted context snapshot references. Full pack bodies are not stored in the inspector data model.",
    });
  }

  const fullPrompt = layers.map((layer) => `## ${layer.label}\n${layer.text}`).join("\n\n");
  return {
    target: "worker",
    runId: run.id,
    missionId: run.missionId,
    stepId: step.id,
    phaseKey,
    phaseName,
    title: `${step.title} prompt`,
    notes,
    layers,
    fullPrompt,
  };
}

function buildCoordinatorRulesSection(rules: CoordinatorUserRules | undefined): string | null {
  if (!rules) return null;
  const ruleLines: string[] = [];
  if (rules.providerPreference) ruleLines.push(`- Provider preference: ${rules.providerPreference}`);
  if (rules.costMode) ruleLines.push(`- Cost mode: ${rules.costMode}`);
  if (rules.maxParallelWorkers != null) ruleLines.push(`- Maximum parallel workers: ${rules.maxParallelWorkers}`);
  if (rules.allowParallelAgents != null) ruleLines.push(`- Parallel agents: ${rules.allowParallelAgents ? "enabled" : "disabled (run work sequentially)"}`);
  if (rules.allowSubAgents != null) ruleLines.push(`- Sub-agents: ${rules.allowSubAgents ? "enabled" : "disabled (do not use nested delegation)"}`);
  if (rules.allowClaudeAgentTeams != null) ruleLines.push(`- Claude native agent teams: ${rules.allowClaudeAgentTeams ? "enabled" : "disabled"}`);
  if (rules.laneStrategy) ruleLines.push(`- Lane strategy: ${rules.laneStrategy}`);
  if (rules.customInstructions) ruleLines.push(`- Custom instructions: ${rules.customInstructions}`);
  if (rules.coordinatorModel) ruleLines.push(`- Coordinator model: ${rules.coordinatorModel} (user selected)`);
  if (rules.prStrategy) ruleLines.push(`- PR strategy: ${rules.prStrategy}`);
  if (rules.budgetLimitUsd != null) ruleLines.push(`- Budget limit: $${rules.budgetLimitUsd.toFixed(2)} USD`);
  if (rules.budgetLimitTokens != null) ruleLines.push(`- Token budget limit: ${rules.budgetLimitTokens.toLocaleString()} tokens`);
  if (rules.recoveryEnabled != null) ruleLines.push(`- Recovery loops: ${rules.recoveryEnabled ? `enabled (max ${rules.recoveryMaxIterations ?? 3} iterations)` : "disabled"}`);
  return ruleLines.length > 0 ? ruleLines.join("\n") : null;
}

function buildCoordinatorPhasesSection(phases: PhaseCard[] | undefined): string | null {
  if (!Array.isArray(phases) || phases.length === 0) return null;
  return phases
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((phase, index) => {
      const lines: string[] = [];
      const customTag = phase.isCustom ? "[CUSTOM] " : "";
      lines.push(`${index + 1}. ${customTag}${phase.name.toUpperCase()} (model: ${phase.model.modelId})`);
      if (phase.description) lines.push(`   Description: ${phase.description}`);
      if (phase.instructions) lines.push(`   Instructions: ${phase.instructions}`);
      if (phase.validationGate.tier !== "none") {
        lines.push(`   Validation: ${phase.validationGate.tier.replace("-", " ")} ${phase.validationGate.required ? "(required)" : "(optional)"}`);
      }
      if (phase.askQuestions.enabled) {
        lines.push(`   Ask Questions: enabled (the active phase owner may ask when needed, max ${Math.max(1, Math.min(10, Number(phase.askQuestions.maxQuestions ?? 5) || 5))} questions)`);
      } else {
        lines.push("   Ask Questions: disabled");
      }
      return lines.join("\n");
    })
    .join("\n");
}

function buildCoordinatorProjectContextSection(projectContext: CoordinatorProjectContext | undefined): string | null {
  if (!projectContext) return null;
  const lines: string[] = [`Project root: ${projectContext.projectRoot}`];
  if (Array.isArray(projectContext.projectDocPaths) && projectContext.projectDocPaths.length > 0) {
    lines.push("Likely project docs:");
    for (const docPath of projectContext.projectDocPaths.slice(0, 40)) {
      lines.push(`- ${docPath}`);
    }
  }
  if (Array.isArray(projectContext.projectKnowledge) && projectContext.projectKnowledge.length > 0) {
    lines.push("Project memory highlights:");
    for (const entry of projectContext.projectKnowledge.slice(0, 12)) {
      lines.push(`- ${entry}`);
    }
  }
  if (projectContext.fileTree) {
    lines.push(`File structure:\n${projectContext.fileTree}`);
  }
  return lines.join("\n");
}

function buildCoordinatorProvidersSection(providers: CoordinatorAvailableProvider[] | undefined): string {
  const available = Array.isArray(providers)
    ? providers.filter((provider) => provider.available).map((provider) => provider.name)
    : [];
  if (available.length === 0) return "Unified worker (spawn_worker) is available; provider availability was not persisted on this run.";
  return [
    "Unified worker (spawn_worker) — choose model per worker with `modelId`; CLI models run as subprocess sessions and API/local models run in-process.",
    `Currently available providers: ${available.join(", ")}`,
  ].join("\n");
}

export function buildCoordinatorPromptInspector(args: {
  runId: string;
  missionId: string;
  missionGoal: string;
  phases?: PhaseCard[];
  userRules?: CoordinatorUserRules;
  projectContext?: CoordinatorProjectContext;
  availableProviders?: CoordinatorAvailableProvider[];
  currentPhaseKey?: string | null;
  currentPhaseName?: string | null;
}): OrchestratorPromptInspector {
  const layers: OrchestratorPromptLayer[] = [];
  const notes = [
    "Coordinator prompt includes hidden planning and orchestration protocol beyond the editable phase card text.",
    "Editing a phase instruction changes only the custom instruction layer; it does not replace coordinator system guidance, runtime constraints, or lane-management rules.",
  ];

  pushLayer(layers, {
    label: "Coordinator identity and autonomy contract",
    source: "system_owned",
    sourceKind: "system_owned",
    editable: false,
    text: [
      "You are the team lead for a software engineering mission. You have a team of AI coding agents (workers) you can spawn, steer, and shut down.",
      "You are the persistent brain. Workers are disposable hands.",
      "You are NOT a task router or dispatcher. You are a thinking, reasoning team lead who reads code, understands architecture, makes judgment calls, and owns the outcome.",
      `Mission goal: ${args.missionGoal}`,
      `Run ID: ${args.runId}`,
      `Mission ID: ${args.missionId}`,
    ].join("\n\n"),
    description: "System-owned coordinator prompt root.",
  });

  const rulesSection = buildCoordinatorRulesSection(args.userRules);
  if (rulesSection) {
    pushLayer(layers, {
      label: "User-configured rules",
      source: "runtime_overlay",
      sourceKind: "run_snapshot",
      editable: false,
      text: rulesSection,
      description: "Frozen user settings that constrain the coordinator.",
    });
  }

  const phasesSection = buildCoordinatorPhasesSection(args.phases);
  if (phasesSection) {
    pushLayer(layers, {
      label: "Phase configuration snapshot",
      source: "phase_snapshot",
      sourceKind: "run_snapshot",
      editable: false,
      text: phasesSection,
      description: "Frozen run snapshot of the mission phase profile.",
    });
  }

  pushLayer(layers, {
    label: "Planning and validation protocol",
    source: "system_owned",
    sourceKind: "system_owned",
    editable: false,
    text: [
      "Phase ordering is enforced by runtime tools. Do not bypass phase gates.",
      "Validation is a runtime contract, not advisory behavior.",
      "Dedicated required validation is auto-spawned by runtime; do not simulate it.",
      "If a Planning phase is enabled, start with one read-only planning worker, wait for its output, then explicitly advance phase before spawning code-changing workers.",
      "Planning questions, when needed, should use ask_user. Provider-native approval prompts are not part of mission flow.",
      "Never spawn a code-changing worker while the run is still in Planning.",
    ].join("\n"),
    description: "System-owned coordinator protocol that sits outside editable phase text.",
  });

  pushLayer(layers, {
    label: "Lane and delegation guardrails",
    source: "system_owned",
    sourceKind: "system_owned",
    editable: false,
    text: [
      "Use delegate_to_subagent only for parent-owned child work; use spawn_worker for independent top-level work.",
      "Hard constraints like allowParallelAgents, allowSubAgents, and allowClaudeAgentTeams are tool-enforced.",
      "Mission lane isolation is the default operating model; workers should stay on the mission lane or child lanes provisioned for the run.",
    ].join("\n"),
    description: "System-owned orchestration guardrails.",
  });

  const providersSection = buildCoordinatorProvidersSection(args.availableProviders);
  pushLayer(layers, {
    label: "Available worker/runtime surface",
    source: "runtime_context",
    sourceKind: "live_effective_prompt",
    editable: false,
    text: providersSection,
    description: "Runtime availability context for worker spawning.",
  });

  const projectSection = buildCoordinatorProjectContextSection(args.projectContext);
  if (projectSection) {
    pushLayer(layers, {
      label: "Project context",
      source: "runtime_context",
      sourceKind: "live_effective_prompt",
      editable: false,
      text: projectSection,
      description: "Project-root, docs, memory highlights, and file-structure context given to the coordinator.",
    });
  }

  const fullPrompt = layers.map((layer) => `## ${layer.label}\n${layer.text}`).join("\n\n");
  return {
    target: "coordinator",
    runId: args.runId,
    missionId: args.missionId,
    stepId: null,
    phaseKey: args.currentPhaseKey ?? null,
    phaseName: args.currentPhaseName ?? null,
    title: "Coordinator prompt",
    notes,
    layers,
    fullPrompt,
  };
}

export function buildPlanningPromptPreview(args: GetPlanningPromptPreviewArgs): OrchestratorPromptInspector {
  const sortedPhases = [...args.phases].sort((a, b) => a.position - b.position);
  const planningPhase = {
    ...(sortedPhases.find((phase) => phase.id === args.phase.id || phase.phaseKey === args.phase.phaseKey) ?? {}),
    ...args.phase,
  };
  const prompt = buildExactWorkerPrompt({
    runId: toOptionalString(args.runId) ?? "preview-run",
    missionId: toOptionalString(args.missionId) ?? "preview-mission",
    missionGoal: args.missionPrompt.trim(),
    phase: planningPhase,
  });

  const layers: OrchestratorPromptLayer[] = [];
  pushLayer(layers, {
    label: "Exact composed planner prompt",
    source: "system_owned",
    sourceKind: "live_effective_prompt",
    editable: false,
    text: prompt,
    description: "This is the actual planner-worker prompt shape ADE assembles from the planning phase contract and your current custom instructions.",
  });

  return {
    target: "worker",
    runId: toOptionalString(args.runId) ?? "preview-run",
    missionId: toOptionalString(args.missionId) ?? "preview-mission",
    stepId: null,
    phaseKey: planningPhase.phaseKey,
    phaseName: planningPhase.name,
    title: "Planning worker prompt",
    notes: [
      "Read-only, system-composed planner prompt preview.",
      "Edit the Custom Instructions field below to change the phase-specific instruction layer that gets folded into this prompt.",
    ],
    layers,
    fullPrompt: prompt,
  };
}
