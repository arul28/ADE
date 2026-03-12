import type {
  GetModelCapabilitiesResult,
  MissionDetail,
  OrchestratorArtifact,
  OrchestratorRunGraph,
  OrchestratorWorkerCheckpoint,
  PhaseCard,
  ValidationEvidenceRequirement,
} from "../../../shared/types";
import { isRecord } from "./missionHelpers";
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

export type ActivePhaseViewModel = {
  currentPhaseKey: string | null;
  currentPhaseName: string | null;
  phase: PhaseCard | null;
  position: number | null;
  total: number;
  modeLabel: "blocked" | "manual" | "coordinator-driven" | "auto-assisted";
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

  const activePhase = phase ?? phases[0] ?? null;
  if (!activePhase) {
    return {
      currentPhaseKey,
      currentPhaseName,
      phase: null,
      position: null,
      total: 0,
      modeLabel: runGraph.run.status === "paused" ? "blocked" : "coordinator-driven",
      validationRequired: false,
      validationTier: "none",
      clarificationLabel: "No phase profile attached",
      whyActive: "This run has no visible phase snapshot. The orchestrator is operating without a user-visible phase profile.",
      exitRequirements: ["Wait for the run to publish a phase snapshot or finish."],
      blockedLaterWork: [],
      capabilityWarnings: [],
    };
  }

  const position = phases.findIndex((entry) => entry.phaseKey === activePhase.phaseKey);
  const openInterventions = mission?.interventions.filter((intervention) => intervention.status === "open") ?? [];
  const phaseSteps = runGraph.steps.filter((step) => {
    const metadata = isRecord(step.metadata) ? step.metadata : null;
    return metadata?.phaseKey === activePhase.phaseKey || metadata?.phaseName === activePhase.name;
  });
  const laterPhaseSteps = runGraph.steps.filter((step) => {
    const metadata = isRecord(step.metadata) ? step.metadata : null;
    const stepPosition = Number(metadata?.phasePosition);
    return Number.isFinite(stepPosition) && stepPosition > activePhase.position;
  });
  const laterBlocked = laterPhaseSteps
    .filter((step) => step.status === "blocked" || step.status === "pending" || step.status === "ready")
    .slice(0, 4)
    .map((step) => `${step.title} (${step.status})`);

  const inFlightCurrentPhase = phaseSteps.filter((step) => step.status === "running");
  const completedCurrentPhase = phaseSteps.filter((step) =>
    step.status === "succeeded" || step.status === "skipped" || step.status === "canceled"
  );

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
  } else if (phaseSteps.length > 0 && completedCurrentPhase.length < phaseSteps.length) {
    whyBits.push("This phase still has non-terminal work that must finish before advancement.");
  } else if (runGraph.run.status === "paused") {
    whyBits.push("The run is paused, so this phase remains active until the mission resumes.");
  } else {
    whyBits.push("This is the latest runtime phase snapshot recorded on the run.");
  }

  const exitRequirements: string[] = [];
  if (activePhase.phaseKey === "planning") {
    if (phaseSteps.length > 0) {
      exitRequirements.push(`Wait for the planning worker to finish and review ${phaseSteps.length - completedCurrentPhase.length} remaining planning step(s).`);
    } else {
      exitRequirements.push("The coordinator must either ask planning questions or start the planning worker.");
    }
    if (openInterventions.length > 0) {
      exitRequirements.push(`Answer ${openInterventions.length} open planning question(s).`);
    } else {
      exitRequirements.push("Once the planner succeeds, ADE should move into Development without a separate plan-exit approval step.");
    }
  } else if (activePhase.phaseKey === "validation") {
    if (phaseSteps.length > 0) {
      exitRequirements.push(`Finish the remaining validation step${phaseSteps.length - completedCurrentPhase.length === 1 ? "" : "s"}.`);
    } else {
      exitRequirements.push("Validation is active. ADE will finish the final validation protocol before completion.");
    }
    if (openInterventions.length > 0) {
      exitRequirements.push(`Resolve ${openInterventions.length} open intervention(s).`);
    }
  } else {
    if (phaseSteps.length > 0) {
      exitRequirements.push(`Finish or explicitly disposition ${phaseSteps.length - completedCurrentPhase.length} remaining step(s) in ${activePhase.name}.`);
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
      ? `active phase owner may ask${activePhase.askQuestions.maxQuestions ? `, max ${activePhase.askQuestions.maxQuestions}` : ""}`
      : "Ask questions disabled",
    whyActive: whyBits.join(" "),
    exitRequirements,
    blockedLaterWork: laterBlocked,
    capabilityWarnings,
  };
}

export type UnifiedMissionArtifact = {
  id: string;
  source: "mission" | "orchestrator" | "checkpoint";
  title: string;
  description: string | null;
  artifactType: string;
  stepId: string | null;
  stepTitle: string | null;
  phaseKey: string | null;
  phaseName: string | null;
  uri: string | null;
  textContent: string | null;
  declared: boolean;
  missingExpectedEvidence: boolean;
  createdAt: string;
};

export type GroupedMissionArtifacts = {
  all: UnifiedMissionArtifact[];
  byPhase: Array<{ key: string; label: string; items: UnifiedMissionArtifact[] }>;
  byStep: Array<{ key: string; label: string; items: UnifiedMissionArtifact[] }>;
  byType: Array<{ key: string; label: string; items: UnifiedMissionArtifact[] }>;
  expectedEvidence: ValidationEvidenceRequirement[];
};

function normalizeMissionArtifacts(mission: MissionDetail | null): UnifiedMissionArtifact[] {
  const artifacts = mission?.artifacts ?? [];
  return artifacts.map((artifact): UnifiedMissionArtifact => ({
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

function normalizeOrchestratorArtifacts(stepById: StepMap, artifacts: OrchestratorArtifact[]): UnifiedMissionArtifact[] {
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

function normalizeCheckpoints(stepById: StepMap, checkpoints: OrchestratorWorkerCheckpoint[]): UnifiedMissionArtifact[] {
  return checkpoints.map((checkpoint) => {
    const step = stepById.get(checkpoint.stepId) ?? null;
    const metadata = isRecord(step?.metadata) ? step.metadata : null;
    return {
      id: checkpoint.id,
      source: "checkpoint",
      title: `Checkpoint: ${checkpoint.stepKey}`,
      description: checkpoint.filePath,
      artifactType: "checkpoint",
      stepId: checkpoint.stepId,
      stepTitle: step?.title ?? null,
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

function buildGroups(items: UnifiedMissionArtifact[], keyFn: (item: UnifiedMissionArtifact) => string, labelFn: (item: UnifiedMissionArtifact) => string) {
  const map = new Map<string, { key: string; label: string; items: UnifiedMissionArtifact[] }>();
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
  const missionArtifacts = normalizeMissionArtifacts(args.mission);
  const orchestratorArtifacts = normalizeOrchestratorArtifacts(stepById, args.orchestratorArtifacts);
  const checkpointArtifacts = normalizeCheckpoints(stepById, args.checkpoints);
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
    byType: buildGroups(
      all,
      (item) => item.artifactType,
      (item) => item.artifactType.replace(/_/g, " "),
    ),
    expectedEvidence,
  };
}
