/**
 * orchestratorContext.ts
 *
 * Shared context type, internal types, constants, and utility functions
 * used by all aiOrchestrator modules. Extracted from the monolithic
 * aiOrchestratorService.ts to enable modular decomposition.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { GetModelCapabilitiesResult } from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import type {
  MissionDetail,
  MissionExecutionPolicy,
  MissionLevelSettings,
  PhaseCard,
  MissionStepStatus,
  MissionStatus,
  ModelCapabilityProfile,
  OrchestratorCallType,
  OrchestratorExecutorKind,
  OrchestratorRunGraph,
  OrchestratorRuntimeEvent,
  OrchestratorStepStatus,
  OrchestratorWorkerState,
  OrchestratorWorkerStatus,
  OrchestratorPlannerProvider,
  OrchestratorRuntimeQuestionLink,
  TerminalRuntimeState,
  UserSteeringDirective,
  OrchestratorChatMessage,
  OrchestratorChatThread,
  OrchestratorChatThreadType,
  OrchestratorChatTarget,
  OrchestratorChatVisibilityMode,
  OrchestratorChatDeliveryState,
  OrchestratorWorkerDigest,
  OrchestratorContextCheckpoint,
  OrchestratorLaneDecision,
  MissionMetricsConfig,
  MissionMetricSample,
  MissionMetricToggle,
  OrchestratorThreadEvent,
  AgentChatEventEnvelope,
  TeamManifest,
  ExecutionPlanPreview,
  OrchestratorWorkerRole,
  RecoveryLoopPolicy,
  RecoveryLoopState,
  RecoveryDiagnosisTier,
  RecoveryDiagnosis,
  OrchestratorContextView,
  IntegrationPrPolicy,
  PrDepth,
  PrStrategy,
  OrchestratorArtifactKind,
  ModelConfig,
  MissionModelConfig,
  RecoveryLoopIteration,
  OrchestratorTeamRuntimeState,
  DagMutationEvent,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createMissionService } from "../missions/missionService";
import type { createOrchestratorService } from "./orchestratorService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createLaneService } from "../lanes/laneService";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createPrService } from "../prs/prService";

// ── Re-export commonly-used shared types for module convenience ──
export type {
  MissionDetail,
  MissionExecutionPolicy,
  MissionStepStatus,
  MissionStatus,
  ModelCapabilityProfile,
  OrchestratorExecutorKind,
  OrchestratorRunGraph,
  OrchestratorRuntimeEvent,
  OrchestratorStepStatus,
  OrchestratorWorkerState,
  OrchestratorWorkerStatus,
  OrchestratorPlannerProvider,
  OrchestratorRuntimeQuestionLink,
  TerminalRuntimeState,
  UserSteeringDirective,
  OrchestratorChatMessage,
  OrchestratorChatThread,
  OrchestratorChatThreadType,
  OrchestratorChatTarget,
  OrchestratorChatVisibilityMode,
  OrchestratorChatDeliveryState,
  OrchestratorWorkerDigest,
  OrchestratorContextCheckpoint,
  OrchestratorLaneDecision,
  MissionMetricsConfig,
  MissionMetricSample,
  MissionMetricToggle,
  OrchestratorThreadEvent,
  AgentChatEventEnvelope,
  TeamManifest,
  ExecutionPlanPreview,
  OrchestratorWorkerRole,
  RecoveryLoopPolicy,
  RecoveryLoopState,
  RecoveryDiagnosisTier,
  RecoveryDiagnosis,
  OrchestratorContextView,
  IntegrationPrPolicy,
  PrDepth,
  PrStrategy,
  OrchestratorArtifactKind,
  ModelConfig,
  MissionModelConfig,
  RecoveryLoopIteration,
  OrchestratorTeamRuntimeState,
  DagMutationEvent,
};

// ── Internal Types ──────────────────────────────────────────────────

export type MissionRunStartArgs = {
  missionId: string;
  runMode?: "autopilot" | "manual";
  autopilotOwnerId?: string;
  defaultExecutorKind?: OrchestratorExecutorKind;
  defaultRetryLimit?: number;
  metadata?: Record<string, unknown> | null;
  forcePlanReviewBypass?: boolean;
  plannerProvider?: OrchestratorPlannerProvider;
};

export type MissionRunStartResult = {
  blockedByPlanReview: boolean;
  started: ReturnType<ReturnType<typeof createOrchestratorService>["startRunFromMission"]> | null;
  mission: MissionDetail | null;
  /** Resolves when async planner phase + post-planning execution setup completes. */
  planningComplete?: Promise<void>;
};

export type OrchestratorHookEvent = "TeammateIdle" | "TaskCompleted";

export type ResolvedOrchestratorHook = {
  command: string;
  timeoutMs: number;
};

export type ResolvedOrchestratorHooks = Partial<Record<OrchestratorHookEvent, ResolvedOrchestratorHook>>;

export type OrchestratorHookExecutionResult = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  spawnError: string | null;
};

export type OrchestratorHookCommandRunner = (args: {
  command: string;
  cwd: string;
  timeoutMs: number;
  env: Record<string, string>;
}) => Promise<OrchestratorHookExecutionResult>;

export type ResolvedOrchestratorConfig = {
  requirePlanReview: boolean;
  defaultPlannerProvider: string | null;
  defaultExecutionPolicy: Partial<MissionExecutionPolicy> | null;
  defaultMissionLevelSettings: MissionLevelSettings | null;
  hooks: ResolvedOrchestratorHooks;
};

export type RuntimeReasoningEffort = "low" | "medium" | "high";

export type MissionRuntimeProfile = {
  planning: {
    useAiPlanner: boolean;
    requirePlanReview: boolean;
    preferProvider: string | null;
  };
  execution: {
    maxParallelWorkers: number;
    defaultRetryLimit: number;
    stepTimeoutMs: number;
  };
  evaluation: {
    evaluateEveryStep: boolean;
    autoAdjustPlan: boolean;
    autoResolveInterventions: boolean;
    interventionConfidenceThreshold: number;
    evaluationReasoningEffort: RuntimeReasoningEffort;
    interventionReasoningEffort: RuntimeReasoningEffort;
  };
  context: {
    contextProfile: "orchestrator_deterministic_v1" | "orchestrator_narrative_opt_in_v1";
    includeNarrative: boolean;
    docsMode: "digest_refs" | "full_docs";
  };
  provenance: {
    source: "policy";
  };
};

export type SessionRuntimeSignal = {
  laneId: string | null;
  sessionId: string;
  runtimeState: TerminalRuntimeState;
  lastOutputPreview: string | null;
  at: string;
};

