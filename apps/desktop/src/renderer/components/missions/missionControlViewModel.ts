import type {
  GetModelCapabilitiesResult,
  MissionDetail,
  MissionIntervention,
  OrchestratorArtifact,
  OrchestratorRunGraph,
  OrchestratorWorkerCheckpoint,
  PhaseCard,
  ValidationEvidenceRequirement,
} from "../../../shared/types";
import { filterExecutionSteps, isRecord } from "./missionHelpers";
import {
  resolveCloseoutRequirementKeyFromArtifact,
  resolveOrchestratorArtifactUri,
} from "../../../shared/proofArtifacts";

/** Return trimmed string or null if empty/non-string. Duplicates shared/utils for renderer boundary. */
function toOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function coercePhaseCards(mission: MissionDetail | null, runGraph: OrchestratorRunGraph | null): PhaseCard[] {
  const runMeta = isRecord(runGraph?.run.metadata) ? runGraph.run.metadata : null;
  const runPhaseOverride = Array.isArray(runMeta?.phaseOverride) ? runMeta.phaseOverride as PhaseCard[] : [];
  if (runPhaseOverride.length > 0) {
    return [...runPhaseOverride].sort((a, b) => a.position - b.position);
  }
  const missionPhases = Array.isArray(mission?.phaseConfiguration?.selectedPhases)
    ? mission.phaseConfiguration.selectedPhases
    : [];
  return [...missionPhases].sort((a, b) => a.position - b.position);
}

