import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import type {
  MissionDetail,
  MissionExecutionPolicy,
  MissionStepStatus,
  MissionStatus,
  CancelOrchestratorRunArgs,
  OrchestratorExecutorKind,
  OrchestratorRun,
  OrchestratorRunGraph,
  OrchestratorStep,
  OrchestratorRuntimeEvent,
  OrchestratorStepStatus,
  OrchestratorWorkerState,
  OrchestratorWorkerStatus,
  OrchestratorRuntimeQuestionLink,
  TerminalRuntimeState,
  SteerMissionArgs,
  SteerMissionResult,
  CleanupOrchestratorTeamResourcesArgs,
  CleanupOrchestratorTeamResourcesResult,
  UserSteeringDirective,
  OrchestratorChatMessage,
  OrchestratorChatThread,
  OrchestratorChatTarget,
  SendOrchestratorChatArgs,
  GetOrchestratorChatArgs,
  ListOrchestratorChatThreadsArgs,
  GetOrchestratorThreadMessagesArgs,
  SendOrchestratorThreadMessageArgs,
  OrchestratorWorkerDigest,
  ListOrchestratorWorkerDigestsArgs,
  GetOrchestratorWorkerDigestArgs,
  GetOrchestratorContextCheckpointArgs,
  ListOrchestratorLaneDecisionsArgs,
  ListOrchestratorArtifactsArgs,
  ListOrchestratorWorkerCheckpointsArgs,
  MissionMetricsConfig,
  MissionMetricSample,
  GetMissionMetricsArgs,
  SetMissionMetricsConfigArgs,
  OrchestratorThreadEvent,
  DagMutationEvent,
  AgentChatEvent,
  AgentChatEventEnvelope,
  DelegationContract,
  TeamManifest,
  ExecutionPlanPreview,
  ExecutionPlanPhase,
  ExecutionPlanStepPreview,
  OrchestratorWorkerRole,
  RecoveryLoopPolicy,
  AggregatedUsageStats,
  GetAggregatedUsageArgs,
  RecoveryLoopState,
  IntegrationPrPolicy,
  PrStrategy,
  StartOrchestratorRunStepInput,
  OrchestratorRunStatus,
  OrchestratorTeamMember,
  OrchestratorTeamRuntimeState,
  TeamRuntimeConfig,
  FinalizeRunArgs,
  FinalizeRunResult,
  GetMissionStateDocumentArgs,
  MissionStateDocument,
  MissionStateDocumentPatch,
  MissionCloseoutRequirement,
  MissionCloseoutRequirementKey,
  MissionFinalizationPolicy,
  MissionFinalizationState,
  MissionCoordinatorAvailability,
  MissionStatePendingIntervention,
  MissionStateProgress,
  MissionStateStepOutcome,
  GetMissionLogsArgs,
  GetMissionLogsResult,
  GetMissionRunViewArgs,
  MissionLogEntry,
  MissionLogChannel,
  ExportMissionLogsArgs,
  ExportMissionLogsResult,
  MissionRunView,
  MissionRunViewDisplayStatus,
  MissionRunViewHaltReason,
  MissionRunViewLatestIntervention,
  MissionRunViewProgressItem,
  MissionRunViewSeverity,
  MissionRunViewWorkerSummary,
  OrchestratorArtifact,
  OrchestratorWorkerCheckpoint,
  GetOrchestratorPromptInspectorArgs,
  GetPlanningPromptPreviewArgs,
  OrchestratorPromptInspector,
  ValidationEvidenceRequirement,
} from "../../../shared/types";
import type { ModelConfig, OrchestratorCallType } from "../../../shared/types";
import {
  DEFAULT_RECOVERY_LOOP_POLICY,
  DEFAULT_INTEGRATION_PR_POLICY,
} from "./orchestratorConstants";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { modelConfigToServiceModel } from "../../../shared/modelProfiles";
import { getModelById } from "../../../shared/modelRegistry";
import { isWorkerBootstrapNoiseLine } from "../../../shared/workerRuntimeNoise";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createMissionService } from "../missions/missionService";
import type { createOrchestratorService } from "./orchestratorService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createLaneService } from "../lanes/laneService";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createPrService } from "../prs/prService";
import type { createConflictService } from "../conflicts/conflictService";
import type { createQueueLandingService } from "../prs/queueLandingService";
import type { ComputerUseArtifactBrokerService } from "../computerUse/computerUseArtifactBrokerService";
import {
  buildComputerUseOwnerSnapshot,
  collectRequiredComputerUseKindsFromPhases,
  getComputerUseArtifactKinds,
} from "../computerUse/controlPlane";
import { createMemoryService } from "../memory/memoryService";
import { CoordinatorAgent, type CoordinatorPlanningStartupFailure } from "./coordinatorAgent";
import { routeEventToCoordinator } from "./runtimeEventRouter";
import {
  deleteCoordinatorCheckpoint,
  getCoordinatorCheckpointPath,
  getMissionStateDocumentPath,
  readCoordinatorCheckpoint,
  readMissionStateDocument,
  updateMissionStateDocument,
} from "./missionStateDoc";
import { getErrorMessage, normalizeBranchName } from "../shared/utils";
import {
  buildCoordinatorPromptInspector,
  buildPlanningPromptPreview,
  buildWorkerPromptInspector,
} from "./promptInspector";

type CoordinatorLifecycleState =
  | "booting"
  | "analyzing_prompt"
  | "fetching_project_context"
  | "launching_planner"
  | "waiting_on_planner"
  | "planner_launch_failed"
  | "stopped";

// ── Module imports (extracted from this file) ────────────────────
import type {
  PendingIntegrationContext,
  MissionRunStartArgs,
  MissionRunStartResult,
  OrchestratorHookCommandRunner,
  MissionRuntimeProfile,
  SessionRuntimeSignal,
  AttemptRuntimeTracker,
  OrchestratorChatSessionState,
  WorkerDeliveryContext,
  ParallelMissionStepDescriptor,
  ResolvedCallTypeConfig,
} from "./orchestratorContext";

// Re-export all types
export type { OrchestratorContext } from "./orchestratorContext";

// Import all constants, helpers, and utility functions from orchestratorContext
import {
  STEERING_DIRECTIVES_METADATA_KEY,
  MAX_PERSISTED_STEERING_DIRECTIVES,
  HEALTH_SWEEP_INTERVAL_MS,
  HEALTH_SWEEP_ACTIVE_RUN_SCAN_LIMIT,
  STALE_ATTEMPT_GRACE_MS,
  WORKER_WAITING_INPUT_INTERVENTION_COOLDOWN_MS,
  WORKER_EVENT_HEARTBEAT_INTERVAL_MS,
  MAX_CHAT_LINE_CHARS,
  MAX_LATEST_CHAT_MESSAGE_CHARS,
  GRACEFUL_CANCEL_NOTIFY_TIMEOUT_MS,
  GRACEFUL_CANCEL_INTERRUPT_TIMEOUT_MS,
  GRACEFUL_CANCEL_DISPOSE_TIMEOUT_MS,
  GRACEFUL_CANCEL_DRAIN_WAIT_MS,
  GRACEFUL_CANCEL_DRAIN_POLL_MS,
  MAX_STEERING_CONTEXT_DIRECTIVES,
  MAX_STEERING_CONTEXT_CHARS,
  MAX_STEERING_DIRECTIVES_PER_STEP,
  MAX_RUNTIME_SIGNAL_PREVIEW_CHARS,
  ACTIVE_ATTEMPT_STATUSES,
  CALL_TYPE_DEFAULTS,
  // Utility functions
  nowIso,
  runBestEffortWithTimeout,
  isRecord,
  asRecord,
  asBool,
  digestSignalText,
  buildQuestionThreadLink,
  buildQuestionReplyLink,
  parseQuestionLink,
  detectWaitingInputSignal,
  clipTextForContext,
  parseJsonRecord,
  workerStateFromRuntimeSignal,
  parseTerminalRuntimeState,
  toOptionalString,
  readConfig,
  mapOrchestratorStepStatus,
  deriveMissionStatusFromRun,
  buildOutcomeSummary,
  buildConflictResolutionInstructions,
  extractRunFailureMessage,
  filterExecutionSteps,
  runOrchestratorHookCommand,
  getModelCapabilities,
} from "./orchestratorContext";

// Re-export public functions that external consumers depend on
export { getModelCapabilities } from "./orchestratorContext";

// Import from coordinator session module
import {
  PM_SYSTEM_PREAMBLE,
} from "./coordinatorSession";

// Import from runtime event router module
import {
  onAgentChatEvent as onAgentChatEventCtx,
  onSessionRuntimeSignal as onSessionRuntimeSignalCtx,
  pruneSessionRuntimeSignals as pruneSessionRuntimeSignalsCtx,
} from "./runtimeEventRouter";

// Import from mission lifecycle module
import {
  inferRoleFromStepMetadata,
  isParallelCandidateStepType,
  stepTitleForMessage,
  resolveAttemptOwnerId,
  resolveAttemptOwnerIdFromRows,
  TERMINAL_PHASE_STEP_STATUSES,
  discoverProjectDocs as discoverProjectDocsCtx,
  resolveActivePolicy as resolveActivePolicyCtx,
  resolveActivePhaseSettings as resolveActivePhaseSettingsCtx,
  resolveActiveRuntimeProfile as resolveActiveRuntimeProfileCtx,
  transitionMissionStatus as transitionMissionStatusCtx,
  getMaxCoordinatorRecoveries as getMaxCoordinatorRecoveriesCtx,
  dispatchOrchestratorHookCtx,
  maybeDispatchTeammateIdleHookCtx,
} from "./missionLifecycle";
import type { HookDispatchDeps } from "./missionLifecycle";
import { hasMaterialWorkerChatEvent } from "../../../shared/chatTranscript";
import {
  isProofEvidenceRequirement,
  resolveCloseoutRequirementKeyFromArtifact,
  resolveOrchestratorArtifactUri,
} from "../../../shared/proofArtifacts";
import { getCapabilityForRequirement } from "../computerUse/localComputerUse";

// ── Intervention Prompt Builder ──

function buildInterventionResolverPrompt(args: {
  missionTitle: string;
  missionPrompt: string;
  interventionDescription: string;
  runContext: string;
  steeringContext: string;
  confidenceThreshold: number;
}): string {
  return [
    `You are an AI orchestrator deciding how to handle an intervention during a mission.`,
    ``,
    `Mission: ${args.missionTitle}`,
    `Prompt: ${args.missionPrompt.slice(0, 300)}`,
    ``,
    `Intervention: ${args.interventionDescription}`,
    ``,
    `Run context: ${args.runContext}`,
    args.steeringContext.length > 0 ? `\nSteering context:\n${args.steeringContext}` : "",
    ``,
    `Confidence threshold for auto-resolution: ${args.confidenceThreshold}`,
    ``,
    `Respond with a JSON object:`,
    `{`,
    `  "autoResolvable": boolean,`,
    `  "confidence": number (0-1),`,
    `  "suggestedAction": "retry" | "skip" | "add_workaround" | "escalate",`,
    `  "reasoning": string,`,
    `  "retryInstructions": string (if action is retry)`,
    `}`
  ].join("\n");
}

type MissionLaunchFailureStage =
  | "run_created"
  | "memory_init"
  | "lane_create"
  | "coordinator_start"
  | "run_activate";

export function buildCoordinatorEvaluationActionHints(graph: OrchestratorRunGraph): string[] {
  const hints: string[] = [];
  const executionSteps = filterExecutionSteps(graph.steps);
  if (executionSteps.length === 0) return hints;

  const runMeta = isRecord(graph.run.metadata) ? graph.run.metadata : null;
  const phaseRuntime = isRecord(runMeta?.phaseRuntime) ? runMeta.phaseRuntime : null;
  const currentPhaseKey = typeof phaseRuntime?.currentPhaseKey === "string" ? phaseRuntime.currentPhaseKey.trim().toLowerCase() : "";
  const currentPhaseName = typeof phaseRuntime?.currentPhaseName === "string" ? phaseRuntime.currentPhaseName.trim().toLowerCase() : "";

  const stepsInCurrentPhase = executionSteps.filter((step) => {
    const stepMeta = isRecord(step.metadata) ? step.metadata : null;
    const stepPhaseKey = typeof stepMeta?.phaseKey === "string" ? stepMeta.phaseKey.trim().toLowerCase() : "";
    const stepPhaseName = typeof stepMeta?.phaseName === "string" ? stepMeta.phaseName.trim().toLowerCase() : "";
    if (currentPhaseKey.length > 0 && stepPhaseKey === currentPhaseKey) return true;
    if (currentPhaseName.length > 0 && stepPhaseName === currentPhaseName) return true;
    return false;
  });
  const currentPhaseTerminal = stepsInCurrentPhase.filter((step) => TERMINAL_PHASE_STEP_STATUSES.has(step.status));
  const currentPhaseNonTerminal = stepsInCurrentPhase.filter((step) => !TERMINAL_PHASE_STEP_STATUSES.has(step.status));
  const remainingExecution = executionSteps.filter((step) => !TERMINAL_PHASE_STEP_STATUSES.has(step.status));
  const currentPhasePlanningSucceeded =
    currentPhaseKey === "planning" || currentPhaseName === "planning"
      ? stepsInCurrentPhase.some((step) => step.status === "succeeded")
      : false;

  if (
    (currentPhaseKey === "planning" || currentPhaseName === "planning")
    && currentPhasePlanningSucceeded
    && currentPhaseTerminal.length > 0
    && currentPhaseNonTerminal.length === 0
  ) {
    hints.push("REQUIRED NEXT ACTION: Planning work is complete. Call set_current_phase with phaseKey \"development\" before spawning any implementation workers.");
  }

  if (remainingExecution.length === 0) {
    if (currentPhaseKey === "planning" || currentPhaseName === "planning") {
      if (currentPhasePlanningSucceeded) {
        hints.push("REQUIRED NEXT ACTION: The run has no executable work left but is still in planning. Advance to the next phase and spawn the implementation work, or call fail_mission if the mission cannot proceed.");
      } else {
        hints.push("REQUIRED NEXT ACTION: Planning has no active executable work and no successful planner result yet. Spawn a replacement planning worker or fail the mission if planning cannot proceed.");
      }
    } else {
      hints.push("REQUIRED NEXT ACTION: All executable steps are terminal. If the mission goal is satisfied, call complete_mission with a concise summary. Otherwise create or spawn the missing follow-up work now.");
    }
  }

  return hints;
}

type PhaseSyncTarget = {
  phaseKey: string;
  phaseName: string;
  phaseModel: Record<string, unknown> | null;
  phaseInstructions: string | null;
  phaseValidation: Record<string, unknown> | null;
  phaseBudget: Record<string, unknown> | null;
  sourceStepId: string | null;
};

type PhaseSyncCard = {
  phaseKey: string;
  name: string;
  position: number;
  model: Record<string, unknown> | null;
  instructions: string | null;
  validationGate: Record<string, unknown> | null;
  budget: Record<string, unknown> | null;
};

function sortStepsForPhaseSync(steps: OrchestratorStep[]): OrchestratorStep[] {
  return [...steps].sort((a, b) => {
    const aMeta = isRecord(a.metadata) ? a.metadata : {};
    const bMeta = isRecord(b.metadata) ? b.metadata : {};
    const aPhasePos = Number(aMeta.phasePosition ?? Number.MAX_SAFE_INTEGER);
    const bPhasePos = Number(bMeta.phasePosition ?? Number.MAX_SAFE_INTEGER);
    if (Number.isFinite(aPhasePos) && Number.isFinite(bPhasePos) && aPhasePos !== bPhasePos) {
      return aPhasePos - bPhasePos;
    }
    if (a.stepIndex !== b.stepIndex) return a.stepIndex - b.stepIndex;
    return a.title.localeCompare(b.title);
  });
}

function deriveConfiguredPhasesForSync(graph: OrchestratorRunGraph): PhaseSyncCard[] {
  const runMeta = isRecord(graph.run.metadata) ? graph.run.metadata : {};
  const rawPhases = Array.isArray(runMeta.phaseOverride) ? runMeta.phaseOverride : [];
  return rawPhases
    .map((entry) => {
      const phase = asRecord(entry);
      if (!phase) return null;
      const phaseKey = typeof phase.phaseKey === "string" ? phase.phaseKey.trim() : "";
      const name = typeof phase.name === "string" ? phase.name.trim() : "";
      if (!phaseKey.length || !name.length) return null;
      const positionRaw = Number(phase.position ?? Number.MAX_SAFE_INTEGER);
      return {
        phaseKey,
        name,
        position: Number.isFinite(positionRaw) ? positionRaw : Number.MAX_SAFE_INTEGER,
        model: asRecord(phase.model),
        instructions: typeof phase.instructions === "string" && phase.instructions.trim().length > 0
          ? phase.instructions.trim()
          : null,
        validationGate: asRecord(phase.validationGate),
        budget: asRecord(phase.budget),
      } satisfies PhaseSyncCard;
    })
    .filter((phase): phase is PhaseSyncCard => phase !== null)
    .sort((a, b) => a.position - b.position);
}

function stepMatchesPhaseForSync(step: OrchestratorStep, phase: PhaseSyncCard): boolean {
  const meta = isRecord(step.metadata) ? step.metadata : {};
  const stepPhaseKey = typeof meta.phaseKey === "string" ? meta.phaseKey.trim() : "";
  const stepPhaseName = typeof meta.phaseName === "string" ? meta.phaseName.trim() : "";
  return stepPhaseKey === phase.phaseKey || stepPhaseName === phase.name;
}

function phaseStepCountsAsCompleteForSync(step: OrchestratorStep, phase: PhaseSyncCard): boolean {
  const phaseKey = phase.phaseKey.trim().toLowerCase();
  const phaseName = phase.name.trim().toLowerCase();
  if (phaseKey === "planning" || phaseName === "planning") {
    return step.status === "succeeded";
  }
  return TERMINAL_PHASE_STEP_STATUSES.has(step.status);
}

function buildPhaseSyncTargetFromCard(card: PhaseSyncCard, sourceStepId: string | null): PhaseSyncTarget {
  return {
    phaseKey: card.phaseKey,
    phaseName: card.name,
    phaseModel: card.model,
    phaseInstructions: card.instructions,
    phaseValidation: card.validationGate,
    phaseBudget: card.budget,
    sourceStepId,
  };
}

export function deriveMissionPhaseSyncTarget(graph: OrchestratorRunGraph): PhaseSyncTarget | null {
  const executionSteps = sortStepsForPhaseSync(filterExecutionSteps(graph.steps));
  const runMeta = isRecord(graph.run.metadata) ? graph.run.metadata : {};
  const phaseRuntime = isRecord(runMeta.phaseRuntime) ? runMeta.phaseRuntime : {};
  const currentPhaseKey = typeof phaseRuntime.currentPhaseKey === "string" ? phaseRuntime.currentPhaseKey.trim() : "";
  const currentPhaseName = typeof phaseRuntime.currentPhaseName === "string" ? phaseRuntime.currentPhaseName.trim() : "";
  const configuredPhases = deriveConfiguredPhasesForSync(graph);

  if (configuredPhases.length > 0) {
    const currentPhaseIndex = configuredPhases.findIndex((phase) =>
      phase.phaseKey === currentPhaseKey || phase.name === currentPhaseName,
    );
    if (currentPhaseIndex >= 0) {
      const currentPhase = configuredPhases[currentPhaseIndex]!;
      const currentPhaseExecutionSteps = executionSteps.filter((step) => stepMatchesPhaseForSync(step, currentPhase));
      if (currentPhaseExecutionSteps.length === 0) {
        // Hold on the currently entered configured phase until it produces work,
        // instead of regressing back to the last completed phase.
        return buildPhaseSyncTargetFromCard(currentPhase, null);
      }
      if (
        currentPhaseExecutionSteps.length > 0
        && currentPhaseExecutionSteps.every((step) => TERMINAL_PHASE_STEP_STATUSES.has(step.status))
      ) {
        const currentPhaseCompleted = currentPhaseExecutionSteps.some((step) =>
          phaseStepCountsAsCompleteForSync(step, currentPhase)
        );
        if (currentPhaseCompleted) {
          const sourceStepId = currentPhaseExecutionSteps[currentPhaseExecutionSteps.length - 1]?.id ?? null;
          return buildPhaseSyncTargetFromCard(currentPhase, sourceStepId);
        }
      }
    }
  }

  const activeExecutionStep =
    executionSteps.find((step) => !TERMINAL_PHASE_STEP_STATUSES.has(step.status))
    ?? executionSteps[executionSteps.length - 1]
    ?? null;
  if (!activeExecutionStep) return null;

  const stepMeta = isRecord(activeExecutionStep.metadata) ? activeExecutionStep.metadata : {};
  return {
    phaseKey: typeof stepMeta.phaseKey === "string" && stepMeta.phaseKey.trim().length > 0
      ? stepMeta.phaseKey.trim()
      : "development",
    phaseName: typeof stepMeta.phaseName === "string" && stepMeta.phaseName.trim().length > 0
      ? stepMeta.phaseName.trim()
      : "Development",
    phaseModel: asRecord(stepMeta.phaseModel),
    phaseInstructions:
      typeof stepMeta.phaseInstructions === "string" && stepMeta.phaseInstructions.trim().length > 0
        ? stepMeta.phaseInstructions.trim()
        : null,
    phaseValidation: asRecord(stepMeta.phaseValidation),
    phaseBudget: asRecord(stepMeta.phaseBudget),
    sourceStepId: activeExecutionStep.id,
  };
}

export function normalizeCoordinatorUpdateForChat(message: string): string | null {
  const compact = message
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/^\[Coordinator\]\s*/i, "")
    .replace(/([.!?])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact.length) return null;

  if (
    /^\{/.test(compact)
    || /^tool\s+/i.test(compact)
    || /^mcp__/i.test(compact)
    || /^assistant:/i.test(compact)
    || /^user:/i.test(compact)
  ) {
    return null;
  }

  const lowerCompact = compact.toLowerCase();
  if (lowerCompact.includes("reviewing the mission, building the plan")) {
    return "Planning is active. I’m briefing the planning worker now.";
  }
  if (lowerCompact.includes("moving through planning, implementation, and validation")) {
    return "Mission started. I’m following the enabled phases and will hand work to workers as each phase opens.";
  }
  if (lowerCompact.includes("read the key files") || lowerCompact.includes("review the key files")) {
    return "I’m reviewing the relevant files and mapping out the next step.";
  }
  if (lowerCompact.includes("look at the router") || lowerCompact.includes("look at the route")) {
    return "I’m checking the routing setup so I can line up the next task cleanly.";
  }
  if (lowerCompact.includes("planning task") || lowerCompact.includes("planning tasks")) {
    return "I’m turning the mission into concrete planning tasks now.";
  }
  if (lowerCompact.includes("spawn the planning worker")) {
    return "I’ve prepared the planning task and I’m starting the worker now.";
  }
  if (lowerCompact.includes("spawn") && lowerCompact.includes("worker")) {
    return "I’ve prepared the next task and I’m starting the worker now.";
  }
  if (lowerCompact.includes("transition") && lowerCompact.includes("phase")) {
    return "I’m wrapping up this phase and moving the run to the next one.";
  }

  const normalized = compact
    .split(/(?<=[.!?])\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => {
      const lowered = entry.toLowerCase();
      return entry.length > 0
        && !/^i have (?:all|enough|the)\b/.test(lowered)
        && !/^i now have\b/.test(lowered)
        && !/^the mission is clear\b/.test(lowered)
        && !/^the implementation is clear\b/.test(lowered);
    })
    .slice(0, 2)
    .join(" ")
    .replace(/\b(?:Now\s+)?I need to\b.*$/i, "")
    .replace(/\b(?:Next,\s*)?I should\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized.length) return null;

  const alphaChars = normalized.match(/[A-Za-z]/g)?.length ?? 0;
  if (alphaChars < 12) return null;
  return clipTextForContext(normalized, 220);
}

// Quality gate module imports removed — quality evaluation is the coordinator's domain

// Import from team runtime config module
import {
  resolveMissionTeamRuntime as resolveMissionTeamRuntimeCtx,
  normalizeTeamRuntimeConfig as normalizeTeamRuntimeConfigFn,
  normalizeAgentRuntimeFlags,
} from "./teamRuntimeConfig";

// Import from team runtime state module
import {
  getTeamMembersForRun as getTeamMembersForRunCtx,
  updateTeamRuntimePhase as updateTeamRuntimePhaseCtx,
  getTeamRuntimeStateForRun as getTeamRuntimeStateForRunCtx,
} from "./teamRuntimeState";

// Import from chat message module
import {
  getMissionMetadata as getMissionMetadataCtx,
  updateMissionMetadata as updateMissionMetadataCtx,
  getMissionIdForRun as getMissionIdForRunCtx,
  getRunMetadata as getRunMetadataCtx,
  updateRunMetadata as updateRunMetadataCtx,
  loadSteeringDirectivesFromMetadata as loadSteeringDirectivesCtx,
  loadChatSessionStateFromMetadata as loadChatSessionStateCtx,
  emitOrchestratorMessage as emitOrchestratorMessageCtx,
  upsertThread as upsertThreadCtx,
  summarizeRunForChat as summarizeRunForChatCtx,
  appendChatMessageCtx,
  updateChatMessage as updateChatMessageCtx,
  listChatThreadsCtx,
  getThreadMessagesCtx,
  sendThreadMessageCtx,
  sendChatCtx,
  getChatCtx,
  parseMentions,
  deliverMessageToAgentCtx,
  getGlobalChatCtx,
  getActiveAgentsCtx,
  sendAgentMessageWithMentionsCtx,
  reconcileThreadedMessagingStateCtx,
} from "./chatMessageService";
import type { ChatRoutingDeps, ReconciliationDeps } from "./chatMessageService";

// Import from worker tracking module
import {
  getWorkerStates as getWorkerStatesCtx,
  upsertWorkerState as upsertWorkerStateCtx,
  listWorkerDigests as listWorkerDigestsCtx,
  getWorkerDigest as getWorkerDigestCtx,
  getContextCheckpoint as getContextCheckpointCtx,
  listLaneDecisions as listLaneDecisionsCtx,
  buildWorkerDigestFromAttempt as buildWorkerDigestFromAttemptCtx,
  updateWorkerStateFromEventCtx,
} from "./workerTracking";

import {
  setMissionMetricsConfig as setMissionMetricsConfigCtx,
  getMissionMetrics as getMissionMetricsCtx,
  getAggregatedUsage as getAggregatedUsageCtx,
  propagateAttemptTokenUsage as propagateAttemptTokenUsageCtx,
  createContextCheckpoint as createContextCheckpointCtx,
} from "./metricsAndUsage";

// Import from recovery service module
import {
  ensureAttemptRuntimeTracker as ensureAttemptRuntimeTrackerCtx,
  updateAttemptStagnationTracker as updateAttemptStagnationTrackerCtx,
  getTrackedSessionState as getTrackedSessionStateCtx,
  listRunningAttemptsForSession as listRunningAttemptsForSessionCtx,
  hydratePersistedAttemptRuntimeState as hydratePersistedAttemptRuntimeStateCtx,
  deletePersistedAttemptRuntimeState as deletePersistedAttemptRuntimeStateCtx,
  persistAttemptRuntimeState as persistAttemptRuntimeStateCtx,
} from "./recoveryService";

// Import from model config resolver module
import {
  resolveCallTypeConfig as resolveCallTypeConfigCtx,
  resolveMissionDecisionTimeoutCapMs as resolveMissionDecisionTimeoutCapMsCtx,
  resolveAiDecisionLikeTimeoutMs as resolveAiDecisionLikeTimeoutMsCtx,
  resolveOrchestratorModelConfig as resolveOrchestratorModelConfigCtx,
} from "./modelConfigResolver";

// Import from worker delivery module
import {
  resolveWorkerDeliveryContextCtx,
  persistThreadWorkerLinksCtx,
  sendWorkerMessageToSessionCtx,
  sendWorkerMessageToSessionWithStatusCtx,
  replayQueuedWorkerMessagesCtx,
  routeMessageToCoordinatorCtx,
  routeMessageToWorkerCtx,
} from "./workerDeliveryService";
import type { WorkerDeliveryDeps } from "./workerDeliveryService";

export function deriveFallbackLaneStrategyDecision(args: {
  descriptors: ParallelMissionStepDescriptor[];
  baseLaneId: string;
}): {
  strategy: "single_lane" | "dependency_parallel" | "phase_parallel";
  maxParallelLanes: number;
  rationale: string;
  confidence: number;
  stepAssignments: Array<{
    stepKey: string;
    laneLabel: string;
    rationale?: string;
  }>;
} {
  const ordered = [...args.descriptors].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
  const assignmentByStepKey = new Map<string, { laneLabel: string; rationale: string }>();
  const existingLaneLabelByLaneId = new Map<string, string>();
  let existingLaneCounter = 0;
  const assignLane = (stepKey: string, laneLabel: string, rationale: string): void => {
    assignmentByStepKey.set(stepKey, { laneLabel, rationale });
  };

  for (const descriptor of ordered) {
    const existingLaneId = toOptionalString(descriptor.laneId);
    if (!existingLaneId || existingLaneId === args.baseLaneId) continue;
    let laneLabel = existingLaneLabelByLaneId.get(existingLaneId);
    if (!laneLabel) {
      existingLaneCounter += 1;
      laneLabel = `existing-${existingLaneCounter}`;
      existingLaneLabelByLaneId.set(existingLaneId, laneLabel);
    }
    assignLane(descriptor.stepKey, laneLabel, `Preserved existing mission lane '${existingLaneId}'.`);
  }

  const independentRoots = ordered.filter((descriptor) =>
    descriptor.dependencyStepKeys.length === 0
    && isParallelCandidateStepType(descriptor.stepType)
    && !assignmentByStepKey.has(descriptor.stepKey)
  );
  if (independentRoots.length > 1) {
    assignLane(independentRoots[0]!.stepKey, "base", "Primary root stream anchored on the base lane.");
    independentRoots.slice(1).forEach((descriptor, index) => {
      assignLane(
        descriptor.stepKey,
        `parallel-${index + 1}`,
        "Independent root step assigned to a dedicated fallback parallel lane."
      );
    });
  } else if (independentRoots.length === 1) {
    assignLane(independentRoots[0]!.stepKey, "base", "Single root stream runs on the base lane.");
  }

  for (const descriptor of ordered) {
    if (assignmentByStepKey.has(descriptor.stepKey)) continue;
    const dependencyLabels = [...new Set(descriptor.dependencyStepKeys
      .map((depKey) => assignmentByStepKey.get(depKey)?.laneLabel ?? null)
      .filter((label): label is string => typeof label === "string" && label.length > 0))];
    if (dependencyLabels.length === 1) {
      assignLane(descriptor.stepKey, dependencyLabels[0]!, "Inherited lane from sole dependency chain.");
    } else if (dependencyLabels.length > 1) {
      assignLane(descriptor.stepKey, "base", "Multi-lane dependencies converge on the base lane.");
    } else {
      assignLane(descriptor.stepKey, "base", "No lane signal found; defaulting to base lane.");
    }
  }

  if (![...assignmentByStepKey.values()].some((assignment) => assignment.laneLabel === "base")) {
    const anchor = ordered[0];
    if (anchor) {
      assignLane(anchor.stepKey, "base", "Anchor fallback strategy with one base-lane step.");
    }
  }

  const fallbackLabels = [...new Set(ordered.map((descriptor) => assignmentByStepKey.get(descriptor.stepKey)?.laneLabel ?? "base"))];
  return {
    strategy: fallbackLabels.length > 1 ? "dependency_parallel" : "single_lane",
    maxParallelLanes: Math.max(1, fallbackLabels.length),
    rationale: "Deterministic fallback lane strategy derived from dependencies and existing lane signals.",
    confidence: 0.6,
    stepAssignments: ordered.map((descriptor) => {
      const assignment = assignmentByStepKey.get(descriptor.stepKey);
      return {
        stepKey: descriptor.stepKey,
        laneLabel: assignment?.laneLabel ?? "base",
        rationale: assignment?.rationale ?? "No lane signal found; defaulting to base lane."
      };
    })
  };
}


export function createAiOrchestratorService(args: {
  db: AdeDb;
  logger: Logger;
  missionService: ReturnType<typeof createMissionService>;
  orchestratorService: ReturnType<typeof createOrchestratorService>;
  agentChatService?: ReturnType<typeof createAgentChatService> | null;
  laneService?: ReturnType<typeof createLaneService> | null;
  projectConfigService?: ReturnType<typeof createProjectConfigService> | null;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService> | null;
  prService?: ReturnType<typeof createPrService> | null;
  conflictService?: ReturnType<typeof createConflictService> | null;
  queueLandingService?: ReturnType<typeof createQueueLandingService> | null;
  missionBudgetService?: import("./missionBudgetService").MissionBudgetService | null;
  humanWorkDigestService?: import("../memory/humanWorkDigestService").HumanWorkDigestService | null;
  missionMemoryLifecycleService?: import("../memory/missionMemoryLifecycleService").MissionMemoryLifecycleService | null;
  computerUseArtifactBrokerService?: ComputerUseArtifactBrokerService | null;
  projectRoot?: string;
  onThreadEvent?: (event: OrchestratorThreadEvent) => void;
  onDagMutation?: (event: DagMutationEvent) => void;
  hookCommandRunner?: OrchestratorHookCommandRunner;
}) {
  const {
    db,
    logger,
    missionService,
    orchestratorService,
    agentChatService,
    laneService,
    projectConfigService,
    aiIntegrationService,
    prService,
    conflictService,
    queueLandingService,
    missionBudgetService,
    humanWorkDigestService,
    missionMemoryLifecycleService,
    computerUseArtifactBrokerService,
    projectRoot,
    onThreadEvent,
    onDagMutation,
    hookCommandRunner = runOrchestratorHookCommand
  } = args;
  const plannerMemoryService = createMemoryService(db);
  const syncLocks = new Set<string>();
  const workerStates = new Map<string, OrchestratorWorkerState>();
  const activeSteeringDirectives = new Map<string, UserSteeringDirective[]>();
  const runRuntimeProfiles = new Map<string, MissionRuntimeProfile>();
  const chatMessages = new Map<string, OrchestratorChatMessage[]>();
  const activeChatSessions = new Map<string, OrchestratorChatSessionState>();
  const chatTurnQueues = new Map<string, Promise<void>>();
  const activeHealthSweepRuns = new Set<string>();
  const sessionRuntimeSignals = new Map<string, SessionRuntimeSignal>();
  const attemptRuntimeTrackers = new Map<string, AttemptRuntimeTracker>();
  const sessionSignalQueues = new Map<string, Promise<void>>();
  const workerDeliveryThreadQueues = new Map<string, Promise<void>>();
  const workerDeliveryInterventionCooldowns = new Map<string, number>();
  const runTeamManifests = new Map<string, TeamManifest>();
  const runRecoveryLoopStates = new Map<string, RecoveryLoopState>();
  const pendingIntegrations = new Map<string, PendingIntegrationContext>();
  const pendingCoordinatorEvals = new Map<string, NodeJS.Timeout>();
  const milestoneReadyNotificationSignatures = new Map<string, string>();
  const runWatchdogTimers = new Map<string, Set<NodeJS.Timeout>>();
  const subagentCompletionRollupSent = new Set<string>();
  const validationSystemSignalDedupe = new Set<string>();
  const workerProgressChatState = new Map<string, { lastDigest: string | null; lastEmittedAtMs: number }>();

  // ── V2 Coordinator Agents (tool-based, replaces specialist calls) ──
  const coordinatorAgents = new Map<string, CoordinatorAgent>();
  const coordinatorRecoveryAttempts = new Map<string, number>();
  const coordinatorLifecycleStates = new Map<string, {
    state: CoordinatorLifecycleState;
    message: string;
    delegationSignature?: string | null;
  }>();
  const coordinatorWriteBarrierRuns = new Set<string>();

  // Team runtime state tracking
  const teamRuntimeStates = new Map<string, OrchestratorTeamRuntimeState>();

  // Call type config cache
  const callTypeConfigCache = new Map<string, { config: ResolvedCallTypeConfig; expiresAt: number }>();
  const STARTUP_RUNTIME_EVENT_HYDRATION_LIMIT = 750;
  const STARTUP_OPEN_QUESTION_REPLAY_LIMIT = 750;

  // Scalar mutable state wrapped for ctx
  const disposedRef = { current: false };
  const healthSweepTimerRef = { current: null as NodeJS.Timeout | null };
  // Local scalar mirrors for hot-path checks.
  let disposed = false;
  let healthSweepTimer: NodeJS.Timeout | null = null;

  // ── OrchestratorContext — shared state for extracted modules ──
  const ctx: import("./orchestratorContext").OrchestratorContext = {
    db,
    logger,
    missionService,
    orchestratorService,
    agentChatService: agentChatService ?? null,
    laneService: laneService ?? null,
    projectConfigService: projectConfigService ?? null,
    aiIntegrationService: aiIntegrationService ?? null,
    prService: prService ?? null,
    missionBudgetService: missionBudgetService ?? null,
    computerUseArtifactBrokerService: computerUseArtifactBrokerService ?? null,
    projectRoot,
    onThreadEvent,
    onDagMutation,
    hookCommandRunner,
    syncLocks,
    workerStates,
    activeSteeringDirectives,
    runRuntimeProfiles,
    chatMessages,
    activeChatSessions,
    chatTurnQueues,
    activeHealthSweepRuns,
    sessionRuntimeSignals,
    attemptRuntimeTrackers,
    sessionSignalQueues,
    workerDeliveryThreadQueues,
    workerDeliveryInterventionCooldowns,
    runTeamManifests,
    runRecoveryLoopStates,
    aiTimeoutBudgetStepLocks: new Set(),
    aiTimeoutBudgetRunLocks: new Set(),
    aiRetryDecisionLocks: new Set(),
    coordinatorSessions: new Map(),
    pendingIntegrations,
    coordinatorThinkingLoops: new Map(),
    pendingCoordinatorEvals,
    coordinatorAgents,
    coordinatorRecoveryAttempts,
    teamRuntimeStates,
    callTypeConfigCache,
    disposed: disposedRef,
    healthSweepTimer: healthSweepTimerRef,
  };

  /** Purge per-run Map entries when a run reaches terminal status. */
  const purgeRunMaps = (runId: string): void => {
    runTeamManifests.delete(runId);
    runRecoveryLoopStates.delete(runId);
    pendingIntegrations.delete(runId);
    teamRuntimeStates.delete(runId);
    coordinatorLifecycleStates.delete(runId);
    for (const key of milestoneReadyNotificationSignatures.keys()) {
      if (key.startsWith(`${runId}::`)) {
        milestoneReadyNotificationSignatures.delete(key);
      }
    }
    const evalTimer = pendingCoordinatorEvals.get(runId);
    if (evalTimer) {
      clearTimeout(evalTimer);
      pendingCoordinatorEvals.delete(runId);
    }
    const watchdogTimers = runWatchdogTimers.get(runId);
    if (watchdogTimers) {
      for (const timer of watchdogTimers) clearTimeout(timer);
      runWatchdogTimers.delete(runId);
    }
    for (const key of subagentCompletionRollupSent) {
      if (key.startsWith(`${runId}:`)) {
        subagentCompletionRollupSent.delete(key);
      }
    }
  };

  const hasRecoverableRuntimeWork = (): boolean => {
    try {
      const activeRun = db.get<{ found: number }>(
        `
          select 1 as found
          from orchestrator_runs
          where status in ('active', 'bootstrapping', 'queued', 'paused')
          limit 1
        `
      );
      if (activeRun?.found === 1) return true;
      const persistedRuntime = db.get<{ found: number }>(
        `
          select 1 as found
          from orchestrator_attempt_runtime
          limit 1
        `
      );
      return persistedRuntime?.found === 1;
    } catch {
      // Fail open so recovery still happens if the quick preflight query itself fails.
      return true;
    }
  };

  // Delegated to missionLifecycle.ts
  const getMaxCoordinatorRecoveries = (missionId?: string | null) => getMaxCoordinatorRecoveriesCtx(ctx, missionId);

  // ── Orchestrator Call Type Resolution (delegated to modelConfigResolver) ──
  const resolveCallTypeConfig = (missionId: string, callType: OrchestratorCallType) =>
    resolveCallTypeConfigCtx(ctx, missionId, callType);

  // ── Team runtime config (delegated to teamRuntimeConfig module) ──
  const resolveMissionTeamRuntime = (missionId: string) => resolveMissionTeamRuntimeCtx(ctx, missionId);
  const normalizeTeamRuntimeConfig = (missionId: string, config: TeamRuntimeConfig) => normalizeTeamRuntimeConfigFn(missionId, config);

  const getMissionMetadata = (missionId: string): Record<string, unknown> => getMissionMetadataCtx(ctx, missionId);
  const updateMissionMetadata = (missionId: string, mutate: (metadata: Record<string, unknown>) => void): void => updateMissionMetadataCtx(ctx, missionId, mutate);
  const getMissionIdForRun = (runId: string): string | null => getMissionIdForRunCtx(ctx, runId);
  const getRunMetadata = (runId: string): Record<string, unknown> => getRunMetadataCtx(ctx, runId);
  const updateRunMetadata = (runId: string, mutate: (metadata: Record<string, unknown>) => void): boolean => updateRunMetadataCtx(ctx, runId, mutate);

  // ── Thread management (delegated to chatMessageService) ─────────
  const upsertThread = (args: Parameters<typeof upsertThreadCtx>[1]) => upsertThreadCtx(ctx, args);

  const loadSteeringDirectivesFromMetadata = (missionId: string) => loadSteeringDirectivesCtx(ctx, missionId);

  const loadChatSessionStateFromMetadata = (missionId: string) => loadChatSessionStateCtx(ctx, missionId);

  const appendChatMessage = (message: OrchestratorChatMessage): OrchestratorChatMessage =>
    appendChatMessageCtx(ctx, message);
  const updateChatMessage = (
    messageId: string,
    updater: Parameters<typeof updateChatMessageCtx>[2],
  ): OrchestratorChatMessage | null => updateChatMessageCtx(ctx, messageId, updater);

  const WORKER_PROGRESS_CHAT_MIN_INTERVAL_MS = 12_000;
  const WORKER_PROGRESS_CHAT_REPEAT_INTERVAL_MS = 45_000;
  const structuredThreadMessageIds = new Map<string, string>();
  const structuredChatSessions = new Set<string>();
  const TERMINAL_COORDINATOR_RUN_STATUSES = new Set<OrchestratorRunStatus>(["succeeded", "failed", "canceled"]);

  const getRunStatusDirect = (runId: string): OrchestratorRunStatus | null => {
    try {
      const row = db.get<{ status: string | null }>(
        `select status from orchestrator_runs where id = ? limit 1`,
        [runId],
      );
      const status = typeof row?.status === "string" ? row.status.trim() : "";
      return status.length > 0 ? status as OrchestratorRunStatus : null;
    } catch {
      return null;
    }
  };

  const shouldSuppressCoordinatorWrites = (runId: string): boolean => {
    if (coordinatorWriteBarrierRuns.has(runId)) return true;
    const status = getRunStatusDirect(runId);
    return status != null && TERMINAL_COORDINATOR_RUN_STATUSES.has(status);
  };

  const closeCoordinatorThread = (missionId: string, runId: string): void => {
    upsertThread({
      missionId,
      threadId: `mission:${missionId}`,
      threadType: "coordinator",
      title: "Orchestrator",
      target: {
        kind: "coordinator",
        runId,
      },
      status: "closed",
    });
  };

  const updateCoordinatorMissionState = (args: {
    missionId: string;
    runId: string;
    state: CoordinatorLifecycleState;
    message: string;
    delegation?: DelegationContract | null;
  }): void => {
    const detailByState: Record<CoordinatorLifecycleState, { available: boolean; mode: MissionCoordinatorAvailability["mode"] }> = {
      booting: { available: true, mode: "continuation_required" },
      analyzing_prompt: { available: true, mode: "continuation_required" },
      fetching_project_context: { available: true, mode: "continuation_required" },
      launching_planner: { available: true, mode: "continuation_required" },
      waiting_on_planner: { available: true, mode: "consult_only" },
      planner_launch_failed: { available: true, mode: "consult_only" },
      stopped: { available: false, mode: "offline" },
    };
    updateMissionStateDoc(args.runId, {
      coordinatorAvailability: {
        available: detailByState[args.state].available,
        mode: detailByState[args.state].mode,
        summary: args.message,
        detail: null,
        delegation: args.delegation
          ? {
              contractId: args.delegation.contractId,
              workerIntent: args.delegation.workerIntent,
              mode: args.delegation.mode,
              status: args.delegation.status,
              scopeKey: args.delegation.scope.key,
              scopeLabel: args.delegation.scope.label ?? null,
              activeWorkerIds: args.delegation.activeWorkerIds,
              updatedAt: args.delegation.updatedAt,
            }
          : null,
        updatedAt: nowIso(),
      },
      pendingInterventions: pendingInterventionsForMission(args.missionId),
    });
  };

  const emitCoordinatorLifecycle = (args: {
    missionId: string;
    runId: string;
    state: CoordinatorLifecycleState;
    message: string;
    force?: boolean;
    delegation?: DelegationContract | null;
  }): void => {
    if (!args.force && shouldSuppressCoordinatorWrites(args.runId)) return;
    const previous = coordinatorLifecycleStates.get(args.runId);
    const delegationSignature = args.delegation
      ? `${args.delegation.contractId}:${args.delegation.status}:${args.delegation.updatedAt}`
      : null;
    if (
      !args.force
      && previous?.state === args.state
      && previous.message === args.message
      && (previous.delegationSignature ?? null) === delegationSignature
    ) {
      return;
    }
    coordinatorLifecycleStates.set(args.runId, {
      state: args.state,
      message: args.message,
      delegationSignature,
    });
    updateRunMetadata(args.runId, (metadata) => {
      metadata.coordinator = {
        ...(isRecord(metadata.coordinator) ? metadata.coordinator : {}),
        lifecycleState: args.state,
        lifecycleMessage: args.message,
        delegation: args.delegation ?? null,
        lifecycleUpdatedAt: nowIso(),
      };
    });
    persistStructuredCoordinatorChatEvent({
      missionId: args.missionId,
      runId: args.runId,
      event: {
        type: "status",
        turnStatus: args.state === "planner_launch_failed" ? "failed" : args.state === "stopped" ? "interrupted" : "started",
        message: args.message,
      },
    });
    recordRuntimeEvent({
      runId: args.runId,
      eventType: "progress",
      eventKey: `coordinator_lifecycle:${args.state}`,
      payload: {
        audience: "mission_feed",
        source: "coordinator_lifecycle",
        state: args.state,
        message: args.message,
        delegation: args.delegation ?? null,
      },
    });
    orchestratorService.appendTimelineEvent({
      runId: args.runId,
      eventType: "coordinator_status",
      reason: args.state,
      detail: {
        state: args.state,
        message: args.message,
        delegation: args.delegation ?? null,
      },
    });
    updateCoordinatorMissionState(args);
  };

  const emitWorkerThreadMessage = (args: {
    missionId: string;
    runId: string;
    step: OrchestratorStep;
    attemptId: string | null;
    sessionId: string | null;
    laneId: string | null;
    content: string;
    metadata?: Record<string, unknown> | null;
  }): OrchestratorChatMessage => {
    const threadId =
      typeof args.attemptId === "string" && args.attemptId.trim().length > 0
        ? `worker:${args.missionId}:${args.attemptId.trim()}`
        : null;
    if (threadId) {
      upsertThread({
        missionId: args.missionId,
        threadId,
        threadType: "worker",
        title: `Worker: ${args.step.stepKey}`,
        target: {
          kind: "worker",
          runId: args.runId,
          stepId: args.step.id,
          stepKey: args.step.stepKey,
          attemptId: args.attemptId,
          sessionId: args.sessionId,
          laneId: args.laneId ?? args.step.laneId ?? null,
        },
        status: "active",
      });
    }
    return appendChatMessage({
      id: randomUUID(),
      missionId: args.missionId,
      threadId,
      role: "worker",
      content: args.content,
      timestamp: nowIso(),
      stepKey: args.step.stepKey,
      target: {
        kind: "worker",
        runId: args.runId,
        stepId: args.step.id,
        stepKey: args.step.stepKey,
        attemptId: args.attemptId,
        sessionId: args.sessionId,
        laneId: args.laneId ?? args.step.laneId ?? null,
      },
      visibility: "full",
      deliveryState: "delivered",
      sourceSessionId: args.sessionId,
      attemptId: args.attemptId,
      laneId: args.laneId ?? args.step.laneId ?? null,
      runId: args.runId,
      metadata: args.metadata ?? null,
    });
  };

  const clipStructuredText = (value: string, maxChars = 8_000): string =>
    value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 16))}\n[truncated]`;

  const stringifyStructuredDetail = (value: unknown): string => {
    if (typeof value === "string") return clipStructuredText(value, 12_000);
    try {
      return clipStructuredText(JSON.stringify(value, null, 2), 12_000);
    } catch {
      return String(value);
    }
  };

  const structuredThreadKeyForEvent = (scopeKey: string, event: AgentChatEvent): string | null => {
    switch (event.type) {
      case "text":
      case "reasoning":
        return `${scopeKey}:${event.type}:${event.turnId ?? "turn"}`;
      case "tool_call":
      case "tool_result":
        return `${scopeKey}:tool:${event.turnId ?? "turn"}:${event.itemId}`;
      case "command":
        return `${scopeKey}:command:${event.turnId ?? "turn"}:${event.itemId}`;
      case "file_change":
        return `${scopeKey}:file:${event.turnId ?? "turn"}:${event.itemId}:${event.path}`;
      case "plan":
        return `${scopeKey}:plan:${event.turnId ?? "turn"}`;
      case "approval_request":
        return `${scopeKey}:approval:${event.turnId ?? "turn"}:${event.itemId}`;
      case "activity":
        return `${scopeKey}:activity:${event.turnId ?? "turn"}:${event.activity}:${event.detail ?? ""}`;
      case "delegation_state":
        return `${scopeKey}:delegation:${event.contract.contractId}:${event.contract.status}:${event.contract.updatedAt}`;
      default:
        return null;
    }
  };

  const buildStructuredEventSummary = (event: AgentChatEvent): string => {
    switch (event.type) {
      case "text":
        return event.text;
      case "reasoning":
        return event.text;
      case "tool_call":
        return `Tool call: ${event.tool}`;
      case "tool_result":
        return `Tool result: ${event.tool}`;
      case "approval_request":
        return event.description;
      case "status":
        return event.message?.trim().length ? event.message.trim() : `Turn ${event.turnStatus}.`;
      case "delegation_state":
        return event.message?.trim().length
          ? event.message.trim()
          : `Delegation ${event.contract.workerIntent} is ${event.contract.status}.`;
      case "done":
        return `Turn ${event.status}.`;
      case "error":
        return event.message;
      case "activity":
        return event.detail?.trim().length ? event.detail.trim() : `Activity: ${event.activity}`;
      case "plan":
        return event.explanation?.trim().length
          ? event.explanation.trim()
          : event.steps.map((step) => `${step.status === "completed" ? "[x]" : step.status === "in_progress" ? "[>]" : "[ ]"} ${step.text}`).join("\n");
      case "command":
        return `Command: ${event.command}`;
      case "file_change":
        return `${event.kind === "create" ? "Created" : event.kind === "delete" ? "Deleted" : "Updated"} ${nodePath.basename(event.path)}`;
      case "step_boundary":
        return `Step ${event.stepNumber}`;
      case "user_message":
        return event.text;
      default:
        return "Agent event";
    }
  };

  const buildStructuredEventMetadata = (sessionId: string, event: AgentChatEvent): Record<string, unknown> => {
    if (event.type === "tool_call") {
      return {
        source: "agent_chat_event",
        missionChatMode: "thread_only",
        structuredStream: {
          kind: "tool",
          sessionId,
          turnId: event.turnId ?? null,
          itemId: event.itemId,
          parentItemId: event.parentItemId ?? null,
          tool: event.tool,
          args: event.args,
          status: "running",
        },
      };
    }
    if (event.type === "tool_result") {
      return {
        source: "agent_chat_event",
        missionChatMode: "thread_only",
        structuredStream: {
          kind: "tool",
          sessionId,
          turnId: event.turnId ?? null,
          itemId: event.itemId,
          parentItemId: event.parentItemId ?? null,
          tool: event.tool,
          result: event.result,
          status: event.status ?? "completed",
        },
      };
    }
    if (event.type === "error") {
      return {
        source: "agent_chat_event",
        missionChatMode: "thread_only",
        structuredStream: {
          kind: "error",
          sessionId,
          turnId: event.turnId ?? null,
          itemId: event.itemId ?? null,
          message: event.message,
          errorInfo: event.errorInfo ?? null,
        },
      };
    }
    if (event.type === "status") {
      return {
        source: "agent_chat_event",
        missionChatMode: "thread_only",
        structuredStream: {
          kind: "status",
          sessionId,
          turnId: event.turnId ?? null,
          status: event.turnStatus,
          message: event.message ?? null,
        },
      };
    }
    if (event.type === "delegation_state") {
      return {
        source: "agent_chat_event",
        missionChatMode: "thread_only",
        structuredStream: {
          kind: "delegation_state",
          sessionId,
          turnId: event.turnId ?? null,
          contract: event.contract,
          message: event.message ?? null,
        },
      };
    }
    if (event.type === "done") {
      return {
        source: "agent_chat_event",
        missionChatMode: "thread_only",
        structuredStream: {
          kind: "done",
          sessionId,
          turnId: event.turnId,
          status: event.status,
          model: event.model ?? null,
          modelId: event.modelId ?? null,
          usage: event.usage ?? null,
        },
      };
    }
    if (event.type === "reasoning") {
      return {
        source: "agent_chat_event",
        missionChatMode: "thread_only",
        structuredStream: {
          kind: "reasoning",
          sessionId,
          turnId: event.turnId ?? null,
          itemId: event.itemId ?? null,
          summaryIndex: event.summaryIndex ?? null,
        },
      };
    }
    if (event.type === "text") {
      return {
        source: "agent_chat_event",
        missionChatMode: "thread_only",
        structuredStream: {
          kind: "text",
          sessionId,
          turnId: event.turnId ?? null,
          itemId: event.itemId ?? null,
        },
      };
    }
    if (event.type === "approval_request") {
      return {
        source: "agent_chat_event",
        missionChatMode: "thread_only",
        structuredStream: {
          kind: "approval_request",
          sessionId,
          turnId: event.turnId ?? null,
          itemId: event.itemId,
          requestKind: event.kind,
          description: event.description,
          detail: event.detail ?? null,
        },
      };
    }
    if (event.type === "command") {
      return {
        source: "agent_chat_event",
        missionChatMode: "thread_only",
        structuredStream: {
          kind: "command",
          sessionId,
          turnId: event.turnId ?? null,
          itemId: event.itemId,
          command: event.command,
          cwd: event.cwd,
          output: event.output,
          exitCode: event.exitCode ?? null,
          durationMs: event.durationMs ?? null,
          status: event.status,
        },
      };
    }
    if (event.type === "file_change") {
      return {
        source: "agent_chat_event",
        missionChatMode: "thread_only",
        structuredStream: {
          kind: "file_change",
          sessionId,
          turnId: event.turnId ?? null,
          itemId: event.itemId,
          path: event.path,
          diff: event.diff,
          changeKind: event.kind,
          status: event.status ?? null,
        },
      };
    }
    if (event.type === "plan") {
      return {
        source: "agent_chat_event",
        missionChatMode: "thread_only",
        structuredStream: {
          kind: "plan",
          sessionId,
          turnId: event.turnId ?? null,
          explanation: event.explanation ?? null,
          steps: event.steps,
        },
      };
    }
    if (event.type === "activity") {
      return {
        source: "agent_chat_event",
        missionChatMode: "thread_only",
        structuredStream: {
          kind: "activity",
          sessionId,
          turnId: event.turnId ?? null,
          activity: event.activity,
          detail: event.detail ?? null,
        },
      };
    }
    if (event.type === "step_boundary") {
      return {
        source: "agent_chat_event",
        missionChatMode: "thread_only",
        structuredStream: {
          kind: "step_boundary",
          sessionId,
          turnId: event.turnId ?? null,
          stepNumber: event.stepNumber,
        },
      };
    }
    if (event.type === "user_message") {
      return {
        source: "agent_chat_event",
        missionChatMode: "thread_only",
        structuredStream: {
          kind: "user_message",
          sessionId,
          turnId: event.turnId ?? null,
          text: event.text,
          attachments: event.attachments ?? [],
        },
      };
    }
    return {
      source: "agent_chat_event",
      missionChatMode: "thread_only",
      structuredStream: {
        kind: "unknown",
        sessionId,
      },
    };
  };

  const mergeStructuredEventMetadata = (
    current: Record<string, unknown> | null | undefined,
    sessionId: string,
    event: AgentChatEvent,
  ): Record<string, unknown> => {
    const base = isRecord(current) ? { ...current } : {};
    const next = buildStructuredEventMetadata(sessionId, event);
    const currentStructured = isRecord(base.structuredStream) ? base.structuredStream : null;
    const nextStructured = isRecord(next.structuredStream) ? next.structuredStream : null;
    if (event.type === "tool_result" && currentStructured) {
      base.source = "agent_chat_event";
      base.missionChatMode = "thread_only";
      base.structuredStream = {
        ...currentStructured,
        ...(nextStructured ?? {}),
        tool: typeof currentStructured.tool === "string" ? currentStructured.tool : event.tool,
        result: event.result,
        status: event.status ?? "completed",
      };
      return base;
    }
    if ((event.type === "command" || event.type === "file_change" || event.type === "plan" || event.type === "activity") && currentStructured) {
      base.source = "agent_chat_event";
      base.missionChatMode = "thread_only";
      base.structuredStream = {
        ...currentStructured,
        ...(nextStructured ?? {}),
      };
      return base;
    }
    return {
      ...base,
      ...next,
    };
  };

  const appendOrUpdateStructuredThreadMessage = (args: {
    missionId: string;
    threadId: string;
    role: "worker" | "orchestrator";
    senderStepKey?: string | null;
    target: OrchestratorChatTarget;
    timestamp: string;
    sessionId: string;
    runId: string | null;
    attemptId: string | null;
    laneId: string | null;
    event: AgentChatEvent;
  }): void => {
    const key = structuredThreadKeyForEvent(args.threadId, args.event);
    const summary = buildStructuredEventSummary(args.event);
    const metadata = buildStructuredEventMetadata(args.sessionId, args.event);
    const canAppendText =
      args.event.type === "user_message"
      || args.event.type === "activity"
      || args.event.type === "text"
      || args.event.type === "reasoning";
    if (key) {
      const existingMessageId = structuredThreadMessageIds.get(key);
      if (existingMessageId) {
        updateChatMessage(existingMessageId, (current) => {
          const nextContent = canAppendText
            ? clipStructuredText(`${current.content}${summary}`)
            : current.content;
          return {
            ...current,
            content: nextContent,
            timestamp: args.timestamp,
            metadata: mergeStructuredEventMetadata(current.metadata, args.sessionId, args.event),
          };
        });
        return;
      }
    }

    const created = appendChatMessage({
      id: randomUUID(),
      missionId: args.missionId,
      threadId: args.threadId,
      role: args.role,
      content: clipStructuredText(summary),
      timestamp: args.timestamp,
      stepKey: args.senderStepKey ?? null,
      target: args.target,
      visibility: "full",
      deliveryState: "delivered",
      sourceSessionId: args.sessionId,
      attemptId: args.attemptId,
      laneId: args.laneId,
      runId: args.runId,
      metadata,
    });
    if (key) {
      structuredThreadMessageIds.set(key, created.id);
    }
  };

  const persistStructuredWorkerChatEvent = (envelope: AgentChatEventEnvelope): void => {
    const workerState = [...workerStates.values()].find((candidate) => candidate.sessionId === envelope.sessionId);
    if (!workerState) return;
    let graph: OrchestratorRunGraph;
    try {
      graph = orchestratorService.getRunGraph({ runId: workerState.runId, timelineLimit: 0 });
    } catch {
      return;
    }
    const step = graph.steps.find((candidate) => candidate.id === workerState.stepId);
    if (!step) return;
    const missionId = graph.run.missionId ?? getMissionIdForRun(workerState.runId);
    if (!missionId) return;
    const threadId = `worker:${missionId}:${workerState.attemptId}`;
    upsertThread({
      missionId,
      threadId,
      threadType: "worker",
      title: `Worker: ${step.stepKey}`,
      target: {
        kind: "worker",
        runId: workerState.runId,
        stepId: step.id,
        stepKey: step.stepKey,
        attemptId: workerState.attemptId,
        sessionId: workerState.sessionId,
        laneId: step.laneId ?? null,
      },
      status: step.status === "running" ? "active" : "closed",
    });
    structuredChatSessions.add(envelope.sessionId);
    appendOrUpdateStructuredThreadMessage({
      missionId,
      threadId,
      role: "worker",
      senderStepKey: step.stepKey,
      target: {
        kind: "worker",
        runId: workerState.runId,
        stepId: step.id,
        stepKey: step.stepKey,
        attemptId: workerState.attemptId,
        sessionId: workerState.sessionId,
        laneId: step.laneId ?? null,
      },
      timestamp: envelope.timestamp,
      sessionId: envelope.sessionId,
      runId: workerState.runId,
      attemptId: workerState.attemptId,
      laneId: step.laneId ?? null,
      event: envelope.event,
    });
    if (!hasMaterialWorkerChatEvent([envelope])) return;
    if (workerState.state !== "initializing" && workerState.state !== "spawned") return;
    upsertWorkerState(workerState.attemptId, {
      stepId: workerState.stepId,
      runId: workerState.runId,
      sessionId: workerState.sessionId,
      executorKind: workerState.executorKind,
      state: "working",
    });
  };

  const persistStructuredCoordinatorChatEvent = (args: {
    missionId: string;
    runId: string;
    event: AgentChatEvent;
    timestamp?: string;
  }): void => {
    if (shouldSuppressCoordinatorWrites(args.runId)) return;
    const threadId = `mission:${args.missionId}`;
    upsertThread({
      missionId: args.missionId,
      threadId,
      threadType: "coordinator",
      title: "Orchestrator",
      target: {
        kind: "coordinator",
        runId: args.runId,
      },
      status: "active",
    });
    appendOrUpdateStructuredThreadMessage({
      missionId: args.missionId,
      threadId,
      role: "orchestrator",
      senderStepKey: null,
      target: {
        kind: "coordinator",
        runId: args.runId,
      },
      timestamp: args.timestamp ?? nowIso(),
      sessionId: `coordinator:${args.runId}`,
      runId: args.runId,
      attemptId: null,
      laneId: null,
      event: args.event,
    });
  };

  const normalizeWorkerProgressPreviewForChat = (preview: string): string | null => {
    const compact = preview
      .replace(/\u001b\[[0-9;]*m/g, "")
      .replace(/([.!?])([A-Z])/g, "$1 $2")
      .replace(/\s+/g, " ")
      .trim();
    if (!compact.length) return null;
    if (isWorkerBootstrapNoiseLine(compact)) return null;

    if (
      /^You are an ADE /i.test(compact)
      || /^Mission goal:/i.test(compact)
      || /^Mission Plan:/i.test(compact)
      || /^Step instructions:/i.test(compact)
      || /^Phase-level guidance:/i.test(compact)
      || /^Referenced docs:/i.test(compact)
      || /^tool ade\./i.test(compact)
      || /^"(?:workerId|text|content|summary|outcome|stepId|stepKey|laneId|reportedAt|type)"\s*:/i.test(compact)
      || /^\{\s*"ok"\s*:/i.test(compact)
      || /^quote>\s*/i.test(compact)
      || /^-p\s+"\$\(cat\s+/i.test(compact)
      || /^cp\s+'.+worker-[a-f0-9-]+\.json'\s+'.+\.json'(\s+&&\s+exec\b.*)?$/i.test(compact)
      || /^ade_[a-z0-9_]+=.+/i.test(compact)
      || /(?:^|[\\/])(?:orchestrator[\\/])?worker-prompts[\\/]worker-[a-f0-9-]+(?:\.[A-Za-z0-9._-]+)?/i.test(compact)
      || /\.ade-worker-mcp-[a-f0-9-]+\.json/i.test(compact)
      || /(?:^|[-*]\s+)?`?\.ade\/(?:step-output|checkpoints)-worker_[^`\s]+\.md`?/i.test(compact)
      || /[A-Za-z0-9._-]+\.(?:txt|json)['")]+$/i.test(compact)
      || /^"(?:missionId|runId|stepId|stepKey|laneId|attemptId)\b/i.test(compact)
      || /^"(?:[A-Za-z0-9_]+)"\s*:\s*/i.test(compact)
      || /^[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json|md|txt):\d+(?::\d+)?:/i.test(compact)
      || /^(?:[-*]\s+)?(?:\.{0,2}[\\/]|\/)[^\s]+$/.test(compact)
      || /^(?:[-*]\s+)?(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\/?$/.test(compact)
      || /^\]\s+as\s+[A-Za-z]/i.test(compact)
      || /^EOF"\s+in\s+\/Users\//i.test(compact)
      || /^\/users\/.+\.zshrc:\d+:/i.test(compact)
      || /command not found:\s*compdef/i.test(compact)
      || /exec claude --model/i.test(compact)
      || /exec codex\b/i.test(compact)
      || /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+\s+.+\s[%#$]$/.test(compact)
    ) {
      return null;
    }

    const fileUpdateMatch = compact.match(/^-?\s*(Created|Updated|Added|Removed)\s+\[([^\]]+)\]/i);
    if (fileUpdateMatch) {
      const verb = fileUpdateMatch[1].charAt(0).toUpperCase() + fileUpdateMatch[1].slice(1).toLowerCase();
      const fileName = nodePath.basename(fileUpdateMatch[2].trim());
      return `${verb} ${fileName}.`;
    }

    if (
      /^(?:\/bin\/(?:zsh|bash)|zsh|bash|git|pnpm|npm|npx|node|sed|rg|cat|ls|cp|mv|rm|apply_patch)\b/i.test(compact)
      || /^(?:diff --git|index [0-9a-f]{7,}\.\.[0-9a-f]{7,}|@@|--- |\+\+\+ )/i.test(compact)
      || /^[+\-@{}[\]()<>|]+$/.test(compact)
      || /^[+-]\s*(?:<[/A-Za-z]|import\b|export\b|const\b|function\b|return\b)/.test(compact)
      || /^(?:<[/A-Za-z]|import\b|export\b|const\b|function\b|return\b)/.test(compact)
    ) {
      return null;
    }

    const alphaChars = compact.match(/[A-Za-z]/g)?.length ?? 0;
    if (alphaChars < 6) return null;
    return clipTextForContext(compact, 180);
  };

  const maybeEmitWorkerProgressChatUpdate = (args: {
    missionId: string;
    runId: string;
    step: OrchestratorStep;
    attemptId: string;
    sessionId: string;
    laneId: string | null;
    preview: string;
  }): void => {
    if (structuredChatSessions.has(args.sessionId)) return;
    const content = normalizeWorkerProgressPreviewForChat(args.preview);
    if (!content) return;

    const digest = digestSignalText(content);
    const nowMs = Date.now();
    const lastState = workerProgressChatState.get(args.attemptId) ?? {
      lastDigest: null,
      lastEmittedAtMs: 0,
    };
    const sameDigest = digest != null && lastState.lastDigest === digest;
    const minIntervalMs = sameDigest
      ? WORKER_PROGRESS_CHAT_REPEAT_INTERVAL_MS
      : WORKER_PROGRESS_CHAT_MIN_INTERVAL_MS;
    if (nowMs - lastState.lastEmittedAtMs < minIntervalMs) return;

    workerProgressChatState.set(args.attemptId, {
      lastDigest: digest,
      lastEmittedAtMs: nowMs,
    });

    emitWorkerThreadMessage({
      missionId: args.missionId,
      runId: args.runId,
      step: args.step,
      attemptId: args.attemptId,
      sessionId: args.sessionId,
      laneId: args.laneId,
      content,
      metadata: {
        source: "runtime_signal_progress",
      },
    });
  };

  const normalizeCoordinatorToolEventName = (toolName: string): string => {
    const trimmed = toolName.trim();
    if (trimmed.startsWith("mcp__")) {
      const parts = trimmed.split("__");
      return (parts[2] ?? trimmed).trim();
    }
    return trimmed;
  };

  const derivePlannerLifecycleFromDelegation = (contract: DelegationContract): {
    state: CoordinatorLifecycleState;
    message: string;
  } | null => {
    if (contract.workerIntent !== "planner") return null;
    if (contract.launchState === "fetching_context") {
      return {
        state: "fetching_project_context",
        message: "I’m pulling project context so the planner starts with the right picture.",
      };
    }
    if (contract.status === "launching" || contract.launchState === "awaiting_worker_launch" || contract.launchState === "launching_worker") {
      return {
        state: "launching_planner",
        message: "I’m starting the planning agent now.",
      };
    }
    if (contract.status === "active" && contract.launchState === "waiting_on_worker") {
      const launched = contract.metadata && isRecord(contract.metadata) ? contract.metadata.launched !== false : true;
      return {
        state: "waiting_on_planner",
        message: launched
          ? "The planning agent is running. I’m waiting for its result."
          : "The planning agent is queued. I’m waiting for it to start.",
      };
    }
    if (contract.status === "launch_failed" || contract.status === "blocked" || contract.status === "failed") {
      return {
        state: "planner_launch_failed",
        message: "The planner hit a launch issue, so I paused the run.",
      };
    }
    return null;
  };

  const syncCoordinatorLifecycleFromEvent = (args: {
    missionId: string;
    runId: string;
    planningIsFirstPhase: boolean;
    event: AgentChatEvent;
  }): void => {
    if (!args.planningIsFirstPhase) return;
    if (args.event.type === "delegation_state") {
      const nextLifecycle = derivePlannerLifecycleFromDelegation(args.event.contract);
      if (!nextLifecycle) return;
      emitCoordinatorLifecycle({
        missionId: args.missionId,
        runId: args.runId,
        state: nextLifecycle.state,
        message: args.event.message?.trim().length ? args.event.message.trim() : nextLifecycle.message,
        delegation: args.event.contract,
      });
      return;
    }
    if (args.event.type === "tool_call") {
      const toolName = normalizeCoordinatorToolEventName(args.event.tool);
      if (toolName === "get_project_context") {
        emitCoordinatorLifecycle({
          missionId: args.missionId,
          runId: args.runId,
          state: "fetching_project_context",
          message: "I’m pulling project context so the planner starts with the right picture.",
        });
      } else if (toolName === "spawn_worker") {
        emitCoordinatorLifecycle({
          missionId: args.missionId,
          runId: args.runId,
          state: "launching_planner",
          message: "I’m starting the planning agent now.",
        });
      }
      return;
    }

    if (args.event.type === "tool_result") {
      const toolName = normalizeCoordinatorToolEventName(args.event.tool);
      if (toolName !== "spawn_worker") return;
      const result = asRecord(args.event.result);
      if (result?.ok === true) {
        emitCoordinatorLifecycle({
          missionId: args.missionId,
          runId: args.runId,
          state: "waiting_on_planner",
          message: result?.launched === false
            ? "The planning agent is queued. I’m waiting for it to start."
            : "The planning agent is running. I’m waiting for its result.",
        });
      } else if (result?.ok === false) {
        emitCoordinatorLifecycle({
          missionId: args.missionId,
          runId: args.runId,
          state: "planner_launch_failed",
          message: "The planner hit a launch issue, so I’m diagnosing that now.",
        });
      }
      return;
    }

    if (args.event.type === "status" && typeof args.event.message === "string" && args.event.message.trim().length > 0) {
      const message = args.event.message.trim();
      if (/retrying once/i.test(message)) {
        emitCoordinatorLifecycle({
          missionId: args.missionId,
          runId: args.runId,
          state: "launching_planner",
          message,
        });
      } else if (/waiting for (?:it to start|its result)/i.test(message)) {
        emitCoordinatorLifecycle({
          missionId: args.missionId,
          runId: args.runId,
          state: "waiting_on_planner",
          message,
        });
      } else if (/paused the run/i.test(message)) {
        emitCoordinatorLifecycle({
          missionId: args.missionId,
          runId: args.runId,
          state: "planner_launch_failed",
          message,
        });
      }
    }
  };

  // ── Coordinator Session Management ──────────────────────────────
  // Spins up a persistent AI coordinator session for a mission run.
  // The coordinator observes runtime events and can intervene with
  // steer/skip/broadcast commands. Uses aiIntegrationService.executeTask
  // with sessionId for multi-turn conversation.


  // ── V2 Coordinator Agent Lifecycle ──────────────────────────────

  const startCoordinatorAgentV2 = (
    missionId: string,
    runId: string,
    missionGoal: string,
    modelConfig: ModelConfig,
    opts?: {
      userRules?: import("./coordinatorAgent").CoordinatorUserRules;
      projectContext?: import("./coordinatorAgent").CoordinatorProjectContext;
      availableProviders?: import("./coordinatorAgent").CoordinatorAvailableProvider[];
      phases?: import("../../../shared/types").PhaseCard[];
      skipInitialActivationMessage?: boolean;
      missionLaneId?: string;
    },
  ): CoordinatorAgent | null => {
    if (!projectRoot) {
      logger.debug("ai_orchestrator.coordinator_agent_v2_skip", {
        missionId,
        runId,
        reason: "no_project_root",
      });
      return null;
    }

    try {
      const coordinatorProjectId = resolveProjectIdForMission(missionId) ?? missionId;
      const modelId = modelConfigToServiceModel(modelConfig);
      const workspaceRoot = (() => {
        const laneId = opts?.missionLaneId ?? resolvePersistedMissionLaneIdForRun(runId);
        if (laneId && laneService && typeof laneService.getLaneWorktreePath === "function") {
          try {
            return laneService.getLaneWorktreePath(laneId);
          } catch {
            // Fall back to the canonical project root below.
          }
        }
        return projectRoot;
      })();
      const initialCoordinatorPhase = Array.isArray(opts?.phases)
        ? [...opts.phases].sort((a, b) => a.position - b.position)[0] ?? null
        : null;
      const planningIsFirstPhase = initialCoordinatorPhase?.phaseKey.trim().toLowerCase() === "planning";
      const agent = new CoordinatorAgent({
        orchestratorService,
        missionService,
        runId,
        missionId,
        missionGoal,
        modelId,
        logger,
        db,
        projectId: coordinatorProjectId,
        projectRoot,
        workspaceRoot,
        memoryService: plannerMemoryService,
        getMissionBudgetStatus: missionBudgetService
          ? async () => {
              try {
                return await missionBudgetService.getMissionBudgetStatus({ missionId, runId });
              } catch {
                return null;
              }
            }
          : undefined,
        onDagMutation: (event) => {
          if (onDagMutation) onDagMutation(event);
        },
        onCoordinatorEvent: (event) => {
          syncCoordinatorLifecycleFromEvent({
            missionId,
            runId,
            planningIsFirstPhase,
            event,
          });
          persistStructuredCoordinatorChatEvent({ missionId, runId, event });
        },
        onRunFinalize: (args) => {
          // Forward coordinator's verdict to the chat before finalizing
          if (args.succeeded) {
            emitOrchestratorMessage(missionId, `[Mission Complete] ${args.summary ?? "Mission finished successfully."}`, null, {
              role: "coordinator_v2",
              runId,
              event: "mission_complete",
            });
          } else {
            emitOrchestratorMessage(missionId, `[Mission Failed] ${args.reason ?? "Mission could not be completed."}`, null, {
              role: "coordinator_v2",
              runId,
              event: "mission_failed",
            });
            finalizeRun({ runId, force: true });
          }
        },
        onHardCapTriggered: (detail) => {
          pauseOnBudgetHardCap(missionId, detail);
        },
        onBudgetWarning: (pressure, detail) => {
          emitOrchestratorMessage(
            missionId,
            `Budget pressure: ${pressure} \u2014 ${detail}`,
            null,
            { budgetPressure: pressure, source: "budget_soft_warning" }
          );
        },
        sendWorkerMessageToSession: async ({ sessionId, text, priority }) =>
          sendWorkerMessageToSessionWithStatusCtx(ctx, sessionId, text, { priority }),
        enableCompaction: true,
        onPlanningStartupFailure: (failure: CoordinatorPlanningStartupFailure) => {
          emitCoordinatorLifecycle({
            missionId,
            runId,
            state: "planner_launch_failed",
            message: failure.category === "permission_denied"
              ? "The planner was blocked by a permission issue, so I paused the run."
              : failure.category === "provider_unreachable"
                ? "The planner hit a launch issue, so I paused the run and opened recovery options."
                : "The planner hit a launch issue, so I paused the run.",
          });
          pauseRunWithIntervention({
            runId,
            missionId,
            source: "transition_decision",
            interventionType: failure.interventionType,
            reasonCode: failure.reasonCode,
            title: failure.title,
            body: failure.body,
            requestedAction: failure.requestedAction,
            metadata: {
              category: failure.category,
              retryable: failure.retryable,
              recoveryOptions: failure.recoveryOptions,
              toolName: failure.toolName ?? null,
              retryCount: failure.retryCount,
            },
          });
        },
        onCoordinatorRuntimeFailure: (failure: import("./coordinatorAgent").CoordinatorRuntimeFailure) => {
          const lifecycleMessage = failure.reasonCode === "coordinator_runtime_provider_auth_failed"
            ? "The orchestrator could not authenticate with the selected provider, so I paused the run."
            : failure.category === "provider_unreachable"
              ? "The orchestrator lost contact with the selected provider, so I paused the run."
            : failure.category === "permission_denied"
              ? "The orchestrator was blocked by permissions, so I paused the run."
              : failure.category === "cli_runtime_failure"
                ? "The orchestrator process exited unexpectedly, so I paused the run."
                : "The orchestrator stopped unexpectedly, so I paused the run.";
          emitCoordinatorLifecycle({
            missionId,
            runId,
            state: "stopped",
            message: lifecycleMessage,
            force: true,
          });
          pauseRunWithIntervention({
            runId,
            missionId,
            source: "transition_decision",
            interventionType: failure.interventionType,
            reasonCode: failure.reasonCode,
            title: failure.title,
            body: failure.body,
            requestedAction: failure.requestedAction,
            metadata: {
              category: failure.category,
              retryable: failure.retryable,
              recoveryOptions: failure.recoveryOptions,
              turnId: failure.turnId,
              modelId,
              error: failure.message,
            },
          });
          endCoordinatorAgentV2(runId);
        },
        userRules: opts?.userRules,
        projectContext: opts?.projectContext,
        availableProviders: opts?.availableProviders,
        phases: opts?.phases,
        missionLaneId: opts?.missionLaneId,
        provisionLane: laneService
          ? async (name: string, description?: string) => {
              const result = await createLaneFromBase(name, { description, folder: `Mission: ${missionId}`, missionId });
              if (!result) throw new Error("No base lane available for provisioning.");
              return result;
            }
          : undefined,
      });

      coordinatorAgents.set(runId, agent);

      // Inject the mission prompt — the coordinator takes it from here
      if (!opts?.skipInitialActivationMessage) {
        const laneContext = opts?.missionLaneId
          ? `\n\nA primary mission lane has been created for you (lane ID: ${opts.missionLaneId}). All workers should be assigned to this lane or to additional lanes you create with provision_lane. NEVER assign workers to the base lane directly.`
          : "";
        agent.injectMessage(
          planningIsFirstPhase
            ? `You have been activated. Your mission:\n\n${missionGoal}\n\nPlanning is the active first phase. If no planning questions are needed, immediately call get_project_context, spawn the planning worker in read-only mode, and then wait for its output instead of continuing to reason on your own.${laneContext}`
            : `You have been activated. Your mission:\n\n${missionGoal}\n\nYou have full authority. Read the mission, create tasks, spawn workers, and complete the mission. Delegate quickly, then stay idle until a worker produces meaningful new information.${laneContext}`,
        );
      }

      logger.info("ai_orchestrator.coordinator_agent_v2_started", {
        missionId,
        runId,
        modelId,
      });

      return agent;
    } catch (error) {
      logger.warn("ai_orchestrator.coordinator_agent_v2_start_failed", {
        missionId,
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const endCoordinatorAgentV2 = (runId: string): void => {
    const agent = coordinatorAgents.get(runId);
    const missionId = getMissionIdForRun(runId);
    if (agent) {
      agent.shutdown();
      coordinatorAgents.delete(runId);
      coordinatorRecoveryAttempts.delete(runId);
      logger.info("ai_orchestrator.coordinator_agent_v2_ended", {
        runId,
        turns: agent.turns,
        historyLength: agent.historyLength,
      });
    }
    if (missionId) {
      closeCoordinatorThread(missionId, runId);
    }
  };

  /**
   * Attempt to recover a dead coordinator agent. Returns the new agent or null if recovery fails.
   * Limited to maxCoordinatorRecoveries (configurable, default 3) per run to prevent infinite restart loops.
   */
  const attemptCoordinatorRecovery = (runId: string): CoordinatorAgent | null => {
    const attempts = coordinatorRecoveryAttempts.get(runId) ?? 0;
    const missionId = getMissionIdForRun(runId);
    const maxRecoveries = getMaxCoordinatorRecoveries(missionId);
    if (attempts >= maxRecoveries) {
      logger.warn("ai_orchestrator.coordinator_recovery_exhausted", { runId, attempts, maxRecoveries });

      // Surface as a user intervention instead of silently returning null
      if (missionId) {
        pauseMissionWithIntervention({
          missionId,
          interventionType: "unrecoverable_error",
          title: "Coordinator recovery exhausted",
          body: `The coordinator has exhausted recovery attempts (${attempts}/${maxRecoveries}). The mission is paused. You can resume to retry, or cancel.`,
          requestedAction: "Resume the mission to retry coordinator startup, adjust maxCoordinatorRecoveries in config, or cancel.",
          metadata: { source: "coordinator_recovery_exhausted", runId, attempts, maxRecoveries },
        });
      }

      return null;
    }

    const nextAttempt = attempts + 1;
    coordinatorRecoveryAttempts.set(runId, nextAttempt);

    try {
      // Clean up the dead agent
      const deadAgent = coordinatorAgents.get(runId);
      if (deadAgent) {
        deadAgent.shutdown();
        coordinatorAgents.delete(runId);
      }

      // Get mission context
      const missionId = getMissionIdForRun(runId);
      if (!missionId) return null;

      const mission = missionService.get(missionId);
      if (!mission) return null;

      const missionGoal = mission.prompt || mission.title;
      const recoveredMissionLaneId = resolvePersistedMissionLaneIdForRun(runId);
      if (recoveredMissionLaneId) {
        persistMissionLaneIdForRun(runId, recoveredMissionLaneId);
      }
      const coordinatorModelConfig = resolveOrchestratorModelConfig(missionId, "coordinator");
      const { userRules, projectCtx, availableProviders, phases } = gatherCoordinatorContext(missionId, { missionId });

      // Restart coordinator
      const newAgent = startCoordinatorAgentV2(missionId, runId, missionGoal, coordinatorModelConfig, {
        userRules,
        projectContext: projectCtx,
        availableProviders,
        phases,
        missionLaneId: recoveredMissionLaneId ?? undefined,
      });

      if (!newAgent) return null;

      // Build recovery context from current run state
      const graph = orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
      const stepSummaries = graph.steps.map((s) => `  - ${s.stepKey} (${s.title}): ${s.status}`).join("\n");
      const runningWorkers = graph.attempts
        .filter((a) => a.status === "running")
        .map((a) => {
          const step = graph.steps.find((s) => s.id === a.stepId);
          return `  - ${step?.stepKey ?? a.stepId}: running (session: ${a.executorSessionId ?? "unknown"})`;
        })
        .join("\n");
      const completedWorkers = graph.attempts
        .filter((a) => a.status === "succeeded" || a.status === "failed")
        .slice(-10) // Last 10 completed
        .map((a) => {
          const step = graph.steps.find((s) => s.id === a.stepId);
          return `  - ${step?.stepKey ?? a.stepId}: ${a.status}${a.resultEnvelope?.summary ? ` — ${a.resultEnvelope.summary.slice(0, 200)}` : ""}`;
        })
        .join("\n");

      newAgent.injectMessage(
        `[COORDINATOR RECOVERY] You are taking over a mission that was in progress.
The previous coordinator crashed (recovery attempt ${nextAttempt} of ${maxRecoveries}). Here is the current state:

Mission: ${missionGoal}

Steps:
${stepSummaries || "  (none)"}

Running workers:
${runningWorkers || "  (none)"}

Recent completed workers:
${completedWorkers || "  (none)"}

Check all worker statuses and continue managing the mission from here. Read worker outputs for any recently completed workers to understand what's been done.`,
      );

      logger.info("ai_orchestrator.coordinator_recovered", {
        runId,
        missionId,
        recoveryAttempt: nextAttempt,
      });

      emitOrchestratorMessage(
        missionId,
        `Coordinator recovered (attempt ${nextAttempt}/${maxRecoveries}). Resuming mission control.`,
        null,
        { role: "coordinator_v2", runId },
      );
      resolveCoordinatorHealthInterventions({
        runId,
        note: `Coordinator recovered and resumed mission control on attempt ${nextAttempt}/${maxRecoveries}.`,
        resolutionReason: "coordinator_recovered",
      });

      return newAgent;
    } catch (error) {
      logger.warn("ai_orchestrator.coordinator_recovery_failed", {
        runId,
        recoveryAttempt: nextAttempt,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const emitOrchestratorMessage = (
    missionId: string,
    content: string,
    stepKey?: string | null,
    metadata?: Record<string, unknown> | null
  ): OrchestratorChatMessage => {
    const runId = typeof metadata?.runId === "string" ? metadata.runId : null;
    const role = typeof metadata?.role === "string" ? metadata.role : null;
    if (runId && role === "coordinator_v2" && shouldSuppressCoordinatorWrites(runId)) {
      return {
        id: randomUUID(),
        missionId,
        role: "orchestrator",
        content,
        timestamp: nowIso(),
        stepKey: stepKey ?? null,
        metadata: metadata ?? null,
      };
    }
    return emitOrchestratorMessageCtx(ctx, missionId, content, stepKey, metadata, { appendChatMessage });
  };

  const emitValidationSystemSignal = (args: {
    event: OrchestratorRuntimeEvent;
    graph: OrchestratorRunGraph;
  }): void => {
    const signalType =
      args.event.reason === "validation_contract_unfulfilled" ||
      args.event.reason === "validation_self_check_reminder" ||
      args.event.reason === "validation_auto_spawned" ||
      args.event.reason === "validation_gate_blocked"
        ? args.event.reason
        : null;
    if (!signalType || !args.event.runId) return;
    const missionId = getMissionIdForRun(args.event.runId);
    if (!missionId) return;

    const dedupeKey = `${signalType}:${args.event.runId}:${args.event.stepId ?? "none"}:${args.event.attemptId ?? "none"}`;
    if (validationSystemSignalDedupe.has(dedupeKey)) return;
    validationSystemSignalDedupe.add(dedupeKey);
    if (validationSystemSignalDedupe.size > 500) {
      // Evict oldest half instead of full clear to preserve recent dedup keys
      const entries = [...validationSystemSignalDedupe];
      validationSystemSignalDedupe.clear();
      for (const key of entries.slice(entries.length >> 1)) {
        validationSystemSignalDedupe.add(key);
      }
    }

    const step = args.event.stepId
      ? args.graph.steps.find((entry) => entry.id === args.event.stepId) ?? null
      : null;
    const stepLabel = step?.title?.trim().length ? step.title.trim() : (step?.stepKey ?? "unknown step");
    let message = "Validation system event received.";
    const metadata: Record<string, unknown> = {
      systemSignal: signalType,
      runId: args.event.runId,
      stepId: args.event.stepId ?? null,
      attemptId: args.event.attemptId ?? null
    };
    if (step?.stepKey) {
      metadata.stepKey = step.stepKey;
    }

    if (signalType === "validation_contract_unfulfilled") {
      message = `Validation System: Required validation is missing for "${stepLabel}". A validator pass is required before this step can be treated as complete.`;
    } else if (signalType === "validation_self_check_reminder") {
      message = `Validation System: "${stepLabel}" requires self-validation. Call report_validation with verdict pass/fail to unblock downstream work.`;
    } else if (signalType === "validation_gate_blocked") {
      const gateEvent = args.graph.timeline.find((entry) => {
        if (entry.eventType !== "validation_gate_blocked") return false;
        if (args.event.stepId && entry.stepId) return entry.stepId === args.event.stepId;
        return true;
      });
      const detail = isRecord(gateEvent?.detail) ? gateEvent.detail : {};
      const reasonText = typeof detail.reason === "string" ? detail.reason.trim() : "";
      const phaseText = typeof detail.phase === "string" ? detail.phase.trim() : "";
      if (reasonText.length > 0) metadata.reason = reasonText;
      if (phaseText.length > 0) metadata.phase = phaseText;
      message = reasonText.length > 0
        ? `Validation System: Worker spawn blocked by required validation gate. ${reasonText}`
        : "Validation System: Worker spawn blocked by required validation gate.";
    }

    emitOrchestratorMessage(
      missionId,
      message,
      step?.stepKey ?? null,
      metadata
    );
  };

  const MISSION_STATE_TERMINAL_STEP_STATUSES = new Set<OrchestratorStepStatus>([
    "succeeded",
    "failed",
    "skipped",
    "superseded",
    "canceled",
  ]);

  const toMissionStateStepStatus = (status: OrchestratorStepStatus): MissionStateStepOutcome["status"] => {
    if (status === "succeeded") return "succeeded";
    if (status === "failed") return "failed";
    if (status === "skipped" || status === "superseded" || status === "canceled") return "skipped";
    return "in_progress";
  };

  const missionGoalForStateDoc = (missionId: string): string => {
    const mission = missionService.get(missionId);
    const prompt = typeof mission?.prompt === "string" ? mission.prompt.trim() : "";
    if (prompt.length > 0) return prompt;
    const title = typeof mission?.title === "string" ? mission.title.trim() : "";
    if (title.length > 0) return title;
    return `Mission ${missionId}`;
  };

  const currentPhaseFromGraph = (graph: OrchestratorRunGraph): string => {
    const runMeta = isRecord(graph.run.metadata) ? graph.run.metadata : {};
    const phaseRuntime = isRecord(runMeta.phaseRuntime) ? runMeta.phaseRuntime : {};
    const phaseName = typeof phaseRuntime.currentPhaseName === "string" ? phaseRuntime.currentPhaseName.trim() : "";
    if (phaseName.length > 0) return phaseName;
    const phaseKey = typeof phaseRuntime.currentPhaseKey === "string" ? phaseRuntime.currentPhaseKey.trim() : "";
    if (phaseKey.length > 0) return phaseKey;
    const relevantSteps = filterExecutionSteps(graph.steps);
    const activeStep = relevantSteps.find((step) => !MISSION_STATE_TERMINAL_STEP_STATUSES.has(step.status)) ?? null;
    const activeMeta = isRecord(activeStep?.metadata) ? activeStep.metadata : {};
    const activePhaseName = typeof activeMeta.phaseName === "string" ? activeMeta.phaseName.trim() : "";
    if (activePhaseName.length > 0) return activePhaseName;
    const activePhaseKey = typeof activeMeta.phaseKey === "string" ? activeMeta.phaseKey.trim() : "";
    if (activePhaseKey.length > 0) return activePhaseKey;
    return "unknown";
  };

  const buildMissionStateProgressFromGraph = (graph: OrchestratorRunGraph): MissionStateProgress => {
    const relevantSteps = filterExecutionSteps(graph.steps);
    return {
      currentPhase: currentPhaseFromGraph(graph),
      completedSteps: relevantSteps.filter((step) => MISSION_STATE_TERMINAL_STEP_STATUSES.has(step.status)).length,
      totalSteps: relevantSteps.length,
      activeWorkers: relevantSteps.filter((step) => step.status === "running").map((step) => step.stepKey),
      blockedSteps: relevantSteps.filter((step) => step.status === "blocked").map((step) => step.stepKey),
      failedSteps: relevantSteps.filter((step) => step.status === "failed").map((step) => step.stepKey),
    };
  };

  const pendingInterventionsForMission = (missionId: string): MissionStatePendingIntervention[] => {
    const mission = missionService.get(missionId);
    if (!mission) return [];
    return mission.interventions
      .filter((entry) => entry.status === "open")
      .map((entry) => ({
        id: entry.id,
        type: entry.interventionType,
        title: entry.title,
        createdAt: entry.createdAt,
      }));
  };

  const updateMissionStateDoc = (
    runId: string,
    patch: MissionStateDocumentPatch,
    options?: { graph?: OrchestratorRunGraph | null }
  ): void => {
    void persistMissionStateDoc(runId, patch, options);
  };

  const persistMissionStateDoc = async (
    runId: string,
    patch: MissionStateDocumentPatch,
    options?: { graph?: OrchestratorRunGraph | null }
  ): Promise<void> => {
    if (!projectRoot) return;
    const graph =
      options?.graph ??
      (() => {
        try {
          return orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
        } catch {
          return null;
        }
      })();
    const missionId = graph?.run.missionId ?? getMissionIdForRun(runId);
    if (!missionId) return;
    const progress = graph ? buildMissionStateProgressFromGraph(graph) : undefined;
    const normalizedPatch: MissionStateDocumentPatch = {
      ...patch,
      ...(progress
        ? {
            updateProgress: {
              ...progress,
              ...(patch.updateProgress ?? {}),
            },
          }
        : {}),
    };
    await updateMissionStateDocument({
      projectRoot,
      missionId,
      runId,
      goal: missionGoalForStateDoc(missionId),
      patch: normalizedPatch,
      initialProgress: progress,
    }).catch((error) => {
      logger.debug("ai_orchestrator.mission_state_update_failed", {
        runId,
        missionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const NULL_FINALIZATION_FIELDS = {
    targetBranch: null,
    draft: null,
    prDepth: null,
    autoRebase: null,
    ciGating: null,
    autoLand: null,
    autoResolveConflicts: null,
    archiveLaneOnLand: null,
    mergeMethod: null,
    conflictResolverModel: null,
    reasoningEffort: null,
  } as const;

  const resolveMissionFinalizationPolicy = (strategy: PrStrategy | null | undefined): MissionFinalizationPolicy => {
    if (!strategy || strategy.kind === "manual") {
      return {
        ...NULL_FINALIZATION_FIELDS,
        kind: "manual",
        description: "Manual PR handling. Execution completion satisfies the mission contract."
      };
    }
    if (strategy.kind === "integration") {
      return {
        ...NULL_FINALIZATION_FIELDS,
        kind: "integration",
        targetBranch: strategy.targetBranch ?? null,
        draft: strategy.draft ?? true,
        prDepth: strategy.prDepth ?? "resolve-conflicts",
        description: "Create a single integration PR as part of mission completion."
      };
    }
    if (strategy.kind === "per-lane") {
      return {
        ...NULL_FINALIZATION_FIELDS,
        kind: "per-lane",
        targetBranch: strategy.targetBranch ?? null,
        draft: strategy.draft ?? true,
        prDepth: strategy.prDepth ?? null,
        description: "Create one PR per lane before the mission is considered complete."
      };
    }
    const autoLand = strategy.autoLand ?? false;
    const autoResolveConflicts = strategy.autoResolveConflicts ?? false;
    return {
      kind: "queue",
      targetBranch: strategy.targetBranch ?? null,
      draft: strategy.draft ?? true,
      prDepth: strategy.prDepth ?? null,
      autoRebase: strategy.autoRebase ?? true,
      ciGating: strategy.ciGating ?? false,
      autoLand,
      autoResolveConflicts,
      archiveLaneOnLand: strategy.archiveLaneOnLand ?? false,
      mergeMethod: strategy.mergeMethod ?? "squash",
      conflictResolverModel: strategy.conflictResolverModel ?? null,
      reasoningEffort: strategy.reasoningEffort ?? null,
      description: autoLand
        ? autoResolveConflicts
          ? "Create queue PRs, auto-resolve merge conflicts, and land the queue before the mission is considered complete."
          : "Create queue PRs and land the queue before the mission is considered complete."
        : "Create queue PRs before the mission is considered complete."
    };
  };

  const EVIDENCE_TO_CLOSEOUT_KEYS = new Set<string>([
    "planning_document", "research_summary", "changed_files_summary",
    "test_report", "review_summary", "risk_notes", "final_outcome_summary",
    "screenshot", "browser_verification", "video_recording", "browser_trace", "console_logs",
  ]);

  const mapEvidenceRequirementToCloseoutKey = (
    requirement: ValidationEvidenceRequirement
  ): MissionCloseoutRequirementKey | null =>
    EVIDENCE_TO_CLOSEOUT_KEYS.has(requirement) ? requirement as MissionCloseoutRequirementKey : null;

  const buildMissionCloseoutRequirements = (args: {
    mission: MissionDetail;
    graph: OrchestratorRunGraph;
    policy: MissionFinalizationPolicy;
    finalization: MissionFinalizationState | null;
    stateDoc: MissionStateDocument | null;
  }): MissionCloseoutRequirement[] => {
    const backendStatus = computerUseArtifactBrokerService?.getBackendStatus() ?? null;
    const computerUseKinds = new Set(getComputerUseArtifactKinds());
    const hasExternalCoverage = (requirementKey: MissionCloseoutRequirementKey): boolean =>
      computerUseKinds.has(requirementKey as ReturnType<typeof getComputerUseArtifactKinds>[number])
        ? (
            backendStatus?.backends.some((backend) =>
              backend.available && backend.supportedKinds.includes(
                requirementKey as ReturnType<typeof getComputerUseArtifactKinds>[number]
              )
            ) ?? false
          )
        : false;
    const outcomeSummary = buildOutcomeSummary(args.graph).trim();
    const modifiedFiles = args.stateDoc?.modifiedFiles ?? [];
    const completionDiagnostics = args.graph.completionEvaluation?.diagnostics ?? [];
    const explicitValidationVerdict = args.graph.completionEvaluation?.validation?.canComplete;
    const validationPhaseSucceeded = completionDiagnostics.some(
      (diagnostic) => diagnostic.phase === "validation" && diagnostic.code === "phase_succeeded"
    );
    const validationPhaseBlocked = completionDiagnostics.some(
      (diagnostic) => diagnostic.phase === "validation" && diagnostic.blocking
    );
    const validationVerdict = typeof explicitValidationVerdict === "boolean"
      ? explicitValidationVerdict
      : validationPhaseSucceeded
        ? true
        : validationPhaseBlocked
          ? false
          : undefined;
    const missionArtifacts = args.mission.artifacts ?? [];
    const orchestratorArtifacts = orchestratorService.getArtifactsForMission(args.mission.id);
    const closeoutRequirements = new Map<MissionCloseoutRequirementKey, MissionCloseoutRequirement>();
    const artifactByKey = new Map<MissionCloseoutRequirementKey, { artifactId: string | null; uri: string | null; detail: string | null; source: "declared" | "discovered" }>();

    for (const artifact of missionArtifacts) {
      const requirementKey = resolveCloseoutRequirementKeyFromArtifact({
        artifactType: artifact.artifactType,
        metadata: artifact.metadata,
      });
      if (!requirementKey) continue;
      artifactByKey.set(requirementKey, {
        artifactId: artifact.id,
        uri: artifact.uri ?? null,
        detail: artifact.description ?? null,
        source: "declared",
      });
    }
    for (const artifact of orchestratorArtifacts) {
      const requirementKey = resolveCloseoutRequirementKeyFromArtifact({
        artifactKey: artifact.artifactKey,
        kind: artifact.kind,
        metadata: artifact.metadata,
      });
      if (!requirementKey) continue;
      artifactByKey.set(requirementKey, {
        artifactId: artifact.id,
        uri: resolveOrchestratorArtifactUri({
          kind: artifact.kind,
          value: artifact.value,
          metadata: artifact.metadata,
        }),
        detail: typeof artifact.metadata.summary === "string"
          ? artifact.metadata.summary
          : typeof artifact.metadata.description === "string"
            ? artifact.metadata.description
            : null,
        source: artifact.declared ? "declared" : "discovered",
      });
    }

    const pushRequirement = (requirement: MissionCloseoutRequirement): void => {
      closeoutRequirements.set(requirement.key, requirement);
    };

    pushRequirement({
      key: "implementation_summary",
      label: "Implementation summary",
      required: true,
      status: outcomeSummary.length > 0 ? "present" : "missing",
      detail: outcomeSummary.length > 0 ? outcomeSummary : "Execution finished without a final implementation summary.",
      artifactId: null,
      uri: null,
      source: "runtime",
    });

    pushRequirement({
      key: "final_outcome_summary",
      label: "Final outcome summary",
      required: true,
      status: outcomeSummary.length > 0 ? "present" : "missing",
      detail: outcomeSummary.length > 0 ? outcomeSummary : "No final outcome summary has been recorded yet.",
      artifactId: null,
      uri: null,
      source: "runtime",
    });

    pushRequirement({
      key: "changed_files_summary",
      label: "Changed files summary",
      required: true,
      status: modifiedFiles.length > 0 ? "present" : "waived",
      detail: modifiedFiles.length > 0
        ? `${modifiedFiles.length} file(s) changed: ${modifiedFiles.slice(0, 12).join(", ")}`
        : "No file changes were reported for this mission.",
      artifactId: null,
      uri: null,
      source: modifiedFiles.length > 0 ? "runtime" : "waiver",
    });

    const validationRequired = (args.mission.phaseConfiguration?.selectedPhases ?? [])
      .some((phase) => phase.validationGate.required);
    pushRequirement({
      key: "validation_verdict",
      label: "Validation verdict",
      required: validationRequired,
      status: validationRequired
        ? typeof validationVerdict === "boolean"
          ? "present"
          : "missing"
        : "waived",
      detail: validationRequired
        ? typeof validationVerdict === "boolean"
          ? validationVerdict
            ? "Validation passed."
            : "Validation reported blockers."
          : "Validation verdict has not been recorded yet."
        : "No required validation gate was configured for this mission.",
      artifactId: null,
      uri: null,
      source: validationRequired ? "runtime" : "waiver",
    });

    if (args.policy.kind !== "manual" && args.policy.kind !== "disabled") {
      const reviewRequired = args.policy.prDepth === "open-and-comment";
      const proposalOnly = args.policy.prDepth === "propose-only";
      pushRequirement({
        key: proposalOnly ? "proposal_url" : "pr_url",
        label: proposalOnly ? "Proposal URL" : "PR URL",
        required: true,
        status: proposalOnly
          ? args.finalization?.proposalUrl
            ? "present"
            : "missing"
          : (args.finalization?.prUrls.length ?? 0) > 0
            ? "present"
            : "missing",
        detail: proposalOnly
          ? args.finalization?.proposalUrl ?? "A proposal URL has not been attached yet."
          : args.finalization?.prUrls[0] ?? "A PR URL has not been attached yet.",
        artifactId: null,
        uri: proposalOnly ? args.finalization?.proposalUrl ?? null : args.finalization?.prUrls[0] ?? null,
        source: "runtime",
      });
      if (reviewRequired) {
        pushRequirement({
          key: "review_summary",
          label: "Review summary",
          required: true,
          status: args.finalization?.reviewStatus === "comment_posted" ? "present" : "missing",
          detail: args.finalization?.reviewStatus === "comment_posted"
            ? "ADE posted the configured review/finalization comment."
            : "The configured review summary comment has not been posted yet.",
          artifactId: null,
          uri: args.finalization?.prUrls[0] ?? null,
          source: "runtime",
        });
      }
    }

    const requiredEvidence = new Set<MissionCloseoutRequirementKey>();
    for (const phase of args.mission.phaseConfiguration?.selectedPhases ?? []) {
      if (!phase.validationGate.required) continue;
      for (const evidenceRequirement of phase.validationGate.evidenceRequirements ?? []) {
        const requirementKey = mapEvidenceRequirementToCloseoutKey(evidenceRequirement);
        if (requirementKey) requiredEvidence.add(requirementKey);
      }
    }

    for (const requirementKey of requiredEvidence) {
      if (closeoutRequirements.has(requirementKey)) continue;
      const artifact = artifactByKey.get(requirementKey) ?? null;
      const capability = isProofEvidenceRequirement(requirementKey)
        ? getCapabilityForRequirement(requirementKey)
        : null;
      pushRequirement({
        key: requirementKey,
        label: requirementKey.replace(/_/g, " "),
        required: true,
        status: artifact
          ? "present"
          : hasExternalCoverage(requirementKey)
            ? "missing"
          : capability && !capability.available
            ? "blocked_by_capability"
            : "missing",
        detail: artifact?.detail
          ?? artifact?.uri
          ?? (
            hasExternalCoverage(requirementKey)
              ? `Required evidence "${requirementKey.replace(/_/g, " ")}" has not been attached yet, but an approved external computer-use backend is available.`
            : capability && !capability.available
              ? `Required evidence "${requirementKey.replace(/_/g, " ")}" is blocked because the local computer-use runtime is unavailable. ${capability.detail}`
              : `Required evidence "${requirementKey.replace(/_/g, " ")}" has not been attached yet.`
          ),
        artifactId: artifact?.artifactId ?? null,
        uri: artifact?.uri ?? null,
        source: artifact?.source ?? (capability && !capability.available && !hasExternalCoverage(requirementKey) ? "runtime" : "declared"),
      });
    }

    return [...closeoutRequirements.values()];
  };

  const updateMissionFinalizationState = async (
    runId: string,
    state: Partial<MissionFinalizationState> & { policy: MissionFinalizationPolicy; status: MissionFinalizationState["status"] },
    options?: { graph?: OrchestratorRunGraph | null }
  ): Promise<MissionFinalizationState | null> => {
    const now = nowIso();
    const stateDoc = projectRoot
      ? await readMissionStateDocument({ projectRoot, runId }).catch(() => null)
      : null;
    const previous = stateDoc?.finalization ?? null;
    const next: MissionFinalizationState = {
      policy: state.policy,
      status: state.status,
      executionComplete: state.executionComplete ?? previous?.executionComplete ?? false,
      contractSatisfied: state.contractSatisfied ?? previous?.contractSatisfied ?? false,
      blocked: state.blocked ?? previous?.blocked ?? false,
      blockedReason: state.blockedReason ?? previous?.blockedReason ?? null,
      summary: state.summary ?? previous?.summary ?? null,
      detail: state.detail ?? previous?.detail ?? null,
      resolverJobId: state.resolverJobId ?? previous?.resolverJobId ?? null,
      integrationLaneId: state.integrationLaneId ?? previous?.integrationLaneId ?? null,
      queueGroupId: state.queueGroupId ?? previous?.queueGroupId ?? null,
      queueId: state.queueId ?? previous?.queueId ?? null,
      activePrId: state.activePrId ?? previous?.activePrId ?? null,
      waitReason: state.waitReason ?? previous?.waitReason ?? null,
      proposalUrl: state.proposalUrl ?? previous?.proposalUrl ?? null,
      prUrls: state.prUrls ?? previous?.prUrls ?? [],
      reviewStatus: state.reviewStatus ?? previous?.reviewStatus ?? null,
      mergeReadiness: state.mergeReadiness ?? previous?.mergeReadiness ?? null,
      requirements: state.requirements ?? previous?.requirements ?? [],
      warnings: state.warnings ?? previous?.warnings ?? [],
      updatedAt: now,
      startedAt: state.startedAt ?? previous?.startedAt ?? now,
      completedAt: state.completedAt ?? previous?.completedAt ?? null,
    };
    await persistMissionStateDoc(runId, { finalization: next }, options);
    return next;
  };

  const updateMissionCompletionFromStateDoc = async (args: {
    runId: string;
    graph: OrchestratorRunGraph;
    mission: MissionDetail;
    finalization: MissionFinalizationState | null;
  }): Promise<void> => {
    if (!projectRoot || !args.finalization) return;
    const stateDoc = await readMissionStateDocument({ projectRoot, runId: args.runId }).catch(() => null);
    const closeoutRequirements = buildMissionCloseoutRequirements({
      mission: args.mission,
      graph: args.graph,
      policy: args.finalization.policy,
      finalization: args.finalization,
      stateDoc,
    });
    const unmetRequirements = closeoutRequirements.filter((requirement) =>
      requirement.required && requirement.status !== "present" && requirement.status !== "waived",
    );
    const nextFinalization = await updateMissionFinalizationState(args.runId, {
      policy: args.finalization.policy,
      status: unmetRequirements.length > 0 && args.finalization.status === "completed"
        ? "finalizing"
        : args.finalization.status,
      executionComplete: true,
      contractSatisfied: args.finalization.contractSatisfied && unmetRequirements.length === 0,
      requirements: closeoutRequirements,
      summary: unmetRequirements.length > 0
        ? "Execution finished, but the closeout contract is still incomplete."
        : args.finalization.summary,
      detail: unmetRequirements.length > 0
        ? unmetRequirements.map((requirement) => requirement.label).join(", ")
        : args.finalization.detail,
      completedAt: unmetRequirements.length > 0 ? null : args.finalization.completedAt,
    }, { graph: args.graph });
    if (!nextFinalization) return;
    if (nextFinalization.status === "finalization_failed") {
      transitionMissionStatus(args.mission.id, "failed", {
        lastError: nextFinalization.blockedReason ?? nextFinalization.detail ?? "Mission finalization failed.",
      });
      return;
    }
    if (nextFinalization.contractSatisfied) {
      transitionMissionStatus(args.mission.id, "completed", {
        outcomeSummary: buildOutcomeSummary(args.graph),
        lastError: null,
      });
    }
  };

  const setCoordinatorAvailability = (
    runId: string,
    availability: MissionCoordinatorAvailability,
    options?: { graph?: OrchestratorRunGraph | null }
  ): void => {
    updateMissionStateDoc(runId, { coordinatorAvailability: availability }, options);
  };

  const onQueueLandingStateChanged = async (queueState: import("../../../shared/types").QueueLandingState): Promise<void> => {
    const runId = queueState.config.originRunId ?? null;
    const missionId = queueState.config.originMissionId ?? (runId ? getMissionIdForRun(runId) : null);
    if (!runId || !missionId) return;

    const mission = missionService.get(missionId);
    if (!mission) return;

    let graph: OrchestratorRunGraph;
    try {
      graph = orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
    } catch {
      return;
    }

    const prUrls = queueState.entries
      .map((entry) => entry.githubUrl ?? null)
      .filter((value): value is string => Boolean(value));

    let status: MissionFinalizationState["status"] = "landing_queue";
    let blocked = false;
    let blockedReason: string | null = null;
    let mergeReadiness: string | null = null;
    let contractSatisfied = false;
    let summary = "Queue finalization is still running.";
    let detail = queueState.lastError ?? null;

    if (queueState.state === "completed") {
      status = "completed";
      contractSatisfied = true;
      mergeReadiness = "queue_landed";
      summary = "Execution and queue landing completed.";
      detail = `Queue ${queueState.groupName ?? queueState.groupId} landed ${queueState.entries.filter((entry) => entry.state === "landed").length} PR(s).`;
    } else if (queueState.state === "landing") {
      if (queueState.activeResolverRunId) {
        status = "resolving_queue_conflicts";
        summary = "Queue landing is resolving merge conflicts before continuing.";
      } else {
        status = "landing_queue";
        summary = "Queue landing is progressing through queued PRs.";
      }
    } else if (queueState.state === "paused") {
      if (queueState.waitReason === "ci") {
        status = "waiting_for_green";
        mergeReadiness = "waiting_for_green";
        summary = "Queue landing is waiting for CI before it can continue.";
      } else if (queueState.waitReason === "review") {
        status = "awaiting_operator_review";
        mergeReadiness = "operator_review_required";
        summary = "Queue landing is waiting for operator review before it can continue.";
      } else if (queueState.waitReason === "manual") {
        status = "finalizing";
        blocked = true;
        blockedReason = queueState.lastError ?? "Queue finalization is paused and needs operator intervention.";
        summary = "Queue finalization is paused pending operator intervention.";
      } else {
        status = "finalization_failed";
        blocked = true;
        blockedReason = queueState.lastError ?? "Queue finalization failed.";
        summary = "Queue finalization failed.";
      }
    } else if (queueState.state === "cancelled") {
      status = "finalization_failed";
      blocked = true;
      blockedReason = queueState.lastError ?? "Queue finalization was cancelled.";
      summary = "Queue finalization was cancelled.";
    }

    const finalization = await updateMissionFinalizationState(runId, {
      policy: resolveMissionFinalizationPolicy((resolveActivePhaseSettings(missionId).settings.prStrategy ?? { kind: "manual" }) as PrStrategy),
      status,
      executionComplete: true,
      contractSatisfied,
      blocked,
      blockedReason,
      summary,
      detail,
      resolverJobId: queueState.activeResolverRunId,
      queueGroupId: queueState.groupId,
      queueId: queueState.queueId,
      activePrId: queueState.activePrId,
      waitReason: queueState.waitReason,
      prUrls,
      mergeReadiness,
      completedAt: contractSatisfied ? queueState.completedAt : null,
      warnings: [],
    }, { graph });

    if (finalization) {
      await updateMissionCompletionFromStateDoc({
        runId,
        graph,
        mission,
        finalization,
      });
    }

    // Notify the coordinator agent when queue landing reaches a terminal state
    if (queueState.state === "completed" || queueState.state === "cancelled") {
      try {
        orchestratorService.appendRuntimeEvent({
          runId,
          eventType: "finalization_queue_landed",
          payload: {
            queueState: queueState.state,
            contractSatisfied,
            summary,
            detail,
            queueGroupId: queueState.groupId,
            prUrls,
          },
        });
      } catch (eventError) {
        logger.debug("ai_orchestrator.finalization_queue_landed_event_failed", {
          runId,
          error: eventError instanceof Error ? eventError.message : String(eventError),
        });
      }

      const coordAgent = coordinatorAgents.get(runId);
      if (coordAgent?.isAlive) {
        const eventMessage = queueState.state === "completed"
          ? `[finalization.queue_landed] Queue landing completed successfully. ${detail ?? ""} Call check_finalization_status for full details before deciding next steps.`
          : `[finalization.queue_landed] Queue landing was cancelled. ${detail ?? ""} Call check_finalization_status to review the current state.`;
        coordAgent.injectMessage(eventMessage);
      }
    }
  };

  const resolveMissionStateStepPhase = (step: OrchestratorStep): string => {
    const stepMeta = isRecord(step.metadata) ? step.metadata : {};
    const phaseName = typeof stepMeta.phaseName === "string" ? stepMeta.phaseName.trim() : "";
    if (phaseName.length > 0) return phaseName;
    const phaseKey = typeof stepMeta.phaseKey === "string" ? stepMeta.phaseKey.trim() : "";
    if (phaseKey.length > 0) return phaseKey;
    return "unknown";
  };

  const buildMissionStateStepOutcomeFromGraph = (
    graph: OrchestratorRunGraph,
    stepId: string
  ): MissionStateStepOutcome | null => {
    const step = graph.steps.find((entry) => entry.id === stepId) ?? null;
    if (!step) return null;

    const attemptsForStep = graph.attempts
      .filter((attempt) => attempt.stepId === step.id)
      .sort((a, b) => {
        const aTime = Date.parse(a.completedAt ?? a.startedAt ?? a.createdAt);
        const bTime = Date.parse(b.completedAt ?? b.startedAt ?? b.createdAt);
        if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
          return bTime - aTime;
        }
        if (a.attemptNumber !== b.attemptNumber) {
          return b.attemptNumber - a.attemptNumber;
        }
        return b.createdAt.localeCompare(a.createdAt);
      });
    const latestAttempt = attemptsForStep[0] ?? null;
    const digest = latestAttempt ? buildWorkerDigestFromAttempt({ graph, attempt: latestAttempt }) : null;
    const fallbackSummary =
      step.status === "failed"
        ? latestAttempt?.errorMessage ?? `Step ${step.stepKey} failed.`
        : step.status === "succeeded"
          ? `Step ${step.stepKey} completed.`
          : step.status === "skipped" || step.status === "superseded" || step.status === "canceled"
            ? `Step ${step.stepKey} was skipped.`
            : `Step ${step.stepKey} is in progress.`;
    // Best-effort: try to read durable step output file for enriched summary
    let stepOutputContent: string | null = null;
    if (projectRoot) {
      try {
        const sanitizedKey = step.stepKey.replace(/[^a-zA-Z0-9_-]/g, "_");
        const outputPath = nodePath.resolve(projectRoot, `.ade/step-output-${sanitizedKey}.md`);
        if (fs.existsSync(outputPath)) {
          stepOutputContent = fs.readFileSync(outputPath, "utf-8").trim();
        }
      } catch {
        // Non-critical — fall back to digest summary
      }
    }

    // If we have a step output file, extract the Summary section to enrich the outcome
    let enrichedSummary: string | null = null;
    if (stepOutputContent) {
      const summaryMatch = stepOutputContent.match(/^## Summary\s*\n([\s\S]*?)(?=\n## |\n*$)/m);
      if (summaryMatch?.[1]?.trim()) {
        enrichedSummary = summaryMatch[1].trim();
      }
    }

    const summarySource = enrichedSummary || digest?.summary?.trim() || fallbackSummary;
    const summary = summarySource.length > 0 ? summarySource.slice(0, 320) : `Step ${step.stepKey} update.`;
    const testsRun = digest?.testsRun
      ? {
          passed: Math.max(0, Math.floor(Number(digest.testsRun.passed ?? 0) || 0)),
          failed: Math.max(0, Math.floor(Number(digest.testsRun.failed ?? 0) || 0)),
          skipped: Math.max(0, Math.floor(Number(digest.testsRun.skipped ?? 0) || 0)),
        }
      : undefined;

    return {
      stepKey: step.stepKey,
      stepName: step.title,
      phase: resolveMissionStateStepPhase(step),
      status: toMissionStateStepStatus(step.status),
      summary,
      filesChanged: digest?.filesChanged ?? [],
      ...(testsRun ? { testsRun } : {}),
      warnings: digest?.warnings ?? [],
      completedAt:
        MISSION_STATE_TERMINAL_STEP_STATUSES.has(step.status)
          ? step.completedAt ?? latestAttempt?.completedAt ?? nowIso()
          : null,
    };
  };

  const resolveProjectIdForMission = (missionId?: string | null): string | null => {
    const normalizedMissionId = toOptionalString(missionId);
    if (normalizedMissionId) {
      const missionProjectId =
        toOptionalString(
          db.get<{ project_id: string | null }>(
            `select project_id from missions where id = ? limit 1`,
            [normalizedMissionId],
          )?.project_id,
        );
      if (missionProjectId) return missionProjectId;
    }

    return toOptionalString(
      db.get<{ id: string | null }>(
        `
          select id
          from projects
          order by datetime(last_opened_at) desc, datetime(created_at) desc, id asc
          limit 1
        `,
      )?.id,
    );
  };

  /**
   * Resolve the primary lane ID. Returns null if lane service is unavailable.
   */
  const resolvePrimaryLaneId = async (missionId?: string | null): Promise<string | null> => {
    const effectiveProjectId = resolveProjectIdForMission(missionId);
    if (!effectiveProjectId) return null;
    if (laneService && typeof laneService.list === "function") {
      const lanes = await laneService.list({ includeArchived: false });
      const primary = lanes.find((lane) => lane.laneType === "primary") ?? lanes[0] ?? null;
      return primary?.id?.trim() || null;
    }
    const laneRow = db.get<{ id: string | null }>(
      `
        select id
        from lanes
        where project_id = ?
          and archived_at is null
        order by case when lane_type = 'primary' then 0 else 1 end, created_at asc, id asc
        limit 1
      `,
      [effectiveProjectId]
    );
    return toOptionalString(laneRow?.id);
  };

  const resolveMissionBaseLaneId = async (missionId?: string | null): Promise<string | null> => {
    const normalizedMissionId = toOptionalString(missionId);
    if (normalizedMissionId) {
      const selectedLaneId = toOptionalString(missionService.get(normalizedMissionId)?.laneId);
      if (selectedLaneId) return selectedLaneId;
    }
    return await resolvePrimaryLaneId(missionId);
  };

  const resolveLaneBranchName = async (laneId?: string | null): Promise<string | null> => {
    const normalizedLaneId = toOptionalString(laneId);
    if (!normalizedLaneId) return null;
    if (laneService && typeof laneService.list === "function") {
      const lanes = await laneService.list({ includeArchived: false });
      const lane = lanes.find((entry) => entry.id === normalizedLaneId) ?? null;
      if (lane) {
        return normalizeBranchName(lane.branchRef || lane.baseRef || "") || null;
      }
    }
    const laneRow = db.get<{ branch_ref: string | null; base_ref: string | null }>(
      `
        select branch_ref, base_ref
        from lanes
        where id = ?
        limit 1
      `,
      [normalizedLaneId]
    );
    return normalizeBranchName(laneRow?.branch_ref ?? laneRow?.base_ref ?? "") || null;
  };

  const resolveMissionBaseBranch = async (missionId?: string | null): Promise<string | null> => {
    const baseLaneId = await resolveMissionBaseLaneId(missionId);
    return await resolveLaneBranchName(baseLaneId);
  };

  /**
   * Create a lane branching from the mission's selected base lane.
   * Falls back to primary when the mission has no explicit base lane.
   * Used for both initial mission lane creation and dynamic provisioning.
   * Returns { laneId, name } or null if unavailable.
   */
  const createLaneFromBase = async (
    name: string,
    opts: { description?: string; folder?: string; missionId: string },
  ): Promise<{ laneId: string; name: string } | null> => {
    if (!laneService) return null;
    const baseLaneId = await resolveMissionBaseLaneId(opts.missionId);
    if (!baseLaneId) {
      logger.warn("ai_orchestrator.lane_create_skip", { missionId: opts.missionId, reason: "no_base_lane" });
      return null;
    }
    const child = await laneService.createChild({
      parentLaneId: baseLaneId,
      name,
      description: opts.description,
      folder: opts.folder,
    });
    logger.info("ai_orchestrator.lane_created", {
      missionId: opts.missionId,
      laneId: child.id,
      name,
      baseLaneId,
    });
    return { laneId: child.id, name: child.name };
  };

  /**
   * Create a dedicated mission lane. Returns the lane ID or null on failure.
   */
  const createMissionLane = async (missionId: string, missionTitle: string): Promise<string | null> => {
    try {
      const laneName = missionTitle.trim().length > 0 ? missionTitle.trim() : `Mission ${missionId.slice(0, 6)}`;
      const result = await createLaneFromBase(
        laneName,
        { description: `Mission lane for ${missionTitle}`, folder: `Mission: ${missionTitle}`, missionId },
      );
      return result?.laneId ?? null;
    } catch (error) {
      logger.warn("ai_orchestrator.mission_lane_creation_failed", {
        missionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const readMissionLaneIdFromRunMetadata = (metadata: Record<string, unknown>): string | null => {
    const directLaneId = toOptionalString(metadata.missionLaneId);
    if (directLaneId) return directLaneId;

    const coordinatorMeta = isRecord(metadata.coordinator) ? metadata.coordinator : null;
    const coordinatorLaneId = coordinatorMeta ? toOptionalString(coordinatorMeta.missionLaneId) : null;
    if (coordinatorLaneId) return coordinatorLaneId;

    const teamRuntimeMeta = isRecord(metadata.teamRuntime) ? metadata.teamRuntime : null;
    return teamRuntimeMeta ? toOptionalString(teamRuntimeMeta.missionLaneId) : null;
  };

  const persistMissionLaneIdForRun = (runId: string, laneId: string): void => {
    const normalizedRunId = toOptionalString(runId);
    const normalizedLaneId = toOptionalString(laneId);
    if (!normalizedRunId || !normalizedLaneId) return;
    updateRunMetadata(normalizedRunId, (metadata) => {
      metadata.missionLaneId = normalizedLaneId;
      const coordinatorMeta = isRecord(metadata.coordinator) ? { ...metadata.coordinator } : {};
      coordinatorMeta.missionLaneId = normalizedLaneId;
      metadata.coordinator = coordinatorMeta;
      const teamRuntimeMeta = isRecord(metadata.teamRuntime) ? { ...metadata.teamRuntime } : {};
      teamRuntimeMeta.missionLaneId = normalizedLaneId;
      metadata.teamRuntime = teamRuntimeMeta;
    });
  };

  const resolvePersistedMissionLaneIdForRun = (runId: string): string | null => {
    const normalizedRunId = toOptionalString(runId);
    if (!normalizedRunId) return null;

    const metadataLaneId = readMissionLaneIdFromRunMetadata(getRunMetadata(normalizedRunId));
    if (metadataLaneId) return metadataLaneId;

    const derivedLaneRow = db.get<{ lane_id: string | null }>(
      `
        select lane_id
        from orchestrator_steps
        where run_id = ?
          and lane_id is not null
        group by lane_id
        order by count(*) desc, min(step_index) asc, lane_id asc
        limit 1
      `,
      [normalizedRunId]
    );
    return toOptionalString(derivedLaneRow?.lane_id);
  };

  const ensureMissionLaneForRun = async (args: {
    runId: string;
    missionId: string;
    missionTitle: string;
    createIfMissing?: boolean;
  }): Promise<string | null> => {
    const persistedLaneId = resolvePersistedMissionLaneIdForRun(args.runId);
    if (persistedLaneId) {
      persistMissionLaneIdForRun(args.runId, persistedLaneId);
      return persistedLaneId;
    }
    if (args.createIfMissing === false) return null;
    const createdLaneId = await createMissionLane(args.missionId, args.missionTitle);
    if (createdLaneId) {
      persistMissionLaneIdForRun(args.runId, createdLaneId);
    }
    return createdLaneId;
  };

  const recordRuntimeEvent = (args: {
    runId: string;
    stepId?: string | null;
    attemptId?: string | null;
    sessionId?: string | null;
    eventType:
      | "progress"
      | "heartbeat"
      | "question"
      | "blocked"
      | "done"
      | "retry_scheduled"
      | "retry_exhausted"
      | "claim_conflict"
      | "session_ended"
      | "intervention_opened"
      | "intervention_resolved"
      | "coordinator_steering"
      | "coordinator_broadcast"
      | "coordinator_skip"
      | "coordinator_add_step"
      | "coordinator_pause"
      | "coordinator_parallelize"
      | "coordinator_consolidate"
      | "coordinator_shutdown"
      | "worker_status_report"
      | "worker_result_report"
      | "worker_message"
      | "plan_revised"
      | "lane_transfer"
      | "validation_report"
      | "validation_contract_unfulfilled"
      | "validation_self_check_reminder"
      | "validation_gate_blocked"
      | "tool_profiles_updated";
    eventKey?: string | null;
    occurredAt?: string | null;
    payload?: Record<string, unknown> | null;
  }) => {
    try {
      orchestratorService.appendRuntimeEvent(args);

      if (args.eventType === "validation_report") {
        const payload = isRecord(args.payload) ? args.payload : {};
        const scope = isRecord(payload.scope) ? payload.scope : {};
        const verdict =
          payload.verdict === "pass" || payload.verdict === "fail"
            ? payload.verdict
            : null;
        const findings = Array.isArray(payload.findings)
          ? payload.findings
              .map((entry) => {
                if (!isRecord(entry)) return "";
                const severity = typeof entry.severity === "string" ? entry.severity.trim() : "";
                const code = typeof entry.code === "string" ? entry.code.trim() : "";
                const message = typeof entry.message === "string" ? entry.message.trim() : "";
                const composed = [severity, code, message].filter((part) => part.length > 0).join(" ");
                return composed.trim();
              })
              .filter((entry) => entry.length > 0)
          : [];
        const graph = (() => {
          try {
            return orchestratorService.getRunGraph({ runId: args.runId, timelineLimit: 0 });
          } catch {
            return null;
          }
        })();
        const targetStep =
          graph?.steps.find((step) => step.id === args.stepId)
          ?? (() => {
            const key = typeof scope.stepKey === "string" ? scope.stepKey.trim() : "";
            if (!key.length || !graph) return null;
            return graph.steps.find((step) => step.stepKey === key) ?? null;
          })();
        const stepKey =
          targetStep?.stepKey
          ?? (typeof scope.stepKey === "string" ? scope.stepKey.trim() : "");
        if (stepKey.length > 0) {
          const stepMeta = isRecord(targetStep?.metadata) ? targetStep.metadata : {};
          const phase =
            (typeof stepMeta.phaseName === "string" && stepMeta.phaseName.trim().length > 0
              ? stepMeta.phaseName.trim()
              : typeof stepMeta.phaseKey === "string" && stepMeta.phaseKey.trim().length > 0
                ? stepMeta.phaseKey.trim()
                : "unknown");
          updateMissionStateDoc(args.runId, {
            updateStepOutcome: {
              stepKey,
              updates: {
                ...(targetStep ? { stepName: targetStep.title, phase } : {}),
                validation: {
                  verdict,
                  findings,
                },
              },
            },
          }, { graph });
        }
      } else if (args.eventType === "validation_contract_unfulfilled") {
        const payload = isRecord(args.payload) ? args.payload : {};
        const stepKey = typeof payload.stepKey === "string" ? payload.stepKey.trim() : "";
        const detail = typeof payload.detail === "string" ? payload.detail.trim() : "";
        const description =
          detail.length > 0
            ? detail
            : "A required validation contract was not fulfilled for a completed step.";
        updateMissionStateDoc(args.runId, {
          addIssue: {
            id: `validation-contract-${randomUUID()}`,
            severity: "high",
            description,
            affectedSteps: stepKey.length > 0 ? [stepKey] : [],
            status: "open",
          },
        });
      } else if (args.eventType === "validation_gate_blocked") {
        const payload = isRecord(args.payload) ? args.payload : {};
        const detail = typeof payload.reason === "string" ? payload.reason.trim() : "";
        const stepKey = typeof payload.stepKey === "string" ? payload.stepKey.trim() : "";
        updateMissionStateDoc(args.runId, {
          addIssue: {
            id: `validation-gate-blocked-${randomUUID()}`,
            severity: "medium",
            description: detail.length > 0 ? detail : "Validation gate blocked worker creation until required upstream validation passes.",
            affectedSteps: stepKey.length > 0 ? [stepKey] : [],
            status: "open",
          },
        });
      } else if (args.eventType === "plan_revised") {
        const payload = isRecord(args.payload) ? args.payload : {};
        const reason = typeof payload.reason === "string" ? payload.reason.trim() : "Coordinator revised the plan.";
        const replaced = Array.isArray(payload.replacedStepKeys)
          ? payload.replacedStepKeys.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
          : [];
        const added = Array.isArray(payload.newStepKeys)
          ? payload.newStepKeys.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
          : [];
        const contextParts = [
          replaced.length > 0 ? `Replaced: ${replaced.join(", ")}` : "",
          added.length > 0 ? `Added: ${added.join(", ")}` : "",
        ].filter((entry) => entry.length > 0);
        updateMissionStateDoc(args.runId, {
          addDecision: {
            timestamp: nowIso(),
            decision: "Plan revised",
            rationale: reason,
            context: contextParts.join(" | ") || "Plan changed based on coordinator runtime assessment.",
          },
        });
      } else if (args.eventType === "intervention_opened" || args.eventType === "intervention_resolved") {
        const missionId = getMissionIdForRun(args.runId);
        if (missionId) {
          updateMissionStateDoc(args.runId, {
            pendingInterventions: pendingInterventionsForMission(missionId),
          });
        }
      }
    } catch (error) {
      logger.debug("ai_orchestrator.runtime_event_append_failed", {
        runId: args.runId,
        stepId: args.stepId ?? null,
        attemptId: args.attemptId ?? null,
        sessionId: args.sessionId ?? null,
        eventType: args.eventType,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const hookDispatchDeps: HookDispatchDeps = { recordRuntimeEvent };

  const dispatchOrchestratorHook = (hookArgs: Parameters<typeof dispatchOrchestratorHookCtx>[1]) =>
    dispatchOrchestratorHookCtx(ctx, hookArgs, hookDispatchDeps);

  const maybeDispatchTeammateIdleHook = (idleArgs: Parameters<typeof maybeDispatchTeammateIdleHookCtx>[1]) =>
    maybeDispatchTeammateIdleHookCtx(ctx, idleArgs, hookDispatchDeps);

  // Delegated to missionLifecycle.ts
  const resolveActivePhaseSettings = (missionId: string) => resolveActivePhaseSettingsCtx(ctx, missionId);
  const resolveActiveRuntimeProfile = (missionId: string) => resolveActiveRuntimeProfileCtx(ctx, missionId);

  const getSteeringContext = (missionId: string): string => {
    const directives = activeSteeringDirectives.get(missionId) ?? loadSteeringDirectivesFromMetadata(missionId);
    if (!directives?.length) return "";
    const recent = directives.slice(-MAX_STEERING_CONTEXT_DIRECTIVES);
    const rendered = [
      "",
      "Active user steering directives (apply these to your decisions):",
      ...recent.map((d, i) => {
        const compactDirective = clipTextForContext(d.directive.replace(/\s+/g, " ").trim(), MAX_CHAT_LINE_CHARS);
        return `  ${i + 1}. [${d.priority}] ${compactDirective}${d.targetStepKey ? ` (target: ${d.targetStepKey})` : ""}`;
      }),
      ""
    ].join("\n");
    return clipTextForContext(rendered, MAX_STEERING_CONTEXT_CHARS);
  };

  const projectSteeringDirectiveToActiveSteps = (directive: UserSteeringDirective): number => {
    const activeRuns = orchestratorService
      .listRuns({ missionId: directive.missionId, limit: 200 })
      .filter((run) => run.status === "active" || run.status === "bootstrapping" || run.status === "queued" || run.status === "paused");
    if (!activeRuns.length) return 0;

    const appliedAt = nowIso();
    const targetStepKey = directive.targetStepKey?.trim() ?? "";
    let updated = 0;
    for (const run of activeRuns) {
      let graph: OrchestratorRunGraph | null = null;
      try {
        graph = orchestratorService.getRunGraph({ runId: run.id, timelineLimit: 0 });
      } catch (error) {
        logger.debug("ai_orchestrator.steer_projection_graph_failed", {
          missionId: directive.missionId,
          runId: run.id,
          error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
      if (!graph) continue;

      for (const step of graph.steps) {
        if (step.status !== "pending" && step.status !== "ready" && step.status !== "running" && step.status !== "blocked") continue;
        if (targetStepKey.length > 0 && step.stepKey !== targetStepKey) continue;
        const nextMetadata = isRecord(step.metadata) ? { ...step.metadata } : {};
        const existing = Array.isArray(nextMetadata.steeringDirectives) ? nextMetadata.steeringDirectives as unknown[] : [];
        const normalizedExisting = existing
          .map((entry) => (isRecord(entry) ? entry : null))
          .filter((entry): entry is Record<string, unknown> => !!entry)
          .map((entry) => {
            const text = typeof entry.directive === "string" ? entry.directive.trim() : "";
            if (!text.length) return null;
            const priority = entry.priority === "instruction" || entry.priority === "override" ? entry.priority : "suggestion";
            return {
              directive: text,
              priority,
              targetStepKey: typeof entry.targetStepKey === "string" ? entry.targetStepKey : null,
              appliedAt: typeof entry.appliedAt === "string" ? entry.appliedAt : null
            };
          })
          .filter((entry): entry is { directive: string; priority: "suggestion" | "instruction" | "override"; targetStepKey: string | null; appliedAt: string | null } => !!entry);
        normalizedExisting.push({
          directive: directive.directive,
          priority: directive.priority,
          targetStepKey: directive.targetStepKey ?? null,
          appliedAt
        });
        nextMetadata.steeringDirectives = normalizedExisting.slice(-MAX_STEERING_DIRECTIVES_PER_STEP);
        db.run(
          `
            update orchestrator_steps
            set metadata_json = ?,
                updated_at = ?
            where id = ?
              and run_id = ?
              and project_id = ?
          `,
          [JSON.stringify(nextMetadata), appliedAt, step.id, run.id, run.projectId]
        );
        updated += 1;
      }
    }
    return updated;
  };

  // Delegate to workerTracking module via ctx
  const getWorkerStates = (args: { runId: string }) => getWorkerStatesCtx(ctx, args);
  const upsertWorkerState = (
    attemptId: string,
    update: {
      stepId: string;
      runId: string;
      sessionId?: string | null;
      executorKind: OrchestratorExecutorKind;
      state: OrchestratorWorkerStatus;
      outcomeTags?: string[];
      completedAt?: string | null;
    }
  ) => upsertWorkerStateCtx(ctx, attemptId, update);

  // Delegate to recoveryService module via ctx
  const ensureAttemptRuntimeTracker = (attemptId: string) => ensureAttemptRuntimeTrackerCtx(ctx, attemptId);

  // Delegated to recoveryService.ts
  const deletePersistedAttemptRuntimeState = (attemptId: string) => deletePersistedAttemptRuntimeStateCtx(ctx, attemptId);
  const persistAttemptRuntimeState = (args: Parameters<typeof persistAttemptRuntimeStateCtx>[1]) => persistAttemptRuntimeStateCtx(ctx, args);

  // Delegated to recoveryService.ts
  const hydratePersistedAttemptRuntimeState = () => hydratePersistedAttemptRuntimeStateCtx(ctx);

  const hydrateRuntimeSignalsFromEventBus = () => {
    let events: ReturnType<typeof orchestratorService.listRuntimeEvents>;
    try {
      events = orchestratorService.listRuntimeEvents({
        eventTypes: ["progress", "heartbeat", "question", "session_ended"],
        limit: STARTUP_RUNTIME_EVENT_HYDRATION_LIMIT
      });
    } catch {
      return;
    }
    if (!events.length) return;

    const isSyntheticSweepHeartbeat = (event: (typeof events)[number]): boolean => {
      if (event.eventType !== "heartbeat") return false;
      const payload = isRecord(event.payload) ? event.payload : null;
      return payload?.source === "health_sweep";
    };

    const latestBySession = new Map<string, (typeof events)[number]>();
    for (const event of events) {
      const sessionId = typeof event.sessionId === "string" ? event.sessionId.trim() : "";
      if (!sessionId.length || latestBySession.has(sessionId)) continue;
      if (isSyntheticSweepHeartbeat(event)) continue;
      latestBySession.set(sessionId, event);
    }

    for (const event of latestBySession.values()) {
      const sessionId = event.sessionId?.trim() ?? "";
      if (!sessionId.length) continue;
      const runtimeState: TerminalRuntimeState =
        event.eventType === "session_ended"
          ? "exited"
          : event.eventType === "question"
            ? "waiting-input"
            : "running";
      const payload = isRecord(event.payload) ? event.payload : null;
      const preview =
        payload && typeof payload.preview === "string" && payload.preview.trim().length > 0
          ? payload.preview.trim()
          : null;
      const existing = sessionRuntimeSignals.get(sessionId);
      const existingMs = existing ? Date.parse(existing.at) : Number.NaN;
      const eventMs = Date.parse(event.occurredAt);
      if (Number.isFinite(existingMs) && Number.isFinite(eventMs) && existingMs > eventMs) continue;
      sessionRuntimeSignals.set(sessionId, {
        laneId: null,
        sessionId,
        runtimeState,
        lastOutputPreview: preview,
        at: event.occurredAt
      });
    }

    for (const event of events) {
      const attemptId = typeof event.attemptId === "string" ? event.attemptId.trim() : "";
      if (!attemptId.length) continue;
      const tracker = ensureAttemptRuntimeTracker(attemptId);
      const eventMs = Date.parse(event.occurredAt);
      if (!Number.isFinite(eventMs)) continue;
      if (event.eventType === "heartbeat") {
        tracker.lastEventHeartbeatAtMs = Math.max(tracker.lastEventHeartbeatAtMs, Math.floor(eventMs));
      }
      if (event.eventType === "question") {
        tracker.lastWaitingInterventionAtMs = Math.max(tracker.lastWaitingInterventionAtMs, Math.floor(eventMs));
        const questionLink = event.questionLink ?? parseQuestionLink(event.payload);
        if (questionLink) {
          tracker.lastQuestionThreadId = questionLink.threadId;
          tracker.lastQuestionMessageId = questionLink.messageId;
        }
      } else if (event.eventType === "progress") {
        const payload = isRecord(event.payload) ? event.payload : null;
        const transition = typeof payload?.transition === "string" ? payload.transition.trim() : "";
        if (transition === "question_answered_resume") {
          const questionLink = event.questionLink ?? parseQuestionLink(event.payload);
          if (questionLink) {
            tracker.lastQuestionThreadId = questionLink.threadId;
            tracker.lastQuestionMessageId = questionLink.messageId;
          }
        }
      }
      tracker.lastPersistedAtMs = Math.max(tracker.lastPersistedAtMs, Math.floor(eventMs));
    }
  };

  const replayOpenQuestionsFromEventBus = () => {
    const runs = orchestratorService
      .listRuns({ limit: 1_000 })
      .filter((run) => run.status === "active" || run.status === "bootstrapping" || run.status === "queued" || run.status === "paused");
    for (const run of runs) {
      let graph: OrchestratorRunGraph;
      try {
        graph = orchestratorService.getRunGraph({ runId: run.id, timelineLimit: 0 });
      } catch {
        continue;
      }
      const mission = missionService.get(graph.run.missionId);
      if (!mission) continue;
      let events: ReturnType<typeof orchestratorService.listRuntimeEvents>;
      try {
        events = orchestratorService.listRuntimeEvents({
          runId: run.id,
          eventTypes: ["question", "intervention_resolved", "progress"],
          limit: STARTUP_OPEN_QUESTION_REPLAY_LIMIT
        });
      } catch {
        continue;
      }
      if (!events.length) continue;

      const stepById = new Map(graph.steps.map((step) => [step.id, step] as const));
      const attemptById = new Map(graph.attempts.map((attempt) => [attempt.id, attempt] as const));
      const latestByAttempt = new Map<string, (typeof events)[number]>();
      for (const event of events) {
        const attemptId = typeof event.attemptId === "string" ? event.attemptId.trim() : "";
        if (!attemptId.length || latestByAttempt.has(attemptId)) continue;
        if (event.eventType === "progress") {
          const payload = isRecord(event.payload) ? event.payload : null;
          const transition = typeof payload?.transition === "string" ? payload.transition.trim() : "";
          if (transition !== "question_answered_resume") continue;
        }
        latestByAttempt.set(attemptId, event);
      }

      for (const [attemptId, event] of latestByAttempt.entries()) {
        if (event.eventType !== "question") continue;
        const attempt = attemptById.get(attemptId);
        if (!attempt || attempt.status !== "running") continue;
        const step = stepById.get(attempt.stepId);
        if (!step) continue;
        const payload = isRecord(event.payload) ? event.payload : null;
        const questionLink =
          parseQuestionLink(payload) ??
          buildQuestionThreadLink({
            attemptId,
            occurredAt: event.occurredAt,
            preview: typeof payload?.preview === "string" ? payload.preview : null
          });
        const tracker = ensureAttemptRuntimeTracker(attemptId);
        tracker.lastQuestionThreadId = questionLink.threadId;
        tracker.lastQuestionMessageId = questionLink.messageId;
        upsertWorkerState(attemptId, {
          runId: run.id,
          stepId: step.id,
          sessionId: event.sessionId ?? attempt.executorSessionId ?? null,
          executorKind: attempt.executorKind,
          state: "waiting_input"
        });
        ensureManualInputIntervention({
          missionId: graph.run.missionId,
          runId: run.id,
          stepId: step.id,
          stepKey: step.stepKey,
          stepTitle: stepTitleForMessage(step),
          laneId: step.laneId ?? null,
          attemptId,
          sessionId: event.sessionId ?? attempt.executorSessionId ?? "session-unknown",
          preview: typeof payload?.preview === "string" ? payload.preview : null,
          questionLink,
          reason: "health_sweep"
        });
      }
    }
  };

  const updateAttemptStagnationTracker = (attemptId: string, preview: string | null) =>
    updateAttemptStagnationTrackerCtx(ctx, attemptId, preview);


  const ensureManualInputIntervention = (args: {
    missionId: string;
    runId: string;
    stepId: string;
    stepKey: string;
    stepTitle: string;
    laneId: string | null;
    attemptId: string;
    sessionId: string;
    preview: string | null;
    questionLink: OrchestratorRuntimeQuestionLink;
    reason: "runtime_signal" | "health_sweep";
  }) => {
    const mission = missionService.get(args.missionId);
    if (!mission) return;
    const existing = mission.interventions.find((entry) => {
      if (entry.status !== "open" || entry.interventionType !== "manual_input") return false;
      if (!isRecord(entry.metadata)) return false;
      return entry.metadata.attemptId === args.attemptId;
    });
    if (existing) return existing;
    const tracker = ensureAttemptRuntimeTracker(args.attemptId);
    const now = Date.now();
    if (
      args.reason !== "health_sweep" &&
      now - tracker.lastWaitingInterventionAtMs < WORKER_WAITING_INPUT_INTERVENTION_COOLDOWN_MS
    ) {
      return null;
    }
    tracker.lastWaitingInterventionAtMs = now;
    const preview = typeof args.preview === "string" && args.preview.trim().length
      ? args.preview.trim()
      : "Worker requested operator guidance.";
    const intervention = missionService.addIntervention({
      missionId: args.missionId,
      interventionType: "manual_input",
      title: `Worker waiting for input: ${args.stepTitle}`,
      body: `Step ${args.stepKey} is waiting for operator input. Latest signal: ${preview}`,
      requestedAction: "Provide steering instruction so execution can continue.",
      laneId: args.laneId,
      pauseMission: false,
      metadata: {
        attemptId: args.attemptId,
        stepId: args.stepId,
        runId: args.runId,
        sessionId: args.sessionId,
        canProceedWithoutAnswer: false,
        threadId: args.questionLink.threadId,
        messageId: args.questionLink.messageId,
        replyTo: args.questionLink.replyTo,
        reason: args.reason
      }
    });
    recordRuntimeEvent({
      runId: args.runId,
      stepId: args.stepId,
      attemptId: args.attemptId,
      sessionId: args.sessionId,
      eventType: "intervention_opened",
      eventKey: `intervention_opened:${intervention.id}`,
      payload: {
        interventionId: intervention.id,
        interventionType: intervention.interventionType,
        reason: args.reason,
        threadId: args.questionLink.threadId,
        messageId: args.questionLink.messageId,
        replyTo: args.questionLink.replyTo,
        preview
      }
    });
    emitOrchestratorMessage(
      args.missionId,
      `Step "${args.stepTitle}" is waiting for input. I opened an intervention so you can respond without babysitting terminals.`,
      args.stepKey,
      {
        interventionId: intervention.id,
        attemptId: args.attemptId,
        sessionId: args.sessionId
      }
    );
    return intervention;
  };

  const resolveStepTimeoutMs = (args: {
    runId: string;
    missionId: string;
    step: OrchestratorRunGraph["steps"][number];
  }): number => {
    const stepMeta = isRecord(args.step.metadata) ? args.step.metadata : {};
    const planStep = isRecord(stepMeta.planStep) ? stepMeta.planStep : null;
    const aiStepTimeout = Number(stepMeta.aiTimeoutMs);
    const explicitStepTimeout = Number(stepMeta.timeoutMs);
    const planStepTimeout = Number(planStep?.timeoutMs ?? NaN);
    const runtimeProfile = runRuntimeProfiles.get(args.runId) ?? resolveActiveRuntimeProfile(args.missionId);
    const fallback = runtimeProfile.execution.stepTimeoutMs;
    const raw =
      Number.isFinite(aiStepTimeout) && aiStepTimeout > 0
        ? aiStepTimeout
        : Number.isFinite(explicitStepTimeout) && explicitStepTimeout > 0
        ? explicitStepTimeout
        : Number.isFinite(planStepTimeout) && planStepTimeout > 0
          ? planStepTimeout
          : fallback;
    const floorMs = Math.max(30_000, Math.floor(raw));
    const capMs = resolveMissionDecisionTimeoutCapMs(args.missionId);
    return Math.max(30_000, Math.min(floorMs, capMs));
  };

  // Deterministic timeout/retry/priority/stagnation functions removed — the
  // coordinator AI handles these decisions through its persistent conversation.


  const getTrackedSessionState = (sessionId: string) => getTrackedSessionStateCtx(ctx, sessionId);

  const pruneSessionRuntimeSignals = () => pruneSessionRuntimeSignalsCtx(ctx);

  const listRunningAttemptsForSession = (sessionId: string) => listRunningAttemptsForSessionCtx(ctx, sessionId);

  const processSessionRuntimeSignal = async (signal: SessionRuntimeSignal): Promise<void> => {
    const sessionId = signal.sessionId.trim();
    if (!sessionId.length) return;

    const waitingForInput =
      signal.runtimeState === "waiting-input" || detectWaitingInputSignal(signal.lastOutputPreview);
    const runtimeWorkerState = workerStateFromRuntimeSignal({
      runtimeState: signal.runtimeState,
      waitingForInput
    });
    const isTerminalSignal = signal.runtimeState === "exited" || signal.runtimeState === "killed";
    const attempts = listRunningAttemptsForSession(sessionId);
    if (!attempts.length) return;

    const graphByRunId = new Map<string, OrchestratorRunGraph>();
    const syncedRunIds = new Set<string>();

    for (const attempt of attempts) {
      const tracker = ensureAttemptRuntimeTracker(attempt.attemptId);
      const nowMs = Date.now();
      const ownerId = resolveAttemptOwnerIdFromRows(attempt.attemptMetadataJson, attempt.runMetadataJson);
      if (nowMs - tracker.lastEventHeartbeatAtMs >= WORKER_EVENT_HEARTBEAT_INTERVAL_MS) {
        tracker.lastEventHeartbeatAtMs = nowMs;
        try {
          orchestratorService.heartbeatClaims({
            attemptId: attempt.attemptId,
            ownerId
          });
          recordRuntimeEvent({
            runId: attempt.runId,
            stepId: attempt.stepId,
            attemptId: attempt.attemptId,
            sessionId,
            eventType: "heartbeat",
            eventKey: `heartbeat:${attempt.attemptId}:${Math.floor(nowMs / WORKER_EVENT_HEARTBEAT_INTERVAL_MS)}`,
            occurredAt: signal.at,
            payload: {
              runtimeState: signal.runtimeState,
              ownerId
            }
          });
        } catch (error) {
          logger.debug("ai_orchestrator.runtime_signal_heartbeat_failed", {
            attemptId: attempt.attemptId,
            runId: attempt.runId,
            ownerId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      let graph = graphByRunId.get(attempt.runId);
      if (!graph) {
        try {
          graph = orchestratorService.getRunGraph({ runId: attempt.runId, timelineLimit: 0 });
          graphByRunId.set(attempt.runId, graph);
        } catch (error) {
          logger.debug("ai_orchestrator.runtime_signal_graph_lookup_failed", {
            sessionId,
            runId: attempt.runId,
            attemptId: attempt.attemptId,
            error: error instanceof Error ? error.message : String(error)
          });
          continue;
        }
      }

      const step = graph.steps.find((entry) => entry.id === attempt.stepId);
      if (!step) continue;

      updateAttemptStagnationTracker(attempt.attemptId, signal.lastOutputPreview);
      const previousWorkerState = workerStates.get(attempt.attemptId)?.state ?? null;
      const attemptMetadata = parseJsonRecord(attempt.attemptMetadataJson);
      const workerSessionKind = typeof attemptMetadata?.workerSessionKind === "string"
        ? attemptMetadata.workerSessionKind.trim()
        : "";
      const effectiveRuntimeWorkerState =
        workerSessionKind === "managed_chat"
        && !structuredChatSessions.has(sessionId)
        && runtimeWorkerState === "working"
          ? "initializing"
          : runtimeWorkerState;
      upsertWorkerState(attempt.attemptId, {
        runId: attempt.runId,
        stepId: attempt.stepId,
        sessionId,
        executorKind: attempt.executorKind,
        state: effectiveRuntimeWorkerState
      });
      if (attempt.executorKind !== "manual") {
        maybeDispatchTeammateIdleHook({
          runId: attempt.runId,
          stepId: attempt.stepId,
          attemptId: attempt.attemptId,
          sessionId,
          previousState: previousWorkerState,
          nextState: effectiveRuntimeWorkerState,
          reason: waitingForInput ? "waiting_input_signal" : "runtime_idle_signal",
          triggerSource: "runtime_signal",
          runtimeState: signal.runtimeState,
          preview: signal.lastOutputPreview,
          laneId: signal.laneId || step.laneId || null
        });
      }

      if (waitingForInput) {
        const questionLink = buildQuestionThreadLink({
          attemptId: attempt.attemptId,
          occurredAt: signal.at,
          preview: signal.lastOutputPreview
        });
        tracker.lastQuestionThreadId = questionLink.threadId;
        tracker.lastQuestionMessageId = questionLink.messageId;
        recordRuntimeEvent({
          runId: attempt.runId,
          stepId: attempt.stepId,
          attemptId: attempt.attemptId,
          sessionId,
          eventType: "question",
          eventKey: questionLink.messageId,
          occurredAt: signal.at,
          payload: {
            preview: signal.lastOutputPreview,
            runtimeState: signal.runtimeState,
            threadId: questionLink.threadId,
            messageId: questionLink.messageId,
            replyTo: questionLink.replyTo
          }
        });
        if (Date.now() - tracker.lastWaitingNotifiedAtMs >= 30_000) {
          tracker.lastWaitingNotifiedAtMs = Date.now();
          emitOrchestratorMessage(
            graph.run.missionId,
            `Step "${stepTitleForMessage(step)}" is waiting for input from the worker. I opened intervention tracking and will resume scheduling once guidance is provided.`,
            step.stepKey
          );
        }
        ensureManualInputIntervention({
          missionId: graph.run.missionId,
          runId: attempt.runId,
          stepId: step.id,
          stepKey: step.stepKey,
          stepTitle: stepTitleForMessage(step),
          laneId: step.laneId ?? signal.laneId ?? null,
          attemptId: attempt.attemptId,
          sessionId,
          preview: signal.lastOutputPreview,
          questionLink,
          reason: "runtime_signal"
        });
      } else if (signal.lastOutputPreview && signal.lastOutputPreview.trim().length > 0) {
        recordRuntimeEvent({
          runId: attempt.runId,
          stepId: attempt.stepId,
          attemptId: attempt.attemptId,
          sessionId,
          eventType: "progress",
          eventKey: `progress:${attempt.attemptId}:${digestSignalText(signal.lastOutputPreview) ?? "none"}:${Math.floor(Date.parse(signal.at) / 1000)}`,
          occurredAt: signal.at,
          payload: {
            preview: signal.lastOutputPreview,
            runtimeState: signal.runtimeState
          }
        });
        maybeEmitWorkerProgressChatUpdate({
          missionId: graph.run.missionId,
          runId: attempt.runId,
          step,
          attemptId: attempt.attemptId,
          sessionId,
          laneId: signal.laneId || step.laneId || null,
          preview: signal.lastOutputPreview,
        });
      }
      persistAttemptRuntimeState({
        attemptId: attempt.attemptId,
        sessionId,
        runtimeState: signal.runtimeState,
        lastSignalAt: signal.at,
        lastOutputPreview: signal.lastOutputPreview,
        force: waitingForInput || isTerminalSignal
      });
    }

    if (!isTerminalSignal) return;
    const sessionState = getTrackedSessionState(sessionId);
    if (!sessionState || sessionState.status === "running") return;
    for (const attempt of attempts) {
      recordRuntimeEvent({
        runId: attempt.runId,
        stepId: attempt.stepId,
        attemptId: attempt.attemptId,
        sessionId,
        eventType: "session_ended",
        eventKey: `session_ended_signal:${attempt.attemptId}:${sessionId}:${signal.runtimeState}:${signal.at}`,
        occurredAt: signal.at,
        payload: {
          runtimeState: signal.runtimeState,
          sessionStatus: sessionState.status,
          exitCode: sessionState.exitCode
        }
      });
    }
    let reconciled = 0;
    try {
      reconciled = await orchestratorService.onTrackedSessionEnded({
        sessionId,
        laneId: signal.laneId || sessionState.laneId,
        exitCode: sessionState.exitCode
      });
    } catch (error) {
      logger.debug("ai_orchestrator.runtime_signal_session_reconcile_failed", {
        sessionId,
        sessionStatus: sessionState.status,
        runtimeState: signal.runtimeState,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    if (reconciled <= 0) return;
    for (const attempt of attempts) {
      attemptRuntimeTrackers.delete(attempt.attemptId);
      deletePersistedAttemptRuntimeState(attempt.attemptId);
      if (syncedRunIds.has(attempt.runId)) continue;
      syncedRunIds.add(attempt.runId);
      void syncMissionFromRun(attempt.runId, "runtime_signal_session_end");
    }
  };

  const cleanupCoordinatorCheckpointFile = (runId: string, reason: string): void => {
    if (!projectRoot) return;
    void deleteCoordinatorCheckpoint(projectRoot, runId).catch((error) => {
      logger.debug("ai_orchestrator.coordinator_checkpoint_cleanup_failed", {
        runId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const emitMilestoneReadinessToCoordinator = (args: { runId: string; reason: string }): void => {
    let graph: OrchestratorRunGraph | null = null;
    try {
      graph = orchestratorService.getRunGraph({ runId: args.runId, timelineLimit: 0 });
    } catch {
      return;
    }
    if (!graph) return;

    const completedDependencyStatuses = new Set<OrchestratorStepStatus>([
      "succeeded",
      "skipped",
      "superseded",
      "canceled",
    ]);

    const readyMilestoneSignatureKeys = new Set<string>();
    const readyMilestones = graph.steps.filter((step) => {
      if (step.status !== "ready") return false;
      const stepMeta = isRecord(step.metadata) ? step.metadata : {};
      return asBool(stepMeta.isMilestone, false);
    });

    for (const step of readyMilestones) {
      const stepMeta = isRecord(step.metadata) ? step.metadata : {};
      const contract = isRecord(stepMeta.validationContract) ? stepMeta.validationContract : null;
      const validationCriteriaRaw =
        typeof contract?.criteria === "string"
          ? contract.criteria
          : typeof stepMeta.validationCriteria === "string"
            ? stepMeta.validationCriteria
            : typeof stepMeta.acceptanceCriteria === "string"
              ? stepMeta.acceptanceCriteria
              : "";
      const validationCriteria =
        validationCriteriaRaw.trim().length > 0
          ? validationCriteriaRaw.trim()
          : "No validation criteria documented in step metadata.";
      const dependencySteps = step.dependencyStepIds
        .map((dependencyStepId) => graph?.steps.find((candidate) => candidate.id === dependencyStepId))
        .filter((candidate): candidate is OrchestratorStep => Boolean(candidate));
      const dependenciesCompleted = dependencySteps.filter((dependencyStep) =>
        completedDependencyStatuses.has(dependencyStep.status)
      ).length;
      const dependencyTotal = dependencySteps.length;
      const signature = [
        step.updatedAt,
        dependenciesCompleted,
        dependencyTotal,
        validationCriteria,
      ].join("::");
      const milestoneKey = `${args.runId}::${step.id}`;
      readyMilestoneSignatureKeys.add(milestoneKey);
      if (milestoneReadyNotificationSignatures.get(milestoneKey) === signature) {
        continue;
      }
      milestoneReadyNotificationSignatures.set(milestoneKey, signature);

      const message = [
        `MILESTONE READY (GATED): "${stepTitleForMessage(step)}" (${step.stepKey})`,
        `Dependencies completed: ${dependenciesCompleted}/${dependencyTotal}`,
        `Validation criteria: ${validationCriteria}`,
        "Action required: spawn validator worker, then call report_validation.",
        "Downstream work stays gated until validation is reported.",
      ].join("\n");

      try {
        orchestratorService.appendRuntimeEvent({
          runId: args.runId,
          stepId: step.id,
          eventType: "progress",
          eventKey: `milestone_ready:${step.id}:${dependenciesCompleted}:${dependencyTotal}`,
          payload: {
            source: args.reason,
            milestoneReady: true,
            stepKey: step.stepKey,
            stepTitle: stepTitleForMessage(step),
            dependenciesCompleted,
            dependencyTotal,
            validationCriteria,
            requiredAction: "spawn_validator_and_report_validation",
            downstreamGated: true,
          },
        });
      } catch {
        // Non-fatal telemetry path.
      }

      const coordAgent = coordinatorAgents.get(args.runId);
      if (coordAgent?.isAlive) {
        coordAgent.injectEvent(
          {
            type: "orchestrator-step-updated",
            runId: args.runId,
            stepId: step.id,
            at: nowIso(),
            reason: "milestone_ready_validation_required",
          },
          message
        );
      }
    }

    for (const key of milestoneReadyNotificationSignatures.keys()) {
      if (!key.startsWith(`${args.runId}::`)) continue;
      if (!readyMilestoneSignatureKeys.has(key)) {
        milestoneReadyNotificationSignatures.delete(key);
      }
    }
  };

  const hasOpenBlockingInterventionForRun = (missionId: string, runId: string): boolean => {
    const mission = missionService.get(missionId);
    if (!mission) return false;
    return mission.status === "intervention_required"
      || mission.interventions.some((intervention) => {
        if (intervention.status !== "open") return false;
        const interventionRunId =
          typeof intervention.metadata?.runId === "string" ? intervention.metadata.runId.trim() : "";
        return interventionRunId.length === 0 || interventionRunId === runId;
      });
  };

  const startReadyAutopilotAttemptsWithMilestoneReadiness = async (args: {
    runId: string;
    reason: string;
  }): Promise<number> => {
    const run = orchestratorService.listRuns({ limit: 1_000 }).find((entry) => entry.id === args.runId) ?? null;
    if (!run) return 0;
    if (run.status !== "active" && run.status !== "bootstrapping" && run.status !== "queued") return 0;
    if (hasOpenBlockingInterventionForRun(run.missionId, run.id)) return 0;
    const coordinator = coordinatorAgents.get(args.runId);
    if (!coordinator?.isAlive) return 0;
    emitMilestoneReadinessToCoordinator({ runId: args.runId, reason: args.reason });
    return orchestratorService.startReadyAutopilotAttempts({ runId: args.runId, reason: args.reason });
  };

  const runHealthSweep = async (reason: string): Promise<{ sweeps: number; staleRecovered: number }> => {
    if (disposed) return { sweeps: 0, staleRecovered: 0 };
    const startedAtMs = Date.now();
    pruneSessionRuntimeSignals();

    // Prune expired call-type config cache entries
    for (const [key, entry] of callTypeConfigCache.entries()) {
      if (entry.expiresAt < startedAtMs) callTypeConfigCache.delete(key);
    }

    // Cap workerProgressChatState to prevent unbounded growth
    if (workerProgressChatState.size > 500) {
      const sorted = [...workerProgressChatState.entries()]
        .sort((a, b) => a[1].lastEmittedAtMs - b[1].lastEmittedAtMs);
      for (const [key] of sorted.slice(0, sorted.length - 250)) {
        workerProgressChatState.delete(key);
      }
    }
    const runs = orchestratorService
      .listRuns({ limit: HEALTH_SWEEP_ACTIVE_RUN_SCAN_LIMIT })
      .filter((run) => run.status === "active" || run.status === "bootstrapping" || run.status === "queued");
    let sweeps = 0;
    let staleRecovered = 0;
    let skippedBlockedRuns = 0;

    for (const run of runs) {
      if (disposed) break;
      if ((reason === "interval" || reason === "startup") && hasOpenBlockingInterventionForRun(run.missionId, run.id)) {
        skippedBlockedRuns += 1;
        continue;
      }
      if (activeHealthSweepRuns.has(run.id)) {
        // Interval/startup sweeps are opportunistic; manual/chat/status sweeps should wait briefly
        // so explicit health checks don't get dropped due to an in-flight background sweep.
        if (reason === "interval" || reason === "startup") continue;
        const deadline = Date.now() + 3_000;
        while (activeHealthSweepRuns.has(run.id) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (activeHealthSweepRuns.has(run.id)) continue;
      }
      activeHealthSweepRuns.add(run.id);
      try {
        if (disposed) break;
        sweeps += 1;
        orchestratorService.tick({ runId: run.id });
        const graph = orchestratorService.getRunGraph({ runId: run.id, timelineLimit: 0 });
        const stepById = new Map(graph.steps.map((step) => [step.id, step] as const));

        for (const attempt of graph.attempts.filter((entry) => entry.status === "running")) {
          const step = stepById.get(attempt.stepId);
          if (!step) continue;
          if (attempt.executorKind === "manual") continue;

          const sessionId = typeof attempt.executorSessionId === "string" ? attempt.executorSessionId.trim() : "";
          const sessionSignal = sessionId.length > 0 ? sessionRuntimeSignals.get(sessionId) ?? null : null;
          const sessionState = sessionId.length > 0 ? getTrackedSessionState(sessionId) : null;
          if (sessionId.length > 0) {
            if (sessionState && sessionState.status && sessionState.status !== "running") {
              const endedAtMs = sessionState.endedAt ? Date.parse(sessionState.endedAt) : Number.NaN;
              const endedRecently = Number.isFinite(endedAtMs) && Date.now() - endedAtMs < STALE_ATTEMPT_GRACE_MS;
              if (!endedRecently) {
                try {
                  const reconciled = await orchestratorService.onTrackedSessionEnded({
                    sessionId,
                    laneId: sessionState.laneId,
                    exitCode: sessionState.exitCode
                  });
                  if (reconciled > 0) {
                    staleRecovered += reconciled;
                    attemptRuntimeTrackers.delete(attempt.id);
                    deletePersistedAttemptRuntimeState(attempt.id);
                    emitOrchestratorMessage(
                      graph.run.missionId,
                      `Step "${stepTitleForMessage(step)}" session ended (${sessionState.status}${sessionState.exitCode == null ? "" : ` exit ${sessionState.exitCode}`}). Reconciled attempt state and advanced scheduling.`,
                      step.stepKey
                    );
                    continue;
                  }
                } catch (error) {
                  logger.debug("ai_orchestrator.health_sweep_session_reconcile_failed", {
                    runId: run.id,
                    attemptId: attempt.id,
                    sessionId,
                    sessionStatus: sessionState.status,
                    error: error instanceof Error ? error.message : String(error)
                  });
                }
              }
            }
          }

          const ownerId = resolveAttemptOwnerId(graph.run, attempt);
          try {
            orchestratorService.heartbeatClaims({
              attemptId: attempt.id,
              ownerId
            });
            recordRuntimeEvent({
              runId: run.id,
              stepId: step.id,
              attemptId: attempt.id,
              sessionId: sessionId.length > 0 ? sessionId : null,
              eventType: "heartbeat",
              eventKey: `sweep_heartbeat:${attempt.id}:${Math.floor(Date.now() / WORKER_EVENT_HEARTBEAT_INTERVAL_MS)}`,
              payload: {
                source: "health_sweep",
                ownerId
              }
            });
          } catch (error) {
            logger.debug("ai_orchestrator.health_sweep_heartbeat_failed", {
              runId: run.id,
              attemptId: attempt.id,
              ownerId,
              error: error instanceof Error ? error.message : String(error)
            });
          }

          const previewFromSignals = typeof sessionSignal?.lastOutputPreview === "string" ? sessionSignal.lastOutputPreview : null;
          const previewFromSession = typeof sessionState?.lastOutputPreview === "string" ? sessionState.lastOutputPreview : null;
          const effectivePreview = previewFromSignals ?? previewFromSession;
          const runtimeWaiting = sessionSignal?.runtimeState === "waiting-input";
          const textWaiting = detectWaitingInputSignal(effectivePreview);
          const waitingForInput = runtimeWaiting || textWaiting;
          const idleLikeState =
            sessionSignal?.runtimeState === "idle"
            || sessionState?.status === "idle"
            || sessionState?.status === "waiting-input";
          const runtimeStateForWorker: TerminalRuntimeState = waitingForInput
            ? "waiting-input"
            : idleLikeState
              ? "idle"
              : "running";
          const nextWorkerState = workerStateFromRuntimeSignal({
            runtimeState: runtimeStateForWorker,
            waitingForInput
          });
          const attemptMetadata = asRecord(attempt.metadata);
          const workerSessionKind = typeof attemptMetadata?.workerSessionKind === "string"
            ? attemptMetadata.workerSessionKind.trim()
            : "";
          const effectiveNextWorkerState =
            workerSessionKind === "managed_chat"
            && attempt.executorSessionId
            && !structuredChatSessions.has(attempt.executorSessionId)
            && nextWorkerState === "working"
              ? "initializing"
              : nextWorkerState;
          const stagnationSnapshot = updateAttemptStagnationTracker(attempt.id, effectivePreview);

          const previousWorkerState = workerStates.get(attempt.id)?.state ?? null;
          upsertWorkerState(attempt.id, {
            runId: run.id,
            stepId: step.id,
            sessionId: attempt.executorSessionId,
            executorKind: attempt.executorKind,
            state: effectiveNextWorkerState
          });
          maybeDispatchTeammateIdleHook({
            runId: run.id,
            stepId: step.id,
            attemptId: attempt.id,
            sessionId: attempt.executorSessionId ?? null,
            previousState: previousWorkerState,
            nextState: effectiveNextWorkerState,
            reason: waitingForInput ? "waiting_input_sweep" : "idle_like_sweep",
            triggerSource: "health_sweep",
            runtimeState: sessionSignal?.runtimeState ?? runtimeStateForWorker,
            preview: effectivePreview,
            laneId: step.laneId ?? null
          });

          if (waitingForInput && sessionId.length > 0) {
            const questionLink = buildQuestionThreadLink({
              attemptId: attempt.id,
              occurredAt: sessionSignal?.at ?? nowIso(),
              preview: effectivePreview
            });
            const tracker = ensureAttemptRuntimeTracker(attempt.id);
            tracker.lastQuestionThreadId = questionLink.threadId;
            tracker.lastQuestionMessageId = questionLink.messageId;
            recordRuntimeEvent({
              runId: run.id,
              stepId: step.id,
              attemptId: attempt.id,
              sessionId,
              eventType: "question",
              eventKey: questionLink.messageId,
              payload: {
                source: "health_sweep",
                preview: effectivePreview,
                threadId: questionLink.threadId,
                messageId: questionLink.messageId,
                replyTo: questionLink.replyTo
              }
            });
            const now = Date.now();
            if (now - tracker.lastWaitingNotifiedAtMs >= 30_000) {
              tracker.lastWaitingNotifiedAtMs = now;
              emitOrchestratorMessage(
                graph.run.missionId,
                `Step "${stepTitleForMessage(step)}" is waiting for input from the worker. I am monitoring and will keep scheduling once guidance is provided.`,
                step.stepKey
              );
            }
            ensureManualInputIntervention({
              missionId: graph.run.missionId,
              runId: run.id,
              stepId: step.id,
              stepKey: step.stepKey,
              stepTitle: stepTitleForMessage(step),
              laneId: step.laneId ?? null,
              attemptId: attempt.id,
              sessionId,
              preview: effectivePreview,
              questionLink,
              reason: "health_sweep"
            });
            persistAttemptRuntimeState({
              attemptId: attempt.id,
              sessionId,
              runtimeState: "waiting-input",
              lastSignalAt: sessionSignal?.at ?? nowIso(),
              lastOutputPreview: effectivePreview,
              force: true
            });
            continue;
          }

          persistAttemptRuntimeState({
            attemptId: attempt.id,
            sessionId: sessionId.length > 0 ? sessionId : null,
            runtimeState: sessionSignal?.runtimeState ?? null,
            lastSignalAt: sessionSignal?.at ?? sessionState?.lastOutputAt ?? null,
            lastOutputPreview: effectivePreview,
            force: false
          });

          const startedAt = attempt.startedAt ?? attempt.createdAt;
          const startedMs = Date.parse(startedAt);
          if (!Number.isFinite(startedMs)) continue;
          const elapsedMs = Date.now() - startedMs;
          const timeoutMs = resolveStepTimeoutMs({
            runId: run.id,
            missionId: graph.run.missionId,
            step
          });
          if (elapsedMs <= timeoutMs + STALE_ATTEMPT_GRACE_MS) continue;

          const activityCandidates = [sessionSignal?.at ?? null, sessionState?.lastOutputAt ?? null]
            .map((value) => (value ? Date.parse(value) : Number.NaN))
            .filter((value) => Number.isFinite(value));
          const lastActivityMs = activityCandidates.length > 0 ? Math.max(...activityCandidates) : Number.NaN;
          const hasRecentSessionActivity =
            Number.isFinite(lastActivityMs) && Date.now() - lastActivityMs <= STALE_ATTEMPT_GRACE_MS;
          const hasRecentPreviewActivity =
            stagnationSnapshot.digest != null && stagnationSnapshot.stagnantMs < STALE_ATTEMPT_GRACE_MS;
          if (hasRecentSessionActivity || hasRecentPreviewActivity) {
            continue;
          }

          // Attempt exceeded timeout and has no recent activity. Notify the coordinator,
          // then enforce a deterministic guardrail so attempts cannot run forever.
          const elapsedMinutes = Math.max(1, Math.round(elapsedMs / 60_000));
          const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60_000));
          const stagnantMs = stagnationSnapshot.stagnantMs;
          const stagnantMinutes = Math.max(1, Math.round(stagnantMs / 60_000));
          const coordAgent = coordinatorAgents.get(run.id);
          const staleMessage = [
            `STALE ATTEMPT DETECTED: Step "${stepTitleForMessage(step)}" (${step.stepKey}) has exceeded its timeout.`,
            `Elapsed: ${elapsedMinutes}m, Timeout: ${timeoutMinutes}m, No progress for: ${stagnantMinutes}m.`,
            `Retry count: ${step.retryCount}/${step.retryLimit}.`,
            `Attempt ID: ${attempt.id}. Step ID: ${step.id}.`,
            `Attempt has been failed by timeout guardrail; decide recovery (retry/skip/workaround).`,
          ].join("\n");
          recordRuntimeEvent({
            runId: run.id,
            stepId: step.id,
            attemptId: attempt.id,
            sessionId: sessionId.length > 0 ? sessionId : null,
            eventType: "progress",
            eventKey: `stale:${attempt.id}:${Math.floor(Date.now() / 60_000)}`,
            payload: {
              staleAttempt: true,
              elapsedMs,
              timeoutMs,
              stagnantMs,
              stepTitle: stepTitleForMessage(step),
              stepKey: step.stepKey,
            }
          });
          if (coordAgent?.isAlive) {
            try {
              coordAgent.injectMessage(staleMessage);
            } catch (error) {
              logger.debug("ai_orchestrator.health_sweep_stale_notify_failed", {
                runId: run.id,
                attemptId: attempt.id,
                error: error instanceof Error ? error.message : String(error)
              });
            }
          }

          const errorMessage = `Attempt stagnating after timeout (${elapsedMinutes}m > ${timeoutMinutes}m) with ${stagnantMinutes}m no progress.`;
          try {
            await orchestratorService.completeAttempt({
              attemptId: attempt.id,
              status: "failed",
              errorClass: "transient",
              errorMessage,
              metadata: {
                watchdogReason: reason,
                watchdogRecoveredAt: nowIso(),
                watchdogTimeoutMs: timeoutMs,
                watchdogElapsedMs: elapsedMs,
                watchdogStagnantMs: stagnantMs,
                ownerId,
                coordinatorNotified: Boolean(coordAgent?.isAlive)
              }
            });
            staleRecovered += 1;
            emitOrchestratorMessage(
              graph.run.missionId,
              `Step "${stepTitleForMessage(step)}" exceeded timeout (${elapsedMinutes}m) and was marked failed by watchdog.`,
              step.stepKey
            );
          } catch (error) {
            logger.debug("ai_orchestrator.health_sweep_complete_failed", {
              runId: run.id,
              attemptId: attempt.id,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }

        const runMeta = isRecord(graph.run.metadata) ? graph.run.metadata : {};
        const autopilot = isRecord(runMeta.autopilot) ? runMeta.autopilot : null;
        const autopilotEnabled = autopilot?.enabled === true;
        if (autopilotEnabled) {
          await startReadyAutopilotAttemptsWithMilestoneReadiness({
            runId: run.id,
            reason: staleRecovered > 0 ? "health_sweep_recovered" : "health_sweep_tick"
          });
        } else {
          orchestratorService.tick({ runId: run.id });
        }
        void syncMissionFromRun(run.id, `health_sweep:${reason}`);
      } catch (error) {
        logger.debug("ai_orchestrator.health_sweep_failed", {
          runId: run.id,
          reason,
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        activeHealthSweepRuns.delete(run.id);
      }
    }

    await replayQueuedWorkerMessages({
      reason: `health_sweep:${reason}`
    });

    logger.debug("ai_orchestrator.health_sweep_summary", {
      reason,
      sweeps,
      staleRecovered,
      skippedBlockedRuns,
      activeRunCount: runs.length,
      durationMs: Date.now() - startedAtMs,
    });

    return { sweeps, staleRecovered };
  };

  // Deterministic retry decision removed — coordinator AI handles retry decisions

  const buildWorkerDigestFromAttempt = (args: Parameters<typeof buildWorkerDigestFromAttemptCtx>[0]) =>
    buildWorkerDigestFromAttemptCtx(args);

  const updateWorkerStateFromEvent = (event: OrchestratorRuntimeEvent) =>
    updateWorkerStateFromEventCtx(ctx, event, {
      recordRuntimeEvent,
      evaluateWorkerPlan,
      propagateHandoffContext,
      steerMission,
      handleInterventionWithAI,
      appendChatMessage,
    });

  const summarizeRunForChat = (missionId: string): string => summarizeRunForChatCtx(ctx, missionId);

  const resolveChatProvider = (missionId: string): "claude" | "codex" | null => {
    const existingSession = activeChatSessions.get(missionId) ?? loadChatSessionStateFromMetadata(missionId);
    if (existingSession) {
      return existingSession.provider;
    }

    const runs = orchestratorService.listRuns({ missionId });
    const activeRun = runs.find((entry) => entry.status === "active" || entry.status === "bootstrapping" || entry.status === "queued" || entry.status === "paused");
    if (activeRun) {
      try {
        const graph = orchestratorService.getRunGraph({ runId: activeRun.id, timelineLimit: 0 });
        const runningAttempt = graph.attempts
          .filter((attempt) => attempt.status === "running")
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
        if (runningAttempt) {
          const rawMeta = isRecord((runningAttempt as any).metadata) ? ((runningAttempt as any).metadata as Record<string, unknown>) : null;
          const attemptModel = typeof rawMeta?.model === "string"
            ? rawMeta.model
            : typeof rawMeta?.modelId === "string"
              ? rawMeta.modelId
              : null;
          if (attemptModel) {
            const desc = getModelById(attemptModel);
            if (desc?.family === "openai") return "codex";
            if (desc?.family === "anthropic") return "claude";
          }
        }
      } catch {
        // ignore
      }
    }

    const config = readConfig(projectConfigService);
    if (config.defaultOrchestratorModelId === "claude" || config.defaultOrchestratorModelId === "codex") {
      return config.defaultOrchestratorModelId as "claude" | "codex";
    }
    if (config.defaultOrchestratorModelId) {
      const desc = getModelById(config.defaultOrchestratorModelId);
      if (desc?.family === "anthropic") return "claude";
      if (desc?.family === "openai") return "codex";
    }
    const availability = aiIntegrationService?.getAvailability?.();
    if (availability?.claude) return "claude";
    if (availability?.codex) return "codex";
    return null;
  };

  const resolveMissionProjectId = (missionId: string): string => {
    const row = db.get<{ project_id: string | null }>(
      `select project_id from missions where id = ? limit 1`,
      [missionId]
    );
    return row?.project_id ? String(row.project_id).trim() : "";
  };

  // persistDiscoveredDocPathsToMemory removed — doc paths are available via
  // the context system and writing them as facts created near-duplicate entries
  // on every mission run.

  const buildProjectMemoryHighlights = (missionId: string): string[] => {
    const missionProjectId = resolveMissionProjectId(missionId);
    if (!missionProjectId.length) return [];
    try {
      return plannerMemoryService
        .getMemoryBudget(missionProjectId, "standard", { includeCandidates: true })
        .map((memory) => {
          const category = String(memory.category ?? "fact").trim() || "fact";
          const content = String(memory.content ?? "").replace(/\s+/g, " ").trim();
          if (!content.length) return "";
          return `[${category}] ${content.length > 240 ? `${content.slice(0, 237).trimEnd()}...` : content}`;
        })
        .filter(Boolean)
        .slice(0, 12);
    } catch {
      return [];
    }
  };

  const MISSION_LAUNCH_FAILURE_REASON_CODE = "mission_launch_failed";

  const describeMissionLaunchStage = (stage: MissionLaunchFailureStage): string => {
    switch (stage) {
      case "run_created":
        return "run initialization";
      case "memory_init":
        return "mission memory initialization";
      case "lane_create":
        return "mission lane creation";
      case "coordinator_start":
        return "coordinator startup";
      case "run_activate":
        return "run activation";
      default:
        return stage;
    }
  };

  const clipErrorStack = (error: unknown, maxChars = 4_000): string | null => {
    const stack = error instanceof Error && typeof error.stack === "string" ? error.stack.trim() : "";
    if (!stack.length) return null;
    return stack.length > maxChars ? `${stack.slice(0, maxChars - 3)}...` : stack;
  };

  const buildMissionLaunchFailureMetadata = (args: {
    runId: string;
    failureStage: MissionLaunchFailureStage;
    error: unknown;
  }): Record<string, unknown> => {
    const rootError = getErrorMessage(args.error);
    const rootErrorStack = clipErrorStack(args.error);
    return {
      runId: args.runId,
      reasonCode: MISSION_LAUNCH_FAILURE_REASON_CODE,
      failureStage: args.failureStage,
      failureStageLabel: describeMissionLaunchStage(args.failureStage),
      rootError,
      ...(rootErrorStack ? { rootErrorStack } : {}),
      coordinatorState: args.failureStage === "coordinator_start" ? "starting" : "not_started",
      launchFailureBeforeCoordinator: args.failureStage !== "run_activate",
    };
  };

  const isMissionLaunchFailureMetadata = (metadata: Record<string, unknown> | null | undefined, runId?: string | null): boolean => {
    const reasonCode = typeof metadata?.reasonCode === "string" ? metadata.reasonCode.trim() : "";
    if (reasonCode !== MISSION_LAUNCH_FAILURE_REASON_CODE) return false;
    if (!runId) return true;
    const metadataRunId = typeof metadata?.runId === "string" ? metadata.runId.trim() : "";
    return metadataRunId.length === 0 || metadataRunId === runId;
  };

  const hasOpenMissionLaunchFailureIntervention = (args: { missionId: string; runId: string }): boolean => {
    const mission = missionService.get(args.missionId);
    if (!mission) return false;
    return mission.interventions.some((entry) => {
      if (entry.status !== "open") return false;
      return isMissionLaunchFailureMetadata(isRecord(entry.metadata) ? entry.metadata : null, args.runId);
    });
  };

  const getRunLaunchFailureMetadata = (runId: string): Record<string, unknown> | null => {
    const metadata = getRunMetadata(runId);
    const launchFailure = isRecord(metadata.launchFailure) ? metadata.launchFailure : null;
    return isMissionLaunchFailureMetadata(launchFailure, runId) ? launchFailure : null;
  };

  const persistRunLaunchFailureMetadata = (runId: string, metadata: Record<string, unknown>): void => {
    updateRunMetadata(runId, (runMetadata) => {
      runMetadata.launchFailure = {
        ...(isRecord(runMetadata.launchFailure) ? runMetadata.launchFailure : {}),
        ...metadata,
        updatedAt: nowIso(),
      };
    });
  };

  const toMissionLaunchFailureBody = (args: {
    failureStage: MissionLaunchFailureStage;
    error: unknown;
  }): string => {
    return `ADE could not finish mission launch during ${describeMissionLaunchStage(args.failureStage)}.\n\n${getErrorMessage(args.error)}`;
  };

  const toMissionLaunchFailureError = (error: unknown, metadata: Record<string, unknown>): Error => {
    const base = error instanceof Error ? error : new Error(getErrorMessage(error));
    Object.assign(base, {
      missionLaunchFailure: metadata,
    });
    return base;
  };

  // ── Team Runtime Manager ─────────────────────────────────────
  // Spawns and manages coordinator + teammates for a run.

  const getTeamMembersForRun = (runId: string): OrchestratorTeamMember[] =>
    getTeamMembersForRunCtx(ctx, runId);

  const updateTeamRuntimePhase = (runId: string, phase: OrchestratorTeamRuntimeState["phase"], extra?: Parameters<typeof updateTeamRuntimePhaseCtx>[3]): void =>
    updateTeamRuntimePhaseCtx(ctx, runId, phase, extra);

  const getTeamRuntimeStateForRun = (runId: string): OrchestratorTeamRuntimeState | null =>
    getTeamRuntimeStateForRunCtx(ctx, runId);

  /**
   * Finalize a run — the coordinator calls this when it believes the mission is complete.
   * Validates that all tasks are done, no running attempts remain, and no blockers exist.
   */
  const finalizeRun = (finalizeArgs: FinalizeRunArgs): FinalizeRunResult => {
    const { runId } = finalizeArgs;
    const graph = orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
    const missionId = graph.run.missionId;

    // The act of calling finalizeRun IS the completion request
    updateTeamRuntimePhase(runId, "executing", { completionRequested: true });
    const finalized = orchestratorService.finalizeRun(finalizeArgs);
    if (!finalized.finalized) {
      updateTeamRuntimePhase(runId, "executing", {
        completionRequested: true,
        completionValidated: false,
        lastValidationError: finalized.blockers.join("; ") || null,
      });
      return finalized;
    }

    const finalStatus = finalized.finalStatus;
    const ts = nowIso();
    updateTeamRuntimePhase(runId, "done", {
      completionRequested: true,
      completionValidated: true,
      lastValidationError: null,
    });

    const keepCoordinatorOnline = finalStatus === "succeeded";
    if (!keepCoordinatorOnline) {
      endCoordinatorAgentV2(runId);
      cleanupCoordinatorCheckpointFile(runId, "finalize_run");
    } else {
      setCoordinatorAvailability(runId, {
        available: true,
        mode: "consult_only",
        summary: "Mission execution is complete. The coordinator remains available for follow-up questions and continuation requests.",
        detail: "Post-completion messages stay in consult mode. New implementation work should create an explicit continuation.",
        updatedAt: ts,
      }, { graph });
    }
    const finalGraph = orchestratorService.getRunGraph({ runId, timelineLimit: 0 });

    const buildRecoveryHandoffPayload = () => {
      const doneSteps = finalGraph.steps
        .filter((step) => step.status === "succeeded" || step.status === "skipped" || step.status === "superseded" || step.status === "canceled")
        .map((step) => ({
          stepId: step.id,
          stepKey: step.stepKey,
          title: step.title,
          status: step.status,
          laneId: step.laneId
        }));
      const remainingSteps = finalGraph.steps
        .filter((step) => step.status !== "succeeded" && step.status !== "skipped" && step.status !== "superseded" && step.status !== "canceled")
        .map((step) => ({
          stepId: step.id,
          stepKey: step.stepKey,
          title: step.title,
          status: step.status,
          laneId: step.laneId
        }));
      const laneMap = finalGraph.steps.reduce<Record<string, string[]>>((acc, step) => {
        const laneKey = step.laneId ?? "unassigned";
        const list = acc[laneKey] ?? [];
        list.push(step.stepKey);
        acc[laneKey] = list;
        return acc;
      }, {});
      const validations = finalGraph.runtimeEvents
        ?.filter((event) => event.eventType === "validation_report")
        .slice(-25)
        .map((event) => ({
          stepId: event.stepId,
          attemptId: event.attemptId,
          verdict: isRecord(event.payload) && typeof event.payload.verdict === "string" ? event.payload.verdict : "unknown",
          summary: isRecord(event.payload) && typeof event.payload.summary === "string" ? event.payload.summary : null,
          occurredAt: event.occurredAt
        })) ?? [];
      return {
        schema: "ade.recoveryHandoff.v1",
        runId,
        missionId,
        finalStatus,
        generatedAt: ts,
        doneSteps,
        remainingSteps,
        laneMap,
        completedValidations: validations
      };
    };

    const persistRecoveryHandoff = (handoffType: "recovery_handoff") => {
      const payload = buildRecoveryHandoffPayload();
      try {
        orchestratorService.createHandoff({
          missionId,
          runId,
          handoffType,
          producer: "coordinator",
          payload
        });
      } catch (error) {
        logger.debug("ai_orchestrator.recovery_handoff_persist_failed", {
          runId,
          missionId,
          handoffType,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return payload;
    };

    // Transition mission status
    if (finalStatus !== "succeeded") {
      persistRecoveryHandoff("recovery_handoff");
      transitionMissionStatus(missionId, "failed");
    }

    const retrospective = (() => {
      try {
        return orchestratorService.generateRunRetrospective({ runId });
      } catch (error) {
        logger.debug("ai_orchestrator.retrospective_generation_failed", {
          runId,
          missionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })();

    if (retrospective && projectRoot) {
      const missionForState = missionService.get(missionId);
      void updateMissionStateDocument({
        projectRoot,
        missionId,
        runId,
        goal: missionForState?.prompt || missionForState?.title || "Mission run",
        patch: {
          reflections: orchestratorService.listReflections({ runId, limit: 200 }),
          latestRetrospective: retrospective,
        },
      }).catch((error) => {
        logger.debug("ai_orchestrator.retrospective_mission_state_sync_failed", {
          runId,
          missionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    logger.info("ai_orchestrator.run_finalized", {
      runId,
      missionId,
      finalStatus,
      blockerCount: finalized.blockers.length,
      retrospectiveGenerated: Boolean(retrospective)
    });

    bestEffortCascadeCleanup(missionId, runId, "run_finalize");

    return finalized;
  };

  /**
   * Resume active team runtimes after app restart.
   * Checks for runs in "active" or "bootstrapping" status with coordinator sessions.
   */
  const resumeActiveTeamRuntimes = (): void => {
    void (async () => {
      if (!hasRecoverableRuntimeWork()) return;
      try {
        const pageSize = 100;
        let offset = 0;
        while (true) {
          const activeRuns = db.all<{ id: string; mission_id: string; status: string; metadata_json: string | null }>(
            `select id, mission_id, status, metadata_json
               from orchestrator_runs
              where status in ('active', 'bootstrapping', 'queued')
              order by created_at desc, id desc
              limit ? OFFSET ?`,
            [pageSize, offset]
          );
          if (!activeRuns.length) break;
          for (const run of activeRuns) {
          const runtimeState = getTeamRuntimeStateForRun(run.id);
          if (!runtimeState || runtimeState.phase === "done" || runtimeState.phase === "failed") continue;

          const mission = missionService.get(run.mission_id);
          if (!mission) continue;

          const preResumeGraph = (() => {
            try {
              return orchestratorService.getRunGraph({ runId: run.id, timelineLimit: 0 });
            } catch {
              return null;
            }
          })();
          const orphanedRunningAttempts = preResumeGraph?.attempts.filter((attempt) => attempt.status === "running") ?? [];
          try {
            orchestratorService.resumeRun({ runId: run.id });
          } catch (error) {
            logger.debug("ai_orchestrator.team_runtime_resume_run_failed", {
              runId: run.id,
              missionId: run.mission_id,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          const [stateDoc, checkpoint]: [MissionStateDocument | null, Awaited<ReturnType<typeof readCoordinatorCheckpoint>>] = projectRoot
            ? await Promise.all([
                readMissionStateDocument({ projectRoot, runId: run.id }),
                readCoordinatorCheckpoint(projectRoot, run.id),
              ])
            : [null, null];

          const coordinatorModelConfig = resolveOrchestratorModelConfig(run.mission_id, "coordinator");
          const missionGoal = mission.prompt || mission.title;
          const resumeMissionLaneId = resolvePersistedMissionLaneIdForRun(run.id);
          if (resumeMissionLaneId) {
            persistMissionLaneIdForRun(run.id, resumeMissionLaneId);
          }
          const { userRules, projectCtx, availableProviders, phases } = gatherCoordinatorContext(run.mission_id, { missionId: run.mission_id });
          const agent = startCoordinatorAgentV2(run.mission_id, run.id, missionGoal, coordinatorModelConfig, {
            userRules,
            projectContext: projectCtx,
            availableProviders,
            phases,
            skipInitialActivationMessage: true,
            missionLaneId: resumeMissionLaneId ?? undefined,
          });

          if (agent) {
            const truncate = (value: string, max: number): string =>
              value.length > max ? `${value.slice(0, max)}\n[truncated]` : value;
            const serializedStateDoc = stateDoc
              ? truncate(JSON.stringify(stateDoc, null, 2), 20_000)
              : '{"note":"Mission state document unavailable."}';
            const checkpointSummary = checkpoint
              ? [
                  `savedAt=${checkpoint.savedAt}`,
                  `turnCount=${checkpoint.turnCount}`,
                  `compactionCount=${checkpoint.compactionCount}`,
                  `lastEventTimestamp=${checkpoint.lastEventTimestamp ?? "unknown"}`,
                  "",
                  truncate(checkpoint.conversationSummary || "No summary saved.", 8_000),
                ].join("\n")
              : "No checkpoint file found for this run.";
            const recoveredAttemptsSummary = orphanedRunningAttempts.length
              ? orphanedRunningAttempts
                  .slice(0, 12)
                  .map((attempt) => {
                    const step = preResumeGraph?.steps.find((candidate) => candidate.id === attempt.stepId);
                    const stepLabel = step ? `${step.stepKey} (${stepTitleForMessage(step)})` : attempt.stepId;
                    return `- ${stepLabel} / attempt ${attempt.attemptNumber} (${attempt.id})`;
                  })
                  .join("\n")
              : "- none";
            agent.injectMessage(
              [
                "[RESUME RECOVERY]",
                "App restart detected. Any orphaned running attempts were failed with errorClass 'resume_recovered' because worker sessions were lost.",
                `Recovered attempts: ${orphanedRunningAttempts.length}`,
                recoveredAttemptsSummary,
                "",
                "Authoritative mission state document:",
                "```json",
                serializedStateDoc,
                "```",
                "",
                "Coordinator checkpoint summary:",
                checkpointSummary,
                "",
                "Recovery instructions:",
                "1. Call read_mission_status immediately to refresh current DAG truth.",
                "2. Treat the mission state document above as the authoritative structured context.",
                "3. Review steps affected by resume_recovered and decide retry/skip/workaround.",
                "4. For milestone-ready gates, spawn validator workers and call report_validation before marking complete.",
                "5. Continue execution from the current DAG state; do not redo completed work.",
              ].join("\n")
            );
            emitMilestoneReadinessToCoordinator({ runId: run.id, reason: "resume_active_team_runtimes" });
            logger.info("ai_orchestrator.team_runtime_resumed", {
              runId: run.id,
              missionId: run.mission_id,
              phase: runtimeState.phase,
              recoveredOrphanedAttempts: orphanedRunningAttempts.length,
              hasMissionStateDoc: Boolean(stateDoc),
              hasCheckpoint: Boolean(checkpoint),
            });
          }
        }
          if (activeRuns.length < pageSize) break;
          offset += activeRuns.length;
        }
      } catch (error) {
        logger.debug("ai_orchestrator.team_runtime_resume_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  };

  // Communication routing: user messages to coordinator thread get injected
  // into the coordinator agent directly instead of going through the old
  // text-command parser.
  const routeUserMessageToCoordinator = (
    _missionId: string,
    runId: string,
    content: string,
    mode: "conversation" | "instruction" = "conversation",
  ): boolean => {
    const coordAgent = coordinatorAgents.get(runId);
    if (!coordAgent?.isAlive) return false;
    const header = mode === "instruction" ? "[USER INSTRUCTION]" : "[USER CHAT]";
    const guidance =
      mode === "instruction"
        ? "Respond to the human in plain language. Their intent has already been recorded as mission steering when applicable. Do not forward their raw words to workers."
        : "Answer the human directly in plain language. Do not treat this as worker steering unless they explicitly ask for an operational change.";
    coordAgent.injectMessage(`${header}\n${guidance}\n\n${content}`);
    return true;
  };


  const respondToChatWithAI = async (
    chatArgs: SendOrchestratorChatArgs,
    _precomputedRecentChatContext?: string
  ): Promise<void> => {
    const mission = missionService.get(chatArgs.missionId);
    if (!mission) return;

    const latestUserMessage = clipTextForContext(chatArgs.content, MAX_LATEST_CHAT_MESSAGE_CHARS);
    const metadata = isRecord(chatArgs.metadata) ? chatArgs.metadata : null;
    const chatMode = metadata?.coordinatorChatMode === "instruction" ? "instruction" : "conversation";

    // Route user messages directly to the coordinator agent (tool-based)
    const runs = orchestratorService.listRuns({ missionId: chatArgs.missionId });
    const latestRun = runs[0] ?? null;
    const activeRun = runs.find((r) => r.status === "active" || r.status === "bootstrapping" || r.status === "queued" || r.status === "paused");
    if (activeRun) {
      const routed = routeUserMessageToCoordinator(chatArgs.missionId, activeRun.id, latestUserMessage, chatMode);
      if (routed) return;
      if (activeRun.status === "paused") {
        emitOrchestratorMessage(
          chatArgs.missionId,
          "Orchestrator runtime is currently paused or unavailable. Resume or restart the run before sending additional directives."
        );
        return;
      }
    }

    if (latestRun && (latestRun.status === "succeeded" || latestRun.status === "failed" || latestRun.status === "canceled")) {
      const coordAgent = coordinatorAgents.get(latestRun.id);
      if (coordAgent?.isAlive) {
        const consultMessage = `[FOLLOW-UP CONSULT ONLY]\nThe mission run is already terminal (${latestRun.status}). Answer questions, explain decisions, and recommend next steps. Do not mutate the completed run. If more implementation work is requested, instruct the operator to start a continuation.\n\nChat mode: ${chatMode}\nUser message:\n${latestUserMessage}`;
        coordAgent.injectMessage(consultMessage);
        return;
      }
      return;
    }

    emitOrchestratorMessage(
      chatArgs.missionId,
      "Orchestrator runtime is not currently online for this mission. Start or resume the run to continue."
    );
  };

  const enqueueChatResponse = (chatArgs: SendOrchestratorChatArgs, recentChatContext: string): void => {
    const missionId = chatArgs.missionId;
    const previous = chatTurnQueues.get(missionId) ?? Promise.resolve();
    const next = previous
      .catch((error) => { logger.warn("ai_orchestrator.chat_queue_previous_failed", { missionId, error: getErrorMessage(error) }); })
      .then(async () => {
        await respondToChatWithAI(chatArgs, recentChatContext);
      })
      .catch((error) => {
        logger.debug("ai_orchestrator.chat_response_failed", {
          missionId,
          error: error instanceof Error ? error.message : String(error)
        });
        emitOrchestratorMessage(
          missionId,
          "I captured your directive, but live response generation failed. I will still apply it to planning and evaluation."
        );
      })
      .finally(() => {
        if (chatTurnQueues.get(missionId) === next) {
          chatTurnQueues.delete(missionId);
        }
      });
    chatTurnQueues.set(missionId, next);
  };

  // ── Event-Driven Coordinator with Heartbeat Safety Net ──────────
  /** Debounce window for batching event-driven coordinator evaluations. */
  const COORDINATOR_EVAL_DEBOUNCE_MS = 500;

  /**
   * Trigger an event-driven coordinator evaluation for a run.
   * Multiple calls within COORDINATOR_EVAL_DEBOUNCE_MS are batched into one evaluation.
   */
  const triggerCoordinatorEvaluation = (runId: string, reason: string): void => {
    if (disposed || !aiIntegrationService || !projectRoot) return;

    const existing = pendingCoordinatorEvals.get(runId);
    if (existing) clearTimeout(existing);

    pendingCoordinatorEvals.set(runId, setTimeout(() => {
      pendingCoordinatorEvals.delete(runId);
      runCoordinatorEvaluation(runId, reason);
    }, COORDINATOR_EVAL_DEBOUNCE_MS));
  };

  /**
   * Run an immediate coordinator evaluation for a run.
   * Routes a rich status event to the coordinator agent and starts any newly-ready autopilot steps.
   */
  const runCoordinatorEvaluation = (runId: string, reason: string): void => {
    if (disposed) return;

    void (async () => {
      try {
        const graph = orchestratorService.getRunGraph({ runId, timelineLimit: 10 });
        if (
          graph.run.status !== "active" && graph.run.status !== "bootstrapping" &&
          graph.run.status !== "queued"
        ) {
          return;
        }

        const missionId = graph.run.missionId;
        const launchFailure = getRunLaunchFailureMetadata(runId);

        const existingCoordinator = coordinatorAgents.get(runId) ?? null;
        let coordinator = existingCoordinator?.isAlive ? existingCoordinator : null;
        if (!coordinator && existingCoordinator && !existingCoordinator.isAlive) {
          const recovered = attemptCoordinatorRecovery(runId);
          if (recovered?.isAlive) coordinator = recovered;
        }
        if (!coordinator) {
          if (launchFailure && hasOpenMissionLaunchFailureIntervention({ missionId, runId })) {
            logger.info("ai_orchestrator.coordinator_unavailable_suppressed", {
              runId,
              missionId,
              reason: "launch_failure_open",
              failureStage: launchFailure.failureStage ?? null,
            });
            return;
          }
          pauseRunWithIntervention({
            runId,
            missionId,
            source: "transition_decision",
            reasonCode: existingCoordinator ? "coordinator_recovery_failed" : "coordinator_unavailable",
            title: existingCoordinator ? "Coordinator recovery failed" : "Coordinator unavailable",
            body: existingCoordinator
              ? "Coordinator agent terminated and could not be recovered. Mission paused to prevent non-autonomous fallback logic."
              : "Coordinator agent is not available for this run. Mission paused to prevent non-autonomous fallback logic.",
            requestedAction: "Resume after coordinator runtime is healthy, or restart the mission run.",
            metadata: {
              evaluationReason: reason
            }
          });
          logger.warn("ai_orchestrator.coordinator_eval_no_live_coordinator", {
            runId,
            missionId,
            reason,
            hadCoordinator: Boolean(existingCoordinator)
          });
          return;
        }

        // Route status event directly to coordinator agent
        {
          const now = Date.now();
          const runStartedAt = Date.parse(graph.run.createdAt);
          const missionDurationSec = Math.round((now - runStartedAt) / 1000);

          const relevantSteps = filterExecutionSteps(graph.steps);
          const runningSteps = relevantSteps.filter((s) => s.status === "running");
          const readySteps = relevantSteps.filter((s) => s.status === "ready");
          const completedSteps = relevantSteps.filter((s) =>
            s.status === "succeeded" || s.status === "failed" || s.status === "skipped" || s.status === "canceled"
          );
          const blockedSteps = relevantSteps.filter((s) => s.status === "blocked");
          const pendingSteps = relevantSteps.filter((s) => s.status === "pending");

          const stepGraph = graph.steps.map((s) => {
            const deps = s.dependencyStepIds
              .map((depId) => graph.steps.find((d) => d.id === depId)?.stepKey)
              .filter(Boolean);
            const latestAttempt = graph.attempts
              .filter((a) => a.stepId === s.id)
              .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
            const resultPreview = latestAttempt?.resultEnvelope?.summary?.slice(0, 200) ?? "";
            const errorMsg = latestAttempt?.errorMessage?.slice(0, 150) ?? "";
            let line = `  ${s.stepKey} [${s.status}] "${s.title}"`;
            if (deps.length) line += ` deps:[${deps.join(",")}]`;
            if (resultPreview) line += ` result:"${resultPreview}"`;
            if (errorMsg && s.status === "failed") line += ` error:"${errorMsg}"`;
            if (s.status === "running") {
              const elapsed = latestAttempt ? Math.round((Date.now() - Date.parse(latestAttempt.createdAt)) / 1000) : 0;
              line += ` running_for:${elapsed}s`;
            }
            return line;
          });

          const statusMessage = [
            `[EVENT: ${reason}] Duration: ${missionDurationSec}s`,
            `Progress: ${completedSteps.length}/${relevantSteps.length} executable steps done, ${runningSteps.length} running, ${readySteps.length} ready, ${blockedSteps.length} blocked, ${pendingSteps.length} pending`,
            ...(() => {
              const actionHints = buildCoordinatorEvaluationActionHints(graph);
              if (actionHints.length === 0) return [] as string[];
              return ["", "Required next actions:", ...actionHints.map((hint) => `- ${hint}`)];
            })(),
            "",
            "Step graph:",
            ...stepGraph,
          ].join("\n");

          coordinator.injectMessage(statusMessage);
        }

        // Always start any newly-ready steps after evaluation
        void startReadyAutopilotAttemptsWithMilestoneReadiness({ runId, reason: `coordinator_eval:${reason}` }).catch((error) => {
          logger.warn("ai_orchestrator.start_ready_attempts_failed", { runId, reason: `coordinator_eval:${reason}`, error: getErrorMessage(error) });
        });

        logger.debug("ai_orchestrator.coordinator_evaluation_triggered", { runId, missionId, reason });
      } catch (error) {
        logger.debug("ai_orchestrator.coordinator_evaluation_failed", {
          runId,
          reason,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    })();
  };


  const evaluateWorkerPlan = async (args: {
    attemptId: string;
    workerPlan: Record<string, unknown>;
    provider: "claude" | "codex";
  }): Promise<{ approved: boolean; feedback: string }> => {
    if (!aiIntegrationService || !projectRoot) {
      logger.debug("ai_orchestrator.evaluate_worker_plan_not_available", { attemptId: args.attemptId });
      return { approved: false, feedback: "Cannot auto-approve — AI evaluation unavailable. Review manually." };
    }

    try {
      const prompt = [
        PM_SYSTEM_PREAMBLE,
        "Your current role: EVALUATOR. Assess whether the worker's output meets quality criteria.",
        "",
        "Worker output summary:",
        JSON.stringify(args.workerPlan, null, 2),
        "",
        "Evaluate like a senior engineer reviewing a PR:",
        "- Does the output actually accomplish what the step was supposed to do? Check against step instructions, not just general quality.",
        "- Are there scope violations — files modified outside the worker's ownership fence?",
        "- Is the output complete enough for downstream steps to build on?",
        "- If rejecting: be specific about what needs to change. 'Auth middleware missing token refresh' beats 'incomplete'.",
        "- If approving with caveats: note what downstream steps should watch for.",
        "Be pragmatic — minor style issues should not block progress.",
        "Return a JSON object with your evaluation."
      ].join("\n");

      const evaluationSchema = {
        type: "object",
        properties: {
          approved: { type: "boolean" },
          feedback: { type: "string" },
          scopeViolations: { type: "array", items: { type: "string" } },
          alignmentScore: { type: "number", minimum: 0, maximum: 1 },
          suggestedAction: { type: "string", enum: ["accept", "retry_with_feedback", "add_corrective_step", "escalate"] }
        },
        required: ["approved", "feedback", "suggestedAction"]
      };

      const runIdForAttempt = db.get<{ run_id: string | null }>(
        `
          select run_id
          from orchestrator_attempts
          where id = ?
          limit 1
        `,
        [args.attemptId]
      )?.run_id ?? null;
      const missionIdForAttempt = runIdForAttempt ? getMissionIdForRun(runIdForAttempt) : null;
      const configWorkerEval = missionIdForAttempt
        ? resolveOrchestratorModelConfig(missionIdForAttempt, "coordinator")
        : ({ provider: "claude", modelId: "claude-sonnet-4-6", thinkingLevel: "medium" } as ModelConfig);
      const callTypeConfig = missionIdForAttempt
        ? resolveCallTypeConfig(missionIdForAttempt, "coordinator")
        : CALL_TYPE_DEFAULTS.coordinator;

      const result = await aiIntegrationService.executeTask({
        feature: "orchestrator",
        taskType: "review",
        prompt,
        cwd: projectRoot,
        provider: callTypeConfig.provider,
        model: modelConfigToServiceModel(configWorkerEval),
        reasoningEffort: callTypeConfig.reasoningEffort,
        jsonSchema: evaluationSchema,
        permissionMode: "read-only",
        oneShot: true,
        timeoutMs: 30_000
      });

      const parsed = isRecord(result.structuredOutput) ? result.structuredOutput : null;
      if (parsed) {
        return {
          approved: parsed.approved === true,
          feedback: typeof parsed.feedback === "string" ? parsed.feedback : result.text
        };
      }
      return { approved: true, feedback: result.text || "Evaluation completed without structured output." };
    } catch (error) {
      logger.warn("ai_orchestrator.evaluate_worker_plan_failed", {
        attemptId: args.attemptId,
        error: error instanceof Error ? error.message : String(error)
      });
      // Don't silently auto-approve on failure — flag for review
      return { approved: false, feedback: `AI evaluation failed (${error instanceof Error ? error.message : "unknown error"}). Flagging for manual review.` };
    }
  };

  // ---------------------------------------------------------------------------
  // AI Plan Adjustment: evaluate and optimize the remaining plan after each
  // step completion. This function is called when autoAdjustPlan is enabled.
  // ---------------------------------------------------------------------------

  const adjustPlanWithAI = async (adjustArgs: {
    runId: string;
    completedStepId: string;
    graph: OrchestratorRunGraph;
  }): Promise<void> => {
    if (!aiIntegrationService || !projectRoot) return;

    const { graph } = adjustArgs;
    const completed = graph.steps.filter((s) => s.status === "succeeded" || s.status === "failed" || s.status === "skipped");
    const remaining = graph.steps.filter((s) => s.status === "pending" || s.status === "ready" || s.status === "blocked");
    const targetStep = graph.steps.find((s) => s.id === adjustArgs.completedStepId);

    const steeringContext = getSteeringContext(graph.run.missionId);

    // Build rich step context so the AI can see actual results and dependency relationships
    const stepDetails = graph.steps.map((s) => {
      const deps = s.dependencyStepIds
        .map((depId) => graph.steps.find((d) => d.id === depId)?.stepKey)
        .filter(Boolean);
      const latestAttempt = graph.attempts
        .filter((a) => a.stepId === s.id)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
      const resultSummary = latestAttempt?.resultEnvelope?.summary?.slice(0, 300) ?? "";
      return `  - ${s.stepKey} [${s.status}] "${s.title}"${deps.length ? ` depends_on:[${deps.join(",")}]` : " (no deps)"}${resultSummary ? ` result: "${resultSummary}..."` : ""}`;
    });

    // Identify parallelization opportunities for the AI
    const blockedWithSingleDep = remaining.filter((s) => {
      if (s.status !== "blocked") return false;
      const depSteps = s.dependencyStepIds
        .map((depId) => graph.steps.find((d) => d.id === depId))
        .filter(Boolean);
      return depSteps.some((d) => d!.status === "succeeded" || d!.status === "skipped");
    });

    const prompt = [
      PM_SYSTEM_PREAMBLE,
      "Your current role: PLAN ADJUSTER. A step just completed. Evaluate the ENTIRE remaining plan aggressively.",
      "",
      "Your #1 priority: MAXIMIZE PARALLELISM. Every blocked step that doesn't truly need its dependency should be unblocked.",
      "Your #2 priority: ELIMINATE WASTE. Skip steps that are now redundant given completed work.",
      "Your #3 priority: FILL GAPS. Add steps only when completed work reveals a concrete missing piece.",
      "",
      "Think like a PM who hates idle workers:",
      "- Look at each blocked step. Does it TRULY need its dependency, or was that dependency speculative at planning time?",
      "- If step A's output is irrelevant to step B, remove the dependency even if the planner thought they were related.",
      "- Can two pending steps be consolidated into one to save time?",
      "- Should a step be reassigned to a different executor (claude vs codex) based on what we've learned?",
      "- Did the completed step produce learnings that running/pending workers should know about?",
      "",
      `Run ID: ${adjustArgs.runId}`,
      `Progress: ${completed.length}/${graph.steps.length} completed`,
      `Last completed: ${targetStep?.stepKey ?? adjustArgs.completedStepId} [${targetStep?.status ?? "unknown"}]`,
      "",
      "Full step graph:",
      ...stepDetails,
      "",
      blockedWithSingleDep.length > 0 ? `Parallelization opportunities — these blocked steps have some completed dependencies:\n${blockedWithSingleDep.map((s) => `  - ${s.stepKey}: "${s.title}"`).join("\n")}` : "",
      steeringContext,
      "",
      "Available actions:",
      "- skip_step: Skip a remaining step (set targetStepKey + reason)",
      "- add_step: Add a new corrective step (set newStep with stepKey, title, instructions, dependencyStepKeys, executorKind)",
      "- parallelize_steps: Remove a dependency from a step to unblock it (set targetStepKey + removeDependencyKey)",
      "- consolidate_steps: Merge two pending/blocked steps into one (set targetStepKey=keep, removeStepKey=discard, mergedInstructions)",
      "- reassign_executor: Change executor kind for a pending/blocked step (set targetStepKey + newExecutorKind: 'unified'|'manual')",
      "- steer_worker: Send a message to a running worker with learnings from this completed step (set targetStepKey + steeringMessage)",
      "- no_change: Nothing to adjust",
      "",
      "Be decisive. Respond with no_change ONLY if you genuinely see no optimization opportunity.",
      "Return a JSON object with your adjustments."
    ].join("\n");

    const adjustmentSchema = {
      type: "object",
      properties: {
        reasoning: { type: "string" },
        adjustments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["add_step", "skip_step", "parallelize_steps", "consolidate_steps", "reassign_executor", "steer_worker", "no_change"] },
              targetStepKey: { type: "string" },
              reason: { type: "string" },
              // For parallelize_steps: which dependency to remove
              removeDependencyKey: { type: "string" },
              // For consolidate_steps: which step to merge into targetStepKey
              removeStepKey: { type: "string" },
              mergedInstructions: { type: "string" },
              // For reassign_executor
              newExecutorKind: { type: "string", enum: ["unified", "manual"] },
              // For steer_worker: message to send to running worker
              steeringMessage: { type: "string" },
              // For add_step
              newStep: {
                type: "object",
                properties: {
                  stepKey: { type: "string" },
                  title: { type: "string" },
                  instructions: { type: "string" },
                  dependencyStepKeys: { type: "array", items: { type: "string" } },
                  executorKind: { type: "string", enum: ["unified", "manual"] }
                }
              }
            },
            required: ["action", "reason"]
          }
        }
      },
      required: ["reasoning", "adjustments"]
    };

    const missionId = graph.run.missionId;
    const planAdjustConfig = resolveCallTypeConfig(missionId, "coordinator");

    const result = await aiIntegrationService.executeTask({
      feature: "orchestrator",
      taskType: "planning",
      prompt,
      cwd: projectRoot,
      provider: planAdjustConfig.provider,
      reasoningEffort: planAdjustConfig.reasoningEffort,
      jsonSchema: adjustmentSchema,
      permissionMode: "read-only",
      oneShot: true,
      timeoutMs: 30_000
    });

    const parsed = isRecord(result.structuredOutput) ? result.structuredOutput : null;
    if (!parsed || !Array.isArray(parsed.adjustments)) return;

    let adjustmentsApplied = 0;
    for (const adj of parsed.adjustments) {
      if (!isRecord(adj)) continue;
      const action = String(adj.action ?? "");
      const reason = String(adj.reason ?? "AI-suggested adjustment");

      if (action === "skip_step" && typeof adj.targetStepKey === "string") {
        const target = graph.steps.find((s) => s.stepKey === adj.targetStepKey);
        if (target && target.status !== "succeeded" && target.status !== "failed") {
          try {
            orchestratorService.skipStep({ runId: adjustArgs.runId, stepId: target.id, reason });
            emitOrchestratorMessage(graph.run.missionId, `AI adjuster skipped "${stepTitleForMessage(target)}": ${reason}`, target.stepKey);
            logger.info("ai_orchestrator.ai_skip_step", { runId: adjustArgs.runId, stepKey: adj.targetStepKey, reason });
            adjustmentsApplied++;
          } catch (e) {
            logger.debug("ai_orchestrator.ai_skip_step_failed", {
              runId: adjustArgs.runId,
              stepKey: adj.targetStepKey,
              error: e instanceof Error ? e.message : String(e)
            });
          }
        }
      } else if (action === "add_step" && isRecord(adj.newStep)) {
        const newStep = adj.newStep;
        const stepKey = typeof newStep.stepKey === "string" ? newStep.stepKey : `ai-corrective-${Date.now()}`;
        const title = typeof newStep.title === "string" ? newStep.title : "AI-suggested corrective step";
        const depKeys = Array.isArray(newStep.dependencyStepKeys) ? newStep.dependencyStepKeys.map(String) : [];
        const executorKind = typeof newStep.executorKind === "string" &&
          ["unified", "manual"].includes(newStep.executorKind)
          ? (newStep.executorKind as OrchestratorExecutorKind)
          : ("unified" as OrchestratorExecutorKind);
        try {
          orchestratorService.addSteps({
            runId: adjustArgs.runId,
            steps: [{
              stepKey,
              title,
              stepIndex: graph.steps.length,
              dependencyStepKeys: depKeys,
              executorKind,
              retryLimit: 1,
              metadata: {
                instructions: typeof newStep.instructions === "string" ? newStep.instructions : "",
                aiGenerated: true,
                generationReason: reason
              }
            }]
          });
          emitOrchestratorMessage(graph.run.missionId, `AI adjuster added step "${title}": ${reason}`);
          logger.info("ai_orchestrator.ai_add_step", { runId: adjustArgs.runId, stepKey, reason });
          adjustmentsApplied++;
        } catch (e) {
          logger.debug("ai_orchestrator.ai_add_step_failed", {
            runId: adjustArgs.runId,
            stepKey,
            error: e instanceof Error ? e.message : String(e)
          });
        }
      } else if (action === "parallelize_steps" && typeof adj.targetStepKey === "string" && typeof adj.removeDependencyKey === "string") {
        // Remove a dependency to unblock a step for parallel execution
        const target = graph.steps.find((s) => s.stepKey === adj.targetStepKey);
        if (target && (target.status === "blocked" || target.status === "pending" || target.status === "ready")) {
          try {
            const currentDepKeys = target.dependencyStepIds
              .map((depId) => graph.steps.find((d) => d.id === depId)?.stepKey)
              .filter((k): k is string => !!k);
            const newDepKeys = currentDepKeys.filter((k) => k !== adj.removeDependencyKey);
            orchestratorService.updateStepDependencies({
              runId: adjustArgs.runId,
              stepId: target.id,
              dependencyStepKeys: newDepKeys
            });
            emitOrchestratorMessage(
              graph.run.missionId,
              `AI adjuster parallelized "${stepTitleForMessage(target)}" — removed dependency on "${adj.removeDependencyKey}": ${reason}`,
              target.stepKey
            );
            logger.info("ai_orchestrator.ai_parallelize_steps", {
              runId: adjustArgs.runId,
              stepKey: adj.targetStepKey,
              removedDep: adj.removeDependencyKey,
              reason
            });
            adjustmentsApplied++;
          } catch (e) {
            logger.debug("ai_orchestrator.ai_parallelize_steps_failed", {
              runId: adjustArgs.runId,
              stepKey: adj.targetStepKey,
              error: e instanceof Error ? e.message : String(e)
            });
          }
        }
      } else if (action === "consolidate_steps" && typeof adj.targetStepKey === "string" && typeof adj.removeStepKey === "string") {
        // Merge two steps into one
        const keepStep = graph.steps.find((s) => s.stepKey === adj.targetStepKey);
        const removeStep = graph.steps.find((s) => s.stepKey === adj.removeStepKey);
        if (keepStep && removeStep && !["succeeded", "failed", "canceled"].includes(removeStep.status)) {
          try {
            orchestratorService.consolidateSteps({
              runId: adjustArgs.runId,
              keepStepId: keepStep.id,
              removeStepId: removeStep.id,
              mergedInstructions: typeof adj.mergedInstructions === "string" ? adj.mergedInstructions : ""
            });
            emitOrchestratorMessage(
              graph.run.missionId,
              `AI adjuster consolidated "${stepTitleForMessage(removeStep)}" into "${stepTitleForMessage(keepStep)}": ${reason}`,
              keepStep.stepKey
            );
            logger.info("ai_orchestrator.ai_consolidate_steps", {
              runId: adjustArgs.runId,
              keepStepKey: adj.targetStepKey,
              removeStepKey: adj.removeStepKey,
              reason
            });
            adjustmentsApplied++;
          } catch (e) {
            logger.debug("ai_orchestrator.ai_consolidate_steps_failed", {
              runId: adjustArgs.runId,
              error: e instanceof Error ? e.message : String(e)
            });
          }
        }
      } else if (action === "reassign_executor" && typeof adj.targetStepKey === "string" && typeof adj.newExecutorKind === "string") {
        // Change executor kind for a pending/blocked step
        // startAttempt reads executorKind from step.metadata.executorKind
        const target = graph.steps.find((s) => s.stepKey === adj.targetStepKey);
        if (target && (target.status === "blocked" || target.status === "pending" || target.status === "ready")) {
          try {
            const oldExecutorKind = isRecord(target.metadata) ? String(target.metadata.executorKind ?? "unknown") : "unknown";
            orchestratorService.updateStepMetadata({
              runId: adjustArgs.runId,
              stepId: target.id,
              metadata: { executorKind: adj.newExecutorKind, reassignReason: reason }
            });
            emitOrchestratorMessage(
              graph.run.missionId,
              `AI adjuster reassigned "${stepTitleForMessage(target)}" from ${oldExecutorKind} → ${adj.newExecutorKind}: ${reason}`,
              target.stepKey
            );
            logger.info("ai_orchestrator.ai_reassign_executor", {
              runId: adjustArgs.runId,
              stepKey: adj.targetStepKey,
              oldExecutorKind,
              newExecutorKind: adj.newExecutorKind,
              reason
            });
            adjustmentsApplied++;
          } catch (e) {
            logger.debug("ai_orchestrator.ai_reassign_executor_failed", {
              runId: adjustArgs.runId,
              stepKey: adj.targetStepKey,
              error: e instanceof Error ? e.message : String(e)
            });
          }
        }
      } else if (action === "steer_worker" && typeof adj.targetStepKey === "string" && typeof adj.steeringMessage === "string") {
        // Cross-worker intelligence: send learnings from completed step to a running worker
        const target = graph.steps.find((s) => s.stepKey === adj.targetStepKey);
        if (target && target.status === "running") {
          const workerEntry = [...workerStates.entries()].find(([, ws]) =>
            ws.stepId === target.id && ws.state === "working" && ws.sessionId
          );
          if (workerEntry && agentChatService) {
            const [, workerWs] = workerEntry;
            void (async () => {
              try {
                await sendWorkerMessageToSession(
                  workerWs.sessionId!,
                  `[ADE ORCHESTRATOR — CROSS-WORKER INTELLIGENCE]: ${adj.steeringMessage}`
                );
                logger.debug("ai_orchestrator.ai_cross_worker_steer_delivered", {
                  runId: adjustArgs.runId,
                  fromStep: targetStep?.stepKey,
                  toStep: adj.targetStepKey
                });
              } catch {
                // Best-effort cross-worker steering
              }
            })();
          }
          emitOrchestratorMessage(
            graph.run.missionId,
            `AI adjuster sent cross-worker insight to "${stepTitleForMessage(target)}": ${adj.steeringMessage!.slice(0, 200)}`,
            target.stepKey
          );
          logger.info("ai_orchestrator.ai_steer_worker", {
            runId: adjustArgs.runId,
            targetStepKey: adj.targetStepKey,
            reason
          });
          adjustmentsApplied++;
        }
      }
      // no_change — just skip
    }

      // After applying adjustments, immediately start any newly-ready steps
    if (adjustmentsApplied > 0) {
      void startReadyAutopilotAttemptsWithMilestoneReadiness({
        runId: adjustArgs.runId,
        reason: `ai_plan_adjustment:${adjustmentsApplied}_changes`
      }).catch((error) => {
        logger.warn("ai_orchestrator.start_ready_attempts_failed", { runId: adjustArgs.runId, reason: `ai_plan_adjustment:${adjustmentsApplied}_changes`, error: getErrorMessage(error) });
      });
      logger.info("ai_orchestrator.ai_plan_adjustment_applied", {
        runId: adjustArgs.runId,
        adjustmentsApplied,
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 500) : ""
      });
    }
  };

  // ---------------------------------------------------------------------------
  // Fan-out run state snapshot: gathers current run state for the meta-reasoner.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Cross-step handoff propagation: automatically enrich downstream steps
  // with structured context from completed upstream steps.
  // This is model-agnostic — any model benefits from richer input context.
  // ---------------------------------------------------------------------------

  const propagateHandoffContext = (args: {
    runId: string;
    completedStepId: string;
    digest: OrchestratorWorkerDigest;
  }): void => {
    try {
      const graph = orchestratorService.getRunGraph({ runId: args.runId, timelineLimit: 0 });
      const completedStep = graph.steps.find((s) => s.id === args.completedStepId);
      if (!completedStep) return;

      // Build structured handoff summary from digest
      const parts: string[] = [];
      parts.push(`[${completedStep.stepKey}] ${args.digest.summary.slice(0, 300)}`);

      if (args.digest.filesChanged.length > 0) {
        const fileList = args.digest.filesChanged.slice(0, 15).join(", ");
        const more = args.digest.filesChanged.length > 15 ? ` (+${args.digest.filesChanged.length - 15} more)` : "";
        parts.push(`Files changed: ${fileList}${more}`);
      }

      if (args.digest.testsRun.failed > 0) {
        parts.push(`Tests: ${args.digest.testsRun.passed} passed, ${args.digest.testsRun.failed} FAILED, ${args.digest.testsRun.skipped} skipped`);
      } else if (args.digest.testsRun.passed > 0) {
        parts.push(`Tests: ${args.digest.testsRun.passed} passed`);
      }

      if (args.digest.warnings.length > 0) {
        parts.push(`Warnings: ${args.digest.warnings.slice(0, 3).join("; ")}`);
      }

      const handoffText = parts.join(". ");
      if (!handoffText.trim().length) return;

      // Find all downstream steps that depend on the completed step
      const downstreamSteps = graph.steps.filter((s) => {
        if (s.status === "succeeded" || s.status === "failed" || s.status === "skipped" || s.status === "canceled") return false;
        return s.dependencyStepIds.includes(args.completedStepId);
      });

      if (downstreamSteps.length === 0) return;

      const now = nowIso();
      for (const downstream of downstreamSteps) {
        const meta = isRecord(downstream.metadata) ? { ...downstream.metadata } : {};
        const handoffKey = `${completedStep.id}:${args.digest.attemptId}`;
        const existing = Array.isArray(meta.handoffSummaries)
          ? [...meta.handoffSummaries as unknown[]].filter((entry) => typeof entry === "string" && entry.trim().length > 0)
          : [];
        const existingKeys = Array.isArray(meta.handoffSummaryKeys)
          ? [...meta.handoffSummaryKeys as unknown[]].filter((entry) => typeof entry === "string" && entry.trim().length > 0)
          : [];
        const alreadyApplied = existingKeys.includes(handoffKey) || existing.includes(handoffText);
        if (alreadyApplied) {
          continue;
        }
        existing.push(handoffText);
        existingKeys.push(handoffKey);
        // Cap at 10 handoff entries to prevent prompt bloat
        meta.handoffSummaries = existing.slice(-10);
        meta.handoffSummaryKeys = existingKeys.slice(-10);
        db.run(
          `update orchestrator_steps set metadata_json = ?, updated_at = ? where id = ? and run_id = ?`,
          [JSON.stringify(meta), now, downstream.id, args.runId]
        );
      }

      logger.debug("ai_orchestrator.handoff_propagated", {
        runId: args.runId,
        fromStepKey: completedStep.stepKey,
        downstreamCount: downstreamSteps.length,
        handoffLength: handoffText.length
      });

      // Tier 2 — AI evaluation on EVERY step completion
      // The AI decides whether to adjust, not hardcoded conditions.
      // This lets the orchestrator opportunistically parallelize, consolidate, and reorder.
      const runtimeProfile = runRuntimeProfiles.get(args.runId) ?? resolveActiveRuntimeProfile(graph.run.missionId);

      const shouldTriggerAiAdjustment =
        runtimeProfile.evaluation.autoAdjustPlan &&
        aiIntegrationService &&
        projectRoot;

      const completedCount = graph.steps.filter(s => s.status === "succeeded" || s.status === "failed" || s.status === "skipped").length;
      const pct = Math.round((completedCount / graph.steps.length) * 100);
      const activeWorkerCount = [...workerStates.values()].filter(ws => ws.runId === args.runId && ws.state === "working").length;
      const blockedCount = graph.steps.filter(s => s.status === "blocked").length;
      const nextReady = graph.steps.filter(s => s.status === "ready").map(s => `"${stepTitleForMessage(s)}"`);

      const progressParts = [`${completedCount}/${graph.steps.length} steps (${pct}%)`];
      if (activeWorkerCount > 0) progressParts.push(`${activeWorkerCount} active`);
      if (blockedCount > 0) progressParts.push(`${blockedCount} blocked`);
      if (nextReady.length > 0) progressParts.push(`next: ${nextReady.slice(0, 2).join(", ")}`);

      emitOrchestratorMessage(
        graph.run.missionId,
        `Progress: ${progressParts.join(" | ")}${shouldTriggerAiAdjustment ? " — triggering plan adjustment" : ""}`,
        completedStep.stepKey
      );

      if (shouldTriggerAiAdjustment) {
        adjustPlanWithAI({
          runId: args.runId,
          completedStepId: args.completedStepId,
          graph
        }).catch((error) => {
          logger.debug("ai_orchestrator.ai_adjustment_failed", {
            runId: args.runId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }

      // Event-driven coordinator trigger: evaluate plan immediately on step completion
      triggerCoordinatorEvaluation(args.runId, `step_completed:${completedStep.stepKey}`);
    } catch (error) {
      logger.debug("ai_orchestrator.handoff_propagation_failed", {
        runId: args.runId,
        completedStepId: args.completedStepId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  // ── Mission Pause Helpers ──────────────────────────────────────────────
  // Create an intervention and transition mission to intervention_required.
  // Running workers are NOT killed — they finish their current task.

  const pauseMissionWithIntervention = (args: {
    missionId: string;
    interventionType: "budget_limit_reached" | "provider_unreachable" | "unrecoverable_error";
    title: string;
    body: string;
    requestedAction: string;
    metadata?: Record<string, unknown>;
  }): void => {
    try {
      missionService.addIntervention({
        missionId: args.missionId,
        interventionType: args.interventionType,
        title: args.title,
        body: args.body,
        requestedAction: args.requestedAction,
        pauseMission: true,
        metadata: args.metadata ?? null,
      });
      emitOrchestratorMessage(
        args.missionId,
        `[MISSION PAUSED] ${args.title}: ${args.body.slice(0, 300)}`,
        null,
        { pauseReason: args.interventionType }
      );

      // Emit mission_paused timeline event for the activity feed
      const pauseRuns = orchestratorService.listRuns({ missionId: args.missionId });
      const pauseRun = pauseRuns.find((r) => r.status === "active" || r.status === "bootstrapping" || r.status === "paused");
      if (pauseRun) {
        orchestratorService.appendTimelineEvent({
          runId: pauseRun.id,
          eventType: "mission_paused",
          reason: `${args.interventionType}: ${args.title}`,
          detail: { interventionType: args.interventionType, body: args.body.slice(0, 300) },
        });
      }

      logger.info("ai_orchestrator.mission_paused", {
        missionId: args.missionId,
        interventionType: args.interventionType,
        title: args.title,
      });
    } catch (err) {
      logger.error("ai_orchestrator.pause_intervention_failed", {
        missionId: args.missionId,
        interventionType: args.interventionType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /** Pause mission when a budget hard cap is triggered by spawn_worker refusal. */
  const pauseOnBudgetHardCap = (missionId: string, detail: string): void => {
    // Emit budget hard cap chat message + timeline event before pausing
    emitOrchestratorMessage(missionId, `Budget pressure: hard_cap — ${detail}`);
    const hardCapRuns = orchestratorService.listRuns({ missionId });
    const hardCapRun = hardCapRuns.find((r) => r.status === "active" || r.status === "bootstrapping" || r.status === "paused");
    if (hardCapRun) {
      orchestratorService.appendTimelineEvent({
        runId: hardCapRun.id,
        eventType: "budget_hard_cap_triggered",
        reason: "Budget hard cap reached",
        detail: { detail },
      });
    }

    pauseMissionWithIntervention({
      missionId,
      interventionType: "budget_limit_reached",
      title: "Budget hard cap reached",
      body: detail,
      requestedAction: "Raise budget limits, wait for the 5-hour window to reset, or cancel the mission.",
      metadata: { source: "spawn_worker_hard_cap" },
    });
  };

  const handleInterventionWithAI = async (args: {
    missionId: string;
    interventionId: string;
    provider: "claude" | "codex";
  }): Promise<{ autoResolved: boolean; suggestion: string | null }> => {
    if (!aiIntegrationService || !projectRoot) {
      logger.debug("ai_orchestrator.handle_intervention_not_available", {
        missionId: args.missionId,
        interventionId: args.interventionId
      });
      return { autoResolved: false, suggestion: null };
    }

    try {
      const mission = missionService.get(args.missionId);
      if (!mission) return { autoResolved: false, suggestion: null };

      // Find the intervention
      const intervention = mission.interventions.find((i) => i.id === args.interventionId);
      const interventionReasonCode =
        typeof intervention?.metadata?.reasonCode === "string" ? intervention.metadata.reasonCode.trim() : "";
      if (interventionReasonCode === "planner_plan_missing") {
        const suggestion =
          "Planner output is missing the canonical plan artifact. Retry planning only after the planner can return report_result.plan.markdown.";
        emitOrchestratorMessage(
          args.missionId,
          `Intervention requires your input: ${intervention?.title ?? args.interventionId}. ${suggestion}`
        );
        return { autoResolved: false, suggestion };
      }
      const interventionDesc = intervention
        ? `Type: ${intervention.interventionType}, Title: ${intervention.title}, Body: ${intervention.body}`
        : `Intervention ID: ${args.interventionId}`;

      // Gather run graph context if available
      const runs = orchestratorService.listRuns({ missionId: args.missionId });
      const activeRun = runs.find((r) => r.status === "active" || r.status === "bootstrapping" || r.status === "paused");
      let runContext = "No active run.";
      if (activeRun) {
        const graph = orchestratorService.getRunGraph({ runId: activeRun.id, timelineLimit: 10 });
        const done = graph.steps.filter((s) => s.status === "succeeded" || s.status === "skipped").length;
        const failed = graph.steps.filter((s) => s.status === "failed").length;
        const remaining = graph.steps.filter((s) => s.status === "pending" || s.status === "ready" || s.status === "blocked").length;
        runContext = `Run ${activeRun.id.slice(0, 8)}: ${done} done, ${failed} failed, ${remaining} remaining of ${graph.steps.length} total steps.`;
      }

      const runtimeProfile = resolveActiveRuntimeProfile(args.missionId);
      const confidenceThreshold = runtimeProfile.evaluation.interventionConfidenceThreshold;
      const steeringContext = getSteeringContext(args.missionId);
      const prompt = buildInterventionResolverPrompt({
        missionTitle: mission.title,
        missionPrompt: mission.prompt,
        interventionDescription: interventionDesc,
        runContext,
        steeringContext,
        confidenceThreshold
      });

      const interventionSchema = {
        type: "object",
        properties: {
          autoResolvable: { type: "boolean" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          suggestedAction: { type: "string", enum: ["retry", "skip", "add_workaround", "escalate"] },
          reasoning: { type: "string" },
          retryInstructions: { type: "string" },
          workaroundStep: {
            type: "object",
            properties: {
              title: { type: "string" },
              instructions: { type: "string" }
            }
          }
        },
        required: ["autoResolvable", "confidence", "suggestedAction", "reasoning"]
      };

      const configIntervention = resolveOrchestratorModelConfig(args.missionId, "coordinator");
      const timeoutMs = resolveAiDecisionLikeTimeoutMs(args.missionId);
      const interventionCallConfig = resolveCallTypeConfig(args.missionId, "coordinator");
      const result = await aiIntegrationService.executeTask({
        feature: "orchestrator",
        taskType: "review",
        prompt,
        cwd: projectRoot,
        provider: interventionCallConfig.provider,
        model: modelConfigToServiceModel(configIntervention),
        reasoningEffort: interventionCallConfig.reasoningEffort,
        jsonSchema: interventionSchema,
        permissionMode: "read-only",
        oneShot: true,
        ...(timeoutMs != null ? { timeoutMs } : {})
      });

      const parsed = isRecord(result.structuredOutput) ? result.structuredOutput : null;
      if (!parsed) {
        return { autoResolved: false, suggestion: result.text || null };
      }

      const autoResolvable = parsed.autoResolvable === true;
      const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
      const suggestedAction = typeof parsed.suggestedAction === "string" ? parsed.suggestedAction : "escalate";
      const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";

      logger.info("ai_orchestrator.intervention_ai_assessment", {
        missionId: args.missionId,
        interventionId: args.interventionId,
        autoResolvable,
        confidence,
        suggestedAction
      });

      if (autoResolvable && confidence >= confidenceThreshold && suggestedAction !== "escalate") {
        // Auto-resolve: attach AI reasoning and resolve the intervention
        if (intervention) {
          try {
            missionService.resolveIntervention({
              missionId: args.missionId,
              interventionId: intervention.id,
              status: "resolved",
              note: `AI auto-resolved (confidence: ${confidence.toFixed(2)}): ${reasoning}`
            });
            if (activeRun) {
              recordRuntimeEvent({
                runId: activeRun.id,
                eventType: "intervention_resolved",
                eventKey: `intervention_resolved:${intervention.id}:ai_auto`,
                payload: {
                  interventionId: intervention.id,
                  reason: "ai_auto_resolve",
                  confidence,
                  suggestedAction
                }
              });
            }
          } catch {
            // Intervention may already be resolved or not found
          }
        }
        emitOrchestratorMessage(
          args.missionId,
          `Intervention auto-resolved: ${reasoning}`
        );
        return { autoResolved: true, suggestion: reasoning };
      }

      // Low confidence or escalate action: attach suggestion but keep intervention open
      emitOrchestratorMessage(
        args.missionId,
        `Intervention requires your input: ${intervention?.title ?? args.interventionId}. ${reasoning || ""}`
      );
      return { autoResolved: false, suggestion: reasoning || null };
    } catch (error) {
      logger.warn("ai_orchestrator.handle_intervention_failed", {
        missionId: args.missionId,
        interventionId: args.interventionId,
        error: error instanceof Error ? error.message : String(error)
      });
      return { autoResolved: false, suggestion: null };
    }
  };

  // ── Model Config Resolution (delegated to modelConfigResolver) ──
  const resolveMissionDecisionTimeoutCapMs = (missionId: string) =>
    resolveMissionDecisionTimeoutCapMsCtx(ctx, missionId);
  const resolveAiDecisionLikeTimeoutMs = (missionId: string) =>
    resolveAiDecisionLikeTimeoutMsCtx(ctx, missionId);
  const resolveOrchestratorModelConfig = (missionId: string, callType: OrchestratorCallType) =>
    resolveOrchestratorModelConfigCtx(ctx, missionId, callType);

  // Delegated to missionLifecycle.ts
  const transitionMissionStatus = (missionId: string, next: MissionStatus, args?: { outcomeSummary?: string | null; lastError?: string | null }) =>
    transitionMissionStatusCtx(ctx, missionId, next, args);

  const COORDINATOR_FAILURE_REASON_CODES = new Set([
    "coordinator_unavailable",
    "coordinator_recovery_failed",
  ]);

  const resolveCoordinatorHealthInterventions = (args: {
    runId: string;
    note: string;
    resolutionReason: "coordinator_recovered" | "run_terminal";
  }): number => {
    const missionId = getMissionIdForRun(args.runId);
    if (!missionId) return 0;
    const mission = missionService.get(missionId);
    if (!mission) return 0;

    let resolved = 0;
    const resolvedAt = nowIso();

    for (const intervention of mission.interventions) {
      if (intervention.status !== "open" || intervention.interventionType !== "failed_step") continue;
      const metadata = isRecord(intervention.metadata) ? intervention.metadata : null;
      const reasonCode = typeof metadata?.reasonCode === "string" ? metadata.reasonCode.trim() : "";
      const interventionRunId = typeof metadata?.runId === "string" ? metadata.runId.trim() : "";
      if (!COORDINATOR_FAILURE_REASON_CODES.has(reasonCode)) continue;
      if (interventionRunId.length > 0 && interventionRunId !== args.runId) continue;

      try {
        missionService.resolveIntervention({
          missionId,
          interventionId: intervention.id,
          status: "resolved",
          note: args.note,
        });
        recordRuntimeEvent({
          runId: args.runId,
          stepId: typeof metadata?.stepId === "string" ? metadata.stepId : null,
          attemptId: typeof metadata?.attemptId === "string" ? metadata.attemptId : null,
          sessionId: typeof metadata?.sessionId === "string" ? metadata.sessionId : null,
          eventType: "intervention_resolved",
          eventKey: `intervention_resolved:${intervention.id}:${args.resolutionReason}`,
          payload: {
            interventionId: intervention.id,
            reason: args.resolutionReason,
            reasonCode,
            resolvedAt,
          }
        });
        resolved += 1;
      } catch (error) {
        logger.debug("ai_orchestrator.coordinator_intervention_resolve_failed", {
          runId: args.runId,
          interventionId: intervention.id,
          reasonCode,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return resolved;
  };

  const pauseRunWithIntervention = (args: {
    runId: string;
    missionId: string;
    stepId?: string | null;
    stepKey?: string | null;
    source: "transition_decision";
    interventionType?: MissionDetail["interventions"][number]["interventionType"];
    reasonCode: string;
    title: string;
    body: string;
    requestedAction: string;
    metadata?: Record<string, unknown>;
  }): string | null => {
    const dedupeKey = `${args.source}:${args.reasonCode}:${args.runId}:${args.stepId ?? "run"}`;
    const runMetadata = getRunMetadata(args.runId);
    const existingAiDecisionMeta = isRecord(runMetadata.aiDecisions) ? runMetadata.aiDecisions : {};
    const mission = missionService.get(args.missionId);
    let existingInterventionId: string | null = null;
    if (mission) {
      for (const entry of mission.interventions) {
        if (entry.status !== "open") continue;
        const metadata = isRecord(entry.metadata) ? entry.metadata : null;
        if (metadata?.aiDecisionFailureKey === dedupeKey) {
          existingInterventionId = entry.id;
          break;
        }
      }
    }

    try {
      orchestratorService.pauseRun({
        runId: args.runId,
        reason: `${args.title}: ${args.body}`.slice(0, 400),
        metadata: {
          aiDecisions: {
            ...existingAiDecisionMeta,
            lastFailureAt: nowIso(),
            lastFailureSource: args.source,
            lastFailureReason: args.reasonCode
          }
        }
      });
      const evalTimer = pendingCoordinatorEvals.get(args.runId);
      if (evalTimer) {
        clearTimeout(evalTimer);
        pendingCoordinatorEvals.delete(args.runId);
      }
    } catch (error) {
      logger.debug("ai_orchestrator.pause_run_failed", {
        runId: args.runId,
        source: args.source,
        reasonCode: args.reasonCode,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    let interventionId: string | null = existingInterventionId;
    if (!interventionId) {
      try {
        const intervention = missionService.addIntervention({
          missionId: args.missionId,
          interventionType: args.interventionType ?? "failed_step",
          title: args.title,
          body: args.body,
          requestedAction: args.requestedAction,
          metadata: {
            aiDecisionFailureKey: dedupeKey,
            runId: args.runId,
            stepId: args.stepId ?? null,
            stepKey: args.stepKey ?? null,
            source: args.source,
            reasonCode: args.reasonCode,
            ...(args.metadata ?? {})
          }
        });
        interventionId = intervention.id;
      } catch (error) {
        logger.debug("ai_orchestrator.pause_intervention_create_failed", {
          runId: args.runId,
          missionId: args.missionId,
          source: args.source,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    transitionMissionStatus(args.missionId, "intervention_required", {
      lastError: args.body
    });
    emitOrchestratorMessage(
      args.missionId,
      `${args.title}. I paused execution and opened an intervention${interventionId ? ` (${interventionId.slice(0, 8)})` : ""}.`,
      args.stepKey ?? null
    );

    if (interventionId) {
      recordRuntimeEvent({
        runId: args.runId,
        stepId: args.stepId ?? null,
        eventType: "intervention_opened",
        eventKey: `intervention_opened:${interventionId}`,
        payload: {
          audience: "mission_feed",
          interventionId,
          interventionType: args.interventionType ?? "failed_step",
          source: args.source,
          reasonCode: args.reasonCode,
          title: args.title,
          body: args.body,
          requestedAction: args.requestedAction,
          summary: args.body,
        }
      });
    }

    updateMissionStateDoc(args.runId, {
      pendingInterventions: pendingInterventionsForMission(args.missionId),
    });

    return interventionId;
  };

  const syncMissionStepsFromRun = (graph: OrchestratorRunGraph) => {
    const mission = missionService.get(graph.run.missionId);
    if (!mission) return;
    const missionStepById = new Map(mission.steps.map((step) => [step.id, step]));

    for (const runStep of graph.steps) {
      if (!runStep.missionStepId) continue;
      const missionStep = missionStepById.get(runStep.missionStepId);
      if (!missionStep) continue;
      const nextStatus = mapOrchestratorStepStatus(runStep.status);
      if (missionStep.status === nextStatus) continue;

      const apply = (status: MissionStepStatus) => {
        missionService.updateStep({
          missionId: mission.id,
          stepId: missionStep.id,
          status,
          note: `Synchronized from orchestrator run ${graph.run.id.slice(0, 8)} at ${nowIso()}.`
        });
      };

      try {
        apply(nextStatus);
        // Emit blocked event when a step transitions to blocked
        if (nextStatus === "blocked" && missionStep.status !== "blocked") {
          recordRuntimeEvent({
            runId: graph.run.id,
            stepId: runStep.id,
            eventType: "blocked",
            eventKey: `blocked:${runStep.id}`,
            payload: {
              stepKey: runStep.stepKey,
              previousStatus: missionStep.status
            }
          });
        }
      } catch {
        // A few transitions are stricter on mission steps. Step through running first when needed.
        if (missionStep.status === "pending" && (nextStatus === "succeeded" || nextStatus === "failed")) {
          try {
            apply("running");
          } catch {
            // ignore
          }
          try {
            apply(nextStatus);
          } catch {
            // ignore
          }
        }
      }
    }
  };

  // TERMINAL_PHASE_STEP_STATUSES — imported from missionLifecycle

  const syncMissionPhaseFromRun = (graph: OrchestratorRunGraph, reason: string) => {
    if (!graph.run.missionId) return;
    const target = deriveMissionPhaseSyncTarget(graph);
    if (!target) return;
    updateMissionStateDoc(graph.run.id, {
      updateProgress: {
        currentPhase: target.phaseName,
      },
    }, { graph });
  };

  const syncMissionFromRun = async (
    runId: string,
    reason: string,
    options?: { nextMissionStatus?: MissionStatus | null }
  ) => {
    if (!runId || syncLocks.has(runId)) return;
    syncLocks.add(runId);
    try {
      const graph = orchestratorService.getRunGraph({ runId, timelineLimit: 120 });
      const mission = missionService.get(graph.run.missionId);
      if (!mission) return;

      syncMissionStepsFromRun(graph);
      syncMissionPhaseFromRun(graph, reason);
      const refreshed = missionService.get(mission.id) ?? mission;
      const nextMissionStatus = options?.nextMissionStatus ?? deriveMissionStatusFromRun(graph, refreshed);
      if (nextMissionStatus === "completed") {
        // ── Post-resolution finalization ─────────────────────────────────────
        // If we previously spawned conflict resolution worker steps, this second
        // completion pass means the workers finished. Finalize the integration.
        const pendingCtx = pendingIntegrations.get(runId);
        let skipNormalPrCreation = false;

        if (pendingCtx && prService) {
          pendingIntegrations.delete(runId);
          skipNormalPrCreation = true;
          try {
            // Check if all conflict resolution steps succeeded
            const conflictSteps = graph.steps.filter((s) =>
              pendingCtx.conflictStepKeys.includes(s.stepKey)
            );
            const allResolved = conflictSteps.every((s) => s.status === "succeeded");
            const failedSteps = conflictSteps.filter((s) => s.status !== "succeeded");

            if (!allResolved) {
              const failedNames = failedSteps.map((s) => s.title || s.stepKey);
              emitOrchestratorMessage(
                pendingCtx.missionId,
                `Conflict resolution partially failed. ${failedNames.length} worker(s) did not succeed: ${failedNames.join(", ")}. ` +
                `The integration lane is available for manual resolution.`
              );
              logger.warn("ai_orchestrator.conflict_workers_partial_failure", {
                missionId: pendingCtx.missionId,
                runId,
                totalWorkers: conflictSteps.length,
                failed: failedSteps.length
              });
            } else {
              // Verify all conflicts are truly resolved
              const verifyResults: Array<{ laneId: string; clean: boolean }> = [];
              for (const cStep of conflictSteps) {
                const meta = cStep.metadata as Record<string, unknown> | null;
                const sourceLaneId = meta?.sourceLaneId as string | undefined;
                if (sourceLaneId) {
                  const recheck = await prService.recheckIntegrationStep({
                    proposalId: pendingCtx.proposalId,
                    laneId: sourceLaneId
                  });
                  verifyResults.push({ laneId: sourceLaneId, clean: recheck.resolution === "resolved" || recheck.allResolved });
                }
              }

              const allClean = verifyResults.every((r) => r.clean);

              if (!allClean) {
                emitOrchestratorMessage(
                  pendingCtx.missionId,
                  `Some conflicts remain after worker resolution. Manual intervention may be needed.`
                );
                logger.warn("ai_orchestrator.post_resolution_verify_failed", {
                  missionId: pendingCtx.missionId,
                  runId,
                  results: verifyResults
                });
              } else {
                // All clean — commit integration PR
                emitOrchestratorMessage(pendingCtx.missionId, `All conflicts resolved. Creating integration PR...`);
                const commitResult = await prService.commitIntegration({
                  proposalId: pendingCtx.proposalId,
                  integrationLaneName: pendingCtx.integrationLaneName,
                  title: `[ADE] Integration: ${pendingCtx.missionTitle}`,
                  body: `Automated integration PR for mission "${pendingCtx.missionTitle}".\n\n` +
                        `Lanes: ${pendingCtx.laneIdArray.join(", ")}\n` +
                        `Conflicts auto-resolved by AI workers.`,
                  draft: pendingCtx.isDraft
                });

                emitOrchestratorMessage(
                  pendingCtx.missionId,
                  `Integration PR #${commitResult.pr.githubPrNumber} created (after worker resolution): ${commitResult.pr.githubUrl}`
                );
                logger.info("ai_orchestrator.integration_pr_created_after_workers", {
                  missionId: pendingCtx.missionId,
                  runId,
                  prNumber: commitResult.pr.githubPrNumber,
                  url: commitResult.pr.githubUrl
                });

                // ── open-and-comment: spawn a review worker ──
                if (pendingCtx.prDepth === "open-and-comment") {
                  try {
                    const reviewStepKey = "pr-review-comment";
                    const maxIdx = graph.steps.reduce((max, s) => Math.max(max, s.stepIndex), -1);

                    const reviewSteps = orchestratorService.addPostCompletionSteps({
                      runId,
                      steps: [{
                        stepKey: reviewStepKey,
                        title: "Review and comment on integration PR",
                        stepIndex: maxIdx + 1,
                        laneId: pendingCtx.integrationLaneId,
                        dependencyStepKeys: pendingCtx.conflictStepKeys,
                        retryLimit: 1,
                        metadata: {
                          stepType: "pr-review",
                          prUrl: commitResult.pr.githubUrl,
                          prNumber: commitResult.pr.githubPrNumber,
                          instructions: "Review the PR diff, write a comprehensive summary comment covering: " +
                            "what changed, potential risks, test coverage, and deployment considerations. " +
                            "Use `gh pr comment` to add the review. Do NOT merge or approve — only comment."
                        }
                      }]
                    });

                    // Store updated context for the review step completion
                    pendingIntegrations.set(runId, {
                      ...pendingCtx,
                      reviewStepKey,
                      conflictStepKeys: [] // No more conflict steps to track
                    });

                    emitOrchestratorMessage(
                      pendingCtx.missionId,
                      `PR created. Spawning review worker to add summary comment...`
                    );
                    logger.info("ai_orchestrator.pr_review_worker_spawned", {
                      missionId: pendingCtx.missionId,
                      runId,
                      reviewStepId: reviewSteps[0]?.id
                    });

                    // Run reopened by addPostCompletionSteps — don't transition to completed
                    return;
                  } catch (reviewError) {
                    // Review worker spawn failed — not critical, PR is already created
                    logger.warn("ai_orchestrator.pr_review_worker_failed", {
                      missionId: pendingCtx.missionId,
                      runId,
                      error: reviewError instanceof Error ? reviewError.message : String(reviewError)
                    });
                    emitOrchestratorMessage(
                      pendingCtx.missionId,
                      `PR created successfully but review comment worker could not be spawned: ${reviewError instanceof Error ? reviewError.message : String(reviewError)}`
                    );
                  }
                }
              }
            }
          } catch (finalizationError) {
            logger.warn("ai_orchestrator.post_resolution_finalization_failed", {
              missionId: pendingCtx.missionId,
              runId,
              error: finalizationError instanceof Error ? finalizationError.message : String(finalizationError)
            });
            emitOrchestratorMessage(
              pendingCtx.missionId,
              `Post-resolution finalization failed: ${finalizationError instanceof Error ? finalizationError.message : String(finalizationError)}. ` +
              `The integration lane is available for manual resolution.`
            );
          }
        }

        // ── PR Creation at Run End (strategy-driven) ──────────────────────────
        // Skip if we already handled integration via the post-resolution path above.
        // The mission transition to "completed" is deferred until AFTER PR creation
        // because the conflict pipeline may spawn workers that reopen the run.
        let workersSpawned = false;
        const { settings: runPhaseSettings } = resolveActivePhaseSettings(mission.id);
        const integrationPrPolicy = runPhaseSettings.integrationPr ?? DEFAULT_INTEGRATION_PR_POLICY;
        const laneIdArrayBase = [...new Set(graph.steps.map((s) => s.laneId).filter(Boolean))] as string[];
        const missionLaneId = resolvePersistedMissionLaneIdForRun(runId) ?? toOptionalString(mission.laneId);
        if (laneIdArrayBase.length === 0 && missionLaneId) laneIdArrayBase.push(missionLaneId);
        const prStrategy: PrStrategy =
          runPhaseSettings.prStrategy
          ?? { kind: "manual" };
        const finalizationPolicy = resolveMissionFinalizationPolicy(prStrategy);
        const missionBaseBranch = await resolveMissionBaseBranch(mission.id);

        if (skipNormalPrCreation) {
          // Already handled via post-resolution path
        } else try {
          await updateMissionFinalizationState(runId, {
            policy: finalizationPolicy,
            status: prStrategy.kind === "manual" ? "completed" : "finalizing",
            executionComplete: true,
            contractSatisfied: prStrategy.kind === "manual",
            blocked: false,
            summary: prStrategy.kind === "manual"
              ? "Execution completed. PR handling is manual for this mission."
              : "Execution completed. ADE is now running the selected finalization contract.",
            detail: finalizationPolicy.description,
            warnings: [],
            completedAt: prStrategy.kind === "manual" ? nowIso() : null,
          }, { graph });

          if (prStrategy.kind === "manual") {
            logger.debug("ai_orchestrator.pr_strategy_manual", { missionId: mission.id, runId });
          } else if (prStrategy.kind === "integration" && prService) {
            await updateMissionFinalizationState(runId, {
              policy: finalizationPolicy,
              status: "creating_pr",
              executionComplete: true,
              contractSatisfied: false,
              blocked: false,
              summary: "Execution finished. Creating integration PR before mission completion.",
              detail: `Base branch: ${prStrategy.targetBranch ?? missionBaseBranch ?? "main"}`,
              warnings: [],
            }, { graph });
            try {
              const laneIdArray = laneIdArrayBase;
              const integrationLaneName = `integration/${mission.id.slice(0, 8)}`;
              const baseBranch = prStrategy.targetBranch ?? missionBaseBranch ?? "main";
              const isDraft = prStrategy.draft ?? integrationPrPolicy.draft ?? true;

              const prResult = await prService.createIntegrationPr({
                sourceLaneIds: laneIdArray,
                integrationLaneName,
                baseBranch,
                title: `[ADE] Integration: ${mission.title}`,
                body: `Automated integration PR for mission "${mission.title}".\n\nLanes: ${laneIdArray.join(", ")}`,
                draft: isDraft
              });

              emitOrchestratorMessage(
                mission.id,
                `Integration PR #${prResult.pr.githubPrNumber} created: ${prResult.pr.githubUrl}`
              );
              logger.info("ai_orchestrator.integration_pr_created", {
                missionId: mission.id,
                runId,
                prNumber: prResult.pr.githubPrNumber,
                url: prResult.pr.githubUrl
              });
              await updateMissionFinalizationState(runId, {
                policy: finalizationPolicy,
                status: "completed",
                executionComplete: true,
                contractSatisfied: true,
                blocked: false,
                prUrls: [prResult.pr.githubUrl],
                mergeReadiness: "operator_review_required",
                summary: "Execution and integration PR creation completed.",
                detail: `Integration PR ${prResult.pr.githubUrl} created.`,
                warnings: [],
                completedAt: nowIso(),
              }, { graph });
            } catch (prError) {
              const prDepth = prStrategy.prDepth
                ?? integrationPrPolicy.prDepth
                ?? "resolve-conflicts";
              const laneIdArray = laneIdArrayBase;
              const baseBranch = prStrategy.targetBranch ?? missionBaseBranch ?? "main";
              const isDraft = prStrategy.draft ?? integrationPrPolicy.draft ?? true;
              const integrationLaneName = `integration/${mission.id.slice(0, 8)}`;

              if (prDepth === "propose-only" || !conflictService || !laneService) {
                throw prError;
              }

              const targetLane = (await laneService.list({ includeArchived: false })).find((lane) => {
                const branchRef = normalizeBranchName(lane.branchRef);
                const laneBaseRef = normalizeBranchName(lane.baseRef);
                const desired = normalizeBranchName(baseBranch);
                return lane.id === baseBranch || branchRef === desired || laneBaseRef === desired;
              });
              if (!targetLane) {
                throw new Error(`No lane is available for base branch "${baseBranch}".`);
              }

              const resolverModelId = integrationPrPolicy.conflictResolverModel ?? null;
              const resolverDescriptor = resolverModelId ? getModelById(resolverModelId) : null;
              const resolverProvider = resolverDescriptor?.family === "openai" ? "codex" : "claude";

              await updateMissionFinalizationState(runId, {
                policy: resolveMissionFinalizationPolicy(prStrategy),
                status: "resolving_integration_conflicts",
                executionComplete: true,
                contractSatisfied: false,
                blocked: false,
                summary: "Execution finished. ADE is resolving integration conflicts before closeout can complete.",
                detail: prError instanceof Error ? prError.message : String(prError),
                warnings: [],
              }, { graph });
              emitOrchestratorMessage(
                mission.id,
                `Integration PR creation hit conflicts. Launching shared resolver on integration lane "${integrationLaneName}" before finalization can complete.`
              );

              const resolverRun = await conflictService.runExternalResolver({
                provider: resolverProvider,
                targetLaneId: targetLane.id,
                sourceLaneIds: laneIdArray,
                integrationLaneName,
              });
              if (resolverRun.status !== "completed" || !resolverRun.integrationLaneId) {
                throw new Error(resolverRun.error ?? "Shared conflict resolver did not complete successfully.");
              }

              await updateMissionFinalizationState(runId, {
                policy: resolveMissionFinalizationPolicy(prStrategy),
                status: "creating_pr",
                executionComplete: true,
                contractSatisfied: false,
                blocked: false,
                resolverJobId: resolverRun.runId,
                integrationLaneId: resolverRun.integrationLaneId,
                detail: resolverRun.summary ?? "Conflict resolution completed. Creating integration PR.",
                warnings: resolverRun.warnings,
              }, { graph });

              const resolvedPr = await prService.createFromLane({
                laneId: resolverRun.integrationLaneId,
                title: `[ADE] Integration: ${mission.title}`,
                body: `Automated integration PR for mission "${mission.title}".\n\nLanes: ${laneIdArray.join(", ")}\n\nResolved via the shared ADE conflict resolver job ${resolverRun.runId}.`,
                draft: isDraft,
                baseBranch,
              });

              if (prDepth === "open-and-comment") {
                await updateMissionFinalizationState(runId, {
                  policy: resolveMissionFinalizationPolicy(prStrategy),
                  status: "posting_review_comment",
                  executionComplete: true,
                  contractSatisfied: false,
                  blocked: false,
                  resolverJobId: resolverRun.runId,
                  integrationLaneId: resolverRun.integrationLaneId,
                  prUrls: [resolvedPr.githubUrl],
                }, { graph });
                await prService.addComment({
                  prId: resolvedPr.id,
                  body: [
                    `ADE finalization summary for mission "${mission.title}":`,
                    "",
                    `- Integration conflicts were resolved by shared resolver job \`${resolverRun.runId}\`.`,
                    `- Changed files: ${resolverRun.changedFiles.length > 0 ? resolverRun.changedFiles.join(", ") : "not reported"}.`,
                    `- Review this PR before landing. This mission is complete, but follow-up work should start as a continuation.`,
                  ].join("\n"),
                });
              }

              emitOrchestratorMessage(
                mission.id,
                `Integration PR #${resolvedPr.githubPrNumber} created after shared conflict resolution: ${resolvedPr.githubUrl}`
              );
              logger.info("ai_orchestrator.integration_pr_created_via_shared_resolver", {
                missionId: mission.id,
                runId,
                resolverRunId: resolverRun.runId,
                prNumber: resolvedPr.githubPrNumber,
                url: resolvedPr.githubUrl
              });
              await updateMissionFinalizationState(runId, {
                policy: resolveMissionFinalizationPolicy(prStrategy),
                status: "completed",
                executionComplete: true,
                contractSatisfied: true,
                blocked: false,
                resolverJobId: resolverRun.runId,
                integrationLaneId: resolverRun.integrationLaneId,
                prUrls: [resolvedPr.githubUrl],
                reviewStatus: prDepth === "open-and-comment" ? "comment_posted" : null,
                mergeReadiness: "operator_review_required",
                summary: "Execution and PR finalization completed.",
                detail: `Integration PR ${resolvedPr.githubUrl} created via shared resolver job ${resolverRun.runId}.`,
                warnings: resolverRun.warnings,
                completedAt: nowIso(),
              }, { graph });
            }
          } else if (prStrategy.kind === "per-lane" && prService) {
            try {
              const laneIdArray = laneIdArrayBase;
              const baseBranch = prStrategy.targetBranch ?? missionBaseBranch ?? "main";
              const isDraft = prStrategy.draft ?? true;
              const createdPrUrls: string[] = [];
              const laneFailures: string[] = [];

              for (const laneId of laneIdArray) {
                try {
                  const prResult = await prService.createIntegrationPr({
                    sourceLaneIds: [laneId],
                    integrationLaneName: laneId,
                    baseBranch,
                    title: `[ADE] Lane ${laneId}: ${mission.title}`,
                    body: `Per-lane PR for lane "${laneId}" of mission "${mission.title}".`,
                    draft: isDraft
                  });
                  emitOrchestratorMessage(
                    mission.id,
                    `Per-lane PR #${prResult.pr.githubPrNumber} for ${laneId}: ${prResult.pr.githubUrl}`
                  );
                  logger.info("ai_orchestrator.per_lane_pr_created", {
                    missionId: mission.id,
                    runId,
                    laneId,
                    prNumber: prResult.pr.githubPrNumber,
                    url: prResult.pr.githubUrl
                  });
                  createdPrUrls.push(prResult.pr.githubUrl);
                } catch (lanePrError) {
                  logger.warn("ai_orchestrator.per_lane_pr_failed", {
                    missionId: mission.id,
                    runId,
                    laneId,
                    error: lanePrError instanceof Error ? lanePrError.message : String(lanePrError)
                  });
                  emitOrchestratorMessage(
                    mission.id,
                    `Per-lane PR for ${laneId} failed: ${lanePrError instanceof Error ? lanePrError.message : String(lanePrError)}`
                  );
                  laneFailures.push(`${laneId}: ${lanePrError instanceof Error ? lanePrError.message : String(lanePrError)}`);
                }
              }
              if (laneFailures.length > 0) {
                await updateMissionFinalizationState(runId, {
                  policy: finalizationPolicy,
                  status: "finalization_failed",
                  executionComplete: true,
                  contractSatisfied: false,
                  blocked: true,
                  blockedReason: laneFailures.join("; "),
                  prUrls: createdPrUrls,
                  summary: "Per-lane PR finalization did not complete successfully.",
                  detail: laneFailures.join("\n"),
                  warnings: [],
                }, { graph });
              } else {
                await updateMissionFinalizationState(runId, {
                  policy: finalizationPolicy,
                  status: "completed",
                  executionComplete: true,
                  contractSatisfied: true,
                  blocked: false,
                  prUrls: createdPrUrls,
                  mergeReadiness: "operator_review_required",
                  summary: "Execution and per-lane PR creation completed.",
                  detail: `${createdPrUrls.length} PR(s) created.`,
                  warnings: [],
                  completedAt: nowIso(),
                }, { graph });
              }
            } catch (perLaneError) {
              logger.warn("ai_orchestrator.per_lane_pr_batch_failed", {
                missionId: mission.id,
                runId,
                error: perLaneError instanceof Error ? perLaneError.message : String(perLaneError)
              });
              await updateMissionFinalizationState(runId, {
                policy: finalizationPolicy,
                status: "finalization_failed",
                executionComplete: true,
                contractSatisfied: false,
                blocked: true,
                blockedReason: perLaneError instanceof Error ? perLaneError.message : String(perLaneError),
                summary: "Per-lane PR finalization failed.",
                detail: perLaneError instanceof Error ? perLaneError.message : String(perLaneError),
                warnings: [],
              }, { graph });
            }
          } else if (prStrategy.kind === "queue" && prService) {
            try {
              const laneIdArray = laneIdArrayBase;
              const targetBranch = prStrategy.targetBranch ?? missionBaseBranch ?? "main";
              const autoLandQueue = prStrategy.autoLand ?? false;
              const autoResolveQueueConflicts = prStrategy.autoResolveConflicts ?? false;
              const queueMergeMethod = prStrategy.mergeMethod ?? "squash";
              const resolverModelId = prStrategy.conflictResolverModel ?? integrationPrPolicy.conflictResolverModel ?? null;
              const resolverDescriptor = resolverModelId ? getModelById(resolverModelId) : null;
              const resolverProvider = resolverDescriptor?.family === "anthropic" ? "claude" : resolverModelId ? "codex" : null;

              const queueResult = await prService.createQueuePrs({
                laneIds: laneIdArray,
                targetBranch,
                draft: prStrategy.draft ?? true,
                autoRebase: prStrategy.autoRebase ?? true,
                ciGating: prStrategy.ciGating ?? false
              });

              for (const pr of queueResult.prs) {
                emitOrchestratorMessage(
                  mission.id,
                  `Queue PR #${pr.githubPrNumber} created: ${pr.githubUrl}`
                );
              }
              for (const err of queueResult.errors) {
                emitOrchestratorMessage(
                  mission.id,
                  `Queue PR for ${err.laneId} failed: ${err.error}`
                );
              }
              logger.info("ai_orchestrator.queue_prs_created", {
                missionId: mission.id,
                runId,
                groupId: queueResult.groupId,
                prCount: queueResult.prs.length,
                errorCount: queueResult.errors.length
              });
              if (queueResult.errors.length > 0) {
                await updateMissionFinalizationState(runId, {
                  policy: finalizationPolicy,
                  status: "finalization_failed",
                  executionComplete: true,
                  contractSatisfied: false,
                  blocked: true,
                  blockedReason: queueResult.errors.map((entry) => `${entry.laneId}: ${entry.error}`).join("; "),
                  queueGroupId: queueResult.groupId,
                  prUrls: queueResult.prs.map((entry) => entry.githubUrl),
                  summary: "Queue PR finalization failed for one or more lanes.",
                  detail: queueResult.errors.map((entry) => `${entry.laneId}: ${entry.error}`).join("\n"),
                  warnings: [],
                }, { graph });
              } else if (autoLandQueue && queueLandingService) {
                await updateMissionFinalizationState(runId, {
                  policy: finalizationPolicy,
                  status: "landing_queue",
                  executionComplete: true,
                  contractSatisfied: false,
                  blocked: false,
                  queueGroupId: queueResult.groupId,
                  prUrls: queueResult.prs.map((entry) => entry.githubUrl),
                  mergeReadiness: prStrategy.ciGating ? "waiting_for_green" : "queue_landing",
                  summary: "Execution finished. Queue landing has started and must complete before the mission can close out.",
                  detail: `Queue group ${queueResult.groupId} created with ${queueResult.prs.length} PR(s).`,
                  warnings: [],
                }, { graph });
                await queueLandingService.startQueue({
                  groupId: queueResult.groupId,
                  method: queueMergeMethod,
                  archiveLane: prStrategy.archiveLaneOnLand ?? false,
                  autoResolve: autoResolveQueueConflicts,
                  ciGating: prStrategy.ciGating ?? false,
                  resolverProvider,
                  resolverModel: resolverModelId,
                  reasoningEffort: prStrategy.reasoningEffort ?? null,
                  permissionMode: prStrategy.permissionMode ?? "guarded_edit",
                  originSurface: "mission",
                  originMissionId: mission.id,
                  originRunId: runId,
                  originLabel: mission.title,
                });
              } else {
                await updateMissionFinalizationState(runId, {
                  policy: finalizationPolicy,
                  status: "completed",
                  executionComplete: true,
                  contractSatisfied: true,
                  blocked: false,
                  queueGroupId: queueResult.groupId,
                  prUrls: queueResult.prs.map((entry) => entry.githubUrl),
                  mergeReadiness: prStrategy.ciGating ? "waiting_for_green" : "operator_review_required",
                  summary: "Execution and queue PR creation completed.",
                  detail: `Queue group ${queueResult.groupId} created with ${queueResult.prs.length} PR(s). Queue landing remains operator-driven.`,
                  warnings: [],
                  completedAt: nowIso(),
                }, { graph });
              }
            } catch (queueError) {
              logger.warn("ai_orchestrator.queue_pr_creation_failed", {
                missionId: mission.id,
                runId,
                error: queueError instanceof Error ? queueError.message : String(queueError)
              });
              emitOrchestratorMessage(
                mission.id,
                `Queue PR creation failed: ${queueError instanceof Error ? queueError.message : String(queueError)}`
              );
              await updateMissionFinalizationState(runId, {
                policy: finalizationPolicy,
                status: "finalization_failed",
                executionComplete: true,
                contractSatisfied: false,
                blocked: true,
                blockedReason: queueError instanceof Error ? queueError.message : String(queueError),
                summary: "Queue PR finalization failed.",
                detail: queueError instanceof Error ? queueError.message : String(queueError),
                warnings: [],
              }, { graph });
            }
          }
        } catch (prStrategyError) {
          const finalizationErrorMessage = prStrategyError instanceof Error ? prStrategyError.message : String(prStrategyError);
          logger.debug("ai_orchestrator.pr_strategy_trigger_failed", {
            runId,
            missionId: mission.id,
            error: finalizationErrorMessage
          });
          await updateMissionFinalizationState(runId, {
            policy: resolveMissionFinalizationPolicy(resolveActivePhaseSettings(mission.id).settings.prStrategy ?? { kind: "manual" }),
            status: "finalization_failed",
            executionComplete: true,
            contractSatisfied: false,
            blocked: true,
            blockedReason: finalizationErrorMessage,
            summary: "Mission finalization failed.",
            detail: finalizationErrorMessage,
            warnings: [],
          }, { graph });
          transitionMissionStatus(mission.id, "failed", {
            lastError: finalizationErrorMessage,
          });
        }

        // Deferred mission completion: only transition to "completed" if no
        // conflict resolution workers were spawned. When workers ARE spawned,
        // the run was reopened (succeeded → running) and the mission should
        // stay in_progress until the workers complete.
        let stateDocAfterFinalization = projectRoot
          ? await readMissionStateDocument({ projectRoot, runId }).catch(() => null)
          : null;
        if (stateDocAfterFinalization?.finalization) {
          const closeoutRequirements = buildMissionCloseoutRequirements({
            mission,
            graph,
            policy: stateDocAfterFinalization.finalization.policy,
            finalization: stateDocAfterFinalization.finalization,
            stateDoc: stateDocAfterFinalization,
          });
          const unmetRequirements = closeoutRequirements.filter((requirement) =>
            requirement.required
            && requirement.status !== "present"
            && requirement.status !== "waived"
          );
          await updateMissionFinalizationState(runId, {
            policy: stateDocAfterFinalization.finalization.policy,
            status: unmetRequirements.length > 0 && stateDocAfterFinalization.finalization.status === "completed"
              ? "finalizing"
              : stateDocAfterFinalization.finalization.status,
            executionComplete: true,
            contractSatisfied: stateDocAfterFinalization.finalization.contractSatisfied && unmetRequirements.length === 0,
            requirements: closeoutRequirements,
            summary: unmetRequirements.length > 0
              ? "Execution finished, but the closeout contract is still incomplete."
              : stateDocAfterFinalization.finalization.summary,
            detail: unmetRequirements.length > 0
              ? unmetRequirements.map((requirement) => requirement.label).join(", ")
              : stateDocAfterFinalization.finalization.detail,
            completedAt: unmetRequirements.length > 0 ? null : stateDocAfterFinalization.finalization.completedAt,
          }, { graph });
          stateDocAfterFinalization = projectRoot
            ? await readMissionStateDocument({ projectRoot, runId }).catch(() => null)
            : stateDocAfterFinalization;
        }
        const finalizationSatisfied = stateDocAfterFinalization?.finalization?.contractSatisfied ?? (prStrategy.kind === "manual");
        const finalizationFailed = stateDocAfterFinalization?.finalization?.status === "finalization_failed";
        if (finalizationFailed) {
          transitionMissionStatus(mission.id, "failed", {
            lastError: stateDocAfterFinalization?.finalization?.blockedReason ?? stateDocAfterFinalization?.finalization?.detail ?? "Mission finalization failed."
          });
        } else if (!workersSpawned && finalizationSatisfied) {
          transitionMissionStatus(mission.id, "completed", {
            outcomeSummary: refreshed.outcomeSummary ?? buildOutcomeSummary(graph),
            lastError: null
          });
        }
      } else if (nextMissionStatus === "failed") {
        transitionMissionStatus(mission.id, "failed", {
          lastError: extractRunFailureMessage(graph)
        });
      } else {
        transitionMissionStatus(mission.id, nextMissionStatus);
      }
      logger.debug("ai_orchestrator.sync_completed", {
        missionId: mission.id,
        runId,
        reason,
        runStatus: graph.run.status,
        missionStatus: nextMissionStatus
      });
      const runCompleted =
        graph.run.status === "succeeded" ||
        graph.run.status === "failed" ||
        graph.run.status === "canceled";
      if (runCompleted) {
        cleanupCoordinatorCheckpointFile(runId, "terminal_status_sync");
        // Emit the "done" runtime bus event for run completion
        recordRuntimeEvent({
          runId,
          eventType: "done",
          eventKey: `done:${runId}`,
          payload: {
            runStatus: graph.run.status,
            missionStatus: nextMissionStatus,
            stepsSucceeded: graph.steps.filter((s) => s.status === "succeeded").length,
            stepsFailed: graph.steps.filter((s) => s.status === "failed").length,
            stepsTotal: graph.steps.length
          }
        });
        purgeRunMaps(runId);
        runRuntimeProfiles.delete(runId);
        activeHealthSweepRuns.delete(runId);
        for (const [attemptId, state] of workerStates.entries()) {
          if (state.runId !== runId) continue;
          // Preserve terminal worker states (completed/failed) so that
          // callers can still read them after the run finishes.  Only
          // discard active (working/initializing) entries and always
          // clean up the runtime tracker / persisted state.
          attemptRuntimeTrackers.delete(attemptId);
          deletePersistedAttemptRuntimeState(attemptId);
          if (state.state !== "completed" && state.state !== "failed") {
            workerStates.delete(attemptId);
          }
        }

        // Clean up mission-keyed in-memory maps when mission reaches a terminal state.
        const missionTerminal =
          nextMissionStatus === "completed" ||
          nextMissionStatus === "failed" ||
          nextMissionStatus === "canceled";
        if (missionTerminal) {
          const mid = mission.id;
          chatMessages.delete(mid);
          activeSteeringDirectives.delete(mid);
          activeChatSessions.delete(mid);
          chatTurnQueues.delete(mid);
        }
      }
    } catch (error) {
      logger.warn("ai_orchestrator.sync_failed", {
        runId,
        reason,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      syncLocks.delete(runId);
    }
  };

  // ── Project Docs Discovery ──────────────────────────────────
  const discoverProjectDocs = () => discoverProjectDocsCtx(ctx);
  const resolveActivePolicy = (missionId: string) => resolveActivePolicyCtx(ctx, missionId);

  const startMissionRun = async (args: MissionRunStartArgs): Promise<MissionRunStartResult> => {
    const missionId = String(args.missionId ?? "").trim();
    if (!missionId.length) throw new Error("missionId is required.");
    const initialMission = missionService.get(missionId);
    if (!initialMission) throw new Error(`Mission not found: ${missionId}`);

    const missionGoal = initialMission.prompt || initialMission.title;

    const missionMetadata = getMissionMetadata(missionId);
    const launchMetadata = isRecord(missionMetadata.launch) ? missionMetadata.launch : null;
    const launchTeamRuntime = isRecord(launchMetadata?.teamRuntime) ? launchMetadata.teamRuntime : null;
    const launchAgentRuntime = isRecord(launchMetadata?.agentRuntime)
      ? launchMetadata.agentRuntime
      : {
          allowParallelAgents: true,
          allowSubAgents: true,
          allowClaudeAgentTeams: true
        };
    const launchEmployeeAgentId =
      typeof launchMetadata?.employeeAgentId === "string" && launchMetadata.employeeAgentId.trim().length > 0
        ? launchMetadata.employeeAgentId.trim()
        : null;
    const missionAfterPlanning = missionService.get(missionId);
    const missionMetadataAfterPlanning = getMissionMetadata(missionId);
    const missionPhaseConfiguration = isRecord(missionMetadataAfterPlanning.phaseConfiguration)
      ? missionMetadataAfterPlanning.phaseConfiguration
      : null;
    const missionLevelSettings = isRecord(missionMetadataAfterPlanning.missionLevelSettings)
      ? missionMetadataAfterPlanning.missionLevelSettings
      : null;
    const plannerPlanMeta = isRecord(missionMetadataAfterPlanning.plannerPlan)
      ? missionMetadataAfterPlanning.plannerPlan
      : null;
    const plannerSummary = plannerPlanMeta && isRecord(plannerPlanMeta.missionSummary)
      ? plannerPlanMeta.missionSummary
      : null;
    const plannerParallelismRaw = Number(plannerSummary?.parallelismCap ?? Number.NaN);
    const plannerParallelismCap = Number.isFinite(plannerParallelismRaw) && plannerParallelismRaw > 0
      ? Math.floor(plannerParallelismRaw)
      : null;
    const launchMaxParallelRaw = Number(launchMetadata?.maxParallelWorkers ?? Number.NaN);
    const launchMaxParallel = Number.isFinite(launchMaxParallelRaw) && launchMaxParallelRaw > 0
      ? Math.floor(launchMaxParallelRaw)
      : null;
    const requestedRunMode = args.runMode === "manual" ? "manual" : "autopilot";
    const requestedExecutorKind: OrchestratorExecutorKind =
      args.defaultExecutorKind === "manual" || args.defaultExecutorKind === "shell" || args.defaultExecutorKind === "unified"
        ? args.defaultExecutorKind
        : "unified";
    const autopilotExecutorKind: OrchestratorExecutorKind =
      requestedRunMode === "manual"
        ? "manual"
        : requestedExecutorKind === "manual"
          ? "unified"
          : requestedExecutorKind;
    const autopilotEnabled = requestedRunMode === "autopilot" && autopilotExecutorKind !== "manual";
    const autopilotOwnerId = String(args.autopilotOwnerId ?? "").trim() || "orchestrator-autopilot";
    const runParallelismCap = Math.max(
      1,
      Math.min(
        32,
        launchAgentRuntime.allowParallelAgents === false
          ? 1
          : plannerParallelismCap ?? launchMaxParallel ?? 4
      )
    );
    const {
      userRules,
      projectCtx: coordinatorProjectContext,
      availableProviders,
      phases,
    } = gatherCoordinatorContext(missionId, args);
    const missionProjectId = resolveMissionProjectId(missionId);
    const knowledgeStatus = await humanWorkDigestService?.getKnowledgeSyncStatus?.().catch(() => null) ?? null;
    if (knowledgeStatus?.diverged) {
      await humanWorkDigestService?.syncKnowledge?.();
    }
    const activePolicy = resolveActivePolicy(missionId);
    const sortedPhases = [...phases].sort((a, b) => a.position - b.position);
    const runtimePhases = activePolicy.planning.mode === "off"
      ? sortedPhases.filter((phase) => phase.phaseKey.trim().toLowerCase() !== "planning")
      : sortedPhases;
    const effectivePhases = runtimePhases.length > 0 ? runtimePhases : sortedPhases;
    const initialPhase = effectivePhases[0] ?? null;
    const phaseRuntime = initialPhase
      ? {
          currentPhaseKey: initialPhase.phaseKey,
          currentPhaseName: initialPhase.name,
          currentPhaseModel: initialPhase.model,
          currentPhaseInstructions: initialPhase.instructions,
          currentPhaseValidation: initialPhase.validationGate,
          currentPhaseBudget: initialPhase.budget ?? {},
          transitionedAt: nowIso(),
          transitions: [
            {
              fromPhaseKey: null,
              fromPhaseName: null,
              toPhaseKey: initialPhase.phaseKey,
              toPhaseName: initialPhase.name,
              at: nowIso(),
              reason: "run_initialized"
            }
          ],
          phaseBudgets: {
            [initialPhase.phaseKey]: {
              enteredAt: nowIso(),
              usedTokens: 0,
              usedCostUsd: 0
            }
          }
        }
      : undefined;

    let startupStage: MissionLaunchFailureStage = "run_created";
    let started: { run: OrchestratorRun; steps: OrchestratorStep[] } | null = null;

    try {
      // ── Create run — just persistence, no planning ──
      started = orchestratorService.startRun({
        missionId,
        steps: [],
        metadata: {
          ...(args.metadata ?? {}),
          missionGoal,
          missionPrompt: initialMission.prompt ?? "",
          runMode: requestedRunMode,
          maxParallelWorkers: runParallelismCap,
          planner: {
            source: "mission_planner",
            stepCount: missionAfterPlanning?.steps.length ?? 0,
            strategy: typeof plannerSummary?.strategy === "string" ? plannerSummary.strategy : null,
            parallelismCap: runParallelismCap,
          },
          autopilot: {
            enabled: autopilotEnabled,
            executorKind: autopilotEnabled ? autopilotExecutorKind : "manual",
            ownerId: autopilotOwnerId,
            parallelismCap: runParallelismCap,
          },
          ...(launchEmployeeAgentId ? { employeeAgentId: launchEmployeeAgentId } : {}),
          teamRuntime: launchTeamRuntime
            ? {
                ...launchTeamRuntime,
                ...normalizeAgentRuntimeFlags(launchTeamRuntime)
              }
            : undefined,
          agentRuntime: normalizeAgentRuntimeFlags(launchAgentRuntime),
          aiFirst: true,
          ...(missionLevelSettings ? { missionLevelSettings } : {}),
          ...(missionPhaseConfiguration ? { phaseConfiguration: missionPhaseConfiguration } : {}),
          phaseOverride: effectivePhases,
          phaseProfileId: typeof missionPhaseConfiguration?.profileId === "string"
            ? missionPhaseConfiguration.profileId
            : null,
          ...(phaseRuntime ? { phaseRuntime } : {}),
        }
      });
      if (!started) {
        throw new Error("Mission run failed to start.");
      }
      const startedRun = started.run;
      const startedRunId = startedRun.id;
      // Transition mission to in_progress early so that failure paths
      // (lane creation, coordinator startup) can move it to intervention_required.
      // The queued -> intervention_required transition is not allowed.
      transitionMissionStatus(missionId, "in_progress");

      emitCoordinatorLifecycle({
        missionId,
        runId: startedRunId,
        state: "booting",
        message: "I’m online and getting the run ready.",
      });

      startupStage = "memory_init";
      if (missionMemoryLifecycleService && missionProjectId.length > 0) {
        missionMemoryLifecycleService.startMission({
          projectId: missionProjectId,
          missionId,
          runId: startedRunId,
          initialDecision: initialMission.prompt ?? initialMission.title,
        });
      }

      startupStage = "lane_create";
      const missionLaneId = await ensureMissionLaneForRun({
        runId: startedRunId,
        missionId,
        missionTitle: initialMission.title,
      });
      if (!missionLaneId) {
        pauseRunWithIntervention({
          runId: startedRunId,
          missionId,
          source: "transition_decision",
          reasonCode: "mission_lane_unavailable",
          title: "Mission lane isolation failed",
          body: "ADE could not create or recover the dedicated mission lane/worktree for this run. The mission has been paused so work does not proceed in an unsafe lane.",
          requestedAction: "Fix lane/worktree health, then resume the run to retry mission activation.",
          metadata: {
            startupPath: "start_mission_run",
            isolationRequired: true,
          }
        });
        const blockedRun = orchestratorService.listRuns({ limit: 1_000 }).find((entry) => entry.id === startedRunId) ?? startedRun;
        return {
          started: {
            run: blockedRun,
            steps: orchestratorService.listSteps(startedRunId),
          },
          mission: missionService.get(missionId),
        };
      }

      startupStage = "coordinator_start";
      emitCoordinatorLifecycle({
        missionId,
        runId: startedRunId,
        state: "analyzing_prompt",
        message: "I’m reading your prompt and sizing up the work.",
      });
      const coordinatorModelConfig = resolveOrchestratorModelConfig(missionId, "coordinator");
      const coordinatorAgent = startCoordinatorAgentV2(missionId, startedRunId, missionGoal, coordinatorModelConfig, {
        userRules,
        projectContext: coordinatorProjectContext,
        availableProviders,
        phases: effectivePhases,
        missionLaneId,
      });
      if (!coordinatorAgent?.isAlive) {
        pauseRunWithIntervention({
          runId: startedRunId,
          missionId,
          source: "transition_decision",
          reasonCode: "coordinator_start_failed",
          title: "Coordinator startup failed",
          body: "Coordinator runtime did not start successfully. Mission activation and autopilot were blocked to prevent non-autonomous fallback behavior.",
          requestedAction: "Resolve coordinator startup health, then resume the run.",
          metadata: {
            startupPath: "start_mission_run"
          }
        });
        const failedRun = orchestratorService.listRuns({ limit: 1_000 }).find((entry) => entry.id === startedRunId) ?? startedRun;
        return {
          started: {
            run: failedRun,
            steps: orchestratorService.listSteps(startedRunId)
          },
          mission: missionService.get(missionId),
        };
      }

      startupStage = "run_activate";
      const activatedRun = orchestratorService.activateRun(startedRunId);
      transitionMissionStatus(missionId, "in_progress");
      if (initialPhase?.phaseKey.trim().toLowerCase() !== "planning") {
        emitOrchestratorMessage(
          missionId,
          "I’m ready and moving into the first task.",
          null,
          {
            role: "coordinator_v2",
            runId: startedRunId,
            source: "coordinator_lifecycle",
          },
        );
      }

      const initialGraph = getRunGraphSafe(started.run.id);
      updateMissionStateDoc(
        started.run.id,
        {
          ...(initialGraph ? { updateProgress: buildMissionStateProgressFromGraph(initialGraph) } : {}),
          pendingInterventions: pendingInterventionsForMission(missionId),
        },
        { graph: initialGraph }
      );

      void syncMissionFromRun(started.run.id, "mission_run_started");

      return {
        started: {
          run: activatedRun,
          steps: orchestratorService.listSteps(started.run.id),
        },
        mission: missionService.get(missionId),
      };
    } catch (error) {
      if (started?.run.id) {
        const launchFailureMetadata = buildMissionLaunchFailureMetadata({
          runId: started.run.id,
          failureStage: startupStage,
          error,
        });
        persistRunLaunchFailureMetadata(started.run.id, launchFailureMetadata);
        pauseRunWithIntervention({
          runId: started.run.id,
          missionId,
          source: "transition_decision",
          interventionType: "unrecoverable_error",
          reasonCode: MISSION_LAUNCH_FAILURE_REASON_CODE,
          title: "Mission launch failed",
          body: toMissionLaunchFailureBody({ failureStage: startupStage, error }),
          requestedAction: "Review the launch failure details, fix the runtime or configuration issue, then restart the mission run.",
          metadata: launchFailureMetadata,
        });
        throw toMissionLaunchFailureError(error, launchFailureMetadata);
      }
      throw error;
    }
  };

  /** Gather user rules, project context, and available providers for the coordinator. */
  const gatherCoordinatorContext = (missionId: string, args: MissionRunStartArgs) => {
    // Extract user rules from mission metadata / launch config
    const missionMeta = getMissionMetadata(missionId);
    const launch = isRecord(missionMeta?.launch) ? missionMeta.launch as Record<string, unknown> : {};

    const userRules: import("./coordinatorAgent").CoordinatorUserRules = {};
    if (typeof launch.providerPreference === "string") userRules.providerPreference = launch.providerPreference;
    if (typeof launch.costMode === "string") userRules.costMode = launch.costMode;
    if (typeof launch.maxParallelWorkers === "number") userRules.maxParallelWorkers = launch.maxParallelWorkers;
    const agentRuntime = isRecord(launch.agentRuntime) ? launch.agentRuntime : null;
    if (agentRuntime) {
      const flags = normalizeAgentRuntimeFlags(agentRuntime as Partial<import("../../../shared/types").MissionAgentRuntimeConfig>);
      userRules.allowParallelAgents = flags.allowParallelAgents;
      userRules.allowSubAgents = flags.allowSubAgents;
      userRules.allowClaudeAgentTeams = flags.allowClaudeAgentTeams;
      if (agentRuntime.allowParallelAgents === false) {
        userRules.maxParallelWorkers = 1;
      }
    }
    if (typeof launch.laneStrategy === "string") userRules.laneStrategy = launch.laneStrategy;
    if (typeof launch.customInstructions === "string") userRules.customInstructions = launch.customInstructions;
    if (args.defaultExecutorKind) userRules.providerPreference = args.defaultExecutorKind;

    // Read phase-based settings and pass budget/recovery/PR/model fields directly into userRules
    const { settings: phaseSettings } = resolveActivePhaseSettings(missionId);
    const coordinatorModelConfig = resolveOrchestratorModelConfig(missionId, "coordinator");
    if (coordinatorModelConfig) userRules.coordinatorModel = modelConfigToServiceModel(coordinatorModelConfig);
    if (phaseSettings.recoveryLoop) {
      userRules.recoveryEnabled = phaseSettings.recoveryLoop.enabled;
      userRules.recoveryMaxIterations = phaseSettings.recoveryLoop.maxIterations;
    }
    if (phaseSettings.prStrategy?.kind) userRules.prStrategy = phaseSettings.prStrategy.kind;
    // Pass budget limits if configured
    const budgetConfig = isRecord(launch.budgetConfig) ? launch.budgetConfig : null;
    if (budgetConfig) {
      if (typeof budgetConfig.maxCostUsd === "number") userRules.budgetLimitUsd = budgetConfig.maxCostUsd;
      if (typeof budgetConfig.maxTokens === "number") userRules.budgetLimitTokens = budgetConfig.maxTokens;
    }
    const plannerPlanMeta = isRecord(missionMeta?.plannerPlan) ? missionMeta.plannerPlan : null;
    const plannerSummaryHints = (() => {
      if (!plannerPlanMeta || !isRecord(plannerPlanMeta.missionSummary)) return [] as string[];
      const summary = plannerPlanMeta.missionSummary as Record<string, unknown>;
      const objective = typeof summary.objective === "string" ? summary.objective.trim() : "";
      const strategy = typeof summary.strategy === "string" ? summary.strategy.trim() : "";
      const parallelismCap = Number(summary.parallelismCap ?? NaN);
      const hints: string[] = [];
      if (objective.length > 0) hints.push(`[planner] Objective: ${objective}`);
      if (strategy.length > 0) hints.push(`[planner] Strategy: ${strategy}`);
      if (Number.isFinite(parallelismCap) && parallelismCap > 0) hints.push(`[planner] Parallelism cap: ${Math.floor(parallelismCap)}`);
      return hints;
    })();

    // Discover project docs (paths used for context only, not persisted to memory)
    const projectDocsContext = discoverProjectDocs();
    const projectMemoryHighlights = [...plannerSummaryHints, ...buildProjectMemoryHighlights(missionId)].slice(0, 12);

    // Build a shallow file tree for coordinator context
    let fileTree: string | undefined;
    if (projectRoot) {
      try {
        const fsSync = require("fs");
        const entries = fsSync.readdirSync(projectRoot, { withFileTypes: true }) as Array<{ isDirectory(): boolean; name: string }>;
        const lines = entries
          .sort((a: { isDirectory(): boolean; name: string }, b: { isDirectory(): boolean; name: string }) =>
            a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
          )
          .slice(0, 50)
          .map((e: { isDirectory(): boolean; name: string }) => (e.isDirectory() ? `${e.name}/` : e.name));
        fileTree = lines.join("\n");
      } catch {
        /* ignore — best-effort */
      }
    }

    const projectCtx: import("./coordinatorAgent").CoordinatorProjectContext | undefined =
      projectRoot ? {
        projectRoot,
        projectDocPaths: projectDocsContext.found ? projectDocsContext.paths : undefined,
        projectKnowledge: projectMemoryHighlights.length > 0 ? projectMemoryHighlights : undefined,
        fileTree,
      } : undefined;

    // Detect available providers
    const availableProviders: import("./coordinatorAgent").CoordinatorAvailableProvider[] = [];
    const availability = aiIntegrationService?.getAvailability?.();
    if (availability) {
      if (availability.claude) availableProviders.push({ name: "claude", available: true });
      if (availability.codex) availableProviders.push({ name: "codex", available: true });
    }
    if (aiIntegrationService) {
      availableProviders.push({
        name: "api/local",
        available: true,
      });
    }

    // Load phase cards so the coordinator knows the mission execution phases
    const phaseConfig = missionService.getPhaseConfiguration(missionId);
    const phases = phaseConfig?.selectedPhases ?? [];

    return { userRules, projectCtx, availableProviders, phases };
  };

  const getRunGraphSafe = (runId: string): OrchestratorRunGraph | null => {
    try {
      return orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
    } catch {
      return null;
    }
  };

  const collectGracefulShutdownTargets = (runId: string): Array<{
    sessionId: string;
    attemptId: string | null;
    stepId: string | null;
    stepKey: string | null;
    laneId: string | null;
  }> => {
    const graph = getRunGraphSafe(runId);
    const stepById = new Map<string, OrchestratorStep>();
    const targetsBySession = new Map<string, {
      sessionId: string;
      attemptId: string | null;
      stepId: string | null;
      stepKey: string | null;
      laneId: string | null;
    }>();

    if (graph) {
      for (const step of graph.steps) {
        stepById.set(step.id, step);
      }
      for (const attempt of graph.attempts) {
        if (!ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) continue;
        const sessionId = toOptionalString(attempt.executorSessionId);
        if (!sessionId || targetsBySession.has(sessionId)) continue;
        const step = stepById.get(attempt.stepId);
        targetsBySession.set(sessionId, {
          sessionId,
          attemptId: attempt.id,
          stepId: attempt.stepId,
          stepKey: step?.stepKey ?? null,
          laneId: step?.laneId ?? null
        });
      }
    }

    for (const [attemptId, state] of workerStates.entries()) {
      if (state.runId !== runId) continue;
      if (state.state === "completed" || state.state === "failed" || state.state === "disposed") continue;
      const sessionId = toOptionalString(state.sessionId);
      if (!sessionId || targetsBySession.has(sessionId)) continue;
      const step = stepById.get(state.stepId);
      targetsBySession.set(sessionId, {
        sessionId,
        attemptId,
        stepId: state.stepId,
        stepKey: step?.stepKey ?? null,
        laneId: step?.laneId ?? null
      });
    }

    return [...targetsBySession.values()];
  };

  const waitForRunAttemptDrain = async (runId: string, timeoutMs = GRACEFUL_CANCEL_DRAIN_WAIT_MS): Promise<boolean> => {
    const deadline = Date.now() + Math.max(0, Math.floor(timeoutMs));
    while (Date.now() <= deadline) {
      const graph = getRunGraphSafe(runId);
      if (!graph) return true;
      const hasActiveAttempts = graph.attempts.some((attempt) => ACTIVE_ATTEMPT_STATUSES.has(attempt.status));
      if (!hasActiveAttempts) return true;
      await new Promise((resolve) => setTimeout(resolve, GRACEFUL_CANCEL_DRAIN_POLL_MS));
    }
    return false;
  };

  const cancelRunGracefully = async (cancelArgs: CancelOrchestratorRunArgs): Promise<OrchestratorRun> => {
    const runId = toOptionalString(cancelArgs.runId);
    if (!runId) throw new Error("runId is required.");

    const reason = toOptionalString(cancelArgs.reason) ?? "Run canceled.";
    const missionId = getMissionIdForRun(runId);
    if (missionId) {
      emitCoordinatorLifecycle({
        missionId,
        runId,
        state: "stopped",
        message: "I’ve stopped the run.",
        force: true,
      });
    }
    const evalTimer = pendingCoordinatorEvals.get(runId);
    if (evalTimer) {
      clearTimeout(evalTimer);
      pendingCoordinatorEvals.delete(runId);
    }
    coordinatorWriteBarrierRuns.add(runId);
    endCoordinatorAgentV2(runId);
    const targets = collectGracefulShutdownTargets(runId);

    logger.info("ai_orchestrator.run_cancel_graceful_start", {
      runId,
      missionId,
      workerCount: targets.length
    });

    const noticeText = `Run cancellation requested: ${reason}\nStop work and wrap up any in-flight operations.`;
    let notifiedWorkers = 0;
    let interruptedSessions = 0;
    let disposedSessions = 0;

    if (agentChatService) {
      if (typeof agentChatService.sendMessage === "function") {
        const outcomes = await Promise.all(
          targets.map(async (target) => ({
            sessionId: target.sessionId,
            outcome: await runBestEffortWithTimeout({
              timeoutMs: GRACEFUL_CANCEL_NOTIFY_TIMEOUT_MS,
              work: () => sendWorkerMessageToSession(target.sessionId, noticeText)
            })
          }))
        );
        for (const entry of outcomes) {
          if (entry.outcome.ok) {
            notifiedWorkers += 1;
          } else {
            logger.debug("ai_orchestrator.run_cancel_graceful_notify_failed", {
              runId,
              sessionId: entry.sessionId,
              timedOut: entry.outcome.timedOut,
              error: entry.outcome.error
            });
          }
        }
      }

      if (typeof agentChatService.interrupt === "function") {
        const outcomes = await Promise.all(
          targets.map(async (target) => ({
            sessionId: target.sessionId,
            outcome: await runBestEffortWithTimeout({
              timeoutMs: GRACEFUL_CANCEL_INTERRUPT_TIMEOUT_MS,
              work: () => agentChatService.interrupt({ sessionId: target.sessionId })
            })
          }))
        );
        for (const entry of outcomes) {
          if (entry.outcome.ok) {
            interruptedSessions += 1;
          } else {
            logger.debug("ai_orchestrator.run_cancel_graceful_interrupt_failed", {
              runId,
              sessionId: entry.sessionId,
              timedOut: entry.outcome.timedOut,
              error: entry.outcome.error
            });
          }
        }
      }

      if (typeof agentChatService.dispose === "function") {
        const outcomes = await Promise.all(
          targets.map(async (target) => ({
            sessionId: target.sessionId,
            outcome: await runBestEffortWithTimeout({
              timeoutMs: GRACEFUL_CANCEL_DISPOSE_TIMEOUT_MS,
              work: () => agentChatService.dispose({ sessionId: target.sessionId })
            })
          }))
        );
        for (const entry of outcomes) {
          if (entry.outcome.ok) {
            disposedSessions += 1;
          } else {
            logger.debug("ai_orchestrator.run_cancel_graceful_dispose_failed", {
              runId,
              sessionId: entry.sessionId,
              timedOut: entry.outcome.timedOut,
              error: entry.outcome.error
            });
          }
        }
      }
    }

    const drained = await waitForRunAttemptDrain(runId, GRACEFUL_CANCEL_DRAIN_WAIT_MS);
    if (!drained) {
      logger.debug("ai_orchestrator.run_cancel_graceful_drain_timeout", {
        runId,
        timeoutMs: GRACEFUL_CANCEL_DRAIN_WAIT_MS
      });
    }

    orchestratorService.cancelRun({ runId, reason });
    purgeRunMaps(runId);
    void syncMissionFromRun(runId, "graceful_cancel");

    const run = orchestratorService.listRuns({ limit: 1_000 }).find((entry) => entry.id === runId);
    if (!run) throw new Error(`Run not found after cancellation: ${runId}`);

    logger.info("ai_orchestrator.run_cancel_graceful_complete", {
      runId,
      missionId,
      workerCount: targets.length,
      notifiedWorkers,
      interruptedSessions,
      disposedSessions,
      drainedBeforeForceCancel: drained
    });

    bestEffortCascadeCleanup(missionId, runId, "run_cancel");

    return run;
  };

  const bestEffortCascadeCleanup = (missionId: string | null | undefined, runId: string, logPrefix: string): void => {
    if (!missionId) return;
    try {
      void cleanupTeamResources({ missionId, runId, cleanupLanes: true }).then((result) => {
        logger.info(`ai_orchestrator.${logPrefix}_cascade_cleanup_complete`, {
          runId,
          missionId,
          lanesArchived: result.lanesArchived.length,
          lanesSkipped: result.lanesSkipped.length,
          laneErrors: result.laneErrors.length
        });
      }).catch((err) => {
        logger.debug(`ai_orchestrator.${logPrefix}_cascade_cleanup_failed`, {
          runId,
          missionId,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    } catch {
      // Cleanup must never break the caller
    }
  };

  const cleanupTeamResources = async (
    cleanupArgs: CleanupOrchestratorTeamResourcesArgs
  ): Promise<CleanupOrchestratorTeamResourcesResult> => {
    const missionId = toOptionalString(cleanupArgs.missionId);
    if (!missionId) throw new Error("missionId is required.");
    const mission = missionService.get(missionId);
    if (!mission) throw new Error(`Mission not found: ${missionId}`);

    const requestedRunId = toOptionalString(cleanupArgs.runId);
    const cleanupLanes = cleanupArgs.cleanupLanes !== false;
    let resolvedRunId: string | null = requestedRunId ?? null;
    const laneIds = new Set<string>();

    if (requestedRunId) {
      const runMissionId = getMissionIdForRun(requestedRunId);
      if (!runMissionId) {
        throw new Error(`Run not found: ${requestedRunId}`);
      }
      if (runMissionId !== missionId) {
        throw new Error(`Run ${requestedRunId} does not belong to mission ${missionId}.`);
      }
      const graph = getRunGraphSafe(requestedRunId);
      for (const laneId of graph?.steps.map((step) => toOptionalString(step.laneId)).filter((value): value is string => Boolean(value)) ?? []) {
        laneIds.add(laneId);
      }
      const missionLaneId = resolvePersistedMissionLaneIdForRun(requestedRunId);
      if (missionLaneId) laneIds.add(missionLaneId);
    } else {
      const missionRuns = [...orchestratorService.listRuns({ missionId, limit: 200 })]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      resolvedRunId = missionRuns[0]?.id ?? null;
      for (const run of missionRuns) {
        const graph = getRunGraphSafe(run.id);
        for (const laneId of graph?.steps.map((step) => toOptionalString(step.laneId)).filter((value): value is string => Boolean(value)) ?? []) {
          laneIds.add(laneId);
        }
        const missionLaneId = resolvePersistedMissionLaneIdForRun(run.id);
        if (missionLaneId) laneIds.add(missionLaneId);
      }
    }
    const laneIdList = [...laneIds];

    const result: CleanupOrchestratorTeamResourcesResult = {
      missionId,
      runId: resolvedRunId,
      laneIds: laneIdList,
      lanesArchived: [],
      lanesSkipped: [],
      laneErrors: []
    };

    if (!cleanupLanes || !laneIdList.length) {
      return result;
    }

    if (!laneService || typeof laneService.archive !== "function") {
      result.laneErrors = laneIdList.map((laneId) => ({ laneId, error: "Lane service unavailable." }));
      return result;
    }

    for (const laneId of laneIdList) {
      try {
        await Promise.resolve(laneService.archive({ laneId }));
        result.lanesArchived.push(laneId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const normalized = message.toLowerCase();
        if (
          (normalized.includes("already") && normalized.includes("archived"))
          || normalized.includes("not found")
        ) {
          result.lanesSkipped.push(laneId);
        } else {
          result.laneErrors.push({ laneId, error: message });
        }
      }
    }

    logger.info("ai_orchestrator.team_resources_cleanup_complete", {
      missionId,
      runId: resolvedRunId,
      laneCount: laneIds.size,
      archivedCount: result.lanesArchived.length,
      skippedCount: result.lanesSkipped.length,
      errorCount: result.laneErrors.length
    });

    return result;
  };

  const steerMission = (steerArgs: SteerMissionArgs): SteerMissionResult => {
    const missionId = steerArgs.missionId?.trim();
    if (!missionId) throw new Error("missionId is required.");
    const targetedInterventionId =
      typeof steerArgs.interventionId === "string" && steerArgs.interventionId.trim().length > 0
        ? steerArgs.interventionId.trim()
        : null;

    const mission = missionService.get(missionId);
    if (!mission) throw new Error(`Mission not found: ${missionId}`);

    const directive: UserSteeringDirective = {
      missionId,
      directive: steerArgs.directive,
      priority: steerArgs.priority ?? "suggestion",
      targetStepKey: steerArgs.targetStepKey ?? null
    };
    const resolutionKind = steerArgs.resolutionKind ?? (targetedInterventionId ? "answer_provided" : null);
    const missionRuns = (() => {
      try {
        return orchestratorService.listRuns({ missionId, limit: 200 });
      } catch {
        return [];
      }
    })();
    const missionRunIds = new Set(missionRuns.map((run) => run.id));
    const runGraphById = new Map<string, OrchestratorRunGraph | null>();
    const loadRunGraph = (runId: string): OrchestratorRunGraph | null => {
      if (runGraphById.has(runId)) {
        return runGraphById.get(runId) ?? null;
      }
      try {
        const graph = orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
        runGraphById.set(runId, graph);
        return graph;
      } catch {
        runGraphById.set(runId, null);
        return null;
      }
    };
    const isLiveSteeringWorker = (attemptId: string, ws: OrchestratorWorkerState): boolean => {
      if (!ws.runId || ws.state !== "working" || !ws.sessionId) return false;
      if (!missionRunIds.has(ws.runId)) return false;
      const graph = loadRunGraph(ws.runId);
      if (!graph) return false;
      const attempt = graph.attempts.find((entry) => entry.id === attemptId);
      if (!attempt || attempt.status !== "running") return false;
      return true;
    };

    // Store in memory for active use by AI decision points
    const existing = activeSteeringDirectives.get(missionId) ?? loadSteeringDirectivesFromMetadata(missionId);
    existing.push(directive);
    activeSteeringDirectives.set(missionId, existing.slice(-MAX_PERSISTED_STEERING_DIRECTIVES));

    // Persist to mission metadata
    try {
      updateMissionMetadata(missionId, (meta) => {
        const storedDirectives = Array.isArray(meta[STEERING_DIRECTIVES_METADATA_KEY])
          ? meta[STEERING_DIRECTIVES_METADATA_KEY] as unknown[]
          : [];
        storedDirectives.push({
          ...directive,
          appliedAt: nowIso()
        });
        meta[STEERING_DIRECTIVES_METADATA_KEY] = storedDirectives.slice(-MAX_PERSISTED_STEERING_DIRECTIVES);
      });
    } catch (error) {
      logger.debug("ai_orchestrator.steer_persist_failed", {
        missionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    logger.info("ai_orchestrator.mission_steered", {
      missionId,
      priority: directive.priority,
      targetStepKey: directive.targetStepKey ?? "all",
      directivePreview: directive.directive.slice(0, 100)
    });

    const projectedStepCount = projectSteeringDirectiveToActiveSteps(directive);

    const resolvedInterventions: string[] = [];
    const resumedRunIds = new Set<string>();
    const refreshedMission = missionService.get(missionId);
    const openManualInput = targetedInterventionId
      ? refreshedMission?.interventions.filter((entry) => {
          if (entry.status !== "open" || entry.interventionType !== "manual_input") return false;
          return entry.id === targetedInterventionId;
        }) ?? []
      : [];
    for (const intervention of openManualInput) {
      try {
        const meta = isRecord(intervention.metadata) ? intervention.metadata : null;
        const runId = typeof meta?.runId === "string" ? meta.runId.trim() : "";
        const attemptId = typeof meta?.attemptId === "string" ? meta.attemptId.trim() : "";
        const stepId = typeof meta?.stepId === "string" ? meta.stepId.trim() : "";
        const sessionId = typeof meta?.sessionId === "string" ? meta.sessionId.trim() : "";
        const ownerGraph = runId ? loadRunGraph(runId) : null;
        const ownerAttempt = attemptId.length > 0 ? ownerGraph?.attempts.find((entry) => entry.id === attemptId) ?? null : null;
        const ownerStep = stepId.length > 0 ? ownerGraph?.steps.find((entry) => entry.id === stepId) ?? null : null;
        const ownerStepMeta = isRecord(ownerStep?.metadata) ? ownerStep.metadata : null;
        const ownerPlanningLike =
          String(ownerStepMeta?.stepType ?? "").trim().toLowerCase() === "planning"
          || String(ownerStepMeta?.stepType ?? "").trim().toLowerCase() === "analysis"
          || String(ownerStepMeta?.phaseKey ?? "").trim().toLowerCase() === "planning";
        const ownerCanResume = attemptId.length === 0 || Boolean(ownerAttempt && ownerAttempt.status === "running");

        if (resolutionKind !== "cancel_run" && !ownerCanResume) {
          const failureTitle = ownerPlanningLike ? "Planner can no longer continue" : "Question owner is no longer active";
          const failureBody = ownerPlanningLike
            ? "The planner that asked this question has already failed or exited, so ADE cannot continue planning with that same thread."
            : "The worker that opened this question is no longer active, so ADE cannot safely resume it from this answer.";
          missionService.addIntervention({
            missionId,
            interventionType: "failed_step",
            title: failureTitle,
            body: failureBody,
            requestedAction: ownerPlanningLike
              ? "Review the planner failure and explicitly choose whether to retry planning."
              : "Review the worker failure and choose whether to retry or replace that step.",
            metadata: {
              runId: runId || null,
              stepId: stepId || null,
              stepKey: ownerStep?.stepKey ?? null,
              attemptId: attemptId || null,
              reasonCode: ownerPlanningLike ? "planner_cannot_resume" : "question_owner_inactive",
            },
          });
          continue;
        }

        missionService.resolveIntervention({
          missionId,
          interventionId: intervention.id,
          status: "resolved",
          resolutionKind: resolutionKind ?? "answer_provided",
          note:
            resolutionKind === "accept_defaults"
              ? "Resolved by accepting defaults."
              : resolutionKind === "skip_question"
                ? "Resolved by skipping the question."
                : resolutionKind === "cancel_run"
                  ? "Resolved by canceling the run."
                  : `Resolved by user answer (${directive.priority}).`
        });
        resolvedInterventions.push(intervention.id);
        if (runId.length > 0) {
          const threadId = typeof meta?.threadId === "string" ? meta.threadId.trim() : "";
          const replyTo = typeof meta?.messageId === "string" ? meta.messageId.trim() : "";
          const questionReplyLink =
            resolutionKind !== "cancel_run" && threadId.length > 0 && replyTo.length > 0
              ? buildQuestionReplyLink({
                  threadId,
                  replyTo,
                  interventionId: intervention.id,
                  directive: directive.directive
                })
              : null;
          recordRuntimeEvent({
            runId,
            stepId: typeof meta?.stepId === "string" ? meta.stepId : null,
            attemptId: typeof meta?.attemptId === "string" ? meta.attemptId : null,
            sessionId: typeof meta?.sessionId === "string" ? meta.sessionId : null,
            eventType: "intervention_resolved",
            eventKey: questionReplyLink?.messageId ?? `intervention_resolved:${intervention.id}:${directive.priority}`,
            payload: {
              interventionId: intervention.id,
              reason: resolutionKind === "cancel_run" ? "cancel_run" : "steering_directive",
              priority: directive.priority,
              directive: clipTextForContext(directive.directive, 220),
              resolutionKind,
              threadId: questionReplyLink?.threadId ?? null,
              messageId: questionReplyLink?.messageId ?? null,
              replyTo: questionReplyLink?.replyTo ?? null
            }
          });
          if (questionReplyLink) {
            recordRuntimeEvent({
              runId,
              stepId: typeof meta?.stepId === "string" ? meta.stepId : null,
              attemptId: typeof meta?.attemptId === "string" ? meta.attemptId : null,
              sessionId: typeof meta?.sessionId === "string" ? meta.sessionId : null,
              eventType: "progress",
              eventKey: `question_resumed:${questionReplyLink.messageId}`,
              payload: {
                transition: "question_answered_resume",
                source: "steering_directive",
                threadId: questionReplyLink.threadId,
                messageId: questionReplyLink.messageId,
                replyTo: questionReplyLink.replyTo
              }
            });
          }
          if (resolutionKind !== "cancel_run" && attemptId.length > 0 && stepId.length > 0) {
            const existingWorker = workerStates.get(attemptId);
            const executorKindRaw = typeof meta?.executorKind === "string" ? meta.executorKind : null;
            const executorKind: OrchestratorExecutorKind =
              existingWorker?.executorKind
                ?? (executorKindRaw === "unified" || executorKindRaw === "shell" || executorKindRaw === "manual"
                  ? executorKindRaw
                  : "manual");
            upsertWorkerState(attemptId, {
              runId,
              stepId,
              sessionId: typeof meta?.sessionId === "string" ? meta.sessionId : null,
              executorKind,
              state: "working"
            });
            const tracker = ensureAttemptRuntimeTracker(attemptId);
            if (questionReplyLink) {
              tracker.lastQuestionThreadId = questionReplyLink.threadId;
              tracker.lastQuestionMessageId = questionReplyLink.messageId;
            }
          }
          if (resolutionKind === "cancel_run") {
            void cancelRunGracefully({
              runId,
              reason: "User canceled the run from an intervention.",
            }).catch((error) => {
              logger.warn("ai_orchestrator.cancel_run_from_intervention_failed", {
                missionId,
                runId,
                error: getErrorMessage(error),
              });
            });
          } else {
            resumedRunIds.add(runId);
          }
        }
      } catch (error) {
        logger.debug("ai_orchestrator.steer_resolve_intervention_failed", {
          missionId,
          interventionId: intervention.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    if (resolvedInterventions.length > 0) {
      for (const runId of resumedRunIds) {
        void startReadyAutopilotAttemptsWithMilestoneReadiness({
          runId,
          reason: "question_answered_resume"
        }).catch((error) => {
          logger.warn("ai_orchestrator.start_ready_attempts_failed", { runId, reason: "question_answered_resume", error: getErrorMessage(error) });
        });
      }
      emitOrchestratorMessage(
        missionId,
        resolutionKind === "cancel_run"
          ? `Resolved ${resolvedInterventions.length} intervention${resolvedInterventions.length === 1 ? "" : "s"} and started canceling the run.`
          : resolutionKind === "accept_defaults"
            ? `Accepted defaults for ${resolvedInterventions.length} intervention${resolvedInterventions.length === 1 ? "" : "s"} and resumed the owning worker.`
            : resolutionKind === "skip_question"
              ? `Skipped ${resolvedInterventions.length} question${resolvedInterventions.length === 1 ? "" : "s"} and resumed the owning worker.`
              : `Applied user answers and resolved ${resolvedInterventions.length} waiting-input intervention${resolvedInterventions.length === 1 ? "" : "s"}.`,
        directive.targetStepKey ?? null,
        {
          interventionIds: resolvedInterventions,
          projectedStepCount
        }
      );

      // VAL-STEER-001: After resolving all blocking interventions, check if any
      // paused runs should be resumed. If no open interventions remain on the
      // mission, resume paused runs and transition mission back to in_progress.
      try {
        const postSteerMission = missionService.get(missionId);
        const remainingOpenInterventions = postSteerMission?.interventions.filter(
          (iv) => iv.status === "open"
        ) ?? [];
        if (remainingOpenInterventions.length === 0) {
          for (const runId of resumedRunIds) {
            try {
              const runGraph = orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
              if (runGraph.run.status === "paused") {
                orchestratorService.resumeRun({ runId });
                logger.info("ai_orchestrator.steer_auto_resumed_run", { missionId, runId });
              }
            } catch (resumeError) {
              logger.debug("ai_orchestrator.steer_auto_resume_failed", {
                missionId,
                runId,
                error: resumeError instanceof Error ? resumeError.message : String(resumeError),
              });
            }
          }
          // Transition mission back to in_progress if it was intervention_required
          if (postSteerMission?.status === "intervention_required") {
            try {
              missionService.update({ missionId, status: "in_progress" });
            } catch {
              // Best effort — mission might already be in a different state
            }
          }
        }
      } catch (steerResumeError) {
        logger.debug("ai_orchestrator.steer_resume_check_failed", {
          missionId,
          error: steerResumeError instanceof Error ? steerResumeError.message : String(steerResumeError),
        });
      }
    }

    // Real-time delivery: try to deliver the directive to running worker sessions
    if (agentChatService) {
      const stepIdToStepKey = new Map<string, string>();
      for (const run of missionRuns) {
        const graph = loadRunGraph(run.id);
        if (!graph) continue;
        for (const step of graph.steps) {
          stepIdToStepKey.set(step.id, step.stepKey);
        }
      }

      const formattedDirective = `[ADE ORCHESTRATOR STEERING]: ${directive.directive}`;

      if (directive.targetStepKey) {
        // Targeted delivery: find the specific worker for this step
        const targetWorker = [...workerStates.entries()].find(([attemptId, ws]) => {
          if (!isLiveSteeringWorker(attemptId, ws)) return false;
          const workerStepKey = stepIdToStepKey.get(ws.stepId);
          return workerStepKey === directive.targetStepKey;
        });

        if (targetWorker) {
          const [targetAttemptId, targetWs] = targetWorker;
          void (async () => {
            try {
              await sendWorkerMessageToSession(targetWs.sessionId!, formattedDirective);
              logger.info("ai_orchestrator.steering_delivered_targeted", {
                missionId,
                targetStepKey: directive.targetStepKey,
                attemptId: targetAttemptId,
                sessionId: targetWs.sessionId
              });
            } catch (deliveryError) {
              logger.debug("ai_orchestrator.steering_worker_delivery_failed", {
                missionId,
                attemptId: targetAttemptId,
                error: deliveryError instanceof Error ? deliveryError.message : String(deliveryError)
              });
            }
          })();
        } else {
          // Worker not running yet — directive stays queued in metadata for when it starts
          logger.info("ai_orchestrator.steering_queued_for_step", {
            missionId,
            targetStepKey: directive.targetStepKey
          });
        }
      } else {
        // No target — deliver to ALL running workers for this mission
        for (const [attemptId, ws] of workerStates.entries()) {
          if (isLiveSteeringWorker(attemptId, ws)) {
            void (async () => {
              try {
                await sendWorkerMessageToSession(ws.sessionId!, formattedDirective);
                logger.debug("ai_orchestrator.steering_delivered_to_worker", {
                  missionId,
                  attemptId,
                  sessionId: ws.sessionId,
                  directive: directive.directive.slice(0, 200)
                });
              } catch (deliveryError) {
                logger.debug("ai_orchestrator.steering_worker_delivery_failed", {
                  missionId,
                  attemptId,
                  error: deliveryError instanceof Error ? deliveryError.message : String(deliveryError)
                });
              }
            })();
          }
        }
      }
    }

    // Event-driven coordinator trigger: evaluate plan immediately after steering directive
    try {
      const steerRuns = orchestratorService.listRuns({ missionId });
      for (const steerRun of steerRuns) {
        if (steerRun.status === "active" || steerRun.status === "bootstrapping" || steerRun.status === "paused") {
          triggerCoordinatorEvaluation(steerRun.id, "steering_directive");
        }
      }
    } catch {
      // Non-critical — coordinator will still pick it up on next heartbeat
    }

    return {
      acknowledged: true,
      appliedAt: nowIso(),
      response: `Directive accepted (${directive.priority}). Applied to ${projectedStepCount} active step${projectedStepCount === 1 ? "" : "s"} and will guide upcoming worker runs.`
    };
  };

  const createContextCheckpoint = (args: Parameters<typeof createContextCheckpointCtx>[1]) =>
    createContextCheckpointCtx(ctx, args);

  // normalizeDeliveryError, isBusyDeliveryError, isNoActiveTurnError, computeWorkerRetryBackoffMs
  // are imported directly from chatMessageService (pure functions, no ctx needed)

  const workerDeliveryDeps: WorkerDeliveryDeps = {
    appendChatMessage,
    recordRuntimeEvent
  };

  const resolveWorkerDeliveryContext = (message: OrchestratorChatMessage): WorkerDeliveryContext | null =>
    resolveWorkerDeliveryContextCtx(ctx, message);

  const persistThreadWorkerLinks = (context: WorkerDeliveryContext) =>
    persistThreadWorkerLinksCtx(ctx, context);

  const sendWorkerMessageToSession = (sessionId: string, text: string) =>
    sendWorkerMessageToSessionCtx(ctx, sessionId, text);

  const replayQueuedWorkerMessages = (args: {
    reason: string;
    missionId?: string | null;
    threadId?: string | null;
    sessionId?: string | null;
  }) => replayQueuedWorkerMessagesCtx(ctx, args, workerDeliveryDeps);

  const routeMessageToCoordinator = (message: OrchestratorChatMessage) =>
    routeMessageToCoordinatorCtx(ctx, message, {
      ...workerDeliveryDeps,
      steerMission,
      enqueueChatResponse,
      runHealthSweep
    });

  const routeMessageToWorker = (message: OrchestratorChatMessage) =>
    routeMessageToWorkerCtx(ctx, message, workerDeliveryDeps);

  const listChatThreads = (threadArgs: ListOrchestratorChatThreadsArgs) =>
    listChatThreadsCtx(ctx, threadArgs);

  const getThreadMessages = (threadArgs: GetOrchestratorThreadMessagesArgs) =>
    getThreadMessagesCtx(ctx, threadArgs);

  const getChat = (chatArgs: GetOrchestratorChatArgs) =>
    getChatCtx(ctx, chatArgs);

  const deliverMessageToAgent = (args: Parameters<typeof deliverMessageToAgentCtx>[1]) =>
    deliverMessageToAgentCtx(ctx, args, { sendWorkerMessageToSession });

  const getGlobalChat = (args: import("../../../shared/types").GetGlobalChatArgs) =>
    getGlobalChatCtx(ctx, args);

  const getActiveAgents = (args: import("../../../shared/types").GetActiveAgentsArgs) =>
    getActiveAgentsCtx(ctx, args);

  const sendAgentMessageWithMentions = (agentMsgArgs: import("../../../shared/types").SendAgentMessageArgs) =>
    sendAgentMessageWithMentionsCtx(ctx, agentMsgArgs, { deliverMessageToAgent });

  const maybeForwardSubagentCompletionRollup = (args: {
    event: OrchestratorRuntimeEvent;
    graph: OrchestratorRunGraph;
  }): void => {
    const { event, graph } = args;
    if (!event.attemptId) return;
    if (event.reason !== "attempt_completed" && event.reason !== "completed") return;
    const dedupeKey = `${event.runId}:${event.attemptId}`;
    if (subagentCompletionRollupSent.has(dedupeKey)) return;

    const attempt = graph.attempts.find((candidate) => candidate.id === event.attemptId);
    if (!attempt) return;
    if (attempt.status !== "succeeded" && attempt.status !== "failed") return;

    const childStep = graph.steps.find((step) => step.id === attempt.stepId);
    const childMeta = isRecord(childStep?.metadata) ? childStep.metadata : null;
    if (!childStep || childMeta?.isSubAgent !== true) return;
    const parentWorkerId = typeof childMeta.parentWorkerId === "string" ? childMeta.parentWorkerId.trim() : "";
    if (!parentWorkerId.length) return;

    const parentStep = graph.steps.find((step) => step.stepKey === parentWorkerId);
    if (!parentStep) return;
    const parentAttempts = graph.attempts.filter((candidate) => candidate.stepId === parentStep.id);
    if (!parentAttempts.length) return;
    const runningParentAttempt = parentAttempts.find((candidate) => candidate.status === "running");
    const parentAttempt = runningParentAttempt
      ?? [...parentAttempts].sort((left, right) => {
        const leftTs = Date.parse(left.completedAt ?? left.createdAt);
        const rightTs = Date.parse(right.completedAt ?? right.createdAt);
        return rightTs - leftTs;
      })[0];
    if (!parentAttempt?.id || parentAttempt.id === attempt.id) return;

    const childLabel = childStep.title?.trim().length ? childStep.title.trim() : childStep.stepKey;
    const summary = attempt.resultEnvelope?.summary?.trim() || attempt.errorMessage?.trim() || "No summary provided.";
    const content = `Sub-agent '${childLabel}' completed (${attempt.status}): ${summary}`;

    try {
      sendAgentMessageWithMentions({
        missionId: graph.run.missionId,
        fromAttemptId: attempt.id,
        toAttemptId: parentAttempt.id,
        content,
        metadata: {
          source: "subagent_result_rollup",
          parentWorkerId,
          childWorkerId: childStep.stepKey,
          childStepId: childStep.id,
          childAttemptId: attempt.id,
        }
      });
      subagentCompletionRollupSent.add(dedupeKey);
    } catch (error) {
      logger.debug("ai_orchestrator.subagent_completion_rollup_failed", {
        runId: event.runId,
        childAttemptId: attempt.id,
        parentAttemptId: parentAttempt.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const listWorkerDigests = (digestArgs: ListOrchestratorWorkerDigestsArgs) => listWorkerDigestsCtx(ctx, digestArgs);
  const getWorkerDigest = (digestArgs: GetOrchestratorWorkerDigestArgs) => getWorkerDigestCtx(ctx, digestArgs);
  const getContextCheckpoint = (checkpointArgs: GetOrchestratorContextCheckpointArgs) => getContextCheckpointCtx(ctx, checkpointArgs);
  const listLaneDecisions = (laneArgs: ListOrchestratorLaneDecisionsArgs) => listLaneDecisionsCtx(ctx, laneArgs);
  const listArtifacts = (artifactArgs: ListOrchestratorArtifactsArgs): OrchestratorArtifact[] => {
    const missionId = toOptionalString(artifactArgs.missionId);
    const runId = toOptionalString(artifactArgs.runId);
    const stepId = toOptionalString(artifactArgs.stepId);

    if (stepId) {
      return orchestratorService.getArtifactsForStep(stepId).filter((artifact) => {
        if (missionId && artifact.missionId !== missionId) return false;
        if (runId && artifact.runId !== runId) return false;
        return true;
      });
    }

    const resolvedMissionId =
      missionId
      ?? (runId
        ? toOptionalString(orchestratorService.getRunGraph({ runId, timelineLimit: 0 }).run.missionId)
        : null);
    if (!resolvedMissionId) {
      throw new Error("listArtifacts requires missionId, runId, or stepId.");
    }

    return orchestratorService.getArtifactsForMission(resolvedMissionId).filter((artifact) =>
      !runId || artifact.runId === runId
    );
  };
  const listWorkerCheckpoints = (checkpointArgs: ListOrchestratorWorkerCheckpointsArgs): OrchestratorWorkerCheckpoint[] => {
    const missionId = toOptionalString(checkpointArgs.missionId);
    const runId = toOptionalString(checkpointArgs.runId);
    const stepId = toOptionalString(checkpointArgs.stepId);

    let checkpoints: OrchestratorWorkerCheckpoint[] = [];
    if (runId) {
      checkpoints = orchestratorService.getWorkerCheckpointsForRun({ runId });
    } else if (missionId) {
      checkpoints = orchestratorService.getWorkerCheckpointsForMission({ missionId });
    } else if (stepId) {
      const row = db.get<{ run_id: string | null }>(
        `select run_id from orchestrator_steps where id = ? limit 1`,
        [stepId],
      );
      const resolvedRunId = toOptionalString(row?.run_id);
      if (!resolvedRunId) throw new Error(`Unable to resolve run for step ${stepId}.`);
      checkpoints = orchestratorService.getWorkerCheckpointsForRun({ runId: resolvedRunId });
    } else {
      throw new Error("listWorkerCheckpoints requires missionId, runId, or stepId.");
    }

    return stepId ? checkpoints.filter((checkpoint) => checkpoint.stepId === stepId) : checkpoints;
  };
  const getPromptInspector = (promptArgs: GetOrchestratorPromptInspectorArgs): OrchestratorPromptInspector => {
    const runId = String(promptArgs.runId ?? "").trim();
    if (!runId) throw new Error("runId is required.");
    const graph = orchestratorService.getRunGraph({ runId, timelineLimit: 500 });
    const runMeta = isRecord(graph.run.metadata) ? graph.run.metadata : null;
    const phaseRuntime = isRecord(runMeta?.phaseRuntime) ? runMeta.phaseRuntime : null;

    if (promptArgs.target === "worker") {
      const stepId = toOptionalString(promptArgs.stepId);
      if (!stepId) throw new Error("stepId is required for worker prompt inspection.");
      return buildWorkerPromptInspector({ graph, stepId });
    }

    const missionId = graph.run.missionId;
    const missionGoal =
      typeof runMeta?.missionGoal === "string" && runMeta.missionGoal.trim().length > 0
        ? runMeta.missionGoal.trim()
        : missionService.get(missionId)?.prompt ?? "";
    const coordinatorContext = gatherCoordinatorContext(missionId, { missionId });
    return buildCoordinatorPromptInspector({
      runId,
      missionId,
      missionGoal,
      userRules: coordinatorContext.userRules,
      projectContext: coordinatorContext.projectCtx,
      availableProviders: coordinatorContext.availableProviders,
      phases: coordinatorContext.phases,
      currentPhaseKey: toOptionalString(phaseRuntime?.currentPhaseKey),
      currentPhaseName: toOptionalString(phaseRuntime?.currentPhaseName),
    });
  };
  const getPlanningPromptPreview = (promptArgs: GetPlanningPromptPreviewArgs): OrchestratorPromptInspector =>
    buildPlanningPromptPreview(promptArgs);

  const chatRoutingDeps: ChatRoutingDeps = {
    routeMessageToWorker,
    routeMessageToCoordinator,
    replayQueuedWorkerMessages,
    sendWorkerMessageToSession,
    createContextCheckpoint,
    listWorkerDigests,
  };

  const sendThreadMessage = (threadArgs: SendOrchestratorThreadMessageArgs) =>
    sendThreadMessageCtx(ctx, threadArgs, chatRoutingDeps);

  const sendChat = (chatArgs: SendOrchestratorChatArgs) =>
    sendChatCtx(ctx, chatArgs, chatRoutingDeps);

  const setMissionMetricsConfig = (configArgs: SetMissionMetricsConfigArgs): MissionMetricsConfig =>
    setMissionMetricsConfigCtx(ctx, configArgs);

  const getMissionMetrics = (metricArgs: GetMissionMetricsArgs): {
    config: MissionMetricsConfig | null;
    samples: MissionMetricSample[];
  } => getMissionMetricsCtx(ctx, metricArgs);

  const reconciliationDeps: ReconciliationDeps = {
    resolveWorkerDeliveryContext,
    persistThreadWorkerLinks,
    replayQueuedWorkerMessages,
  };

  const reconcileThreadedMessagingState = () =>
    reconcileThreadedMessagingStateCtx(ctx, reconciliationDeps);

  const startHealthSweepLoop = () => {
    if (disposed || healthSweepTimer) return;
    healthSweepTimer = setInterval(() => {
      if (disposed) return;
      if (workerStates.size === 0 && activeHealthSweepRuns.size === 0 && !hasRecoverableRuntimeWork()) return;
      void runHealthSweep("interval").catch((error) => {
        logger.debug("ai_orchestrator.health_sweep_interval_failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, HEALTH_SWEEP_INTERVAL_MS);
    healthSweepTimerRef.current = healthSweepTimer;
    if (!disposed && hasRecoverableRuntimeWork()) {
      void runHealthSweep("startup").catch((error) => {
        logger.debug("ai_orchestrator.health_sweep_startup_failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  };

  const onSessionRuntimeSignal = (signal: SessionRuntimeSignal): void => {
    if (disposed) return;
    const sessionId = String(signal.sessionId ?? "").trim();
    if (!sessionId.length) return;
    const normalizedSignal: SessionRuntimeSignal = {
      laneId: String(signal.laneId ?? "").trim(),
      sessionId,
      runtimeState: parseTerminalRuntimeState(signal.runtimeState) ?? "running",
      lastOutputPreview:
        typeof signal.lastOutputPreview === "string" && signal.lastOutputPreview.trim().length > 0
          ? clipTextForContext(signal.lastOutputPreview.trim(), MAX_RUNTIME_SIGNAL_PREVIEW_CHARS)
          : null,
      at: typeof signal.at === "string" && signal.at.trim().length > 0 ? signal.at : nowIso()
    };
    onSessionRuntimeSignalCtx(ctx, normalizedSignal, {
      processSessionRuntimeSignal,
      replayQueuedWorkerMessages,
    });
    if (sessionRuntimeSignals.size > 200) {
      pruneSessionRuntimeSignals();
    }
  };

  const onAgentChatEvent = (envelope: AgentChatEventEnvelope): void => {
    if (disposed) return;
    persistStructuredWorkerChatEvent(envelope);
    onAgentChatEventCtx(ctx, envelope, { replayQueuedWorkerMessages });
  };

  const RUN_VIEW_NOISE_EVENT_TYPES = new Set([
    "scheduler_tick",
    "claim_heartbeat",
    "autopilot_parallelism_cap_adjusted",
    "context_snapshot_created",
    "context_pack_v2_metrics",
    "executor_session_attached",
    "startup_verification_warning",
    "step_metadata_updated",
    "step_dependencies_resolved",
  ]);

  const toRunViewSeverity = (value: string | null | undefined): MissionRunViewSeverity => {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (
      normalized.includes("fail")
      || normalized.includes("error")
      || normalized.includes("unavailable")
      || normalized.includes("blocked")
      || normalized.includes("cancel")
    ) {
      return "error";
    }
    if (
      normalized.includes("warn")
      || normalized.includes("pause")
      || normalized.includes("waiting")
      || normalized.includes("retry")
      || normalized.includes("review")
    ) {
      return "warning";
    }
    if (normalized.includes("success") || normalized.includes("complete") || normalized.includes("done")) {
      return "success";
    }
    return "info";
  };

  const ACTIVE_RUN_VIEW_STATUSES = new Set<OrchestratorRunStatus>(["active", "bootstrapping", "queued", "paused"]);

  const pickPreferredMissionRun = (
    runs: OrchestratorRun[],
    requestedRunId?: string | null,
  ): OrchestratorRun | null => {
    const explicitRunId = toOptionalString(requestedRunId);
    if (explicitRunId) {
      return runs.find((entry) => entry.id === explicitRunId) ?? null;
    }
    return runs.find((entry) => ACTIVE_RUN_VIEW_STATUSES.has(entry.status)) ?? runs[0] ?? null;
  };

  const getScopedOpenIntervention = (args: {
    mission: MissionDetail;
    run: OrchestratorRun | null;
  }) => {
    const interventionPriority = (entry: MissionDetail["interventions"][number]): number => {
      const metadata = isRecord(entry.metadata) ? entry.metadata : null;
      if (isMissionLaunchFailureMetadata(metadata, args.run?.id ?? null)) return 200;
      const reasonCode = typeof metadata?.reasonCode === "string" ? metadata.reasonCode.trim() : "";
      if (reasonCode === "coordinator_unavailable" || reasonCode === "coordinator_recovery_failed") return 100;
      return 0;
    };
    const sortByPriority = (left: MissionDetail["interventions"][number], right: MissionDetail["interventions"][number]) => {
      const priorityDelta = interventionPriority(right) - interventionPriority(left);
      if (priorityDelta !== 0) return priorityDelta;
      return Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt);
    };
    const openEntries = args.mission.interventions.filter((entry) => entry.status === "open");
    if (!args.run) return [...openEntries].sort(sortByPriority)[0] ?? null;
    const runScoped = openEntries
      .filter((entry) => toOptionalString(asRecord(entry.metadata)?.runId) === args.run?.id)
      .sort(sortByPriority)[0] ?? null;
    if (runScoped) return runScoped;
    if (args.mission.status === "intervention_required") {
      return [...openEntries]
        .filter((entry) => !toOptionalString(asRecord(entry.metadata)?.runId))
        .sort(sortByPriority)[0] ?? null;
    }
    return null;
  };

  const formatInterventionHaltDetail = (intervention: MissionDetail["interventions"][number]): string => {
    const metadata = isRecord(intervention.metadata) ? intervention.metadata : null;
    if (isMissionLaunchFailureMetadata(metadata)) {
      const stage = typeof metadata?.failureStageLabel === "string"
        ? metadata.failureStageLabel.trim()
        : typeof metadata?.failureStage === "string"
          ? metadata.failureStage.trim()
          : "launch";
      const rootError = typeof metadata?.rootError === "string" ? metadata.rootError.trim() : "";
      if (rootError.length > 0) {
        return `Launch failed during ${stage}: ${rootError}`;
      }
    }
    return intervention.requestedAction?.trim() || intervention.body;
  };

  const toRunViewLatestIntervention = (mission: MissionDetail): MissionRunViewLatestIntervention | null => {
    const latest = [...mission.interventions].sort((left, right) => {
      const leftAt = Date.parse(left.updatedAt || left.createdAt);
      const rightAt = Date.parse(right.updatedAt || right.createdAt);
      return (Number.isFinite(rightAt) ? rightAt : 0) - (Number.isFinite(leftAt) ? leftAt : 0);
    })[0];
    if (!latest) return null;
    const metadata = asRecord(latest.metadata);
    return {
      id: latest.id,
      title: latest.title,
      body: latest.body,
      interventionType: latest.interventionType,
      status: latest.status,
      requestedAction: latest.requestedAction ?? null,
      ownerLabel: toOptionalString(metadata?.questionOwnerLabel),
      createdAt: latest.updatedAt || latest.createdAt,
    };
  };

  const toRunViewWorkerStatus = (
    worker: OrchestratorWorkerState | null,
    attemptStatus: string | null,
  ): MissionRunViewWorkerSummary["status"] => {
    if (!worker) {
      if (attemptStatus === "blocked") return "blocked";
      if (attemptStatus === "failed") return "failed";
      if (attemptStatus === "succeeded" || attemptStatus === "canceled") return "completed";
      return "idle";
    }
    switch (worker.state) {
      case "spawned":
      case "initializing":
      case "working":
      case "waiting_input":
        return "active";
      case "failed":
        return "failed";
      case "completed":
        return "completed";
      case "disposed":
        return attemptStatus === "failed" ? "failed" : attemptStatus === "blocked" ? "blocked" : "idle";
      default:
        return "idle";
    }
  };

  const buildRunViewHaltReason = (args: {
    mission: MissionDetail;
    runStatus: OrchestratorRunStatus | null;
    coordinatorAvailability: MissionCoordinatorAvailability | null;
    latestIntervention: MissionRunViewLatestIntervention | null;
    openIntervention: MissionDetail["interventions"][number] | null;
  }): MissionRunViewHaltReason | null => {
    const openIntervention = args.openIntervention;
    if (openIntervention) {
      const interventionMetadata = isRecord(openIntervention.metadata) ? openIntervention.metadata : null;
      return {
        source: "intervention",
        title: openIntervention.title,
        detail: formatInterventionHaltDetail(openIntervention),
        severity: isMissionLaunchFailureMetadata(interventionMetadata) ? "error" : "warning",
        interventionId: openIntervention.id,
        createdAt: openIntervention.updatedAt || openIntervention.createdAt,
      };
    }
    if (args.coordinatorAvailability && args.coordinatorAvailability.available === false) {
      return {
        source: "coordinator",
        title: "Coordinator unavailable",
        detail: args.coordinatorAvailability.detail?.trim() || args.coordinatorAvailability.summary,
        severity: "error",
        createdAt: args.coordinatorAvailability.updatedAt,
      };
    }
    if (args.runStatus === "failed") {
      return {
        source: "run",
        title: "Run failed",
        detail: args.mission.lastError?.trim() || "The run stopped with a failure.",
        severity: "error",
        createdAt: args.mission.updatedAt,
      };
    }
    if (args.runStatus === "canceled" || args.mission.status === "canceled") {
      return {
        source: args.runStatus === "canceled" ? "run" : "mission",
        title: "Run canceled",
        detail: args.mission.lastError?.trim() || "Execution was canceled before completion.",
        severity: "warning",
        createdAt: args.mission.updatedAt,
      };
    }
    if (args.mission.status === "failed") {
      return {
        source: "mission",
        title: "Mission failed",
        detail: args.mission.lastError?.trim() || args.latestIntervention?.body || "Mission ended in a failed state.",
        severity: "error",
        createdAt: args.mission.updatedAt,
      };
    }
    return null;
  };

  const buildRunViewTimelineItem = (
    event: OrchestratorRunGraph["timeline"][number],
    stepById: Map<string, OrchestratorStep>,
  ): MissionRunViewProgressItem | null => {
    if (RUN_VIEW_NOISE_EVENT_TYPES.has(event.eventType)) return null;
    const step = event.stepId ? stepById.get(event.stepId) ?? null : null;
    const stepLabel = step?.title ?? step?.stepKey ?? "run";
    const detailRecord = isRecord(event.detail) ? event.detail : null;
    const detailSummary = toOptionalString(detailRecord?.summary)
      ?? toOptionalString(detailRecord?.message)
      ?? toOptionalString(detailRecord?.reason)
      ?? null;

    switch (event.eventType) {
      case "coordinator_status": {
        const state = toOptionalString(detailRecord?.state) ?? event.reason;
        const message = detailSummary ?? "The orchestrator updated its status.";
        const title = state === "booting"
          ? "Orchestrator online"
          : state === "analyzing_prompt"
            ? "Orchestrator is sizing up the run"
            : state === "fetching_project_context"
              ? "Orchestrator is gathering project context"
              : state === "launching_planner"
                ? "Planning worker is launching"
                : state === "waiting_on_planner"
                  ? "Planning worker is in flight"
                  : state === "planner_launch_failed"
                    ? "Planning worker launch failed"
                    : state === "stopped"
                      ? "Orchestrator offline"
                      : "Orchestrator update";
        const audience = state === "launching_planner" || state === "waiting_on_planner"
          ? "mission_feed"
          : "timeline";
        return {
          id: `timeline:${event.id}`,
          at: event.createdAt,
          kind: "system",
          title,
          detail: message,
          severity: toRunViewSeverity(state),
          audience,
          source: "timeline",
          stepId: event.stepId,
          stepKey: step?.stepKey ?? null,
          attemptId: event.attemptId,
        };
      }
      case "phase_transition":
        return {
          id: `timeline:${event.id}`,
          at: event.createdAt,
          kind: "system",
          title: "Phase advanced",
          detail: detailSummary
            ?? `Now working in ${(toOptionalString(detailRecord?.toPhaseName) ?? toOptionalString(detailRecord?.toPhaseKey) ?? "the next phase")}.`,
          severity: "info",
          audience: "mission_feed",
          source: "timeline",
          stepId: event.stepId,
          stepKey: step?.stepKey ?? null,
          attemptId: event.attemptId,
        };
      case "step_status_changed": {
        if (!["running", "blocked", "failed", "succeeded", "canceled"].includes(event.reason)) return null;
        const reasonTitle = event.reason === "running"
          ? "Worker started"
          : event.reason === "succeeded"
            ? "Worker completed"
            : event.reason === "blocked"
              ? "Worker blocked"
              : event.reason === "failed"
                ? "Worker failed"
                : "Worker canceled";
        return {
          id: `timeline:${event.id}`,
          at: event.createdAt,
          kind: "worker",
          title: reasonTitle,
          detail: detailSummary ?? `${stepLabel} is ${event.reason}.`,
          severity: toRunViewSeverity(event.reason),
          audience: "mission_feed",
          source: "timeline",
          stepId: event.stepId,
          stepKey: step?.stepKey ?? null,
          attemptId: event.attemptId,
        };
      }
      case "worker_status_reported":
      case "worker_result_reported":
        return {
          id: `timeline:${event.id}`,
          at: event.createdAt,
          kind: "worker",
          title: event.eventType === "worker_result_reported" ? "Worker result" : "Worker update",
          detail: detailSummary ?? `${stepLabel} reported progress.`,
          severity: toRunViewSeverity(detailSummary ?? event.reason),
          audience: "mission_feed",
          source: "timeline",
          stepId: event.stepId,
          stepKey: step?.stepKey ?? null,
          attemptId: event.attemptId,
        };
      case "autopilot_step_skipped":
        return {
          id: `timeline:${event.id}`,
          at: event.createdAt,
          kind: "system",
          title: "Step skipped",
          detail: detailSummary ?? `${stepLabel} was skipped by the orchestrator.`,
          severity: "warning",
          audience: "mission_feed",
          source: "timeline",
          stepId: event.stepId,
          stepKey: step?.stepKey ?? null,
          attemptId: event.attemptId,
        };
      case "planning_artifact_missing":
        return {
          id: `timeline:${event.id}`,
          at: event.createdAt,
          kind: "intervention",
          title: "Planner failed to return a plan",
          detail: detailSummary ?? `${stepLabel} completed without a usable plan payload.`,
          severity: "error",
          audience: "mission_feed",
          source: "timeline",
          stepId: event.stepId,
          stepKey: step?.stepKey ?? null,
          attemptId: event.attemptId,
        };
      default:
        if (
          event.eventType.startsWith("validation_")
          || event.reason.startsWith("validation_")
        ) {
          return {
            id: `timeline:${event.id}`,
            at: event.createdAt,
            kind: "validation",
            title: "Validation update",
            detail: detailSummary ?? `${stepLabel} validation changed.`,
            severity: toRunViewSeverity(event.reason),
            audience: "mission_feed",
            source: "timeline",
            stepId: event.stepId,
            stepKey: step?.stepKey ?? null,
            attemptId: event.attemptId,
          };
        }
        return null;
    }
  };

  const buildRunViewRuntimeItem = (
    event: NonNullable<OrchestratorRunGraph["runtimeEvents"]>[number],
    stepById: Map<string, OrchestratorStep>,
  ): MissionRunViewProgressItem | null => {
    if (
      RUN_VIEW_NOISE_EVENT_TYPES.has(event.eventType)
      || event.eventType === "heartbeat"
      || event.eventType === "progress"
    ) {
      return null;
    }
    const step = event.stepId ? stepById.get(event.stepId) ?? null : null;
    const payload = isRecord(event.payload) ? event.payload : null;
    const detail = toOptionalString(payload?.summary)
      ?? toOptionalString(payload?.message)
      ?? toOptionalString(payload?.reason)
      ?? toOptionalString(payload?.directive)
      ?? null;

    if (event.eventType === "coordinator_steering" || event.eventType === "coordinator_broadcast") {
      return {
        id: `runtime:${event.id}`,
        at: event.occurredAt,
        kind: "user",
        title: event.eventType === "coordinator_broadcast" ? "Broadcast sent" : "Steering applied",
        detail: detail ?? "Mission steering was applied.",
        severity: "info",
        audience: "mission_feed",
        source: "runtime",
        stepId: event.stepId,
        stepKey: step?.stepKey ?? null,
        attemptId: event.attemptId,
      };
    }
    if (event.eventType === "intervention_opened") {
      const title = toOptionalString(payload?.title) ?? "Intervention opened";
      const body = toOptionalString(payload?.body);
      const requestedAction = toOptionalString(payload?.requestedAction);
      return {
        id: `runtime:${event.id}`,
        at: event.occurredAt,
        kind: "intervention",
        title,
        detail: body ?? detail ?? requestedAction ?? "ADE opened an intervention and paused the mission.",
        severity: "warning",
        audience: "mission_feed",
        source: "runtime",
        stepId: event.stepId,
        stepKey: step?.stepKey ?? null,
        attemptId: event.attemptId,
      };
    }
    if (event.eventType === "intervention_resolved") {
      const resolutionLabel =
        payload?.resolutionKind === "accept_defaults"
          ? "Defaults accepted"
          : payload?.resolutionKind === "skip_question"
            ? "Question skipped"
            : payload?.resolutionKind === "cancel_run"
              ? "Run canceled"
              : "Answer received";
      return {
        id: `runtime:${event.id}`,
        at: event.occurredAt,
        kind: "user",
        title: resolutionLabel,
        detail: detail ?? "ADE applied the intervention outcome.",
        severity: payload?.resolutionKind === "cancel_run" ? "warning" : "info",
        audience: "mission_feed",
        source: "runtime",
        stepId: event.stepId,
        stepKey: step?.stepKey ?? null,
        attemptId: event.attemptId,
      };
    }
    if (event.eventType === "worker_message") {
      const sourceLabel = toOptionalString(payload?.sourceLabel) ?? "One worker";
      const targetLabel = toOptionalString(payload?.targetLabel) ?? "another worker";
      return {
        id: `runtime:${event.id}`,
        at: event.occurredAt,
        kind: "worker",
        title: "Agent handoff",
        detail: detail ?? `${sourceLabel} sent a message to ${targetLabel}.`,
        severity: "info",
        audience: "mission_feed",
        source: "runtime",
        stepId: event.stepId,
        stepKey: step?.stepKey ?? null,
        attemptId: event.attemptId,
      };
    }
    if (
      event.eventType === "validation_report"
      || event.eventType === "validation_contract_unfulfilled"
      || event.eventType === "validation_self_check_reminder"
      || event.eventType === "validation_gate_blocked"
    ) {
      return {
        id: `runtime:${event.id}`,
        at: event.occurredAt,
        kind: "validation",
        title: "Validation signal",
        detail: detail ?? `${step?.title ?? step?.stepKey ?? "Step"} validation state changed.`,
        severity: toRunViewSeverity(event.eventType),
        audience: "mission_feed",
        source: "runtime",
        stepId: event.stepId,
        stepKey: step?.stepKey ?? null,
        attemptId: event.attemptId,
      };
    }
    return null;
  };

  const buildRunViewProgressLog = (args: {
    mission: MissionDetail;
    graph: OrchestratorRunGraph | null;
  }): MissionRunViewProgressItem[] => {
    const stepById = new Map((args.graph?.steps ?? []).map((step) => [step.id, step] as const));
    const items: MissionRunViewProgressItem[] = [];
    const seenInterventionIds = new Set<string>();
    const hasRuntimeInterventionEvents = new Set<string>();
    for (const event of args.graph?.timeline ?? []) {
      const item = buildRunViewTimelineItem(event, stepById);
      if (item) items.push(item);
    }
    for (const event of args.graph?.runtimeEvents ?? []) {
      const payload = isRecord(event.payload) ? event.payload : null;
      const interventionId = toOptionalString(payload?.interventionId);
      if (interventionId) {
        seenInterventionIds.add(interventionId);
        hasRuntimeInterventionEvents.add(event.eventType);
      }
      const item = buildRunViewRuntimeItem(event, stepById);
      if (item) items.push(item);
    }
    for (const intervention of args.mission.interventions) {
      if (seenInterventionIds.has(intervention.id)) continue;
      items.push({
        id: `intervention:${intervention.id}:${intervention.status}`,
        at: intervention.updatedAt || intervention.createdAt,
        kind: "intervention",
        title: intervention.title,
        detail: intervention.requestedAction?.trim() || intervention.body,
        severity: intervention.status === "open" ? "warning" : "info",
        audience: "mission_feed",
        source: "intervention",
      });
    }
    for (const event of args.mission.events) {
      if (event.eventType !== "mission_intervention_resolved") {
        continue;
      }
      if (hasRuntimeInterventionEvents.has("intervention_resolved")) continue;
      items.push({
        id: `mission:${event.id}`,
        at: event.createdAt,
        kind: "user",
        title: (() => {
          const payload = isRecord(event.payload) ? event.payload : null;
          if (payload?.resolutionKind === "accept_defaults") return "Defaults accepted";
          if (payload?.resolutionKind === "skip_question") return "Question skipped";
          if (payload?.resolutionKind === "cancel_run") return "Run canceled";
          return "Intervention resolved";
        })(),
        detail: event.summary,
        severity: toRunViewSeverity(event.eventType),
        audience: "mission_feed",
        source: "mission",
      });
    }
    if (args.mission.status === "completed" && args.mission.completedAt) {
      items.push({
        id: `mission-terminal:${args.mission.id}:completed`,
        at: args.mission.completedAt,
        kind: "system",
        title: "Mission completed",
        detail: args.mission.outcomeSummary?.trim() || "The mission finished successfully.",
        severity: "success",
        audience: "mission_feed",
        source: "mission",
      });
    } else if (args.mission.status === "failed" && args.mission.updatedAt) {
      items.push({
        id: `mission-terminal:${args.mission.id}:failed`,
        at: args.mission.updatedAt,
        kind: "system",
        title: "Mission failed",
        detail: args.mission.lastError?.trim() || "The mission stopped with an error.",
        severity: "error",
        audience: "mission_feed",
        source: "mission",
      });
    } else if (args.mission.status === "canceled" && args.mission.updatedAt) {
      items.push({
        id: `mission-terminal:${args.mission.id}:canceled`,
        at: args.mission.updatedAt,
        kind: "system",
        title: "Mission canceled",
        detail: args.mission.lastError?.trim() || "The mission was canceled before completion.",
        severity: "warning",
        audience: "mission_feed",
        source: "mission",
      });
    }
    return items
      .sort((left, right) => {
        const delta = Date.parse(right.at) - Date.parse(left.at);
        return Number.isFinite(delta) && delta !== 0 ? delta : right.id.localeCompare(left.id);
      })
      .slice(0, 80);
  };

  const getRunView = async (
    viewArgs: GetMissionRunViewArgs,
  ): Promise<MissionRunView | null> => {
    const missionId = String(viewArgs.missionId ?? "").trim();
    if (!missionId.length) return null;
    const mission = missionService.get(missionId);
    if (!mission) return null;

    const runs = orchestratorService.listRuns({ missionId, limit: 200 });
    const run = pickPreferredMissionRun(runs, viewArgs.runId);
    const graph = run ? orchestratorService.getRunGraph({ runId: run.id, timelineLimit: 200 }) : null;
    const stateDoc = run ? await getMissionStateDocument({ runId: run.id }) : null;
    const workerStates = run ? getWorkerStates({ runId: run.id }) : [];
    const latestIntervention = toRunViewLatestIntervention(mission);
    const openIntervention = getScopedOpenIntervention({ mission, run });
    const openInterventionReasonCode = toOptionalString(asRecord(openIntervention?.metadata)?.reasonCode);
    const coordinatorAvailability = stateDoc?.coordinatorAvailability
      ?? (
        openInterventionReasonCode === "coordinator_unavailable" || openInterventionReasonCode === "coordinator_recovery_failed"
          ? {
              available: false,
              mode: "continuation_required",
              summary: openIntervention?.title ?? "Coordinator unavailable",
              detail: openIntervention?.body ?? null,
              updatedAt: openIntervention?.updatedAt ?? mission.updatedAt,
            } satisfies MissionCoordinatorAvailability
          : null
      )
      ?? (
        run && coordinatorAgents.get(run.id)?.isAlive
          ? {
              available: true,
              mode: "continuation_required",
              summary: "Coordinator online",
              detail: null,
              updatedAt: mission.updatedAt,
            } satisfies MissionCoordinatorAvailability
          : null
      );

    const haltReason = buildRunViewHaltReason({
      mission,
      runStatus: run?.status ?? null,
      coordinatorAvailability,
      latestIntervention,
      openIntervention,
    });

    const activeStep = (() => {
      const steps = filterExecutionSteps(graph?.steps ?? []);
      const byPriority = [
        steps.find((step) => step.status === "running"),
        steps.find((step) => step.status === "blocked"),
        steps.find((step) => step.status === "ready" || step.status === "pending"),
        steps.find((step) => step.status === "failed"),
      ];
      return byPriority.find((step): step is OrchestratorStep => Boolean(step)) ?? null;
    })();

    const phaseRuntime = asRecord(isRecord(graph?.run.metadata) ? graph?.run.metadata.phaseRuntime : null);
    const activeStepMeta = asRecord(activeStep?.metadata);
    const displayStatus = (() => {
      if (openIntervention || coordinatorAvailability?.available === false) return "blocked" satisfies MissionRunViewDisplayStatus;
      if (run?.status === "failed" || mission.status === "failed") return "failed" satisfies MissionRunViewDisplayStatus;
      if (run?.status === "canceled" || mission.status === "canceled") return "canceled" satisfies MissionRunViewDisplayStatus;
      if (run?.status === "succeeded" || mission.status === "completed") return "completed" satisfies MissionRunViewDisplayStatus;
      if (run?.status === "queued" || run?.status === "bootstrapping" || mission.status === "planning") return "starting" satisfies MissionRunViewDisplayStatus;
      if (run?.status === "paused") return "paused" satisfies MissionRunViewDisplayStatus;
      if (run?.status === "active" || mission.status === "in_progress") return "running" satisfies MissionRunViewDisplayStatus;
      return "not_started" satisfies MissionRunViewDisplayStatus;
    })();

    const progressLog = buildRunViewProgressLog({ mission, graph });
    const stepById = new Map((graph?.steps ?? []).map((step) => [step.id, step] as const));
    const attemptById = new Map((graph?.attempts ?? []).map((attempt) => [attempt.id, attempt] as const));
    const workers: MissionRunViewWorkerSummary[] = workerStates.map((worker) => {
      const step = stepById.get(worker.stepId) ?? null;
      const attempt = attemptById.get(worker.attemptId) ?? null;
      return {
        attemptId: worker.attemptId,
        stepId: worker.stepId,
        stepKey: step?.stepKey ?? null,
        stepTitle: step?.title ?? null,
        laneId: step?.laneId ?? null,
        sessionId: worker.sessionId ?? null,
        executorKind: worker.executorKind ?? null,
        state: worker.state,
        status: toRunViewWorkerStatus(worker, attempt?.status ?? null),
        lastHeartbeatAt: worker.lastHeartbeatAt ?? null,
        completedAt: worker.completedAt ?? null,
      };
    });

    for (const step of filterExecutionSteps(graph?.steps ?? []).filter((entry) => entry.status === "blocked")) {
      if (workers.some((worker) => worker.stepId === step.id)) continue;
      const latestAttempt = [...(graph?.attempts ?? [])]
        .filter((attempt) => attempt.stepId === step.id)
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null;
      workers.push({
        attemptId: latestAttempt?.id ?? null,
        stepId: step.id,
        stepKey: step.stepKey,
        stepTitle: step.title,
        laneId: step.laneId ?? null,
        sessionId: latestAttempt?.executorSessionId ?? null,
        executorKind: latestAttempt?.executorKind ?? null,
        state: "blocked",
        status: "blocked",
        lastHeartbeatAt: latestAttempt?.completedAt ?? latestAttempt?.startedAt ?? latestAttempt?.createdAt ?? null,
        completedAt: latestAttempt?.completedAt ?? null,
      });
    }

    const missionComputerUse = computerUseArtifactBrokerService
      ? buildComputerUseOwnerSnapshot({
          broker: computerUseArtifactBrokerService,
          owner: { kind: "mission", id: missionId },
          policy: mission.computerUse,
          requiredKinds: collectRequiredComputerUseKindsFromPhases(mission.phaseConfiguration?.selectedPhases ?? []),
          limit: 50,
        })
      : null;

    return {
      missionId,
      runId: run?.id ?? null,
      lifecycle: {
        missionStatus: mission.status,
        runStatus: run?.status ?? null,
        displayStatus,
        summary: haltReason?.detail
          ?? (
            displayStatus === "running"
              ? activeStep?.title
                ? `Working on ${activeStep.title}.`
                : "Mission is actively running."
              : displayStatus === "starting"
                ? "Preparing mission runtime and coordinator."
                : displayStatus === "completed"
                  ? (mission.outcomeSummary?.trim() || "Mission completed.")
                  : displayStatus === "failed"
                    ? (mission.lastError?.trim() || "Mission failed.")
                    : displayStatus === "canceled"
                      ? "Mission was canceled."
                      : displayStatus === "paused"
                        ? "Mission is paused."
                      : "Mission has not started yet."
          ),
        startedAt: run?.startedAt ?? mission.startedAt ?? null,
        completedAt: run?.completedAt ?? mission.completedAt ?? null,
      },
      active: {
        phaseKey: toOptionalString(activeStepMeta?.phaseKey)
          ?? toOptionalString(phaseRuntime?.currentPhaseKey)
          ?? toOptionalString(stateDoc?.progress.currentPhase)
          ?? null,
        phaseName: toOptionalString(activeStepMeta?.phaseName)
          ?? toOptionalString(phaseRuntime?.currentPhaseName)
          ?? toOptionalString(stateDoc?.progress.currentPhase)
          ?? null,
        stepId: activeStep?.id ?? null,
        stepKey: activeStep?.stepKey ?? null,
        stepTitle: activeStep?.title ?? null,
        featureLabel: toOptionalString(activeStepMeta?.featureLabel)
          ?? toOptionalString(activeStepMeta?.featureKey)
          ?? toOptionalString(activeStepMeta?.phaseName)
          ?? null,
      },
      coordinator: {
        available: coordinatorAvailability?.available ?? null,
        mode: coordinatorAvailability?.mode ?? null,
        summary: coordinatorAvailability?.summary ?? null,
        detail: coordinatorAvailability?.detail ?? null,
        updatedAt: coordinatorAvailability?.updatedAt ?? null,
      },
      latestIntervention,
      haltReason,
      workers: workers.sort((left, right) => {
        const leftAt = Date.parse(left.completedAt || left.lastHeartbeatAt || "");
        const rightAt = Date.parse(right.completedAt || right.lastHeartbeatAt || "");
        return (Number.isFinite(rightAt) ? rightAt : 0) - (Number.isFinite(leftAt) ? leftAt : 0);
      }),
      progressLog,
      lastMeaningfulProgress: progressLog[0] ?? null,
      closeoutRequirements: graph
        ? buildMissionCloseoutRequirements({
            mission,
            graph,
            policy: resolveMissionFinalizationPolicy(resolveActivePhaseSettings(mission.id).settings.prStrategy ?? { kind: "manual" }),
            finalization: stateDoc?.finalization ?? null,
            stateDoc,
          })
        : [],
      computerUse: missionComputerUse,
    };
  };

  // ── Execution Plan Preview ──────────────────────────────────
  const getExecutionPlanPreview = (previewArgs: { runId: string }): ExecutionPlanPreview | null => {
    const runId = previewArgs.runId;
    try {
      const graph = orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
      const mission = missionService.get(graph.run.missionId);
      if (!mission) return null;

      const teamManifest = runTeamManifests.get(runId);
      // Prefer mission phase settings, then use default runtime policy values.
      const { settings: previewPhaseSettings } = resolveActivePhaseSettings(graph.run.missionId);
      const recoveryPolicy: RecoveryLoopPolicy = previewPhaseSettings.recoveryLoop ?? DEFAULT_RECOVERY_LOOP_POLICY;
      const integrationPrPlan: IntegrationPrPolicy = previewPhaseSettings.integrationPr ?? DEFAULT_INTEGRATION_PR_POLICY;

      // Group steps into phases by stepType
      const phaseMap = new Map<string, typeof graph.steps>();
      for (const step of graph.steps) {
        const stepMeta = isRecord(step.metadata) ? step.metadata : {};
        const phase = typeof stepMeta.stepType === "string" && stepMeta.stepType.trim().length > 0
          ? stepMeta.stepType.trim()
          : step.stepKey.replace(/_\d+$/, "");
        const bucket = phaseMap.get(phase) ?? [];
        bucket.push(step);
        phaseMap.set(phase, bucket);
      }

      const phases: ExecutionPlanPhase[] = [];
      for (const [phaseName, phaseSteps] of phaseMap.entries()) {
        const stepPreviews: ExecutionPlanStepPreview[] = phaseSteps.map((step) => {
          const stepMeta = isRecord(step.metadata) ? step.metadata : {};
          const workerAssignment = teamManifest?.workers.find((w) => w.assignedStepKeys.includes(step.stepKey));
          const role: OrchestratorWorkerRole = workerAssignment?.role ?? inferRoleFromStepMetadata(stepMeta, step.stepKey);
          const stepExecutorKind = typeof stepMeta.executorKind === "string"
            ? (stepMeta.executorKind as OrchestratorExecutorKind)
            : workerAssignment?.executorKind ?? "unified";
          return {
            stepKey: step.stepKey,
            title: step.title ?? step.stepKey,
            role,
            executorKind: stepExecutorKind,
            model: typeof stepMeta.model === "string" ? stepMeta.model : "default",
            laneId: step.laneId ?? null,
            dependencies: step.dependencyStepIds ?? [],
            gateType: typeof stepMeta.gateType === "string" ? stepMeta.gateType : null,
            recoveryOnFailure: recoveryPolicy.enabled
          };
        });

        const firstStep = phaseSteps[0];
        const firstStepMeta = firstStep ? (isRecord(firstStep.metadata) ? firstStep.metadata : {}) : {};
        const firstStepExecutorKind = typeof firstStepMeta.executorKind === "string"
          ? (firstStepMeta.executorKind as OrchestratorExecutorKind)
          : "unified";
        phases.push({
          phase: phaseName,
          enabled: true,
          stepCount: phaseSteps.length,
          steps: stepPreviews,
          model: typeof firstStepMeta.model === "string" ? firstStepMeta.model : "default",
          executorKind: firstStepExecutorKind,
          gatePolicy: typeof firstStepMeta.gateType === "string" ? firstStepMeta.gateType : "none",
          recoveryEnabled: recoveryPolicy.enabled
        });
      }

      // Team summary
      const workerCount = teamManifest?.workers.length ?? graph.steps.length;
      const parallelLanes = teamManifest?.parallelLanes.length ?? new Set(graph.steps.map((s) => s.laneId).filter(Boolean)).size;
      const roles = teamManifest
        ? [...new Set(teamManifest.workers.map((w) => w.role))]
        : [...new Set(phases.flatMap((p) => p.steps.map((s) => s.role)))];

      // Alignment check
      const driftNotes: string[] = [];
      const actualStepKeys = new Set(graph.steps.map((s) => s.stepKey));
      if (teamManifest) {
        for (const w of teamManifest.workers) {
          for (const key of w.assignedStepKeys) {
            if (!actualStepKeys.has(key)) {
              driftNotes.push(`Team manifest references step "${key}" which no longer exists in run.`);
            }
          }
        }
      }
      const aligned = driftNotes.length === 0;

      // Strategy
      const strategy = teamManifest
        ? `${teamManifest.complexity.estimatedScope} ${teamManifest.complexity.domain} mission with ${workerCount} workers`
        : `${graph.steps.length}-step execution plan`;

      return {
        runId,
        missionId: graph.run.missionId,
        generatedAt: nowIso(),
        strategy,
        phases,
        teamSummary: {
          workerCount,
          parallelLanes,
          roles
        },
        recoveryPolicy,
        integrationPrPlan,
        aligned,
        driftNotes
      };
    } catch (error) {
      logger.debug("ai_orchestrator.execution_plan_preview_failed", {
        runId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  };

  const getMissionStateDocument = async (
    stateArgs: GetMissionStateDocumentArgs
  ): Promise<MissionStateDocument | null> => {
    const runId = String(stateArgs.runId ?? "").trim();
    if (!runId.length || !projectRoot) return null;
    try {
      return await readMissionStateDocument({
        projectRoot,
        runId,
      });
    } catch (error) {
      logger.debug("ai_orchestrator.mission_state_read_failed", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  // ── Aggregated Usage Stats (delegated to metricsAndUsage) ──
  const getAggregatedUsage = (usageArgs: GetAggregatedUsageArgs): AggregatedUsageStats =>
    getAggregatedUsageCtx(ctx, usageArgs);

  const propagateAttemptTokenUsage = (runId: string, attemptId: string): void =>
    propagateAttemptTokenUsageCtx(ctx, runId, attemptId);

  if (hasRecoverableRuntimeWork()) {
    hydratePersistedAttemptRuntimeState();
    hydrateRuntimeSignalsFromEventBus();
    replayOpenQuestionsFromEventBus();
    void (async () => {
      try {
        await reconcileThreadedMessagingState();
      } catch (error) {
        logger.debug("ai_orchestrator.chat_reconciliation_failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        if (!disposed) {
          startHealthSweepLoop();
        }
      }
    })();
  } else {
    startHealthSweepLoop();
  }

  // ---------------------------------------------------------------------------
  // Smart Agent Recovery: AI-diagnosed failure handling with tiered response
  // ---------------------------------------------------------------------------

  const ALL_MISSION_LOG_CHANNELS: MissionLogChannel[] = [
    "timeline",
    "runtime",
    "chat",
    "outputs",
    "reflections",
    "retrospectives",
    "interventions",
  ];

  const normalizeMissionLogChannels = (channels?: MissionLogChannel[]): MissionLogChannel[] => {
    if (!Array.isArray(channels) || channels.length === 0) return ALL_MISSION_LOG_CHANNELS;
    const out: MissionLogChannel[] = [];
    for (const raw of channels) {
      if (
        raw === "timeline" ||
        raw === "runtime" ||
        raw === "chat" ||
        raw === "outputs" ||
        raw === "reflections" ||
        raw === "retrospectives" ||
        raw === "interventions"
      ) {
        if (!out.includes(raw)) out.push(raw);
      }
    }
    return out.length > 0 ? out : ALL_MISSION_LOG_CHANNELS;
  };

  const toMissionLogLevel = (args: {
    eventType?: string | null;
    message?: string | null;
  }): MissionLogEntry["level"] => {
    const text = `${args.eventType ?? ""} ${args.message ?? ""}`.toLowerCase();
    if (
      text.includes("failed") ||
      text.includes("error") ||
      text.includes("unavailable") ||
      text.includes("hard_cap") ||
      text.includes("budget_exceeded")
    ) {
      return "error";
    }
    if (
      text.includes("warning") ||
      text.includes("blocked") ||
      text.includes("paused") ||
      text.includes("retry")
    ) {
      return "warning";
    }
    return "info";
  };

  const pickMissionLogRunId = (missionId: string, requestedRunId?: string | null): string | null => {
    const runs = orchestratorService.listRuns({ missionId, limit: 200 });
    return pickPreferredMissionRun(runs, requestedRunId)?.id ?? null;
  };

  const getMissionLogs = async (args: GetMissionLogsArgs): Promise<GetMissionLogsResult> => {
    const missionId = String(args.missionId ?? "").trim();
    if (!missionId.length) throw new Error("missionId is required.");
    const mission = missionService.get(missionId);
    if (!mission) throw new Error(`Mission not found: ${missionId}`);

    const channels = normalizeMissionLogChannels(args.channels);
    const channelSet = new Set<MissionLogChannel>(channels);
    const runId = pickMissionLogRunId(missionId, args.runId);
    const entries: MissionLogEntry[] = [];
    const pushEntry = (entry: MissionLogEntry) => entries.push(entry);

    if (channelSet.has("timeline")) {
      for (const event of mission.events) {
        pushEntry({
          id: `mission-event:${event.id}`,
          missionId,
          runId: runId ?? null,
          channel: "timeline",
          level: toMissionLogLevel({ eventType: event.eventType, message: event.summary }),
          at: event.createdAt,
          title: event.eventType,
          message: event.summary,
          payload: event.payload,
        });
      }
    }

    if (runId && channelSet.has("timeline")) {
      const timeline = orchestratorService.listTimeline({ runId, limit: 4_000 });
      for (const event of timeline) {
        pushEntry({
          id: `timeline:${event.id}`,
          missionId,
          runId,
          channel: "timeline",
          level: toMissionLogLevel({ eventType: event.eventType, message: event.reason }),
          at: event.createdAt,
          title: event.eventType,
          message: event.reason,
          stepId: event.stepId ?? null,
          attemptId: event.attemptId ?? null,
          payload: event.detail ?? null,
        });
      }
    }

    if (runId && channelSet.has("runtime")) {
      const runtimeEvents = orchestratorService.listRuntimeEvents({ runId, limit: 4_000 });
      for (const event of runtimeEvents) {
        const payload = isRecord(event.payload) ? event.payload : null;
        const summary =
          (payload && typeof payload.summary === "string" && payload.summary.trim().length > 0)
            ? payload.summary.trim()
            : event.eventType;
        pushEntry({
          id: `runtime:${event.id}`,
          missionId,
          runId,
          channel: "runtime",
          level: toMissionLogLevel({ eventType: event.eventType, message: summary }),
          at: event.occurredAt,
          title: event.eventType,
          message: summary,
          stepId: event.stepId ?? null,
          attemptId: event.attemptId ?? null,
          payload,
        });
      }
    }

    if (channelSet.has("chat")) {
      const seenMessageIds = new Set<string>();
      const addChatEntry = (message: OrchestratorChatMessage): void => {
        if (seenMessageIds.has(message.id)) return;
        seenMessageIds.add(message.id);
        const role = message.role;
        const prefix = role === "user" ? "User" : role === "agent" ? "Agent" : role === "worker" ? "Worker" : "Orchestrator";
        const text = String(message.content ?? "").trim();
        pushEntry({
          id: `chat:${message.id}`,
          missionId,
          runId: message.runId ?? runId ?? null,
          channel: "chat",
          level: role === "orchestrator" ? "warning" : "info",
          at: message.timestamp,
          title: `${prefix} message`,
          message: text.length > 0 ? text : "(empty message)",
          stepKey: message.stepKey ?? null,
          threadId: message.threadId ?? null,
          payload: isRecord(message.metadata) ? message.metadata : null,
        });
      };

      const globalMessages = getGlobalChat({ missionId, limit: 2_000 });
      for (const message of globalMessages) addChatEntry(message);

      const threads = listChatThreads({ missionId, includeClosed: true });
      for (const thread of threads) {
        const threadMessages = getThreadMessages({ missionId, threadId: thread.id, limit: 500 });
        for (const message of threadMessages) addChatEntry(message);
      }
    }

    if (runId && channelSet.has("outputs")) {
      const graph = orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
      const stepById = new Map(graph.steps.map((step) => [step.id, step] as const));
      for (const attempt of graph.attempts) {
        const summary = attempt.resultEnvelope?.summary?.trim();
        const errorMessage = attempt.errorMessage?.trim();
        if (!summary && !errorMessage) continue;
        const step = stepById.get(attempt.stepId);
        const msg = summary ?? errorMessage ?? `Attempt ${attempt.status}`;
        pushEntry({
          id: `output:${attempt.id}`,
          missionId,
          runId,
          channel: "outputs",
          level: attempt.status === "failed" ? "error" : attempt.status === "blocked" ? "warning" : "info",
          at: attempt.completedAt ?? attempt.startedAt ?? attempt.createdAt,
          title: step ? `Step output: ${step.stepKey}` : "Step output",
          message: msg,
          stepId: attempt.stepId,
          stepKey: step?.stepKey ?? null,
          attemptId: attempt.id,
          payload: attempt.resultEnvelope?.outputs ?? null,
        });
      }
      const checkpoint = getContextCheckpoint({ missionId });
      if (checkpoint) {
        pushEntry({
          id: `output:checkpoint:${checkpoint.id}`,
          missionId,
          runId,
          channel: "outputs",
          level: "info",
          at: checkpoint.createdAt,
          title: "Context checkpoint",
          message: `Checkpoint saved for ${checkpoint.trigger ?? "runtime state"}.`,
          payload: {
            trigger: checkpoint.trigger,
            summary: checkpoint.summary,
          },
        });
      }
    }

    if (channelSet.has("reflections")) {
      const reflections = orchestratorService.listReflections({
        missionId,
        ...(runId ? { runId } : {}),
        limit: 500,
      });
      for (const reflection of reflections) {
        const message = `${reflection.observation} Recommendation: ${reflection.recommendation}`;
        pushEntry({
          id: `reflection:${reflection.id}`,
          missionId,
          runId: reflection.runId,
          channel: "reflections",
          level: "info",
          at: reflection.occurredAt,
          title: `Reflection (${reflection.signalType})`,
          message,
          stepId: reflection.stepId,
          attemptId: reflection.attemptId,
          payload: {
            phase: reflection.phase,
            agentRole: reflection.agentRole,
            context: reflection.context,
          },
        });
      }
    }

    if (channelSet.has("retrospectives")) {
      const retrospectives = orchestratorService.listRetrospectives({ missionId, limit: 100 });
      for (const retrospective of retrospectives) {
        if (runId && retrospective.runId !== runId) continue;
        const summaryParts: string[] = [];
        if (retrospective.wins.length > 0) summaryParts.push(`Wins: ${retrospective.wins.slice(0, 3).join("; ")}`);
        if (retrospective.failures.length > 0) summaryParts.push(`Failures: ${retrospective.failures.slice(0, 3).join("; ")}`);
        if (retrospective.followUpActions.length > 0) {
          summaryParts.push(`Follow-ups: ${retrospective.followUpActions.slice(0, 3).join("; ")}`);
        }
        pushEntry({
          id: `retrospective:${retrospective.id}`,
          missionId,
          runId: retrospective.runId,
          channel: "retrospectives",
          level: retrospective.finalStatus === "failed" ? "error" : retrospective.finalStatus === "canceled" ? "warning" : "info",
          at: retrospective.generatedAt,
          title: "Run retrospective",
          message: summaryParts.length > 0 ? summaryParts.join(" | ") : "Retrospective generated.",
          payload: {
            finalStatus: retrospective.finalStatus,
            wins: retrospective.wins,
            failures: retrospective.failures,
            unresolvedRisks: retrospective.unresolvedRisks,
            followUpActions: retrospective.followUpActions,
            topPainPoints: retrospective.topPainPoints,
            topImprovements: retrospective.topImprovements,
            estimatedImpact: retrospective.estimatedImpact,
          },
        });
      }
    }

    if (channelSet.has("interventions")) {
      for (const intervention of mission.interventions) {
        pushEntry({
          id: `intervention:${intervention.id}`,
          missionId,
          runId: runId ?? null,
          channel: "interventions",
          level: intervention.status === "open" ? "warning" : "info",
          at: intervention.updatedAt ?? intervention.createdAt,
          title: intervention.title,
          message: intervention.body,
          interventionId: intervention.id,
          payload: {
            status: intervention.status,
            interventionType: intervention.interventionType,
            requestedAction: intervention.requestedAction,
            resolutionNote: intervention.resolutionNote,
          },
        });
      }
    }

    const sorted = [...entries].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const total = sorted.length;
    const offsetRaw = Number(args.cursor ?? "0");
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
    const limitRaw = Number(args.limit ?? 200);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1_000, Math.floor(limitRaw))) : 200;
    const paged = sorted.slice(offset, offset + limit);
    const nextCursor = offset + limit < total ? String(offset + limit) : null;
    return {
      entries: paged,
      nextCursor,
      total,
    };
  };

  const exportMissionLogs = async (args: ExportMissionLogsArgs): Promise<ExportMissionLogsResult> => {
    const missionId = String(args.missionId ?? "").trim();
    if (!missionId.length) throw new Error("missionId is required.");
    const runId = pickMissionLogRunId(missionId, args.runId);
    const includeArtifacts = args.includeArtifacts === true;
    const channels = ALL_MISSION_LOG_CHANNELS;

    const allEntries: MissionLogEntry[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await getMissionLogs({
        missionId,
        runId,
        channels,
        cursor,
        limit: 1_000,
      });
      allEntries.push(...page.entries);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    const root = projectRoot ?? process.cwd();
    const runPart = runId ?? "latest";
    const bundlePath = nodePath.join(resolveAdeLayout(root).logBundlesDir, missionId, runPart);
    fs.mkdirSync(bundlePath, { recursive: true });

    const files: ExportMissionLogsResult["manifest"]["files"] = [];
    const writeBundleFile = (name: string, content: string, entriesCount = 0): void => {
      const filePath = nodePath.join(bundlePath, name);
      fs.writeFileSync(filePath, content, "utf8");
      files.push({
        name,
        path: filePath,
        bytes: Buffer.byteLength(content, "utf8"),
        entries: entriesCount,
      });
    };
    const copyBundleFile = (name: string, sourcePath: string): void => {
      if (!sourcePath.trim().length || !fs.existsSync(sourcePath)) return;
      const filePath = nodePath.join(bundlePath, name);
      fs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
      fs.copyFileSync(sourcePath, filePath);
      files.push({
        name,
        path: filePath,
        bytes: fs.statSync(filePath).size,
        entries: 0,
      });
    };

    const grouped = new Map<MissionLogChannel, MissionLogEntry[]>();
    for (const channel of channels) grouped.set(channel, []);
    for (const entry of allEntries) {
      const bucket = grouped.get(entry.channel);
      if (bucket) bucket.push(entry);
    }

    for (const channel of channels) {
      const channelEntries = grouped.get(channel) ?? [];
      writeBundleFile(`${channel}.json`, `${JSON.stringify(channelEntries, null, 2)}\n`, channelEntries.length);
    }

    if (includeArtifacts) {
      const mission = missionService.get(missionId);
      if (mission) {
        writeBundleFile(
          "mission-detail.json",
          `${JSON.stringify(
            {
              id: mission.id,
              title: mission.title,
              status: mission.status,
              prompt: mission.prompt,
              createdAt: mission.createdAt,
              updatedAt: mission.updatedAt,
              artifacts: mission.artifacts,
              interventions: mission.interventions,
            },
            null,
            2,
          )}\n`,
        );
      }
      writeBundleFile(
        "chat-transcript.json",
        `${JSON.stringify(getChat({ missionId }), null, 2)}\n`,
      );
      if (runId) {
        const runGraph = orchestratorService.getRunGraph({ runId, timelineLimit: 5_000 });
        const logsDir = resolveAdeLayout(root).logsDir;
        writeBundleFile("run-graph.json", `${JSON.stringify(runGraph, null, 2)}\n`);
        writeBundleFile(
          "worker-checkpoints.json",
          `${JSON.stringify(orchestratorService.getWorkerCheckpointsForRun({ runId }), null, 2)}\n`,
        );
        copyBundleFile("mission-state.json", getMissionStateDocumentPath(root, runId));
        copyBundleFile("coordinator-checkpoint.json", getCoordinatorCheckpointPath(root, runId));
        copyBundleFile("logs/main.jsonl", nodePath.join(logsDir, "main.jsonl"));
        copyBundleFile("logs/runtime.log", nodePath.join(logsDir, "runtime.log"));
        copyBundleFile("logs/coordinator.claude.log", nodePath.join(logsDir, `coordinator-${runId}.claude.log`));
        for (const attempt of runGraph.attempts) {
          const metadata = isRecord(attempt.metadata) ? attempt.metadata : null;
          const transcriptPath = typeof metadata?.transcriptPath === "string" ? metadata.transcriptPath.trim() : "";
          if (!transcriptPath.length) continue;
          const fileName = nodePath.basename(transcriptPath);
          copyBundleFile(nodePath.join("transcripts", fileName), transcriptPath);
        }
      }
    }

    const exportedAt = nowIso();
    const manifest: ExportMissionLogsResult["manifest"] = {
      schema: "ade.mission-log-bundle.v1",
      missionId,
      runId,
      exportedAt,
      channels,
      entryCount: allEntries.length,
      files,
      includeArtifacts,
    };
    writeBundleFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

    return {
      bundlePath,
      manifest,
    };
  };

  return {
    startMissionRun,
    cancelRunGracefully,
    cleanupTeamResources,
    onQueueLandingStateChanged,

    onOrchestratorRuntimeEvent(event: OrchestratorRuntimeEvent) {
      if (disposed) return;
      if (!event.runId) return;
      const runId = event.runId;
      updateWorkerStateFromEvent(event);

      const isStepCompletionEvent = event.stepId && (event.reason === "attempt_completed" || event.reason === "skipped");
      const isAttemptCompletionShadowEvent =
        event.type === "orchestrator-attempt-updated" &&
        event.reason === "completed" &&
        Boolean(event.stepId) &&
        Boolean(event.attemptId);
      const isAttemptCompletionEvent = (event.reason === "attempt_completed" || event.reason === "completed") && Boolean(event.attemptId);

      // ── Shared graph fetch for coordinator routing + follow-up checks ──
      let cachedEventGraph: OrchestratorRunGraph | null = null;
      const getEventGraph = (): OrchestratorRunGraph => {
        if (!cachedEventGraph) {
          cachedEventGraph = orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
        }
        return cachedEventGraph;
      };

      if (
        event.reason === "validation_contract_unfulfilled" ||
        event.reason === "validation_self_check_reminder" ||
        event.reason === "validation_gate_blocked"
      ) {
        try {
          emitValidationSystemSignal({
            event,
            graph: getEventGraph(),
          });
        } catch (signalError) {
          logger.debug("ai_orchestrator.validation_system_signal_emit_failed", {
            runId,
            reason: event.reason,
            stepId: event.stepId ?? null,
            attemptId: event.attemptId ?? null,
            error: signalError instanceof Error ? signalError.message : String(signalError)
          });
        }
      }

      // VAL-BUDGET-001: When completeAttempt detects token-budget-exceeded and
      // pauses the run, create a budget_limit_reached intervention matching the
      // hard cap path in coordinatorTools (pauseOnBudgetHardCap).
      if (event.type === "orchestrator-run-updated" && event.reason === "budget_exceeded") {
        try {
          const missionId = getMissionIdForRun(runId);
          if (missionId) {
            const graph = getEventGraph();
            const detail = graph.run.lastError ?? "Total token budget exceeded.";
            pauseMissionWithIntervention({
              missionId,
              interventionType: "budget_limit_reached",
              title: "Token budget exceeded",
              body: detail,
              requestedAction: "Raise budget limits, wait for the 5-hour window to reset, or cancel the mission.",
              metadata: { source: "completeAttempt_budget_exceeded", runId },
            });
          }
        } catch (budgetError) {
          logger.debug("ai_orchestrator.budget_exceeded_intervention_failed", {
            runId,
            error: budgetError instanceof Error ? budgetError.message : String(budgetError),
          });
        }
      }

      if (event.type === "orchestrator-attempt-updated" && event.attemptId && event.stepId) {
        try {
          const graph = getEventGraph();
          const step = graph.steps.find((entry) => entry.id === event.stepId) ?? null;
          const attempt = graph.attempts.find((entry) => entry.id === event.attemptId) ?? null;
          const missionId = graph.run.missionId ?? getMissionIdForRun(runId);
          if (missionId) {
            const threadStatus =
              attempt
              && (
                attempt.status === "succeeded"
                || attempt.status === "failed"
                || attempt.status === "blocked"
                || attempt.status === "canceled"
              )
                ? "closed"
                : "active";
            const fallbackStepLabel = step?.stepKey?.trim() || step?.title?.trim() || "starting";
            upsertThread({
              missionId,
              threadId: `worker:${missionId}:${event.attemptId}`,
              threadType: "worker",
              title: `Worker: ${fallbackStepLabel}`,
              target: {
                kind: "worker",
                runId,
                stepId: step?.id ?? event.stepId,
                stepKey: step?.stepKey ?? null,
                attemptId: event.attemptId,
                sessionId: attempt?.executorSessionId ?? null,
                laneId: step?.laneId ?? null,
              },
              status: threadStatus,
            });
          }
        } catch (threadError) {
          logger.debug("ai_orchestrator.worker_thread_upsert_failed", {
            runId,
            stepId: event.stepId,
            attemptId: event.attemptId,
            reason: event.reason,
            error: threadError instanceof Error ? threadError.message : String(threadError),
          });
        }
      }

      // ── Strict coordinator ownership gate ──
      const existingCoordinator = coordinatorAgents.get(runId) ?? null;
      let coordinator = existingCoordinator?.isAlive ? existingCoordinator : null;
      if (!coordinator && existingCoordinator && !existingCoordinator.isAlive) {
        const recovered = attemptCoordinatorRecovery(runId);
        if (recovered?.isAlive) coordinator = recovered;
      }
      const coordinatorWritesSuppressed = coordinatorWriteBarrierRuns.has(runId);
      if (!coordinator) {
        const runStatus = getEventGraph().run.status;
        const terminalCoordinatorRun =
          typeof runStatus === "string" && TERMINAL_COORDINATOR_RUN_STATUSES.has(runStatus as OrchestratorRunStatus);
        const waitingForCoordinatorStartup =
          !existingCoordinator &&
          event.type === "orchestrator-run-updated" &&
          (runStatus === "bootstrapping" || runStatus === "queued");
        if (waitingForCoordinatorStartup) {
          return;
        }
        if (coordinatorWritesSuppressed || terminalCoordinatorRun) {
          if (event.reason === "finalized" || terminalCoordinatorRun) {
            resolveCoordinatorHealthInterventions({
              runId,
              note: `Run reached terminal state (${runStatus}) and stale coordinator availability intervention was closed.`,
              resolutionReason: "run_terminal",
            });
          }
          void syncMissionFromRun(runId, event.reason);
          logger.info("ai_orchestrator.coordinator_unavailable_suppressed_terminal", {
            runId,
            eventType: event.type,
            reason: event.reason,
            runStatus,
            writeBarrier: coordinatorWritesSuppressed,
          });
          return;
        }
        if (event.reason !== "finalized") {
          const missionId = getMissionIdForRun(runId);
          if (missionId) {
            const launchFailure = getRunLaunchFailureMetadata(runId);
            if (launchFailure && hasOpenMissionLaunchFailureIntervention({ missionId, runId })) {
              logger.info("ai_orchestrator.coordinator_unavailable_suppressed", {
                runId,
                missionId,
                eventType: event.type,
                reason: event.reason,
                failureStage: launchFailure.failureStage ?? null,
              });
              return;
            }
            pauseRunWithIntervention({
              runId,
              missionId,
              stepId: event.stepId ?? null,
              source: "transition_decision",
              reasonCode: existingCoordinator ? "coordinator_recovery_failed" : "coordinator_unavailable",
              title: existingCoordinator ? "Coordinator recovery failed" : "Coordinator unavailable",
              body: existingCoordinator
                ? "Coordinator agent terminated and could not be recovered. Mission paused to prevent non-autonomous fallback logic."
                : "Coordinator agent is not available for this run. Mission paused to prevent non-autonomous fallback logic.",
              requestedAction: "Resume after coordinator runtime is healthy, or restart the mission run.",
              metadata: {
                runtimeEventType: event.type,
                runtimeEventReason: event.reason,
                attemptId: event.attemptId ?? null
              }
            });
          }
        } else if (runStatus === "succeeded" || runStatus === "failed" || runStatus === "canceled") {
          resolveCoordinatorHealthInterventions({
            runId,
            note: `Run reached terminal state (${runStatus}) and stale coordinator availability intervention was closed.`,
            resolutionReason: "run_terminal",
          });
        }
        logger.warn("ai_orchestrator.coordinator_unavailable", {
          runId,
          eventType: event.type,
          reason: event.reason,
          recovered: false
        });
        return;
      }

      resolveCoordinatorHealthInterventions({
        runId,
        note: "Coordinator runtime is healthy again; closed stale coordinator availability intervention.",
        resolutionReason: "coordinator_recovered",
      });

      // Run finalized — coordinator's job is done, shut it down
      if (event.reason === "finalized") {
        const terminalRunStatus = getEventGraph().run.status;
        if (terminalRunStatus === "succeeded" || terminalRunStatus === "failed" || terminalRunStatus === "canceled") {
          resolveCoordinatorHealthInterventions({
            runId,
            note: `Run reached terminal state (${terminalRunStatus}) and stale coordinator availability intervention was closed.`,
            resolutionReason: "run_terminal",
          });
        }
        void syncMissionFromRun(runId, event.reason);
        endCoordinatorAgentV2(runId);
        return;
      }

      // ── Hooks: always fire (observability, not decisions) ──
      if (isStepCompletionEvent && event.stepId) {
        dispatchOrchestratorHook({
          event: "TaskCompleted",
          runId,
          stepId: event.stepId,
          attemptId: event.attemptId ?? null,
          sessionId: null,
          reason: event.reason,
          triggerSource: "runtime_event",
          eventAt: event.at,
          metadata: {
            runtimeEventType: event.type
          }
        });
      }

      // ── Token consumption: always propagate (bookkeeping, not decisions) ──
      if (isAttemptCompletionEvent && event.attemptId) {
        propagateAttemptTokenUsage(event.runId, event.attemptId);
      }

      if (isAttemptCompletionEvent) {
        try {
          maybeForwardSubagentCompletionRollup({
            event,
            graph: getEventGraph(),
          });
        } catch (error) {
          logger.debug("ai_orchestrator.subagent_completion_rollup_unhandled", {
            runId: event.runId,
            attemptId: event.attemptId ?? null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // ── Safety check: always run (guardrail, not decision) ──
      if (isAttemptCompletionEvent && event.stepId && event.runId) {
        try {
          const safetyGraph = getEventGraph();
          const step = safetyGraph.steps.find((s) => s.id === event.stepId);
          const meta = step?.metadata as Record<string, unknown> | null;
          const stepType = meta?.stepType as string | undefined;
          if (stepType === "conflict-resolution" || stepType === "pr-review") {
            const attempt = safetyGraph.attempts
              .filter((a) => a.stepId === event.stepId)
              .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
            const summary = attempt?.resultEnvelope?.summary ?? "";
            if (/git\s+push/i.test(summary)) {
              logger.warn("ai_orchestrator.safety_git_push_detected", {
                runId: event.runId,
                stepId: event.stepId,
                stepType,
                stepKey: step?.stepKey,
                message: "A conflict-resolution or pr-review worker may have attempted git push"
              });
            }
          }
        } catch {
          // Non-critical safety check — ignore errors
        }
      }

      if (isStepCompletionEvent && event.stepId) {
        try {
          const stepOutcomeGraph = getEventGraph();
          const stepOutcome = buildMissionStateStepOutcomeFromGraph(stepOutcomeGraph, event.stepId);
          if (stepOutcome) {
            updateMissionStateDoc(runId, {
              addStepOutcome: stepOutcome,
            }, { graph: stepOutcomeGraph });
          }
        } catch (error) {
          logger.debug("ai_orchestrator.mission_state_step_outcome_update_failed", {
            runId,
            stepId: event.stepId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // ── Sync mission status (lightweight persistence, not decisions) ──
      if (!isStepCompletionEvent && !isAttemptCompletionShadowEvent) {
        void syncMissionFromRun(runId, event.reason);
      } else if (isStepCompletionEvent) {
        void syncMissionFromRun(runId, event.reason);
      }

      // ────────────────────────────────────────────────────────────────────
      // COORDINATOR-OWNED: When the coordinator agent is alive, ALL decision
      // logic is handled by it. We just route events — no deterministic
      // transition handlers, quality gates, retry decisions, failure diagnosis,
      // fan-out analysis, or intervention auto-resolution.
      // ────────────────────────────────────────────────────────────────────
      try {
        routeEventToCoordinator(coordinator, event, { graph: getEventGraph() });
      } catch (routeError) {
        logger.debug("ai_orchestrator.coordinator_v2_route_failed", {
          runId,
          reason: event.reason,
          error: routeError instanceof Error ? routeError.message : String(routeError),
        });
      }
      return;
    },

    onSessionRuntimeSignal,
    onAgentChatEvent,

    syncMissionFromRun,

    getWorkerStates,
    evaluateWorkerPlan,
    handleInterventionWithAI,
    steerMission,
    getModelCapabilities: () => getModelCapabilities(),
    getTeamMembers: (tmArgs: { runId: string }) => getTeamMembersForRun(tmArgs.runId),
    getTeamRuntimeState: (trArgs: { runId: string }) => getTeamRuntimeStateForRun(trArgs.runId),
    finalizeRun,
    resumeActiveTeamRuntimes,
    routeUserMessageToCoordinator,
    sendChat,
    getChat,
    listChatThreads,
    getThreadMessages,
    sendThreadMessage,
    sendAgentMessage: sendAgentMessageWithMentions,
    deliverMessageToAgent,
    getGlobalChat,
    getActiveAgents,
    parseMentions,
    getWorkerDigest,
    listWorkerDigests,
    getContextCheckpoint,
    listLaneDecisions,
    listArtifacts,
    listWorkerCheckpoints,
    getPromptInspector,
    getPlanningPromptPreview,
    getMissionMetrics,
    setMissionMetricsConfig,
    getExecutionPlanPreview,
    getMissionStateDocument,
    getRunView,
    getAggregatedUsage,
    getTeamManifest: (tmArgs: { runId: string }): TeamManifest | null => {
      return runTeamManifests.get(tmArgs.runId) ?? null;
    },
    getRecoveryLoopState: (rlArgs: { runId: string }): RecoveryLoopState | null => {
      return runRecoveryLoopStates.get(rlArgs.runId) ?? null;
    },
    runHealthSweep: (reason = "manual") => runHealthSweep(reason),
    getMissionLogs,
    exportMissionLogs,
    dispose: () => {
      disposed = true;
      disposedRef.current = true;
      if (healthSweepTimer) {
        clearInterval(healthSweepTimer);
        healthSweepTimer = null;
        healthSweepTimerRef.current = null;
      }
      // Cancel pending event-driven coordinator evaluations
      for (const [rid, evalTimer] of pendingCoordinatorEvals.entries()) {
        clearTimeout(evalTimer);
        pendingCoordinatorEvals.delete(rid);
      }
      for (const [runId, timers] of runWatchdogTimers.entries()) {
        for (const timer of timers) {
          clearTimeout(timer);
        }
        runWatchdogTimers.delete(runId);
      }
      syncLocks.clear();
      workerStates.clear();
      activeSteeringDirectives.clear();
      runRuntimeProfiles.clear();
      chatMessages.clear();
      activeChatSessions.clear();
      chatTurnQueues.clear();
      activeHealthSweepRuns.clear();
      sessionRuntimeSignals.clear();
      attemptRuntimeTrackers.clear();
      sessionSignalQueues.clear();
      workerDeliveryThreadQueues.clear();
      workerDeliveryInterventionCooldowns.clear();
      runTeamManifests.clear();
      runRecoveryLoopStates.clear();
      teamRuntimeStates.clear();
      validationSystemSignalDedupe.clear();
      workerProgressChatState.clear();
      milestoneReadyNotificationSignatures.clear();
      callTypeConfigCache.clear();
      // Shutdown all coordinator agents
      for (const [rid, agent] of coordinatorAgents.entries()) {
        agent.shutdown();
        coordinatorAgents.delete(rid);
      }
    }
  };
}