export type AttemptRuntimeTracker = {
  lastPreviewDigest: string | null;
  digestSinceMs: number;
  repeatCount: number;
  lastWaitingInterventionAtMs: number;
  lastEventHeartbeatAtMs: number;
  lastWaitingNotifiedAtMs: number;
  lastQuestionThreadId: string | null;
  lastQuestionMessageId: string | null;
  lastPersistedAtMs: number;
};

export type OrchestratorChatSessionState = {
  provider: "claude" | "codex";
  sessionId: string;
  updatedAt: string;
};

export type AgentChatSessionSummaryEntry = Awaited<
  ReturnType<ReturnType<typeof createAgentChatService>["listSessions"]>
>[number];

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  settled: boolean;
};

export type PlannerTurnCompletionStatus = "completed" | "failed" | "interrupted";

export type PlannerTurnCompletion = {
  status: PlannerTurnCompletionStatus;
  rawOutput: string;
  error: string | null;
};

export type PlannerAgentSessionState = {
  missionId: string;
  runId: string | null;
  stepId: string | null;
  threadId: string;
  sessionId: string;
  laneId: string;
  provider: "claude" | "codex";
  model: string;
  reasoningEffort: string | null;
  rawOutput: string;
  rawOutputTruncated: boolean;
  streamBuffer: string;
  lastStreamFlushAtMs: number;
  turn: Deferred<PlannerTurnCompletion> | null;
  activeTurnId: string | null;
  createdAt: string;
  lastEventAt: string;
};

export type WorkerDeliveryContext = {
  missionId: string;
  threadId: string;
  target: Extract<OrchestratorChatTarget, { kind: "worker" }>;
  runId: string | null;
  stepId: string | null;
  stepKey: string | null;
  attemptId: string | null;
  laneId: string | null;
  sessionId: string | null;
  sessionStatus: string | null;
  sessionToolType: string | null;
  executorKind: OrchestratorExecutorKind | null;
};

export type WorkerDeliverySessionResolution = {
  sessionId: string | null;
  source: "sticky" | "mapped" | "lane_fallback";
  providerHint: "codex" | "claude" | null;
  summary: AgentChatSessionSummaryEntry | null;
  error: string | null;
};

export type ResolvedCallTypeConfig = {
  provider: "claude" | "codex";
  model: string;
  reasoningEffort: string;
};

export type CoordinatorSessionEntry = {
  sessionId: string | null;
  missionId: string;
  runId: string;
  modelConfig: ModelConfig;
  startedAt: string;
  eventCount: number;
  lastEventAt: string | null;
  dead: boolean;
  startupGreetingSent: boolean;
  systemPrompt: string;
  pendingInit: Promise<void> | null;
};

export type PendingIntegrationContext = {
  proposalId: string;
  missionId: string;
  integrationLaneName: string;
  integrationLaneId: string;
  baseBranch: string;
  isDraft: boolean;
  prDepth: PrDepth;
  conflictStepKeys: string[];
  reviewStepKey: string | null;
  laneIdArray: string[];
  missionTitle: string;
};

export type ParallelMissionStepDescriptor = {
  id: string;
  index: number;
  title: string;
  kind: string;
  laneId: string | null;
  stepType: string;
  stepKey: string;
  dependencyStepKeys: string[];
};

// ── Constants ───────────────────────────────────────────────────────

export const PLAN_REVIEW_INTERVENTION_TITLE = "Mission plan approval required";
export const STEERING_DIRECTIVES_METADATA_KEY = "steeringDirectives";
export const ORCHESTRATOR_CHAT_METADATA_KEY = "orchestratorChat";
export const ORCHESTRATOR_CHAT_SESSION_METADATA_KEY = "orchestratorChatSession";
export const MAX_PERSISTED_STEERING_DIRECTIVES = 200;
export const MAX_PERSISTED_CHAT_MESSAGES = 200;
export const HEALTH_SWEEP_INTERVAL_MS = 5_000;
export const HEALTH_SWEEP_ACTIVE_RUN_SCAN_LIMIT = 200;
export const STALE_ATTEMPT_GRACE_MS = 10_000;
export const WORKER_WAITING_INPUT_INTERVENTION_COOLDOWN_MS = 120_000;
export const WORKER_EVENT_HEARTBEAT_INTERVAL_MS = 10_000;
export const MAX_CHAT_CONTEXT_CHARS = 4_000;
export const MAX_CHAT_CONTEXT_MESSAGES = 8;
export const MAX_CHAT_LINE_CHARS = 420;
export const MAX_LATEST_CHAT_MESSAGE_CHARS = 1_500;
export const SESSION_SIGNAL_RETENTION_MS = 20 * 60_000;
export const GRACEFUL_CANCEL_NOTIFY_TIMEOUT_MS = 1_200;
export const GRACEFUL_CANCEL_INTERRUPT_TIMEOUT_MS = 1_500;
export const GRACEFUL_CANCEL_DISPOSE_TIMEOUT_MS = 2_500;
export const GRACEFUL_CANCEL_DRAIN_WAIT_MS = 2_000;
export const GRACEFUL_CANCEL_DRAIN_POLL_MS = 100;
export const MAX_STEERING_CONTEXT_DIRECTIVES = 8;
export const MAX_STEERING_CONTEXT_CHARS = 1_600;
export const MAX_STEERING_DIRECTIVES_PER_STEP = 24;
export const ATTEMPT_RUNTIME_PERSIST_INTERVAL_MS = 2_000;
export const MAX_RUNTIME_SIGNAL_PREVIEW_CHARS = 320;
export const GATE_PHASE_STEP_TYPES = new Set(["test", "validation", "review", "code_review", "test_review", "integration"]);
export const QUALITY_GATE_MAX_OUTPUT_CHARS = 4_000;
export const DEFAULT_METRIC_TOGGLES: MissionMetricToggle[] = [
  "planning",
  "implementation",
  "testing",
  "validation",
  "code_review",
  "test_review",
  "integration",
  "cost",
  "tokens",
  "retries",
  "claims",
  "context_pressure",
  "interventions"
];
export const KNOWN_METRIC_TOGGLES = new Set<MissionMetricToggle>(DEFAULT_METRIC_TOGGLES);
export const DEFAULT_CHAT_VISIBILITY: OrchestratorChatVisibilityMode = "full";
export const DEFAULT_CHAT_DELIVERY: OrchestratorChatDeliveryState = "delivered";
export const DEFAULT_WORKER_CHAT_VISIBILITY: OrchestratorChatVisibilityMode = "digest_only";
export const DEFAULT_THREAD_STATUS = "active";
export const DEFAULT_CHAT_THREAD_TITLE = "Mission Coordinator";
export const MAX_THREAD_PAGE_SIZE = 200;
export const CONTEXT_CHECKPOINT_CHAT_THRESHOLD = 120;
export const WORKER_MESSAGE_RETRY_BUDGET = 4;
export const WORKER_MESSAGE_RETRY_BACKOFF_BASE_MS = 5_000;
export const WORKER_MESSAGE_RETRY_BACKOFF_MAX_MS = 90_000;
export const WORKER_MESSAGE_RETRY_INTERVENTION_COOLDOWN_MS = 90_000;
export const WORKER_MESSAGE_INFLIGHT_LEASE_MS = 45_000;
export const WORKER_MESSAGE_INFLIGHT_STALE_FAIL_MS = 180_000;
export const ACTIVE_ATTEMPT_STATUSES = new Set(["queued", "running", "blocked"]);
export const PLANNER_THREAD_ID_PREFIX = "planner";
export const PLANNER_THREAD_TITLE = "Planner Agent";
export const PLANNER_THREAD_STEP_KEY = "planner";
export const PLANNER_STREAM_FLUSH_CHARS = 1_800;
export const PLANNER_STREAM_FLUSH_INTERVAL_MS = 2_500;
export const PLANNER_STREAM_MIN_INTERVAL_FLUSH_CHARS = 480;
export const MAX_PLANNER_RAW_OUTPUT_CHARS = 4_000_000;
export const ORCHESTRATOR_HOOK_DEFAULT_TIMEOUT_MS = 10_000;
export const ORCHESTRATOR_HOOK_MAX_TIMEOUT_MS = 300_000;
export const ORCHESTRATOR_HOOK_MAX_CAPTURE_CHARS = 8_000;
export const ORCHESTRATOR_HOOK_LOG_PREVIEW_CHARS = 480;
export const DECISION_TIMEOUT_CAP_MS_BY_HOURS: Record<number, number> = {
  6: 6 * 60 * 60 * 1_000,
  12: 12 * 60 * 60 * 1_000,
  24: 24 * 60 * 60 * 1_000,
  48: 48 * 60 * 60 * 1_000
};
export const TERMINAL_STEP_STATUSES = new Set<OrchestratorStepStatus>(["succeeded", "failed", "skipped", "superseded", "canceled"]);
export const TRANSIENT_ERROR_CLASSES = new Set(["transient", "claim_conflict", "resume_recovered"]);

