import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import type {
  MissionDetail,
  MissionExecutionPolicy,
  MissionPlannerEngine,
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
  MissionMetricsConfig,
  MissionMetricSample,
  GetMissionMetricsArgs,
  SetMissionMetricsConfigArgs,
  OrchestratorThreadEvent,
  DagMutationEvent,
  AgentChatEventEnvelope,
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
  RunCompletionBlocker,
  GetMissionStateDocumentArgs,
  MissionStateDocument,
  MissionStateDocumentPatch,
  MissionStatePendingIntervention,
  MissionStateProgress,
  MissionStateStepOutcome,
} from "../../../shared/types";
import type { ModelConfig, OrchestratorCallType } from "../../../shared/types";
import {
  DEFAULT_RECOVERY_LOOP_POLICY,
  DEFAULT_INTEGRATION_PR_POLICY,
} from "./orchestratorConstants";
import { modelConfigToServiceModel } from "../../../shared/modelProfiles";
import { getModelById } from "../../../shared/modelRegistry";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createMissionService } from "../missions/missionService";
import type { createOrchestratorService } from "./orchestratorService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createLaneService } from "../lanes/laneService";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createPrService } from "../prs/prService";
import { createMemoryService } from "../memory/memoryService";
import { planMissionOnce, plannerPlanToMissionSteps, MissionPlanningError } from "../missions/missionPlanningService";
import { CoordinatorAgent } from "./coordinatorAgent";
import { routeEventToCoordinator } from "./runtimeEventRouter";
import {
  deleteCoordinatorCheckpoint,
  readCoordinatorCheckpoint,
  readMissionStateDocument,
  updateMissionStateDocument,
} from "./missionStateDoc";
import { getErrorMessage } from "../shared/utils";

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
  PlannerAgentSessionState,
  WorkerDeliveryContext,
  ParallelMissionStepDescriptor,
  ResolvedCallTypeConfig,
  PlannerTurnCompletionStatus,
} from "./orchestratorContext";

// Re-export all types
export type { OrchestratorContext } from "./orchestratorContext";

// Import all constants, helpers, and utility functions from orchestratorContext
import {
  PLAN_REVIEW_INTERVENTION_TITLE,
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
  PLANNER_THREAD_TITLE,
  PLANNER_THREAD_STEP_KEY,
  PLANNER_STREAM_FLUSH_CHARS,
  PLANNER_STREAM_FLUSH_INTERVAL_MS,
  PLANNER_STREAM_MIN_INTERVAL_FLUSH_CHARS,
  MAX_PLANNER_RAW_OUTPUT_CHARS,
  CALL_TYPE_DEFAULTS,
  // Utility functions
  nowIso,
  runBestEffortWithTimeout,
  isRecord,
  asBool,
  digestSignalText,
  buildQuestionThreadLink,
  buildQuestionReplyLink,
  parseQuestionLink,
  detectWaitingInputSignal,
  clipTextForContext,
  workerStateFromRuntimeSignal,
  parseTerminalRuntimeState,
  plannerThreadId,
  toOptionalString,
  readConfig,
  mapOrchestratorStepStatus,
  deriveMissionStatusFromRun,
  buildOutcomeSummary,
  buildConflictResolutionInstructions,
  extractRunFailureMessage,
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
  pruneSessionRuntimeSignals as pruneSessionRuntimeSignalsCtx,
} from "./runtimeEventRouter";

