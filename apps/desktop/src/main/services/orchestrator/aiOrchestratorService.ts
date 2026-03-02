import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type {
  MissionDetail,
  MissionStep,
  MissionExecutionPolicy,
  MissionPlannerEngine,
  MissionStepStatus,
  MissionStatus,
  ModelCapabilityProfile,
  CancelOrchestratorRunArgs,
  OrchestratorExecutorKind,
  OrchestratorRun,
  OrchestratorRunGraph,
  OrchestratorStep,
  OrchestratorRuntimeEvent,
  OrchestratorStepStatus,
  OrchestratorWorkerState,
  OrchestratorWorkerStatus,
  OrchestratorPlannerProvider,
  OrchestratorRuntimeQuestionLink,
  TerminalRuntimeState,
  SteerMissionArgs,
  SteerMissionResult,
  CleanupOrchestratorTeamResourcesArgs,
  CleanupOrchestratorTeamResourcesResult,
  GetModelCapabilitiesResult,
  UserSteeringDirective,
  OrchestratorChatMessage,
  OrchestratorChatThread,
  OrchestratorChatThreadType,
  OrchestratorChatTarget,
  OrchestratorChatVisibilityMode,
  OrchestratorChatDeliveryState,
  SendOrchestratorChatArgs,
  GetOrchestratorChatArgs,
  ListOrchestratorChatThreadsArgs,
  GetOrchestratorThreadMessagesArgs,
  SendOrchestratorThreadMessageArgs,
  OrchestratorWorkerDigest,
  ListOrchestratorWorkerDigestsArgs,
  GetOrchestratorWorkerDigestArgs,
  OrchestratorContextCheckpoint,
  GetOrchestratorContextCheckpointArgs,
  OrchestratorLaneDecision,
  ListOrchestratorLaneDecisionsArgs,
  MissionMetricsConfig,
  MissionMetricSample,
  MissionMetricToggle,
  GetMissionMetricsArgs,
  SetMissionMetricsConfigArgs,
  OrchestratorThreadEvent,
  DagMutationEvent,
  AgentChatEventEnvelope,
  TeamManifest,
  TeamComplexityAssessment,
  TeamWorkerAssignment,
  TeamDecisionEntry,
  ExecutionPlanPreview,
  ExecutionPlanPhase,
  ExecutionPlanStepPreview,
  OrchestratorWorkerRole,
  RecoveryLoopPolicy,
  AggregatedUsageStats,
  GetAggregatedUsageArgs,
  UsageModelBreakdown,
  UsageRecentSession,
  UsageActiveSession,
  UsageMissionBreakdown,
  RecoveryLoopState,
  RecoveryDiagnosisTier,
  RecoveryDiagnosis,
  OrchestratorContextView,
  IntegrationPrPolicy,
  PrDepth,
  PrStrategy,
  StartOrchestratorRunStepInput,
  OrchestratorArtifactKind,
  OrchestratorRunStatus,
  OrchestratorTeamMember,
  OrchestratorTeamRuntimeState,
  TeamRuntimeConfig,
  TeamTemplate,
  RoleDefinition,
  MissionPolicyFlags,
  FinalizeRunArgs,
  FinalizeRunResult,
  RunCompletionBlocker,
  RunCompletionValidation,
  SLASH_COMMAND_TRANSLATIONS
} from "../../../shared/types";
import type { ModelConfig, OrchestratorCallType, MissionModelConfig } from "../../../shared/types";
import {
  DEFAULT_RECOVERY_LOOP_POLICY,
  DEFAULT_CONTEXT_VIEW_POLICIES,
  DEFAULT_INTEGRATION_PR_POLICY
} from "../../../shared/types";
import { resolveCallTypeModel, modelConfigToServiceModel, thinkingLevelToReasoningEffort, legacyToModelConfig } from "../../../shared/modelProfiles";
import { resolveExecutionPolicy, DEFAULT_EXECUTION_POLICY, buildExecutionPlanPreview } from "./executionPolicy";
import { getModelById, getAvailableModels, type ModelDescriptor } from "../../../shared/modelRegistry";
import { detectAllAuth } from "../ai/authDetector";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createMissionService } from "../missions/missionService";
import type { createOrchestratorService } from "./orchestratorService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createLaneService } from "../lanes/laneService";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createPrService } from "../prs/prService";
import { planMissionOnce, plannerPlanToMissionSteps, MissionPlanningError, cleanupPlanTempFiles } from "../missions/missionPlanningService";
import { analyzeForFanOut, type MetaReasonerRunState } from "./metaReasoner";
import { CoordinatorAgent } from "./coordinatorAgent";
import { routeEventToCoordinator } from "./runtimeEventRouter";

// ── Module imports (extracted from this file) ────────────────────
import type {
  OrchestratorContext,
  CoordinatorSessionEntry,
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
  WorkerDeliverySessionResolution,
  ParallelMissionStepDescriptor,
  ResolvedOrchestratorConfig,
  RuntimeReasoningEffort,
  ResolvedCallTypeConfig,
  Deferred,
  PlannerTurnCompletion,
  PlannerTurnCompletionStatus,
  OrchestratorHookExecutionResult,
  ResolvedOrchestratorHook,
  ResolvedOrchestratorHooks,
  OrchestratorHookEvent,
  AgentChatSessionSummaryEntry,
} from "./orchestratorContext";

// Re-export all types
export type { OrchestratorContext } from "./orchestratorContext";

// Import all constants, helpers, and utility functions from orchestratorContext
import {
  PLAN_REVIEW_INTERVENTION_TITLE,
  STEERING_DIRECTIVES_METADATA_KEY,
  ORCHESTRATOR_CHAT_METADATA_KEY,
  ORCHESTRATOR_CHAT_SESSION_METADATA_KEY,
  MAX_PERSISTED_STEERING_DIRECTIVES,
  MAX_PERSISTED_CHAT_MESSAGES,
  HEALTH_SWEEP_INTERVAL_MS,
  HEALTH_SWEEP_ACTIVE_RUN_SCAN_LIMIT,
  STALE_ATTEMPT_GRACE_MS,
  WORKER_WAITING_INPUT_INTERVENTION_COOLDOWN_MS,
  WORKER_EVENT_HEARTBEAT_INTERVAL_MS,
  MAX_CHAT_CONTEXT_CHARS,
  MAX_CHAT_CONTEXT_MESSAGES,
  MAX_CHAT_LINE_CHARS,
  MAX_LATEST_CHAT_MESSAGE_CHARS,
  SESSION_SIGNAL_RETENTION_MS,
  GRACEFUL_CANCEL_NOTIFY_TIMEOUT_MS,
  GRACEFUL_CANCEL_INTERRUPT_TIMEOUT_MS,
  GRACEFUL_CANCEL_DISPOSE_TIMEOUT_MS,
  GRACEFUL_CANCEL_DRAIN_WAIT_MS,
  GRACEFUL_CANCEL_DRAIN_POLL_MS,
  MAX_STEERING_CONTEXT_DIRECTIVES,
  MAX_STEERING_CONTEXT_CHARS,
  MAX_STEERING_DIRECTIVES_PER_STEP,
  ATTEMPT_RUNTIME_PERSIST_INTERVAL_MS,
  MAX_RUNTIME_SIGNAL_PREVIEW_CHARS,
  DEFAULT_METRIC_TOGGLES,
  KNOWN_METRIC_TOGGLES,
  DEFAULT_CHAT_VISIBILITY,
  DEFAULT_CHAT_DELIVERY,
  DEFAULT_WORKER_CHAT_VISIBILITY,
  DEFAULT_THREAD_STATUS,
  DEFAULT_CHAT_THREAD_TITLE,
  MAX_THREAD_PAGE_SIZE,
  CONTEXT_CHECKPOINT_CHAT_THRESHOLD,
  WORKER_MESSAGE_RETRY_BUDGET,
  WORKER_MESSAGE_RETRY_BACKOFF_BASE_MS,
  WORKER_MESSAGE_RETRY_BACKOFF_MAX_MS,
  WORKER_MESSAGE_RETRY_INTERVENTION_COOLDOWN_MS,
  WORKER_MESSAGE_INFLIGHT_LEASE_MS,
  WORKER_MESSAGE_INFLIGHT_STALE_FAIL_MS,
  ACTIVE_ATTEMPT_STATUSES,
  PLANNER_THREAD_ID_PREFIX,
  PLANNER_THREAD_TITLE,
  PLANNER_THREAD_STEP_KEY,
  PLANNER_STREAM_FLUSH_CHARS,
  PLANNER_STREAM_FLUSH_INTERVAL_MS,
  PLANNER_STREAM_MIN_INTERVAL_FLUSH_CHARS,
  MAX_PLANNER_RAW_OUTPUT_CHARS,
  ORCHESTRATOR_HOOK_DEFAULT_TIMEOUT_MS,
  ORCHESTRATOR_HOOK_MAX_TIMEOUT_MS,
  ORCHESTRATOR_HOOK_MAX_CAPTURE_CHARS,
  ORCHESTRATOR_HOOK_LOG_PREVIEW_CHARS,
  DECISION_TIMEOUT_CAP_MS_BY_HOURS,
  TRANSIENT_ERROR_CLASSES,
  CALL_TYPE_DEFAULTS,
  // Utility functions
  nowIso,
  createDeferred,
  runBestEffortWithTimeout,
  isRecord,
  asBool,
  asString,
  parseSteeringDirective,
  parseChatVisibility,
  classifyFailureTier,
  parseChatDeliveryState,
  parseChatTarget,
  parseThreadType,
  fallbackLegacyChatMessageId,
  parseChatMessage,
  parseChatSessionState,
  normalizeSignalText,
  digestSignalText,
  buildQuestionThreadLink,
  buildQuestionReplyLink,
  parseQuestionLink,
  detectWaitingInputSignal,
  clipTextForContext,
  workerStateFromRuntimeSignal,
  parseTerminalRuntimeState,
  clipHookLogText,
  parseOrchestratorHookConfig,
  readOrchestratorHooksConfig,
  parseJsonRecord,
  parseJsonArray,
  missionThreadId,
  plannerThreadId,
  clampLimit,
  normalizeChatVisibility,
  normalizeChatDeliveryState,
  normalizeThreadType,
  toOptionalString,
  sanitizeChatTarget,
  parseWorkerProviderHint,
  workerThreadIdentity,
  deriveThreadTitle,
  readConfig,
  mapOrchestratorStepStatus,
  deriveMissionStatusFromRun,
  buildOutcomeSummary,
  buildConflictResolutionInstructions,
  normalizeReasoningEffort,
  extractRunFailureMessage,
  inferPrStrategy,
  runOrchestratorHookCommand,
  deriveRuntimeProfileFromPolicy,
  getModelCapabilities,
  getModelCapabilitiesFromRegistry,
} from "./orchestratorContext";

// Re-export public functions that external consumers depend on
export { getModelCapabilities } from "./orchestratorContext";

// Import from coordinator session module
import {
  PM_SYSTEM_PREAMBLE,
} from "./coordinatorSession";

// Import from runtime event router module
import {
  buildRunStateSnapshot,
  pruneSessionRuntimeSignals,
} from "./runtimeEventRouter";

// Import from mission lifecycle module
import {
  deriveScopeFromStepCount,
  inferRoleFromStepMetadata,
  buildParallelDescriptors,
  parseNumericDependencyIndices,
  slugify,
  isParallelCandidateStepType,
  toStepKey,
} from "./missionLifecycle";

// Import from planning pipeline module
import {
  buildInterventionResolverPrompt,
  buildFailureDiagnosisPrompt,
  beginPlannerTurn,
} from "./planningPipeline";

// Quality gate module imports removed — quality evaluation is the coordinator's domain

// Import from chat message module
import {
  emitThreadEvent,
  getMissionMetadata,
  updateMissionMetadata,
  getMissionIdentity,
  getMissionIdForRun,
  getRunMetadata,
  updateRunMetadata,
  loadSteeringDirectivesFromMetadata,
  loadChatMessagesFromMetadata,
  loadChatSessionStateFromMetadata,
  persistChatSessionState,
  formatRecentChatContext,
  buildRecentChatContext,
  formatOrchestratorContent,
  emitOrchestratorMessage,
  parseMentions,
  normalizeDeliveryError,
  isBusyDeliveryError,
  isNoActiveTurnError,
  computeWorkerRetryBackoffMs,
} from "./chatMessageService";

// Import from worker tracking module
import {
  getWorkerStates,
  upsertWorkerState,
  parseWorkerDigestRow,
  listWorkerDigests,
  getWorkerDigest,
  getContextCheckpoint,
  listLaneDecisions,
} from "./workerTracking";

// Import from metrics and usage module
import {
  estimateTokenCost,
  getAggregatedUsage,
  propagateAttemptTokenUsage,
  setMissionMetricsConfig,
} from "./metricsAndUsage";

// Import from recovery service module
import {
  ensureAttemptRuntimeTracker,
  updateAttemptStagnationTracker,
} from "./recoveryService";