export const CALL_TYPE_DEFAULTS: Record<OrchestratorCallType, ResolvedCallTypeConfig> = {
  coordinator: { provider: "claude", model: "anthropic/claude-sonnet-4-6", reasoningEffort: "high" },
  chat_response: { provider: "claude", model: "anthropic/claude-sonnet-4-6", reasoningEffort: "medium" },
};

// ── OrchestratorContext ──────────────────────────────────────────────

export type OrchestratorContext = {
  // Dependencies
  db: AdeDb;
  logger: Logger;
  missionService: ReturnType<typeof createMissionService>;
  orchestratorService: ReturnType<typeof createOrchestratorService>;
  agentChatService: ReturnType<typeof createAgentChatService> | null | undefined;
  laneService: ReturnType<typeof createLaneService> | null | undefined;
  projectConfigService: ReturnType<typeof createProjectConfigService> | null | undefined;
  aiIntegrationService: ReturnType<typeof createAiIntegrationService> | null | undefined;
  prService: ReturnType<typeof createPrService> | null | undefined;
  missionBudgetService: import("./missionBudgetService").MissionBudgetService | null | undefined;
  projectRoot: string | undefined;
  onThreadEvent: ((event: OrchestratorThreadEvent) => void) | undefined;
  onDagMutation: ((event: DagMutationEvent) => void) | undefined;
  hookCommandRunner: OrchestratorHookCommandRunner;

  // Mutable state maps
  syncLocks: Set<string>;
  workerStates: Map<string, OrchestratorWorkerState>;
  activeSteeringDirectives: Map<string, UserSteeringDirective[]>;
  runRuntimeProfiles: Map<string, MissionRuntimeProfile>;
  chatMessages: Map<string, OrchestratorChatMessage[]>;
  activeChatSessions: Map<string, OrchestratorChatSessionState>;
  chatTurnQueues: Map<string, Promise<void>>;
  plannerSessionByMissionId: Map<string, PlannerAgentSessionState>;
  plannerSessionBySessionId: Map<string, PlannerAgentSessionState>;
  activeHealthSweepRuns: Set<string>;
  sessionRuntimeSignals: Map<string, SessionRuntimeSignal>;
  attemptRuntimeTrackers: Map<string, AttemptRuntimeTracker>;
  sessionSignalQueues: Map<string, Promise<void>>;
  workerDeliveryThreadQueues: Map<string, Promise<void>>;
  workerDeliveryInterventionCooldowns: Map<string, number>;
  runTeamManifests: Map<string, TeamManifest>;
  runRecoveryLoopStates: Map<string, RecoveryLoopState>;
  aiTimeoutBudgetStepLocks: Set<string>;
  aiTimeoutBudgetRunLocks: Set<string>;
  aiRetryDecisionLocks: Set<string>;
  coordinatorSessions: Map<string, CoordinatorSessionEntry>;
  pendingIntegrations: Map<string, PendingIntegrationContext>;
  coordinatorThinkingLoops: Map<string, NodeJS.Timeout>;
  pendingCoordinatorEvals: Map<string, NodeJS.Timeout>;

  // Coordinator and team runtime state
  coordinatorAgents: Map<string, import("./coordinatorAgent").CoordinatorAgent>;
  coordinatorRecoveryAttempts: Map<string, number>;
  teamRuntimeStates: Map<string, OrchestratorTeamRuntimeState>;
  callTypeConfigCache: Map<string, { config: ResolvedCallTypeConfig; expiresAt: number }>;

  // Scalar mutable state (wrapped for mutation through context)
  disposed: { current: boolean };
  healthSweepTimer: { current: NodeJS.Timeout | null };
};

// ── Utility Functions ───────────────────────────────────────────────

export function nowIso(): string {
  return new Date().toISOString();
}

export function createDeferred<T>(): Deferred<T> {
  let settle: ((value: T) => void) | null = null;
  let rejectFn: ((error: unknown) => void) | null = null;
  const deferred: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      settle = resolve;
      rejectFn = reject;
    }),
    resolve(value: T) {
      if (deferred.settled) return;
      deferred.settled = true;
      settle?.(value);
    },
    reject(error: unknown) {
      if (deferred.settled) return;
      deferred.settled = true;
      rejectFn?.(error);
    },
    settled: false
  };
  return deferred;
}