function normalizeInterventionMeta(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isPlanningQuestionIntervention(intervention: MissionIntervention): boolean {
  if (intervention.status !== "open" || intervention.interventionType !== "manual_input") return false;
  const metadata = isRecord(intervention.metadata) ? intervention.metadata : null;
  const source = normalizeInterventionMeta(metadata?.source);
  const reasonCode = normalizeInterventionMeta(metadata?.reasonCode);
  const phase = normalizeInterventionMeta(metadata?.phase);
  const phaseKey = normalizeInterventionMeta(metadata?.phaseKey);
  const phaseName = normalizeInterventionMeta(metadata?.phaseName);
  const stepType = normalizeInterventionMeta(metadata?.stepType);
  const ownerKind = normalizeInterventionMeta(metadata?.questionOwnerKind);
  return source === "ask_user"
    || reasonCode === "planner_natural_question"
    || reasonCode === "planner_required_question_missing"
    || phase === "planning"
    || phaseKey === "planning"
    || phaseName === "planning"
    || stepType === "planning"
    || ownerKind === "planner";
}

function terminalPhaseSummary(args: {
  missionStatus: MissionDetail["status"] | null | undefined;
  runStatus: OrchestratorRunGraph["run"]["status"];
}): string | null {
  if (args.missionStatus === "canceled" || args.runStatus === "canceled") {
    return "Mission canceled. Rerun to start a fresh run.";
  }
  if (args.missionStatus === "failed" || args.runStatus === "failed") {
    return "Mission failed. Review the feed or rerun after fixing the blocker.";
  }
  if (args.missionStatus === "completed" || args.runStatus === "succeeded") {
    return "Mission completed. Review artifacts or rerun for another pass.";
  }
  return null;
}

export type ActivePhaseViewModel = {
  currentPhaseKey: string | null;
  currentPhaseName: string | null;
  phase: PhaseCard | null;
  position: number | null;
  total: number;
  modeLabel: "blocked" | "manual" | "coordinator-driven" | "auto-assisted" | "closed";
  validationRequired: boolean;
  validationTier: string;
  clarificationLabel: string;
  whyActive: string;
  exitRequirements: string[];
  blockedLaterWork: string[];
  capabilityWarnings: string[];
};

export function deriveActivePhaseViewModel(args: {
  mission: MissionDetail | null;
  runGraph: OrchestratorRunGraph | null;
  modelCapabilities?: GetModelCapabilitiesResult | null;
}): ActivePhaseViewModel | null {
  const { mission, runGraph, modelCapabilities } = args;
  if (!runGraph) return null;
  const phases = coercePhaseCards(mission, runGraph);
  const runMeta = isRecord(runGraph.run.metadata) ? runGraph.run.metadata : null;
  const phaseRuntime = isRecord(runMeta?.phaseRuntime) ? runMeta.phaseRuntime : null;
  const currentPhaseKey = toOptionalString(phaseRuntime?.currentPhaseKey);
  const currentPhaseName = toOptionalString(phaseRuntime?.currentPhaseName);
  const phase = phases.find((entry) =>
    entry.phaseKey === currentPhaseKey
    || entry.name === currentPhaseName
  ) ?? null;
  const terminalSummary = terminalPhaseSummary({
    missionStatus: mission?.status,
    runStatus: runGraph.run.status,
  });

  const activePhase = phase ?? phases[0] ?? null;
  if (!activePhase) {
    return {
      currentPhaseKey,
      currentPhaseName,
      phase: null,
      position: null,
      total: 0,
      modeLabel: terminalSummary ? "closed" : runGraph.run.status === "paused" ? "blocked" : "coordinator-driven",
      validationRequired: false,
      validationTier: "none",
      clarificationLabel: "No phase profile attached",
      whyActive: terminalSummary ?? "This run has no visible phase snapshot. The orchestrator is operating without a user-visible phase profile.",
      exitRequirements: terminalSummary ? [] : ["Wait for the run to publish a phase snapshot or finish."],
      blockedLaterWork: [],
      capabilityWarnings: [],
    };
  }

  const position = phases.findIndex((entry) => entry.phaseKey === activePhase.phaseKey);
  if (terminalSummary) {
    return {
      currentPhaseKey,
      currentPhaseName,
      phase: activePhase,
      position: position >= 0 ? position + 1 : null,
      total: phases.length,
      modeLabel: "closed",
      validationRequired: activePhase.validationGate.required,
      validationTier: activePhase.validationGate.tier,
      clarificationLabel: activePhase.askQuestions.enabled
        ? `active phase owner may ask${activePhase.askQuestions.maxQuestions == null ? " without a question limit" : `, max ${activePhase.askQuestions.maxQuestions}`}`
        : "Ask questions disabled",
      whyActive: terminalSummary,
      exitRequirements: [],
      blockedLaterWork: [],
      capabilityWarnings: [],
    };
  }

  const openInterventions = mission?.interventions.filter((intervention) => intervention.status === "open") ?? [];
  const phaseSteps = filterExecutionSteps(runGraph.steps.filter((step) => {
    const metadata = isRecord(step.metadata) ? step.metadata : null;
    return metadata?.phaseKey === activePhase.phaseKey || metadata?.phaseName === activePhase.name;
  }));
  const laterPhaseSteps = filterExecutionSteps(runGraph.steps.filter((step) => {
    const metadata = isRecord(step.metadata) ? step.metadata : null;
    const stepPosition = Number(metadata?.phasePosition);
    return Number.isFinite(stepPosition) && stepPosition > activePhase.position;
  }));
  const laterBlocked = laterPhaseSteps
    .filter((step) => step.status === "blocked" || step.status === "pending" || step.status === "ready")
    .slice(0, 4)
    .map((step) => `${step.title} (${step.status})`);

  const inFlightCurrentPhase = phaseSteps.filter((step) => step.status === "running");
  const completedCurrentPhase = phaseSteps.filter((step) =>
    step.status === "succeeded" || step.status === "skipped" || step.status === "canceled"
  );
  const remainingCurrentPhaseCount = Math.max(0, phaseSteps.length - completedCurrentPhase.length);

  let modeLabel: ActivePhaseViewModel["modeLabel"] = "auto-assisted";
  if (runGraph.run.status === "paused" || openInterventions.length > 0) {
    modeLabel = "blocked";
  } else if (activePhase.askQuestions.enabled) {
    modeLabel = "manual";
  } else if (activePhase.phaseKey === "planning" || activePhase.phaseKey === "validation") {
    modeLabel = "coordinator-driven";
  }

  const whyBits: string[] = [];
  if (inFlightCurrentPhase.length > 0) {
    whyBits.push(`${inFlightCurrentPhase.length} step${inFlightCurrentPhase.length === 1 ? " is" : "s are"} active in this phase.`);
  } else if (phaseSteps.length > 0 && remainingCurrentPhaseCount > 0) {
    whyBits.push("This phase still has non-terminal work that must finish before advancement.");
  } else if (runGraph.run.status === "paused") {
    whyBits.push("The run is paused, so this phase remains active until the mission resumes.");
  } else {
    whyBits.push("This is the latest runtime phase snapshot recorded on the run.");
  }

  const exitRequirements: string[] = [];
  if (activePhase.phaseKey === "planning") {
    if (phaseSteps.length > 0 && remainingCurrentPhaseCount > 0) {
      exitRequirements.push(`Wait for the planning worker to finish and review ${remainingCurrentPhaseCount} remaining planning step(s).`);
    } else if (phaseSteps.length > 0) {
      exitRequirements.push("Planning worker output is ready for coordinator review.");
    } else {
      exitRequirements.push("The coordinator must either ask planning questions or start the planning worker.");
    }
    const openPlanningQuestions = openInterventions.filter(isPlanningQuestionIntervention);
    if (openPlanningQuestions.length > 0) {
      exitRequirements.push(`Answer ${openPlanningQuestions.length} open planning question(s).`);
    }
    if (activePhase.requiresApproval) {
      exitRequirements.push("Review the generated plan and explicitly approve the planning phase before ADE moves into Development.");
    } else {
      exitRequirements.push("Once the planner succeeds, ADE can move into Development immediately.");
    }
  } else if (activePhase.phaseKey === "validation") {
    if (phaseSteps.length > 0 && remainingCurrentPhaseCount > 0) {
      exitRequirements.push(`Finish the remaining validation step${remainingCurrentPhaseCount === 1 ? "" : "s"}.`);
    } else if (phaseSteps.length > 0) {
      exitRequirements.push("All executable validation steps are terminal. ADE can complete after coordinator review.");
    } else {
      exitRequirements.push("Validation is active. ADE will finish the final validation protocol before completion.");
    }
    if (openInterventions.length > 0) {
      exitRequirements.push(`Resolve ${openInterventions.length} open intervention(s).`);
    }
  } else {
    if (phaseSteps.length > 0 && remainingCurrentPhaseCount > 0) {
      exitRequirements.push(`Finish or explicitly disposition ${remainingCurrentPhaseCount} remaining step(s) in ${activePhase.name}.`);
    } else if (phaseSteps.length > 0) {
      exitRequirements.push(`All executable ${activePhase.name} steps are terminal. ADE can advance after coordinator review.`);
    } else {
      exitRequirements.push(`The coordinator must finish the ${activePhase.name} phase protocol before advancing.`);
    }
    if (activePhase.validationGate.required) {
      exitRequirements.push("A required validation step still needs to pass before ADE can move on.");
    }
    if (openInterventions.length > 0) {
      exitRequirements.push(`Resolve ${openInterventions.length} open intervention(s).`);
    }
  }

  const capabilityWarnings: string[] = [];
  const HARD_EVIDENCE_KINDS = new Set(["screenshot", "browser_verification", "video_recording", "browser_trace"]);
  const hardEvidence = (activePhase.validationGate.evidenceRequirements ?? []).filter((e) => HARD_EVIDENCE_KINDS.has(e));
  if (hardEvidence.length > 0) {
    const modelId = activePhase.model.modelId;
    const capabilityProfile = modelCapabilities?.profiles.find((p) => p.modelId === modelId) ?? null;
    if (!capabilityProfile) {
      capabilityWarnings.push(`Evidence requires ${hardEvidence.join(", ")}, but this run has no persisted capability profile for ${modelId}. Validate runtime support before relying on the gate.`);
    } else {
      const capabilityText = `${capabilityProfile.strengths.join(" ")} ${capabilityProfile.weaknesses.join(" ")}`.toLowerCase();
      const likelyBrowserCapable = capabilityText.includes("browser") || capabilityText.includes("computer use") || capabilityText.includes("verification");
      if (!likelyBrowserCapable) {
        capabilityWarnings.push(`Evidence requires ${hardEvidence.join(", ")}, but ${capabilityProfile.displayName} does not advertise browser/screenshot capability in the current runtime profile.`);
      }
    }
  }
  if (activePhase.validationGate.required && activePhase.validationGate.capabilityFallback === "warn") {
    capabilityWarnings.push("This phase is configured to warn rather than hard-block when evidence capability is missing.");
  }

  return {
    currentPhaseKey,
    currentPhaseName,
    phase: activePhase,
    position: position >= 0 ? position + 1 : null,
    total: phases.length,
    modeLabel,
    validationRequired: activePhase.validationGate.required,
    validationTier: activePhase.validationGate.tier,
    clarificationLabel: activePhase.askQuestions.enabled
      ? `active phase owner may ask${activePhase.askQuestions.maxQuestions == null ? " without a question limit" : `, max ${activePhase.askQuestions.maxQuestions}`}`
      : "Ask questions disabled",
    whyActive: whyBits.join(" "),
    exitRequirements,
    blockedLaterWork: laterBlocked,
    capabilityWarnings,
  };
}

export type MissionArtifactRecord = {
  id: string;
  source: "mission" | "orchestrator" | "checkpoint";
  title: string;
  description: string | null;
  artifactType: string;
  stepId: string | null;
  stepTitle: string | null;
  workerId: string | null;
  workerLabel: string | null;
  phaseKey: string | null;
  phaseName: string | null;
  uri: string | null;
  textContent: string | null;
  declared: boolean;
  missingExpectedEvidence: boolean;
  createdAt: string;
};

export type GroupedMissionArtifacts = {
  all: MissionArtifactRecord[];
  byPhase: Array<{ key: string; label: string; items: MissionArtifactRecord[] }>;
  byStep: Array<{ key: string; label: string; items: MissionArtifactRecord[] }>;
  byWorker: Array<{ key: string; label: string; items: MissionArtifactRecord[] }>;
  byType: Array<{ key: string; label: string; items: MissionArtifactRecord[] }>;
  expectedEvidence: ValidationEvidenceRequirement[];
};

function normalizeMissionArtifacts(mission: MissionDetail | null): MissionArtifactRecord[] {
  const artifacts = mission?.artifacts ?? [];
  return artifacts.map((artifact): MissionArtifactRecord => ({
    id: artifact.id,
    source: "mission",
    title: artifact.title,
    description: artifact.description,
    artifactType: resolveCloseoutRequirementKeyFromArtifact({
      artifactType: artifact.artifactType,
      metadata: artifact.metadata,
    }) ?? artifact.artifactType,
    stepId: toOptionalString(artifact.metadata?.stepId),
    stepTitle: toOptionalString(artifact.metadata?.stepTitle),
    workerId: toOptionalString(artifact.metadata?.attemptId)
      ?? toOptionalString(artifact.metadata?.workerId)
      ?? toOptionalString(artifact.metadata?.workerName)
      ?? toOptionalString(artifact.createdBy),
    workerLabel: toOptionalString(artifact.metadata?.workerName)
      ?? toOptionalString(artifact.metadata?.workerLabel)
      ?? toOptionalString(artifact.createdBy),
    phaseKey: toOptionalString(artifact.metadata?.phaseKey),
    phaseName: toOptionalString(artifact.metadata?.phaseName),
    uri: artifact.uri,
    textContent: artifact.description,
    declared: true,
    missingExpectedEvidence: false,
    createdAt: artifact.createdAt,
  }));
}

type StepMap = Map<string, OrchestratorRunGraph["steps"][number]>;

function buildStepMap(runGraph: OrchestratorRunGraph | null): StepMap {
  return new Map((runGraph?.steps ?? []).map((step) => [step.id, step] as const));
}

type AttemptMap = Map<string, OrchestratorRunGraph["attempts"][number]>;

function buildAttemptMap(runGraph: OrchestratorRunGraph | null): AttemptMap {
  return new Map((runGraph?.attempts ?? []).map((attempt) => [attempt.id, attempt] as const));
}

function shortArtifactWorkerId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function resolveArtifactWorkerLabel(args: {
  artifactMeta?: Record<string, unknown> | null;
  stepMeta?: Record<string, unknown> | null;
  stepTitle?: string | null;
  attemptId?: string | null;
  attemptOwnerId?: string | null;
}): string | null {
  return toOptionalString(args.artifactMeta?.workerName)
    ?? toOptionalString(args.artifactMeta?.workerLabel)
    ?? toOptionalString(args.stepMeta?.workerName)
    ?? toOptionalString(args.stepMeta?.workerLabel)
    ?? toOptionalString(args.attemptOwnerId)
    ?? args.stepTitle
    ?? (args.attemptId ? `Worker ${shortArtifactWorkerId(args.attemptId)}` : null);
}

function normalizeOrchestratorArtifacts(stepById: StepMap, artifacts: OrchestratorArtifact[]): MissionArtifactRecord[] {
  return artifacts.map((artifact) => {
    const step = artifact.stepId ? stepById.get(artifact.stepId) ?? null : null;
    const metadata = isRecord(step?.metadata) ? step.metadata : null;
    const artifactMeta = isRecord(artifact.metadata) ? artifact.metadata : null;
    return {
      id: artifact.id,
      source: "orchestrator",
      title: toOptionalString(artifactMeta?.title) ?? artifact.artifactKey.replace(/_/g, " "),
      description: toOptionalString(artifactMeta?.summary) ?? toOptionalString(artifactMeta?.description),
      artifactType: resolveCloseoutRequirementKeyFromArtifact({
        artifactKey: artifact.artifactKey,
        kind: artifact.kind,
        metadata: artifact.metadata,
      }) ?? artifact.kind,
      stepId: artifact.stepId,
      stepTitle: step?.title ?? null,
      workerId: artifact.attemptId ?? artifact.stepId ?? null,
      workerLabel: resolveArtifactWorkerLabel({
        artifactMeta,
        stepMeta: metadata,
        stepTitle: step?.title ?? null,
        attemptId: artifact.attemptId,
      }),
      phaseKey: toOptionalString(metadata?.phaseKey),
      phaseName: toOptionalString(metadata?.phaseName),
      uri: resolveOrchestratorArtifactUri({
        kind: artifact.kind,
        value: artifact.value,
        metadata: artifact.metadata,
      }),
      textContent: artifact.kind === "custom" || artifact.kind === "checkpoint" || artifact.kind === "test_report" ? artifact.value : null,
      declared: artifact.declared,
      missingExpectedEvidence: false,
      createdAt: artifact.createdAt,
    };
  });
}

function normalizeCheckpoints(stepById: StepMap, attemptById: AttemptMap, checkpoints: OrchestratorWorkerCheckpoint[]): MissionArtifactRecord[] {
  return checkpoints.map((checkpoint) => {
    const step = stepById.get(checkpoint.stepId) ?? null;
    const metadata = isRecord(step?.metadata) ? step.metadata : null;
    const attempt = attemptById.get(checkpoint.attemptId) ?? null;
    const attemptMetadata = isRecord(attempt?.metadata) ? attempt.metadata : null;
    return {
      id: checkpoint.id,
      source: "checkpoint",
      title: `Checkpoint: ${checkpoint.stepKey}`,
      description: checkpoint.filePath,
      artifactType: "checkpoint",
      stepId: checkpoint.stepId,
      stepTitle: step?.title ?? null,
      workerId: checkpoint.attemptId ?? checkpoint.stepId ?? null,
      workerLabel: resolveArtifactWorkerLabel({
        stepMeta: metadata,
        stepTitle: step?.title ?? checkpoint.stepKey,
        attemptId: checkpoint.attemptId,
        attemptOwnerId: toOptionalString(attemptMetadata?.ownerId),
      }),
      phaseKey: toOptionalString(metadata?.phaseKey),
      phaseName: toOptionalString(metadata?.phaseName),
      uri: checkpoint.filePath,
      textContent: checkpoint.content,
      declared: true,
      missingExpectedEvidence: false,
      createdAt: checkpoint.updatedAt,
    };
  });
}

function buildGroups(items: MissionArtifactRecord[], keyFn: (item: MissionArtifactRecord) => string, labelFn: (item: MissionArtifactRecord) => string) {
  const map = new Map<string, { key: string; label: string; items: MissionArtifactRecord[] }>();
  for (const item of items) {
    const key = keyFn(item);
    const label = labelFn(item);
    const bucket = map.get(key) ?? { key, label, items: [] };
    bucket.items.push(item);
    map.set(key, bucket);
  }
  return [...map.values()].sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
}

export function buildMissionArtifactGroups(args: {
  mission: MissionDetail | null;
  runGraph: OrchestratorRunGraph | null;
  orchestratorArtifacts: OrchestratorArtifact[];
  checkpoints: OrchestratorWorkerCheckpoint[];
}): GroupedMissionArtifacts {
  const stepById = buildStepMap(args.runGraph);
  const attemptById = buildAttemptMap(args.runGraph);
  const missionArtifacts = normalizeMissionArtifacts(args.mission);
  const orchestratorArtifacts = normalizeOrchestratorArtifacts(stepById, args.orchestratorArtifacts);
  const checkpointArtifacts = normalizeCheckpoints(stepById, attemptById, args.checkpoints);
  const all = [...missionArtifacts, ...orchestratorArtifacts, ...checkpointArtifacts]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const phaseCards = coercePhaseCards(args.mission, args.runGraph);
  const expectedEvidence = [...new Set(
    phaseCards.flatMap((phase) => phase.validationGate.evidenceRequirements ?? [])
  )];
  const presentEvidence = new Set(all.map((artifact) => artifact.artifactType));
  for (const requirement of expectedEvidence) {
    if (presentEvidence.has(requirement)) continue;
    all.push({
      id: `missing:${requirement}`,
      source: "orchestrator",
      title: `Expected evidence missing: ${requirement.replace(/_/g, " ")}`,
      description: "Configured as required evidence, but no artifact has been attached yet.",
      artifactType: requirement,
      stepId: null,
      stepTitle: null,
      workerId: null,
      workerLabel: null,
      phaseKey: null,
      phaseName: null,
      uri: null,
      textContent: null,
      declared: true,
      missingExpectedEvidence: true,
      createdAt: new Date(0).toISOString(),
    });
  }

  return {
    all,
    byPhase: buildGroups(
      all,
      (item) => item.phaseKey ?? "unassigned",
      (item) => item.phaseName ?? "Unassigned phase",
    ),
    byStep: buildGroups(
      all,
      (item) => item.stepId ?? "mission",
      (item) => item.stepTitle ?? "Mission-level artifacts",
    ),
    byWorker: buildGroups(
      all,
      (item) => item.workerId ?? item.stepId ?? "mission",
      (item) => item.workerLabel ?? item.stepTitle ?? "Mission-level artifacts",
    ),
    byType: buildGroups(
      all,
      (item) => item.artifactType,
      (item) => item.artifactType.replace(/_/g, " "),
    ),
    expectedEvidence,
  };
}