function budgetToEffort(budget: number): "low" | "medium" | "high" {
  return budget < 1000 ? "low" : budget < 5000 ? "medium" : "high";
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
  // Deterministic decision lock sets removed


  /** Tracks active integration resolution contexts so we can resume after worker steps complete. Keyed by runId. */
  type PendingIntegrationContext = {
    proposalId: string;
    missionId: string;
    integrationLaneName: string;
    integrationLaneId: string;
    baseBranch: string;
    isDraft: boolean;
    prDepth: PrDepth;
    conflictStepKeys: string[];      // step keys of the conflict resolution workers
    reviewStepKey: string | null;     // step key of the PR review worker (open-and-comment only)
    laneIdArray: string[];
    missionTitle: string;
  };
  const pendingIntegrations = new Map<string, PendingIntegrationContext>();

  let healthSweepTimer: NodeJS.Timeout | null = null;
  let disposed = false;
  /** Debounce timers for event-driven coordinator evaluations, keyed by runId. */
  const pendingCoordinatorEvals = new Map<string, NodeJS.Timeout>();

  /** Purge per-run Map entries when a run reaches terminal status. */
  const purgeRunMaps = (runId: string): void => {
    runTeamManifests.delete(runId);
    runRecoveryLoopStates.delete(runId);
    pendingIntegrations.delete(runId);
    teamRuntimeStates.delete(runId);
    const evalTimer = pendingCoordinatorEvals.get(runId);
    if (evalTimer) {
      clearTimeout(evalTimer);
      pendingCoordinatorEvals.delete(runId);
    }
  };

  // ── V2 Coordinator Agents (tool-based, replaces specialist calls) ──
  const coordinatorAgents = new Map<string, CoordinatorAgent>();
  const coordinatorRecoveryAttempts = new Map<string, number>();
  const DEFAULT_MAX_COORDINATOR_RECOVERIES = 3;

  const getMaxCoordinatorRecoveries = (missionId?: string | null): number => {
    // Check mission-specific metadata first
    if (missionId) {
      try {
        const metadata = getMissionMetadata(missionId);
        const missionMax = (metadata as Record<string, unknown>)?.maxCoordinatorRecoveries;
        if (typeof missionMax === "number" && Number.isFinite(missionMax) && missionMax >= 0) {
          return missionMax;
        }
      } catch { /* fall through */ }
    }
    // Then project config
    try {
      const config = readConfig(projectConfigService);
      const execPolicy = config.defaultExecutionPolicy;
      const policyMax = (execPolicy as Record<string, unknown> | null)?.maxCoordinatorRecoveries;
      if (typeof policyMax === "number" && Number.isFinite(policyMax) && policyMax >= 0) {
        return policyMax;
      }
    } catch { /* use default */ }
    return DEFAULT_MAX_COORDINATOR_RECOVERIES;
  };

  // Team runtime state tracking
  const teamRuntimeStates = new Map<string, OrchestratorTeamRuntimeState>();

  // ── Orchestrator Call Type Resolution ─────────────────────────────
  // Only coordinator-legitimate call types remain. Deterministic per-micro-decision
  // routing has been removed — the coordinator AI handles all tactical decisions.
  // Type and defaults imported from orchestratorContext.

  const callTypeConfigCache = new Map<string, { config: ResolvedCallTypeConfig; expiresAt: number }>();
  const CALL_TYPE_CONFIG_TTL_MS = 30_000;

  const resolveCallTypeConfig = (missionId: string, callType: OrchestratorCallType): ResolvedCallTypeConfig => {
    const cacheKey = `${missionId}:${callType}`;
    const cached = callTypeConfigCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.config;
    const config = resolveCallTypeConfigUncached(missionId, callType);
    callTypeConfigCache.set(cacheKey, { config, expiresAt: Date.now() + CALL_TYPE_CONFIG_TTL_MS });
    return config;
  };

  const resolveCallTypeConfigUncached = (missionId: string, callType: OrchestratorCallType): ResolvedCallTypeConfig => {
    const defaults = CALL_TYPE_DEFAULTS[callType];
    try {
      const row = db.get<{ metadata_json: string | null }>(
        "select metadata_json from missions where id = ? limit 1",
        [missionId]
      );
      if (row?.metadata_json) {
        const metadata = JSON.parse(row.metadata_json);
        const launch = isRecord(metadata.launch) ? metadata.launch : null;

        // Priority 1: Per-call-type intelligence config (most specific)
        const intelligenceConfig = launch && isRecord(launch.intelligenceConfig) ? launch.intelligenceConfig : null;
        if (intelligenceConfig) {
          const callConfig = isRecord(intelligenceConfig[callType]) ? intelligenceConfig[callType] : null;
          if (callConfig) {
            return {
              provider: typeof callConfig.provider === "string" ? callConfig.provider as "claude" | "codex" : defaults.provider,
              model: typeof callConfig.modelId === "string" ? callConfig.modelId : defaults.model,
              reasoningEffort: typeof callConfig.thinkingLevel === "string" ? callConfig.thinkingLevel : defaults.reasoningEffort,
            };
          }
        }

        // Priority 2: Top-level orchestratorModel (applies to all call types)
        const topLevelModel = typeof launch?.orchestratorModel === "string" ? launch.orchestratorModel.trim().toLowerCase() : null;
        if (topLevelModel && (topLevelModel === "opus" || topLevelModel === "sonnet" || topLevelModel === "haiku")) {
          // Also check thinkingBudgets for per-call-type reasoning effort override
          const thinkingBudgets = launch && isRecord(launch.thinkingBudgets) ? launch.thinkingBudgets : null;
          const budgetForCallType = thinkingBudgets && typeof thinkingBudgets[callType] === "number" ? thinkingBudgets[callType] : null;
          const budgetEffort = budgetForCallType != null ? budgetToEffort(budgetForCallType as number) : null;
          return {
            provider: "claude",
            model: topLevelModel,
            reasoningEffort: budgetEffort ?? defaults.reasoningEffort,
          };
        }

        // Also check thinkingBudgets even without explicit model override
        const thinkingBudgets = launch && isRecord(launch.thinkingBudgets) ? launch.thinkingBudgets : null;
        if (thinkingBudgets) {
          const budgetForCallType = typeof thinkingBudgets[callType] === "number" ? thinkingBudgets[callType] : null;
          if (budgetForCallType != null) {
            const budgetEffort = budgetToEffort(budgetForCallType as number);
            return { ...defaults, reasoningEffort: budgetEffort };
          }
        }
      }
    } catch { /* ignore parse errors */ }
    // Priority 3: Built-in defaults per call type
    return defaults;
  };

  const DEFAULT_MISSION_POLICY_FLAGS: MissionPolicyFlags = {
    clarificationMode: "auto_if_uncertain",
    maxClarificationQuestions: 5,
    strictTdd: false,
    requireValidatorPass: true,
    maxParallelWorkers: 4,
    riskApprovalMode: "confirm_high_risk"
  };

  const REQUIRED_TEAM_CAPABILITIES = ["coordinator", "planner", "validator"] as const;

  const DEFAULT_TEAM_TEMPLATE: TeamTemplate = {
    id: "default-autonomy-template",
    name: "Autonomous Team",
    roles: [
      {
        name: "coordinator",
        description: "Mission lead that plans, delegates, and decides recovery strategy.",
        capabilities: ["coordinator", "planner"],
        defaultModel: { provider: "claude", modelId: "anthropic/claude-sonnet-4-6", thinkingLevel: "high" },
        maxInstances: 1,
        toolProfile: {
          allowedTools: [
            "spawn_worker",
            "request_specialist",
            "revise_plan",
            "retry_step",
            "skip_step",
            "read_mission_status",
            "message_worker",
            "read_file",
            "search_files",
            "get_project_context",
            "report_status",
            "report_result",
            "report_validation",
            "update_tool_profiles",
            "transfer_lane"
          ]
        }
      },
      {
        name: "implementer",
        description: "Executes implementation tasks and reports structured progress/results.",
        capabilities: ["implementation"],
        defaultModel: { provider: "codex", modelId: "openai/gpt-5.3-codex", thinkingLevel: "medium" },
        maxInstances: 12
      },
      {
        name: "validator",
        description: "Validates outputs at gates and returns actionable remediation guidance.",
        capabilities: ["validator", "review", "testing"],
        defaultModel: { provider: "claude", modelId: "anthropic/claude-sonnet-4-6", thinkingLevel: "medium" },
        maxInstances: 4
      }
    ],
    policyDefaults: DEFAULT_MISSION_POLICY_FLAGS,
    constraints: {
      maxWorkers: 20,
      requiredRoles: [...REQUIRED_TEAM_CAPABILITIES]
    }
  };

  const toClampedToolProfileMap = (value: unknown): TeamRuntimeConfig["toolProfiles"] => {
    if (!isRecord(value)) return undefined;
    const out: Record<string, { allowedTools: string[]; blockedTools?: string[]; mcpServers?: string[]; notes?: string }> = {};
    for (const [key, raw] of Object.entries(value)) {
      if (!isRecord(raw)) continue;
      const allowedTools = Array.isArray(raw.allowedTools)
        ? raw.allowedTools.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
        : [];
      if (!allowedTools.length) continue;
      const blockedTools = Array.isArray(raw.blockedTools)
        ? raw.blockedTools.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
        : undefined;
      const mcpServers = Array.isArray(raw.mcpServers)
        ? raw.mcpServers.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
        : undefined;
      out[key] = {
        allowedTools,
        ...(blockedTools && blockedTools.length > 0 ? { blockedTools } : {}),
        ...(mcpServers && mcpServers.length > 0 ? { mcpServers } : {}),
        ...(typeof raw.notes === "string" && raw.notes.trim().length > 0 ? { notes: raw.notes.trim() } : {})
      };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const parsePolicyFlags = (value: unknown): MissionPolicyFlags | undefined => {
    if (!isRecord(value)) return undefined;
    const maxQuestions = Number(value.maxClarificationQuestions);
    const maxParallelWorkers = Number(value.maxParallelWorkers);
    return {
      clarificationMode:
        value.clarificationMode === "always" ||
        value.clarificationMode === "auto_if_uncertain" ||
        value.clarificationMode === "off"
          ? value.clarificationMode
          : undefined,
      maxClarificationQuestions: Number.isFinite(maxQuestions) ? Math.max(1, Math.min(20, Math.floor(maxQuestions))) : undefined,
      strictTdd: typeof value.strictTdd === "boolean" ? value.strictTdd : undefined,
      requireValidatorPass: typeof value.requireValidatorPass === "boolean" ? value.requireValidatorPass : undefined,
      maxParallelWorkers: Number.isFinite(maxParallelWorkers) ? Math.max(1, Math.min(32, Math.floor(maxParallelWorkers))) : undefined,
      riskApprovalMode:
        value.riskApprovalMode === "auto" ||
        value.riskApprovalMode === "confirm_high_risk" ||
        value.riskApprovalMode === "confirm_all"
          ? value.riskApprovalMode
          : undefined
    };
  };

  const parseRoleDefinition = (value: unknown): RoleDefinition | null => {
    if (!isRecord(value)) return null;
    const name = typeof value.name === "string" ? value.name.trim() : "";
    if (!name.length) return null;
    const description = typeof value.description === "string" ? value.description.trim() : "";
    const capabilities = Array.isArray(value.capabilities)
      ? value.capabilities.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
      : [];
    const defaultModel = isRecord(value.defaultModel) ? value.defaultModel : null;
    const provider = defaultModel?.provider === "claude" || defaultModel?.provider === "codex" ? defaultModel.provider : null;
    const modelId = typeof defaultModel?.modelId === "string" ? defaultModel.modelId.trim() : "";
    if (!provider || !modelId.length) return null;
    const maxInstancesRaw = Number(value.maxInstances);
    return {
      name,
      description: description.length ? description : `${name} role`,
      capabilities,
      defaultModel: {
        provider,
        modelId,
        ...(defaultModel?.thinkingLevel && typeof defaultModel.thinkingLevel === "string"
          ? { thinkingLevel: defaultModel.thinkingLevel as ModelConfig["thinkingLevel"] }
          : {})
      },
      ...(Number.isFinite(maxInstancesRaw) && maxInstancesRaw > 0
        ? { maxInstances: Math.max(1, Math.min(100, Math.floor(maxInstancesRaw))) }
        : {})
    };
  };

  const parseTeamTemplate = (value: unknown): TeamTemplate | null => {
    if (!isRecord(value)) return null;
    const id = typeof value.id === "string" && value.id.trim().length > 0
      ? value.id.trim()
      : DEFAULT_TEAM_TEMPLATE.id;
    const name = typeof value.name === "string" && value.name.trim().length > 0
      ? value.name.trim()
      : DEFAULT_TEAM_TEMPLATE.name;
    const roles = Array.isArray(value.roles)
      ? value.roles.map((entry) => parseRoleDefinition(entry)).filter((entry): entry is RoleDefinition => !!entry)
      : [];
    const constraints = isRecord(value.constraints) ? value.constraints : null;
    const maxWorkersRaw = Number(constraints?.maxWorkers);
    const requiredRoles = Array.isArray(constraints?.requiredRoles)
      ? constraints.requiredRoles.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
      : [...REQUIRED_TEAM_CAPABILITIES];
    return {
      id,
      name,
      roles: roles.length > 0 ? roles : DEFAULT_TEAM_TEMPLATE.roles,
      policyDefaults: {
        ...DEFAULT_MISSION_POLICY_FLAGS,
        ...(parsePolicyFlags(value.policyDefaults) ?? {})
      },
      constraints: {
        maxWorkers: Number.isFinite(maxWorkersRaw) ? Math.max(1, Math.min(100, Math.floor(maxWorkersRaw))) : DEFAULT_TEAM_TEMPLATE.constraints.maxWorkers,
        requiredRoles
      }
    };
  };

  const missingRequiredCapabilities = (template: TeamTemplate): string[] => {
    const roleNames = new Set(template.roles.map((role) => role.name.toLowerCase()));
    const roleCapabilities = new Set(
      template.roles.flatMap((role) => role.capabilities.map((capability) => capability.toLowerCase()))
    );
    const required = template.constraints.requiredRoles.length
      ? template.constraints.requiredRoles
      : [...REQUIRED_TEAM_CAPABILITIES];
    const missing: string[] = [];
    for (const requiredEntry of required) {
      const normalized = requiredEntry.toLowerCase();
      if (roleNames.has(normalized)) continue;
      if (roleCapabilities.has(normalized)) continue;
      missing.push(requiredEntry);
    }
    return missing;
  };

  /** Resolve team runtime config from mission launch metadata */
  const resolveMissionTeamRuntime = (missionId: string): TeamRuntimeConfig | null => {
    try {
      const row = db.get<{ metadata_json: string | null }>(
        "select metadata_json from missions where id = ? limit 1",
        [missionId]
      );
      if (row?.metadata_json) {
        const metadata = JSON.parse(row.metadata_json);
        const launch = isRecord(metadata.launch) ? metadata.launch : null;
        const teamRuntime = launch && isRecord(launch.teamRuntime) ? launch.teamRuntime : null;
        if (teamRuntime && teamRuntime.enabled === true) {
          const parsedTemplate = parseTeamTemplate(teamRuntime.template);
          const template = parsedTemplate ?? DEFAULT_TEAM_TEMPLATE;
          const missing = missingRequiredCapabilities(template);
          if (missing.length > 0) {
            throw new Error(`teamRuntime template missing required roles/capabilities: ${missing.join(", ")}`);
          }
          const teammateCount = typeof teamRuntime.teammateCount === "number"
            ? Math.max(0, Math.min(20, Math.floor(teamRuntime.teammateCount)))
            : 2;
          const boundedTeammateCount = Math.min(teammateCount, Math.max(0, template.constraints.maxWorkers - 1));
          return {
            enabled: true,
            targetProvider: (teamRuntime.targetProvider === "claude" || teamRuntime.targetProvider === "codex") ? teamRuntime.targetProvider : "auto",
            teammateCount: boundedTeammateCount,
            template,
            toolProfiles: toClampedToolProfileMap(teamRuntime.toolProfiles),
            mcpServerAllowlist: Array.isArray(teamRuntime.mcpServerAllowlist)
              ? (teamRuntime.mcpServerAllowlist as unknown[])
                  .map((entry: unknown) => String(entry ?? "").trim())
                  .filter((entry) => entry.length > 0)
              : undefined,
            policyOverrides: parsePolicyFlags(teamRuntime.policyOverrides)
          };
        }
      }
    } catch (error) {
      logger.warn("ai_orchestrator.team_runtime_config_invalid", {
        missionId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
    return null;
  };

  const normalizeTeamRuntimeConfig = (missionId: string, config: TeamRuntimeConfig): TeamRuntimeConfig => {
    if (!config.enabled) return config;
    const template = parseTeamTemplate(config.template) ?? DEFAULT_TEAM_TEMPLATE;
    const missing = missingRequiredCapabilities(template);
    if (missing.length > 0) {
      throw new Error(`teamRuntime template missing required roles/capabilities: ${missing.join(", ")}`);
    }
    const teammateCount = Math.max(
      0,
      Math.min(
        20,
        Math.min(
          Number.isFinite(Number(config.teammateCount)) ? Math.floor(Number(config.teammateCount)) : 2,
          Math.max(0, template.constraints.maxWorkers - 1)
        )
      )
    );
    const policyOverrides = {
      ...DEFAULT_MISSION_POLICY_FLAGS,
      ...(config.policyOverrides ?? {})
    };
    return {
      ...config,
      targetProvider:
        config.targetProvider === "claude" || config.targetProvider === "codex" || config.targetProvider === "auto"
          ? config.targetProvider
          : "auto",
      teammateCount,
      template,
      policyOverrides
    };
  };

  const emitThreadEvent = (event: Omit<OrchestratorThreadEvent, "at">) => {
    if (disposed) return;
    try {
      onThreadEvent?.({
        ...event,
        at: nowIso()
      });
    } catch (error) {
      logger.debug("ai_orchestrator.thread_event_emit_failed", {
        type: event.type,
        missionId: event.missionId,
        threadId: event.threadId ?? null,
        messageId: event.messageId ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const emitDagMutation = (event: DagMutationEvent) => {
    if (disposed) return;
    try {
      onDagMutation?.(event);
    } catch (error) {
      logger.debug("ai_orchestrator.dag_mutation_emit_failed", {
        runId: event.runId,
        mutationType: event.mutation.type,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const getMissionMetadata = (missionId: string): Record<string, unknown> => {
    const row = db.get<{ metadata_json: string | null }>(
      `select metadata_json from missions where id = ? limit 1`,
      [missionId]
    );
    if (!row?.metadata_json) return {};
    try {
      return JSON.parse(row.metadata_json) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  const updateMissionMetadata = (missionId: string, mutate: (metadata: Record<string, unknown>) => void) => {
    const metadata = getMissionMetadata(missionId);
    mutate(metadata);
    db.run(
      `update missions set metadata_json = ?, updated_at = ? where id = ?`,
      [JSON.stringify(metadata), nowIso(), missionId]
    );
  };

  const getMissionIdentity = (missionId: string): { projectId: string; laneId: string | null } | null => {
    const row = db.get<{ project_id: string; lane_id: string | null }>(
      `select project_id, lane_id from missions where id = ? limit 1`,
      [missionId]
    );
    if (!row?.project_id) return null;
    return {
      projectId: row.project_id,
      laneId: row.lane_id ?? null
    };
  };

  const getMissionIdForRun = (runId: string): string | null => {
    const row = db.get<{ mission_id: string | null }>(
      `select mission_id from orchestrator_runs where id = ? limit 1`,
      [runId]
    );
    return toOptionalString(row?.mission_id);
  };

  const getRunMetadata = (runId: string): Record<string, unknown> => {
    const row = db.get<{ metadata_json: string | null }>(
      `select metadata_json from orchestrator_runs where id = ? limit 1`,
      [runId]
    );
    if (!row?.metadata_json) return {};
    try {
      const parsed = JSON.parse(row.metadata_json);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };

  const updateRunMetadata = (runId: string, mutate: (metadata: Record<string, unknown>) => void): boolean => {
    const row = db.get<{ id: string; metadata_json: string | null }>(
      `select id, metadata_json from orchestrator_runs where id = ? limit 1`,
      [runId]
    );
    if (!row?.id) return false;
    const metadata = (() => {
      if (!row.metadata_json) return {} as Record<string, unknown>;
      try {
        const parsed = JSON.parse(row.metadata_json);
        return isRecord(parsed) ? parsed : {};
      } catch {
        return {} as Record<string, unknown>;
      }
    })();
    mutate(metadata);
    db.run(
      `update orchestrator_runs set metadata_json = ?, updated_at = ? where id = ?`,
      [JSON.stringify(metadata), nowIso(), runId]
    );
    return true;
  };

  const parseThreadRow = (row: {
    id: string;
    mission_id: string;
    thread_type: string;
    title: string;
    run_id: string | null;
    step_id: string | null;
    step_key: string | null;
    attempt_id: string | null;
    session_id: string | null;
    lane_id: string | null;
    status: string;
    unread_count: number | null;
    metadata_json: string | null;
    created_at: string;
    updated_at: string;
  }): OrchestratorChatThread => {
    return {
      id: row.id,
      missionId: row.mission_id,
      threadType: normalizeThreadType(row.thread_type),
      title: String(row.title ?? DEFAULT_CHAT_THREAD_TITLE),
      runId: row.run_id ?? null,
      stepId: row.step_id ?? null,
      stepKey: row.step_key ?? null,
      attemptId: row.attempt_id ?? null,
      sessionId: row.session_id ?? null,
      laneId: row.lane_id ?? null,
      status: row.status === "closed" ? "closed" : "active",
      unreadCount: Number.isFinite(Number(row.unread_count)) ? Math.max(0, Math.floor(Number(row.unread_count))) : 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: parseJsonRecord(row.metadata_json)
    };
  };

  const getThreadById = (missionId: string, threadId: string): OrchestratorChatThread | null => {
    const row = db.get<{
      id: string;
      mission_id: string;
      thread_type: string;
      title: string;
      run_id: string | null;
      step_id: string | null;
      step_key: string | null;
      attempt_id: string | null;
      session_id: string | null;
      lane_id: string | null;
      status: string;
      unread_count: number | null;
      metadata_json: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `
        select
          id,
          mission_id,
          thread_type,
          title,
          run_id,
          step_id,
          step_key,
          attempt_id,
          session_id,
          lane_id,
          status,
          unread_count,
          metadata_json,
          created_at,
          updated_at
        from orchestrator_chat_threads
        where mission_id = ?
          and id = ?
        limit 1
      `,
      [missionId, threadId]
    );
    if (!row) return null;
    return parseThreadRow(row);
  };

  const upsertThread = (args: {
    missionId: string;
    threadId: string;
    threadType: OrchestratorChatThreadType;
    title: string;
    target: OrchestratorChatTarget | null;
    status?: "active" | "closed";
    metadata?: Record<string, unknown> | null;
  }): OrchestratorChatThread => {
    const missionIdentity = getMissionIdentity(args.missionId);
    if (!missionIdentity) {
      throw new Error(`Mission not found: ${args.missionId}`);
    }
    const target = sanitizeChatTarget(args.target);
    const now = nowIso();
    db.run(
      `
        insert into orchestrator_chat_threads(
          id,
          project_id,
          mission_id,
          thread_type,
          title,
          run_id,
          step_id,
          step_key,
          attempt_id,
          session_id,
          lane_id,
          status,
          unread_count,
          metadata_json,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        on conflict(id) do update set
          thread_type = excluded.thread_type,
          title = excluded.title,
          run_id = excluded.run_id,
          step_id = excluded.step_id,
          step_key = excluded.step_key,
          attempt_id = excluded.attempt_id,
          session_id = excluded.session_id,
          lane_id = excluded.lane_id,
          status = excluded.status,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `,
      [
        args.threadId,
        missionIdentity.projectId,
        args.missionId,
        args.threadType,
        args.title,
        (target && "runId" in target ? target.runId : null) ?? null,
        target?.kind === "worker" ? target.stepId ?? null : null,
        target?.kind === "worker" ? target.stepKey ?? null : null,
        target?.kind === "worker" ? target.attemptId ?? null : null,
        target?.kind === "worker" ? target.sessionId ?? null : null,
        target?.kind === "worker" ? target.laneId ?? missionIdentity.laneId : missionIdentity.laneId,
        args.status ?? DEFAULT_THREAD_STATUS,
        args.metadata ? JSON.stringify(args.metadata) : null,
        now,
        now
      ]
    );
    const nextThread = getThreadById(args.missionId, args.threadId) ?? {
      id: args.threadId,
      missionId: args.missionId,
      threadType: args.threadType,
      title: args.title,
      runId: target?.runId ?? null,
      stepId: target?.kind === "worker" ? target.stepId ?? null : null,
      stepKey: target?.kind === "worker" ? target.stepKey ?? null : null,
      attemptId: target?.kind === "worker" ? target.attemptId ?? null : null,
      sessionId: target?.kind === "worker" ? target.sessionId ?? null : null,
      laneId: target?.kind === "worker" ? target.laneId ?? missionIdentity.laneId : missionIdentity.laneId,
      status: args.status ?? "active",
      unreadCount: 0,
      createdAt: now,
      updatedAt: now,
      metadata: args.metadata ?? null
    };
    emitThreadEvent({
      type: "thread_updated",
      missionId: args.missionId,
      threadId: nextThread.id,
      runId: nextThread.runId ?? null,
      reason: "upsert_thread"
    });
    return nextThread;
  };

  const ensureMissionThread = (missionId: string): OrchestratorChatThread => {
    const id = missionThreadId(missionId);
    const existing = getThreadById(missionId, id);
    if (existing) return existing;
    return upsertThread({
      missionId,
      threadId: id,
      threadType: "coordinator",
      title: DEFAULT_CHAT_THREAD_TITLE,
      target: {
        kind: "coordinator",
        runId: null
      }
    });
  };

  const ensureThreadForTarget = (args: {
    missionId: string;
    threadId?: string | null;
    target?: OrchestratorChatTarget | null;
    fallbackTitle?: string | null;
  }): OrchestratorChatThread => {
    const missionId = args.missionId;
    const requestedThreadId = toOptionalString(args.threadId);
    if (requestedThreadId) {
      const existing = getThreadById(missionId, requestedThreadId);
      if (existing) return existing;
      const target = sanitizeChatTarget(args.target);
      const threadType: OrchestratorChatThreadType = target?.kind === "worker" ? "worker" : "coordinator";
      return upsertThread({
        missionId,
        threadId: requestedThreadId,
        threadType,
        title: deriveThreadTitle({
          target,
          step: null,
          lane: null,
          fallback: args.fallbackTitle ?? undefined
        }),
        target
      });
    }

    const target = sanitizeChatTarget(args.target);
    if (!target || target.kind === "coordinator" || target.kind === "workers") {
      return ensureMissionThread(missionId);
    }
    const identity = workerThreadIdentity(target);
    const fallbackId = `worker:${missionId}:${identity ?? randomUUID()}`;
    const existing = getThreadById(missionId, fallbackId);
    if (existing) return existing;
    return upsertThread({
      missionId,
      threadId: fallbackId,
      threadType: "worker",
      title: deriveThreadTitle({
        target,
        step: null,
        lane: null,
        fallback: args.fallbackTitle ?? undefined
      }),
      target
    });
  };

  const loadSteeringDirectivesFromMetadata = (missionId: string): UserSteeringDirective[] => {
    if (activeSteeringDirectives.has(missionId)) {
      return activeSteeringDirectives.get(missionId) ?? [];
    }
    const metadata = getMissionMetadata(missionId);
    const stored = Array.isArray(metadata[STEERING_DIRECTIVES_METADATA_KEY])
      ? metadata[STEERING_DIRECTIVES_METADATA_KEY] as unknown[]
      : [];
    const parsed = stored
      .map((entry) => parseSteeringDirective(entry, missionId))
      .filter((entry): entry is UserSteeringDirective => !!entry)
      .slice(-MAX_PERSISTED_STEERING_DIRECTIVES);
    if (parsed.length > 0) {
      activeSteeringDirectives.set(missionId, parsed);
    }
    return parsed;
  };

  const loadChatMessagesFromMetadata = (missionId: string): OrchestratorChatMessage[] => {
    if (chatMessages.has(missionId)) {
      return chatMessages.get(missionId) ?? [];
    }
    const metadata = getMissionMetadata(missionId);
    const stored = Array.isArray(metadata[ORCHESTRATOR_CHAT_METADATA_KEY])
      ? metadata[ORCHESTRATOR_CHAT_METADATA_KEY] as unknown[]
      : [];
    const parsed = stored
      .map((entry, index) => parseChatMessage(entry, missionId, index))
      .filter((entry): entry is OrchestratorChatMessage => !!entry)
      .slice(-MAX_PERSISTED_CHAT_MESSAGES);
    if (parsed.length > 0) {
      chatMessages.set(missionId, parsed);
    }
    return parsed;
  };

  const parseChatMessageRow = (row: {
    id: string;
    mission_id: string;
    role: string;
    content: string;
    timestamp: string;
    step_key: string | null;
    thread_id: string | null;
    target_json: string | null;
    visibility: string | null;
    delivery_state: string | null;
    source_session_id: string | null;
    attempt_id: string | null;
    lane_id: string | null;
    run_id: string | null;
    metadata_json: string | null;
  }): OrchestratorChatMessage | null => {
    const role = row.role === "user" || row.role === "worker" || row.role === "orchestrator" ? row.role : null;
    if (!role) return null;
    return {
      id: row.id,
      missionId: row.mission_id,
      role,
      content: row.content,
      timestamp: row.timestamp,
      stepKey: row.step_key ?? null,
      threadId: row.thread_id ?? null,
      target: parseChatTarget(parseJsonRecord(row.target_json)),
      visibility: normalizeChatVisibility(row.visibility),
      deliveryState: normalizeChatDeliveryState(row.delivery_state),
      sourceSessionId: row.source_session_id ?? null,
      attemptId: row.attempt_id ?? null,
      laneId: row.lane_id ?? null,
      runId: row.run_id ?? null,
      metadata: parseJsonRecord(row.metadata_json)
    };
  };

  const getChatMessageById = (messageId: string): OrchestratorChatMessage | null => {
    const row = db.get<{
      id: string;
      mission_id: string;
      role: string;
      content: string;
      timestamp: string;
      step_key: string | null;
      thread_id: string | null;
      target_json: string | null;
      visibility: string | null;
      delivery_state: string | null;
      source_session_id: string | null;
      attempt_id: string | null;
      lane_id: string | null;
      run_id: string | null;
      metadata_json: string | null;
    }>(
      `
        select
          id,
          mission_id,
          role,
          content,
          timestamp,
          step_key,
          thread_id,
          target_json,
          visibility,
          delivery_state,
          source_session_id,
          attempt_id,
          lane_id,
          run_id,
          metadata_json
        from orchestrator_chat_messages
        where id = ?
        limit 1
      `,
      [messageId]
    );
    return row ? parseChatMessageRow(row) : null;
  };

  const persistUpdatedChatMessage = (next: OrchestratorChatMessage): OrchestratorChatMessage => {
    const normalized: OrchestratorChatMessage = {
      ...next,
      target: sanitizeChatTarget(next.target ?? null),
      visibility: normalizeChatVisibility(next.visibility),
      deliveryState: normalizeChatDeliveryState(next.deliveryState),
      metadata: isRecord(next.metadata) ? next.metadata : null
    };
    db.run(
      `
        update orchestrator_chat_messages
        set
          thread_id = ?,
          step_key = ?,
          target_json = ?,
          visibility = ?,
          delivery_state = ?,
          source_session_id = ?,
          attempt_id = ?,
          lane_id = ?,
          run_id = ?,
          metadata_json = ?
        where id = ?
      `,
      [
        normalized.threadId ?? missionThreadId(normalized.missionId),
        normalized.stepKey ?? null,
        normalized.target ? JSON.stringify(normalized.target) : null,
        normalizeChatVisibility(normalized.visibility),
        normalizeChatDeliveryState(normalized.deliveryState),
        normalized.sourceSessionId ?? null,
        normalized.attemptId ?? null,
        normalized.laneId ?? null,
        normalized.runId ?? null,
        normalized.metadata ? JSON.stringify(normalized.metadata) : null,
        normalized.id
      ]
    );

    const current = chatMessages.get(normalized.missionId);
    if (current?.length) {
      const nextMessages = current.map((entry) => (entry.id === normalized.id ? normalized : entry));
      chatMessages.set(normalized.missionId, nextMessages);
    }

    try {
      updateMissionMetadata(normalized.missionId, (metadata) => {
        const existing = Array.isArray(metadata[ORCHESTRATOR_CHAT_METADATA_KEY])
          ? (metadata[ORCHESTRATOR_CHAT_METADATA_KEY] as unknown[])
          : [];
        metadata[ORCHESTRATOR_CHAT_METADATA_KEY] = existing.map((entry, index) => {
          const parsed = parseChatMessage(entry, normalized.missionId, index);
          return parsed?.id === normalized.id ? normalized : entry;
        });
      });
    } catch (error) {
      logger.debug("ai_orchestrator.chat_metadata_message_update_failed", {
        missionId: normalized.missionId,
        messageId: normalized.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    emitThreadEvent({
      type: "message_updated",
      missionId: normalized.missionId,
      threadId: normalized.threadId ?? missionThreadId(normalized.missionId),
      messageId: normalized.id,
      runId: normalized.runId ?? null,
      reason: "message_update"
    });
    emitThreadEvent({
      type: "thread_updated",
      missionId: normalized.missionId,
      threadId: normalized.threadId ?? missionThreadId(normalized.missionId),
      runId: normalized.runId ?? null,
      reason: "message_update"
    });

    return normalized;
  };

  const updateChatMessage = (
    messageId: string,
    updater: (current: OrchestratorChatMessage) => OrchestratorChatMessage
  ): OrchestratorChatMessage | null => {
    const current = getChatMessageById(messageId);
    if (!current) return null;
    const next = updater(current);
    if (next.id !== current.id || next.missionId !== current.missionId) {
      throw new Error("Chat message identity cannot change during update.");
    }
    return persistUpdatedChatMessage(next);
  };

  const loadChatMessagesFromDb = (args: {
    missionId: string;
    threadId?: string | null;
    limit?: number;
    before?: string | null;
  }): OrchestratorChatMessage[] => {
    const limit = clampLimit(args.limit, MAX_PERSISTED_CHAT_MESSAGES, 500);
    const rows = db.all<{
      id: string;
      mission_id: string;
      role: string;
      content: string;
      timestamp: string;
      step_key: string | null;
      thread_id: string | null;
      target_json: string | null;
      visibility: string | null;
      delivery_state: string | null;
      source_session_id: string | null;
      attempt_id: string | null;
      lane_id: string | null;
      run_id: string | null;
      metadata_json: string | null;
    }>(
      `
        select
          id,
          mission_id,
          role,
          content,
          timestamp,
          step_key,
          thread_id,
          target_json,
          visibility,
          delivery_state,
          source_session_id,
          attempt_id,
          lane_id,
          run_id,
          metadata_json
        from orchestrator_chat_messages
        where mission_id = ?
          and (? is null or thread_id = ?)
          and (? is null or timestamp < ?)
        order by timestamp desc
        limit ?
      `,
      [
        args.missionId,
        args.threadId ?? null,
        args.threadId ?? null,
        args.before ?? null,
        args.before ?? null,
        limit
      ]
    );
    if (!rows.length) return [];
    return rows
      .map((row) => parseChatMessageRow(row))
      .filter((entry): entry is OrchestratorChatMessage => !!entry)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  };

  const loadChatSessionStateFromMetadata = (missionId: string): OrchestratorChatSessionState | null => {
    if (activeChatSessions.has(missionId)) {
      return activeChatSessions.get(missionId) ?? null;
    }
    const metadata = getMissionMetadata(missionId);
    const parsed = parseChatSessionState(metadata[ORCHESTRATOR_CHAT_SESSION_METADATA_KEY]);
    if (parsed) {
      activeChatSessions.set(missionId, parsed);
      return parsed;
    }
    return null;
  };

  const persistChatSessionState = (missionId: string, state: OrchestratorChatSessionState) => {
    activeChatSessions.set(missionId, state);
    try {
      updateMissionMetadata(missionId, (metadata) => {
        metadata[ORCHESTRATOR_CHAT_SESSION_METADATA_KEY] = state;
      });
    } catch (error) {
      logger.debug("ai_orchestrator.chat_session_persist_failed", {
        missionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const appendChatMessage = (message: OrchestratorChatMessage): OrchestratorChatMessage => {
    if (disposed) {
      return {
        ...message,
        target: sanitizeChatTarget(message.target ?? null),
        visibility: normalizeChatVisibility(message.visibility),
        deliveryState: normalizeChatDeliveryState(message.deliveryState),
        metadata: isRecord(message.metadata) ? message.metadata : null
      };
    }
    const thread = ensureThreadForTarget({
      missionId: message.missionId,
      threadId: message.threadId ?? null,
      target: message.target ?? null
    });
    const normalized: OrchestratorChatMessage = {
      ...message,
      threadId: thread.id,
      visibility: normalizeChatVisibility(message.visibility),
      deliveryState: normalizeChatDeliveryState(message.deliveryState),
      target: sanitizeChatTarget(message.target ?? null),
      metadata: isRecord(message.metadata) ? message.metadata : null
    };
    const existing = chatMessages.has(normalized.missionId)
      ? chatMessages.get(normalized.missionId) ?? []
      : loadChatMessagesFromMetadata(normalized.missionId);
    const next = [...existing, normalized].slice(-MAX_PERSISTED_CHAT_MESSAGES);
    chatMessages.set(message.missionId, next);
    try {
      updateMissionMetadata(normalized.missionId, (metadata) => {
        metadata[ORCHESTRATOR_CHAT_METADATA_KEY] = next;
      });
    } catch (error) {
      logger.debug("ai_orchestrator.chat_persist_failed", {
        missionId: normalized.missionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    const missionIdentity = getMissionIdentity(normalized.missionId);
    if (missionIdentity) {
      const createdAt = nowIso();
      db.run(
        `
          insert into orchestrator_chat_messages(
            id,
            project_id,
            mission_id,
            thread_id,
            role,
            content,
            timestamp,
            step_key,
            target_json,
            visibility,
            delivery_state,
            source_session_id,
            attempt_id,
            lane_id,
            run_id,
            metadata_json,
            created_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          normalized.id,
          missionIdentity.projectId,
          normalized.missionId,
          normalized.threadId ?? missionThreadId(normalized.missionId),
          normalized.role,
          normalized.content,
          normalized.timestamp,
          normalized.stepKey ?? null,
          normalized.target ? JSON.stringify(normalized.target) : null,
          normalizeChatVisibility(normalized.visibility),
          normalizeChatDeliveryState(normalized.deliveryState),
          normalized.sourceSessionId ?? null,
          normalized.attemptId ?? null,
          normalized.laneId ?? null,
          normalized.runId ?? null,
          normalized.metadata ? JSON.stringify(normalized.metadata) : null,
          createdAt
        ]
      );
      const unreadIncrement = normalized.role === "user" ? 0 : 1;
      db.run(
        `
          update orchestrator_chat_threads
          set updated_at = ?,
              unread_count = case when ? > 0 then unread_count + ? else unread_count end
          where id = ?
        `,
        [normalized.timestamp, unreadIncrement, unreadIncrement, normalized.threadId ?? missionThreadId(normalized.missionId)]
      );
    }
    emitThreadEvent({
      type: "message_appended",
      missionId: normalized.missionId,
      threadId: normalized.threadId ?? missionThreadId(normalized.missionId),
      messageId: normalized.id,
      runId: normalized.runId ?? null,
      reason: "append_message",
      metadata: {
        role: normalized.role,
        deliveryState: normalized.deliveryState ?? null
      }
    });
    emitThreadEvent({
      type: "thread_updated",
      missionId: normalized.missionId,
      threadId: normalized.threadId ?? missionThreadId(normalized.missionId),
      runId: normalized.runId ?? null,
      reason: "append_message"
    });
    return normalized;
  };

  /** Format orchestrator messages for the activity feed — keep them concise and prefixed */
  const formatOrchestratorContent = (
    content: string,
    stepKey?: string | null,
    metadata?: Record<string, unknown> | null
  ): string => {
    // Coordinator messages pass through as-is (they're already concise if prompted correctly)
    if (metadata?.role === "coordinator") return content;

    let formatted = content;

    // Strip raw JSON blocks
    formatted = formatted.replace(/```json[\s\S]*?```/g, "[json data]");
    // Strip code blocks
    formatted = formatted.replace(/```[\s\S]*?```/g, "[code block]");
    // Strip raw file contents (unified diff format)
    formatted = formatted.replace(/^[-+]{3}\s.*$/gm, "").replace(/^@@.*@@.*$/gm, "");
    // Collapse multiple newlines
    formatted = formatted.replace(/\n{3,}/g, "\n\n").trim();

    // Truncate if still too long
    if (formatted.length > 200) {
      formatted = `${formatted.slice(0, 197).trimEnd()}...`;
    }

    // Prefix with step key for identification
    if (stepKey) {
      formatted = `[${stepKey}] ${formatted}`;
    }

    return formatted;
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
        enableCompaction: true,
        userRules: opts?.userRules,
        projectContext: opts?.projectContext,
        availableProviders: opts?.availableProviders,
        phases: opts?.phases,
      });

      coordinatorAgents.set(runId, agent);

      // Inject the mission prompt — the coordinator takes it from here
      agent.injectMessage(
        `You have been activated. Your mission:\n\n${missionGoal}\n\nYou have full authority. Read the mission, think about the approach, create tasks, spawn workers, and complete the mission. Start now.`,
      );

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
      const coordinatorModelConfig = resolveOrchestratorModelConfig(missionId, "coordinator");
      const { userRules, projectCtx, availableProviders, phases } = gatherCoordinatorContext(missionId, { missionId });

      // Restart coordinator
      const newAgent = startCoordinatorAgentV2(missionId, runId, missionGoal, coordinatorModelConfig, {
        userRules,
        projectContext: projectCtx,
        availableProviders,
        phases,
      });

      if (!newAgent) return null;

      coordinatorRecoveryAttempts.set(runId, attempts + 1);

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
The previous coordinator crashed (recovery attempt ${attempts + 1} of ${maxRecoveries}). Here is the current state:

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
        recoveryAttempt: attempts + 1,
      });

      emitOrchestratorMessage(
        missionId,
        `Coordinator recovered (attempt ${attempts + 1}/${maxRecoveries}). Resuming mission control.`,
        null,
        { role: "coordinator_v2", runId },
      );

      return newAgent;
    } catch (error) {
      logger.warn("ai_orchestrator.coordinator_recovery_failed", {
        runId,
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
    const formattedContent = formatOrchestratorContent(content, stepKey, metadata);
    const msg: OrchestratorChatMessage = {
      id: randomUUID(),
      missionId,
      role: "orchestrator",
      content: formattedContent,
      timestamp: new Date().toISOString(),
      stepKey: stepKey ?? null,
      metadata: metadata ? { ...metadata, rawContent: content !== formattedContent ? content : undefined } : null
    };
    return appendChatMessage(msg);
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

  const beginPlannerTurn = (state: PlannerAgentSessionState): Deferred<PlannerTurnCompletion> => {
    if (state.turn && !state.turn.settled) {
      state.turn.resolve({
        status: "interrupted",
        rawOutput: state.rawOutput,
        error: "Planner turn was interrupted by a newer turn."
      });
    }
    state.rawOutput = "";
    state.rawOutputTruncated = false;
    state.streamBuffer = "";
    state.lastStreamFlushAtMs = 0;
    state.activeTurnId = null;
    const turn = createDeferred<PlannerTurnCompletion>();
    state.turn = turn;
    return turn;
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

  const resolvePlannerLaneId = async (mission: MissionDetail): Promise<string> => {
    const missionLaneId = toOptionalString(mission.laneId);
    if (missionLaneId) return missionLaneId;
    if (!laneService || typeof laneService.list !== "function") {
      throw new Error("Mission planning lane could not be resolved.");
    }
    const lanes = await laneService.list({ includeArchived: false });
    const preferred = lanes.find((lane) => lane.laneType === "primary") ?? lanes[0] ?? null;
    const laneId = preferred && typeof preferred.id === "string" ? preferred.id.trim() : "";
    if (!laneId.length) {
      throw new Error("Mission planning lane could not be resolved.");
    }
    return laneId;
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

  const dispatchOrchestratorHook = (hookArgs: {
    event: OrchestratorHookEvent;
    runId: string;
    stepId?: string | null;
    attemptId?: string | null;
    sessionId?: string | null;
    reason: string;
    triggerSource: string;
    eventAt?: string | null;
    metadata?: Record<string, unknown> | null;
  }): void => {
    const config = readConfig(projectConfigService);
    const hook = config.hooks[hookArgs.event];
    if (!hook?.command) return;
    const missionId = getMissionIdForRun(hookArgs.runId);
    const commandPreview = clipHookLogText(hook.command);
    const commandDigest = createHash("sha256").update(hook.command).digest("hex").slice(0, 16);
    const occurredAt = hookArgs.eventAt && hookArgs.eventAt.trim().length > 0 ? hookArgs.eventAt : nowIso();
    const runtimeEventBase = {
      source: "orchestrator_hook",
      hookEvent: hookArgs.event,
      missionId,
      reason: hookArgs.reason,
      triggerSource: hookArgs.triggerSource,
      commandDigest,
      commandPreview,
      timeoutMs: hook.timeoutMs
    };
    recordRuntimeEvent({
      runId: hookArgs.runId,
      stepId: hookArgs.stepId ?? null,
      attemptId: hookArgs.attemptId ?? null,
      sessionId: hookArgs.sessionId ?? null,
      eventType: "progress",
      eventKey: `hook_dispatch:${hookArgs.event}:${hookArgs.attemptId ?? hookArgs.stepId ?? "none"}:${Date.now()}`,
      occurredAt,
      payload: {
        ...runtimeEventBase,
        phase: "started",
        ...(hookArgs.metadata ?? {})
      }
    });
    logger.info("ai_orchestrator.hook_dispatch_started", {
      runId: hookArgs.runId,
      stepId: hookArgs.stepId ?? null,
      attemptId: hookArgs.attemptId ?? null,
      sessionId: hookArgs.sessionId ?? null,
      ...runtimeEventBase
    });

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") env[key] = value;
    }
    env.ADE_HOOK_EVENT = hookArgs.event;
    env.ADE_HOOK_RUN_ID = hookArgs.runId;
    env.ADE_HOOK_STEP_ID = hookArgs.stepId ?? "";
    env.ADE_HOOK_ATTEMPT_ID = hookArgs.attemptId ?? "";
    env.ADE_HOOK_SESSION_ID = hookArgs.sessionId ?? "";
    env.ADE_HOOK_REASON = hookArgs.reason;
    env.ADE_HOOK_TRIGGER = hookArgs.triggerSource;
    env.ADE_HOOK_MISSION_ID = missionId ?? "";
    env.ADE_HOOK_METADATA_JSON = JSON.stringify({
      event: hookArgs.event,
      runId: hookArgs.runId,
      stepId: hookArgs.stepId ?? null,
      attemptId: hookArgs.attemptId ?? null,
      sessionId: hookArgs.sessionId ?? null,
      missionId,
      reason: hookArgs.reason,
      triggerSource: hookArgs.triggerSource,
      occurredAt,
      ...(hookArgs.metadata ?? {})
    });

    void hookCommandRunner({
      command: hook.command,
      cwd: projectRoot ?? process.cwd(),
      timeoutMs: hook.timeoutMs,
      env
    }).then((result) => {
      const stdoutPreview = clipHookLogText(result.stdout);
      const stderrPreview = clipHookLogText(result.stderr);
      const success = result.spawnError == null && !result.timedOut && result.exitCode === 0;
      const logPayload = {
        runId: hookArgs.runId,
        stepId: hookArgs.stepId ?? null,
        attemptId: hookArgs.attemptId ?? null,
        sessionId: hookArgs.sessionId ?? null,
        ...runtimeEventBase,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdoutPreview,
        stderrPreview,
        spawnError: result.spawnError
      };
      if (success) {
        logger.info("ai_orchestrator.hook_execution_succeeded", logPayload);
      } else {
        logger.warn("ai_orchestrator.hook_execution_failed", logPayload);
      }
      recordRuntimeEvent({
        runId: hookArgs.runId,
        stepId: hookArgs.stepId ?? null,
        attemptId: hookArgs.attemptId ?? null,
        sessionId: hookArgs.sessionId ?? null,
        eventType: "progress",
        eventKey: `hook_result:${hookArgs.event}:${hookArgs.attemptId ?? hookArgs.stepId ?? "none"}:${Date.now()}`,
        payload: {
          ...runtimeEventBase,
          phase: success ? "succeeded" : "failed",
          success,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          stdoutPreview,
          stderrPreview,
          spawnError: result.spawnError,
          ...(hookArgs.metadata ?? {})
        }
      });
    }).catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn("ai_orchestrator.hook_execution_failed", {
        runId: hookArgs.runId,
        stepId: hookArgs.stepId ?? null,
        attemptId: hookArgs.attemptId ?? null,
        sessionId: hookArgs.sessionId ?? null,
        ...runtimeEventBase,
        error: errorMessage
      });
      recordRuntimeEvent({
        runId: hookArgs.runId,
        stepId: hookArgs.stepId ?? null,
        attemptId: hookArgs.attemptId ?? null,
        sessionId: hookArgs.sessionId ?? null,
        eventType: "progress",
        eventKey: `hook_result:${hookArgs.event}:${hookArgs.attemptId ?? hookArgs.stepId ?? "none"}:${Date.now()}`,
        payload: {
          ...runtimeEventBase,
          phase: "failed",
          success: false,
          error: errorMessage,
          ...(hookArgs.metadata ?? {})
        }
      });
    });
  };

  const maybeDispatchTeammateIdleHook = (idleArgs: {
    runId: string;
    stepId: string;
    attemptId: string;
    sessionId?: string | null;
    previousState: OrchestratorWorkerStatus | null;
    nextState: OrchestratorWorkerStatus;
    reason: string;
    triggerSource: "runtime_signal" | "health_sweep";
    runtimeState?: TerminalRuntimeState | null;
    preview?: string | null;
    laneId?: string | null;
  }): void => {
    if (idleArgs.nextState !== "idle" && idleArgs.nextState !== "waiting_input") return;
    if (idleArgs.previousState === idleArgs.nextState) return;
    dispatchOrchestratorHook({
      event: "TeammateIdle",
      runId: idleArgs.runId,
      stepId: idleArgs.stepId,
      attemptId: idleArgs.attemptId,
      sessionId: idleArgs.sessionId ?? null,
      reason: idleArgs.reason,
      triggerSource: idleArgs.triggerSource,
      metadata: {
        previousState: idleArgs.previousState,
        nextState: idleArgs.nextState,
        runtimeState: idleArgs.runtimeState ?? null,
        laneId: idleArgs.laneId ?? null,
        preview: clipHookLogText(idleArgs.preview)
      }
    });
  };

  const resolveActivePolicy = (missionId: string): MissionExecutionPolicy => {
    const metadata = getMissionMetadata(missionId);
    const config = readConfig(projectConfigService);

    // 1) Mission metadata explicit policy
    if (isRecord(metadata.executionPolicy)) {
      return resolveExecutionPolicy({
        missionMetadata: metadata.executionPolicy as Partial<MissionExecutionPolicy>
      });
    }

    // 2) Project default execution policy
    if (config.defaultExecutionPolicy) {
      return resolveExecutionPolicy({
        projectConfig: config.defaultExecutionPolicy
      });
    }

    // 3) Built-in default policy
    return DEFAULT_EXECUTION_POLICY;
  };

  const resolveActiveRuntimeProfile = (missionId: string): MissionRuntimeProfile => {
    const config = readConfig(projectConfigService);
    const policy = resolveActivePolicy(missionId);
    return deriveRuntimeProfileFromPolicy(policy, config);
  };

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

  const getWorkerStates = (args: { runId: string }): OrchestratorWorkerState[] => {
    const result: OrchestratorWorkerState[] = [];
    for (const state of workerStates.values()) {
      if (state.runId === args.runId) result.push(state);
    }
    return result;
  };

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
  ) => {
    const now = nowIso();
    const existing = workerStates.get(attemptId);
    if (existing) {
      existing.state = update.state;
      existing.lastHeartbeatAt = now;
      if (update.sessionId !== undefined) existing.sessionId = update.sessionId;
      if (update.outcomeTags) existing.outcomeTags = update.outcomeTags;
      if (update.completedAt !== undefined) existing.completedAt = update.completedAt;
    } else {
      workerStates.set(attemptId, {
        attemptId,
        stepId: update.stepId,
        runId: update.runId,
        sessionId: update.sessionId ?? null,
        executorKind: update.executorKind,
        state: update.state,
        lastHeartbeatAt: now,
        spawnedAt: now,
        completedAt: update.completedAt ?? null,
        outcomeTags: update.outcomeTags ?? []
      });
    }
  };

  const ensureAttemptRuntimeTracker = (attemptId: string): AttemptRuntimeTracker => {
    const existing = attemptRuntimeTrackers.get(attemptId);
    if (existing) return existing;
    const next: AttemptRuntimeTracker = {
      lastPreviewDigest: null,
      digestSinceMs: Date.now(),
      repeatCount: 0,
      lastWaitingInterventionAtMs: 0,
      lastEventHeartbeatAtMs: 0,
      lastWaitingNotifiedAtMs: 0,
      lastQuestionThreadId: null,
      lastQuestionMessageId: null,
      lastPersistedAtMs: 0
    };
    attemptRuntimeTrackers.set(attemptId, next);
    return next;
  };

  const deletePersistedAttemptRuntimeState = (attemptId: string) => {
    try {
      db.run(`delete from orchestrator_attempt_runtime where attempt_id = ?`, [attemptId]);
    } catch (error) {
      logger.debug("ai_orchestrator.runtime_state_delete_failed", {
        attemptId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const persistAttemptRuntimeState = (args: {
    attemptId: string;
    sessionId: string | null;
    runtimeState: TerminalRuntimeState | null;
    lastSignalAt: string | null;
    lastOutputPreview: string | null;
    force?: boolean;
  }) => {
    const attemptId = String(args.attemptId ?? "").trim();
    if (!attemptId.length) return;
    const tracker = ensureAttemptRuntimeTracker(attemptId);
    const nowMs = Date.now();
    if (!args.force && nowMs - tracker.lastPersistedAtMs < ATTEMPT_RUNTIME_PERSIST_INTERVAL_MS) return;
    const updatedAt = nowIso();
    try {
      db.run(
        `
          insert into orchestrator_attempt_runtime(
            attempt_id,
            session_id,
            runtime_state,
            last_signal_at,
            last_output_preview,
            last_preview_digest,
            digest_since_ms,
            repeat_count,
            last_waiting_intervention_at_ms,
            last_event_heartbeat_at_ms,
            last_waiting_notified_at_ms,
            updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(attempt_id) do update set
            session_id = excluded.session_id,
            runtime_state = excluded.runtime_state,
            last_signal_at = excluded.last_signal_at,
            last_output_preview = excluded.last_output_preview,
            last_preview_digest = excluded.last_preview_digest,
            digest_since_ms = excluded.digest_since_ms,
            repeat_count = excluded.repeat_count,
            last_waiting_intervention_at_ms = excluded.last_waiting_intervention_at_ms,
            last_event_heartbeat_at_ms = excluded.last_event_heartbeat_at_ms,
            last_waiting_notified_at_ms = excluded.last_waiting_notified_at_ms,
            updated_at = excluded.updated_at
        `,
        [
          attemptId,
          args.sessionId,
          args.runtimeState,
          args.lastSignalAt,
          args.lastOutputPreview,
          tracker.lastPreviewDigest,
          Math.max(0, Math.floor(tracker.digestSinceMs)),
          Math.max(0, Math.floor(tracker.repeatCount)),
          Math.max(0, Math.floor(tracker.lastWaitingInterventionAtMs)),
          Math.max(0, Math.floor(tracker.lastEventHeartbeatAtMs)),
          Math.max(0, Math.floor(tracker.lastWaitingNotifiedAtMs)),
          updatedAt
        ]
      );
      tracker.lastPersistedAtMs = nowMs;
    } catch (error) {
      logger.debug("ai_orchestrator.runtime_state_persist_failed", {
        attemptId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const hydratePersistedAttemptRuntimeState = () => {
    const nowMs = Date.now();
    try {
      db.run(
        `
          delete from orchestrator_attempt_runtime
          where attempt_id in (
            select r.attempt_id
            from orchestrator_attempt_runtime r
            left join orchestrator_attempts a on a.id = r.attempt_id
            where a.id is null or a.status != 'running'
          )
        `
      );
    } catch (error) {
      logger.debug("ai_orchestrator.runtime_state_prune_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    const rows = db.all<{
      attempt_id: string;
      session_id: string | null;
      runtime_state: string | null;
      last_signal_at: string | null;
      last_output_preview: string | null;
      last_preview_digest: string | null;
      digest_since_ms: number | null;
      repeat_count: number | null;
      last_waiting_intervention_at_ms: number | null;
      last_event_heartbeat_at_ms: number | null;
      last_waiting_notified_at_ms: number | null;
    }>(
      `
        select
          r.attempt_id as attempt_id,
          r.session_id as session_id,
          r.runtime_state as runtime_state,
          r.last_signal_at as last_signal_at,
          r.last_output_preview as last_output_preview,
          r.last_preview_digest as last_preview_digest,
          r.digest_since_ms as digest_since_ms,
          r.repeat_count as repeat_count,
          r.last_waiting_intervention_at_ms as last_waiting_intervention_at_ms,
          r.last_event_heartbeat_at_ms as last_event_heartbeat_at_ms,
          r.last_waiting_notified_at_ms as last_waiting_notified_at_ms
        from orchestrator_attempt_runtime r
        join orchestrator_attempts a on a.id = r.attempt_id
        where a.status = 'running'
      `
    );
    if (!rows.length) return;

    for (const row of rows) {
      const attemptId = String(row.attempt_id ?? "").trim();
      if (!attemptId.length) continue;
      const tracker: AttemptRuntimeTracker = {
        lastPreviewDigest: typeof row.last_preview_digest === "string" ? row.last_preview_digest : null,
        digestSinceMs: Number.isFinite(Number(row.digest_since_ms))
          ? Math.max(0, Math.floor(Number(row.digest_since_ms)))
          : nowMs,
        repeatCount: Number.isFinite(Number(row.repeat_count))
          ? Math.max(0, Math.floor(Number(row.repeat_count)))
          : 0,
        lastWaitingInterventionAtMs: Number.isFinite(Number(row.last_waiting_intervention_at_ms))
          ? Math.max(0, Math.floor(Number(row.last_waiting_intervention_at_ms)))
          : 0,
        lastEventHeartbeatAtMs: Number.isFinite(Number(row.last_event_heartbeat_at_ms))
          ? Math.max(0, Math.floor(Number(row.last_event_heartbeat_at_ms)))
          : 0,
        lastWaitingNotifiedAtMs: Number.isFinite(Number(row.last_waiting_notified_at_ms))
          ? Math.max(0, Math.floor(Number(row.last_waiting_notified_at_ms)))
          : 0,
        lastQuestionThreadId: null,
        lastQuestionMessageId: null,
        lastPersistedAtMs: nowMs
      };
      attemptRuntimeTrackers.set(attemptId, tracker);

      const sessionId = typeof row.session_id === "string" ? row.session_id.trim() : "";
      const runtimeState = parseTerminalRuntimeState(row.runtime_state);
      const at = typeof row.last_signal_at === "string" && row.last_signal_at.trim().length ? row.last_signal_at : nowIso();
      if (!sessionId.length || !runtimeState) continue;
      const existing = sessionRuntimeSignals.get(sessionId);
      if (existing) {
        const existingMs = Date.parse(existing.at);
        const nextMs = Date.parse(at);
        if (Number.isFinite(existingMs) && Number.isFinite(nextMs) && existingMs > nextMs) {
          continue;
        }
      }
      sessionRuntimeSignals.set(sessionId, {
        laneId: "",
        sessionId,
        runtimeState,
        lastOutputPreview:
          typeof row.last_output_preview === "string" && row.last_output_preview.trim().length
            ? row.last_output_preview.trim()
            : null,
        at
      });
    }
  };

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
        laneId: "",
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

  const updateAttemptStagnationTracker = (attemptId: string, preview: string | null): { digest: string | null; stagnantMs: number } => {
    const tracker = ensureAttemptRuntimeTracker(attemptId);
    const now = Date.now();
    const digest = digestSignalText(preview);
    if (!digest) {
      tracker.lastPreviewDigest = null;
      tracker.repeatCount = 0;
      tracker.digestSinceMs = now;
      return { digest: null, stagnantMs: 0 };
    }
    if (tracker.lastPreviewDigest !== digest) {
      tracker.lastPreviewDigest = digest;
      tracker.repeatCount = 1;
      tracker.digestSinceMs = now;
      return { digest, stagnantMs: 0 };
    }
    tracker.repeatCount += 1;
    return { digest, stagnantMs: Math.max(0, now - tracker.digestSinceMs) };
  };

  const resolveAttemptOwnerIdFromRows = (attemptMetadataJson: string | null, runMetadataJson: string | null): string => {
    const attemptMeta = parseJsonRecord(attemptMetadataJson);
    const explicitOwner = typeof attemptMeta?.ownerId === "string" ? attemptMeta.ownerId.trim() : "";
    if (explicitOwner.length > 0) return explicitOwner;
    const runMeta = parseJsonRecord(runMetadataJson);
    const autopilot = runMeta && isRecord(runMeta.autopilot) ? runMeta.autopilot : null;
    const owner = autopilot && typeof autopilot.ownerId === "string" ? autopilot.ownerId.trim() : "";
    if (owner.length > 0) return owner;
    return "orchestrator-autopilot";
  };

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

  const extractOutcomeTags = (attempt: OrchestratorRunGraph["attempts"][number]): string[] => {
    const tags: string[] = [];
    if (attempt.resultEnvelope) {
      const envelope = attempt.resultEnvelope;
      if (envelope.warnings?.length) tags.push("has_warnings", `warnings:${envelope.warnings.length}`);
      if (envelope.outputs && isRecord(envelope.outputs)) {
        const filesModified = Number(envelope.outputs.filesModified ?? envelope.outputs.files_modified);
        if (Number.isFinite(filesModified)) tags.push(`files_modified:${filesModified}`);
        const testsPassed = Number(envelope.outputs.testsPassed ?? envelope.outputs.tests_passed);
        if (Number.isFinite(testsPassed)) tags.push(`tests_passed:${testsPassed}`);
      }
    }
    const durationMs = attempt.completedAt && attempt.startedAt
      ? Date.parse(attempt.completedAt) - Date.parse(attempt.startedAt)
      : null;
    if (durationMs != null && Number.isFinite(durationMs)) {
      const category = durationMs < 10_000 ? "fast" : durationMs < 60_000 ? "normal" : "slow";
      tags.push(`duration_category:${category}`);
    }
    return tags;
  };

  /**
   * Extract artifacts from a completed attempt's result envelope and register them
   * in the artifact registry. Compares produced artifacts against planner-declared
   * artifactHints and logs warnings for any that are missing.
   */
  const extractAndRegisterArtifacts = (args: {
    graph: OrchestratorRunGraph;
    attempt: OrchestratorRunGraph["attempts"][number];
  }): void => {
    try {
      const { graph, attempt } = args;
      const envelope = attempt.resultEnvelope;
      if (!envelope) return;
      const outputs = envelope.outputs;
      if (!outputs || !isRecord(outputs)) return;

      const step = graph.steps.find((s) => s.id === attempt.stepId);
      const stepMeta = step && isRecord(step.metadata) ? step.metadata : {};
      const planStep = isRecord(stepMeta.planStep) ? stepMeta.planStep : null;
      const artifactHints: string[] = Array.isArray(planStep?.artifactHints)
        ? (planStep!.artifactHints as unknown[]).map((h) => String(h ?? "").trim()).filter(Boolean)
        : [];
      const declaredKeySet = new Set(artifactHints);
      const registeredKeys = new Set<string>();

      const register = (artifactKey: string, kind: OrchestratorArtifactKind, value: string, metadata?: Record<string, unknown>) => {
        const isDeclared = declaredKeySet.has(artifactKey);
        orchestratorService.registerArtifact({
          missionId: graph.run.missionId,
          runId: attempt.runId,
          stepId: attempt.stepId,
          attemptId: attempt.id,
          artifactKey,
          kind,
          value,
          metadata: metadata ?? {},
          declared: isDeclared
        });
        registeredKeys.add(artifactKey);
        logger.debug("ai_orchestrator.artifact_registered", {
          runId: attempt.runId,
          stepId: attempt.stepId,
          attemptId: attempt.id,
          artifactKey,
          kind,
          declared: isDeclared
        });
      };

      // Extract file artifacts from filesChanged / filesModified
      const filesChangedRaw = outputs.filesChanged ?? outputs.files_changed ?? outputs.filesModified ?? outputs.files_modified;
      if (Array.isArray(filesChangedRaw) && filesChangedRaw.length > 0) {
        const files = filesChangedRaw.map((f) => String(f ?? "").trim()).filter(Boolean);
        if (files.length > 0) {
          register("files_changed", "file", files.join(", "), { fileCount: files.length, files: files.slice(0, 50) });
        }
      }

      // Extract test report artifacts
      const testsPassed = Number(outputs.testsPassed ?? outputs.tests_passed);
      const testsFailed = Number(outputs.testsFailed ?? outputs.tests_failed);
      const testsSkipped = Number(outputs.testsSkipped ?? outputs.tests_skipped);
      if (Number.isFinite(testsPassed) || Number.isFinite(testsFailed)) {
        const testSummary = typeof outputs.testsSummary === "string"
          ? outputs.testsSummary
          : typeof outputs.tests_summary === "string"
            ? outputs.tests_summary
            : `passed: ${testsPassed || 0}, failed: ${testsFailed || 0}, skipped: ${testsSkipped || 0}`;
        register("test_results", "test_report", testSummary, {
          passed: Number.isFinite(testsPassed) ? testsPassed : 0,
          failed: Number.isFinite(testsFailed) ? testsFailed : 0,
          skipped: Number.isFinite(testsSkipped) ? testsSkipped : 0
        });
      }

      // Extract branch artifact
      const branchName = outputs.branchName ?? outputs.branch_name ?? outputs.branch;
      if (typeof branchName === "string" && branchName.trim().length > 0) {
        register("feature_branch", "branch", branchName.trim());
      }

      // Extract PR artifact
      const prUrl = outputs.prUrl ?? outputs.pr_url ?? outputs.pullRequestUrl ?? outputs.pull_request_url;
      if (typeof prUrl === "string" && prUrl.trim().length > 0) {
        register("implementation_pr", "pr", prUrl.trim());
      }

      // Match remaining output keys against declared artifactHints
      for (const hintKey of artifactHints) {
        if (registeredKeys.has(hintKey)) continue;
        // Check if outputs has a matching key (camelCase or snake_case)
        const value = outputs[hintKey] ?? outputs[hintKey.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
        if (value != null) {
          const strValue = typeof value === "string" ? value : JSON.stringify(value);
          register(hintKey, "custom", strValue, { raw: value });
        }
      }

      // Validate: warn for any declared hints that were not produced
      const missingHints = artifactHints.filter((hint) => !registeredKeys.has(hint));
      if (missingHints.length > 0) {
        logger.info("ai_orchestrator.artifact_hints_missing", {
          runId: attempt.runId,
          stepId: attempt.stepId,
          attemptId: attempt.id,
          stepKey: step?.stepKey ?? null,
          missingHints,
          producedKeys: Array.from(registeredKeys)
        });
        // Record a timeline event for the missing artifacts
        orchestratorService.appendTimelineEvent({
          runId: attempt.runId,
          stepId: attempt.stepId,
          attemptId: attempt.id,
          eventType: "artifact_hints_missing",
          reason: "artifact_validation",
          detail: {
            missingHints,
            producedKeys: Array.from(registeredKeys),
            totalDeclared: artifactHints.length,
            totalProduced: registeredKeys.size
          }
        });
      }
    } catch (error) {
      logger.debug("ai_orchestrator.artifact_extraction_failed", {
        runId: args.attempt.runId,
        stepId: args.attempt.stepId,
        attemptId: args.attempt.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const resolveAttemptOwnerId = (run: OrchestratorRunGraph["run"], attempt: OrchestratorRunGraph["attempts"][number]): string => {
    const attemptMeta = isRecord(attempt.metadata) ? attempt.metadata : {};
    const explicitOwner = typeof attemptMeta.ownerId === "string" ? attemptMeta.ownerId.trim() : "";
    if (explicitOwner.length > 0) return explicitOwner;
    const runMeta = isRecord(run.metadata) ? run.metadata : {};
    const autopilot = isRecord(runMeta.autopilot) ? runMeta.autopilot : null;
    const runOwner = autopilot && typeof autopilot.ownerId === "string" ? autopilot.ownerId.trim() : "";
    if (runOwner.length > 0) return runOwner;
    return "orchestrator-autopilot";
  };

  const resolveStepTimeoutMs = (args: {
    runId: string;
    missionId: string;
    step: OrchestratorRunGraph["steps"][number];
  }): number => {
    const stepMeta = isRecord(args.step.metadata) ? args.step.metadata : {};
    const planStep = isRecord(stepMeta.planStep) ? stepMeta.planStep : null;
    const aiStepTimeout = Number(stepMeta.aiTimeoutMs ?? stepMeta.ai_timeout_ms);
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

  const stepTitleForMessage = (step: OrchestratorRunGraph["steps"][number]): string => {
    const raw = String(step.title ?? "").trim();
    if (raw.length > 0) return raw;
    return step.stepKey || step.id.slice(0, 8);
  };

  const isRetryQueuedForStep = (step: OrchestratorRunGraph["steps"][number] | undefined): boolean => {
    if (!step) return false;
    return step.status === "pending" || step.status === "ready" || step.status === "running";
  };

  const getTrackedSessionState = (sessionId: string): {
    laneId: string | null;
    status: string;
    endedAt: string | null;
    exitCode: number | null;
    lastOutputAt: string | null;
    lastOutputPreview: string | null;
    transcriptPath: string | null;
  } | null => {
    const row = db.get<{
      lane_id: string | null;
      status: string | null;
      ended_at: string | null;
      exit_code: number | null;
      last_output_at: string | null;
      last_output_preview: string | null;
      transcript_path: string | null;
    }>(
      `
        select lane_id, status, ended_at, exit_code, last_output_at, last_output_preview, transcript_path
        from terminal_sessions
        where id = ?
        limit 1
      `,
      [sessionId]
    );
    if (!row) return null;
    return {
      laneId: row.lane_id ?? null,
      status: String(row.status ?? "").trim().toLowerCase(),
      endedAt: typeof row.ended_at === "string" ? row.ended_at : null,
      exitCode: Number.isFinite(Number(row.exit_code)) ? Number(row.exit_code) : null,
      lastOutputAt: typeof row.last_output_at === "string" ? row.last_output_at : null,
      lastOutputPreview: typeof row.last_output_preview === "string" ? row.last_output_preview : null,
      transcriptPath: typeof row.transcript_path === "string" ? row.transcript_path : null
    };
  };

  const pruneSessionRuntimeSignals = () => {
    const now = Date.now();
    for (const [sessionId, signal] of sessionRuntimeSignals.entries()) {
      const atMs = Date.parse(signal.at);
      if (!Number.isFinite(atMs) || now - atMs > SESSION_SIGNAL_RETENTION_MS) {
        sessionRuntimeSignals.delete(sessionId);
      }
    }
  };

  const listRunningAttemptsForSession = (sessionId: string): Array<{
    attemptId: string;
    runId: string;
    stepId: string;
    executorKind: OrchestratorExecutorKind;
    attemptMetadataJson: string | null;
    runMetadataJson: string | null;
  }> => {
    const rows = db.all<{
      attempt_id: string;
      run_id: string;
      step_id: string;
      executor_kind: string | null;
      attempt_metadata_json: string | null;
      run_metadata_json: string | null;
    }>(
      `
        select
          a.id as attempt_id,
          a.run_id as run_id,
          a.step_id as step_id,
          a.executor_kind as executor_kind,
          a.metadata_json as attempt_metadata_json,
          r.metadata_json as run_metadata_json
        from orchestrator_attempts a
        join orchestrator_runs r on r.id = a.run_id
        where a.status = 'running'
          and a.executor_session_id = ?
        order by a.created_at asc
      `,
      [sessionId]
    );
    return rows
      .map((row) => {
        const executorKindRaw = String(row.executor_kind ?? "").trim();
        const executorKind: OrchestratorExecutorKind =
          executorKindRaw === "claude" || executorKindRaw === "codex" || executorKindRaw === "shell" || executorKindRaw === "manual"
            ? executorKindRaw
            : "manual";
        return {
          attemptId: row.attempt_id,
          runId: row.run_id,
          stepId: row.step_id,
          executorKind,
          attemptMetadataJson: row.attempt_metadata_json ?? null,
          runMetadataJson: row.run_metadata_json ?? null
        };
      })
      .filter((row) => row.attemptId.length > 0 && row.runId.length > 0 && row.stepId.length > 0);
  };

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
          await orchestratorService.startReadyAutopilotAttempts({
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

  const buildWorkerDigestFromAttempt = (args: {
    graph: OrchestratorRunGraph;
    attempt: OrchestratorRunGraph["attempts"][number];
  }): OrchestratorWorkerDigest => {
    const step = args.graph.steps.find((entry) => entry.id === args.attempt.stepId);
    const envelope = args.attempt.resultEnvelope;
    const outputs = envelope?.outputs ?? null;
    const filesChangedRaw = outputs?.filesChanged ?? outputs?.files_changed ?? [];
    const filesChanged = Array.isArray(filesChangedRaw)
      ? filesChangedRaw.map((entry) => String(entry ?? "").trim()).filter(Boolean)
      : [];
    const testsRun = {
      passed: Math.max(0, Math.floor(Number(outputs?.testsPassed ?? outputs?.tests_passed) || 0)),
      failed: Math.max(0, Math.floor(Number(outputs?.testsFailed ?? outputs?.tests_failed) || 0)),
      skipped: Math.max(0, Math.floor(Number(outputs?.testsSkipped ?? outputs?.tests_skipped) || 0)),
      summary: typeof outputs?.testsSummary === "string"
        ? outputs.testsSummary
        : typeof outputs?.tests_summary === "string"
          ? outputs.tests_summary
          : null
    };
    const tokensInput = Number(outputs?.inputTokens ?? outputs?.input_tokens ?? outputs?.tokensInput ?? outputs?.tokens_input);
    const tokensOutput = Number(outputs?.outputTokens ?? outputs?.output_tokens ?? outputs?.tokensOutput ?? outputs?.tokens_output);
    const tokensTotal = Number(outputs?.totalTokens ?? outputs?.total_tokens ?? outputs?.tokensTotal ?? outputs?.tokens_total);
    const tokens =
      Number.isFinite(tokensInput) || Number.isFinite(tokensOutput) || Number.isFinite(tokensTotal)
        ? {
            input: Number.isFinite(tokensInput) ? Math.max(0, Math.floor(tokensInput)) : undefined,
            output: Number.isFinite(tokensOutput) ? Math.max(0, Math.floor(tokensOutput)) : undefined,
            total: Number.isFinite(tokensTotal) ? Math.max(0, Math.floor(tokensTotal)) : undefined
          }
        : null;
    const costUsdRaw = Number(outputs?.costUsd ?? outputs?.cost_usd ?? outputs?.usdCost ?? outputs?.usd_cost);
    const costUsd = Number.isFinite(costUsdRaw) ? costUsdRaw : null;
    const status =
      args.attempt.status === "running"
      || args.attempt.status === "succeeded"
      || args.attempt.status === "failed"
      || args.attempt.status === "blocked"
      || args.attempt.status === "queued"
        ? args.attempt.status
        : "queued";
    const summary =
      typeof envelope?.summary === "string" && envelope.summary.trim().length
        ? envelope.summary.trim()
        : args.attempt.status === "running"
          ? `Worker started on ${step ? stepTitleForMessage(step) : args.attempt.stepId}.`
          : args.attempt.errorMessage ?? `Step ${step?.stepKey ?? args.attempt.stepId} finished with status ${args.attempt.status}.`;
    const warnings = Array.isArray(envelope?.warnings)
      ? envelope.warnings.map((entry) => String(entry ?? "").trim()).filter(Boolean)
      : [];
    return {
      id: randomUUID(),
      missionId: args.graph.run.missionId,
      runId: args.attempt.runId,
      stepId: args.attempt.stepId,
      stepKey: step?.stepKey ?? null,
      attemptId: args.attempt.id,
      laneId: step?.laneId ?? null,
      sessionId: args.attempt.executorSessionId ?? null,
      status,
      summary,
      filesChanged,
      testsRun,
      warnings,
      tokens,
      costUsd,
      suggestedNextActions:
        args.attempt.status === "failed"
          ? ["Investigate failure", "Review logs", "Retry with guidance"]
          : args.attempt.status === "running"
            ? ["Monitor progress"]
            : [],
      createdAt: nowIso()
    };
  };

  const updateWorkerStateFromEvent = (event: OrchestratorRuntimeEvent) => {
    if (event.type !== "orchestrator-attempt-updated" || !event.attemptId || !event.runId) return;

    try {
      const graph = orchestratorService.getRunGraph({ runId: event.runId, timelineLimit: 0 });
      const attempt = graph.attempts.find((a) => a.id === event.attemptId);
      if (!attempt) return;

      const stepForAttempt = graph.steps.find((s) => s.id === attempt.stepId);
      const stepTitle = stepForAttempt?.title ?? stepForAttempt?.stepKey ?? attempt.stepId.slice(0, 8);
      const stepKey = stepForAttempt?.stepKey ?? null;

      if (attempt.status === "running") {
        const existing = workerStates.get(attempt.id);
        const shouldAnnounceStart = !existing || existing.state !== "working";
        upsertWorkerState(attempt.id, {
          stepId: attempt.stepId,
          runId: attempt.runId,
          sessionId: attempt.executorSessionId,
          executorKind: attempt.executorKind,
          state: "working"
        });
        if (shouldAnnounceStart) {
          emitOrchestratorMessage(
            graph.run.missionId,
            `Worker started on step "${stepTitle}" using ${attempt.executorKind}.`,
            stepKey
          );
          emitWorkerDigest(buildWorkerDigestFromAttempt({ graph, attempt }));

          try {
            ensureThreadForTarget({
              missionId: graph.run.missionId,
              target: {
                kind: "worker",
                runId: attempt.runId,
                stepId: attempt.stepId,
                stepKey: stepKey,
                attemptId: attempt.id,
                sessionId: attempt.executorSessionId ?? null,
                laneId: stepForAttempt?.laneId ?? null,
              },
              fallbackTitle: `Worker: ${stepTitle}`,
            });
          } catch (_threadErr) {
            /* best-effort */
          }
        }
        recordMissionMetricSample({
          missionId: graph.run.missionId,
          runId: attempt.runId,
          attemptId: attempt.id,
          metric: "implementation",
          value: 1,
          unit: "attempt",
          metadata: {
            status: attempt.status,
            executorKind: attempt.executorKind
          }
        });
      } else if (attempt.status === "succeeded") {
        attemptRuntimeTrackers.delete(attempt.id);
        deletePersistedAttemptRuntimeState(attempt.id);
        const outcomeTags = extractOutcomeTags(attempt);
        const digest = emitWorkerDigest(buildWorkerDigestFromAttempt({ graph, attempt }));
        upsertWorkerState(attempt.id, {
          stepId: attempt.stepId,
          runId: attempt.runId,
          sessionId: attempt.executorSessionId,
          executorKind: attempt.executorKind,
          state: "completed",
          outcomeTags,
          completedAt: attempt.completedAt ?? nowIso()
        });
        const resultSummary = attempt.resultEnvelope?.summary
          ? ` — ${attempt.resultEnvelope.summary.slice(0, 120)}`
          : "";
        emitOrchestratorMessage(
          graph.run.missionId,
          `Step "${stepTitle}" completed${resultSummary}`,
          stepKey
        );
        if (digest.tokens?.total != null) {
          recordMissionMetricSample({
            missionId: graph.run.missionId,
            runId: attempt.runId,
            attemptId: attempt.id,
            metric: "tokens",
            value: digest.tokens.total,
            unit: "tokens"
          });
        }
        if (digest.costUsd != null) {
          recordMissionMetricSample({
            missionId: graph.run.missionId,
            runId: attempt.runId,
            attemptId: attempt.id,
            metric: "cost",
            value: digest.costUsd,
            unit: "usd"
          });
        }

        // Extract and register artifacts from the worker result envelope.
        extractAndRegisterArtifacts({ graph, attempt });

        // Evaluation loop: evaluate step based on active runtime profile.
        const step = graph.steps.find((s) => s.id === attempt.stepId);
        if (step && aiIntegrationService) {
          const runtimeProfile = runRuntimeProfiles.get(attempt.runId) ?? resolveActiveRuntimeProfile(graph.run.missionId);
          const isFinalStep = graph.steps.every(
            (s) => s.id === step.id || s.status === "succeeded" || s.status === "failed" || s.status === "skipped"
          );
          const stepMeta = isRecord(step.metadata) ? step.metadata : {};
          const completionCriteria = typeof stepMeta.completionCriteria === "string" ? stepMeta.completionCriteria : "";
          const hasCriteria = completionCriteria.length > 0 && completionCriteria !== "step_done";

          const coordForEval = coordinatorAgents.get(attempt.runId);
          if (!coordForEval?.isAlive && hasCriteria && (runtimeProfile.evaluation.evaluateEveryStep || isFinalStep)) {
            evaluateWorkerPlan({
              attemptId: attempt.id,
              workerPlan: {
                stepKey: step.stepKey,
                status: step.status,
                outcomeTags,
                completionCriteria,
                resultSummary: attempt.resultEnvelope?.summary ?? null
              },
              provider: attempt.executorKind === "codex" ? "codex" : "claude"
            }).then((evalResult) => {
              emitOrchestratorMessage(
                graph.run.missionId,
                evalResult.approved
                  ? `Step "${stepTitleForMessage(step)}" passed evaluation. ${evalResult.feedback}`
                  : `Step "${stepTitleForMessage(step)}" failed evaluation: ${evalResult.feedback}.`,
                step.stepKey
              );
              if (!evalResult.approved) {
                logger.info("ai_orchestrator.step_evaluation_rejected", {
                  runId: attempt.runId,
                  stepId: step.id,
                  feedback: evalResult.feedback
                });
              }
            }).catch((error) => {
              logger.debug("ai_orchestrator.step_evaluation_failed", {
                runId: attempt.runId,
                stepId: step.id,
                error: error instanceof Error ? error.message : String(error)
              });
            });
          }
        }

        // Propagate structured handoff context to downstream steps
        propagateHandoffContext({
          runId: attempt.runId,
          completedStepId: attempt.stepId,
          digest
        });

        // Transition handling is AI-driven via runtime attempt_completed events.
      } else if (attempt.status === "failed") {
        attemptRuntimeTrackers.delete(attempt.id);
        deletePersistedAttemptRuntimeState(attempt.id);
        const outcomeTags = extractOutcomeTags(attempt);
        const digest = emitWorkerDigest(buildWorkerDigestFromAttempt({ graph, attempt }));
        upsertWorkerState(attempt.id, {
          stepId: attempt.stepId,
          runId: attempt.runId,
          sessionId: attempt.executorSessionId,
          executorKind: attempt.executorKind,
          state: "failed",
          outcomeTags,
          completedAt: attempt.completedAt ?? nowIso()
        });

        // Check for retry exhaustion → create real intervention then trigger AI
        const step = graph.steps.find((s) => s.id === attempt.stepId);
        const retryQueued = isRetryQueuedForStep(step);
        const retriesLeft = step ? Math.max(0, step.retryLimit - step.retryCount) : 0;
        emitOrchestratorMessage(
          graph.run.missionId,
          `Step "${stepTitle}" failed: ${attempt.errorMessage ?? "unknown error"}. ${
            retryQueued
              ? `Retry scheduled${retriesLeft > 0 ? ` (${retriesLeft} retries left).` : "."}`
              : "No retries remaining."
          }`,
          stepKey
        );
        recordMissionMetricSample({
          missionId: graph.run.missionId,
          runId: attempt.runId,
          attemptId: attempt.id,
          metric: "retries",
          value: step?.retryCount ?? 0,
          unit: "count",
          metadata: {
            retryLimit: step?.retryLimit ?? null
          }
        });
        if (digest.tokens?.total != null) {
          recordMissionMetricSample({
            missionId: graph.run.missionId,
            runId: attempt.runId,
            attemptId: attempt.id,
            metric: "tokens",
            value: digest.tokens.total,
            unit: "tokens"
          });
        }
        if (digest.costUsd != null) {
          recordMissionMetricSample({
            missionId: graph.run.missionId,
            runId: attempt.runId,
            attemptId: attempt.id,
            metric: "cost",
            value: digest.costUsd,
            unit: "usd"
          });
        }
        if (step && step.status === "failed" && step.retryCount >= step.retryLimit) {
          try {
            // Emit retry_exhausted event
            recordRuntimeEvent({
              runId: attempt.runId,
              stepId: step.id,
              attemptId: attempt.id,
              sessionId: attempt.executorSessionId,
              eventType: "retry_exhausted",
              eventKey: `retry_exhausted:${step.id}`,
              payload: {
                retryCount: step.retryCount,
                retryLimit: step.retryLimit,
                lastError: attempt.errorMessage ?? "unknown"
              }
            });
            const intervention = missionService.addIntervention({
              missionId: graph.run.missionId,
              interventionType: "failed_step",
              title: `Step "${stepTitleForMessage(step)}" failed after ${step.retryCount} retries`,
              body: `Step ${step.stepKey} (${stepTitleForMessage(step)}) exhausted all ${step.retryLimit} retries. Last error: ${attempt.errorMessage ?? "unknown"}`,
              requestedAction: "Review and decide whether to retry, skip, or add a workaround."
            });
            recordRuntimeEvent({
              runId: attempt.runId,
              stepId: step.id,
              attemptId: attempt.id,
              sessionId: attempt.executorSessionId,
              eventType: "intervention_opened",
              eventKey: `intervention_opened:${intervention.id}`,
              payload: {
                interventionId: intervention.id,
                interventionType: intervention.interventionType,
                reason: "retry_exhausted"
              }
            });

            const coordForDiag = coordinatorAgents.get(attempt.runId);
            if (!coordForDiag?.isAlive && aiIntegrationService && projectRoot) {
              // AI failure diagnosis that DECIDES and ACTS, not just describes (one-shot fallback when no coordinator)
              const diagConfig = resolveCallTypeConfig(graph.run.missionId, "coordinator");
              void (async () => {
                try {
                  const fullGraph = orchestratorService.getRunGraph({ runId: attempt.runId, timelineLimit: 5 });
                  const succeededContext = fullGraph.steps
                    .filter((s) => s.status === "succeeded")
                    .slice(0, 5)
                    .map((s) => {
                      const lastAttempt = fullGraph.attempts
                        .filter((a) => a.stepId === s.id && a.status === "succeeded")
                        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
                      return `  - ${s.stepKey}: ${lastAttempt?.resultEnvelope?.summary?.slice(0, 150) ?? "completed"}`;
                    });
                  const blockedByThis = fullGraph.steps.filter((s) =>
                    s.dependencyStepIds.includes(step.id) && s.status === "blocked"
                  );

                  const diagPrompt = [
                    PM_SYSTEM_PREAMBLE,
                    "Your current role: FAILURE DIAGNOSTICIAN AND DECISION MAKER.",
                    "A step has exhausted all retries. You must DECIDE and ACT, not just describe the problem.",
                    "",
                    `Failed step: "${stepTitleForMessage(step)}" (key: ${step.stepKey})`,
                    `Retries: ${step.retryCount}/${step.retryLimit}`,
                    `Last error: ${attempt.errorMessage ?? "unknown"}`,
                    `Step instructions: ${(isRecord(step.metadata) && typeof step.metadata.instructions === "string") ? step.metadata.instructions.slice(0, 500) : "N/A"}`,
                    succeededContext.length > 0 ? `\nCompleted steps for context:\n${succeededContext.join("\n")}` : "",
                    blockedByThis.length > 0 ? `\nSteps BLOCKED by this failure: ${blockedByThis.map((s) => `"${s.title}"`).join(", ")}` : "",
                    "",
                    "Choose ONE action:",
                    "- skip: Non-critical step. Provide downstreamGuidance for blocked steps.",
                    "- workaround: Add a new step achieving the same goal differently. Provide workaroundStep details.",
                    "- retry: Provide revisedInstructions addressing the root cause.",
                    "- escalate: ONLY if you truly need human input. Explain exactly what's needed.",
                    "",
                    "BIAS TOWARD ACTION. 'workaround' or 'skip' is almost always better than 'escalate'."
                  ].join("\n");

                  const diagSchema = {
                    type: "object",
                    properties: {
                      rootCause: { type: "string" },
                      category: { type: "string", enum: ["code", "environment", "design", "dependency", "unknown"] },
                      recommendation: { type: "string", enum: ["retry", "skip", "workaround", "escalate"] },
                      details: { type: "string" },
                      revisedInstructions: { type: "string" },
                      workaroundStep: {
                        type: "object",
                        properties: {
                          title: { type: "string" },
                          instructions: { type: "string" },
                          executorKind: { type: "string", enum: ["claude", "codex"] }
                        }
                      },
                      downstreamGuidance: { type: "string" }
                    },
                    required: ["rootCause", "category", "recommendation", "details"]
                  };

                  const diagResult = await aiIntegrationService.executeTask({
                    feature: "orchestrator",
                    taskType: "review",
                    prompt: diagPrompt,
                    cwd: projectRoot,
                    provider: diagConfig.provider,
                    reasoningEffort: diagConfig.reasoningEffort,
                    jsonSchema: diagSchema,
                    oneShot: true,
                    timeoutMs: 45_000
                  });

                  const diagParsed = isRecord(diagResult.structuredOutput) ? diagResult.structuredOutput : null;
                  const recommendation = String(diagParsed?.recommendation ?? "escalate");
                  const rootCause = String(diagParsed?.rootCause ?? diagResult.text?.slice(0, 500) ?? "Unknown");

                  logger.info("ai_orchestrator.failure_diagnosis_completed", {
                    runId: attempt.runId,
                    stepId: step.id,
                    recommendation,
                    rootCause: rootCause.slice(0, 200)
                  });
                  emitOrchestratorMessage(
                    graph.run.missionId,
                    `[FAILURE DIAGNOSIS] "${stepTitleForMessage(step)}": ${rootCause.slice(0, 300)} → Action: ${recommendation}`,
                    step.stepKey
                  );

                  // ACT on the diagnosis
                  if (recommendation === "skip") {
                    try {
                      orchestratorService.skipStep({
                        runId: attempt.runId,
                        stepId: step.id,
                        reason: `AI diagnosis: ${rootCause.slice(0, 200)}`
                      });
                      if (typeof diagParsed?.downstreamGuidance === "string" && blockedByThis.length > 0) {
                        for (const blocked of blockedByThis) {
                          steerMission({
                            missionId: graph.run.missionId,
                            directive: `Previous step "${stepTitleForMessage(step)}" was skipped. Guidance: ${diagParsed.downstreamGuidance}`,
                            priority: "instruction",
                            targetStepKey: blocked.stepKey
                          });
                        }
                      }
                      emitOrchestratorMessage(graph.run.missionId, `AI auto-skipped failed step "${stepTitleForMessage(step)}"`, step.stepKey);
                      void orchestratorService.startReadyAutopilotAttempts({ runId: attempt.runId, reason: "ai_diagnosis_skip" }).catch(() => {});
                    } catch (skipErr) {
                      logger.debug("ai_orchestrator.diagnosis_skip_failed", { error: skipErr instanceof Error ? skipErr.message : String(skipErr) });
                    }
                  } else if (recommendation === "workaround" && isRecord(diagParsed?.workaroundStep)) {
                    try {
                      const ws = diagParsed.workaroundStep;
                      const workaroundKey = `workaround-${step.stepKey}-${Date.now()}`;
                      orchestratorService.addSteps({
                        runId: attempt.runId,
                        steps: [{
                          stepKey: workaroundKey,
                          title: typeof ws.title === "string" ? ws.title : `Workaround for ${stepTitleForMessage(step)}`,
                          stepIndex: step.stepIndex + 1,
                          dependencyStepKeys: [],
                          executorKind: (typeof ws.executorKind === "string" && ["claude", "codex"].includes(ws.executorKind) ? ws.executorKind : "claude") as OrchestratorExecutorKind,
                          retryLimit: 2,
                          metadata: {
                            instructions: typeof ws.instructions === "string" ? ws.instructions : "",
                            aiGenerated: true,
                            generationReason: `workaround for failed ${step.stepKey}: ${rootCause.slice(0, 200)}`
                          }
                        }]
                      });
                      // Remap blocked steps to depend on workaround instead
                      for (const blocked of blockedByThis) {
                        try {
                          const currentDeps = blocked.dependencyStepIds
                            .map((depId) => fullGraph.steps.find((d) => d.id === depId)?.stepKey)
                            .filter((k): k is string => !!k);
                          const newDeps = currentDeps.map((k) => k === step.stepKey ? workaroundKey : k);
                          orchestratorService.updateStepDependencies({
                            runId: attempt.runId,
                            stepId: blocked.id,
                            dependencyStepKeys: newDeps
                          });
                        } catch {
                          // Best-effort dependency remap
                        }
                      }
                      emitOrchestratorMessage(graph.run.missionId, `AI added workaround for "${stepTitleForMessage(step)}"`, workaroundKey);
                      void orchestratorService.startReadyAutopilotAttempts({ runId: attempt.runId, reason: "ai_diagnosis_workaround" }).catch(() => {});
                    } catch (workaroundErr) {
                      logger.debug("ai_orchestrator.diagnosis_workaround_failed", { error: workaroundErr instanceof Error ? workaroundErr.message : String(workaroundErr) });
                    }
                  }
                  // retry and escalate fall through to intervention handling below
                } catch (diagError) {
                  logger.debug("ai_orchestrator.failure_diagnosis_failed", {
                    runId: attempt.runId,
                    stepId: step.id,
                    error: diagError instanceof Error ? diagError.message : String(diagError)
                  });
                }
              })();

              // Also attempt auto-resolution if configured
              const runtimeProfile = runRuntimeProfiles.get(attempt.runId) ?? resolveActiveRuntimeProfile(graph.run.missionId);
              if (runtimeProfile.evaluation.autoResolveInterventions) {
                handleInterventionWithAI({
                  missionId: graph.run.missionId,
                  interventionId: intervention.id,
                  provider: attempt.executorKind === "codex" ? "codex" : "claude"
                }).catch((error) => {
                  logger.debug("ai_orchestrator.auto_intervention_failed", {
                    runId: event.runId,
                    stepId: step.id,
                    error: error instanceof Error ? error.message : String(error)
                  });
                });
              }
            }
          } catch (interventionError) {
            logger.debug("ai_orchestrator.create_intervention_failed", {
              runId: event.runId,
              stepId: step.id,
              error: interventionError instanceof Error ? interventionError.message : String(interventionError)
            });
          }
        }
      }
    } catch (error) {
      logger.debug("ai_orchestrator.worker_state_update_failed", {
        attemptId: event.attemptId,
        runId: event.runId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const summarizeRunForChat = (missionId: string): string => {
    const runs = orchestratorService.listRuns({ missionId });
    if (!runs.length) return "No run has started yet.";
    const byCreatedDesc = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const activeRun = byCreatedDesc.find((entry) => entry.status === "active" || entry.status === "bootstrapping" || entry.status === "queued" || entry.status === "paused");
    const targetRun = activeRun ?? byCreatedDesc[0];
    if (!targetRun) return "No run has started yet.";
    try {
      const graph = orchestratorService.getRunGraph({ runId: targetRun.id, timelineLimit: 0 });
      const total = graph.steps.length;
      const running = graph.steps.filter((step) => step.status === "running").length;
      const done = graph.steps.filter((step) =>
        step.status === "succeeded" || step.status === "failed" || step.status === "skipped" || step.status === "canceled"
      ).length;
      const failed = graph.steps.filter((step) => step.status === "failed").length;
      const blocked = graph.steps.filter((step) => step.status === "blocked").length;
      const runMeta = isRecord(graph.run.metadata) ? graph.run.metadata : {};
      const autopilot = isRecord(runMeta.autopilot) ? runMeta.autopilot : null;
      const parallelCap =
        autopilot && Number.isFinite(Number(autopilot.parallelismCap))
          ? Math.max(1, Math.floor(Number(autopilot.parallelismCap)))
          : null;
      const runningSteps = graph.steps
        .filter((step) => step.status === "running")
        .slice(0, 3)
        .map((step) => `${step.title || step.stepKey}${step.laneId ? ` @${step.laneId}` : ""}`);
      const readySteps = graph.steps
        .filter((step) => step.status === "ready")
        .slice(0, 3)
        .map((step) => `${step.title || step.stepKey}${step.laneId ? ` @${step.laneId}` : ""}`);
      return [
        `Run ${targetRun.id.slice(0, 8)} is ${targetRun.status}. Progress ${done}/${total}. Running ${running}. Failed ${failed}. Blocked ${blocked}.`,
        parallelCap ? `Parallelism cap: ${parallelCap}.` : null,
        runningSteps.length ? `Active steps: ${runningSteps.join("; ")}.` : null,
        readySteps.length ? `Ready queue: ${readySteps.join("; ")}.` : null
      ]
        .filter((line): line is string => Boolean(line))
        .join(" ");
    } catch {
      return `Latest run ${targetRun.id.slice(0, 8)} is ${targetRun.status}.`;
    }
  };

  const formatRecentChatContext = (
    messages: OrchestratorChatMessage[],
    limit = MAX_CHAT_CONTEXT_MESSAGES
  ): string => {
    const recent = messages.slice(-limit);
    if (!recent.length) return "";
    const lines = recent.map((entry) => {
      const role = entry.role === "user" ? "User" : entry.role === "worker" ? "Worker" : "Orchestrator";
      const compact = clipTextForContext(
        entry.content.replace(/\s+/g, " ").trim(),
        MAX_CHAT_LINE_CHARS
      );
      return `- ${role}: ${compact}`;
    });
    const rendered = ["Recent mission chat:", ...lines, ""].join("\n");
    return clipTextForContext(rendered, MAX_CHAT_CONTEXT_CHARS);
  };

  const buildRecentChatContext = (missionId: string, limit = MAX_CHAT_CONTEXT_MESSAGES): string => {
    const messages = chatMessages.get(missionId) ?? loadChatMessagesFromMetadata(missionId);
    return formatRecentChatContext(messages, limit);
  };

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
        if (runningAttempt?.executorKind === "claude" || runningAttempt?.executorKind === "codex") {
          return runningAttempt.executorKind as "claude" | "codex";
        }
        if (runningAttempt?.executorKind === "unified") {
          // For unified executor, resolve from the model metadata or default to claude
          const attemptModel = typeof (runningAttempt as any).metadata?.model === "string" ? (runningAttempt as any).metadata.model : null;
          if (attemptModel) {
            const desc = getModelById(attemptModel);
            if (desc?.family === "openai") return "codex";
          }
          return "claude";
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

  // ── Team Runtime Manager ─────────────────────────────────────
  // Spawns and manages coordinator + teammates for a run.

  /** Register a team member in the persistent DB table */
  const registerTeamMember = (member: OrchestratorTeamMember): void => {
    db.run(
      `insert into orchestrator_team_members(
        id, run_id, mission_id, provider, model, role, session_id, status,
        claimed_task_ids_json, metadata_json, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        member.id, member.runId, member.missionId, member.provider, member.model,
        member.role, member.sessionId, member.status,
        JSON.stringify(member.claimedTaskIds), member.metadata ? JSON.stringify(member.metadata) : null,
        member.createdAt, member.updatedAt
      ]
    );
  };

  /** Update a team member's status/session in the DB */
  const updateTeamMemberStatus = (memberId: string, updates: {
    status?: OrchestratorTeamMember["status"];
    sessionId?: string | null;
    claimedTaskIds?: string[];
  }): void => {
    const now = nowIso();
    if (updates.status) {
      db.run(
        `update orchestrator_team_members set status = ?, updated_at = ? where id = ?`,
        [updates.status, now, memberId]
      );
    }
    if (updates.sessionId !== undefined) {
      db.run(
        `update orchestrator_team_members set session_id = ?, updated_at = ? where id = ?`,
        [updates.sessionId, now, memberId]
      );
    }
    if (updates.claimedTaskIds) {
      db.run(
        `update orchestrator_team_members set claimed_task_ids_json = ?, updated_at = ? where id = ?`,
        [JSON.stringify(updates.claimedTaskIds), now, memberId]
      );
    }
  };

  /** Get team members for a run */
  const getTeamMembersForRun = (runId: string): OrchestratorTeamMember[] => {
    const rows = db.all<{
      id: string; run_id: string; mission_id: string; provider: string; model: string;
      role: string; session_id: string | null; status: string;
      claimed_task_ids_json: string; metadata_json: string | null;
      created_at: string; updated_at: string;
    }>(
      `select * from orchestrator_team_members where run_id = ? order by created_at asc`,
      [runId]
    );
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      missionId: row.mission_id,
      provider: row.provider,
      model: row.model,
      role: row.role as OrchestratorTeamMember["role"],
      sessionId: row.session_id,
      status: row.status as OrchestratorTeamMember["status"],
      claimedTaskIds: parseJsonArray(row.claimed_task_ids_json) as string[],
      metadata: parseJsonRecord(row.metadata_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  };

  /** Initialize team runtime state in the DB */
  const initTeamRuntimeState = (runId: string, coordinatorSessionId: string | null): void => {
    const now = nowIso();
    db.run(
      `insert into orchestrator_run_state(
        run_id, phase, completion_requested, completion_validated,
        last_validation_error, coordinator_session_id, teammate_ids_json,
        created_at, updated_at
      ) values (?, 'bootstrapping', 0, 0, null, ?, '[]', ?, ?)
      on conflict(run_id) do update set
        phase = 'bootstrapping',
        completion_requested = 0,
        completion_validated = 0,
        coordinator_session_id = excluded.coordinator_session_id,
        updated_at = excluded.updated_at`,
      [runId, coordinatorSessionId, now, now]
    );
    teamRuntimeStates.set(runId, {
      runId,
      phase: "bootstrapping",
      completionRequested: false,
      completionValidated: false,
      lastValidationError: null,
      coordinatorSessionId: coordinatorSessionId,
      teammateIds: [],
      createdAt: now,
      updatedAt: now,
    });
  };

  /** Update team runtime phase in the DB */
  const updateTeamRuntimePhase = (runId: string, phase: OrchestratorTeamRuntimeState["phase"], extra?: {
    coordinatorSessionId?: string | null;
    teammateIds?: string[];
    completionRequested?: boolean;
    completionValidated?: boolean;
    lastValidationError?: string | null;
  }): void => {
    const now = nowIso();
    const state = teamRuntimeStates.get(runId);
    if (state) {
      state.phase = phase;
      state.updatedAt = now;
      if (extra?.coordinatorSessionId !== undefined) state.coordinatorSessionId = extra.coordinatorSessionId;
      if (extra?.teammateIds) state.teammateIds = extra.teammateIds;
      if (extra?.completionRequested !== undefined) state.completionRequested = extra.completionRequested;
      if (extra?.completionValidated !== undefined) state.completionValidated = extra.completionValidated;
      if (extra?.lastValidationError !== undefined) state.lastValidationError = extra.lastValidationError;
    }
    db.run(
      `update orchestrator_run_state set phase = ?, updated_at = ? where run_id = ?`,
      [phase, now, runId]
    );
    if (extra?.coordinatorSessionId !== undefined) {
      db.run(
        `update orchestrator_run_state set coordinator_session_id = ? where run_id = ?`,
        [extra.coordinatorSessionId, runId]
      );
    }
    if (extra?.teammateIds) {
      db.run(
        `update orchestrator_run_state set teammate_ids_json = ? where run_id = ?`,
        [JSON.stringify(extra.teammateIds), runId]
      );
    }
    if (extra?.completionRequested !== undefined) {
      db.run(
        `update orchestrator_run_state set completion_requested = ? where run_id = ?`,
        [extra.completionRequested ? 1 : 0, runId]
      );
    }
    if (extra?.completionValidated !== undefined) {
      db.run(
        `update orchestrator_run_state set completion_validated = ? where run_id = ?`,
        [extra.completionValidated ? 1 : 0, runId]
      );
    }
    if (extra?.lastValidationError !== undefined) {
      db.run(
        `update orchestrator_run_state set last_validation_error = ? where run_id = ?`,
        [extra.lastValidationError, runId]
      );
    }
  };

  /** Get the team runtime state for a run */
  const getTeamRuntimeStateForRun = (runId: string): OrchestratorTeamRuntimeState | null => {
    const cached = teamRuntimeStates.get(runId);
    if (cached) return cached;
    const row = db.get<{
      run_id: string; phase: string; completion_requested: number; completion_validated: number;
      last_validation_error: string | null; coordinator_session_id: string | null;
      teammate_ids_json: string; created_at: string; updated_at: string;
    }>(
      `select * from orchestrator_run_state where run_id = ? limit 1`,
      [runId]
    );
    if (!row) return null;
    const runtimeState: OrchestratorTeamRuntimeState = {
      runId: row.run_id,
      phase: row.phase as OrchestratorTeamRuntimeState["phase"],
      completionRequested: row.completion_requested === 1,
      completionValidated: row.completion_validated === 1,
      lastValidationError: row.last_validation_error,
      coordinatorSessionId: row.coordinator_session_id,
      teammateIds: parseJsonArray(row.teammate_ids_json) as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    teamRuntimeStates.set(runId, runtimeState);
    return runtimeState;
  };

  /**
   * Spawn the team runtime for a run: coordinator agent + N teammates.
   * The coordinator is a persistent CoordinatorAgent. Teammates are registered
   * and claim tasks through the kernel.
   */
  const spawnTeamRuntime = async (args: {
    runId: string;
    missionId: string;
    missionGoal: string;
    config: TeamRuntimeConfig;
    coordinatorModelConfig: ModelConfig;
  }): Promise<{ coordinatorAgent: CoordinatorAgent | null; teammateIds: string[] }> => {
    const { runId, missionId, missionGoal, config, coordinatorModelConfig } = args;

    // Initialize runtime state
    initTeamRuntimeState(runId, null);

    // 1. Spawn coordinator agent
    const { userRules: teamUserRules, projectCtx: teamProjectCtx, availableProviders: teamProviders, phases: teamPhases } = gatherCoordinatorContext(missionId, { missionId });
    const coordinatorAgent = startCoordinatorAgentV2(missionId, runId, missionGoal, coordinatorModelConfig, {
      userRules: teamUserRules,
      projectContext: teamProjectCtx,
      availableProviders: teamProviders,
      phases: teamPhases,
    });
    const coordinatorMemberId = randomUUID();
    const now = nowIso();

    registerTeamMember({
      id: coordinatorMemberId,
      runId,
      missionId,
      provider: coordinatorModelConfig.provider,
      model: modelConfigToServiceModel(coordinatorModelConfig),
      role: "coordinator",
      sessionId: null,
      status: coordinatorAgent ? "active" : "failed",
      claimedTaskIds: [],
      metadata: { coordinatorAgent: true },
      createdAt: now,
      updatedAt: now,
    });

    // 2. Spawn teammates
    const teammateIds: string[] = [];
    const template = config.template ?? DEFAULT_TEAM_TEMPLATE;
    const teammateCount = Math.max(
      0,
      Math.min(
        20,
        Math.min(config.teammateCount, Math.max(0, template.constraints.maxWorkers - 1))
      )
    );
    const assignableRoles = template.roles.filter((role) => role.name.toLowerCase() !== "coordinator");
    const targetProvider = config.targetProvider === "auto"
      ? coordinatorModelConfig.provider
      : config.targetProvider;

    for (let i = 0; i < teammateCount; i++) {
      const roleDef = assignableRoles.length > 0
        ? assignableRoles[i % assignableRoles.length]
        : null;
      const roleProvider = roleDef?.defaultModel.provider ?? targetProvider;
      const roleModel = roleDef?.defaultModel.modelId ?? modelConfigToServiceModel(coordinatorModelConfig);
      const roleName = roleDef?.name ?? "teammate";
      const configuredToolProfile =
        config.toolProfiles && roleName in config.toolProfiles
          ? config.toolProfiles[roleName]
          : roleDef?.toolProfile;
      const memberId = randomUUID();
      registerTeamMember({
        id: memberId,
        runId,
        missionId,
        provider: roleProvider,
        model: roleModel,
        role: "teammate",
        sessionId: null,
        status: "spawning",
        claimedTaskIds: [],
        metadata: {
          index: i,
          roleName,
          roleCapabilities: roleDef?.capabilities ?? [],
          toolProfile: configuredToolProfile ?? null,
          mcpServerAllowlist: config.mcpServerAllowlist ?? []
        },
        createdAt: now,
        updatedAt: now,
      });
      teammateIds.push(memberId);
    }

    // Update runtime state
    updateTeamRuntimePhase(runId, "planning", {
      coordinatorSessionId: coordinatorMemberId,
      teammateIds,
    });

    logger.info("ai_orchestrator.team_runtime_spawned", {
      runId,
      missionId,
      coordinatorAlive: !!coordinatorAgent,
      teammateCount: teammateIds.length,
      provider: targetProvider,
      templateId: template.id
    });

    return { coordinatorAgent, teammateIds };
  };

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
    try {
      const activeRuns = db.all<{ id: string; mission_id: string; status: string; metadata_json: string | null }>(
        `select id, mission_id, status, metadata_json from orchestrator_runs where status in ('active', 'bootstrapping', 'queued') order by created_at desc limit 10`
      );
      for (const run of activeRuns) {
        const runtimeState = getTeamRuntimeStateForRun(run.id);
        if (!runtimeState || runtimeState.phase === "done" || runtimeState.phase === "failed") continue;

        // Restore coordinator agent if possible
        const mission = missionService.get(run.mission_id);
        if (!mission) continue;

        const coordinatorModelConfig = resolveOrchestratorModelConfig(run.mission_id, "coordinator");
        const missionGoal = mission.prompt || mission.title;
        const { userRules, projectCtx, availableProviders, phases } = gatherCoordinatorContext(run.mission_id, { missionId: run.mission_id });
        const agent = startCoordinatorAgentV2(run.mission_id, run.id, missionGoal, coordinatorModelConfig, {
          userRules,
          projectContext: projectCtx,
          availableProviders,
          phases,
        });

        if (agent) {
          agent.injectMessage(
            `[RESUME] Mission resumed after app restart. Check the current state of all workers and tasks, then continue managing the mission.`
          );
          logger.info("ai_orchestrator.team_runtime_resumed", {
            runId: run.id,
            missionId: run.mission_id,
            phase: runtimeState.phase,
          });
        }
      }
    } catch (error) {
      logger.debug("ai_orchestrator.team_runtime_resume_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Communication routing: user messages to coordinator thread get injected
  // into the coordinator agent directly instead of going through the old
  // text-command parser.
  const routeUserMessageToCoordinator = (missionId: string, runId: string, content: string): boolean => {
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
      .catch(() => undefined)
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
  const COORDINATOR_HEARTBEAT_INTERVAL_MS = 30_000;
  const COORDINATOR_STUCK_THRESHOLD_MS = 60_000;
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

        // Route status event directly to coordinator agent
        const coordAgent = coordinatorAgents.get(runId);
        if (coordAgent?.isAlive) {
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

          coordAgent.injectMessage(statusMessage);
        }

        // Always start any newly-ready steps after evaluation
        void orchestratorService.startReadyAutopilotAttempts({ runId, reason: `coordinator_eval:${reason}` }).catch(() => {});

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
      const planning = await planMissionOnce({
        missionId: args.missionId,
        title: mission.title,
        prompt: mission.prompt,
        laneId: mission.laneId,
        plannerEngine,
        model: args.model,
        projectRoot,
        aiIntegrationService: planningIntegration,
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

      // Get project_id from missions table for DB operations
      const missionRow = db.get<{ project_id: string }>(
        `select project_id from missions where id = ? limit 1`,
        [args.missionId]
      );
      if (!missionRow) return;
      const missionProjectId = missionRow.project_id;

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
      const runtimeProfile =
        (runIdForAttempt ? runRuntimeProfiles.get(runIdForAttempt) : null)
        ?? (missionIdForAttempt ? resolveActiveRuntimeProfile(missionIdForAttempt) : null);
      const evaluationReasoningEffort = runtimeProfile?.evaluation.evaluationReasoningEffort ?? "medium";
      const configWorkerEval = missionIdForAttempt
        ? resolveOrchestratorModelConfig(missionIdForAttempt, "coordinator")
        : legacyToModelConfig("sonnet", evaluationReasoningEffort);
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
      "- reassign_executor: Change executor kind for a pending/blocked step (set targetStepKey + newExecutorKind: 'claude'|'codex')",
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
              newExecutorKind: { type: "string", enum: ["claude", "codex"] },
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
                  executorKind: { type: "string", enum: ["claude", "codex", "manual"] }
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
          ["claude", "codex", "manual"].includes(newStep.executorKind)
          ? (newStep.executorKind as OrchestratorExecutorKind)
          : ("manual" as OrchestratorExecutorKind);
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
      void orchestratorService.startReadyAutopilotAttempts({
        runId: adjustArgs.runId,
        reason: `ai_plan_adjustment:${adjustmentsApplied}_changes`
      }).catch(() => {});
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

  const buildRunStateSnapshot = (runId: string): MetaReasonerRunState => {
    const graph = orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
    const activeAgentCount = graph.attempts.filter((a) => a.status === "running").length;
    const runMeta = graph.run.metadata ?? {};
    const autopilot = typeof runMeta.autopilot === "object" && runMeta.autopilot && !Array.isArray(runMeta.autopilot)
      ? (runMeta.autopilot as Record<string, unknown>)
      : {};
    const parallelismCap = Math.max(1, Math.min(32, Number(autopilot.parallelismCap ?? 4)));

    // Available lanes: lanes from steps that are not currently running
    const runningLaneIds = new Set(
      graph.steps.filter((s) => s.status === "running" && s.laneId).map((s) => s.laneId!)
    );
    const allLaneIds = [...new Set(graph.steps.map((s) => s.laneId).filter((id): id is string => id != null))];
    const availableLanes = allLaneIds.filter((id) => !runningLaneIds.has(id));

    // File ownership from active claims
    const fileOwnershipMap: Record<string, string> = {};
    for (const claim of graph.claims) {
      if (claim.state === "active" && claim.scopeKind === "file") {
        fileOwnershipMap[claim.scopeValue] = claim.ownerId;
      }
    }

    return { activeAgentCount, parallelismCap, availableLanes, fileOwnershipMap };
  };

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

  /** Pause mission when a provider is unreachable (rate limit, auth error, network). */
  const pauseOnProviderUnreachable = (missionId: string, provider: string, errorMessage: string): void => {
    const lowerErr = errorMessage.toLowerCase();
    const isAuthError = lowerErr.includes("auth") || lowerErr.includes("401") || lowerErr.includes("403")
      || lowerErr.includes("invalid api key") || lowerErr.includes("unauthorized") || lowerErr.includes("forbidden");

    pauseMissionWithIntervention({
      missionId,
      interventionType: "provider_unreachable",
      title: isAuthError
        ? `Worker failed: authentication error (${provider})`
        : `Provider unreachable: ${provider}`,
      body: isAuthError
        ? `Worker failed: ${errorMessage.slice(0, 500)}. Check your ${provider} subscription or API key, or switch to a different model.`
        : `Worker failed because ${provider} is unreachable: ${errorMessage.slice(0, 500)}`,
      requestedAction: isAuthError
        ? `Verify your ${provider} API key or subscription in Settings, switch to a different model, then resume.`
        : "Check provider status, verify credentials, or switch to a different provider.",
      metadata: { source: "worker_provider_failure", provider, isAuthError },
    });
  };

  /** Pause mission on unrecoverable errors the coordinator cannot handle. */
  const pauseOnUnrecoverableError = (missionId: string, stepKey: string, errorMessage: string): void => {
    pauseMissionWithIntervention({
      missionId,
      interventionType: "unrecoverable_error",
      title: `Unrecoverable error in ${stepKey}`,
      body: `Coordinator cannot recover from: ${errorMessage.slice(0, 500)}`,
      requestedAction: "Investigate the error, fix manually, or cancel the mission.",
      metadata: { source: "coordinator_unrecoverable", stepKey },
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

  const ensurePlanReviewIntervention = (missionId: string) => {
    const mission = missionService.get(missionId);
    if (!mission) return;
    const existing = mission.interventions.find(
      (entry) => entry.status === "open" && entry.interventionType === "approval_required" && entry.title === PLAN_REVIEW_INTERVENTION_TITLE
    );
    if (existing) return;
    missionService.addIntervention({
      missionId,
      interventionType: "approval_required",
      title: PLAN_REVIEW_INTERVENTION_TITLE,
      body: "Review planner output and approve mission execution when ready.",
      requestedAction: "Approve the plan to begin execution."
    });
  };

  const resolveMissionParallelismCap = (missionId: string): number | null => {
    const row = db.get<{ metadata_json: string | null }>(
      `
        select metadata_json
        from missions
        where id = ?
        limit 1
      `,
      [missionId]
    );
    if (!row?.metadata_json) return null;
    try {
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      const plannerPlan = isRecord(metadata.plannerPlan) ? (metadata.plannerPlan as Record<string, unknown>) : null;
      const missionSummary = plannerPlan && isRecord(plannerPlan.missionSummary)
        ? (plannerPlan.missionSummary as Record<string, unknown>)
        : null;
      const cap = Number(missionSummary?.parallelismCap ?? NaN);
      return Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : null;
    } catch {
      return null;
    }
  };

  const resolveMissionLaneStrategyParallelismCap = (missionId: string): number | null => {
    const metadata = getMissionMetadata(missionId);
    const parallelLanes = isRecord(metadata.parallelLanes) ? metadata.parallelLanes : null;
    const cap = Number(parallelLanes?.maxParallelLanes ?? Number.NaN);
    return Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : null;
  };

  const resolveMissionLaunchPlannerModel = (missionId: string): "opus" | "sonnet" | "haiku" | null => {
    const row = db.get<{ metadata_json: string | null }>(
      `
        select metadata_json
        from missions
        where id = ?
        limit 1
      `,
      [missionId]
    );
    if (!row?.metadata_json) return null;
    try {
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      const launch = isRecord(metadata.launch) ? (metadata.launch as Record<string, unknown>) : null;
      const raw = typeof launch?.orchestratorModel === "string" ? launch.orchestratorModel.trim().toLowerCase() : "";
      if (raw === "opus" || raw === "sonnet" || raw === "haiku") return raw;
      return null;
    } catch {
      return null;
    }
  };

  const resolveMissionDecisionTimeoutCapMs = (missionId: string): number => {
    const metadata = getMissionMetadata(missionId);
    const modelConfig = isRecord(metadata.modelConfig) ? metadata.modelConfig : null;
    const rawHours = Number(modelConfig?.decisionTimeoutCapHours ?? Number.NaN);
    const normalizedHours = Number.isFinite(rawHours) ? Math.floor(rawHours) : 24;
    return DECISION_TIMEOUT_CAP_MS_BY_HOURS[normalizedHours] ?? DECISION_TIMEOUT_CAP_MS_BY_HOURS[24];
  };

  const resolveAiDecisionLikeTimeoutMs = (missionId: string): number | null => {
    void missionId;
    return null;
  };

  /** Resolve a per-call-type ModelConfig from mission metadata, with fallback to legacy model */
  const resolveOrchestratorModelConfig = (missionId: string, callType: OrchestratorCallType): ModelConfig => {
    // Try to load full MissionModelConfig from mission metadata
    const metadata = getMissionMetadata(missionId);
    const missionModelConfig = metadata?.modelConfig as MissionModelConfig | undefined;

    if (missionModelConfig) {
      return resolveCallTypeModel(
        callType,
        missionModelConfig.intelligenceConfig,
        missionModelConfig.orchestratorModel
      );
    }

    // Fallback: use legacy orchestratorModel from launch metadata
    const legacyModel = resolveMissionLaunchPlannerModel(missionId);
    return legacyToModelConfig(legacyModel);
  };

  /** Resolve the orchestrator model for AI decision calls — defaults to "sonnet" (backward compat wrapper) */
  const resolveOrchestratorModel = (missionId: string): string => {
    const config = resolveOrchestratorModelConfig(missionId, "coordinator");
    return modelConfigToServiceModel(config);
  };

  const resolveMissionModelConfig = (missionId: string): MissionModelConfig | null => {
    const metadata = getMissionMetadata(missionId);
    const modelConfig = metadata?.modelConfig;
    return isRecord(modelConfig) ? (modelConfig as MissionModelConfig) : null;
  };

  const transitionMissionStatus = (missionId: string, next: MissionStatus, args?: { outcomeSummary?: string | null; lastError?: string | null }) => {
    const mission = missionService.get(missionId);
    if (!mission) return;
    if (mission.status === next && args?.outcomeSummary == null && args?.lastError == null) return;
    try {
      missionService.update({
        missionId,
        status: next,
        ...(args?.outcomeSummary !== undefined ? { outcomeSummary: args.outcomeSummary } : {}),
        ...(args?.lastError !== undefined ? { lastError: args.lastError } : {})
      });
    } catch (error) {
      logger.debug("ai_orchestrator.mission_status_transition_skipped", {
        missionId,
        from: mission.status,
        to: next,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  };

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

  const isAllowedStepCompletionMissionStatus = (value: string): value is MissionStatus =>
    value === "in_progress" ||
    value === "intervention_required" ||
    value === "completed" ||
    value === "partially_completed" ||
    value === "failed" ||
    value === "canceled";

  const validateTransitionDecisionSafety = (graph: OrchestratorRunGraph, missionStatus: MissionStatus): { ok: boolean; reason: string } => {
    const runStatus = graph.run.status;
    const allTerminal = graph.steps.every((step) =>
      step.status === "succeeded" || step.status === "failed" || step.status === "skipped" || step.status === "canceled"
    );
    const hasFailures = graph.steps.some((step) => step.status === "failed" || step.status === "blocked");

    if (runStatus === "succeeded") {
      return missionStatus === "completed" || missionStatus === "partially_completed"
        ? { ok: true, reason: "terminal_success" }
        : { ok: false, reason: `Run is succeeded; mission status must be completed or partially_completed.` };
    }
    if (runStatus === "succeeded_with_risk") {
      return missionStatus === "partially_completed" || missionStatus === "completed"
        ? { ok: true, reason: "terminal_success_with_risk" }
        : { ok: false, reason: "Run is succeeded_with_risk; mission status must be partially_completed." };
    }
    if (runStatus === "failed") {
      return missionStatus === "failed" || missionStatus === "intervention_required"
        ? { ok: true, reason: "terminal_failure" }
        : { ok: false, reason: "Run is failed; mission status must be failed or intervention_required." };
    }
    if (runStatus === "canceled") {
      return missionStatus === "canceled"
        ? { ok: true, reason: "terminal_canceled" }
        : { ok: false, reason: "Run is canceled; mission status must be canceled." };
    }
    if (runStatus === "paused") {
      return missionStatus === "intervention_required"
        ? { ok: true, reason: "paused_requires_intervention" }
        : { ok: false, reason: "Run is paused; mission status must be intervention_required." };
    }

    if (missionStatus === "completed" || missionStatus === "partially_completed") {
      return allTerminal && !hasFailures
        ? { ok: true, reason: "all_steps_terminal_success" }
        : missionStatus === "partially_completed" && allTerminal
          ? { ok: true, reason: "all_steps_terminal_partial" }
          : { ok: false, reason: "Mission cannot be completed while run is still active or contains failures." };
    }
    if (missionStatus === "failed") {
      return allTerminal && hasFailures
        ? { ok: true, reason: "all_steps_terminal_failure" }
        : { ok: false, reason: "Mission cannot be failed while run is active without terminal failures." };
    }
    if (missionStatus === "canceled") {
      return { ok: false, reason: "Mission cannot be canceled from active run status without explicit cancel." };
    }

    return { ok: true, reason: "active_run_status_ok" };
  };

  type AiTransitionDirectives = {
    parallelismCap: number | null;
    disableHeuristicParallelism: boolean;
    retryBackoffMs: number | null;
    timeoutBudgetMs: number | null;
    stagnationThresholdMs: number | null;
    stepPriorities: Array<{ stepKey: string; priority: number; reason: string | null; laneHint: string | null }>;
  };

  type AiTransitionDecision = {
    actionType: "continue" | "retry" | "pause" | "replan" | "abort";
    missionStatus: MissionStatus;
    pauseRun: boolean;
    rationale: string;
    interventionTitle: string | null;
    interventionBody: string | null;
    directives: AiTransitionDirectives;
  };

  const deriveTransitionMissionStatus = (args: {
    graph: OrchestratorRunGraph;
    mission: MissionDetail;
    actionType: "continue" | "retry" | "pause" | "replan" | "abort";
    nextStatus: string | null;
  }): MissionStatus => {
    const requested = typeof args.nextStatus === "string" ? args.nextStatus.trim() : "";
    if (requested && isAllowedStepCompletionMissionStatus(requested)) return requested;
    if (args.actionType === "pause" || args.actionType === "replan") return "intervention_required";
    if (args.actionType === "abort") return "failed";
    if (args.actionType === "retry") return "in_progress";
    return deriveMissionStatusFromRun(args.graph, args.mission);
  };

  type MissionReplanAnalysis = {
    shouldReplan: boolean;
    summary: string;
    planDelta: string[];
    confidence: number | null;
    error: string | null;
  };

  const summarizeCurrentPlanForReplan = (graph: OrchestratorRunGraph): string => {
    const preview = graph.steps
      .slice(0, 12)
      .map((step) => `${step.stepKey}:${step.status}`)
      .join(", ");
    const summary = `Run status=${graph.run.status}; stepCount=${graph.steps.length}; preview=[${preview}]`;
    return summary.slice(0, 4_000);
  };

  const resolveMissionObjectiveForReplan = (missionId: string, mission: MissionDetail | null): string => {
    const metadata = getMissionMetadata(missionId);
    const plannerPlan = isRecord(metadata.plannerPlan) ? metadata.plannerPlan : null;
    const missionSummary = plannerPlan && isRecord(plannerPlan.missionSummary)
      ? plannerPlan.missionSummary
      : null;
    const objective = typeof missionSummary?.objective === "string" ? missionSummary.objective.trim() : "";
    if (objective.length > 0) return objective;
    const prompt = typeof mission?.prompt === "string" ? mission.prompt.trim() : "";
    if (prompt.length > 0) return prompt;
    const title = typeof mission?.title === "string" ? mission.title.trim() : "";
    return title.length > 0 ? title : "Mission objective unavailable.";
  };

  const requestMissionReplanAnalysis = async (args: {
    missionId: string;
    runId: string;
    stepId?: string | null;
    stepKey?: string | null;
    reason: string;
    failureDigest: string;
    graph: OrchestratorRunGraph;
  }): Promise<MissionReplanAnalysis> => {
    const mission = missionService.get(args.missionId);
    const failureDigest = args.failureDigest.slice(0, 4_000);
    const missionObjective = resolveMissionObjectiveForReplan(args.missionId, mission);
    const currentPlanSummary = summarizeCurrentPlanForReplan(args.graph);

    // Replan analysis is now handled by the coordinator agent via injectEvent().
    // This path provides a deterministic fallback that always triggers replan.
    const analysis: MissionReplanAnalysis = {
      shouldReplan: true,
      summary: args.reason,
      planDelta: [],
      confidence: null,
      error: null
    };

    updateRunMetadata(args.runId, (metadata) => {
      const aiDecisions = isRecord(metadata.aiDecisions) ? { ...metadata.aiDecisions } : {};
      aiDecisions.lastReplanRequest = {
        requestedAt: nowIso(),
        missionId: args.missionId,
        stepId: args.stepId ?? null,
        stepKey: args.stepKey ?? null,
        reason: args.reason,
        failureDigest,
        shouldReplan: analysis.shouldReplan,
        summary: analysis.summary,
        planDelta: analysis.planDelta,
        confidence: analysis.confidence,
        error: analysis.error
      };
      metadata.aiDecisions = aiDecisions;
    });

    return analysis;
  };

  const formatReplanInterventionBody = (args: {
    reason: string;
    analysis: MissionReplanAnalysis;
  }): string => {
    const lines = [
      args.reason,
      `Replan summary: ${args.analysis.summary}`,
      args.analysis.planDelta.length > 0
        ? `Proposed plan deltas:\n- ${args.analysis.planDelta.join("\n- ")}`
        : null,
      args.analysis.error ? `Replan analysis warning: ${args.analysis.error}` : null
    ];
    return lines.filter((line): line is string => typeof line === "string" && line.trim().length > 0).join("\n\n");
  };

  // Deterministic step priority and transition functions removed —
  // the coordinator AI handles step transitions through its persistent conversation.

  const decideStepTransitionViaAiDecisionService = async (args: {
    runId: string;
    stepId: string;
  }): Promise<
    | { ok: true; graph: OrchestratorRunGraph; missionId: string; stepKey: string | null; decision: AiTransitionDecision }
    | { ok: false; missionId: string | null; stepKey: string | null; reason: string }
  > => {
    try {
      const graph = orchestratorService.getRunGraph({ runId: args.runId, timelineLimit: 40 });
      const missionId = graph.run.missionId;
      const mission = missionService.get(missionId);
      const step = graph.steps.find((entry) => entry.id === args.stepId);
      const stepKey = step?.stepKey ?? null;
      if (!mission) {
        return { ok: false, missionId, stepKey, reason: "Mission not found for run." };
      }
      if (!step) {
        return { ok: false, missionId, stepKey, reason: "Completed step not found in run graph." };
      }

      // No deterministic transition logic — just continue.
      // The coordinator AI will observe this event and decide what to do.
      const missionStatus = deriveTransitionMissionStatus({
        graph,
        mission,
        actionType: "continue",
        nextStatus: null
      });
      const safetyCheck = validateTransitionDecisionSafety(graph, missionStatus);
      if (!safetyCheck.ok) {
        return { ok: false, missionId, stepKey, reason: `Unsafe transition decision rejected: ${safetyCheck.reason}` };
      }

      const decision: AiTransitionDecision = {
        actionType: "continue",
        missionStatus,
        pauseRun: false,
        rationale: "Step completed — coordinator AI will decide next action.",
        interventionTitle: null,
        interventionBody: null,
        directives: {
          parallelismCap: null,
          disableHeuristicParallelism: false,
          retryBackoffMs: null,
          timeoutBudgetMs: null,
          stagnationThresholdMs: null,
          stepPriorities: []
        }
      };

      return {
        ok: true,
        graph,
        missionId,
        stepKey,
        decision
      };
    } catch (error) {
      return {
        ok: false,
        missionId: getMissionIdForRun(args.runId),
        stepKey: null,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  };

  const applyAIDecisionDirectives = (args: {
    runId: string;
    graph: OrchestratorRunGraph;
    completedStepId: string;
    decision: AiTransitionDecision;
  }) => {
    const directives = args.decision.directives;
    const disableHeuristicParallelism = directives.disableHeuristicParallelism || directives.parallelismCap != null;
    if (
      directives.parallelismCap == null &&
      directives.retryBackoffMs == null &&
      directives.timeoutBudgetMs == null &&
      directives.stagnationThresholdMs == null &&
      directives.stepPriorities.length === 0 &&
      !disableHeuristicParallelism
    ) {
      return;
    }

    updateRunMetadata(args.runId, (metadata) => {
      const aiDecisionMeta = isRecord(metadata.aiDecisions) ? { ...metadata.aiDecisions } : {};
      if (directives.parallelismCap != null) {
        aiDecisionMeta.parallelismCap = directives.parallelismCap;
      }
      if (directives.stagnationThresholdMs != null) {
        aiDecisionMeta.stagnationThresholdMs = directives.stagnationThresholdMs;
      }
      if (disableHeuristicParallelism) {
        aiDecisionMeta.disableHeuristicParallelism = true;
      }
      aiDecisionMeta.lastDecisionAt = nowIso();
      aiDecisionMeta.source = "ai_decision_service";
      metadata.aiDecisions = aiDecisionMeta;

      if (directives.parallelismCap != null) {
        const autopilot = isRecord(metadata.autopilot) ? { ...metadata.autopilot } : null;
        if (autopilot) {
          autopilot.parallelismCap = directives.parallelismCap;
          metadata.autopilot = autopilot;
        }
      }
    });

    if (directives.stepPriorities.length > 0) {
      for (const entry of directives.stepPriorities) {
        const step = args.graph.steps.find((candidate) => candidate.stepKey === entry.stepKey);
        if (!step) continue;
        const meta = isRecord(step.metadata) ? { ...step.metadata } : {};
        meta.priority = entry.priority;
        meta.aiPriority = entry.priority;
        if (entry.reason) {
          meta.aiPriorityReason = entry.reason;
        }
        if (entry.laneHint) {
          meta.aiPriorityLaneHint = entry.laneHint;
        } else if ("aiPriorityLaneHint" in meta) {
          delete meta.aiPriorityLaneHint;
        }
        db.run(
          `update orchestrator_steps set metadata_json = ?, updated_at = ? where id = ? and run_id = ?`,
          [JSON.stringify(meta), nowIso(), step.id, args.runId]
        );
      }
    }

    if (directives.retryBackoffMs != null) {
      const completedStep = args.graph.steps.find((step) => step.id === args.completedStepId);
      if (completedStep) {
        const meta = isRecord(completedStep.metadata) ? { ...completedStep.metadata } : {};
        meta.aiRetryBackoffMs = directives.retryBackoffMs;
        if (completedStep.status === "pending" || completedStep.status === "ready") {
          meta.lastRetryBackoffMs = directives.retryBackoffMs;
          meta.nextRetryAt = new Date(Date.now() + directives.retryBackoffMs).toISOString();
        }
        db.run(
          `update orchestrator_steps set metadata_json = ?, updated_at = ? where id = ? and run_id = ?`,
          [JSON.stringify(meta), nowIso(), completedStep.id, args.runId]
        );
      }
    }

    if (directives.timeoutBudgetMs != null) {
      const completedStep = args.graph.steps.find((step) => step.id === args.completedStepId);
      if (completedStep) {
        const meta = isRecord(completedStep.metadata) ? { ...completedStep.metadata } : {};
        meta.aiTimeoutMs = directives.timeoutBudgetMs;
        meta.ai_timeout_ms = directives.timeoutBudgetMs;
        db.run(
          `update orchestrator_steps set metadata_json = ?, updated_at = ? where id = ? and run_id = ?`,
          [JSON.stringify(meta), nowIso(), completedStep.id, args.runId]
        );
      }
    }
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

  const TERMINAL_PHASE_STEP_STATUSES = new Set<OrchestratorStepStatus>([
    "succeeded",
    "failed",
    "skipped",
    "superseded",
    "canceled"
  ]);

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
          const runPolicy = resolveActivePolicy(mission.id);
          const integrationPrPolicy = runPolicy.integrationPr ?? DEFAULT_INTEGRATION_PR_POLICY;
          const teamManifest = runTeamManifests.get(runId);
          const graphLaneCount = new Set(graph.steps.map((s) => s.laneId).filter(Boolean)).size;
          const usedMultipleLanes = (teamManifest && teamManifest.parallelLanes.length > 1) || graphLaneCount > 1;
          const prStrategy: PrStrategy =
            runPolicy.prStrategy
            ?? DEFAULT_EXECUTION_POLICY.prStrategy
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

  const handleStepCompletionTransition = async (args: { runId: string; stepId: string }) => {
    const decisionResult = await decideStepTransitionViaAiDecisionService({
      runId: args.runId,
      stepId: args.stepId
    });

    if (!decisionResult.ok) {
      const missionId = decisionResult.missionId ?? getMissionIdForRun(args.runId);
      if (missionId) {
        pauseRunWithIntervention({
          runId: args.runId,
          missionId,
          stepId: args.stepId,
          stepKey: decisionResult.stepKey,
          source: "transition_decision",
          reasonCode: "ai_decision_failed",
          title: "AI transition decision failed",
          body: `Unable to determine the next transition after step completion. Error: ${decisionResult.reason}`,
          requestedAction: "Review the run state and resume when a transition strategy is confirmed.",
          metadata: {
            failure: decisionResult.reason
          }
        });
        await syncMissionFromRun(args.runId, "ai_transition_decision_failed", {
          nextMissionStatus: "intervention_required"
        });
      }
      return;
    }

    const { graph, missionId, stepKey, decision } = decisionResult;
    try {
      applyAIDecisionDirectives({
        runId: args.runId,
        graph,
        completedStepId: args.stepId,
        decision
      });
    } catch (error) {
      pauseRunWithIntervention({
        runId: args.runId,
        missionId,
        stepId: args.stepId,
        stepKey,
        source: "transition_decision",
        reasonCode: "ai_directive_apply_failed",
        title: "AI transition directives could not be applied",
        body: `AI produced a transition decision, but runtime directives failed to apply: ${error instanceof Error ? error.message : String(error)}`,
        requestedAction: "Inspect step/runtime metadata and resume once directives are corrected."
      });
      await syncMissionFromRun(args.runId, "ai_transition_directives_failed", {
        nextMissionStatus: "intervention_required"
      });
      return;
    }

    if (decision.pauseRun) {
      const isReplanRequest = decision.actionType === "replan";
      const replanReason =
        decision.interventionBody
        ?? (decision.rationale || "AI requested mission replanning.");
      const replanAnalysis = isReplanRequest
        ? await requestMissionReplanAnalysis({
            missionId,
            runId: args.runId,
            stepId: args.stepId,
            stepKey,
            reason: replanReason,
            failureDigest: [
              `Transition action: ${decision.actionType}`,
              `Step: ${stepKey ?? args.stepId}`,
              `Reason: ${replanReason}`,
              `Latest failure: ${extractRunFailureMessage(graph) ?? "none"}`
            ].join("\n"),
            graph
          })
        : null;
      pauseRunWithIntervention({
        runId: args.runId,
        missionId,
        stepId: args.stepId,
        stepKey,
        source: "transition_decision",
        reasonCode: isReplanRequest ? "ai_requested_replan" : "ai_requested_pause",
        title: isReplanRequest
          ? "AI requested mission replanning"
          : (decision.interventionTitle ?? "AI requested operator intervention"),
        body: isReplanRequest && replanAnalysis
          ? formatReplanInterventionBody({
              reason: replanReason,
              analysis: replanAnalysis
            })
          : (decision.interventionBody ?? (decision.rationale || "AI requested a pause for manual intervention.")),
        requestedAction: isReplanRequest
          ? "Review the replan summary, update mission steps, then resume execution."
          : "Review AI rationale and provide guidance before resuming execution.",
        metadata: {
          rationale: decision.rationale,
          ...(replanAnalysis
            ? {
                replanShouldReplan: replanAnalysis.shouldReplan,
                replanSummary: replanAnalysis.summary,
                replanPlanDelta: replanAnalysis.planDelta,
                replanConfidence: replanAnalysis.confidence,
                replanError: replanAnalysis.error
              }
            : {})
        }
      });
    }

    // Deterministic timeout budget application removed — coordinator handles timeouts

    await syncMissionFromRun(args.runId, "ai_transition_decision_applied", {
      nextMissionStatus: decision.pauseRun ? "intervention_required" : decision.missionStatus
    });
  };

  type ParallelMissionStepDescriptor = {
    id: string;
    index: number;
    title: string;
    kind: string;
    laneId: string | null;
    stepType: string;
    stepKey: string;
    dependencyStepKeys: string[];
  };

  const parseNumericDependencyIndices = (metadata: Record<string, unknown>): number[] => {
    if (!Array.isArray(metadata.dependencyIndices)) return [];
    return metadata.dependencyIndices
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .map((value) => Math.floor(value));
  };

  const toStepKey = (step: MissionStep, position: number): string => {
    const metadata = isRecord(step.metadata) ? step.metadata : {};
    const explicit = typeof metadata.stepKey === "string" ? metadata.stepKey.trim() : "";
    if (explicit.length > 0) return explicit;
    return `mission_step_${step.index}_${position}`;
  };

  const slugify = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 28) || "lane";

  const isParallelCandidateStepType = (stepType: string): boolean => {
    const normalized = stepType.trim().toLowerCase();
    if (normalized === "analysis" || normalized === "summary" || normalized === "review") return false;
    if (normalized === "integration" || normalized === "merge") return false;
    return true;
  };

  const buildParallelDescriptors = (steps: MissionStep[]): ParallelMissionStepDescriptor[] => {
    const ordered = [...steps].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
    const keyed = ordered.map((step, position) => ({
      step,
      position,
      metadata: isRecord(step.metadata) ? step.metadata : {},
      stepKey: toStepKey(step, position)
    }));
    const stepKeysByIndex = new Map<number, string[]>();
    for (const entry of keyed) {
      const bucket = stepKeysByIndex.get(entry.step.index) ?? [];
      bucket.push(entry.stepKey);
      stepKeysByIndex.set(entry.step.index, bucket);
    }

    return keyed.map((entry) => {
      const metadata = entry.metadata;
      const explicitDeps = Array.isArray(metadata.dependencyStepKeys)
        ? metadata.dependencyStepKeys
            .map((value) => String(value ?? "").trim())
            .filter(Boolean)
        : [];
      const indexedDeps = parseNumericDependencyIndices(metadata).flatMap((depIdx) => stepKeysByIndex.get(depIdx) ?? []);
      const depSet = new Set([...explicitDeps, ...indexedDeps].filter((dep) => dep !== entry.stepKey));
      const stepType =
        typeof metadata.stepType === "string" && metadata.stepType.trim().length
          ? metadata.stepType.trim()
          : entry.step.kind;
      return {
        id: entry.step.id,
        index: entry.step.index,
        title: entry.step.title,
        kind: entry.step.kind,
        laneId: entry.step.laneId,
        stepType,
        stepKey: entry.stepKey,
        dependencyStepKeys: [...depSet]
      };
    });
  };

  const provisionParallelMissionLanes = async (args: {
    missionId: string;
    runMode?: "autopilot" | "manual";
  }): Promise<{ createdLaneIds: string[]; assignedSteps: number }> => {
    if (!laneService) return { createdLaneIds: [], assignedSteps: 0 };
    const mission = missionService.get(args.missionId);
    if (!mission) return { createdLaneIds: [], assignedSteps: 0 };
    if (mission.steps.length < 2) return { createdLaneIds: [], assignedSteps: 0 };

    const descriptors = buildParallelDescriptors(mission.steps);
    const baseLaneId = mission.laneId ?? descriptors.find((step) => step.laneId)?.laneId ?? null;
    if (!baseLaneId) return { createdLaneIds: [], assignedSteps: 0 };

    const laneStrategySignals = {
      candidateSteps: descriptors.filter((step) => isParallelCandidateStepType(step.stepType)).length,
      blockedSteps: descriptors.filter((step) => step.dependencyStepKeys.length > 0).length,
      dependencyEdges: descriptors.reduce((sum, step) => sum + step.dependencyStepKeys.length, 0),
      currentParallelLanes: Math.max(1, new Set(descriptors.map((step) => step.laneId).filter(Boolean)).size)
    };
    let laneStrategyDecision: {
      strategy: "single_lane" | "dependency_parallel" | "phase_parallel";
      maxParallelLanes: number;
      rationale: string;
      confidence: number;
      stepAssignments: Array<{
        stepKey: string;
        laneLabel: string;
        rationale?: string;
      }>;
    };
    // Lane strategy is now handled by the coordinator agent.
    // Deterministic fallback: assign all steps to a single lane.
    laneStrategyDecision = {
      strategy: "single_lane",
      maxParallelLanes: 1,
      rationale: "Deterministic single-lane fallback (coordinator handles lane decisions).",
      confidence: 1.0,
      stepAssignments: descriptors.map((descriptor) => ({
        stepKey: descriptor.stepKey,
        laneLabel: "main",
        rationale: "default assignment"
      }))
    };

    const descriptorByStepKey = new Map(descriptors.map((step) => [step.stepKey, step] as const));
    const assignmentsByStepKey = new Map<string, string>();
    for (const assignment of laneStrategyDecision.stepAssignments) {
      const stepKey = assignment.stepKey.trim();
      const laneLabel = assignment.laneLabel.trim();
      if (!stepKey || !laneLabel) continue;
      assignmentsByStepKey.set(stepKey, laneLabel);
    }
    const unknownAssignments = [...assignmentsByStepKey.keys()].filter((stepKey) => !descriptorByStepKey.has(stepKey));
    if (unknownAssignments.length > 0) {
      const message = `Lane strategy referenced unknown step keys: ${unknownAssignments.join(", ")}`;
      transitionMissionStatus(args.missionId, "intervention_required", { lastError: message });
      missionService.addIntervention({
        missionId: args.missionId,
        interventionType: "failed_step",
        title: "AI lane assignments are invalid",
        body: `${message}.`,
        requestedAction: "Review lane assignments and retry mission start."
      });
      throw new Error(message);
    }
    const missingAssignments = descriptors
      .filter((descriptor) => !assignmentsByStepKey.has(descriptor.stepKey))
      .map((descriptor) => descriptor.stepKey);
    if (missingAssignments.length > 0) {
      const message = `Lane strategy omitted assignments for steps: ${missingAssignments.join(", ")}`;
      transitionMissionStatus(args.missionId, "intervention_required", { lastError: message });
      missionService.addIntervention({
        missionId: args.missionId,
        interventionType: "failed_step",
        title: "AI lane assignments are incomplete",
        body: `${message}.`,
        requestedAction: "Review lane assignments and retry mission start."
      });
      throw new Error(message);
    }

    const ordered = [...descriptors].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
    const laneLabelToStepKeys = new Map<string, string[]>();
    for (const descriptor of ordered) {
      const laneLabel = assignmentsByStepKey.get(descriptor.stepKey)!;
      const bucket = laneLabelToStepKeys.get(laneLabel) ?? [];
      bucket.push(descriptor.stepKey);
      laneLabelToStepKeys.set(laneLabel, bucket);
    }

    const labels = [...laneLabelToStepKeys.keys()];
    if (labels.length === 0) {
      const message = "Lane strategy returned no lane labels.";
      transitionMissionStatus(args.missionId, "intervention_required", { lastError: message });
      missionService.addIntervention({
        missionId: args.missionId,
        interventionType: "failed_step",
        title: "AI lane assignments are invalid",
        body: message,
        requestedAction: "Review lane strategy output and retry mission start."
      });
      throw new Error(message);
    }
    const BASE_LABEL_ALIASES = new Set(["base", "main", "default", "mission", "primary"]);
    const baseLabels = labels.filter((label) => BASE_LABEL_ALIASES.has(label.trim().toLowerCase()));
    if (baseLabels.length !== 1) {
      const message = `Lane strategy must include exactly one base lane label (${[...BASE_LABEL_ALIASES].join(", ")}); received: ${labels.join(", ")}.`;
      transitionMissionStatus(args.missionId, "intervention_required", { lastError: message });
      missionService.addIntervention({
        missionId: args.missionId,
        interventionType: "failed_step",
        title: "AI lane assignments are invalid",
        body: message,
        requestedAction: "Review lane strategy output and retry mission start."
      });
      throw new Error(message);
    }
    const baseLabel = baseLabels[0]!;
    if (laneStrategyDecision.strategy === "single_lane" && labels.length !== 1) {
      const message = `Lane strategy is single_lane but produced ${labels.length} lane labels.`;
      transitionMissionStatus(args.missionId, "intervention_required", { lastError: message });
      missionService.addIntervention({
        missionId: args.missionId,
        interventionType: "failed_step",
        title: "AI lane assignments conflict with strategy",
        body: message,
        requestedAction: "Review lane strategy output and retry mission start."
      });
      throw new Error(message);
    }
    if (laneLabelToStepKeys.size > laneStrategyDecision.maxParallelLanes) {
      const message =
        `AI lane strategy produced ${laneLabelToStepKeys.size} lane groups, exceeding maxParallelLanes=${laneStrategyDecision.maxParallelLanes}.`;
      transitionMissionStatus(args.missionId, "intervention_required", { lastError: message });
      missionService.addIntervention({
        missionId: args.missionId,
        interventionType: "failed_step",
        title: "AI lane strategy exceeds lane limits",
        body: message,
        requestedAction: "Adjust lane strategy constraints and retry mission start."
      });
      throw new Error(message);
    }

    const createdLaneIds: string[] = [];
    const laneIdByLabel = new Map<string, string>();
    laneIdByLabel.set(baseLabel, baseLaneId);

    for (const label of labels) {
      if (laneIdByLabel.has(label)) continue;
      const assignedStepKeys = laneLabelToStepKeys.get(label) ?? [];
      const explicitLaneIds = [...new Set(assignedStepKeys
        .map((stepKey) => descriptorByStepKey.get(stepKey)?.laneId ?? null)
        .filter((laneId): laneId is string => typeof laneId === "string" && laneId.length > 0 && laneId !== baseLaneId))];
      if (explicitLaneIds.length > 1) {
        const message = `Lane assignment group "${label}" maps to multiple existing lanes (${explicitLaneIds.join(", ")}).`;
        transitionMissionStatus(args.missionId, "intervention_required", { lastError: message });
        missionService.addIntervention({
          missionId: args.missionId,
          interventionType: "failed_step",
          title: "AI lane assignments conflict with existing lanes",
          body: message,
          requestedAction: "Normalize lane assignments and retry mission start."
        });
        throw new Error(message);
      }
      if (explicitLaneIds.length === 1) {
        laneIdByLabel.set(label, explicitLaneIds[0]!);
        continue;
      }
      const firstStepKey = assignedStepKeys[0] ?? label;
      const firstStep = descriptorByStepKey.get(firstStepKey);
      const requestedName = `m-${args.missionId.slice(0, 6)}-${slugify(firstStep?.title || label)}-${createdLaneIds.length + 1}`;
      try {
        const child = await laneService.createChild({
          parentLaneId: baseLaneId,
          name: requestedName,
          description: `AI lane strategy group "${label}" for mission ${args.missionId}.`,
          folder: `Mission: ${mission.title}`
        });
        laneIdByLabel.set(label, child.id);
        createdLaneIds.push(child.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        transitionMissionStatus(args.missionId, "intervention_required", { lastError: message });
        missionService.addIntervention({
          missionId: args.missionId,
          interventionType: "failed_step",
          title: "Failed to create AI lane assignment",
          body: `Unable to create lane for assignment group "${label}". ${message}`,
          requestedAction: "Inspect lane setup and retry mission start."
        });
        throw error;
      }
    }

    const laneByStepId = new Map<string, string>();
    for (const step of ordered) {
      const laneLabel = assignmentsByStepKey.get(step.stepKey);
      if (!laneLabel) continue;
      const laneId = laneIdByLabel.get(laneLabel);
      if (!laneId) {
        const message = `AI lane assignment group "${laneLabel}" is unresolved for step ${step.stepKey}.`;
        transitionMissionStatus(args.missionId, "intervention_required", { lastError: message });
        missionService.addIntervention({
          missionId: args.missionId,
          interventionType: "failed_step",
          title: "AI lane assignments are invalid",
          body: message,
          requestedAction: "Review lane strategy output and retry mission start."
        });
        throw new Error(message);
      }
      laneByStepId.set(step.id, laneId);
    }

    let assignedSteps = 0;
    for (const step of ordered) {
      const nextLaneId = laneByStepId.get(step.id) ?? baseLaneId;
      const currentLaneId = step.laneId ?? baseLaneId;
      if (nextLaneId === currentLaneId) continue;
      db.run(
        `
          update mission_steps
          set lane_id = ?,
              updated_at = ?
          where id = ?
            and mission_id = ?
        `,
        [nextLaneId, nowIso(), step.id, args.missionId]
      );
      assignedSteps += 1;
      // stepId is omitted because these are mission-step IDs, not
      // orchestrator-step IDs — the orchestrator run hasn't been created
      // yet, so inserting them would violate the FK constraint on
      // orchestrator_lane_decisions.step_id -> orchestrator_steps.id.
      recordLaneDecision({
        missionId: args.missionId,
        stepKey: step.stepKey,
        laneId: nextLaneId,
        decisionType: "validated",
        validatorOutcome: "pass",
        ruleHits: ["parallel_lane_provisioning", "ai_lane_assignment"],
        rationale: `Assigned step ${step.stepKey} to lane ${nextLaneId} (from ${currentLaneId}).`,
        metadata: {
          strategy: laneStrategyDecision.strategy,
          laneLabel: assignmentsByStepKey.get(step.stepKey) ?? null,
          previousLaneId: currentLaneId,
          missionStepId: step.id,
          dependencyStepKeys: step.dependencyStepKeys,
          assignmentRationale:
            laneStrategyDecision.stepAssignments.find((assignment) => assignment.stepKey.trim() === step.stepKey)?.rationale
            ?? null
        }
      });
    }

    updateMissionMetadata(args.missionId, (metadata) => {
      metadata.parallelLanes = {
        enabled: true,
        createdLaneIds,
        assignedSteps,
        rootStepCount: descriptors.filter((step) => step.dependencyStepKeys.length === 0).length,
        parallelCandidateCount: labels.length,
        strategy: laneStrategyDecision.strategy,
        maxParallelLanes: laneStrategyDecision.maxParallelLanes,
        rationale: laneStrategyDecision.rationale,
        confidence: laneStrategyDecision.confidence,
        baseLaneId,
        aiAssignments: laneStrategyDecision.stepAssignments,
        updatedAt: nowIso()
      };
    });
    if (createdLaneIds.length > 0 || assignedSteps > 0) {
      emitOrchestratorMessage(
        args.missionId,
        `Parallel lane provisioning complete. ${createdLaneIds.length} new lane${createdLaneIds.length === 1 ? "" : "s"} created; ${assignedSteps} step lane assignments updated.`
      );
    } else {
      emitOrchestratorMessage(args.missionId, "AI lane strategy validated. Existing lane assignments were already aligned.");
    }

    return { createdLaneIds, assignedSteps };
  };

  // ── Team Synthesis Helpers ──────────────────────────────────
  const deriveScopeFromStepCount = (stepCount: number): TeamComplexityAssessment["estimatedScope"] => {
    if (stepCount <= 3) return "small";
    if (stepCount <= 8) return "medium";
    if (stepCount <= 20) return "large";
    return "very_large";
  };

  const inferRoleFromStepMetadata = (metadata: Record<string, unknown>, kind: string): OrchestratorWorkerRole => {
    const stepType = typeof metadata.stepType === "string" ? metadata.stepType.trim().toLowerCase() : "";
    const taskType = typeof metadata.taskType === "string" ? metadata.taskType.trim().toLowerCase() : "";
    const combined = `${stepType} ${taskType} ${kind}`.toLowerCase();
    if (combined.includes("test_review") || combined.includes("testreview")) return "test_review";
    if (combined.includes("review") || combined.includes("code_review")) return "code_review";
    if (combined.includes("test") || combined.includes("validation")) return "testing";
    if (combined.includes("plan")) return "planning";
    if (combined.includes("integration") || combined.includes("merge")) return "integration";
    if (combined.includes("merge")) return "merge";
    return "implementation";
  };

  const synthesizeTeamManifest = (opts: {
    missionId: string;
    mission: MissionDetail;
    policy: MissionExecutionPolicy;
    userPrompt: string;
    aiParallelismCap: number;
  }): TeamManifest => {
    const { missionId, mission, policy, userPrompt, aiParallelismCap } = opts;
    const steps = mission.steps;
    const descriptors = buildParallelDescriptors(steps);
    const decisionLog: TeamDecisionEntry[] = [];
    const now = nowIso();

    // ── Complexity assessment ──────────────────────────────────
    void userPrompt;
    const laneIds = new Set(descriptors.map((d) => d.laneId).filter(Boolean));
    const laneCount = Math.max(1, laneIds.size);
    const stepCount = steps.length;
    const estimatedScope = deriveScopeFromStepCount(stepCount);
    const domain: TeamComplexityAssessment["domain"] = "mixed";
    const parallelizable = Number.isFinite(Number(aiParallelismCap)) && Number(aiParallelismCap) > 1;
    const requiresIntegration = policy.integrationPr?.enabled === true || laneCount > 1;
    const fileZoneCount = laneCount;

    const complexity: TeamComplexityAssessment = {
      domain,
      estimatedScope,
      parallelizable,
      requiresIntegration,
      fileZoneCount,
      thoroughnessRequested: false
    };

    decisionLog.push({
      timestamp: now,
      decision: `Complexity assessed as ${estimatedScope} (${domain})`,
      reason: `${stepCount} steps, ${laneCount} lanes, parallelizable=${parallelizable}`,
      source: "complexity"
    });

    // ── Worker assignments ──────────────────────────────────────
    const workers: TeamWorkerAssignment[] = [];
    const roleCounters = new Map<OrchestratorWorkerRole, number>();

    for (const desc of descriptors) {
      const stepMeta = isRecord(steps.find((s) => s.id === desc.id)?.metadata) ? (steps.find((s) => s.id === desc.id)!.metadata as Record<string, unknown>) : {};
      const role = inferRoleFromStepMetadata(stepMeta, desc.kind);
      const count = (roleCounters.get(role) ?? 0) + 1;
      roleCounters.set(role, count);
      const workerId = `${role}_${count}`;
      workers.push({
        workerId,
        role,
        assignedStepKeys: [desc.stepKey],
        laneId: desc.laneId,
        executorKind: (typeof stepMeta.executorKind === "string" && (stepMeta.executorKind === "claude" || stepMeta.executorKind === "codex" || stepMeta.executorKind === "manual")
          ? stepMeta.executorKind as OrchestratorExecutorKind
          : "claude") as OrchestratorExecutorKind
      });
    }

    decisionLog.push({
      timestamp: now,
      decision: `Assigned ${workers.length} workers across ${roleCounters.size} roles`,
      reason: `Roles: ${[...roleCounters.entries()].map(([r, c]) => `${r}(${c})`).join(", ")}`,
      source: "dag_shape"
    });

    // ── AI-driven parallelism cap ───────────────────────────────
    const aiParallelismCapRaw = Number(aiParallelismCap);
    if (!Number.isFinite(aiParallelismCapRaw) || aiParallelismCapRaw <= 0) {
      throw new Error("AI parallelism cap must be a positive finite number.");
    }
    const normalizedAiParallelismCap = Math.floor(aiParallelismCapRaw);
    const parallelismCap = Math.max(1, Math.min(32, normalizedAiParallelismCap));

    decisionLog.push({
      timestamp: now,
      decision: `Parallelism cap set to ${parallelismCap} from AI decision`,
      reason: `AI provided mission-start cap ${normalizedAiParallelismCap}. Applied hard safety clamp to range [1, 32].`,
      source: "override"
    });

    // ── Parallel lane groupings ─────────────────────────────────
    const parallelLanes: string[][] = [];
    const laneGroupMap = new Map<string, string[]>();
    for (const w of workers) {
      if (!w.laneId) continue;
      const group = laneGroupMap.get(w.laneId) ?? [];
      group.push(w.workerId);
      laneGroupMap.set(w.laneId, group);
    }
    for (const group of laneGroupMap.values()) {
      if (group.length > 0) parallelLanes.push(group);
    }

    const rationale = `Team of ${workers.length} workers for ${estimatedScope} ${domain} mission. ` +
      `Parallelism cap: ${parallelismCap}. ` +
      (requiresIntegration ? "Integration phase included. " : "") +
      `${parallelLanes.length} parallel lane group${parallelLanes.length === 1 ? "" : "s"}.`;

    return {
      runId: "", // Will be set after run starts
      missionId,
      synthesizedAt: now,
      rationale,
      complexity,
      workers,
      parallelismCap,
      parallelLanes,
      decisionLog
    };
  };

  // ── Project Docs Discovery ──────────────────────────────────
  const discoverProjectDocs = (): { found: boolean; paths: string[]; contents: Record<string, string> } => {
    if (!projectRoot) return { found: false, paths: [], contents: {} };
    const candidatePaths = [
      "docs/PRD.md",
      "docs/prd.md",
      "PRD.md",
      "docs/architecture.md",
      "docs/ARCHITECTURE.md",
      "docs/architecture/README.md",
      "docs/final-plan.md",
      "docs/design.md",
      "ARCHITECTURE.md"
    ];
    const foundPaths: string[] = [];
    const contents: Record<string, string> = {};
    for (const candidate of candidatePaths) {
      const fullPath = `${projectRoot}/${candidate}`;
      try {
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, "utf-8");
          if (content.trim().length > 0) {
            foundPaths.push(candidate);
            // Cap at 8KB per doc to avoid bloating context
            contents[candidate] = content.slice(0, 8_192);
          }
        }
      } catch {
        // ignore read errors
      }
    }
    if (foundPaths.length > 0) {
      logger.debug("ai_orchestrator.project_docs_discovered", {
        count: foundPaths.length,
        paths: foundPaths
      });
    }
    return { found: foundPaths.length > 0, paths: foundPaths, contents };
  };

  // ── Helper: Build step inputs from mission_steps table ──────────
  const buildStepInputsFromMissionSteps = (buildArgs: {
    missionId: string;
    plannerStepKey: string;
    defaultExecutorKind?: OrchestratorExecutorKind;
    defaultRetryLimit?: number;
  }): StartOrchestratorRunStepInput[] => {
    const missionSteps = db.all<{
      id: string;
      step_index: number;
      title: string;
      detail: string | null;
      kind: string;
      lane_id: string | null;
      metadata_json: string | null;
    }>(
      `select id, step_index, title, detail, kind, lane_id, metadata_json
       from mission_steps
       where mission_id = ?
       order by step_index asc, created_at asc`,
      [buildArgs.missionId]
    );

    if (!missionSteps.length) return [];

    const fallbackExecutor = buildArgs.defaultExecutorKind ?? "unified";
    const fallbackRetryLimit = buildArgs.defaultRetryLimit ?? 2;

    const descriptors = missionSteps.map((row, index) => {
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(row.metadata_json || "{}"); } catch { /* empty */ }
      const stepIndex = Number.isFinite(Number(row.step_index)) ? Number(row.step_index) : index;
      const explicitKey = typeof metadata.stepKey === "string" ? (metadata.stepKey as string).trim() : "";
      const stepKey = explicitKey.length ? explicitKey : `mission_step_${stepIndex}_${index}`;
      return { row, index, metadata, stepIndex, stepKey };
    });

    return descriptors.map((desc) => {
      const { row, metadata } = desc;

      // Resolve dependencies from metadata or default to sequential
      let dependencyStepKeys: string[] = [];
      const hasExplicitDeps =
        Array.isArray(metadata.dependencyStepKeys) || Array.isArray(metadata.dependencyIndices);
      if (Array.isArray(metadata.dependencyStepKeys)) {
        dependencyStepKeys = (metadata.dependencyStepKeys as unknown[])
          .map((e) => String(e ?? "").trim())
          .filter((e) => e.length > 0 && e !== desc.stepKey);
      }
      if (!dependencyStepKeys.length && Array.isArray(metadata.dependencyIndices)) {
        const indices = (metadata.dependencyIndices as unknown[])
          .map((v) => Number(v))
          .filter((v) => Number.isFinite(v) && v >= 0);
        const stepKeysByIndex = new Map<number, string>();
        for (const d of descriptors) stepKeysByIndex.set(d.stepIndex, d.stepKey);
        dependencyStepKeys = indices
          .map((i) => stepKeysByIndex.get(i))
          .filter((k): k is string => k != null && k !== desc.stepKey);
      }
      if (!dependencyStepKeys.length && !hasExplicitDeps && desc.index > 0) {
        dependencyStepKeys = [descriptors[desc.index - 1]!.stepKey];
      }

      // Root steps (no other deps) depend on the planner step
      if (dependencyStepKeys.length === 0) {
        dependencyStepKeys = [buildArgs.plannerStepKey];
      }

      const executorKind: OrchestratorExecutorKind =
        typeof metadata.executorKind === "string"
          ? (metadata.executorKind as OrchestratorExecutorKind)
          : fallbackExecutor;

      const retryLimitRaw = Number(metadata.retryLimit);
      const retryLimit = Number.isFinite(retryLimitRaw)
        ? Math.max(0, Math.floor(retryLimitRaw))
        : Math.max(0, Math.floor(fallbackRetryLimit));

      const instructions =
        typeof metadata.instructions === "string" && metadata.instructions.trim().length
          ? metadata.instructions.trim()
          : typeof row.detail === "string" && row.detail.trim().length
            ? row.detail.trim()
            : "";

      return {
        missionStepId: row.id,
        stepKey: desc.stepKey,
        title: row.title,
        stepIndex: desc.stepIndex + 1, // offset: planner is step 0
        laneId: row.lane_id,
        dependencyStepKeys,
        retryLimit,
        executorKind,
        metadata: {
          ...metadata,
          instructions,
          stepType: String(metadata.stepType ?? row.kind ?? "manual"),
        }
      } as StartOrchestratorRunStepInput;
    });
  };

  // ── Post-planning continuation: add steps, start coordinator + autopilot ──
  const continueMissionExecution = async (ctx: {
    missionId: string;
    runId: string;
    plannerStepKey: string;
    provider: "claude" | "codex" | null;
    plannerModel: string | undefined;
    policy: MissionExecutionPolicy;
    runtimeProfile: MissionRuntimeProfile;
    config: ReturnType<typeof readConfig>;
    args: MissionRunStartArgs;
    initialMission: MissionDetail;
  }): Promise<void> => {
    const {
      missionId, runId, plannerStepKey, provider, plannerModel,
      policy, runtimeProfile, config, args, initialMission
    } = ctx;

    // ── Lane provisioning ──
    try {
      await provisionParallelMissionLanes({
        missionId,
        runMode: args.runMode
      });
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : String(error);
      logger.warn("ai_orchestrator.parallel_lane_provision_failed", {
        missionId,
        error: failureMessage
      });
      emitOrchestratorMessage(
        missionId,
        `Lane strategy decision failed: ${failureMessage}. Continuing with default lanes.`
      );
    }

    // ── Team Synthesis + Parallelism ──
    const mission = missionService.get(missionId) ?? initialMission;
    const plannerParallelismCap = resolveMissionParallelismCap(missionId);
    const laneStrategyParallelismCap = resolveMissionLaneStrategyParallelismCap(missionId);
    const laneCount = new Set(mission.steps.map((step) => step.laneId).filter(Boolean)).size;
    // Simple parallelism cap: take the minimum of configured caps, default to lane count or 4
    const caps = [plannerParallelismCap, laneStrategyParallelismCap, laneCount].filter(
      (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0
    );
    const missionStartAiParallelismCap = Math.max(1, Math.min(32, caps.length > 0 ? Math.min(...caps) : 4));
    updateMissionMetadata(missionId, (metadata) => {
      metadata.parallelismDecision = {
        cap: missionStartAiParallelismCap,
        rationale: "configured parallelism cap",
        confidence: 1.0,
        decidedAt: nowIso()
      };
    });

    const teamManifest = synthesizeTeamManifest({
      missionId,
      mission,
      policy,
      userPrompt: mission.prompt,
      aiParallelismCap: missionStartAiParallelismCap
    });

    const projectDocsContext = discoverProjectDocs();

    const parallelismCap = Math.max(1, Math.min(32, Math.floor(teamManifest.parallelismCap)));
    const resolvedExecutorKind: OrchestratorExecutorKind | undefined =
      args.defaultExecutorKind
      ?? (provider === "claude" || provider === "codex" ? provider : undefined);

    // ── Add planned steps to the existing run ──
    const stepInputs = buildStepInputsFromMissionSteps({
      missionId,
      plannerStepKey,
      defaultExecutorKind: resolvedExecutorKind,
      defaultRetryLimit: args.defaultRetryLimit ?? runtimeProfile.execution.defaultRetryLimit,
    });
    let addedSteps: OrchestratorStep[] = [];
    if (stepInputs.length) {
      addedSteps = orchestratorService.addSteps({ runId, steps: stepInputs });
    }

    // ── Update run metadata with team manifest + planning info ──
    try {
      const existingRunRow = db.get<{ metadata_json: string | null }>(
        `select metadata_json from orchestrator_runs where id = ?`,
        [runId]
      );
      const existingMeta = existingRunRow?.metadata_json
        ? JSON.parse(existingRunRow.metadata_json) as Record<string, unknown>
        : {};
      const updatedMeta = {
        ...existingMeta,
        plannerParallelismCap: parallelismCap,
        executionPolicy: policy,
        ...(projectDocsContext.found ? { projectDocsIncluded: true, projectDocPaths: projectDocsContext.paths } : {}),
        teamManifestSummary: {
          workerCount: teamManifest.workers.length,
          parallelismCap: teamManifest.parallelismCap,
          complexity: teamManifest.complexity.estimatedScope,
          domain: teamManifest.complexity.domain,
          roles: teamManifest.workers.map((w) => w.role)
        },
        runtimeProfile: {
          source: runtimeProfile.provenance.source,
          maxParallelWorkers: parallelismCap,
          stepTimeoutMs: runtimeProfile.execution.stepTimeoutMs,
          evaluateEveryStep: runtimeProfile.evaluation.evaluateEveryStep,
          autoAdjustPlan: runtimeProfile.evaluation.autoAdjustPlan,
          autoResolveInterventions: runtimeProfile.evaluation.autoResolveInterventions,
          interventionConfidenceThreshold: runtimeProfile.evaluation.interventionConfidenceThreshold,
          contextProfile: runtimeProfile.context.contextProfile,
          docsMode: runtimeProfile.context.docsMode
        }
      };
      db.run(
        `update orchestrator_runs set metadata_json = ?, updated_at = ? where id = ?`,
        [JSON.stringify(updatedMeta), nowIso(), runId]
      );
    } catch {
      // Non-fatal: metadata update failure doesn't block execution
    }

    // ── Cache runtime profile and team manifest ──
    runRuntimeProfiles.set(runId, runtimeProfile);
    teamManifest.runId = runId;
    runTeamManifests.set(runId, teamManifest);

    const plannerSummary = runtimeProfile.planning.useAiPlanner
      ? `Planner mode: AI${provider ? ` (${provider})` : ""}.`
      : "Planner mode: policy-off (using existing mission steps).";
    emitOrchestratorMessage(
      missionId,
      `Executing mission with ${addedSteps.length} steps. Profile: ${runtimeProfile.provenance.source}. ${plannerSummary}`
    );

    // ── Start Coordinator Agent + Team Runtime ──
      const coordinatorModelConfig = resolveOrchestratorModelConfig(missionId, "coordinator");
      const teamRuntimeConfigRaw = resolveMissionTeamRuntime(missionId) ?? policy.teamRuntime ?? null;
      const teamRuntimeConfig = teamRuntimeConfigRaw ? normalizeTeamRuntimeConfig(missionId, teamRuntimeConfigRaw) : null;

    if (teamRuntimeConfig?.enabled) {
      // Full team runtime: coordinator + teammates
      const missionGoal = initialMission.prompt || initialMission.title;
      void spawnTeamRuntime({
        runId,
        missionId,
        missionGoal,
        config: teamRuntimeConfig,
        coordinatorModelConfig,
      }).then(() => {
        // Transition run from bootstrapping to active
        const ts = nowIso();
        db.run(
          `update orchestrator_runs set status = 'active', updated_at = ? where id = ? and status in ('bootstrapping', 'queued', 'running')`,
          [ts, runId]
        );
        updateTeamRuntimePhase(runId, "executing");
      }).catch((error) => {
        logger.error("ai_orchestrator.team_runtime_spawn_failed", {
          missionId,
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
        updateTeamRuntimePhase(runId, "failed");
      });
    } else {
      // Single coordinator agent (no teammates)
      const missionGoal = initialMission.prompt || initialMission.title;
      const { userRules: soloRules, projectCtx: soloCtx, availableProviders: soloProviders, phases: soloPhases } = gatherCoordinatorContext(missionId, args);
      startCoordinatorAgentV2(missionId, runId, missionGoal, coordinatorModelConfig, {
        userRules: soloRules,
        projectContext: soloCtx,
        availableProviders: soloProviders,
        phases: soloPhases,
      });

      // Transition run to active
      const ts = nowIso();
      db.run(
        `update orchestrator_runs set status = 'active', updated_at = ? where id = ? and status in ('bootstrapping', 'queued', 'running')`,
        [ts, runId]
      );
    }

    void syncMissionFromRun(runId, "mission_run_started");

    // ── Start autopilot ──
    setTimeout(() => {
      void orchestratorService.startReadyAutopilotAttempts({
        runId,
        reason: "post_planner_ramp_up",
      }).catch(() => {});
    }, 300);

    // ── Execution watchdog ──
    setTimeout(() => {
      try {
        const graph = orchestratorService.getRunGraph({ runId });
        if (!graph) return;
        const runningAttempts = graph.attempts.filter(
          (a) => a.status === "running" && a.executorSessionId
        );
        if (runningAttempts.length === 0) return;
        let stalledCount = 0;
        for (const attempt of runningAttempts) {
          const sessionCheck = db.get<{ last_output_at: string | null; status: string | null }>(
            `select last_output_at, status from terminal_sessions where id = ? limit 1`,
            [attempt.executorSessionId]
          );
          const hasOutput = Boolean(sessionCheck?.last_output_at);
          const sessionStatus = sessionCheck?.status ?? "unknown";
          if (!hasOutput && sessionStatus !== "completed" && sessionStatus !== "exited") {
            stalledCount++;
          }
        }
        if (stalledCount > 0) {
          emitOrchestratorMessage(
            missionId,
            `Execution watchdog: ${stalledCount} of ${runningAttempts.length} running step${runningAttempts.length === 1 ? "" : "s"} ha${stalledCount === 1 ? "s" : "ve"} not produced output after 20s.`
          );
          void orchestratorService.startReadyAutopilotAttempts({
            runId,
            reason: "execution_watchdog"
          }).catch(() => {});
        }
      } catch (error) {
        logger.debug("ai_orchestrator.execution_watchdog_failed", {
          missionId,
          runId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }, 20_000);
  };

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
        startCoordinatorAgentV2(missionId, activeRun.id, missionGoal, coordinatorModelConfig, {
          userRules,
          projectContext: projectCtx,
          availableProviders,
          phases,
        });

        const ts = nowIso();
        db.run(
          `update orchestrator_runs set status = 'active', updated_at = ? where id = ? and status in ('bootstrapping', 'queued', 'paused')`,
          [ts, activeRun.id]
        );

        const steps = orchestratorService.listSteps(activeRun.id);
        return {
          blockedByPlanReview: false,
          started: { run: activeRun, steps },
          mission: missionService.get(missionId)
        };
      }
    }

    // ── Create run — just persistence, no planning ──
    const started = orchestratorService.startRun({
      missionId,
      steps: [],
      metadata: {
        ...(args.metadata ?? {}),
        missionGoal,
        missionPrompt: initialMission.prompt ?? "",
        aiFirst: true,
      }
    });

    // Mark run as active
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

    // ── Gather context for the coordinator ──
    const { userRules, projectCtx, availableProviders, phases } = gatherCoordinatorContext(missionId, args);

    // ── Spawn the coordinator — the AI brain takes over ──
    const coordinatorModelConfig = resolveOrchestratorModelConfig(missionId, "coordinator");
    startCoordinatorAgentV2(missionId, started.run.id, missionGoal, coordinatorModelConfig, {
      userRules,
      projectContext: projectCtx,
      availableProviders,
      phases,
    });

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
    if (typeof launch.laneStrategy === "string") userRules.laneStrategy = launch.laneStrategy;
    if (typeof launch.customInstructions === "string") userRules.customInstructions = launch.customInstructions;
    if (args.defaultExecutorKind) userRules.providerPreference = args.defaultExecutorKind;

    // Resolve and pass execution policy so the coordinator knows what phases
    // are enabled and what constraints to follow
    const policy = resolveActivePolicy(missionId);
    const executionPolicy: import("./coordinatorAgent").CoordinatorExecutionPolicy = {};
    if (policy.planning?.mode) executionPolicy.planningMode = policy.planning.mode;
    if (policy.testing?.mode) executionPolicy.testingMode = policy.testing.mode;
    if (policy.validation?.mode) executionPolicy.validationMode = policy.validation.mode;
    if (policy.codeReview?.mode) executionPolicy.codeReviewMode = policy.codeReview.mode;
    if (policy.testReview?.mode) executionPolicy.testReviewMode = policy.testReview.mode;
    if (policy.prStrategy?.kind) executionPolicy.prStrategy = policy.prStrategy.kind;
    if (policy.implementation?.model) executionPolicy.workerModel = policy.implementation.model;
    const coordinatorModelConfig = resolveOrchestratorModelConfig(missionId, "coordinator");
    if (coordinatorModelConfig) executionPolicy.coordinatorModel = modelConfigToServiceModel(coordinatorModelConfig);
    if (policy.recoveryLoop) {
      executionPolicy.recoveryEnabled = policy.recoveryLoop.enabled;
      executionPolicy.recoveryMaxIterations = policy.recoveryLoop.maxIterations;
    }
    // Pass budget limits if configured
    const budgetConfig = isRecord(launch.budgetConfig) ? launch.budgetConfig : null;
    if (budgetConfig) {
      if (typeof budgetConfig.maxCostUsd === "number") executionPolicy.budgetLimitUsd = budgetConfig.maxCostUsd;
      if (typeof budgetConfig.maxTokens === "number") executionPolicy.budgetLimitTokens = budgetConfig.maxTokens;
    }
    if (Object.keys(executionPolicy).length > 0) {
      userRules.executionPolicy = executionPolicy;
    }

    // Discover project docs
    const projectDocsContext = discoverProjectDocs();

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
        projectDocs: projectDocsContext.found ? projectDocsContext.contents : undefined,
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
                ?? (executorKindRaw === "claude" || executorKindRaw === "codex" || executorKindRaw === "shell" || executorKindRaw === "manual"
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
        void orchestratorService.startReadyAutopilotAttempts({
          runId,
          reason: "question_answered_resume"
        }).catch(() => {});
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

  const createContextCheckpoint = (args: {
    missionId: string;
    runId?: string | null;
    trigger: OrchestratorContextCheckpoint["trigger"];
    summary: string;
    source: OrchestratorContextCheckpoint["source"];
  }): OrchestratorContextCheckpoint | null => {
    const missionIdentity = getMissionIdentity(args.missionId);
    if (!missionIdentity) return null;
    const checkpoint: OrchestratorContextCheckpoint = {
      id: randomUUID(),
      missionId: args.missionId,
      runId: args.runId ?? null,
      trigger: args.trigger,
      summary: args.summary,
      source: {
        digestCount: Math.max(0, Math.floor(Number(args.source.digestCount) || 0)),
        chatMessageCount: Math.max(0, Math.floor(Number(args.source.chatMessageCount) || 0)),
        compressedMessageCount: Math.max(0, Math.floor(Number(args.source.compressedMessageCount) || 0))
      },
      createdAt: nowIso()
    };
    db.run(
      `
        insert into orchestrator_context_checkpoints(
          id,
          project_id,
          mission_id,
          run_id,
          trigger,
          summary,
          source_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        checkpoint.id,
        missionIdentity.projectId,
        checkpoint.missionId,
        checkpoint.runId,
        checkpoint.trigger,
        checkpoint.summary,
        JSON.stringify(checkpoint.source),
        checkpoint.createdAt
      ]
    );
    return checkpoint;
  };

  const recordLaneDecision = (args: {
    missionId: string;
    runId?: string | null;
    stepId?: string | null;
    stepKey?: string | null;
    laneId?: string | null;
    decisionType: OrchestratorLaneDecision["decisionType"];
    validatorOutcome: OrchestratorLaneDecision["validatorOutcome"];
    ruleHits?: string[];
    rationale: string;
    metadata?: Record<string, unknown> | null;
  }): OrchestratorLaneDecision | null => {
    const missionIdentity = getMissionIdentity(args.missionId);
    if (!missionIdentity) return null;
    const decision: OrchestratorLaneDecision = {
      id: randomUUID(),
      missionId: args.missionId,
      runId: args.runId ?? null,
      stepId: args.stepId ?? null,
      stepKey: args.stepKey ?? null,
      laneId: args.laneId ?? null,
      decisionType: args.decisionType,
      validatorOutcome: args.validatorOutcome,
      ruleHits: Array.isArray(args.ruleHits) ? args.ruleHits.slice(0, 64) : [],
      rationale: args.rationale,
      metadata: args.metadata ?? null,
      createdAt: nowIso()
    };
    db.run(
      `
        insert into orchestrator_lane_decisions(
          id,
          project_id,
          mission_id,
          run_id,
          step_id,
          step_key,
          lane_id,
          decision_type,
          validator_outcome,
          rule_hits_json,
          rationale,
          metadata_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        decision.id,
        missionIdentity.projectId,
        decision.missionId,
        decision.runId,
        decision.stepId,
        decision.stepKey,
        decision.laneId,
        decision.decisionType,
        decision.validatorOutcome,
        JSON.stringify(decision.ruleHits),
        decision.rationale,
        decision.metadata ? JSON.stringify(decision.metadata) : null,
        decision.createdAt
      ]
    );
    return decision;
  };

  const recordMissionMetricSample = (args: {
    missionId: string;
    runId?: string | null;
    attemptId?: string | null;
    metric: MissionMetricToggle | string;
    value: number;
    unit?: string | null;
    metadata?: Record<string, unknown> | null;
  }): MissionMetricSample | null => {
    const missionIdentity = getMissionIdentity(args.missionId);
    if (!missionIdentity) return null;
    const numericValue = Number(args.value);
    if (!Number.isFinite(numericValue)) return null;
    const sample: MissionMetricSample = {
      id: randomUUID(),
      missionId: args.missionId,
      runId: args.runId ?? null,
      attemptId: args.attemptId ?? null,
      metric: args.metric,
      value: numericValue,
      unit: args.unit ?? null,
      metadata: args.metadata ?? null,
      createdAt: nowIso()
    };
    db.run(
      `
        insert into orchestrator_metrics_samples(
          id,
          project_id,
          mission_id,
          run_id,
          attempt_id,
          metric,
          value,
          unit,
          metadata_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        sample.id,
        missionIdentity.projectId,
        sample.missionId,
        sample.runId,
        sample.attemptId,
        sample.metric,
        sample.value,
        sample.unit,
        sample.metadata ? JSON.stringify(sample.metadata) : null,
        sample.createdAt
      ]
    );
    emitThreadEvent({
      type: "metrics_updated",
      missionId: sample.missionId,
      runId: sample.runId ?? null,
      reason: "metric_sample",
      metadata: {
        metric: sample.metric,
        sampleId: sample.id
      }
    });
    return sample;
  };

  const normalizeDeliveryError = (error: unknown): string => {
    if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
    return String(error ?? "Unknown delivery failure");
  };

  const isBusyDeliveryError = (errorMessage: string): boolean => {
    const normalized = errorMessage.toLowerCase();
    return normalized.includes("turn is already active")
      || normalized.includes("already active")
      || normalized.includes("busy");
  };

  const isNoActiveTurnError = (errorMessage: string): boolean => {
    return /\bno active turn\b/i.test(errorMessage);
  };

  const computeWorkerRetryBackoffMs = (retryCount: number): number => {
    const exponent = Math.max(0, retryCount - 1);
    return Math.min(
      WORKER_MESSAGE_RETRY_BACKOFF_MAX_MS,
      WORKER_MESSAGE_RETRY_BACKOFF_BASE_MS * (2 ** exponent)
    );
  };

  const readWorkerDeliveryMetadata = (message: OrchestratorChatMessage): {
    metadata: Record<string, unknown>;
    workerDelivery: Record<string, unknown>;
    retries: number;
    maxRetries: number;
    nextRetryAtMs: number | null;
    interventionId: string | null;
    agentSessionId: string | null;
    inFlightAttemptId: string | null;
    inFlightAtMs: number | null;
    inFlightSessionId: string | null;
  } => {
    const metadata = isRecord(message.metadata) ? { ...message.metadata } : {};
    const workerDelivery = isRecord(metadata.workerDelivery) ? { ...(metadata.workerDelivery as Record<string, unknown>) } : {};
    const retries = Number.isFinite(Number(workerDelivery.retries))
      ? Math.max(0, Math.floor(Number(workerDelivery.retries)))
      : 0;
    const maxRetries = Number.isFinite(Number(workerDelivery.maxRetries))
      ? Math.max(1, Math.floor(Number(workerDelivery.maxRetries)))
      : WORKER_MESSAGE_RETRY_BUDGET;
    const nextRetryAtRaw = typeof workerDelivery.nextRetryAt === "string" ? workerDelivery.nextRetryAt : "";
    const parsedNextRetryAt = nextRetryAtRaw ? Date.parse(nextRetryAtRaw) : Number.NaN;
    const interventionId = typeof workerDelivery.interventionId === "string" && workerDelivery.interventionId.trim().length > 0
      ? workerDelivery.interventionId.trim()
      : null;
    const agentSessionId = typeof workerDelivery.agentSessionId === "string" && workerDelivery.agentSessionId.trim().length > 0
      ? workerDelivery.agentSessionId.trim()
      : null;
    const inFlightAttemptId = typeof workerDelivery.inFlightAttemptId === "string" && workerDelivery.inFlightAttemptId.trim().length > 0
      ? workerDelivery.inFlightAttemptId.trim()
      : null;
    const inFlightAtRaw = typeof workerDelivery.inFlightAt === "string" ? workerDelivery.inFlightAt : "";
    const parsedInFlightAt = inFlightAtRaw ? Date.parse(inFlightAtRaw) : Number.NaN;
    const inFlightSessionId = typeof workerDelivery.inFlightSessionId === "string" && workerDelivery.inFlightSessionId.trim().length > 0
      ? workerDelivery.inFlightSessionId.trim()
      : null;
    return {
      metadata,
      workerDelivery,
      retries,
      maxRetries,
      nextRetryAtMs: Number.isFinite(parsedNextRetryAt) ? parsedNextRetryAt : null,
      interventionId,
      agentSessionId,
      inFlightAttemptId,
      inFlightAtMs: Number.isFinite(parsedInFlightAt) ? parsedInFlightAt : null,
      inFlightSessionId
    };
  };

  const selectAttemptDeliveryContext = (whereClause: string, params: Array<string | null>): {
    attempt_id: string;
    run_id: string;
    step_id: string;
    step_key: string | null;
    lane_id: string | null;
    session_id: string | null;
    session_status: string | null;
    session_tool_type: string | null;
    executor_kind: string | null;
  } | null => {
    return db.get<{
      attempt_id: string;
      run_id: string;
      step_id: string;
      step_key: string | null;
      lane_id: string | null;
      session_id: string | null;
      session_status: string | null;
      session_tool_type: string | null;
      executor_kind: string | null;
    }>(
      `
        select
          a.id as attempt_id,
          a.run_id as run_id,
          a.step_id as step_id,
          s.step_key as step_key,
          s.lane_id as lane_id,
          a.executor_session_id as session_id,
          ts.status as session_status,
          ts.tool_type as session_tool_type,
          a.executor_kind as executor_kind
        from orchestrator_attempts a
        left join orchestrator_steps s on s.id = a.step_id
        left join terminal_sessions ts on ts.id = a.executor_session_id
        where ${whereClause}
        order by
          case a.status
            when 'running' then 0
            when 'queued' then 1
            when 'blocked' then 2
            else 3
          end,
          a.attempt_number desc,
          a.created_at desc
        limit 1
      `,
      params
    );
  };

  const resolveWorkerDeliveryContext = (message: OrchestratorChatMessage): WorkerDeliveryContext | null => {
    const thread = message.threadId ? getThreadById(message.missionId, message.threadId) : null;
    const baseTarget = message.target?.kind === "worker"
      ? message.target
      : thread?.threadType === "worker"
        ? {
            kind: "worker" as const,
            runId: thread.runId ?? null,
            stepId: thread.stepId ?? null,
            stepKey: thread.stepKey ?? null,
            attemptId: thread.attemptId ?? null,
            sessionId: thread.sessionId ?? null,
            laneId: thread.laneId ?? null
          }
        : null;
    if (!baseTarget) return null;

    const attemptCandidates = [
      toOptionalString(baseTarget.attemptId),
      toOptionalString(message.attemptId),
      toOptionalString(thread?.attemptId)
    ].filter((value): value is string => !!value);
    let attemptContext: ReturnType<typeof selectAttemptDeliveryContext> = null;
    for (const attemptId of attemptCandidates) {
      attemptContext = selectAttemptDeliveryContext(`a.id = ?`, [attemptId]);
      if (attemptContext) break;
    }

    const sessionCandidates = [
      toOptionalString(baseTarget.sessionId),
      toOptionalString(message.sourceSessionId),
      toOptionalString(thread?.sessionId)
    ].filter((value): value is string => !!value);
    if (!attemptContext) {
      for (const sessionId of sessionCandidates) {
        attemptContext = selectAttemptDeliveryContext(`a.executor_session_id = ?`, [sessionId]);
        if (attemptContext) break;
      }
    }
    if (!attemptContext) {
      const runId = toOptionalString(baseTarget.runId) ?? toOptionalString(thread?.runId) ?? toOptionalString(message.runId);
      const stepId = toOptionalString(baseTarget.stepId) ?? toOptionalString(thread?.stepId);
      if (runId && stepId) {
        attemptContext = selectAttemptDeliveryContext(`a.run_id = ? and a.step_id = ?`, [runId, stepId]);
      }
      if (!attemptContext && runId) {
        const stepKey = toOptionalString(baseTarget.stepKey) ?? toOptionalString(thread?.stepKey) ?? toOptionalString(message.stepKey);
        if (stepKey) {
          attemptContext = selectAttemptDeliveryContext(`a.run_id = ? and s.step_key = ?`, [runId, stepKey]);
        }
      }
    }
    if (!attemptContext) {
      const laneId = toOptionalString(baseTarget.laneId) ?? toOptionalString(thread?.laneId) ?? toOptionalString(message.laneId);
      if (laneId) {
        attemptContext = selectAttemptDeliveryContext(`s.lane_id = ? and a.executor_session_id is not null`, [laneId]);
      }
    }

    const runId =
      toOptionalString(baseTarget.runId)
      ?? toOptionalString(thread?.runId)
      ?? toOptionalString(message.runId)
      ?? toOptionalString(attemptContext?.run_id)
      ?? null;
    const stepId =
      toOptionalString(baseTarget.stepId)
      ?? toOptionalString(thread?.stepId)
      ?? toOptionalString(attemptContext?.step_id)
      ?? null;
    const stepKey =
      toOptionalString(baseTarget.stepKey)
      ?? toOptionalString(thread?.stepKey)
      ?? toOptionalString(message.stepKey)
      ?? toOptionalString(attemptContext?.step_key)
      ?? null;
    const attemptId =
      toOptionalString(baseTarget.attemptId)
      ?? toOptionalString(message.attemptId)
      ?? toOptionalString(thread?.attemptId)
      ?? toOptionalString(attemptContext?.attempt_id)
      ?? null;
    const laneId =
      toOptionalString(baseTarget.laneId)
      ?? toOptionalString(thread?.laneId)
      ?? toOptionalString(message.laneId)
      ?? toOptionalString(attemptContext?.lane_id)
      ?? null;
    const sessionId =
      toOptionalString(baseTarget.sessionId)
      ?? toOptionalString(message.sourceSessionId)
      ?? toOptionalString(thread?.sessionId)
      ?? toOptionalString(attemptContext?.session_id)
      ?? null;
    const sessionStatusFromDb = toOptionalString(attemptContext?.session_status)?.toLowerCase() ?? null;
    const trackedSessionStatus = sessionId
      ? toOptionalString(getTrackedSessionState(sessionId)?.status)?.toLowerCase() ?? null
      : null;
    const sessionStatus = sessionStatusFromDb ?? trackedSessionStatus;
    const sessionToolType = toOptionalString(attemptContext?.session_tool_type) ?? null;
    const executorKindRaw = toOptionalString(attemptContext?.executor_kind);
    const executorKind: OrchestratorExecutorKind | null =
      executorKindRaw === "claude" || executorKindRaw === "codex" || executorKindRaw === "shell" || executorKindRaw === "manual"
        ? executorKindRaw
        : null;
    const resolvedTarget: Extract<OrchestratorChatTarget, { kind: "worker" }> = {
      kind: "worker",
      runId,
      stepId,
      stepKey,
      attemptId,
      sessionId,
      laneId
    };
    return {
      missionId: message.missionId,
      threadId: message.threadId ?? missionThreadId(message.missionId),
      target: resolvedTarget,
      runId,
      stepId,
      stepKey,
      attemptId,
      laneId,
      sessionId,
      sessionStatus,
      sessionToolType,
      executorKind
    };
  };

  const persistThreadWorkerLinks = (context: WorkerDeliveryContext) => {
    db.run(
      `
        update orchestrator_chat_threads
        set
          run_id = coalesce(?, run_id),
          step_id = coalesce(?, step_id),
          step_key = coalesce(?, step_key),
          attempt_id = coalesce(?, attempt_id),
          session_id = coalesce(?, session_id),
          lane_id = coalesce(?, lane_id),
          updated_at = ?
        where mission_id = ?
          and id = ?
      `,
      [
        context.runId,
        context.stepId,
        context.stepKey,
        context.attemptId,
        context.sessionId,
        context.laneId,
        nowIso(),
        context.missionId,
        context.threadId
      ]
    );
  };

  const upsertWorkerDeliveryIntervention = (args: {
    message: OrchestratorChatMessage;
    context: WorkerDeliveryContext | null;
    retries: number;
    error: string;
  }): string | null => {
    const cooldownKey = args.message.id;
    const nowMs = Date.now();
    const lastMs = workerDeliveryInterventionCooldowns.get(cooldownKey) ?? 0;
    if (nowMs - lastMs < WORKER_MESSAGE_RETRY_INTERVENTION_COOLDOWN_MS) {
      return null;
    }
    const mission = missionService.get(args.message.missionId);
    if (!mission) return null;
    if (mission.status === "queued") {
      try {
        missionService.update({
          missionId: args.message.missionId,
          status: "in_progress"
        });
      } catch (error) {
        logger.debug("ai_orchestrator.worker_delivery_promote_mission_failed", {
          missionId: args.message.missionId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const existing = mission.interventions.find((entry) => {
      if (entry.status !== "open") return false;
      if (!isRecord(entry.metadata)) return false;
      return entry.metadata.sourceMessageId === args.message.id;
    });
    if (existing) {
      workerDeliveryInterventionCooldowns.set(cooldownKey, nowMs);
      return existing.id;
    }

    const workerLabel =
      toOptionalString(args.context?.stepKey)
      ?? toOptionalString(args.context?.attemptId)
      ?? toOptionalString(args.context?.sessionId)
      ?? "worker";
    const intervention = missionService.addIntervention({
      missionId: args.message.missionId,
      interventionType: "manual_input",
      title: `Worker delivery blocked: ${workerLabel}`,
      body: `Could not deliver operator guidance to ${workerLabel} after ${args.retries} retries. Latest error: ${args.error}`,
      requestedAction: "Open the worker thread and resend guidance once the worker session is available.",
      laneId: args.context?.laneId ?? args.message.laneId ?? null,
      pauseMission: false,
      metadata: {
        sourceMessageId: args.message.id,
        threadId: args.message.threadId ?? null,
        attemptId: args.context?.attemptId ?? args.message.attemptId ?? null,
        sessionId: args.context?.sessionId ?? args.message.sourceSessionId ?? null,
        runId: args.context?.runId ?? args.message.runId ?? null,
        workerDeliveryFailure: true
      }
    });
    workerDeliveryInterventionCooldowns.set(cooldownKey, nowMs);
    if (args.context?.runId) {
      recordRuntimeEvent({
        runId: args.context.runId,
        stepId: args.context.stepId,
        attemptId: args.context.attemptId,
        sessionId: args.context.sessionId,
        eventType: "intervention_opened",
        eventKey: `worker_delivery_intervention:${intervention.id}`,
        payload: {
          interventionId: intervention.id,
          sourceMessageId: args.message.id,
          retries: args.retries,
          error: args.error
        }
      });
    }
    emitOrchestratorMessage(
      args.message.missionId,
      `Worker guidance could not be delivered after ${args.retries} retries. I opened intervention "${intervention.title}" so you can recover it deterministically.`,
      args.context?.stepKey ?? args.message.stepKey ?? null,
      {
        sourceMessageId: args.message.id,
        interventionId: intervention.id,
        retries: args.retries
      }
    );
    return intervention.id;
  };

  const updateWorkerDeliveryState = (args: {
    message: OrchestratorChatMessage;
    context: WorkerDeliveryContext | null;
    state: OrchestratorChatDeliveryState;
    retries: number;
    maxRetries: number;
    error: string | null;
    method: "send" | "steer" | "queued" | "failed";
    nextRetryAt: string | null;
    interventionId?: string | null;
    deliverySessionId?: string | null;
  }): OrchestratorChatMessage => {
    const updated = updateChatMessage(args.message.id, (current) => {
      const deliveryMeta = readWorkerDeliveryMetadata(current);
      const metadata = deliveryMeta.metadata;
      metadata.workerDelivery = {
        ...(deliveryMeta.workerDelivery ?? {}),
        retries: args.retries,
        maxRetries: args.maxRetries,
        lastAttemptAt: nowIso(),
        lastMethod: args.method,
        lastError: args.error,
        nextRetryAt: args.nextRetryAt,
        deliveredAt: args.state === "delivered" ? nowIso() : null,
        interventionId: args.interventionId ?? deliveryMeta.interventionId ?? null,
        agentSessionId: args.deliverySessionId ?? deliveryMeta.agentSessionId ?? null,
        inFlightAttemptId: null,
        inFlightAt: null,
        inFlightSessionId: null
      };
      const contextTarget = args.context?.target ?? (current.target?.kind === "worker" ? current.target : null);
      const target =
        contextTarget && contextTarget.kind === "worker"
          ? {
              ...contextTarget,
              sessionId: args.deliverySessionId ?? contextTarget.sessionId ?? null
            }
          : contextTarget;
      return {
        ...current,
        target,
        deliveryState: args.state,
        sourceSessionId: args.deliverySessionId ?? args.context?.sessionId ?? current.sourceSessionId ?? null,
        attemptId: args.context?.attemptId ?? current.attemptId ?? null,
        laneId: args.context?.laneId ?? current.laneId ?? null,
        runId: args.context?.runId ?? current.runId ?? null,
        stepKey: args.context?.stepKey ?? current.stepKey ?? null,
        metadata
      };
    });
    return updated ?? args.message;
  };

  const markWorkerDeliveryInFlight = (args: {
    message: OrchestratorChatMessage;
    context: WorkerDeliveryContext | null;
    retries: number;
    maxRetries: number;
    deliverySessionId: string;
  }): OrchestratorChatMessage => {
    const inFlightAttemptId = `${args.message.id}:attempt:${args.retries + 1}`;
    const updated = updateChatMessage(args.message.id, (current) => {
      const deliveryMeta = readWorkerDeliveryMetadata(current);
      const metadata = deliveryMeta.metadata;
      metadata.workerDelivery = {
        ...(deliveryMeta.workerDelivery ?? {}),
        retries: args.retries,
        maxRetries: args.maxRetries,
        lastAttemptAt: nowIso(),
        lastMethod: "attempt",
        lastError: null,
        nextRetryAt: null,
        deliveredAt: null,
        interventionId: deliveryMeta.interventionId ?? null,
        agentSessionId: args.deliverySessionId,
        inFlightAttemptId,
        inFlightAt: nowIso(),
        inFlightSessionId: args.deliverySessionId
      };
      const contextTarget = args.context?.target ?? (current.target?.kind === "worker" ? current.target : null);
      const target =
        contextTarget && contextTarget.kind === "worker"
          ? {
              ...contextTarget,
              sessionId: args.deliverySessionId
            }
          : contextTarget;
      return {
        ...current,
        target,
        deliveryState: "queued",
        sourceSessionId: args.deliverySessionId,
        attemptId: args.context?.attemptId ?? current.attemptId ?? null,
        laneId: args.context?.laneId ?? current.laneId ?? null,
        runId: args.context?.runId ?? current.runId ?? null,
        stepKey: args.context?.stepKey ?? current.stepKey ?? null,
        metadata
      };
    });
    return updated ?? args.message;
  };

  const failWorkerDeliveryStaleInFlight = (args: {
    message: OrchestratorChatMessage;
    context: WorkerDeliveryContext | null;
    retries: number;
    maxRetries: number;
    ageMs: number;
  }): OrchestratorChatMessage => {
    const ageSeconds = Math.max(1, Math.floor(args.ageMs / 1_000));
    const error = `Delivery attempt remained in-flight for ${ageSeconds}s without confirmation; marking failed to avoid duplicate worker injection.`;
    const interventionId = upsertWorkerDeliveryIntervention({
      message: args.message,
      context: args.context,
      retries: Math.max(args.retries, args.maxRetries),
      error
    });
    const failed = updateWorkerDeliveryState({
      message: args.message,
      context: args.context,
      state: "failed",
      retries: Math.max(args.retries, args.maxRetries),
      maxRetries: args.maxRetries,
      error,
      method: "failed",
      nextRetryAt: null,
      interventionId
    });
    emitThreadEvent({
      type: "worker_replay",
      missionId: failed.missionId,
      threadId: failed.threadId ?? missionThreadId(failed.missionId),
      messageId: failed.id,
      runId: failed.runId ?? null,
      reason: "stale_inflight_failed"
    });
    return failed;
  };

  const resolveWorkerDeliverySession = async (args: {
    message: OrchestratorChatMessage;
    context: WorkerDeliveryContext | null;
    deliveryMeta: ReturnType<typeof readWorkerDeliveryMetadata>;
  }): Promise<WorkerDeliverySessionResolution> => {
    const providerHint =
      parseWorkerProviderHint(args.context?.executorKind)
      ?? parseWorkerProviderHint(args.context?.sessionToolType)
      ?? parseWorkerProviderHint(args.message.target?.kind === "worker" ? args.message.target.sessionId : null)
      ?? parseWorkerProviderHint(args.message.sourceSessionId)
      ?? null;
    if (!agentChatService) {
      return {
        sessionId: null,
        source: "mapped",
        providerHint,
        summary: null,
        error: "Agent chat service unavailable."
      };
    }
    const laneId = toOptionalString(args.context?.laneId) ?? toOptionalString(args.message.laneId);
    const sessions = await agentChatService.listSessions(laneId ?? undefined);
    const byId = new Map<string, AgentChatSessionSummaryEntry>();
    for (const summary of sessions) {
      const sessionId = toOptionalString(summary.sessionId);
      if (!sessionId) continue;
      byId.set(sessionId, summary);
    }

    const stickySessionId = toOptionalString(args.deliveryMeta.agentSessionId);
    if (stickySessionId) {
      const sticky = byId.get(stickySessionId);
      if (sticky) {
        return {
          sessionId: sticky.sessionId,
          source: "sticky",
          providerHint: parseWorkerProviderHint(sticky.provider) ?? providerHint,
          summary: sticky,
          error: null
        };
      }
    }

    const directCandidates = [
      toOptionalString(args.context?.sessionId),
      toOptionalString(args.message.sourceSessionId)
    ].filter((value): value is string => !!value);
    for (const candidate of directCandidates) {
      const summary = byId.get(candidate);
      if (!summary) continue;
      return {
        sessionId: summary.sessionId,
        source: "mapped",
        providerHint: parseWorkerProviderHint(summary.provider) ?? providerHint,
        summary,
        error: null
      };
    }

    if (!laneId) {
      return {
        sessionId: null,
        source: "lane_fallback",
        providerHint,
        summary: null,
        error: "No lane is mapped for this worker thread, so fallback delivery cannot choose a safe chat session."
      };
    }

    const providerScoped = providerHint
      ? sessions.filter((entry) => entry.provider === providerHint)
      : sessions;
    const activeProviderScoped = providerScoped.filter((entry) => entry.status !== "ended");
    if (activeProviderScoped.length === 1) {
      return {
        sessionId: activeProviderScoped[0].sessionId,
        source: "lane_fallback",
        providerHint,
        summary: activeProviderScoped[0],
        error: null
      };
    }
    if (activeProviderScoped.length > 1) {
      return {
        sessionId: null,
        source: "lane_fallback",
        providerHint,
        summary: null,
        error: "Multiple active worker chat sessions are available for this lane; specify a worker session target to avoid misdelivery."
      };
    }
    if (providerScoped.length === 1) {
      return {
        sessionId: providerScoped[0].sessionId,
        source: "lane_fallback",
        providerHint,
        summary: providerScoped[0],
        error: null
      };
    }
    if (providerScoped.length > 1) {
      return {
        sessionId: null,
        source: "lane_fallback",
        providerHint,
        summary: null,
        error: "Multiple worker chat sessions were found, but none are active. Resume a specific session or target one directly."
      };
    }

    return {
      sessionId: null,
      source: "lane_fallback",
      providerHint,
      summary: null,
      error: "No worker agent-chat session is currently mapped to this thread."
    };
  };

  const sendWorkerMessageToSession = async (sessionId: string, text: string): Promise<"send" | "steer"> => {
    if (!agentChatService) {
      throw new Error("Agent chat service unavailable.");
    }
    try {
      await agentChatService.sendMessage({
        sessionId,
        text
      });
      return "send";
    } catch (error) {
      const sendError = normalizeDeliveryError(error);
      if (!isBusyDeliveryError(sendError)) {
        throw error;
      }
      try {
        await agentChatService.steer({
          sessionId,
          text
        });
        return "steer";
      } catch (steerError) {
        const steerText = normalizeDeliveryError(steerError);
        if (isNoActiveTurnError(steerText)) {
          await agentChatService.sendMessage({
            sessionId,
            text
          });
          return "send";
        }
        throw steerError;
      }
    }
  };

  const deliverWorkerMessage = async (
    message: OrchestratorChatMessage,
    options?: { ignoreBackoff?: boolean }
  ): Promise<OrchestratorChatMessage> => {
    if (disposed) return message;
    const contextBase = resolveWorkerDeliveryContext(message);
    if (contextBase) {
      persistThreadWorkerLinks(contextBase);
    }
    const deliveryMeta = readWorkerDeliveryMetadata(message);
    if (!options?.ignoreBackoff && deliveryMeta.nextRetryAtMs != null && Date.now() < deliveryMeta.nextRetryAtMs) {
      return message;
    }
    if (deliveryMeta.inFlightAttemptId && deliveryMeta.inFlightAtMs != null) {
      const inFlightAgeMs = Date.now() - deliveryMeta.inFlightAtMs;
      if (inFlightAgeMs < WORKER_MESSAGE_INFLIGHT_LEASE_MS) {
        return message;
      }
      if (inFlightAgeMs >= WORKER_MESSAGE_INFLIGHT_STALE_FAIL_MS) {
        return failWorkerDeliveryStaleInFlight({
          message,
          context: contextBase,
          retries: Math.max(deliveryMeta.retries + 1, deliveryMeta.maxRetries),
          maxRetries: deliveryMeta.maxRetries,
          ageMs: inFlightAgeMs
        });
      }
    }

    if (!agentChatService) {
      return updateWorkerDeliveryState({
        message,
        context: contextBase,
        state: "queued",
        retries: deliveryMeta.retries,
        maxRetries: deliveryMeta.maxRetries,
        error: "Agent chat service is unavailable.",
        method: "queued",
        nextRetryAt: null
      });
    }

    let context: WorkerDeliveryContext | null = contextBase;
    let workingMessage = message;
    try {
      const sessionResolution = await resolveWorkerDeliverySession({
        message,
        context: contextBase,
        deliveryMeta
      });
      const resolvedSessionId = toOptionalString(sessionResolution.sessionId);
      context =
        contextBase && resolvedSessionId
          ? {
              ...contextBase,
              sessionId: resolvedSessionId,
              target: {
                ...contextBase.target,
                sessionId: resolvedSessionId
              }
            }
          : contextBase;

      if (contextBase && resolvedSessionId && contextBase.sessionId !== resolvedSessionId && context) {
        persistThreadWorkerLinks(context);
      }
      if (resolvedSessionId && sessionResolution.summary?.status === "ended") {
        try {
          await agentChatService.resumeSession({ sessionId: resolvedSessionId });
        } catch {
          // Best-effort resume path; final delivery attempt below determines state.
        }
      }

      const sessionId = resolvedSessionId;
      if (!sessionId) {
        throw new Error(sessionResolution.error ?? "No worker session is currently mapped to this thread.");
      }
      workingMessage = markWorkerDeliveryInFlight({
        message,
        context,
        retries: deliveryMeta.retries,
        maxRetries: deliveryMeta.maxRetries,
        deliverySessionId: sessionId
      });
      const deliveryMethod = await sendWorkerMessageToSession(sessionId, message.content);
      const delivered = updateWorkerDeliveryState({
        message: workingMessage,
        context,
        state: "delivered",
        retries: deliveryMeta.retries,
        maxRetries: deliveryMeta.maxRetries,
        error: null,
        method: deliveryMethod,
        nextRetryAt: null,
        deliverySessionId: sessionId
      });
      if (message.deliveryState === "queued" && delivered.deliveryState === "delivered") {
        const workerLabel =
          toOptionalString(context?.stepKey)
          ?? toOptionalString(context?.attemptId)
          ?? toOptionalString(context?.sessionId)
          ?? "worker";
        emitOrchestratorMessage(
          delivered.missionId,
          `Delivered queued worker guidance to ${workerLabel}.`,
          context?.stepKey ?? delivered.stepKey ?? null,
          {
            sourceMessageId: delivered.id,
            threadId: delivered.threadId ?? null,
            deliveryMethod
          }
        );
      }
      return delivered;
    } catch (error) {
      const failure = normalizeDeliveryError(error);
      const nextRetries = deliveryMeta.retries + 1;
      const exhausted = nextRetries >= deliveryMeta.maxRetries;
      if (exhausted) {
        const interventionId = upsertWorkerDeliveryIntervention({
          message: workingMessage,
          context,
          retries: nextRetries,
          error: failure
        });
        return updateWorkerDeliveryState({
          message: workingMessage,
          context,
          state: "failed",
          retries: nextRetries,
          maxRetries: deliveryMeta.maxRetries,
          error: failure,
          method: "failed",
          nextRetryAt: null,
          interventionId
        });
      }
      const nextRetryAt = new Date(Date.now() + computeWorkerRetryBackoffMs(nextRetries)).toISOString();
      return updateWorkerDeliveryState({
        message: workingMessage,
        context,
        state: "queued",
        retries: nextRetries,
        maxRetries: deliveryMeta.maxRetries,
        error: failure,
        method: "queued",
        nextRetryAt
      });
    }
  };

  const replayQueuedWorkerMessages = async (args: {
    reason: string;
    missionId?: string | null;
    threadId?: string | null;
    sessionId?: string | null;
  }): Promise<{ delivered: number; failed: number; queued: number }> => {
    if (disposed) return { delivered: 0, failed: 0, queued: 0 };
    const rows = db.all<{
      id: string;
      mission_id: string;
      role: string;
      content: string;
      timestamp: string;
      step_key: string | null;
      thread_id: string | null;
      thread_type: string | null;
      target_json: string | null;
      visibility: string | null;
      delivery_state: string | null;
      source_session_id: string | null;
      attempt_id: string | null;
      lane_id: string | null;
      run_id: string | null;
      metadata_json: string | null;
      created_at: string;
    }>(
      `
        select
          m.id as id,
          m.mission_id as mission_id,
          m.role as role,
          m.content as content,
          m.timestamp as timestamp,
          m.step_key as step_key,
          m.thread_id as thread_id,
          t.thread_type as thread_type,
          m.target_json as target_json,
          m.visibility as visibility,
          m.delivery_state as delivery_state,
          m.source_session_id as source_session_id,
          m.attempt_id as attempt_id,
          m.lane_id as lane_id,
          m.run_id as run_id,
          m.metadata_json as metadata_json,
          m.created_at as created_at
        from orchestrator_chat_messages m
        left join orchestrator_chat_threads t on t.id = m.thread_id
        where m.role = 'user'
          and m.delivery_state = 'queued'
          and (? is null or m.mission_id = ?)
          and (? is null or m.thread_id = ?)
        order by m.timestamp asc, m.created_at asc, m.id asc
      `,
      [
        args.missionId ?? null,
        args.missionId ?? null,
        args.threadId ?? null,
        args.threadId ?? null
      ]
    );

    const grouped = new Map<string, OrchestratorChatMessage[]>();
    for (const row of rows) {
      const parsed = parseChatMessageRow(row);
      if (!parsed) continue;
      const isWorkerThread = row.thread_type === "worker";
      if (parsed.target?.kind !== "worker" && !isWorkerThread) continue;
      const key = parsed.threadId ?? missionThreadId(parsed.missionId);
      const bucket = grouped.get(key) ?? [];
      bucket.push(parsed);
      grouped.set(key, bucket);
    }

    let delivered = 0;
    let failed = 0;
    let queued = 0;

    const threadEntries = Array.from(grouped.entries());
    const maxParallelThreads = 8;
    for (let batchIndex = 0; batchIndex < threadEntries.length; batchIndex += maxParallelThreads) {
      const batch = threadEntries.slice(batchIndex, batchIndex + maxParallelThreads);
      await Promise.all(
        batch.map(async ([threadId, messages]) => {
          const ignoreBackoff = args.reason.startsWith("runtime_signal") || args.reason.startsWith("agent_chat");
          const previous = workerDeliveryThreadQueues.get(threadId) ?? Promise.resolve();
          const next = previous
            .catch(() => undefined)
            .then(async () => {
              if (disposed) return;
              for (const candidate of messages) {
                if (disposed) return;
                const fresh = getChatMessageById(candidate.id);
                if (!fresh || fresh.deliveryState !== "queued") continue;
                const context = resolveWorkerDeliveryContext(fresh);
                if (args.sessionId) {
                  const signalSessionId = args.sessionId.trim();
                  if (signalSessionId.length > 0) {
                    const mapped = toOptionalString(context?.sessionId) ?? toOptionalString(fresh.sourceSessionId);
                    if (!mapped || mapped !== signalSessionId) continue;
                  }
                }
                const updated = await deliverWorkerMessage(fresh, {
                  ignoreBackoff
                });
                if (updated.deliveryState === "delivered") {
                  delivered += 1;
                  continue;
                }
                if (updated.deliveryState === "failed") {
                  failed += 1;
                  continue;
                }
                queued += 1;
                break;
              }
            })
            .catch((error) => {
              logger.debug("ai_orchestrator.worker_delivery_replay_failed", {
                reason: args.reason,
                threadId,
                error: error instanceof Error ? error.message : String(error)
              });
            })
            .finally(() => {
              if (workerDeliveryThreadQueues.get(threadId) === next) {
                workerDeliveryThreadQueues.delete(threadId);
              }
            });
          workerDeliveryThreadQueues.set(threadId, next);
          await next;
        })
      );
    }

    if ((delivered > 0 || failed > 0 || queued > 0) && args.missionId) {
      emitThreadEvent({
        type: "worker_replay",
        missionId: args.missionId,
        threadId: args.threadId ?? null,
        runId: null,
        reason: args.reason,
        metadata: {
          delivered,
          failed,
          queued,
          sessionId: args.sessionId ?? null
        }
      });
    }

    return { delivered, failed, queued };
  };

  const routeMessageToCoordinator = (message: OrchestratorChatMessage) => {
    const chatArgs: SendOrchestratorChatArgs = {
      missionId: message.missionId,
      content: message.content,
      threadId: message.threadId ?? missionThreadId(message.missionId),
      target: {
        kind: "coordinator",
        runId: message.runId ?? null
      },
      visibilityMode: message.visibility ?? DEFAULT_CHAT_VISIBILITY,
      metadata: message.metadata ?? null
    };
    const recentChatContext = formatRecentChatContext(chatMessages.get(message.missionId) ?? [message]);
    const statusIntent = /\b(status|progress|stuck|heartbeat|worker|lane)\b/i.test(message.content);
    if (statusIntent) {
      void (async () => {
        if (disposed) return;
        try {
          const sweep = await runHealthSweep("chat_status");
          if (disposed) return;
          const summary = summarizeRunForChat(message.missionId);
          const recoveryNote =
            sweep.staleRecovered > 0
              ? ` Recovered ${sweep.staleRecovered} stale attempt${sweep.staleRecovered === 1 ? "" : "s"} during health sweep.`
              : "";
          emitOrchestratorMessage(message.missionId, `${summary}${recoveryNote}`.trim());
        } catch {
          if (disposed) return;
          emitOrchestratorMessage(message.missionId, summarizeRunForChat(message.missionId));
        }
      })();
    }

    try {
      steerMission({
        missionId: message.missionId,
        directive: message.content,
        priority: "instruction",
        targetStepKey: message.target?.kind === "worker" ? message.target.stepKey ?? null : null
      });
    } catch {
      // Ignore missing mission / invalid status transitions and preserve chat UX.
    }

    if (aiIntegrationService && projectRoot) {
      enqueueChatResponse(chatArgs, recentChatContext);
    } else if (!statusIntent) {
      emitOrchestratorMessage(
        message.missionId,
        "Directive received. I will apply it at the next planning/evaluation decision point."
      );
    }
  };

  const maybeEmitWorkerQueuedNotice = (message: OrchestratorChatMessage, workerLabel: string, stepKey: string | null): void => {
    if (message.deliveryState !== "queued") return;
    void (async () => {
      if (disposed) return;
      let canResolveImmediately = false;
      if (agentChatService) {
        try {
          const latest = getChatMessageById(message.id) ?? message;
          if (latest.deliveryState !== "queued") return;
          const context = resolveWorkerDeliveryContext(latest);
          const deliveryMeta = readWorkerDeliveryMetadata(latest);
          const sessionResolution = await resolveWorkerDeliverySession({
            message: latest,
            context,
            deliveryMeta
          });
          canResolveImmediately = !!toOptionalString(sessionResolution.sessionId);
        } catch (error) {
          logger.debug("ai_orchestrator.worker_delivery_queue_probe_failed", {
            missionId: message.missionId,
            messageId: message.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      const fresh = getChatMessageById(message.id);
      if (!fresh || fresh.deliveryState !== "queued") return;
      if (canResolveImmediately) return;

      emitOrchestratorMessage(
        fresh.missionId,
        `Worker message queued for ${workerLabel}; delivery will resume once the worker session is available.`,
        stepKey ?? fresh.stepKey ?? null
      );
    })();
  };

  const routeMessageToWorker = (message: OrchestratorChatMessage) => {
    const target = message.target && message.target.kind === "worker" ? message.target : null;
    const workerLabel =
      toOptionalString(target?.stepKey)
      ?? toOptionalString(target?.stepId)
      ?? toOptionalString(target?.attemptId)
      ?? toOptionalString(target?.sessionId)
      ?? "worker";
    const coordinatorDigest =
      message.visibility === "full"
        ? `User sent worker guidance to ${workerLabel}: ${clipTextForContext(message.content, 300)}`
        : `User sent worker guidance to ${workerLabel}.`;
    emitOrchestratorMessage(
      message.missionId,
      coordinatorDigest,
      target?.stepKey ?? null,
      {
        threadId: message.threadId ?? null,
        sourceMessageId: message.id,
        visibility: message.visibility ?? DEFAULT_WORKER_CHAT_VISIBILITY,
        deliveryState: message.deliveryState ?? "queued",
        target
      }
    );
    if (message.deliveryState === "queued") {
      maybeEmitWorkerQueuedNotice(message, workerLabel, target?.stepKey ?? null);
    } else if (message.deliveryState === "failed") {
      emitOrchestratorMessage(
        message.missionId,
        `Worker message to ${workerLabel} failed delivery and needs intervention.`,
        target?.stepKey ?? null
      );
    }
  };

  const listChatThreads = (threadArgs: ListOrchestratorChatThreadsArgs): OrchestratorChatThread[] => {
    ensureMissionThread(threadArgs.missionId);
    const rows = db.all<{
      id: string;
      mission_id: string;
      thread_type: string;
      title: string;
      run_id: string | null;
      step_id: string | null;
      step_key: string | null;
      attempt_id: string | null;
      session_id: string | null;
      lane_id: string | null;
      status: string;
      unread_count: number | null;
      metadata_json: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `
        select
          id,
          mission_id,
          thread_type,
          title,
          run_id,
          step_id,
          step_key,
          attempt_id,
          session_id,
          lane_id,
          status,
          unread_count,
          metadata_json,
          created_at,
          updated_at
        from orchestrator_chat_threads
        where mission_id = ?
          and (? = 1 or status != 'closed')
        order by updated_at desc, created_at desc
      `,
      [threadArgs.missionId, threadArgs.includeClosed === true ? 1 : 0]
    );
    return rows.map((row) => parseThreadRow(row));
  };

  const getThreadMessages = (threadArgs: GetOrchestratorThreadMessagesArgs): OrchestratorChatMessage[] => {
    const thread = ensureThreadForTarget({
      missionId: threadArgs.missionId,
      threadId: threadArgs.threadId
    });
    if (!threadArgs.before) {
      db.run(
        `
          update orchestrator_chat_threads
          set unread_count = 0
          where mission_id = ?
            and id = ?
        `,
        [threadArgs.missionId, thread.id]
      );
      if (thread.unreadCount > 0) {
        emitThreadEvent({
          type: "thread_updated",
          missionId: threadArgs.missionId,
          threadId: thread.id,
          runId: thread.runId ?? null,
          reason: "thread_read"
        });
      }
    }
    const messages = loadChatMessagesFromDb({
      missionId: threadArgs.missionId,
      threadId: thread.id,
      limit: threadArgs.limit ?? MAX_PERSISTED_CHAT_MESSAGES,
      before: threadArgs.before ?? null
    });
    if (messages.length > 0) return messages;
    if (thread.threadType === "coordinator") {
      return (chatMessages.get(threadArgs.missionId) ?? loadChatMessagesFromMetadata(threadArgs.missionId))
        .filter((entry) => (entry.threadId ?? missionThreadId(threadArgs.missionId)) === thread.id)
        .slice(-clampLimit(threadArgs.limit, MAX_PERSISTED_CHAT_MESSAGES, 500));
    }
    return [];
  };

  const sendWorkersBroadcastMessage = (threadArgs: SendOrchestratorThreadMessageArgs, target: Extract<OrchestratorChatTarget, { kind: "workers" }>): OrchestratorChatMessage => {
    const missionThread = ensureMissionThread(threadArgs.missionId);
    const metadata = isRecord(threadArgs.metadata) ? threadArgs.metadata : null;
    const broadcastMessage = appendChatMessage({
      id: randomUUID(),
      missionId: threadArgs.missionId,
      role: "user",
      content: threadArgs.content,
      timestamp: nowIso(),
      threadId: missionThread.id,
      target,
      visibility: normalizeChatVisibility(threadArgs.visibilityMode, DEFAULT_CHAT_VISIBILITY),
      deliveryState: "delivered",
      sourceSessionId: null,
      attemptId: null,
      laneId: target.laneId ?? null,
      runId: target.runId ?? null,
      stepKey: null,
      metadata
    });

    const candidates = listChatThreads({
      missionId: threadArgs.missionId,
      includeClosed: target.includeClosed === true
    })
      .filter((thread) => thread.threadType === "worker")
      .filter((thread) => !target.runId || thread.runId === target.runId)
      .filter((thread) => !target.laneId || thread.laneId === target.laneId)
      .sort((a, b) => {
        const left = Date.parse(a.createdAt);
        const right = Date.parse(b.createdAt);
        if (left !== right) return left - right;
        return a.id.localeCompare(b.id);
      });

    if (!candidates.length) {
      emitOrchestratorMessage(
        threadArgs.missionId,
        "Worker broadcast queued no deliveries because no matching worker threads are currently available.",
        null,
        {
          sourceMessageId: broadcastMessage.id,
          target
        }
      );
      return broadcastMessage;
    }

    for (let index = 0; index < candidates.length; index += 1) {
      const thread = candidates[index]!;
      const workerTarget: OrchestratorChatTarget = {
        kind: "worker",
        runId: thread.runId ?? target.runId ?? null,
        stepId: thread.stepId ?? null,
        stepKey: thread.stepKey ?? null,
        attemptId: thread.attemptId ?? null,
        sessionId: thread.sessionId ?? null,
        laneId: thread.laneId ?? target.laneId ?? null
      };
      const nextMetadata: Record<string, unknown> = {
        ...(metadata ?? {}),
        workerBroadcast: {
          sourceMessageId: broadcastMessage.id,
          fanoutIndex: index + 1,
          fanoutTotal: candidates.length
        }
      };
      sendThreadMessage({
        missionId: threadArgs.missionId,
        threadId: thread.id,
        content: threadArgs.content,
        target: workerTarget,
        visibilityMode: normalizeChatVisibility(threadArgs.visibilityMode, DEFAULT_WORKER_CHAT_VISIBILITY),
        metadata: nextMetadata
      });
    }

    emitOrchestratorMessage(
      threadArgs.missionId,
      `Broadcast worker guidance to ${candidates.length} worker thread${candidates.length === 1 ? "" : "s"}.`,
      null,
      {
        sourceMessageId: broadcastMessage.id,
        target,
        deliveredThreads: candidates.map((thread) => thread.id)
      }
    );
    return broadcastMessage;
  };

  const sendThreadMessage = (threadArgs: SendOrchestratorThreadMessageArgs): OrchestratorChatMessage => {
    const target = sanitizeChatTarget(threadArgs.target);
    if (target?.kind === "workers") {
      return sendWorkersBroadcastMessage(threadArgs, target);
    }
    const thread = ensureThreadForTarget({
      missionId: threadArgs.missionId,
      threadId: threadArgs.threadId ?? null,
      target
    });
    const visibilityFallback = target?.kind === "worker" ? DEFAULT_WORKER_CHAT_VISIBILITY : DEFAULT_CHAT_VISIBILITY;
    const visibility = normalizeChatVisibility(threadArgs.visibilityMode, visibilityFallback);
    const deliveryState: OrchestratorChatDeliveryState =
      target?.kind === "worker" ? "queued" : DEFAULT_CHAT_DELIVERY;
    const msg = appendChatMessage({
      id: randomUUID(),
      missionId: threadArgs.missionId,
      role: "user",
      content: threadArgs.content,
      timestamp: nowIso(),
      threadId: thread.id,
      target: target ?? (thread.threadType === "coordinator" ? { kind: "coordinator", runId: thread.runId ?? null } : null),
      visibility,
      deliveryState,
      sourceSessionId: target?.kind === "worker" ? target.sessionId ?? null : null,
      attemptId: target?.kind === "worker" ? target.attemptId ?? null : null,
      laneId: target?.kind === "worker" ? target.laneId ?? null : null,
      runId: target?.runId ?? thread.runId ?? null,
      stepKey: target?.kind === "worker" ? target.stepKey ?? null : null,
      metadata: threadArgs.metadata ?? null
    });
    if ((chatMessages.get(threadArgs.missionId)?.length ?? 0) >= CONTEXT_CHECKPOINT_CHAT_THRESHOLD) {
      const total = chatMessages.get(threadArgs.missionId)?.length ?? 0;
      if (total % CONTEXT_CHECKPOINT_CHAT_THRESHOLD === 0) {
        createContextCheckpoint({
          missionId: threadArgs.missionId,
          runId: msg.runId ?? null,
          trigger: "step_threshold",
          summary: `Compressed mission chat context at ${total} messages.`,
          source: {
            digestCount: listWorkerDigests({ missionId: threadArgs.missionId, limit: 1_000 }).length,
            chatMessageCount: total,
            compressedMessageCount: Math.floor(total / 2)
          }
        });
      }
    }
    if (msg.target?.kind === "worker") {
      routeMessageToWorker(msg);
      void replayQueuedWorkerMessages({
        reason: "send_thread_message",
        missionId: threadArgs.missionId,
        threadId: msg.threadId ?? null,
        sessionId: msg.target.sessionId ?? null
      }).catch((error) => {
        logger.debug("ai_orchestrator.worker_delivery_replay_enqueue_failed", {
          missionId: threadArgs.missionId,
          threadId: msg.threadId ?? null,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    } else {
      routeMessageToCoordinator(msg);
    }
    return msg;
  };

  const sendChat = (chatArgs: SendOrchestratorChatArgs): OrchestratorChatMessage => {
    return sendThreadMessage({
      missionId: chatArgs.missionId,
      content: chatArgs.content,
      threadId: chatArgs.threadId ?? missionThreadId(chatArgs.missionId),
      target: chatArgs.target ?? { kind: "coordinator", runId: null },
      visibilityMode: chatArgs.visibilityMode ?? DEFAULT_CHAT_VISIBILITY,
      metadata: chatArgs.metadata ?? null
    });
  };

  const getChat = (chatArgs: GetOrchestratorChatArgs): OrchestratorChatMessage[] => {
    return getThreadMessages({
      missionId: chatArgs.missionId,
      threadId: missionThreadId(chatArgs.missionId),
      limit: MAX_PERSISTED_CHAT_MESSAGES
    });
  };

  const sendAgentMessage = (args: import("../../../shared/types").SendAgentMessageArgs): OrchestratorChatMessage => {
    const { missionId, fromAttemptId, toAttemptId, content, metadata } = args;

    // Find or create a thread for the source agent
    const sourceThread = ensureThreadForTarget({
      missionId,
      threadId: null,
      target: { kind: "worker", attemptId: fromAttemptId } as OrchestratorChatTarget
    });

    // Record message in source agent's thread
    const agentMsg = appendChatMessage({
      id: randomUUID(),
      missionId,
      role: "agent",
      content,
      timestamp: nowIso(),
      threadId: sourceThread.id,
      target: { kind: "agent", sourceAttemptId: fromAttemptId, targetAttemptId: toAttemptId },
      visibility: "full" as OrchestratorChatVisibilityMode,
      deliveryState: "delivered" as OrchestratorChatDeliveryState,
      sourceSessionId: null,
      attemptId: fromAttemptId,
      laneId: null,
      runId: sourceThread.runId ?? null,
      stepKey: null,
      metadata: metadata ?? null
    });

    // Also deliver to target agent's thread
    const targetThread = ensureThreadForTarget({
      missionId,
      threadId: null,
      target: { kind: "worker", attemptId: toAttemptId } as OrchestratorChatTarget
    });

    appendChatMessage({
      id: randomUUID(),
      missionId,
      role: "agent",
      content,
      timestamp: nowIso(),
      threadId: targetThread.id,
      target: { kind: "agent", sourceAttemptId: fromAttemptId, targetAttemptId: toAttemptId },
      visibility: "full" as OrchestratorChatVisibilityMode,
      deliveryState: "delivered" as OrchestratorChatDeliveryState,
      sourceSessionId: null,
      attemptId: fromAttemptId,
      laneId: null,
      runId: targetThread.runId ?? null,
      stepKey: null,
      metadata: { ...(metadata ?? {}), interAgentDelivery: true }
    });

    // Emit thread event so UI updates
    emitThreadEvent({
      type: "message_appended",
      missionId,
      threadId: sourceThread.id,
      messageId: agentMsg.id,
      reason: "agent_message"
    });
    emitThreadEvent({
      type: "message_appended",
      missionId,
      threadId: targetThread.id,
      messageId: agentMsg.id,
      reason: "agent_message_delivery"
    });

    return agentMsg;
  };

  // ── Inter-agent messaging: @mention parsing ──
  const parseMentions = (content: string): { mentions: string[]; cleanContent: string } => {
    const mentionRegex = /@([\w-]+)/g;
    const mentions: string[] = [];
    let match;
    while ((match = mentionRegex.exec(content)) !== null) {
      mentions.push(match[1]);
    }
    return { mentions, cleanContent: content };
  };

  // ── Inter-agent messaging: route message to mentioned agents ──
  const routeMessage = (message: OrchestratorChatMessage, mentions: string[]): void => {
    if (!message.missionId) return;
    const missionId = message.missionId;

    // Resolve active run to find agents
    const runs = orchestratorService.listRuns({ missionId });
    const activeRun = runs.find(
      (r) => r.status === "active" || r.status === "bootstrapping" || r.status === "queued" || r.status === "paused"
    );
    if (!activeRun) return;

    const isBroadcast = mentions.includes("all");

    if (isBroadcast) {
      // Deliver to all active workers
      for (const [, ws] of workerStates.entries()) {
        if (ws.runId !== activeRun.id || ws.state !== "working" || !ws.sessionId) continue;
        void deliverMessageToAgent({
          missionId,
          targetAttemptId: ws.attemptId,
          content: message.content,
          priority: "normal"
        });
      }
      return;
    }

    // Deliver to each specifically mentioned agent (by step key)
    const graph = orchestratorService.getRunGraph({ runId: activeRun.id, timelineLimit: 0 });
    for (const mention of mentions) {
      if (mention === "orchestrator") {
        // Messages to orchestrator are already in the chat system
        continue;
      }
      const targetStep = graph.steps.find((s) => s.stepKey === mention);
      if (!targetStep) continue;
      const targetWorker = [...workerStates.entries()].find(
        ([, ws]) => ws.stepId === targetStep.id && ws.runId === activeRun.id && ws.state === "working"
      );
      if (targetWorker) {
        void deliverMessageToAgent({
          missionId,
          targetAttemptId: targetWorker[1].attemptId,
          content: message.content,
          priority: "normal"
        });
      }
    }
  };

  // ── Inter-agent messaging: deliver message to a running agent ──
  const deliverMessageToAgent = async (args: {
    missionId: string;
    targetAttemptId: string;
    content: string;
    priority?: "normal" | "urgent";
    fromAttemptId?: string | null;
  }): Promise<{ delivered: boolean; method: string }> => {
    const ws = workerStates.get(args.targetAttemptId);
    if (!ws) {
      return { delivered: false, method: "not_found" };
    }

    const priority = args.priority ?? "normal";
    const prefix = args.fromAttemptId ? `[Message from ${args.fromAttemptId}] ` : "[Team message] ";
    const formattedContent = `${prefix}${args.content}`;

    // For agents with an active session (both CLI-wrapped and SDK), use the existing delivery mechanism
    if (ws.sessionId && agentChatService) {
      try {
        if (priority === "urgent") {
          // Use steer for urgent messages — injects immediately even if agent is busy
          try {
            await agentChatService.steer({ sessionId: ws.sessionId, text: formattedContent });
            return { delivered: true, method: "steer" };
          } catch {
            // Fall through to sendMessage
          }
        }
        const method = await sendWorkerMessageToSession(ws.sessionId, formattedContent);
        return { delivered: true, method };
      } catch (error) {
        logger.debug("ai_orchestrator.deliver_message_to_agent_failed", {
          missionId: args.missionId,
          targetAttemptId: args.targetAttemptId,
          sessionId: ws.sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // For SDK agents without an active session, queue the message
    const { enqueuePendingMessage } = require("../ai/unifiedExecutor") as typeof import("../ai/unifiedExecutor");
    const sessionKey = ws.sessionId ?? `pending-${args.targetAttemptId}`;
    enqueuePendingMessage(sessionKey, {
      id: randomUUID(),
      content: formattedContent,
      fromAttemptId: args.fromAttemptId ?? null,
      priority,
      receivedAt: nowIso()
    });
    return { delivered: true, method: "queued" };
  };

  // ── Global chat: all messages for a mission across all threads ──
  const getGlobalChat = (args: import("../../../shared/types").GetGlobalChatArgs): OrchestratorChatMessage[] => {
    const limit = Math.min(Math.max(args.limit ?? 200, 1), 1000);
    return loadChatMessagesFromDb({
      missionId: args.missionId,
      threadId: null, // null = all threads
      limit,
      before: args.since ? null : null // since is used as a floor, not a ceiling
    }).filter((msg) => {
      if (!args.since) return true;
      return Date.parse(msg.timestamp) >= Date.parse(args.since);
    });
  };

  // ── Active agents: list for @mention autocomplete ──
  const getActiveAgents = (args: import("../../../shared/types").GetActiveAgentsArgs): import("../../../shared/types").ActiveAgentInfo[] => {
    const result: import("../../../shared/types").ActiveAgentInfo[] = [];
    // Find active run for the mission
    const runs = orchestratorService.listRuns({ missionId: args.missionId });
    const activeRun = runs.find(
      (r) => r.status === "active" || r.status === "bootstrapping" || r.status === "queued" || r.status === "paused"
    );
    if (!activeRun) return result;

    let graph: OrchestratorRunGraph | null = null;
    try {
      graph = orchestratorService.getRunGraph({ runId: activeRun.id, timelineLimit: 0 });
    } catch {
      return result;
    }

    for (const [, ws] of workerStates.entries()) {
      if (ws.runId !== activeRun.id) continue;
      if (ws.state !== "working" && ws.state !== "waiting_input" && ws.state !== "idle") continue;
      const step = graph.steps.find((s) => s.id === ws.stepId);
      result.push({
        attemptId: ws.attemptId,
        stepId: ws.stepId,
        stepKey: step?.stepKey ?? null,
        runId: ws.runId,
        sessionId: ws.sessionId,
        state: ws.state,
        executorKind: ws.executorKind
      });
    }
    return result;
  };

  // ── Wire @mention parsing into sendAgentMessage flow ──
  const sendAgentMessageWithMentions = (agentMsgArgs: import("../../../shared/types").SendAgentMessageArgs): OrchestratorChatMessage => {
    const msg = sendAgentMessage(agentMsgArgs);
    const { mentions } = parseMentions(agentMsgArgs.content);
    if (mentions.length > 0) {
      routeMessage(msg, mentions);
    }
    return msg;
  };

  const parseWorkerDigestRow = (row: {
    id: string;
    mission_id: string;
    run_id: string;
    step_id: string;
    step_key: string | null;
    attempt_id: string;
    lane_id: string | null;
    session_id: string | null;
    status: string;
    summary: string;
    files_changed_json: string | null;
    tests_run_json: string | null;
    warnings_json: string | null;
    tokens_json: string | null;
    cost_usd: number | null;
    suggested_next_actions_json: string | null;
    created_at: string;
  }): OrchestratorWorkerDigest => {
    const filesChanged = parseJsonArray(row.files_changed_json).map((value) => String(value ?? "")).filter(Boolean);
    const warnings = parseJsonArray(row.warnings_json).map((value) => String(value ?? "")).filter(Boolean);
    const suggestions = parseJsonArray(row.suggested_next_actions_json).map((value) => String(value ?? "")).filter(Boolean);
    const testsParsed = parseJsonRecord(row.tests_run_json);
    const testsRun = {
      passed: Math.max(0, Math.floor(Number(testsParsed?.passed) || 0)),
      failed: Math.max(0, Math.floor(Number(testsParsed?.failed) || 0)),
      skipped: Math.max(0, Math.floor(Number(testsParsed?.skipped) || 0)),
      summary: typeof testsParsed?.summary === "string" ? testsParsed.summary : null
    };
    const tokensParsed = parseJsonRecord(row.tokens_json);
    const tokens = tokensParsed
      ? {
          input: Number.isFinite(Number(tokensParsed.input)) ? Number(tokensParsed.input) : undefined,
          output: Number.isFinite(Number(tokensParsed.output)) ? Number(tokensParsed.output) : undefined,
          total: Number.isFinite(Number(tokensParsed.total)) ? Number(tokensParsed.total) : undefined
        }
      : null;
    const status =
      row.status === "succeeded" || row.status === "failed" || row.status === "blocked" || row.status === "running" || row.status === "queued"
        ? row.status
        : "queued";
    return {
      id: row.id,
      missionId: row.mission_id,
      runId: row.run_id,
      stepId: row.step_id,
      stepKey: row.step_key ?? null,
      attemptId: row.attempt_id,
      laneId: row.lane_id ?? null,
      sessionId: row.session_id ?? null,
      status,
      summary: row.summary,
      filesChanged,
      testsRun,
      warnings,
      tokens,
      costUsd: Number.isFinite(Number(row.cost_usd)) ? Number(row.cost_usd) : null,
      suggestedNextActions: suggestions,
      createdAt: row.created_at
    };
  };

  const emitWorkerDigest = (digest: OrchestratorWorkerDigest): OrchestratorWorkerDigest => {
    const missionIdentity = getMissionIdentity(digest.missionId);
    if (!missionIdentity) return digest;
    db.run(
      `
        insert into orchestrator_worker_digests(
          id,
          project_id,
          mission_id,
          run_id,
          step_id,
          step_key,
          attempt_id,
          lane_id,
          session_id,
          status,
          summary,
          files_changed_json,
          tests_run_json,
          warnings_json,
          tokens_json,
          cost_usd,
          suggested_next_actions_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        digest.id,
        missionIdentity.projectId,
        digest.missionId,
        digest.runId,
        digest.stepId,
        digest.stepKey,
        digest.attemptId,
        digest.laneId,
        digest.sessionId,
        digest.status,
        digest.summary,
        JSON.stringify(digest.filesChanged ?? []),
        JSON.stringify(digest.testsRun ?? { passed: 0, failed: 0, skipped: 0 }),
        JSON.stringify(digest.warnings ?? []),
        digest.tokens ? JSON.stringify(digest.tokens) : null,
        digest.costUsd ?? null,
        JSON.stringify(digest.suggestedNextActions ?? []),
        digest.createdAt
      ]
    );
    emitThreadEvent({
      type: "worker_digest_updated",
      missionId: digest.missionId,
      runId: digest.runId,
      threadId: null,
      reason: "worker_digest",
      metadata: {
        digestId: digest.id,
        attemptId: digest.attemptId,
        stepId: digest.stepId
      }
    });
    return digest;
  };

  const listWorkerDigests = (digestArgs: ListOrchestratorWorkerDigestsArgs): OrchestratorWorkerDigest[] => {
    const limit = clampLimit(digestArgs.limit, 100, 500);
    const rows = db.all<{
      id: string;
      mission_id: string;
      run_id: string;
      step_id: string;
      step_key: string | null;
      attempt_id: string;
      lane_id: string | null;
      session_id: string | null;
      status: string;
      summary: string;
      files_changed_json: string | null;
      tests_run_json: string | null;
      warnings_json: string | null;
      tokens_json: string | null;
      cost_usd: number | null;
      suggested_next_actions_json: string | null;
      created_at: string;
    }>(
      `
        select
          id,
          mission_id,
          run_id,
          step_id,
          step_key,
          attempt_id,
          lane_id,
          session_id,
          status,
          summary,
          files_changed_json,
          tests_run_json,
          warnings_json,
          tokens_json,
          cost_usd,
          suggested_next_actions_json,
          created_at
        from orchestrator_worker_digests
        where mission_id = ?
          and (? is null or run_id = ?)
          and (? is null or step_id = ?)
          and (? is null or attempt_id = ?)
          and (? is null or lane_id = ?)
        order by created_at desc
        limit ?
      `,
      [
        digestArgs.missionId,
        digestArgs.runId ?? null,
        digestArgs.runId ?? null,
        digestArgs.stepId ?? null,
        digestArgs.stepId ?? null,
        digestArgs.attemptId ?? null,
        digestArgs.attemptId ?? null,
        digestArgs.laneId ?? null,
        digestArgs.laneId ?? null,
        limit
      ]
    );
    return rows.map((row) => parseWorkerDigestRow(row));
  };

  const getWorkerDigest = (digestArgs: GetOrchestratorWorkerDigestArgs): OrchestratorWorkerDigest | null => {
    const row = db.get<{
      id: string;
      mission_id: string;
      run_id: string;
      step_id: string;
      step_key: string | null;
      attempt_id: string;
      lane_id: string | null;
      session_id: string | null;
      status: string;
      summary: string;
      files_changed_json: string | null;
      tests_run_json: string | null;
      warnings_json: string | null;
      tokens_json: string | null;
      cost_usd: number | null;
      suggested_next_actions_json: string | null;
      created_at: string;
    }>(
      `
        select
          id,
          mission_id,
          run_id,
          step_id,
          step_key,
          attempt_id,
          lane_id,
          session_id,
          status,
          summary,
          files_changed_json,
          tests_run_json,
          warnings_json,
          tokens_json,
          cost_usd,
          suggested_next_actions_json,
          created_at
        from orchestrator_worker_digests
        where mission_id = ?
          and id = ?
        limit 1
      `,
      [digestArgs.missionId, digestArgs.digestId]
    );
    return row ? parseWorkerDigestRow(row) : null;
  };

  const getContextCheckpoint = (checkpointArgs: GetOrchestratorContextCheckpointArgs): OrchestratorContextCheckpoint | null => {
    const row = db.get<{
      id: string;
      mission_id: string;
      run_id: string | null;
      trigger: string;
      summary: string;
      source_json: string | null;
      created_at: string;
    }>(
      `
        select
          id,
          mission_id,
          run_id,
          trigger,
          summary,
          source_json,
          created_at
        from orchestrator_context_checkpoints
        where mission_id = ?
          and (? is null or id = ?)
        order by created_at desc
        limit 1
      `,
      [checkpointArgs.missionId, checkpointArgs.checkpointId ?? null, checkpointArgs.checkpointId ?? null]
    );
    if (!row) return null;
    const trigger =
      row.trigger === "step_threshold"
      || row.trigger === "pressure_soft"
      || row.trigger === "pressure_hard"
      || row.trigger === "status_request"
      || row.trigger === "manual"
        ? row.trigger
        : "manual";
    const source = parseJsonRecord(row.source_json);
    return {
      id: row.id,
      missionId: row.mission_id,
      runId: row.run_id ?? null,
      trigger,
      summary: row.summary,
      source: {
        digestCount: Math.max(0, Math.floor(Number(source?.digestCount) || 0)),
        chatMessageCount: Math.max(0, Math.floor(Number(source?.chatMessageCount) || 0)),
        compressedMessageCount: Math.max(0, Math.floor(Number(source?.compressedMessageCount) || 0))
      },
      createdAt: row.created_at
    };
  };

  const listLaneDecisions = (laneArgs: ListOrchestratorLaneDecisionsArgs): OrchestratorLaneDecision[] => {
    const limit = clampLimit(laneArgs.limit, 100, 500);
    const rows = db.all<{
      id: string;
      mission_id: string;
      run_id: string | null;
      step_id: string | null;
      step_key: string | null;
      lane_id: string | null;
      decision_type: string;
      validator_outcome: string;
      rule_hits_json: string | null;
      rationale: string;
      metadata_json: string | null;
      created_at: string;
    }>(
      `
        select
          id,
          mission_id,
          run_id,
          step_id,
          step_key,
          lane_id,
          decision_type,
          validator_outcome,
          rule_hits_json,
          rationale,
          metadata_json,
          created_at
        from orchestrator_lane_decisions
        where mission_id = ?
          and (? is null or run_id = ?)
          and (? is null or step_id = ?)
        order by created_at desc
        limit ?
      `,
      [
        laneArgs.missionId,
        laneArgs.runId ?? null,
        laneArgs.runId ?? null,
        laneArgs.stepId ?? null,
        laneArgs.stepId ?? null,
        limit
      ]
    );
    return rows.map((row) => {
      const decisionType =
        row.decision_type === "proposal" || row.decision_type === "validated" || row.decision_type === "override" || row.decision_type === "replan"
          ? row.decision_type
          : "proposal";
      const validatorOutcome =
        row.validator_outcome === "pass" || row.validator_outcome === "fail" || row.validator_outcome === "warn"
          ? row.validator_outcome
          : "warn";
      return {
        id: row.id,
        missionId: row.mission_id,
        runId: row.run_id ?? null,
        stepId: row.step_id ?? null,
        stepKey: row.step_key ?? null,
        laneId: row.lane_id ?? null,
        decisionType,
        validatorOutcome,
        ruleHits: parseJsonArray(row.rule_hits_json).map((entry) => String(entry ?? "")).filter(Boolean),
        rationale: row.rationale,
        metadata: parseJsonRecord(row.metadata_json),
        createdAt: row.created_at
      };
    });
  };

  const setMissionMetricsConfig = (configArgs: SetMissionMetricsConfigArgs): MissionMetricsConfig => {
    const missionIdentity = getMissionIdentity(configArgs.missionId);
    if (!missionIdentity) throw new Error(`Mission not found: ${configArgs.missionId}`);
    const deduped: MissionMetricToggle[] = [];
    const seen = new Set<string>();
    for (const toggle of configArgs.toggles ?? []) {
      const normalized = String(toggle ?? "").trim();
      if (!normalized.length || seen.has(normalized)) continue;
      if (!KNOWN_METRIC_TOGGLES.has(normalized as MissionMetricToggle)) continue;
      seen.add(normalized);
      deduped.push(normalized as MissionMetricToggle);
    }
    const toggles = deduped.length > 0 ? deduped : [...DEFAULT_METRIC_TOGGLES];
    const config: MissionMetricsConfig = {
      missionId: configArgs.missionId,
      toggles,
      updatedAt: nowIso()
    };
    db.run(
      `
        insert into mission_metrics_config(
          mission_id,
          project_id,
          toggles_json,
          updated_at
        ) values (?, ?, ?, ?)
        on conflict(mission_id) do update set
          toggles_json = excluded.toggles_json,
          updated_at = excluded.updated_at
      `,
      [config.missionId, missionIdentity.projectId, JSON.stringify(config.toggles), config.updatedAt]
    );
    emitThreadEvent({
      type: "metrics_updated",
      missionId: config.missionId,
      runId: null,
      reason: "metrics_config",
      metadata: {
        toggles: config.toggles
      }
    });
    return config;
  };

  const getMissionMetrics = (metricArgs: GetMissionMetricsArgs): {
    config: MissionMetricsConfig | null;
    samples: MissionMetricSample[];
  } => {
    const configRow = db.get<{ toggles_json: string | null; updated_at: string | null }>(
      `
        select toggles_json, updated_at
        from mission_metrics_config
        where mission_id = ?
        limit 1
      `,
      [metricArgs.missionId]
    );
    const config: MissionMetricsConfig | null = configRow
      ? {
          missionId: metricArgs.missionId,
          toggles: parseJsonArray(configRow.toggles_json)
            .map((entry) => String(entry ?? ""))
            .filter((entry): entry is MissionMetricToggle => KNOWN_METRIC_TOGGLES.has(entry as MissionMetricToggle)),
          updatedAt: configRow.updated_at ?? nowIso()
        }
      : null;
    const limit = clampLimit(metricArgs.limit, 200, 1_000);
    const sampleRows = db.all<{
      id: string;
      mission_id: string;
      run_id: string | null;
      attempt_id: string | null;
      metric: string;
      value: number;
      unit: string | null;
      metadata_json: string | null;
      created_at: string;
    }>(
      `
        select
          id,
          mission_id,
          run_id,
          attempt_id,
          metric,
          value,
          unit,
          metadata_json,
          created_at
        from orchestrator_metrics_samples
        where mission_id = ?
          and (? is null or run_id = ?)
        order by created_at desc
        limit ?
      `,
      [metricArgs.missionId, metricArgs.runId ?? null, metricArgs.runId ?? null, limit]
    );
    const samples: MissionMetricSample[] = sampleRows.map((row) => ({
      id: row.id,
      missionId: row.mission_id,
      runId: row.run_id ?? null,
      attemptId: row.attempt_id ?? null,
      metric: row.metric,
      value: Number(row.value ?? 0),
      unit: row.unit ?? null,
      metadata: parseJsonRecord(row.metadata_json),
      createdAt: row.created_at
    }));
    return {
      config,
      samples
    };
  };

  const backfillLegacyThreadMessages = (missionId: string): number => {
    const missionIdentity = getMissionIdentity(missionId);
    if (!missionIdentity) return 0;
    const legacy = loadChatMessagesFromMetadata(missionId);
    if (!legacy.length) return 0;
    const existingIds = new Set(
      db.all<{ id: string }>(
        `
          select id
          from orchestrator_chat_messages
          where mission_id = ?
        `,
        [missionId]
      ).map((entry) => String(entry.id))
    );
    let inserted = 0;
    for (const message of legacy) {
      if (existingIds.has(message.id)) continue;
      const thread = ensureThreadForTarget({
        missionId,
        threadId: message.threadId ?? null,
        target: message.target ?? null
      });
      db.run(
        `
          insert into orchestrator_chat_messages(
            id,
            project_id,
            mission_id,
            thread_id,
            role,
            content,
            timestamp,
            step_key,
            target_json,
            visibility,
            delivery_state,
            source_session_id,
            attempt_id,
            lane_id,
            run_id,
            metadata_json,
            created_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          message.id,
          missionIdentity.projectId,
          missionId,
          thread.id,
          message.role,
          message.content,
          message.timestamp,
          message.stepKey ?? null,
          message.target ? JSON.stringify(message.target) : null,
          normalizeChatVisibility(message.visibility),
          normalizeChatDeliveryState(message.deliveryState),
          message.sourceSessionId ?? null,
          message.attemptId ?? null,
          message.laneId ?? null,
          message.runId ?? null,
          message.metadata ? JSON.stringify(message.metadata) : null,
          message.timestamp
        ]
      );
      existingIds.add(message.id);
      inserted += 1;
    }
    return inserted;
  };

  const reconcileMissingThreadRows = (missionId: string): number => {
    const orphans = db.all<{
      thread_id: string;
      target_json: string | null;
    }>(
      `
        select distinct
          m.thread_id as thread_id,
          m.target_json as target_json
        from orchestrator_chat_messages m
        left join orchestrator_chat_threads t on t.id = m.thread_id
        where m.mission_id = ?
          and t.id is null
      `,
      [missionId]
    );
    let repaired = 0;
    for (const orphan of orphans) {
      const threadId = toOptionalString(orphan.thread_id);
      if (!threadId) continue;
      ensureThreadForTarget({
        missionId,
        threadId,
        target: parseChatTarget(parseJsonRecord(orphan.target_json))
      });
      repaired += 1;
    }
    return repaired;
  };

  const reconcileWorkerThreadLinks = (missionId: string): number => {
    const rows = db.all<{
      id: string;
      run_id: string | null;
      step_id: string | null;
      step_key: string | null;
      attempt_id: string | null;
      session_id: string | null;
      lane_id: string | null;
    }>(
      `
        select
          id,
          run_id,
          step_id,
          step_key,
          attempt_id,
          session_id,
          lane_id
        from orchestrator_chat_threads
        where mission_id = ?
          and thread_type = 'worker'
      `,
      [missionId]
    );
    let repaired = 0;
    for (const row of rows) {
      const latestMessage = loadChatMessagesFromDb({
        missionId,
        threadId: row.id,
        limit: 1
      })[0] ?? null;
      const synthetic: OrchestratorChatMessage = latestMessage ?? {
        id: `reconcile:${row.id}`,
        missionId,
        role: "orchestrator",
        content: "Thread link reconciliation",
        timestamp: nowIso(),
        threadId: row.id,
        target: {
          kind: "worker",
          runId: row.run_id ?? null,
          stepId: row.step_id ?? null,
          stepKey: row.step_key ?? null,
          attemptId: row.attempt_id ?? null,
          sessionId: row.session_id ?? null,
          laneId: row.lane_id ?? null
        },
        visibility: "metadata_only",
        deliveryState: "queued",
        sourceSessionId: row.session_id ?? null,
        attemptId: row.attempt_id ?? null,
        laneId: row.lane_id ?? null,
        runId: row.run_id ?? null,
        stepKey: row.step_key ?? null,
        metadata: null
      };
      const context = resolveWorkerDeliveryContext(synthetic);
      if (!context) continue;
      persistThreadWorkerLinks(context);
      repaired += 1;
    }
    return repaired;
  };

  const reconcileUnreadSanity = (missionId: string): number => {
    const threads = db.all<{ id: string; unread_count: number | null }>(
      `
        select id, unread_count
        from orchestrator_chat_threads
        where mission_id = ?
      `,
      [missionId]
    );
    let updated = 0;
    for (const thread of threads) {
      const totalNonUser = db.get<{ count: number }>(
        `
          select count(1) as count
          from orchestrator_chat_messages
          where thread_id = ?
            and role != 'user'
        `,
        [thread.id]
      );
      const total = Math.max(0, Math.floor(Number(totalNonUser?.count) || 0));
      const current = Number.isFinite(Number(thread.unread_count))
        ? Math.floor(Number(thread.unread_count))
        : total;
      const normalized = Math.min(total, Math.max(0, current));
      if (normalized === current) continue;
      db.run(
        `
          update orchestrator_chat_threads
          set unread_count = ?
          where mission_id = ?
            and id = ?
        `,
        [normalized, missionId, thread.id]
      );
      updated += 1;
    }
    return updated;
  };

  const reconcileThreadedMessagingState = async (): Promise<void> => {
    if (disposed) return;
    const missions = db.all<{ id: string }>(
      `
        select id
        from missions
        order by created_at asc
      `
    );
    let legacyBackfilled = 0;
    let missingThreadsRepaired = 0;
    let linksRepaired = 0;
    let unreadNormalized = 0;

    for (const mission of missions) {
      if (disposed) return;
      const missionId = toOptionalString(mission.id);
      if (!missionId) continue;
      ensureMissionThread(missionId);
      legacyBackfilled += backfillLegacyThreadMessages(missionId);
      missingThreadsRepaired += reconcileMissingThreadRows(missionId);
      linksRepaired += reconcileWorkerThreadLinks(missionId);
      unreadNormalized += reconcileUnreadSanity(missionId);
    }

    if (legacyBackfilled > 0 || missingThreadsRepaired > 0 || linksRepaired > 0 || unreadNormalized > 0) {
      logger.info("ai_orchestrator.chat_reconciliation_complete", {
        missions: missions.length,
        legacyBackfilled,
        missingThreadsRepaired,
        linksRepaired,
        unreadNormalized
      });
    }

    await replayQueuedWorkerMessages({
      reason: "startup"
    });
  };

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
      .catch(() => undefined)
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
      .catch(() => undefined)
      .then(async () => {
        if (disposed) return;
        await replayQueuedWorkerMessages({
          reason: `agent_chat:${event.type}`,
          sessionId
        });
      })
      .catch((error) => {
        logger.debug("ai_orchestrator.agent_chat_replay_failed", {
          sessionId,
          eventType: event.type,
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

  // ── Execution Plan Preview ──────────────────────────────────
  const getExecutionPlanPreview = (previewArgs: { runId: string }): ExecutionPlanPreview | null => {
    const runId = previewArgs.runId;
    try {
      const graph = orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
      const mission = missionService.get(graph.run.missionId);
      if (!mission) return null;

      const teamManifest = runTeamManifests.get(runId);
      const runMeta = isRecord(graph.run.metadata) ? graph.run.metadata : {};
      const policy = isRecord(runMeta.executionPolicy) ? (runMeta.executionPolicy as MissionExecutionPolicy) : resolveActivePolicy(graph.run.missionId);
      const recoveryPolicy: RecoveryLoopPolicy = policy.recoveryLoop ?? DEFAULT_RECOVERY_LOOP_POLICY;
      const integrationPrPlan: IntegrationPrPolicy = policy.integrationPr ?? DEFAULT_INTEGRATION_PR_POLICY;

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
            : workerAssignment?.executorKind ?? "claude";
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
          : "claude";
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

  // Quality gate evaluation and recovery loop coordination removed —
  // these are the coordinator AI's responsibility. It evaluates quality
  // through its persistent conversation and decides recovery actions.

  // Stub kept for API compatibility — callers should migrate to coordinator tools.
  const handleQualityGateFailure = async (_gateArgs: {
    runId: string;
    stepId: string;
    phase: string;
    reason: string;
  }): Promise<{ triggered: boolean; exhausted: boolean; iteration: number }> => {
    // No-op: quality gate recovery is now the coordinator AI's domain
    return { triggered: false, exhausted: false, iteration: 0 };
  };

  // ── Aggregated Usage Stats ──────────────────────────────────
  const USAGE_TOKEN_COST: Record<string, { input: number; output: number }> = {
    "claude-opus": { input: 5 / 1_000_000, output: 25 / 1_000_000 },
    "claude-sonnet": { input: 3 / 1_000_000, output: 15 / 1_000_000 },
    "claude-haiku": { input: 0.8 / 1_000_000, output: 4 / 1_000_000 },
    "codex": { input: 2 / 1_000_000, output: 8 / 1_000_000 },
    "codex-mini": { input: 0.3 / 1_000_000, output: 1.2 / 1_000_000 },
    "default": { input: 3 / 1_000_000, output: 15 / 1_000_000 }
  };
  function estimateTokenCost(model: string, inputTokens: number, outputTokens: number): number {
    const lower = (model ?? "").toLowerCase();
    let rate = USAGE_TOKEN_COST["default"];
    if (lower.includes("opus")) rate = USAGE_TOKEN_COST["claude-opus"];
    else if (lower.includes("sonnet")) rate = USAGE_TOKEN_COST["claude-sonnet"];
    else if (lower.includes("haiku")) rate = USAGE_TOKEN_COST["claude-haiku"];
    else if (lower.includes("codex") && lower.includes("mini")) rate = USAGE_TOKEN_COST["codex-mini"];
    else if (lower.includes("codex") || lower.includes("gpt") || lower.includes("o3") || lower.includes("o4")) rate = USAGE_TOKEN_COST["codex"];
    return inputTokens * rate.input + outputTokens * rate.output;
  }
  const getAggregatedUsage = (usageArgs: GetAggregatedUsageArgs): AggregatedUsageStats => {
    const since = usageArgs.since ?? null;
    const usageLimit = usageArgs.limit ?? 100;
    const missionFilter = usageArgs.missionId ?? null;
    // When filtering by mission, scope ai_usage_log queries to sessions linked to that mission
    const missionSessionClause = missionFilter
      ? ` and session_id in (
          select oa.executor_session_id from orchestrator_attempts oa
          join orchestrator_runs orr on orr.id = oa.run_id
          where orr.mission_id = ? and oa.executor_session_id is not null
        )`
      : "";
    const modelRows = db.all(`
      select provider, model, count(*) as sessions,
        coalesce(sum(input_tokens), 0) as input_tokens,
        coalesce(sum(output_tokens), 0) as output_tokens,
        coalesce(sum(duration_ms), 0) as duration_ms
      from ai_usage_log
      where (? is null or timestamp >= ?)${missionSessionClause}
      group by provider, model order by sessions desc
    `, missionFilter ? [since, since, missionFilter] : [since, since]) as Array<{
      provider: string; model: string; sessions: number;
      input_tokens: number; output_tokens: number; duration_ms: number;
    }>;
    const byModel: UsageModelBreakdown[] = modelRows.map((r) => {
      const inp = Number(r.input_tokens) || 0;
      const out = Number(r.output_tokens) || 0;
      return {
        provider: r.provider ?? "unknown", model: r.model ?? "unknown",
        sessions: Number(r.sessions) || 0, inputTokens: inp, outputTokens: out,
        durationMs: Number(r.duration_ms) || 0,
        costEstimateUsd: estimateTokenCost(r.model ?? "", inp, out)
      };
    });
    const recentRows = db.all(`
      select id, feature, provider, model,
        coalesce(input_tokens, 0) as input_tokens, coalesce(output_tokens, 0) as output_tokens,
        coalesce(duration_ms, 0) as duration_ms, success, timestamp
      from ai_usage_log where (? is null or timestamp >= ?)${missionSessionClause}
      order by timestamp desc limit ?
    `, missionFilter ? [since, since, missionFilter, usageLimit] : [since, since, usageLimit]) as Array<{
      id: string; feature: string; provider: string; model: string;
      input_tokens: number; output_tokens: number; duration_ms: number;
      success: number; timestamp: string;
    }>;
    const recentSessions: UsageRecentSession[] = recentRows.map((r) => ({
      id: r.id, feature: r.feature ?? "", provider: r.provider ?? "unknown",
      model: r.model ?? "unknown", inputTokens: Number(r.input_tokens) || 0,
      outputTokens: Number(r.output_tokens) || 0, durationMs: Number(r.duration_ms) || 0,
      success: r.success === 1 || (r.success as unknown) === true, timestamp: r.timestamp
    }));
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const activeRows = db.all(`
      select id, feature, provider, model, timestamp from ai_usage_log
      where timestamp >= ? and (success is null or success = 0)${missionSessionClause}
      order by timestamp desc limit 20
    `, missionFilter ? [fiveMinAgo, missionFilter] : [fiveMinAgo]) as Array<{
      id: string; feature: string; provider: string; model: string; timestamp: string;
    }>;
    const activeSessions: UsageActiveSession[] = activeRows.map((r) => ({
      id: r.id, feature: r.feature ?? "", provider: r.provider ?? "unknown",
      model: r.model ?? "unknown", startedAt: r.timestamp,
      elapsedMs: Date.now() - new Date(r.timestamp).getTime()
    }));
    const missionRows = db.all(`
      select oms.mission_id,
        coalesce(sum(case when oms.metric = 'tokens' then oms.value else 0 end), 0) as total_tokens,
        coalesce(sum(case when oms.metric = 'cost' then oms.value else 0 end), 0) as cost_estimate_usd,
        m.title as mission_title
      from orchestrator_metrics_samples oms
      left join missions m on m.id = oms.mission_id
      where (? is null or oms.mission_id = ?) and (? is null or oms.created_at >= ?)
      group by oms.mission_id order by total_tokens desc limit 50
    `, [missionFilter, missionFilter, since, since]) as Array<{
      mission_id: string; total_tokens: number; cost_estimate_usd: number; mission_title: string | null;
    }>;
    const missionBreakdown: UsageMissionBreakdown[] = missionRows.map((r) => ({
      missionId: r.mission_id, missionTitle: r.mission_title ?? r.mission_id.slice(0, 8),
      totalTokens: Number(r.total_tokens) || 0, costEstimateUsd: Number(r.cost_estimate_usd) || 0
    }));
    const totalSessions = byModel.reduce((a, x) => a + x.sessions, 0);
    const totalInputTokens = byModel.reduce((a, x) => a + x.inputTokens, 0);
    const totalOutputTokens = byModel.reduce((a, x) => a + x.outputTokens, 0);
    const totalDurationMs = byModel.reduce((a, x) => a + x.durationMs, 0);
    const totalCostEstimateUsd = byModel.reduce((a, x) => a + x.costEstimateUsd, 0);
    return {
      summary: { totalSessions, activeSessions: activeSessions.length, totalInputTokens, totalOutputTokens, totalDurationMs, totalCostEstimateUsd },
      byModel, recentSessions, activeSessions, missionBreakdown
    };
  };

  // ── Token Consumption Propagation ──────────────────────────────
  const propagateAttemptTokenUsage = (runId: string, attemptId: string): void => {
    try {
      // Get tokens from the attempt's AI sessions
      const attempt = db.get<{ session_id: string | null }>(
        "select session_id from orchestrator_attempts where id = ? limit 1",
        [attemptId]
      );
      if (!attempt?.session_id) return;

      const usage = db.get<{ total_input: number; total_output: number }>(
        `select coalesce(sum(input_tokens), 0) as total_input, coalesce(sum(output_tokens), 0) as total_output
         from ai_usage_log where session_id = ?`,
        [attempt.session_id]
      );
      if (!usage) return;

      const attemptTokens = (usage.total_input ?? 0) + (usage.total_output ?? 0);
      if (attemptTokens <= 0) return;

      // Update run metadata
      const run = db.get<{ metadata_json: string | null }>(
        "select metadata_json from orchestrator_runs where id = ? limit 1",
        [runId]
      );
      const currentMeta = run?.metadata_json ? JSON.parse(run.metadata_json) : {};
      const currentTokens = typeof currentMeta.tokensConsumed === "number" ? currentMeta.tokensConsumed : 0;
      currentMeta.tokensConsumed = currentTokens + attemptTokens;

      db.run(
        "update orchestrator_runs set metadata_json = ? where id = ?",
        [JSON.stringify(currentMeta), runId]
      );

      logger.debug("ai_orchestrator.tokens_propagated", {
        runId, attemptId,
        attemptTokens,
        totalTokens: currentMeta.tokensConsumed
      });
    } catch (error) {
      logger.debug("ai_orchestrator.token_propagation_failed", {
        runId, attemptId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

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

  const diagnoseFailureWithAI = async (diagArgs: {
    stepTitle: string;
    stepKey: string;
    stepInstructions: string;
    missionTitle: string;
    missionObjective: string;
    errorClass: string;
    errorMessage: string;
    attemptSummary: string;
    retryCount: number;
    retryLimit: number;
    tier: RecoveryDiagnosisTier;
    missionId: string;
  }): Promise<RecoveryDiagnosis> => {
    const defaultDiagnosis: RecoveryDiagnosis = {
      tier: diagArgs.tier,
      classification: `${diagArgs.errorClass}: ${diagArgs.errorMessage.slice(0, 300)}`,
      adjustedHint: null,
      peerNotification: null,
      suggestedModel: null,
      diagnosedAt: nowIso()
    };

    if (!aiIntegrationService) return defaultDiagnosis;

    try {
      const peerField = diagArgs.tier === "blocker"
        ? `"peerNotification": "1-sentence alert for sibling agents about this blocker and how it might affect them"`
        : `"peerNotification": null`;
      const prompt = buildFailureDiagnosisPrompt({
        stepTitle: diagArgs.stepTitle,
        stepKey: diagArgs.stepKey,
        missionTitle: diagArgs.missionTitle,
        missionObjective: diagArgs.missionObjective,
        stepInstructions: diagArgs.stepInstructions,
        errorClass: diagArgs.errorClass,
        errorMessage: diagArgs.errorMessage,
        attemptSummary: diagArgs.attemptSummary,
        retryCount: diagArgs.retryCount,
        retryLimit: diagArgs.retryLimit,
        tier: diagArgs.tier,
        peerField
      });

      const configFailureDiag = resolveOrchestratorModelConfig(diagArgs.missionId, "coordinator");
      const timeoutMs = resolveAiDecisionLikeTimeoutMs(diagArgs.missionId);
      const result = await aiIntegrationService.executeTask({
        feature: "orchestrator" as const,
        taskType: "review" as const,
        prompt,
        cwd: projectRoot ?? "",
        provider: configFailureDiag.provider === "codex" ? "codex" : "claude",
        model: modelConfigToServiceModel(configFailureDiag),
        reasoningEffort: thinkingLevelToReasoningEffort(configFailureDiag.thinkingLevel),
        oneShot: true,
        ...(timeoutMs != null ? { timeoutMs } : {})
      });

      const text = typeof result.text === "string" ? result.text.trim() : "";
      if (!text.length) return defaultDiagnosis;

      // Extract JSON from potential markdown wrapping
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return defaultDiagnosis;

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        tier: diagArgs.tier,
        classification: typeof parsed.classification === "string" ? parsed.classification : defaultDiagnosis.classification,
        adjustedHint: typeof parsed.adjustedHint === "string" && parsed.adjustedHint.trim().length > 0
          ? parsed.adjustedHint.trim()
          : null,
        peerNotification: typeof parsed.peerNotification === "string" && parsed.peerNotification.trim().length > 0
          ? parsed.peerNotification.trim()
          : null,
        suggestedModel: typeof parsed.suggestedModel === "string" ? parsed.suggestedModel : null,
        diagnosedAt: nowIso()
      };
    } catch (error) {
      logger.debug("ai_orchestrator.failure_diagnosis_ai_failed", {
        stepKey: diagArgs.stepKey,
        error: error instanceof Error ? error.message : String(error)
      });
      return defaultDiagnosis;
    }
  };

  const handleFailedAttemptRecovery = async (recoveryArgs: {
    runId: string;
    stepId: string;
    attemptId: string;
  }): Promise<void> => {
    const { runId, stepId, attemptId } = recoveryArgs;

    try {
      const graph = orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
      const step = graph.steps.find((s) => s.id === stepId);
      if (!step) return;

      const attempt = graph.attempts.find((a) => a.id === attemptId);
      if (!attempt) return;

      // Only process failed attempts
      if (attempt.status !== "failed") return;

      // Only process if the step is pending (meaning shouldRetry was true)
      if (step.status !== "pending") return;

      const missionId = graph.run.missionId;
      const mission = missionService.get(missionId);
      if (!mission) return;

      const stepMeta = isRecord(step.metadata) ? step.metadata : {};
      const errorMessage = attempt.errorMessage ?? "Unknown error";
      const attemptSummary = attempt.resultEnvelope?.summary ?? errorMessage;

      // Classify the failure tier
      const tier = classifyFailureTier({
        errorClass: attempt.errorClass
      });

      // Provider unreachable: pause mission on executor failures that indicate the
      // provider itself is down (rate limit, auth, network). These show up as
      // "executor_failure" with recognizable error messages.
      if (attempt.errorClass === "executor_failure") {
        const lowerErr = errorMessage.toLowerCase();
        const isProviderDown =
          lowerErr.includes("rate limit") ||
          lowerErr.includes("rate_limit") ||
          lowerErr.includes("429") ||
          lowerErr.includes("auth") ||
          lowerErr.includes("401") ||
          lowerErr.includes("403") ||
          lowerErr.includes("network") ||
          lowerErr.includes("econnrefused") ||
          lowerErr.includes("fetch failed") ||
          lowerErr.includes("service unavailable") ||
          lowerErr.includes("503");
        if (isProviderDown) {
          const executorKind = attempt.executorKind ?? "claude";
          pauseOnProviderUnreachable(missionId, executorKind, errorMessage);
          return;
        }
      }

      // Unrecoverable: policy blocks with exhausted retries
      if (attempt.errorClass === "policy" && step.retryCount >= step.retryLimit) {
        pauseOnUnrecoverableError(missionId, step.stepKey, errorMessage);
        return;
      }

      // Tier 1: transient — existing backoff is sufficient
      if (tier === "transient") {
        logger.debug("ai_orchestrator.recovery_tier1_transient", {
          runId, stepId, attemptId, errorClass: attempt.errorClass
        });
        return;
      }

      // Tier 2/3: diagnose with AI
      const diagnosis = await diagnoseFailureWithAI({
        stepTitle: step.title ?? step.stepKey,
        stepKey: step.stepKey,
        stepInstructions: typeof stepMeta.instructions === "string" ? stepMeta.instructions : "",
        missionTitle: mission.title,
        missionObjective: mission.prompt ?? mission.title,
        errorClass: attempt.errorClass,
        errorMessage,
        attemptSummary,
        retryCount: step.retryCount,
        retryLimit: step.retryLimit,
        tier,
        missionId
      });

      // Inject adjusted hint as steering directive for the retry
      if (diagnosis.adjustedHint) {
        steerMission({
          missionId,
          directive: `[RECOVERY GUIDANCE - retry ${step.retryCount + 1}/${step.retryLimit}] ${diagnosis.adjustedHint}`,
          priority: "instruction",
          targetStepKey: step.stepKey
        });
      }

      // Tier 3: notify peer agents about the blocker
      if (tier === "blocker" && diagnosis.peerNotification) {
        steerMission({
          missionId,
          directive: `[PEER ALERT from ${step.stepKey}] ${diagnosis.peerNotification}`,
          priority: "suggestion",
          targetStepKey: null
        });
      }

      // Record diagnosis in step metadata for observability
      const freshStepMeta = isRecord(step.metadata) ? { ...step.metadata } : {};
      freshStepMeta.lastRecoveryDiagnosis = {
        tier: diagnosis.tier,
        classification: diagnosis.classification,
        adjustedHint: diagnosis.adjustedHint,
        peerNotification: diagnosis.peerNotification,
        suggestedModel: diagnosis.suggestedModel,
        diagnosedAt: diagnosis.diagnosedAt,
        attemptId,
        retryCount: step.retryCount
      };
      db.run(
        `update orchestrator_steps set metadata_json = ?, updated_at = ? where id = ? and run_id = ?`,
        [JSON.stringify(freshStepMeta), nowIso(), stepId, runId]
      );

      // Emit timeline event for observability
      recordRuntimeEvent({
        runId,
        stepId,
        attemptId,
        eventType: "progress",
        eventKey: `recovery_diagnosis:${attemptId}:${tier}`,
        payload: {
          tier: diagnosis.tier,
          classification: diagnosis.classification,
          adjustedHint: diagnosis.adjustedHint ? diagnosis.adjustedHint.slice(0, 200) : null,
          peerNotified: tier === "blocker" && !!diagnosis.peerNotification
        }
      });

      // Emit orchestrator message for the mission chat
      emitOrchestratorMessage(
        missionId,
        `Recovery diagnosis for ${step.stepKey} (${tier}): ${diagnosis.classification}${diagnosis.adjustedHint ? " — Adjusted guidance injected for retry." : ""}`
      );

      logger.info("ai_orchestrator.recovery_diagnosis_applied", {
        runId, stepId, attemptId, tier,
        classification: diagnosis.classification,
        hasAdjustedHint: !!diagnosis.adjustedHint,
        hasPeerNotification: !!diagnosis.peerNotification
      });
    } catch (error) {
      logger.debug("ai_orchestrator.recovery_diagnosis_handler_failed", {
        runId, stepId: recoveryArgs.stepId, attemptId: recoveryArgs.attemptId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

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

      // ── Check if coordinator is alive — if so, IT makes all decisions ──
      const coordAgent = coordinatorAgents.get(runId);
      const coordinatorOwned = coordAgent?.isAlive === true;

      const isStepCompletionEvent = event.stepId && (event.reason === "attempt_completed" || event.reason === "skipped");
      const isAttemptCompletionShadowEvent =
        event.type === "orchestrator-attempt-updated" &&
        event.reason === "completed" &&
        Boolean(event.stepId) &&
        Boolean(event.attemptId);

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
      if (event.reason === "attempt_completed" && event.attemptId) {
        propagateAttemptTokenUsage(event.runId, event.attemptId);
      }

      // ── Shared graph fetch for safety check + coordinator routing ──
      let cachedEventGraph: OrchestratorRunGraph | null = null;
      const getEventGraph = (): OrchestratorRunGraph => {
        if (!cachedEventGraph) {
          cachedEventGraph = orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
        }
        return cachedEventGraph;
      };

      // ── Safety check: always run (guardrail, not decision) ──
      if (event.reason === "attempt_completed" && event.stepId && event.runId) {
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
      if (coordinatorOwned) {
        // Route event to the coordinator — it will decide what to do
        if (event.reason === "completed" || event.reason === "run_failed") {
          endCoordinatorAgentV2(runId);
        } else {
          try {
            routeEventToCoordinator(coordAgent, event, { graph: getEventGraph() });
          } catch (routeError) {
            logger.debug("ai_orchestrator.coordinator_v2_route_failed", {
              runId,
              reason: event.reason,
              error: routeError instanceof Error ? routeError.message : String(routeError),
            });
          }
        }
        return; // Coordinator handles everything — no deterministic fallthrough
      }

      // ────────────────────────────────────────────────────────────────────
      // COORDINATOR RECOVERY: If coordinator existed but died, attempt to
      // restart it. We do NOT fall back to deterministic decision handlers.
      // ────────────────────────────────────────────────────────────────────
      if (coordAgent && !coordAgent.isAlive) {
        const recovered = attemptCoordinatorRecovery(runId);
        if (recovered) {
          try {
            routeEventToCoordinator(recovered, event, { graph: getEventGraph() });
          } catch (routeError) {
            logger.debug("ai_orchestrator.coordinator_v2_recovery_route_failed", {
              runId,
              reason: event.reason,
              error: routeError instanceof Error ? routeError.message : String(routeError),
            });
          }
          return; // Recovered coordinator handles it
        }
      }

      // ────────────────────────────────────────────────────────────────────
      // STRICT AUTONOMY: If no live coordinator is available, pause and
      // escalate. We do not execute legacy deterministic strategy logic.
      // ────────────────────────────────────────────────────────────────────
      if (!coordAgent || !coordAgent.isAlive) {
        if (event.reason !== "completed" && event.reason !== "run_failed") {
          const missionId = getMissionIdForRun(runId);
          if (missionId) {
            pauseRunWithIntervention({
              runId,
              missionId,
              stepId: event.stepId ?? null,
              source: "transition_decision",
              reasonCode: coordAgent ? "coordinator_recovery_failed" : "coordinator_unavailable",
              title: coordAgent ? "Coordinator recovery failed" : "Coordinator unavailable",
              body: coordAgent
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

      // Unreachable guard: all non-coordinator-owned paths return above.
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
    resolveActivePolicy,
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
    getAggregatedUsage,
    handleQualityGateFailure,
    getTeamManifest: (tmArgs: { runId: string }): TeamManifest | null => {
      return runTeamManifests.get(tmArgs.runId) ?? null;
    },
    getRecoveryLoopState: (rlArgs: { runId: string }): RecoveryLoopState | null => {
      return runRecoveryLoopStates.get(rlArgs.runId) ?? null;
    },
    runHealthSweep: (reason = "manual") => runHealthSweep(reason),
    dispose: () => {
      disposed = true;
      if (healthSweepTimer) {
        clearInterval(healthSweepTimer);
        healthSweepTimer = null;
      }
      // Cancel pending event-driven coordinator evaluations
      for (const [rid, evalTimer] of pendingCoordinatorEvals.entries()) {
        clearTimeout(evalTimer);
        pendingCoordinatorEvals.delete(rid);
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
      // Clean up any leftover planner temp files
      cleanupPlanTempFiles();
    }
  };
}