export async function runBestEffortWithTimeout(args: {
  timeoutMs: number;
  work: () => Promise<unknown>;
}): Promise<{ ok: boolean; timedOut: boolean; error: string | null }> {
  let timer: NodeJS.Timeout | null = null;
  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => args.work())
        .then(() => ({ kind: "ok" as const }))
        .catch((error) => ({ kind: "error" as const, error })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), Math.max(1, Math.floor(args.timeoutMs)));
      })
    ]);
    if (outcome.kind === "ok") {
      return { ok: true, timedOut: false, error: null };
    }
    if (outcome.kind === "timeout") {
      return { ok: false, timedOut: true, error: "timed_out" };
    }
    return {
      ok: false,
      timedOut: false,
      error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asBool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function parseSteeringDirective(value: unknown, missionId: string): UserSteeringDirective | null {
  if (!isRecord(value)) return null;
  const directive = typeof value.directive === "string" ? value.directive.trim() : "";
  if (!directive.length) return null;
  const priority = value.priority === "instruction" || value.priority === "override" ? value.priority : "suggestion";
  return {
    missionId,
    directive,
    priority,
    targetStepKey: typeof value.targetStepKey === "string" ? value.targetStepKey : null
  };
}

export function parseChatVisibility(value: unknown): OrchestratorChatVisibilityMode | null {
  if (value === "full" || value === "digest_only" || value === "metadata_only") return value;
  return null;
}

export function classifyFailureTier(args: {
  errorClass: string;
}): RecoveryDiagnosisTier {
  if (TRANSIENT_ERROR_CLASSES.has(args.errorClass)) return "transient";
  if (args.errorClass === "policy") return "blocker";
  return "semantic";
}

export function parseChatDeliveryState(value: unknown): OrchestratorChatDeliveryState | null {
  if (value === "queued" || value === "delivered" || value === "failed") return value;
  return null;
}

export function parseChatTarget(value: unknown): OrchestratorChatTarget | null {
  if (!isRecord(value)) return null;
  const kind =
    value.kind === "coordinator"
    || value.kind === "teammate"
    || value.kind === "worker"
    || value.kind === "workers"
      ? value.kind
      : null;
  if (!kind) return null;
  if (kind === "coordinator") {
    return {
      kind: "coordinator",
      runId: typeof value.runId === "string" ? value.runId : null
    };
  }
  if (kind === "teammate") {
    return {
      kind: "teammate",
      runId: typeof value.runId === "string" ? value.runId : null,
      teamMemberId: typeof value.teamMemberId === "string" ? value.teamMemberId : null,
      sessionId: typeof value.sessionId === "string" ? value.sessionId : null
    };
  }
  if (kind === "workers") {
    return {
      kind: "workers",
      runId: typeof value.runId === "string" ? value.runId : null,
      laneId: typeof value.laneId === "string" ? value.laneId : null,
      includeClosed: value.includeClosed === true
    };
  }
  return {
    kind: "worker",
    runId: typeof value.runId === "string" ? value.runId : null,
    stepId: typeof value.stepId === "string" ? value.stepId : null,
    stepKey: typeof value.stepKey === "string" ? value.stepKey : null,
    attemptId: typeof value.attemptId === "string" ? value.attemptId : null,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
    laneId: typeof value.laneId === "string" ? value.laneId : null
  };
}

export function parseThreadType(value: unknown): OrchestratorChatThreadType | null {
  if (value === "coordinator" || value === "teammate" || value === "worker") return value;
  return null;
}

export function parseChatMessage(value: unknown, missionId: string): OrchestratorChatMessage | null {
  if (!isRecord(value)) return null;
  const role = value.role === "user" || value.role === "orchestrator" || value.role === "worker"
    ? value.role
    : null;
  if (!role) return null;
  const content = typeof value.content === "string" ? value.content.trim() : "";
  const timestamp = typeof value.timestamp === "string" ? value.timestamp : nowIso();
  if (!content.length) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id.length) return null;
  return {
    id,
    missionId,
    role,
    content,
    timestamp,
    stepKey: typeof value.stepKey === "string" ? value.stepKey : null,
    threadId: typeof value.threadId === "string" ? value.threadId : undefined,
    target: parseChatTarget(value.target),
    visibility: parseChatVisibility(value.visibility) ?? DEFAULT_CHAT_VISIBILITY,
    deliveryState: parseChatDeliveryState(value.deliveryState) ?? DEFAULT_CHAT_DELIVERY,
    sourceSessionId: typeof value.sourceSessionId === "string" ? value.sourceSessionId : undefined,
    attemptId: typeof value.attemptId === "string" ? value.attemptId : undefined,
    laneId: typeof value.laneId === "string" ? value.laneId : undefined,
    runId: typeof value.runId === "string" ? value.runId : undefined,
    metadata: isRecord(value.metadata) ? value.metadata : null
  };
}

export function parseChatSessionState(value: unknown): OrchestratorChatSessionState | null {
  if (!isRecord(value)) return null;
  const provider = value.provider === "claude" || value.provider === "codex" ? value.provider : null;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  if (!provider || !sessionId.length) return null;
  return {
    provider,
    sessionId,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : nowIso()
  };
}

export function normalizeSignalText(value: string | null | undefined): string {
  if (!value || typeof value !== "string") return "";
  return value
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function digestSignalText(value: string | null | undefined): string | null {
  const normalized = normalizeSignalText(value);
  if (!normalized.length) return null;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function buildQuestionThreadLink(args: {
  attemptId: string;
  preview: string | null;
  occurredAt: string;
}): OrchestratorRuntimeQuestionLink {
  const attemptId = String(args.attemptId ?? "").trim();
  const threadId = `question:${attemptId}`;
  const digest = digestSignalText(args.preview) ?? "none";
  const secondBucket = Math.max(0, Math.floor(Date.parse(args.occurredAt) / 1000) || 0);
  return {
    threadId,
    messageId: `question:${attemptId}:${digest}:${secondBucket}`,
    replyTo: null
  };
}

export function buildQuestionReplyLink(args: {
  threadId: string;
  replyTo: string;
  interventionId: string;
  directive: string;
}): OrchestratorRuntimeQuestionLink {
  const digest = digestSignalText(args.directive) ?? "none";
  return {
    threadId: args.threadId,
    messageId: `question_reply:${args.interventionId}:${digest}`,
    replyTo: args.replyTo
  };
}

export function parseQuestionLink(value: unknown): OrchestratorRuntimeQuestionLink | null {
  if (!isRecord(value)) return null;
  const threadId = typeof value.threadId === "string" ? value.threadId.trim() : "";
  const messageId = typeof value.messageId === "string" ? value.messageId.trim() : "";
  const replyToRaw = typeof value.replyTo === "string" ? value.replyTo.trim() : "";
  if (!threadId.length || !messageId.length) return null;
  return {
    threadId,
    messageId,
    replyTo: replyToRaw.length > 0 ? replyToRaw : null
  };
}

export function detectWaitingInputSignal(text: string | null | undefined): boolean {
  const normalized = normalizeSignalText(text);
  if (!normalized.length) return false;
  return /waiting.{0,20}input|need.{0,20}(input|direction|guidance)/.test(normalized);
}

export function clipTextForContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const suffix = "... (truncated)";
  return value.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
}

export function workerStateFromRuntimeSignal(args: {
  runtimeState: TerminalRuntimeState;
  waitingForInput?: boolean;
}): OrchestratorWorkerStatus {
  if (args.waitingForInput) return "waiting_input";
  switch (args.runtimeState) {
    case "running": return "working";
    case "idle": return "idle";
    case "waiting-input": return "waiting_input";
    case "exited": return "completed";
    case "killed": return "failed";
    default: return "working";
  }
}

export function parseTerminalRuntimeState(raw: unknown): TerminalRuntimeState | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "running" || value === "idle" || value === "waiting-input" || value === "exited" || value === "killed") {
    return value as TerminalRuntimeState;
  }
  return null;
}