// Import from mission lifecycle module
import {
  inferRoleFromStepMetadata,
  slugify,
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

// Import from planning pipeline module
import {
  buildInterventionResolverPrompt,
  beginPlannerTurn,
} from "./planningPipeline";

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
  missionBudgetService?: import("./missionBudgetService").MissionBudgetService | null;
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
    missionBudgetService,
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
  const plannerSessionByMissionId = new Map<string, PlannerAgentSessionState>();
  const plannerSessionBySessionId = new Map<string, PlannerAgentSessionState>();
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

  // ── V2 Coordinator Agents (tool-based, replaces specialist calls) ──
  const coordinatorAgents = new Map<string, CoordinatorAgent>();
  const coordinatorRecoveryAttempts = new Map<string, number>();

  // Team runtime state tracking
  const teamRuntimeStates = new Map<string, OrchestratorTeamRuntimeState>();

  // Call type config cache
  const callTypeConfigCache = new Map<string, { config: ResolvedCallTypeConfig; expiresAt: number }>();

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
    plannerSessionByMissionId,
    plannerSessionBySessionId,
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
      const modelId = modelConfigToServiceModel(modelConfig);
      const agent = new CoordinatorAgent({
        orchestratorService,
        missionService,
        runId,
        missionId,
        missionGoal,
        modelId,
        logger,
        db,
        projectId: missionId,
        projectRoot,
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
        onCoordinatorMessage: (message) => {
          emitOrchestratorMessage(missionId, `[Coordinator] ${message}`, null, {
            role: "coordinator_v2",
            runId,
          });
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
          }
          finalizeRun({ runId, force: true });
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
        sendWorkerMessageToSession: async ({ sessionId, text }) =>
          sendWorkerMessageToSessionWithStatusCtx(ctx, sessionId, text),
        enableCompaction: true,
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
          `You have been activated. Your mission:\n\n${missionGoal}\n\nYou have full authority. Read the mission, think about the approach, create tasks, spawn workers, and complete the mission. Start now.${laneContext}`,
        );
      }

      logger.info("ai_orchestrator.coordinator_agent_v2_started", {
        missionId,
        runId,
        modelId,
      });

      emitOrchestratorMessage(
        missionId,
        "Orchestrator online. The AI is now in full control of the mission.",
        null,
        {
          role: "coordinator_v2",
          runId,
          modelId,
        },
      );

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
    if (!agent) return;
    agent.shutdown();
    coordinatorAgents.delete(runId);
    coordinatorRecoveryAttempts.delete(runId);
    logger.info("ai_orchestrator.coordinator_agent_v2_ended", {
      runId,
      turns: agent.turns,
      historyLength: agent.historyLength,
    });
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
  ): OrchestratorChatMessage => emitOrchestratorMessageCtx(ctx, missionId, content, stepKey, metadata, { appendChatMessage });

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
    const activeStep = graph.steps.find((step) => !MISSION_STATE_TERMINAL_STEP_STATUSES.has(step.status)) ?? null;
    const activeMeta = isRecord(activeStep?.metadata) ? activeStep.metadata : {};
    const activePhaseName = typeof activeMeta.phaseName === "string" ? activeMeta.phaseName.trim() : "";
    if (activePhaseName.length > 0) return activePhaseName;
    const activePhaseKey = typeof activeMeta.phaseKey === "string" ? activeMeta.phaseKey.trim() : "";
    if (activePhaseKey.length > 0) return activePhaseKey;
    return "unknown";
  };

  const buildMissionStateProgressFromGraph = (graph: OrchestratorRunGraph): MissionStateProgress => ({
    currentPhase: currentPhaseFromGraph(graph),
    completedSteps: graph.steps.filter((step) => MISSION_STATE_TERMINAL_STEP_STATUSES.has(step.status)).length,
    totalSteps: graph.steps.length,
    activeWorkers: graph.steps.filter((step) => step.status === "running").map((step) => step.stepKey),
    blockedSteps: graph.steps.filter((step) => step.status === "blocked").map((step) => step.stepKey),
    failedSteps: graph.steps.filter((step) => step.status === "failed").map((step) => step.stepKey),
  });

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
    void updateMissionStateDocument({
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

  const upsertPlannerThread = (args: {
    missionId: string;
    laneId: string;
    sessionId: string;
    provider: "claude" | "codex";
    model: string;
    reasoningEffort: string | null;
    runId?: string | null;
    stepId?: string | null;
  }): OrchestratorChatThread => {
    return upsertThread({
      missionId: args.missionId,
      threadId: plannerThreadId(args.missionId),
      threadType: "worker",
      title: PLANNER_THREAD_TITLE,
      target: {
        kind: "worker",
        runId: args.runId ?? null,
        stepId: args.stepId ?? null,
        stepKey: PLANNER_THREAD_STEP_KEY,
        attemptId: null,
        sessionId: args.sessionId,
        laneId: args.laneId
      },
      metadata: {
        role: "planner",
        provider: args.provider,
        model: args.model,
        reasoningEffort: args.reasoningEffort,
        plannerThread: true
      }
    });
  };

  const appendPlannerWorkerMessage = (
    state: PlannerAgentSessionState,
    content: string,
    metadata?: Record<string, unknown> | null
  ): OrchestratorChatMessage | null => {
    const normalizedContent = content.trim();
    if (!normalizedContent.length) return null;
    return appendChatMessage({
      id: randomUUID(),
      missionId: state.missionId,
      role: "worker",
      content: normalizedContent,
      timestamp: nowIso(),
      threadId: state.threadId,
      target: {
        kind: "worker",
        runId: state.runId ?? null,
        stepId: state.stepId ?? null,
        stepKey: PLANNER_THREAD_STEP_KEY,
        attemptId: null,
        sessionId: state.sessionId,
        laneId: state.laneId
      },
      visibility: "full",
      deliveryState: "delivered",
      sourceSessionId: state.sessionId,
      attemptId: null,
      laneId: state.laneId,
      runId: state.runId ?? null,
      stepKey: PLANNER_THREAD_STEP_KEY,
      metadata: metadata ?? null
    });
  };

  const flushPlannerStreamBuffer = (state: PlannerAgentSessionState, force = false): void => {
    if (!state.streamBuffer.length) return;
    if (!force) {
      const hasParagraphBreak = /\n{2,}/.test(state.streamBuffer);
      const trailingWindow = state.streamBuffer.slice(-200);
      const hasSentenceBoundary = /[.!?](?:\s|\n|$)/.test(trailingWindow);
      const exceededChunkThreshold = state.streamBuffer.length >= PLANNER_STREAM_FLUSH_CHARS;
      const exceededInterval =
        Date.now() - state.lastStreamFlushAtMs >= PLANNER_STREAM_FLUSH_INTERVAL_MS
        && state.streamBuffer.length >= PLANNER_STREAM_MIN_INTERVAL_FLUSH_CHARS;
      if (!hasParagraphBreak && !hasSentenceBoundary && !exceededChunkThreshold && !exceededInterval) {
        return;
      }
    }

    // Don't emit tiny fragments - accumulate more content first
    if (!force && state.streamBuffer.trim().length < 10) {
      return;
    }

    let chunk = state.streamBuffer;
    if (!force) {
      let boundary = Math.min(state.streamBuffer.length, PLANNER_STREAM_FLUSH_CHARS);
      const paragraphBoundary = state.streamBuffer.lastIndexOf("\n\n", boundary);
      if (paragraphBoundary >= 120) {
        boundary = paragraphBoundary + 2;
      } else {
        const lastNewline = state.streamBuffer.lastIndexOf("\n", boundary);
        if (lastNewline >= 120) {
          boundary = lastNewline + 1;
        } else {
          const sentenceSlice = state.streamBuffer.slice(0, boundary);
          const sentencePattern = /[.!?](?:\s|\n|$)/g;
          let sentenceBoundary = -1;
          let sentenceMatch: RegExpExecArray | null = null;
          while ((sentenceMatch = sentencePattern.exec(sentenceSlice)) !== null) {
            sentenceBoundary = sentenceMatch.index + sentenceMatch[0].length;
          }
          if (sentenceBoundary >= 160) {
            boundary = sentenceBoundary;
          }
        }
      }
      chunk = state.streamBuffer.slice(0, boundary);
      state.streamBuffer = state.streamBuffer.slice(boundary);
    } else {
      state.streamBuffer = "";
    }

    state.lastStreamFlushAtMs = Date.now();
    appendPlannerWorkerMessage(state, chunk, {
      planner: {
        stream: true,
        sessionId: state.sessionId
      }
    });
  };

  const appendPlannerTextDelta = (state: PlannerAgentSessionState, rawDelta: string): void => {
    // Strip thinking markers if present
    let delta = String(rawDelta ?? "");
    if (delta.includes("<thinking>") || delta.includes("</thinking>")) {
      delta = delta.replace(/<\/?thinking>/g, "");
    }
    if (!delta.trim().length) return;
    if (state.rawOutput.length < MAX_PLANNER_RAW_OUTPUT_CHARS) {
      const remaining = MAX_PLANNER_RAW_OUTPUT_CHARS - state.rawOutput.length;
      const accepted = delta.slice(0, remaining);
      state.rawOutput += accepted;
      if (accepted.length < delta.length) {
        state.rawOutputTruncated = true;
      }
    } else {
      state.rawOutputTruncated = true;
    }
    state.streamBuffer += delta;
    flushPlannerStreamBuffer(state, false);
  };

  const completePlannerTurn = (
    state: PlannerAgentSessionState,
    status: PlannerTurnCompletionStatus,
    error: string | null
  ): void => {
    flushPlannerStreamBuffer(state, true);
    if (state.rawOutputTruncated) {
      appendPlannerWorkerMessage(
        state,
        "Planner output exceeded capture limit; response was truncated in-thread.",
        {
          planner: {
            truncated: true,
            sessionId: state.sessionId
          }
        }
      );
    }
    const turn = state.turn;
    if (!turn || turn.settled) return;
    turn.resolve({
      status,
      rawOutput: state.rawOutput,
      error
    });
    state.turn = null;
  };

  const registerPlannerSession = (state: PlannerAgentSessionState): void => {
    const existingByMission = plannerSessionByMissionId.get(state.missionId);
    if (existingByMission && existingByMission.sessionId !== state.sessionId) {
      completePlannerTurn(
        existingByMission,
        "interrupted",
        "Planner session was replaced by a newer planning run."
      );
      plannerSessionBySessionId.delete(existingByMission.sessionId);
    }
    plannerSessionByMissionId.set(state.missionId, state);
    plannerSessionBySessionId.set(state.sessionId, state);
  };

  /**
   * Resolve the primary lane ID. Returns null if lane service is unavailable.
   */
  const resolvePrimaryLaneId = async (): Promise<string | null> => {
    if (!laneService || typeof laneService.list !== "function") return null;
    const lanes = await laneService.list({ includeArchived: false });
    const primary = lanes.find((lane) => lane.laneType === "primary") ?? lanes[0] ?? null;
    return primary?.id?.trim() || null;
  };

  const resolvePlannerLaneId = async (mission: MissionDetail): Promise<string> => {
    const missionLaneId = toOptionalString(mission.laneId);
    if (missionLaneId) return missionLaneId;
    const laneId = await resolvePrimaryLaneId();
    if (!laneId) throw new Error("Mission planning lane could not be resolved.");
    return laneId;
  };

  /**
   * Create a lane branching from the primary lane.
   * Used for both initial mission lane creation and dynamic provisioning.
   * Returns { laneId, name } or null if unavailable.
   */
  const createLaneFromBase = async (
    name: string,
    opts: { description?: string; folder?: string; missionId: string },
  ): Promise<{ laneId: string; name: string } | null> => {
    if (!laneService) return null;
    const baseLaneId = await resolvePrimaryLaneId();
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
      const result = await createLaneFromBase(
        `m-${missionId.slice(0, 6)}-${slugify(missionTitle)}`,
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
        limit: 5_000
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
          limit: 5_000
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
      upsertWorkerState(attempt.attemptId, {
        runId: attempt.runId,
        stepId: attempt.stepId,
        sessionId,
        executorKind: attempt.executorKind,
        state: runtimeWorkerState
      });
      if (attempt.executorKind !== "manual") {
        maybeDispatchTeammateIdleHook({
          runId: attempt.runId,
          stepId: attempt.stepId,
          attemptId: attempt.attemptId,
          sessionId,
          previousState: previousWorkerState,
          nextState: runtimeWorkerState,
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

  const startReadyAutopilotAttemptsWithMilestoneReadiness = async (args: {
    runId: string;
    reason: string;
  }): Promise<number> => {
    const run = orchestratorService.listRuns({ limit: 1_000 }).find((entry) => entry.id === args.runId) ?? null;
    if (!run) return 0;
    if (run.status !== "active" && run.status !== "bootstrapping" && run.status !== "queued") return 0;
    const coordinator = coordinatorAgents.get(args.runId);
    if (!coordinator?.isAlive) return 0;
    emitMilestoneReadinessToCoordinator({ runId: args.runId, reason: args.reason });
    return orchestratorService.startReadyAutopilotAttempts({ runId: args.runId, reason: args.reason });
  };

  const runHealthSweep = async (reason: string): Promise<{ sweeps: number; staleRecovered: number }> => {
    if (disposed) return { sweeps: 0, staleRecovered: 0 };
    pruneSessionRuntimeSignals();
    const runs = orchestratorService
      .listRuns({ limit: HEALTH_SWEEP_ACTIVE_RUN_SCAN_LIMIT })
      .filter((run) => run.status === "active" || run.status === "bootstrapping" || run.status === "queued");
    let sweeps = 0;
    let staleRecovered = 0;

    for (const run of runs) {
      if (disposed) break;
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
          const stagnationSnapshot = updateAttemptStagnationTracker(attempt.id, effectivePreview);

          const previousWorkerState = workerStates.get(attempt.id)?.state ?? null;
          upsertWorkerState(attempt.id, {
            runId: run.id,
            stepId: step.id,
            sessionId: attempt.executorSessionId,
            executorKind: attempt.executorKind,
            state: nextWorkerState
          });
          maybeDispatchTeammateIdleHook({
            runId: run.id,
            stepId: step.id,
            attemptId: attempt.id,
            sessionId: attempt.executorSessionId ?? null,
            previousState: previousWorkerState,
            nextState: nextWorkerState,
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
            orchestratorService.completeAttempt({
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
    if (config.defaultPlannerProvider === "claude" || config.defaultPlannerProvider === "codex") {
      return config.defaultPlannerProvider as "claude" | "codex";
    }
    if (config.defaultPlannerProvider) {
      const desc = getModelById(config.defaultPlannerProvider);
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

  const inferPlannerProviderFromHint = (hint: string | null | undefined): "claude" | "codex" | null => {
    const raw = String(hint ?? "").trim();
    if (!raw.length) return null;
    if (raw === "claude" || raw === "codex") return raw;
    const desc = getModelById(raw);
    if (desc?.family === "anthropic") return "claude";
    if (desc?.family === "openai") return "codex";
    const lower = raw.toLowerCase();
    if (lower.includes("claude") || lower.includes("anthropic")) return "claude";
    if (lower.includes("codex") || lower.includes("gpt")) return "codex";
    return null;
  };

  const persistDiscoveredDocPathsToMemory = (args: { missionId: string; docPaths: string[]; sourceRunId?: string | null }): void => {
    const missionProjectId = resolveMissionProjectId(args.missionId);
    if (!missionProjectId.length || args.docPaths.length === 0) return;
    const compactPaths = [...new Set(args.docPaths.map((entry) => String(entry ?? "").trim()).filter(Boolean))].slice(0, 40);
    if (compactPaths.length === 0) return;
    const content = `Project documentation paths: ${compactPaths.join(", ")}`;
    try {
      plannerMemoryService.addMemory({
        projectId: missionProjectId,
        scope: "project",
        category: "fact",
        content,
        importance: "medium",
        sourceRunId: args.sourceRunId ?? undefined
      });
    } catch (error) {
      logger.debug("ai_orchestrator.doc_inventory_memory_write_failed", {
        missionId: args.missionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

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

  const resolvePlannerProviderForMission = (args: {
    missionId: string;
    plannerProviderHint?: string | null;
    runtimeProfile?: MissionRuntimeProfile | null;
  }): "claude" | "codex" | null => {
    const explicit = inferPlannerProviderFromHint(args.plannerProviderHint);
    if (explicit) return explicit;
    const runtimeHint = inferPlannerProviderFromHint(args.runtimeProfile?.planning.preferProvider ?? null);
    if (runtimeHint) return runtimeHint;
    return resolveChatProvider(args.missionId);
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
    const { runId, force } = finalizeArgs;
    const graph = orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
    const missionId = graph.run.missionId;

    // The act of calling finalizeRun IS the completion request
    updateTeamRuntimePhase(runId, "executing", { completionRequested: true });

    const blockers: RunCompletionBlocker[] = [];

    // Hard gate: can't complete while workers are still executing
    const runningAttempts = graph.attempts.filter((a) => a.status === "running");
    if (runningAttempts.length > 0) {
      blockers.push({ code: "running_attempts", message: `${runningAttempts.length} attempts still running` });
    }

    // Soft gate: tasks not done — only block if NOT force (coordinator already skipped remaining steps)
    if (!force) {
      const notDoneSteps = graph.steps.filter(
        (s) =>
          s.status !== "succeeded" &&
          s.status !== "skipped" &&
          s.status !== "superseded" &&
          s.status !== "canceled" &&
          s.status !== "failed"
      );
      if (notDoneSteps.length > 0) {
        blockers.push({ code: "claimed_tasks", message: `${notDoneSteps.length} tasks not yet complete` });
      }
    }

    // completion_not_requested gate removed — calling finalizeRun IS the request

    if (blockers.length > 0 && !force) {
      updateTeamRuntimePhase(runId, "executing", {
        completionRequested: true,
        completionValidated: false,
        lastValidationError: blockers.map((b) => b.message).join("; "),
      });
      return { finalized: false, blockers: blockers.map((b) => b.message), finalStatus: "active" };
    }

    // When force is true, only running_attempts is a hard gate
    if (force && runningAttempts.length > 0) {
      return { finalized: false, blockers: blockers.map((b) => b.message), finalStatus: "active" };
    }

    // Determine final status
    const failedSteps = graph.steps.filter((s) => s.status === "failed");
    const allSucceededOrSkipped = graph.steps.every(
      (s) => s.status === "succeeded" || s.status === "skipped" || s.status === "superseded" || s.status === "canceled"
    );
    let finalStatus: OrchestratorRunStatus;
    if (allSucceededOrSkipped) {
      finalStatus = "succeeded";
    } else if (failedSteps.length > 0 && failedSteps.length < graph.steps.length) {
      finalStatus = "succeeded_with_risk";
    } else {
      finalStatus = "failed";
    }

    // Transition run
    const ts = nowIso();
    db.run(
      `update orchestrator_runs set status = ?, completed_at = ?, updated_at = ? where id = ?`,
      [finalStatus, ts, ts, runId]
    );
    updateTeamRuntimePhase(runId, "done", {
      completionRequested: true,
      completionValidated: true,
    });

    // End coordinator
    endCoordinatorAgentV2(runId);
    cleanupCoordinatorCheckpointFile(runId, "finalize_run");

    const buildRecoveryHandoffPayload = () => {
      const doneSteps = graph.steps
        .filter((step) => step.status === "succeeded" || step.status === "skipped" || step.status === "superseded" || step.status === "canceled")
        .map((step) => ({
          stepId: step.id,
          stepKey: step.stepKey,
          title: step.title,
          status: step.status,
          laneId: step.laneId
        }));
      const remainingSteps = graph.steps
        .filter((step) => step.status !== "succeeded" && step.status !== "skipped" && step.status !== "superseded" && step.status !== "canceled")
        .map((step) => ({
          stepId: step.id,
          stepKey: step.stepKey,
          title: step.title,
          status: step.status,
          laneId: step.laneId
        }));
      const laneMap = graph.steps.reduce<Record<string, string[]>>((acc, step) => {
        const laneKey = step.laneId ?? "unassigned";
        const list = acc[laneKey] ?? [];
        list.push(step.stepKey);
        acc[laneKey] = list;
        return acc;
      }, {});
      const validations = graph.runtimeEvents
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

    const persistRecoveryHandoff = (handoffType: "partial_completion_handoff" | "recovery_handoff") => {
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
    if (finalStatus === "succeeded") {
      transitionMissionStatus(missionId, "completed");
    } else if (finalStatus === "succeeded_with_risk") {
      const payload = persistRecoveryHandoff("partial_completion_handoff");
      transitionMissionStatus(missionId, "partially_completed", {
        outcomeSummary: `Done ${payload.doneSteps.length}, remaining ${payload.remainingSteps.length}.`
      });
    } else {
      persistRecoveryHandoff("recovery_handoff");
      transitionMissionStatus(missionId, "failed");
    }

    logger.info("ai_orchestrator.run_finalized", { runId, missionId, finalStatus, blockerCount: blockers.length });
    return { finalized: true, blockers: [], finalStatus };
  };

  /**
   * Resume active team runtimes after app restart.
   * Checks for runs in "active" or "bootstrapping" status with coordinator sessions.
   */
  const resumeActiveTeamRuntimes = (): void => {
    void (async () => {
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
  const routeUserMessageToCoordinator = (_missionId: string, runId: string, content: string): boolean => {
    const coordAgent = coordinatorAgents.get(runId);
    if (!coordAgent?.isAlive) return false;
    coordAgent.injectMessage(`[USER MESSAGE] ${content}`);
    return true;
  };


  const respondToChatWithAI = async (
    chatArgs: SendOrchestratorChatArgs,
    _precomputedRecentChatContext?: string
  ): Promise<void> => {
    const mission = missionService.get(chatArgs.missionId);
    if (!mission) return;

    const latestUserMessage = clipTextForContext(chatArgs.content, MAX_LATEST_CHAT_MESSAGE_CHARS);

    // Route user messages directly to the coordinator agent (tool-based)
    const runs = orchestratorService.listRuns({ missionId: chatArgs.missionId });
    const activeRun = runs.find((r) => r.status === "active" || r.status === "bootstrapping" || r.status === "queued" || r.status === "paused");
    if (activeRun) {
      const routed = routeUserMessageToCoordinator(chatArgs.missionId, activeRun.id, latestUserMessage);
      if (routed) return;
    }

    // Fallback: no active coordinator agent — use a simple one-shot AI call
    if (!aiIntegrationService || !projectRoot) return;
    const provider = resolveChatProvider(chatArgs.missionId);
    if (!provider) return;

    const runSummary = summarizeRunForChat(chatArgs.missionId);
    const prompt = [
      "You are the ADE mission coordinator. Respond to the user's message concisely.",
      "Be direct, specific, and actionable. Reference step names and metrics.",
      "",
      `Mission: ${mission.title}`,
      `Run summary: ${runSummary}`,
      `User message: ${latestUserMessage}`,
    ].join("\n");

    const configChat = resolveOrchestratorModelConfig(chatArgs.missionId, "chat_response");
    const chatCallConfig = resolveCallTypeConfig(chatArgs.missionId, "chat_response");
    try {
      const result = await aiIntegrationService.executeTask({
        feature: "orchestrator" as const,
        taskType: "review" as const,
        prompt,
        cwd: projectRoot,
        provider: chatCallConfig.provider,
        model: modelConfigToServiceModel(configChat),
        reasoningEffort: chatCallConfig.reasoningEffort,
        permissionMode: "read-only" as const,
        oneShot: true,
        timeoutMs: 30_000
      });
      const response = String(result.text ?? "").trim();
      if (response.length > 0) {
        emitOrchestratorMessage(chatArgs.missionId, response);
      }
    } catch (error) {
      logger.debug("ai_orchestrator.chat_fallback_failed", {
        missionId: chatArgs.missionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
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
          graph.run.status !== "queued" &&
          graph.run.status !== "paused"
        ) {
          return;
        }

        const missionId = graph.run.missionId;

        const existingCoordinator = coordinatorAgents.get(runId) ?? null;
        let coordinator = existingCoordinator?.isAlive ? existingCoordinator : null;
        if (!coordinator && existingCoordinator && !existingCoordinator.isAlive) {
          const recovered = attemptCoordinatorRecovery(runId);
          if (recovered?.isAlive) coordinator = recovered;
        }
        if (!coordinator) {
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

          const runningSteps = graph.steps.filter((s) => s.status === "running");
          const readySteps = graph.steps.filter((s) => s.status === "ready");
          const completedSteps = graph.steps.filter((s) =>
            s.status === "succeeded" || s.status === "failed" || s.status === "skipped" || s.status === "canceled"
          );
          const blockedSteps = graph.steps.filter((s) => s.status === "blocked");
          const pendingSteps = graph.steps.filter((s) => s.status === "pending");

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
            `Progress: ${completedSteps.length}/${graph.steps.length} done, ${runningSteps.length} running, ${readySteps.length} ready, ${blockedSteps.length} blocked, ${pendingSteps.length} pending`,
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


  const canUsePlannerAgentSessions = (): boolean => {
    return Boolean(
      agentChatService
      && laneService
      && typeof agentChatService.createSession === "function"
      && typeof agentChatService.sendMessage === "function"
    );
  };

  const createPlannerAgentIntegration = (args: {
    mission: MissionDetail;
    provider: "claude" | "codex";
    model?: string;
    policy?: MissionExecutionPolicy;
  }): ReturnType<typeof createAiIntegrationService> => {
    if (!agentChatService) {
      throw new Error("Planner agent chat service is unavailable.");
    }
    const providerAvailability = {
      claude: args.provider === "claude",
      codex: args.provider === "codex"
    };
    const planningReasoningEffort =
      typeof args.policy?.planning.reasoningEffort === "string" && args.policy.planning.reasoningEffort.trim().length
        ? args.policy.planning.reasoningEffort.trim()
        : null;
    const fallbackModel = args.provider === "claude" ? "sonnet" : "gpt-5.3-codex";

    return {
      getMode: () => "subscription",
      getAvailability: () => providerAvailability,
      planMission: async (planArgs: {
        cwd: string;
        prompt: string;
        timeoutMs?: number;
        model?: string;
        provider?: "claude" | "codex";
        jsonSchema?: unknown;
      }) => {
        const startedAtMs = Date.now();
        const laneId = await resolvePlannerLaneId(args.mission);
        const model = String(planArgs.model ?? args.model ?? fallbackModel).trim() || fallbackModel;
        const session = await agentChatService.createSession({
          laneId,
          provider: args.provider,
          model,
          permissionMode: "plan",
          ...(planningReasoningEffort ? { reasoningEffort: planningReasoningEffort } : {})
        });
        const thread = upsertPlannerThread({
          missionId: args.mission.id,
          laneId,
          sessionId: session.id,
          provider: args.provider,
          model: session.model,
          reasoningEffort: session.reasoningEffort ?? planningReasoningEffort
        });
        const plannerState: PlannerAgentSessionState = {
          missionId: args.mission.id,
          runId: null,
          stepId: null,
          threadId: thread.id,
          sessionId: session.id,
          laneId,
          provider: args.provider,
          model: session.model,
          reasoningEffort: session.reasoningEffort ?? planningReasoningEffort,
          rawOutput: "",
          rawOutputTruncated: false,
          streamBuffer: "",
          lastStreamFlushAtMs: 0,
          turn: null,
          activeTurnId: null,
          createdAt: nowIso(),
          lastEventAt: nowIso()
        };
        registerPlannerSession(plannerState);
        updateMissionMetadata(args.mission.id, (metadata) => {
          metadata.plannerAgent = {
            sessionId: session.id,
            threadId: thread.id,
            laneId,
            provider: args.provider,
            model: session.model,
            reasoningEffort: session.reasoningEffort ?? planningReasoningEffort,
            updatedAt: nowIso()
          };
        });
        appendPlannerWorkerMessage(
          plannerState,
          "Planner online. Prompt received — drafting the mission plan now.",
          {
            planner: {
              event: "session_started",
              sessionId: session.id,
              provider: args.provider,
              model: session.model
            }
          }
        );

        const turn = beginPlannerTurn(plannerState);
        appendPlannerWorkerMessage(
          plannerState,
          "Planning in progress. I will post the execution breakdown as soon as it is ready.",
          {
            planner: {
              event: "turn_enqueued",
              sessionId: session.id
            }
          }
        );

        try {
          await agentChatService.sendMessage({
            sessionId: session.id,
            text: planArgs.prompt,
            ...(planningReasoningEffort ? { reasoningEffort: planningReasoningEffort } : {})
          });
          const completion = await turn.promise;
          const text = completion.rawOutput.trim();
          // If the planner produced output, use it even if the turn status is
          // "failed" due to an incidental tool error (e.g. a late Read failure).
          // The plan is the valuable artifact — a stray error doesn't invalidate it.
          if (!text.length) {
            if (completion.status !== "completed") {
              throw new Error(completion.error ?? `Planner turn finished with status '${completion.status}'.`);
            }
            throw new Error("Planner turn completed without returning text.");
          }
          if (completion.status !== "completed") {
            logger.warn("ai_orchestrator.planner_turn_non_success_with_output", {
              missionId: args.mission.id,
              sessionId: session.id,
              status: completion.status,
              error: completion.error,
              outputLength: text.length
            });
          }
          appendPlannerWorkerMessage(
            plannerState,
            "Planner produced a candidate plan. Validating and applying steps...",
            {
              planner: {
                event: "response_ready",
                sessionId: session.id
              }
            }
          );
          return {
            text,
            structuredOutput: null,
            provider: args.provider,
            model: session.model,
            sessionId: session.id,
            durationMs: Date.now() - startedAtMs,
            inputTokens: null,
            outputTokens: null
          } as any;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          completePlannerTurn(plannerState, "failed", message);
          appendPlannerWorkerMessage(
            plannerState,
            `Planner turn failed: ${message}`,
            {
              planner: {
                event: "turn_failed",
                sessionId: session.id
              }
            }
          );
          throw error;
        }
      }
    } as ReturnType<typeof createAiIntegrationService>;
  };

  /**
   * Plan a mission using AI.
   *
   * Delegation model: planning runs through an explicit planner agent session
   * whenever chat/lane services are available. This keeps planning behavior
   * aligned with other spawned worker agents and exposes a dedicated planner
   * thread in the UI.
   *
   * AI planning is policy-driven — callers decide whether to invoke this
   * based on the active mission execution policy/runtime profile.
   */
  const planWithAI = async (args: {
    missionId: string;
    provider: "claude" | "codex";
    model?: string;
    policy?: MissionExecutionPolicy;
  }): Promise<void> => {
    const mission = missionService.get(args.missionId);
    if (!mission) {
      logger.warn("ai_orchestrator.plan_with_ai_mission_not_found", { missionId: args.missionId });
      return;
    }

    const plannerSessionSupported = canUsePlannerAgentSessions();
    if (!projectRoot || (!aiIntegrationService && !plannerSessionSupported)) {
      logger.warn("ai_orchestrator.plan_with_ai_not_available", {
        missionId: args.missionId,
        hasAiService: !!aiIntegrationService,
        hasPlannerSessionSupport: plannerSessionSupported,
        hasProjectRoot: !!projectRoot
      });
      throw new MissionPlanningError({
        reasonCode: "planner_unavailable",
        reasonDetail: "Planner execution service is not available.",
        engine: null
      });
    }

    try {
      const plannerEngine: MissionPlannerEngine = args.provider === "codex" ? "codex_cli" : "claude_cli";
      const planningIntegration = plannerSessionSupported
        ? createPlannerAgentIntegration({
            mission,
            provider: args.provider,
            model: args.model,
            policy: args.policy
          })
        : aiIntegrationService ?? undefined;

      const teamRuntimeCfgRaw = resolveMissionTeamRuntime(args.missionId);
      const teamRuntimeCfg = teamRuntimeCfgRaw ? normalizeTeamRuntimeConfig(args.missionId, teamRuntimeCfgRaw) : null;
      const phaseConfig = missionService.getPhaseConfiguration(args.missionId);
      const missionMetadata = getMissionMetadata(args.missionId);
      const launchMetadata = isRecord(missionMetadata.launch) ? missionMetadata.launch : null;
      const agentRuntime = isRecord(launchMetadata?.agentRuntime) ? launchMetadata.agentRuntime : null;
      const missionProjectId = resolveMissionProjectId(args.missionId);
      const projectDocsContext = discoverProjectDocs();
      if (projectDocsContext.paths.length > 0) {
        persistDiscoveredDocPathsToMemory({
          missionId: args.missionId,
          docPaths: projectDocsContext.paths
        });
      }
      const docsDigest = projectDocsContext.docs.slice(0, 40).map((entry) => ({
        path: entry.path,
        sha256: entry.sha256,
        bytes: entry.bytes
      }));
      const plannerConstraints = (() => {
        const constraints: string[] = [];
        if (agentRuntime?.allowParallelAgents === false) {
          constraints.push("Parallel agents are disabled by mission settings. Use sequential strategy and set missionSummary.parallelismCap=1.");
        }
        if (agentRuntime?.allowSubAgents === false) {
          constraints.push("Nested sub-agent delegation is disabled by mission settings. Keep steps self-contained for single-agent execution.");
        }
        if (agentRuntime?.allowClaudeAgentTeams === false) {
          constraints.push("Claude native agent teams are disabled by mission settings.");
        }
        return constraints;
      })();
      const planning = await planMissionOnce({
        missionId: args.missionId,
        title: mission.title,
        prompt: mission.prompt,
        laneId: mission.laneId,
        plannerEngine,
        model: args.model,
        projectRoot,
        allowPlanningQuestions: (() => {
          return launchMetadata?.allowPlanningQuestions === true;
        })(),
        phaseCards: phaseConfig?.selectedPhases,
        contextBundle: docsDigest.length > 0 || plannerConstraints.length > 0
          ? {
              ...(docsDigest.length > 0 ? { docsDigest } : {}),
              ...(plannerConstraints.length > 0 ? { constraints: plannerConstraints } : {})
            }
          : undefined,
        aiIntegrationService: planningIntegration,
        memoryService: missionProjectId.length > 0 ? plannerMemoryService : undefined,
        memoryProjectId: missionProjectId.length > 0 ? missionProjectId : undefined,
        logger,
        policy: args.policy,
        teamRuntime: teamRuntimeCfg ?? undefined
      });

      const plannedSteps = plannerPlanToMissionSteps({
        plan: planning.plan,
        requestedEngine: planning.run.requestedEngine,
        resolvedEngine: planning.run.resolvedEngine!,
        executorPolicy: "both",
        degraded: planning.run.degraded,
        reasonCode: planning.run.reasonCode,
        validationErrors: planning.run.validationErrors,
        policy: args.policy
      });
      if (!missionProjectId.length) return;

      // Replace existing mission steps with AI-planned steps
      db.run(`delete from mission_steps where mission_id = ?`, [args.missionId]);
      const now = nowIso();
      for (const step of plannedSteps) {
        db.run(
          `insert into mission_steps(
            id, mission_id, project_id, step_index, title, detail, kind,
            lane_id, status, metadata_json, created_at, updated_at, started_at, completed_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, null, null)`,
          [
            randomUUID(),
            args.missionId,
            missionProjectId,
            step.index,
            step.title,
            step.detail,
            step.kind,
            mission.laneId,
            JSON.stringify(step.metadata),
            now,
            now
          ]
        );
      }

      // Store planner plan + run metadata on the mission
      const existingMetadata = (() => {
        const row = db.get<{ metadata_json: string | null }>(
          `select metadata_json from missions where id = ? limit 1`,
          [args.missionId]
        );
        if (!row?.metadata_json) return {};
        try { return JSON.parse(row.metadata_json) as Record<string, unknown>; } catch { return {}; }
      })();

      const updatedMetadata = {
        ...existingMetadata,
        plannerPlan: {
          schemaVersion: planning.plan.schemaVersion,
          clarifyingQuestions: planning.plan.clarifyingQuestions ?? [],
          clarifyingAnswers: planning.plan.clarifyingAnswers ?? [],
          missionSummary: planning.plan.missionSummary,
          assumptions: planning.plan.assumptions,
          risks: planning.plan.risks,
          stepCount: planning.plan.steps.length,
          handoffPolicy: planning.plan.handoffPolicy
        },
        planner: {
          id: planning.run.id,
          requestedEngine: planning.run.requestedEngine,
          resolvedEngine: planning.run.resolvedEngine,
          status: planning.run.status,
          degraded: planning.run.degraded,
          reasonCode: planning.run.reasonCode,
          reasonDetail: planning.run.reasonDetail,
          planHash: planning.run.planHash,
          normalizedPlanHash: planning.run.normalizedPlanHash,
          durationMs: planning.run.durationMs,
          validationErrors: planning.run.validationErrors
        }
      };

      db.run(
        `update missions set metadata_json = ?, updated_at = ? where id = ?`,
        [JSON.stringify(updatedMetadata), now, args.missionId]
      );

      emitOrchestratorMessage(
        args.missionId,
        (() => {
          const titles = plannedSteps.map((step) => step.title);
          const preview =
            titles.length <= 6
              ? titles.join(", ")
              : `${titles.slice(0, 6).join(", ")} (+${titles.length - 6} more)`;
          return `Planning complete. Created ${plannedSteps.length} steps: ${preview}.`;
        })()
      );

      logger.info("ai_orchestrator.plan_with_ai_completed", {
        missionId: args.missionId,
        provider: args.provider,
        plannerSessionSupported,
        resolvedEngine: planning.run.resolvedEngine,
        stepCount: plannedSteps.length
      });
    } catch (error) {
      logger.warn("ai_orchestrator.plan_with_ai_failed", {
        missionId: args.missionId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
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
        const existing = Array.isArray(meta.handoffSummaries) ? [...meta.handoffSummaries as unknown[]] : [];
        existing.push(handoffText);
        // Cap at 10 handoff entries to prevent prompt bloat
        meta.handoffSummaries = existing.slice(-10);
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

  const pauseRunWithIntervention = (args: {
    runId: string;
    missionId: string;
    stepId?: string | null;
    stepKey?: string | null;
    source: "transition_decision";
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
        if (entry.status !== "open" || entry.interventionType !== "failed_step") continue;
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
          interventionType: "failed_step",
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
          interventionId,
          interventionType: "failed_step",
          source: args.source,
          reasonCode: args.reasonCode
        }
      });
    }

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

    const sortedSteps = [...graph.steps].sort((a, b) => {
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
    if (sortedSteps.length === 0) return;

    const activeStep =
      sortedSteps.find((step) => !TERMINAL_PHASE_STEP_STATUSES.has(step.status))
      ?? sortedSteps[sortedSteps.length - 1]
      ?? null;
    if (!activeStep) return;

    const stepMeta = isRecord(activeStep.metadata) ? activeStep.metadata : {};
    const nextPhaseKey = typeof stepMeta.phaseKey === "string" && stepMeta.phaseKey.trim().length > 0
      ? stepMeta.phaseKey.trim()
      : "development";
    const nextPhaseName = typeof stepMeta.phaseName === "string" && stepMeta.phaseName.trim().length > 0
      ? stepMeta.phaseName.trim()
      : "Development";
    const nextPhaseModel = isRecord(stepMeta.phaseModel) ? stepMeta.phaseModel : null;
    const nextPhaseInstructions =
      typeof stepMeta.phaseInstructions === "string" && stepMeta.phaseInstructions.trim().length > 0
        ? stepMeta.phaseInstructions.trim()
        : null;
    const nextPhaseValidation = isRecord(stepMeta.phaseValidation) ? stepMeta.phaseValidation : null;
    const nextPhaseBudget = isRecord(stepMeta.phaseBudget) ? stepMeta.phaseBudget : null;

    const runMeta = isRecord(graph.run.metadata) ? graph.run.metadata : {};
    const phaseRuntime = isRecord(runMeta.phaseRuntime) ? runMeta.phaseRuntime : {};
    const prevPhaseKey = typeof phaseRuntime.currentPhaseKey === "string" ? phaseRuntime.currentPhaseKey : null;
    const prevPhaseName = typeof phaseRuntime.currentPhaseName === "string" ? phaseRuntime.currentPhaseName : null;
    if (prevPhaseKey === nextPhaseKey) return;

    const transitionedAt = nowIso();
    const transitionReason = `${prevPhaseName ?? "Start"} -> ${nextPhaseName}`;

    updateRunMetadata(graph.run.id, (metadata) => {
      const nextRuntime = isRecord(metadata.phaseRuntime) ? { ...metadata.phaseRuntime } : {};
      const transitions = Array.isArray(nextRuntime.transitions) ? [...nextRuntime.transitions] : [];
      transitions.unshift({
        fromPhaseKey: prevPhaseKey,
        fromPhaseName: prevPhaseName,
        toPhaseKey: nextPhaseKey,
        toPhaseName: nextPhaseName,
        at: transitionedAt,
        reason
      });
      nextRuntime.transitions = transitions.slice(0, 64);
      nextRuntime.currentPhaseKey = nextPhaseKey;
      nextRuntime.currentPhaseName = nextPhaseName;
      nextRuntime.currentPhaseModel = nextPhaseModel;
      nextRuntime.currentPhaseInstructions = nextPhaseInstructions;
      nextRuntime.currentPhaseValidation = nextPhaseValidation;
      nextRuntime.currentPhaseBudget = nextPhaseBudget;
      nextRuntime.transitionedAt = transitionedAt;

      const phaseBudgets = isRecord(nextRuntime.phaseBudgets) ? { ...nextRuntime.phaseBudgets } : {};
      if (!isRecord(phaseBudgets[nextPhaseKey])) {
        phaseBudgets[nextPhaseKey] = {
          enteredAt: transitionedAt,
          usedTokens: 0,
          usedCostUsd: 0
        };
      }
      nextRuntime.phaseBudgets = phaseBudgets;
      metadata.phaseRuntime = nextRuntime;
    });

    orchestratorService.appendTimelineEvent({
      runId: graph.run.id,
      stepId: activeStep.id,
      eventType: "phase_transition",
      reason: transitionReason,
      detail: {
        fromPhaseKey: prevPhaseKey,
        fromPhaseName: prevPhaseName,
        toPhaseKey: nextPhaseKey,
        toPhaseName: nextPhaseName,
        transitionReason: reason,
        phaseModel: nextPhaseModel,
        phaseValidation: nextPhaseValidation,
        phaseBudget: nextPhaseBudget,
        transitionedAt
      }
    });

    emitOrchestratorMessage(
      graph.run.missionId,
      `Phase transition: ${prevPhaseName ?? "Start"} → ${nextPhaseName}`,
      null,
      { phaseFrom: prevPhaseKey, phaseTo: nextPhaseKey }
    );

    updateMissionStateDoc(graph.run.id, {
      updateProgress: {
        currentPhase: nextPhaseName,
      },
    }, { graph });

    try {
      missionService.logEvent({
        missionId: graph.run.missionId,
        eventType: "phase_transition",
        actor: "system",
        summary: transitionReason,
        payload: {
          runId: graph.run.id,
          fromPhaseKey: prevPhaseKey,
          fromPhaseName: prevPhaseName,
          toPhaseKey: nextPhaseKey,
          toPhaseName: nextPhaseName,
          transitionReason: reason,
          phaseModel: nextPhaseModel,
          phaseValidation: nextPhaseValidation,
          phaseBudget: nextPhaseBudget,
          transitionedAt
        }
      });
    } catch {
      // Best effort mission event write; runtime should continue.
    }
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

        if (skipNormalPrCreation) {
          // Already handled via post-resolution path
        } else try {
          const { settings: runPhaseSettings } = resolveActivePhaseSettings(mission.id);
          const integrationPrPolicy = runPhaseSettings.integrationPr ?? DEFAULT_INTEGRATION_PR_POLICY;
          const teamManifest = runTeamManifests.get(runId);
          const graphLaneCount = new Set(graph.steps.map((s) => s.laneId).filter(Boolean)).size;
          const usedMultipleLanes = (teamManifest && teamManifest.parallelLanes.length > 1) || graphLaneCount > 1;
          const prStrategy: PrStrategy =
            runPhaseSettings.prStrategy
            ?? { kind: "manual" };

          if (prStrategy.kind === "manual") {
            logger.debug("ai_orchestrator.pr_strategy_manual", { missionId: mission.id, runId });
          } else if (prStrategy.kind === "integration" && usedMultipleLanes && prService) {
            try {
              const laneIdArray = [...new Set(graph.steps.map((s) => s.laneId).filter(Boolean))] as string[];
              const integrationLaneName = `integration/${mission.id.slice(0, 8)}`;
              const baseBranch = prStrategy.targetBranch ?? mission.laneId ?? "main";
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
            } catch (prError) {
              // ── Worker-based conflict resolution pipeline ──────────────────
              // When direct PR creation fails (typically due to merge conflicts),
              // the behavior depends on prDepth:
              //   "propose-only"       → list conflicts, create draft PR, no workers
              //   "resolve-conflicts"  → spawn orchestrator worker steps for each conflict
              //   "open-and-comment"   → resolve + spawn review comment worker
              const prDepth = prStrategy.prDepth
                ?? integrationPrPolicy.prDepth
                ?? "resolve-conflicts";

              try {
                // Step 1: Simulate integration to get a conflict map / proposal
                const laneIdArray = [...new Set(graph.steps.map((s) => s.laneId).filter(Boolean))] as string[];
                const baseBranch = prStrategy.targetBranch ?? mission.laneId ?? "main";
                const isDraft = prStrategy.draft ?? integrationPrPolicy.draft ?? true;

                emitOrchestratorMessage(
                  mission.id,
                  `Integration PR creation hit conflicts. Simulating integration for ${laneIdArray.length} lanes against ${baseBranch}...`
                );
                logger.info("ai_orchestrator.conflict_pipeline_starting", {
                  missionId: mission.id,
                  runId,
                  prDepth,
                  originalError: prError instanceof Error ? prError.message : String(prError)
                });

                const proposal = await prService.simulateIntegration({
                  sourceLaneIds: laneIdArray,
                  baseBranch
                });

                const conflictingSteps = proposal.steps.filter((s) => s.outcome === "conflict");

                if (conflictingSteps.length === 0) {
                  // Simulation says no conflicts — original error was likely transient
                  emitOrchestratorMessage(
                    mission.id,
                    `Simulation found no conflicts (original failure may have been transient). Retrying PR creation...`
                  );
                  const retryResult = await prService.createIntegrationPr({
                    sourceLaneIds: laneIdArray,
                    integrationLaneName: `integration/${mission.id.slice(0, 8)}`,
                    baseBranch,
                    title: `[ADE] Integration: ${mission.title}`,
                    body: `Automated integration PR for mission "${mission.title}".\n\nLanes: ${laneIdArray.join(", ")}`,
                    draft: isDraft
                  });
                  emitOrchestratorMessage(
                    mission.id,
                    `Integration PR #${retryResult.pr.githubPrNumber} created (retry): ${retryResult.pr.githubUrl}`
                  );
                  logger.info("ai_orchestrator.integration_pr_created_retry", {
                    missionId: mission.id,
                    runId,
                    prNumber: retryResult.pr.githubPrNumber,
                    url: retryResult.pr.githubUrl
                  });
                } else {
                  // Real conflicts exist — create integration lane
                  emitOrchestratorMessage(
                    mission.id,
                    `Found ${conflictingSteps.length} lane(s) with conflicts: ${conflictingSteps.map((s) => s.laneName).join(", ")}. ` +
                    `Setting up integration lane...`
                  );

                  const laneResult = await prService.createIntegrationLaneForProposal({
                    proposalId: proposal.proposalId
                  });

                  logger.info("ai_orchestrator.integration_lane_created", {
                    missionId: mission.id,
                    runId,
                    integrationLaneId: laneResult.integrationLaneId,
                    mergedClean: laneResult.mergedCleanLanes.length,
                    conflicting: laneResult.conflictingLanes.length
                  });

                  if (laneResult.mergedCleanLanes.length > 0) {
                    emitOrchestratorMessage(
                      mission.id,
                      `Merged ${laneResult.mergedCleanLanes.length} clean lane(s). ` +
                      `${laneResult.conflictingLanes.length} lane(s) need resolution.`
                    );
                  }

                  const integrationLaneName = `integration/${mission.id.slice(0, 8)}`;

                  // ── propose-only: list conflicts and create draft, no resolution ──
                  if (prDepth === "propose-only") {
                    const conflictSummaryLines: string[] = [];
                    for (const conflictLaneId of laneResult.conflictingLanes) {
                      const cStep = conflictingSteps.find((s) => s.laneId === conflictLaneId);
                      const laneName = cStep?.laneName ?? conflictLaneId;
                      const files = cStep?.conflictingFiles.map((f) => f.path) ?? [];
                      conflictSummaryLines.push(
                        `Lane "${laneName}" conflicts in ${files.length} file(s): ${files.join(", ") || "(unknown)"}`
                      );
                    }
                    emitOrchestratorMessage(
                      mission.id,
                      `Conflicts detected (propose-only mode — no auto-resolution):\n${conflictSummaryLines.join("\n")}`
                    );

                    // Create draft PR that documents the conflicts
                    try {
                      const draftResult = await prService.commitIntegration({
                        proposalId: proposal.proposalId,
                        integrationLaneName,
                        title: `[ADE] Integration (draft): ${mission.title}`,
                        body: `Automated integration PR for mission "${mission.title}".\n\n` +
                              `Lanes: ${laneIdArray.join(", ")}\n\n` +
                              `**Conflicts (not auto-resolved):**\n${conflictSummaryLines.join("\n")}`,
                        draft: true
                      });
                      emitOrchestratorMessage(
                        mission.id,
                        `Draft integration PR #${draftResult.pr.githubPrNumber} created: ${draftResult.pr.githubUrl}`
                      );
                      logger.info("ai_orchestrator.integration_pr_draft_created", {
                        missionId: mission.id,
                        runId,
                        prNumber: draftResult.pr.githubPrNumber,
                        url: draftResult.pr.githubUrl,
                        conflictCount: laneResult.conflictingLanes.length
                      });
                    } catch (draftError) {
                      logger.warn("ai_orchestrator.integration_pr_draft_failed", {
                        missionId: mission.id,
                        runId,
                        error: draftError instanceof Error ? draftError.message : String(draftError)
                      });
                      emitOrchestratorMessage(
                        mission.id,
                        `Could not create draft PR: ${draftError instanceof Error ? draftError.message : String(draftError)}. ` +
                        `Integration lane is available for manual resolution.`
                      );
                    }
                  } else {
                    // ── resolve-conflicts / open-and-comment: spawn worker steps ──

                    // For each conflicting lane, probe for conflict files and spawn a worker step
                    const conflictStepKeys: string[] = [];
                    const existingSteps = graph.steps;
                    const maxIndex = existingSteps.reduce((max, s) => Math.max(max, s.stepIndex), -1);
                    const newStepInputs: StartOrchestratorRunStepInput[] = [];

                    for (let i = 0; i < laneResult.conflictingLanes.length; i++) {
                      const conflictLaneId = laneResult.conflictingLanes[i]!;
                      const cStep = conflictingSteps.find((s) => s.laneId === conflictLaneId);
                      const laneName = cStep?.laneName ?? conflictLaneId;

                      // Probe conflict files via startIntegrationResolution
                      const resolutionInfo = await prService.startIntegrationResolution({
                        proposalId: proposal.proposalId,
                        laneId: conflictLaneId
                      });

                      if (resolutionInfo.mergedClean) {
                        emitOrchestratorMessage(mission.id, `Lane "${laneName}" merged cleanly (no worker needed).`);
                        continue;
                      }

                      const stepKey = `conflict-resolve-${conflictLaneId.slice(0, 8)}`;
                      conflictStepKeys.push(stepKey);

                      newStepInputs.push({
                        stepKey,
                        title: `Resolve conflicts: ${laneName}`,
                        stepIndex: maxIndex + 1 + i,
                        laneId: resolutionInfo.integrationLaneId,
                        dependencyStepKeys: [],
                        retryLimit: 1,
                        metadata: {
                          stepType: "conflict-resolution",
                          conflictFiles: resolutionInfo.conflictFiles,
                          sourceLaneName: laneName,
                          sourceLaneId: conflictLaneId,
                          integrationLaneId: resolutionInfo.integrationLaneId,
                          proposalId: proposal.proposalId,
                          instructions: buildConflictResolutionInstructions(resolutionInfo.conflictFiles, laneName)
                        }
                      });

                      emitOrchestratorMessage(
                        mission.id,
                        `Spawning conflict resolution worker for lane "${laneName}" (${resolutionInfo.conflictFiles.length} file(s)).`
                      );
                    }

                    if (newStepInputs.length === 0) {
                      // All lanes merged cleanly during probe — commit directly
                      emitOrchestratorMessage(mission.id, `All conflicts resolved during probe. Creating integration PR...`);
                      const commitResult = await prService.commitIntegration({
                        proposalId: proposal.proposalId,
                        integrationLaneName,
                        title: `[ADE] Integration: ${mission.title}`,
                        body: `Automated integration PR for mission "${mission.title}".\n\nLanes: ${laneIdArray.join(", ")}`,
                        draft: isDraft
                      });
                      emitOrchestratorMessage(
                        mission.id,
                        `Integration PR #${commitResult.pr.githubPrNumber} created: ${commitResult.pr.githubUrl}`
                      );
                      logger.info("ai_orchestrator.integration_pr_created_clean_probe", {
                        missionId: mission.id,
                        runId,
                        prNumber: commitResult.pr.githubPrNumber,
                        url: commitResult.pr.githubUrl
                      });
                    } else {
                      // Add worker steps to the run (reopens terminal run if needed)
                      const addedSteps = orchestratorService.addPostCompletionSteps({
                        runId,
                        steps: newStepInputs
                      });

                      // Track each worker with prService
                      for (const addedStep of addedSteps) {
                        const meta = addedStep.metadata as Record<string, unknown> | null;
                        const sourceLaneId = meta?.sourceLaneId as string | undefined;
                        if (sourceLaneId) {
                          prService.markResolutionWorkerActive(proposal.proposalId, sourceLaneId, addedStep.id);
                        }
                      }

                      // Store context for post-resolution completion handler
                      pendingIntegrations.set(runId, {
                        proposalId: proposal.proposalId,
                        missionId: mission.id,
                        integrationLaneName,
                        integrationLaneId: laneResult.integrationLaneId,
                        baseBranch,
                        isDraft,
                        prDepth,
                        conflictStepKeys,
                        reviewStepKey: null,
                        laneIdArray,
                        missionTitle: mission.title
                      });

                      // Flag that workers were spawned — defer mission completion
                      workersSpawned = true;

                      logger.info("ai_orchestrator.conflict_workers_spawned", {
                        missionId: mission.id,
                        runId,
                        prDepth,
                        workerCount: addedSteps.length,
                        stepKeys: conflictStepKeys
                      });

                      emitOrchestratorMessage(
                        mission.id,
                        `Spawned ${addedSteps.length} conflict resolution worker(s). ` +
                        `The run will resume and complete after all conflicts are resolved.`
                      );
                    }
                  }
                }
              } catch (pipelineError) {
                // Safety net: if the pipeline itself fails, fall back to logging + messaging
                logger.warn("ai_orchestrator.conflict_pipeline_failed", {
                  missionId: mission.id,
                  runId,
                  prDepth,
                  originalError: prError instanceof Error ? prError.message : String(prError),
                  pipelineError: pipelineError instanceof Error ? pipelineError.message : String(pipelineError)
                });
                emitOrchestratorMessage(
                  mission.id,
                  `Integration PR creation failed and conflict pipeline also failed.\n` +
                  `Original error: ${prError instanceof Error ? prError.message : String(prError)}\n` +
                  `Pipeline error: ${pipelineError instanceof Error ? pipelineError.message : String(pipelineError)}`
                );
              }
            }
          } else if (prStrategy.kind === "per-lane" && prService && usedMultipleLanes) {
            try {
              const laneIdArray = [...new Set(graph.steps.map((s) => s.laneId).filter(Boolean))] as string[];
              const baseBranch = prStrategy.targetBranch ?? mission.laneId ?? "main";
              const isDraft = prStrategy.draft ?? true;

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
                }
              }
            } catch (perLaneError) {
              logger.warn("ai_orchestrator.per_lane_pr_batch_failed", {
                missionId: mission.id,
                runId,
                error: perLaneError instanceof Error ? perLaneError.message : String(perLaneError)
              });
            }
          } else if (prStrategy.kind === "queue" && prService && usedMultipleLanes) {
            try {
              const laneIdArray = [...new Set(graph.steps.map((s) => s.laneId).filter(Boolean))] as string[];
              const targetBranch = prStrategy.targetBranch ?? mission.laneId ?? "main";

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
            }
          }
        } catch (prStrategyError) {
          logger.debug("ai_orchestrator.pr_strategy_trigger_failed", {
            runId,
            missionId: mission.id,
            error: prStrategyError instanceof Error ? prStrategyError.message : String(prStrategyError)
          });
        }

        // Deferred mission completion: only transition to "completed" if no
        // conflict resolution workers were spawned. When workers ARE spawned,
        // the run was reopened (succeeded → running) and the mission should
        // stay in_progress until the workers complete.
        if (!workersSpawned) {
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
        graph.run.status === "succeeded_with_risk" ||
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
          nextMissionStatus === "partially_completed" ||
          nextMissionStatus === "failed" ||
          nextMissionStatus === "canceled";
        if (missionTerminal) {
          const mid = mission.id;
          chatMessages.delete(mid);
          activeSteeringDirectives.delete(mid);
          activeChatSessions.delete(mid);
          chatTurnQueues.delete(mid);
          // Clean planner session and associated session-keyed maps.
          const plannerState = plannerSessionByMissionId.get(mid);
          if (plannerState) {
            plannerSessionByMissionId.delete(mid);
            const sid = plannerState.sessionId;
            plannerSessionBySessionId.delete(sid);
            sessionRuntimeSignals.delete(sid);
            sessionSignalQueues.delete(sid);
          }
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

    // ── Check for existing run (plan review re-entry) ──
    if (args.forcePlanReviewBypass) {
      const existingRuns = orchestratorService.listRuns({ missionId });
      const activeRun = existingRuns.find(
        (r) => r.status === "active" || r.status === "bootstrapping" || r.status === "queued" || r.status === "paused"
      );
      if (activeRun) {
        // Resume the coordinator for the existing run
        const coordinatorModelConfig = resolveOrchestratorModelConfig(missionId, "coordinator");
        const { userRules, projectCtx, availableProviders, phases } = gatherCoordinatorContext(missionId, args);
        const resumeMissionLaneId = await ensureMissionLaneForRun({
          runId: activeRun.id,
          missionId,
          missionTitle: initialMission.title,
        });
        const resumedCoordinator = startCoordinatorAgentV2(missionId, activeRun.id, missionGoal, coordinatorModelConfig, {
          userRules,
          projectContext: projectCtx,
          availableProviders,
          phases,
          missionLaneId: resumeMissionLaneId ?? undefined,
        });
        const coordinatorStarted = Boolean(resumedCoordinator?.isAlive);
        if (coordinatorStarted) {
          const ts = nowIso();
          db.run(
            `update orchestrator_runs set status = 'active', updated_at = ? where id = ? and status in ('bootstrapping', 'queued', 'paused')`,
            [ts, activeRun.id]
          );
        } else {
          pauseRunWithIntervention({
            runId: activeRun.id,
            missionId,
            source: "transition_decision",
            reasonCode: "coordinator_start_failed",
            title: "Coordinator startup failed",
            body: "Coordinator runtime failed to start while resuming this run. Activation was blocked to preserve coordinator-owned autonomy.",
            requestedAction: "Resolve coordinator startup health, then resume the run.",
            metadata: {
              startupPath: "force_plan_review_bypass_resume"
            }
          });
        }

        const steps = orchestratorService.listSteps(activeRun.id);
        const existingGraph = getRunGraphSafe(activeRun.id);
        updateMissionStateDoc(
          activeRun.id,
          {
            ...(existingGraph ? { updateProgress: buildMissionStateProgressFromGraph(existingGraph) } : {}),
            pendingInterventions: pendingInterventionsForMission(missionId),
          },
          { graph: existingGraph }
        );
        return {
          blockedByPlanReview: false,
          started: {
            run: orchestratorService.listRuns({ limit: 1_000 }).find((entry) => entry.id === activeRun.id) ?? activeRun,
            steps
          },
          mission: missionService.get(missionId)
        };
      }
    }

    const runtimeProfile = resolveActiveRuntimeProfile(missionId);
    const planningEnabled = runtimeProfile.planning.useAiPlanner;
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
    const replanOnStart = launchMetadata?.replanOnStart === true;
    const shouldPlanBeforeCoordinator = planningEnabled && (initialMission.steps.length === 0 || replanOnStart);
    if (shouldPlanBeforeCoordinator) {
      const plannerProvider = resolvePlannerProviderForMission({
        missionId,
        plannerProviderHint: args.plannerProvider ?? null,
        runtimeProfile
      });
      const plannerModelHint = runtimeProfile.planning.preferProvider;
      const plannerModel =
        typeof plannerModelHint === "string" && plannerModelHint.trim().length > 0 && getModelById(plannerModelHint)
          ? plannerModelHint
          : undefined;

      if (!plannerProvider) {
        logger.warn("ai_orchestrator.start_mission_planner_unavailable", {
          missionId,
          preferProvider: runtimeProfile.planning.preferProvider
        });
      } else {
        transitionMissionStatus(missionId, "planning");
        emitOrchestratorMessage(
          missionId,
          `Planner starting (${plannerProvider}${plannerModel ? ` · ${plannerModel}` : ""}). Coordinator activation will begin after planning completes.`
        );
        await planWithAI({
          missionId,
          provider: plannerProvider,
          ...(plannerModel ? { model: plannerModel } : {}),
          policy: resolveActivePolicy(missionId)
        });
      }
    } else if (planningEnabled && initialMission.steps.length > 0) {
      logger.info("ai_orchestrator.start_mission_reusing_existing_plan", {
        missionId,
        stepCount: initialMission.steps.length
      });
    }

    const missionAfterPlanning = missionService.get(missionId);
    const missionMetadataAfterPlanning = getMissionMetadata(missionId);
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

    // ── Create run — just persistence, no planning ──
    const started = orchestratorService.startRun({
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
        teamRuntime: launchTeamRuntime
          ? {
              ...launchTeamRuntime,
              ...normalizeAgentRuntimeFlags(launchTeamRuntime)
            }
          : undefined,
        agentRuntime: normalizeAgentRuntimeFlags(launchAgentRuntime),
        aiFirst: true,
      }
    });

    // ── Gather context for the coordinator ──
    const { userRules, projectCtx, availableProviders, phases } = gatherCoordinatorContext(missionId, args);

    // ── Create a dedicated mission lane ──
    const missionLaneId = await ensureMissionLaneForRun({
      runId: started.run.id,
      missionId,
      missionTitle: initialMission.title,
    });

    // ── Spawn the coordinator — the AI brain takes over ──
    const coordinatorModelConfig = resolveOrchestratorModelConfig(missionId, "coordinator");
    const coordinatorAgent = startCoordinatorAgentV2(missionId, started.run.id, missionGoal, coordinatorModelConfig, {
      userRules,
      projectContext: projectCtx,
      availableProviders,
      phases,
      missionLaneId: missionLaneId ?? undefined,
    });
    if (!coordinatorAgent?.isAlive) {
      pauseRunWithIntervention({
        runId: started.run.id,
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
      const failedRun = orchestratorService.listRuns({ limit: 1_000 }).find((entry) => entry.id === started.run.id) ?? started.run;
      return {
        blockedByPlanReview: false,
        started: {
          run: failedRun,
          steps: orchestratorService.listSteps(started.run.id)
        },
        mission: missionService.get(missionId),
      };
    }

    // Mark run as active only after coordinator startup succeeds.
    const runStartTs = nowIso();
    db.run(
      `update orchestrator_runs set status = 'active', started_at = coalesce(started_at, ?), updated_at = ? where id = ?`,
      [runStartTs, runStartTs, started.run.id]
    );
    transitionMissionStatus(missionId, "in_progress");
    emitOrchestratorMessage(
      missionId,
      "Mission started. The AI orchestrator is now in control."
    );

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
      blockedByPlanReview: false,
      started,
      mission: missionService.get(missionId),
    };
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

    // Discover project docs
    const projectDocsContext = discoverProjectDocs();
    if (projectDocsContext.paths.length > 0) {
      persistDiscoveredDocPathsToMemory({
        missionId,
        docPaths: projectDocsContext.paths
      });
    }
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

    // Load phase cards so the coordinator knows the mission execution phases
    const phaseConfig = missionService.getPhaseConfiguration(missionId);
    const phases = phaseConfig?.selectedPhases ?? [];

    return { userRules, projectCtx, availableProviders, phases };
  };

  const approveMissionPlan = async (args: MissionRunStartArgs): Promise<MissionRunStartResult> => {
    const missionId = String(args.missionId ?? "").trim();
    if (!missionId.length) throw new Error("missionId is required.");
    const mission = missionService.get(missionId);
    if (!mission) throw new Error(`Mission not found: ${missionId}`);
    const runs = orchestratorService.listRuns({ missionId });
    const activeRun = runs.find((entry) => entry.status === "active" || entry.status === "bootstrapping" || entry.status === "paused" || entry.status === "queued") ?? null;

    for (const intervention of mission.interventions) {
      if (
        intervention.status === "open" &&
        intervention.interventionType === "approval_required" &&
        intervention.title === PLAN_REVIEW_INTERVENTION_TITLE
      ) {
        try {
          missionService.resolveIntervention({
            missionId,
            interventionId: intervention.id,
            status: "resolved",
            note: "Approved for execution."
          });
          if (activeRun) {
            recordRuntimeEvent({
              runId: activeRun.id,
              eventType: "intervention_resolved",
              eventKey: `intervention_resolved:${intervention.id}:plan_approval`,
              payload: {
                interventionId: intervention.id,
                reason: "plan_approved"
              }
            });
          }
        } catch {
          // ignore
        }
      }
    }

    return startMissionRun({
      ...args,
      forcePlanReviewBypass: true
    });
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

    return run;
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

    if (requestedRunId) {
      const runMissionId = getMissionIdForRun(requestedRunId);
      if (!runMissionId) {
        throw new Error(`Run not found: ${requestedRunId}`);
      }
      if (runMissionId !== missionId) {
        throw new Error(`Run ${requestedRunId} does not belong to mission ${missionId}.`);
      }
    } else {
      const missionRuns = [...orchestratorService.listRuns({ missionId, limit: 200 })]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      resolvedRunId = missionRuns[0]?.id ?? null;
    }

    const graph = resolvedRunId ? getRunGraphSafe(resolvedRunId) : null;
    const laneIds = graph
      ? [...new Set(graph.steps.map((step) => toOptionalString(step.laneId)).filter((value): value is string => Boolean(value)))]
      : [];

    const result: CleanupOrchestratorTeamResourcesResult = {
      missionId,
      runId: resolvedRunId,
      laneIds,
      lanesArchived: [],
      lanesSkipped: [],
      laneErrors: []
    };

    if (!cleanupLanes || !laneIds.length) {
      return result;
    }

    if (!laneService || typeof laneService.archive !== "function") {
      result.laneErrors = laneIds.map((laneId) => ({ laneId, error: "Lane service unavailable." }));
      return result;
    }

    for (const laneId of laneIds) {
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
      laneCount: laneIds.length,
      archivedCount: result.lanesArchived.length,
      skippedCount: result.lanesSkipped.length,
      errorCount: result.laneErrors.length
    });

    return result;
  };

  const steerMission = (steerArgs: SteerMissionArgs): SteerMissionResult => {
    const missionId = steerArgs.missionId?.trim();
    if (!missionId) throw new Error("missionId is required.");

    const mission = missionService.get(missionId);
    if (!mission) throw new Error(`Mission not found: ${missionId}`);

    const directive: UserSteeringDirective = {
      missionId,
      directive: steerArgs.directive,
      priority: steerArgs.priority ?? "suggestion",
      targetStepKey: steerArgs.targetStepKey ?? null
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

    // ── Real-time steering injection ──
    // If the directive targets a specific step with an active agent session,
    // inject it directly into the running session for zero-latency delivery.
    if (directive.targetStepKey && agentChatService) {
      try {
        const runs = orchestratorService.listRuns({ missionId });
        const activeRun = runs.find(
          (r) => r.status === "active" || r.status === "bootstrapping" || r.status === "queued" || r.status === "paused"
        );
        if (activeRun) {
          const graph = orchestratorService.getRunGraph({ runId: activeRun.id, timelineLimit: 0 });
          const targetStep = graph.steps.find((s) => s.stepKey === directive.targetStepKey);
          if (targetStep) {
            const runningWorkers = [...workerStates.entries()].filter(
              ([, ws]) =>
                ws.state === "working" &&
                ws.sessionId &&
                ws.stepId === targetStep.id &&
                ws.runId === activeRun.id
            );
            for (const [attemptId, ws] of runningWorkers) {
              const sessionId = ws.sessionId!;
              const steerContent = `[STEERING DIRECTIVE] ${directive.directive}`;
              void sendWorkerMessageToSession(sessionId, steerContent)
                .then(() => {
                  updateMissionMetadata(missionId, (meta) => {
                    const delivered = Array.isArray(meta._liveDeliveredDirectives)
                      ? (meta._liveDeliveredDirectives as unknown[])
                      : [];
                    delivered.push({
                      attemptId,
                      sessionId,
                      stepKey: directive.targetStepKey,
                      deliveredAt: nowIso()
                    });
                    meta._liveDeliveredDirectives = delivered.slice(-20);
                  });
                  logger.info("ai_orchestrator.steering_live_injected", {
                    missionId,
                    targetStepKey: directive.targetStepKey,
                    attemptId,
                    sessionId
                  });
                })
                .catch((injectError) => {
                  logger.debug("ai_orchestrator.steering_live_inject_failed", {
                    missionId,
                    targetStepKey: directive.targetStepKey,
                    attemptId,
                    error: injectError instanceof Error ? injectError.message : String(injectError)
                  });
                });
              break; // Only inject into one matching session
            }
          }
        }
      } catch (liveInjectError) {
        logger.debug("ai_orchestrator.steering_live_inject_outer_failed", {
          missionId,
          error: liveInjectError instanceof Error ? liveInjectError.message : String(liveInjectError)
        });
      }
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
    const openManualInput = refreshedMission?.interventions.filter((entry) => entry.status === "open" && entry.interventionType === "manual_input") ?? [];
    for (const intervention of openManualInput) {
      try {
        missionService.resolveIntervention({
          missionId,
          interventionId: intervention.id,
          status: "resolved",
          note: `Resolved by steering directive (${directive.priority}).`
        });
        resolvedInterventions.push(intervention.id);
        const meta = isRecord(intervention.metadata) ? intervention.metadata : null;
        const runId = typeof meta?.runId === "string" ? meta.runId : "";
        if (runId.length > 0) {
          const threadId = typeof meta?.threadId === "string" ? meta.threadId.trim() : "";
          const replyTo = typeof meta?.messageId === "string" ? meta.messageId.trim() : "";
          const questionReplyLink =
            threadId.length > 0 && replyTo.length > 0
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
              reason: "steering_directive",
              priority: directive.priority,
              directive: clipTextForContext(directive.directive, 220),
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
          const attemptId = typeof meta?.attemptId === "string" ? meta.attemptId.trim() : "";
          const stepId = typeof meta?.stepId === "string" ? meta.stepId.trim() : "";
          if (attemptId.length > 0 && stepId.length > 0) {
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
          resumedRunIds.add(runId);
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
        `Applied steering and resolved ${resolvedInterventions.length} waiting-input intervention${resolvedInterventions.length === 1 ? "" : "s"}.`,
        directive.targetStepKey ?? null,
        {
          interventionIds: resolvedInterventions,
          projectedStepCount
        }
      );
    }

    // Real-time delivery: try to deliver the directive to running planner session
    const plannerState = plannerSessionByMissionId.get(missionId);
    if (plannerState && agentChatService) {
      void (async () => {
        try {
          await sendWorkerMessageToSession(
            plannerState.sessionId,
            `[ADE ORCHESTRATOR STEERING]: ${directive.directive}`
          );
          logger.debug("ai_orchestrator.steering_delivered_to_planner", {
            missionId,
            directive: directive.directive.slice(0, 200)
          });
        } catch (deliveryError) {
          logger.debug("ai_orchestrator.steering_planner_delivery_failed", {
            missionId,
            error: deliveryError instanceof Error ? deliveryError.message : String(deliveryError)
          });
        }
      })();
    }

    // Real-time delivery: try to deliver the directive to running worker sessions
    if (agentChatService) {
      // Build a set of runIds that belong to this mission for fast lookup
      const missionRunIds = new Set<string>();
      // Build a map of stepId -> stepKey for resolving targeted delivery
      const stepIdToStepKey = new Map<string, string>();
      try {
        const runs = orchestratorService.listRuns({ missionId, limit: 200 });
        for (const run of runs) {
          missionRunIds.add(run.id);
          if (directive.targetStepKey) {
            try {
              const graph = orchestratorService.getRunGraph({ runId: run.id, timelineLimit: 0 });
              for (const step of graph.steps) {
                stepIdToStepKey.set(step.id, step.stepKey);
              }
            } catch {
              // ignore graph lookup failures
            }
          }
        }
      } catch {
        // ignore listRuns failures — fall through with empty sets
      }

      const formattedDirective = `[ADE ORCHESTRATOR STEERING]: ${directive.directive}`;

      if (directive.targetStepKey) {
        // Targeted delivery: find the specific worker for this step
        const targetWorker = [...workerStates.entries()].find(([, ws]) => {
          if (!ws.runId || ws.state !== "working" || !ws.sessionId) return false;
          if (!missionRunIds.has(ws.runId)) return false;
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
          if (ws.runId && ws.state === "working" && ws.sessionId && missionRunIds.has(ws.runId)) {
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
      void runHealthSweep("interval").catch((error) => {
        logger.debug("ai_orchestrator.health_sweep_interval_failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, HEALTH_SWEEP_INTERVAL_MS);
    healthSweepTimerRef.current = healthSweepTimer;
    if (!disposed) {
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
    const runtimeState = parseTerminalRuntimeState(signal.runtimeState) ?? "running";
    const normalizedSignal: SessionRuntimeSignal = {
      laneId: String(signal.laneId ?? "").trim(),
      sessionId,
      runtimeState,
      lastOutputPreview:
        typeof signal.lastOutputPreview === "string" && signal.lastOutputPreview.trim().length > 0
          ? clipTextForContext(signal.lastOutputPreview.trim(), MAX_RUNTIME_SIGNAL_PREVIEW_CHARS)
          : null,
      at: typeof signal.at === "string" && signal.at.trim().length > 0 ? signal.at : nowIso()
    };
    sessionRuntimeSignals.set(sessionId, normalizedSignal);
    if (sessionRuntimeSignals.size > 500) {
      pruneSessionRuntimeSignals();
    }
    const previous = sessionSignalQueues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch((error) => { logger.warn("ai_orchestrator.session_signal_queue_previous_failed", { sessionId, error: getErrorMessage(error) }); })
      .then(async () => {
        if (disposed) return;
        await processSessionRuntimeSignal(normalizedSignal);
        if (disposed) return;
        await replayQueuedWorkerMessages({
          reason: "runtime_signal",
          sessionId
        });
      })
      .catch((error) => {
        logger.debug("ai_orchestrator.runtime_signal_process_failed", {
          sessionId,
          runtimeState: normalizedSignal.runtimeState,
          error: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        if (sessionSignalQueues.get(sessionId) === next) {
          sessionSignalQueues.delete(sessionId);
        }
      });
    sessionSignalQueues.set(sessionId, next);
  };

  const handlePlannerAgentChatEvent = (envelope: AgentChatEventEnvelope): boolean => {
    const sessionId = String(envelope.sessionId ?? "").trim();
    if (!sessionId.length) return false;
    const state = plannerSessionBySessionId.get(sessionId);
    if (!state) return false;

    state.lastEventAt = typeof envelope.timestamp === "string" && envelope.timestamp.trim().length
      ? envelope.timestamp
      : nowIso();

    const event = envelope.event;
    if (event.type === "status") {
      if (event.turnId) {
        state.activeTurnId = event.turnId;
      }
      if (event.turnStatus === "started") {
        appendPlannerWorkerMessage(
          state,
          "Planner started reasoning on the mission plan.",
          {
            planner: {
              event: "turn_started",
              sessionId: state.sessionId,
              turnId: event.turnId ?? null
            }
          }
        );
      } else if (event.turnStatus === "failed" || event.turnStatus === "interrupted") {
        const status = event.turnStatus === "failed" ? "failed" : "interrupted";
        const message = typeof event.message === "string" && event.message.trim().length
          ? event.message.trim()
          : `Planner turn ${status}.`;
        appendPlannerWorkerMessage(state, message, {
          planner: {
            event: "turn_status_terminal",
            sessionId: state.sessionId,
            status
          }
        });
        completePlannerTurn(state, status, message);
      }
      return true;
    }

    if (event.type === "text") {
      appendPlannerTextDelta(state, event.text);
      return true;
    }

    if (event.type === "plan") {
      appendPlannerWorkerMessage(
        state,
        `Planner proposed ${event.steps.length} plan step${event.steps.length === 1 ? "" : "s"}.`,
        {
          planner: {
            event: "plan_outline",
            sessionId: state.sessionId
          }
        }
      );
      return true;
    }

    if (event.type === "error") {
      const rawMsg = String(event.message ?? "Planner session reported an error.").trim();

      // Filter known noisy errors into human-readable summaries
      let displayMsg = rawMsg;
      if (rawMsg.includes("File content") && rawMsg.includes("exceeds maximum")) {
        displayMsg = "Reading large file in smaller chunks...";
      } else if (rawMsg.includes("Sibling tool call errored")) {
        // Skip entirely - this is a cascading error from a parallel tool call
        return true;
      } else if (rawMsg.includes("SANDBOX BLOCKED")) {
        displayMsg = "Skipping restricted path, trying alternative approach...";
      } else if (rawMsg.startsWith("Tool '") && rawMsg.includes("failed:")) {
        // Generic tool failure - summarize
        const toolName = rawMsg.match(/Tool '(\w+)'/)?.[1] ?? "tool";
        displayMsg = `${toolName} encountered an issue, adjusting approach...`;
      }

      // Only emit if we have a meaningful message
      if (displayMsg && displayMsg.length > 3) {
        appendPlannerWorkerMessage(state, displayMsg, {
          planner: {
            event: "error",
            sessionId: state.sessionId
          }
        });
      }
      completePlannerTurn(state, "failed", rawMsg);
      return true;
    }

    if (event.type === "done") {
      const status: PlannerTurnCompletionStatus =
        event.status === "failed"
          ? "failed"
          : event.status === "interrupted"
            ? "interrupted"
            : "completed";
      completePlannerTurn(state, status, status === "completed" ? null : `Planner turn ${status}.`);
      appendPlannerWorkerMessage(
        state,
        status === "completed"
          ? "Planner completed the turn."
          : `Planner turn ${status}.`,
        {
          planner: {
            event: "turn_done",
            sessionId: state.sessionId,
            status
          }
        }
      );
      return true;
    }

    return false;
  };

  const onAgentChatEvent = (envelope: AgentChatEventEnvelope): void => {
    if (disposed) return;
    const sessionId = String(envelope.sessionId ?? "").trim();
    if (!sessionId.length) return;
    handlePlannerAgentChatEvent(envelope);
    const event = envelope.event;
    const shouldReplay =
      (event.type === "status" && (event.turnStatus === "completed" || event.turnStatus === "interrupted" || event.turnStatus === "failed"))
      || event.type === "done"
      || event.type === "error";
    if (!shouldReplay) return;

    const previous = sessionSignalQueues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch((error) => { logger.warn("ai_orchestrator.session_signal_queue_previous_failed", { sessionId, error: getErrorMessage(error) }); })
      .then(async () => {
        if (disposed) return;
        await replayQueuedWorkerMessages({
          reason: `agent_chat:${event.type}`,
          sessionId
        });
      })
      .catch((error) => {
        logger.warn("ai_orchestrator.agent_chat_replay_failed", {
          sessionId,
          eventType: event.type,
          error: getErrorMessage(error)
        });
      })
      .finally(() => {
        if (sessionSignalQueues.get(sessionId) === next) {
          sessionSignalQueues.delete(sessionId);
        }
      });
    sessionSignalQueues.set(sessionId, next);
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

  // ---------------------------------------------------------------------------
  // Smart Agent Recovery: AI-diagnosed failure handling with tiered response
  // ---------------------------------------------------------------------------

  return {
    startMissionRun,

    approveMissionPlan,
    cancelRunGracefully,
    cleanupTeamResources,

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

      // ── Strict coordinator ownership gate ──
      const existingCoordinator = coordinatorAgents.get(runId) ?? null;
      let coordinator = existingCoordinator?.isAlive ? existingCoordinator : null;
      if (!coordinator && existingCoordinator && !existingCoordinator.isAlive) {
        const recovered = attemptCoordinatorRecovery(runId);
        if (recovered?.isAlive) coordinator = recovered;
      }
      if (!coordinator) {
        if (event.reason !== "finalized") {
          const missionId = getMissionIdForRun(runId);
          if (missionId) {
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
        }
        logger.warn("ai_orchestrator.coordinator_unavailable", {
          runId,
          eventType: event.type,
          reason: event.reason,
          recovered: false
        });
        return;
      }

      // Run finalized — coordinator's job is done, shut it down
      if (event.reason === "finalized") {
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
    planWithAI,
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
    getMissionMetrics,
    setMissionMetricsConfig,
    getExecutionPlanPreview,
    getMissionStateDocument,
    getAggregatedUsage,
    getTeamManifest: (tmArgs: { runId: string }): TeamManifest | null => {
      return runTeamManifests.get(tmArgs.runId) ?? null;
    },
    getRecoveryLoopState: (rlArgs: { runId: string }): RecoveryLoopState | null => {
      return runRecoveryLoopStates.get(rlArgs.runId) ?? null;
    },
    runHealthSweep: (reason = "manual") => runHealthSweep(reason),
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
      plannerSessionByMissionId.clear();
      plannerSessionBySessionId.clear();
      activeHealthSweepRuns.clear();
      sessionRuntimeSignals.clear();
      attemptRuntimeTrackers.clear();
      sessionSignalQueues.clear();
      workerDeliveryThreadQueues.clear();
      workerDeliveryInterventionCooldowns.clear();
      runTeamManifests.clear();
      runRecoveryLoopStates.clear();
      teamRuntimeStates.clear();
      // Shutdown all coordinator agents
      for (const [rid, agent] of coordinatorAgents.entries()) {
        agent.shutdown();
        coordinatorAgents.delete(rid);
      }
    }
  };
}