export function clipHookLogText(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").replace(/\u0000/g, "").trim();
  if (!normalized.length) return null;
  return normalized.length > ORCHESTRATOR_HOOK_LOG_PREVIEW_CHARS
    ? normalized.slice(0, ORCHESTRATOR_HOOK_LOG_PREVIEW_CHARS) + "..."
    : normalized;
}

export function parseOrchestratorHookConfig(raw: unknown): ResolvedOrchestratorHook | null {
  if (!isRecord(raw)) return null;
  const command = String(raw.command ?? "").trim();
  if (!command.length) return null;
  const timeoutRaw = Number(raw.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutRaw)
    ? Math.max(1_000, Math.min(ORCHESTRATOR_HOOK_MAX_TIMEOUT_MS, Math.floor(timeoutRaw)))
    : ORCHESTRATOR_HOOK_DEFAULT_TIMEOUT_MS;
  return { command, timeoutMs };
}

export function readOrchestratorHooksConfig(orchestrator: Record<string, unknown>): ResolvedOrchestratorHooks {
  const hooksRaw = isRecord(orchestrator.hooks) ? orchestrator.hooks : null;
  if (!hooksRaw) return {};
  const hooks: ResolvedOrchestratorHooks = {};
  const teammateIdle = parseOrchestratorHookConfig(hooksRaw.TeammateIdle ?? hooksRaw.teammateIdle ?? hooksRaw.teammate_idle);
  if (teammateIdle) hooks.TeammateIdle = teammateIdle;
  const taskCompleted = parseOrchestratorHookConfig(hooksRaw.TaskCompleted ?? hooksRaw.taskCompleted ?? hooksRaw.task_completed);
  if (taskCompleted) hooks.TaskCompleted = taskCompleted;
  return hooks;
}

export function parseJsonRecord(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw || typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function missionThreadId(missionId: string): string {
  return `mission:${missionId}`;
}

export function plannerThreadId(missionId: string): string {
  return `${PLANNER_THREAD_ID_PREFIX}:${missionId}`;
}

export function clampLimit(rawLimit: number | null | undefined, fallback: number, max = MAX_THREAD_PAGE_SIZE): number {
  const numeric = Number(rawLimit);
  if (!Number.isFinite(numeric) || numeric < 1) return fallback;
  return Math.min(max, Math.max(1, Math.floor(numeric)));
}

export function normalizeChatVisibility(value: unknown, fallback: OrchestratorChatVisibilityMode = DEFAULT_CHAT_VISIBILITY): OrchestratorChatVisibilityMode {
  return parseChatVisibility(value) ?? fallback;
}

export function normalizeChatDeliveryState(value: unknown, fallback: OrchestratorChatDeliveryState = DEFAULT_CHAT_DELIVERY): OrchestratorChatDeliveryState {
  return parseChatDeliveryState(value) ?? fallback;
}

export function normalizeThreadType(value: unknown, fallback: OrchestratorChatThreadType = "coordinator"): OrchestratorChatThreadType {
  return parseThreadType(value) ?? fallback;
}

export function toOptionalString(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw.length > 0 ? raw : null;
}

export function sanitizeChatTarget(target: OrchestratorChatTarget | null | undefined): OrchestratorChatTarget | null {
  if (!target) return null;
  if (target.kind === "coordinator") {
    return {
      kind: "coordinator",
      runId: toOptionalString(target.runId)
    };
  }
  if (target.kind === "teammate") {
    return {
      kind: "teammate",
      runId: toOptionalString(target.runId),
      teamMemberId: toOptionalString(target.teamMemberId),
      sessionId: toOptionalString(target.sessionId)
    };
  }
  if (target.kind === "workers") {
    return {
      kind: "workers",
      runId: toOptionalString(target.runId),
      laneId: toOptionalString(target.laneId),
      includeClosed: target.includeClosed === true
    };
  }
  if (target.kind !== "worker") return null;
  const sanitized: OrchestratorChatTarget = {
    kind: "worker",
    runId: toOptionalString(target.runId),
    stepId: toOptionalString(target.stepId),
    stepKey: toOptionalString(target.stepKey),
    attemptId: toOptionalString(target.attemptId),
    sessionId: toOptionalString(target.sessionId),
    laneId: toOptionalString(target.laneId)
  };
  return sanitized;
}

export function parseWorkerProviderHint(raw: unknown): "codex" | "claude" | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "codex" || value === "openai") return "codex";
  if (value === "claude" || value === "anthropic") return "claude";
  return null;
}

export function workerThreadIdentity(target: OrchestratorChatTarget | null | undefined): string | null {
  if (!target || target.kind !== "worker") return null;
  const options = [target.attemptId, target.sessionId, target.stepId, target.stepKey, target.laneId];
  for (const value of options) {
    const normalized = toOptionalString(value);
    if (normalized) return normalized;
  }
  return null;
}

export function teammateThreadIdentity(target: OrchestratorChatTarget | null | undefined): string | null {
  if (!target || target.kind !== "teammate") return null;
  const options = [target.teamMemberId, target.sessionId, target.runId];
  for (const value of options) {
    const normalized = toOptionalString(value);
    if (normalized) return normalized;
  }
  return null;
}

export function deriveThreadTitle(args: {
  target: OrchestratorChatTarget | null | undefined;
  step: { stepKey: string; title: string } | null | undefined;
  lane: { name: string } | null | undefined;
  fallback?: string;
}): string {
  const teammate = args.target && args.target.kind === "teammate" ? args.target : null;
  if (teammate) {
    const teammateLabel = toOptionalString(teammate.teamMemberId) ?? toOptionalString(teammate.sessionId);
    return teammateLabel ? `Teammate: ${teammateLabel}` : "Teammate";
  }
  const target = args.target && args.target.kind === "worker" ? args.target : null;
  const stepLabel = args.step?.title || args.step?.stepKey || target?.stepKey || null;
  const suffix =
    stepLabel ??
    (args.lane?.name ? `Lane: ${args.lane.name}` : null) ??
    target?.laneId ??
    null;
  return suffix ? `Worker: ${suffix}` : (args.fallback ?? DEFAULT_CHAT_THREAD_TITLE);
}

export function readConfig(projectConfigService: ReturnType<typeof createProjectConfigService> | null | undefined): ResolvedOrchestratorConfig {
  const snapshot = projectConfigService?.get();
  const ai = snapshot?.effective?.ai;
  const orchestrator = isRecord(ai) && isRecord(ai.orchestrator) ? (ai.orchestrator as Record<string, unknown>) : {};
  const requirePlanReview = asBool(orchestrator.requirePlanReview, false);
  const defaultPlannerProviderRaw = asString(orchestrator.defaultPlannerProvider);
  const defaultPlannerProvider: string | null =
    defaultPlannerProviderRaw && defaultPlannerProviderRaw.trim().length > 0 ? defaultPlannerProviderRaw.trim() : null;
  const defaultExecutionPolicy = isRecord(orchestrator.defaultExecutionPolicy)
    ? (orchestrator.defaultExecutionPolicy as Partial<MissionExecutionPolicy>)
    : null;
  const defaultMissionLevelSettings = isRecord(orchestrator.defaultMissionLevelSettings)
    ? (orchestrator.defaultMissionLevelSettings as MissionLevelSettings)
    : null;
  const hooks = readOrchestratorHooksConfig(orchestrator);
  return {
    requirePlanReview,
    defaultPlannerProvider,
    defaultExecutionPolicy,
    defaultMissionLevelSettings,
    hooks
  };
}

export function mapOrchestratorStepStatus(status: OrchestratorStepStatus): MissionStepStatus {
  switch (status) {
    case "pending": return "pending";
    case "ready": return "pending";
    case "running": return "running";
    case "succeeded": return "succeeded";
    case "failed": return "failed";
    case "skipped": return "skipped";
    case "superseded": return "skipped";
    case "blocked": return "blocked";
    case "canceled": return "canceled";
    default: return "pending";
  }
}

export function deriveMissionStatusFromRun(graph: OrchestratorRunGraph, mission: MissionDetail): MissionStatus {
  if (graph.run.status === "active" || graph.run.status === "bootstrapping" || graph.run.status === "queued" || graph.run.status === "completing") return "in_progress";
  if (graph.run.status === "paused") return "intervention_required";
  const hasFailedSteps = graph.steps.some((step) => step.status === "failed");
  if (graph.run.status === "succeeded_with_risk") {
    return "partially_completed";
  }
  if (graph.run.status === "succeeded") {
    return hasFailedSteps ? "partially_completed" : "completed";
  }
  if (graph.run.status === "failed") return "failed";
  return mission.status;
}

export function buildOutcomeSummary(graph: OrchestratorRunGraph): string {
  const total = graph.steps.length;
  const succeeded = graph.steps.filter((step) => step.status === "succeeded").length;
  const superseded = graph.steps.filter((step) => step.status === "superseded").length;
  const failed = graph.steps.filter((step) => step.status === "failed").length;
  const blocked = graph.steps.filter((step) => step.status === "blocked").length;
  const done = succeeded + superseded;
  const remaining = total - done;
  const attempts = graph.attempts.length;
  const parts = [
    `${done}/${total} done`,
    remaining > 0 ? `${remaining} remaining` : null,
    superseded > 0 ? `${superseded} superseded` : null,
    failed > 0 ? `${failed} failed` : null,
    blocked > 0 ? `${blocked} blocked` : null,
    `${attempts} total attempts`
  ].filter(Boolean);
  return parts.join(", ") + ".";
}

export function buildConflictResolutionInstructions(conflictFiles: string[], sourceLaneName: string): string {
  const fileList = conflictFiles.slice(0, 10);
  const more = conflictFiles.length > 10 ? `\n  ... and ${conflictFiles.length - 10} more files` : "";
  return [
    `# Conflict Resolution Instructions`,
    ``,
    `You are resolving merge conflicts in branch "${sourceLaneName}" that arose while merging into the integration branch.`,
    ``,
    `## Conflicting Files`,
    fileList.map((f) => `  - ${f}`).join("\n") + more,
    ``,
    `## Steps`,
    `1. For each file with conflict markers, resolve the conflict to produce correct code.`,
    `2. Prefer the feature branch changes when they implement new functionality.`,
    `3. Keep integration branch changes that fix bugs or update shared infrastructure.`,
    `4. Run tests after resolving to ensure nothing is broken.`,
    `5. Stage resolved files with \`git add\`.`,
    `6. Do NOT commit or push — the orchestrator handles that.`,
    ``,
    `## Important`,
    `- Do NOT run \`git merge\`, \`git rebase\`, \`git push\`, or \`git commit\`.`,
    `- Focus only on editing the conflicting files to remove conflict markers.`,
    `- Ensure the code compiles and tests pass after resolution.`
  ].join("\n");
}

export function normalizeReasoningEffort(value: unknown, fallback: RuntimeReasoningEffort): RuntimeReasoningEffort {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") return normalized;
  return fallback;
}

export function extractRunFailureMessage(graph: OrchestratorRunGraph): string | null {
  const latestFailure = [...graph.attempts]
    .filter((a) => a.status === "failed" && a.errorMessage)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  return latestFailure?.errorMessage ?? null;
}

// ── PR Strategy Inference ────────────────────────────────────────

export function inferPrStrategy(args: { laneCount: number; lanesAreCoupled: boolean; userOverride?: PrStrategy }): PrStrategy {
  if (args.userOverride) return args.userOverride;
  if (args.laneCount === 1) return { kind: "per-lane" };
  if (args.lanesAreCoupled) return { kind: "integration" };
  return { kind: "queue" };
}

// ── Hook Command Runner ──────────────────────────────────────────

export const runOrchestratorHookCommand: OrchestratorHookCommandRunner = async (args) => {
  const startedAt = Date.now();
  return await new Promise<OrchestratorHookExecutionResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;

    const finish = (result: Partial<OrchestratorHookExecutionResult>) => {
      if (settled) return;
      settled = true;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      resolve({
        exitCode: result.exitCode ?? null,
        signal: result.signal ?? null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        spawnError: result.spawnError ?? null
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(args.command, {
        cwd: args.cwd,
        env: args.env,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      finish({
        spawnError: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    const appendOutput = (target: "stdout" | "stderr", chunk: unknown) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
      if (!text.length) return;
      if (target === "stdout") {
        stdout = (stdout + text).slice(-ORCHESTRATOR_HOOK_MAX_CAPTURE_CHARS);
      } else {
        stderr = (stderr + text).slice(-ORCHESTRATOR_HOOK_MAX_CAPTURE_CHARS);
      }
    };

    if (args.timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // Best-effort only.
        }
        setTimeout(() => {
          if (child.exitCode == null && !child.killed) {
            try {
              child.kill("SIGKILL");
            } catch {
              // Best-effort only.
            }
          }
        }, 1_000).unref();
      }, args.timeoutMs);
    }

    child.stdout?.on("data", (chunk) => appendOutput("stdout", chunk));
    child.stderr?.on("data", (chunk) => appendOutput("stderr", chunk));
    child.on("error", (error) => {
      finish({
        spawnError: error instanceof Error ? error.message : String(error)
      });
    });
    child.on("close", (exitCode, signal) => {
      finish({
        exitCode: Number.isFinite(Number(exitCode)) ? Number(exitCode) : null,
        signal: typeof signal === "string" ? signal : null
      });
    });
  });
};

// ── Runtime Profile Derivation ───────────────────────────────────

export function deriveRuntimeProfileFromPolicy(
  policy: MissionExecutionPolicy,
  config: ResolvedOrchestratorConfig
): MissionRuntimeProfile {
  const testingEnabled = policy.testing.mode !== "none";
  const reviewEnabled = policy.codeReview.mode !== "off" || policy.testReview.mode !== "off";
  const strictGates =
    policy.validation.mode === "required"
    || policy.codeReview.mode === "required"
    || policy.testReview.mode === "required";

  let maxParallelWorkers = 2;
  if (testingEnabled) maxParallelWorkers += 1;
  if (reviewEnabled) maxParallelWorkers += 1;
  if (policy.teamRuntime?.enabled) maxParallelWorkers += 2;
  if (policy.testing.mode === "tdd") maxParallelWorkers = Math.max(maxParallelWorkers, 4);
  maxParallelWorkers = Math.max(1, Math.min(6, maxParallelWorkers));

  let stepTimeoutMs = 300_000;
  if (!testingEnabled && !reviewEnabled) {
    stepTimeoutMs = 180_000;
  }
  if (strictGates || policy.planning.mode === "manual_review") {
    stepTimeoutMs = 600_000;
  } else if (policy.testing.mode === "tdd") {
    stepTimeoutMs = 480_000;
  }

  const includeNarrative = policy.planning.mode === "manual_review" || strictGates;
  const contextProfile = includeNarrative ? "orchestrator_narrative_opt_in_v1" : "orchestrator_deterministic_v1";

  return {
    planning: {
      useAiPlanner: policy.planning.mode !== "off",
      requirePlanReview: policy.planning.mode === "manual_review",
      preferProvider: policy.planning.model ?? config.defaultPlannerProvider ?? null
    },
    execution: {
      maxParallelWorkers,
      defaultRetryLimit: strictGates || testingEnabled ? 2 : 1,
      stepTimeoutMs
    },
    evaluation: {
      evaluateEveryStep: strictGates || policy.testing.mode === "tdd",
      autoAdjustPlan: policy.planning.mode !== "off" || reviewEnabled,
      autoResolveInterventions: testingEnabled || reviewEnabled,
      interventionConfidenceThreshold: strictGates ? 0.75 : 0.9,
      evaluationReasoningEffort: normalizeReasoningEffort(
        policy.codeReview.reasoningEffort ?? policy.testReview.reasoningEffort ?? policy.validation.reasoningEffort,
        strictGates ? "high" : "medium"
      ),
      interventionReasoningEffort: normalizeReasoningEffort(
        policy.planning.reasoningEffort,
        strictGates ? "high" : "medium"
      )
    },
    context: {
      contextProfile,
      includeNarrative,
      docsMode: includeNarrative ? "full_docs" : "digest_refs"
    },
    provenance: {
      source: "policy"
    }
  };
}

// ── Phase-card-based Runtime Profile Derivation ──────────────────

export function deriveRuntimeProfileFromPhases(
  phases: PhaseCard[],
  settings: MissionLevelSettings,
  config: ResolvedOrchestratorConfig
): MissionRuntimeProfile {
  // Build a set of enabled phase keys
  const phaseKeys = new Set(phases.map((p) => p.phaseKey.toLowerCase()));

  const planningCard = phases.find((p) => p.phaseKey.toLowerCase() === "planning");
  const testingEnabled = phaseKeys.has("testing") || phaseKeys.has("test");
  const reviewEnabled = phaseKeys.has("code_review") || phaseKeys.has("codereview") || phaseKeys.has("review")
    || phaseKeys.has("test_review") || phaseKeys.has("testreview");
  const hasStrictGates = phases.some(
    (p) => p.validationGate.required && p.validationGate.tier !== "none"
  );
  const hasTdd = phases.some(
    (p) => (p.phaseKey.toLowerCase() === "testing" || p.phaseKey.toLowerCase() === "test")
      && p.instructions.toLowerCase().includes("tdd")
  );
  const hasManualReview = planningCard?.askQuestions.mode === "always";

  let maxParallelWorkers = 2;
  if (testingEnabled) maxParallelWorkers += 1;
  if (reviewEnabled) maxParallelWorkers += 1;
  if (settings.teamRuntime?.enabled) maxParallelWorkers += 2;
  if (hasTdd) maxParallelWorkers = Math.max(maxParallelWorkers, 4);
  maxParallelWorkers = Math.max(1, Math.min(6, maxParallelWorkers));

  let stepTimeoutMs = 300_000;
  if (!testingEnabled && !reviewEnabled) {
    stepTimeoutMs = 180_000;
  }
  if (hasStrictGates || hasManualReview) {
    stepTimeoutMs = 600_000;
  } else if (hasTdd) {
    stepTimeoutMs = 480_000;
  }

  const includeNarrative = hasManualReview || hasStrictGates;
  const contextProfile = includeNarrative ? "orchestrator_narrative_opt_in_v1" : "orchestrator_deterministic_v1";

  // Derive reasoning effort from phase cards that have validation or review roles
  const reviewPhases = phases.filter(
    (p) => ["validation", "code_review", "codereview", "review", "test_review", "testreview"]
      .includes(p.phaseKey.toLowerCase())
  );
  const planningPhases = phases.filter(
    (p) => p.phaseKey.toLowerCase() === "planning" || p.phaseKey.toLowerCase() === "analysis"
  );

  return {
    planning: {
      useAiPlanner: phaseKeys.has("planning") || phaseKeys.has("analysis"),
      requirePlanReview: hasManualReview,
      preferProvider: planningCard?.model?.modelId ?? config.defaultPlannerProvider ?? null
    },
    execution: {
      maxParallelWorkers,
      defaultRetryLimit: hasStrictGates || testingEnabled ? 2 : 1,
      stepTimeoutMs
    },
    evaluation: {
      evaluateEveryStep: hasStrictGates || hasTdd,
      autoAdjustPlan: (phaseKeys.has("planning") || phaseKeys.has("analysis")) || reviewEnabled,
      autoResolveInterventions: testingEnabled || reviewEnabled,
      interventionConfidenceThreshold: hasStrictGates ? 0.75 : 0.9,
      evaluationReasoningEffort: normalizeReasoningEffort(
        reviewPhases[0]?.model?.modelId,
        hasStrictGates ? "high" : "medium"
      ),
      interventionReasoningEffort: normalizeReasoningEffort(
        planningPhases[0]?.model?.modelId,
        hasStrictGates ? "high" : "medium"
      )
    },
    context: {
      contextProfile,
      includeNarrative,
      docsMode: includeNarrative ? "full_docs" : "digest_refs"
    },
    provenance: {
      source: "policy"
    }
  };
}

// ── Model Capabilities ───────────────────────────────────────────

export function getModelCapabilities(): GetModelCapabilitiesResult {
  const profiles: ModelCapabilityProfile[] = [
    {
      provider: "claude",
      modelId: "claude-opus-4-6",
      displayName: "Claude Opus 4.6",
      strengths: ["complex reasoning", "architectural planning", "nuanced review", "deep analysis"],
      weaknesses: ["high cost tier", "not recommended for bulk implementation"],
      costTier: "very_high",
      bestFor: ["planning", "review"],
      parallelCapable: false,
      reasoningTiers: ["low", "medium", "high", "max"]
    },
    {
      provider: "claude",
      modelId: "claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
      strengths: ["fast balanced quality", "code review", "planning", "narrative generation"],
      weaknesses: ["very large scope implementation", "long-running autonomous tasks"],
      costTier: "medium",
      bestFor: ["review", "planning", "narrative"],
      parallelCapable: true,
      reasoningTiers: ["low", "medium", "high"]
    },
    {
      provider: "claude",
      modelId: "claude-haiku-4-5",
      displayName: "Claude Haiku 4.5",
      strengths: ["fastest Claude variant", "narrative generation", "summaries", "quick classification"],
      weaknesses: ["limited on complex multi-step reasoning", "not suited for large implementations"],
      costTier: "low",
      bestFor: ["narrative"],
      parallelCapable: true,
      reasoningTiers: ["low", "medium", "high"]
    },
    {
      provider: "codex",
      modelId: "gpt-5.3-codex",
      displayName: "GPT-5.3 Codex",
      strengths: ["latest and most capable coding model", "excellent implementation", "testing", "code review"],
      weaknesses: ["narrative prose", "complex architectural reasoning"],
      costTier: "medium",
      bestFor: ["implementation", "review"],
      parallelCapable: true,
      reasoningTiers: ["minimal", "low", "medium", "high", "xhigh"]
    },
    {
      provider: "codex",
      modelId: "gpt-5.3-codex-spark",
      displayName: "GPT-5.3 Codex Spark",
      strengths: ["real-time coding (>1000 tok/s)", "quick edits", "rapid iteration"],
      weaknesses: ["limited reasoning depth", "not suited for complex multi-file refactors"],
      costTier: "low",
      bestFor: ["implementation"],
      parallelCapable: true,
      reasoningTiers: ["minimal", "low", "medium"]
    },
    {
      provider: "codex",
      modelId: "gpt-5.2-codex",
      displayName: "GPT-5.2 Codex",
      strengths: ["strong implementation", "reliable for standard coding tasks", "test writing"],
      weaknesses: ["previous generation", "less capable than 5.3 on complex tasks"],
      costTier: "medium",
      bestFor: ["implementation"],
      parallelCapable: true,
      reasoningTiers: ["minimal", "low", "medium", "high", "xhigh"]
    },
    {
      provider: "codex",
      modelId: "gpt-5.1-codex-max",
      displayName: "GPT-5.1 Codex Max",
      strengths: ["extended context variant", "large files and repos", "multi-file understanding"],
      weaknesses: ["older generation", "higher latency than newer models"],
      costTier: "medium",
      bestFor: ["implementation"],
      parallelCapable: true,
      reasoningTiers: ["low", "medium", "high"]
    },
    {
      provider: "codex",
      modelId: "codex-mini-latest",
      displayName: "Codex Mini",
      strengths: ["small fast model", "simple tasks", "quick fixes"],
      weaknesses: ["limited capability on complex tasks", "smaller context window"],
      costTier: "low",
      bestFor: ["implementation"],
      parallelCapable: true,
      reasoningTiers: ["low", "medium"]
    },
    {
      provider: "codex",
      modelId: "o4-mini",
      displayName: "o4-mini",
      strengths: ["fast reasoning model", "analysis", "planning with speed"],
      weaknesses: ["less capable than full o3 on deep analysis"],
      costTier: "low",
      bestFor: ["planning", "review"],
      parallelCapable: true,
      reasoningTiers: ["low", "medium", "high"]
    },
    {
      provider: "codex",
      modelId: "o3",
      displayName: "o3",
      strengths: ["advanced reasoning", "complex analysis", "architecture", "deep debugging"],
      weaknesses: ["higher cost", "slower than mini variants"],
      costTier: "high",
      bestFor: ["planning", "review"],
      parallelCapable: false,
      reasoningTiers: ["minimal", "low", "medium", "high"]
    }
  ];
  return { profiles };
}

export function getModelCapabilitiesFromRegistry(modelId: string): ModelCapabilityProfile | null {
  const descriptor = getModelById(modelId);
  if (!descriptor) return null;
  return {
    provider: descriptor.family,
    modelId: descriptor.sdkModelId,
    displayName: descriptor.displayName,
    strengths: [],
    weaknesses: [],
    costTier: descriptor.family === "anthropic"
      ? (descriptor.sdkModelId.includes("opus") ? "very_high" : descriptor.sdkModelId.includes("haiku") ? "low" : "medium")
      : "medium",
    bestFor: [],
    parallelCapable: true,
    reasoningTiers: ["low", "medium", "high"]
  };
}
