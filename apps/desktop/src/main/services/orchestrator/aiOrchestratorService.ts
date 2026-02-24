import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type {
  MissionDetail,
  MissionStep,
  MissionDepthTier,
  MissionDepthConfig,
  MissionExecutionPolicy,
  MissionPlannerEngine,
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
  SteerMissionArgs,
  SteerMissionResult,
  GetMissionDepthConfigArgs,
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
  RecoveryLoopIteration,
  RecoveryDiagnosisTier,
  RecoveryDiagnosis,
  OrchestratorContextView,
  IntegrationPrPolicy,
  PrStrategy,
  SLASH_COMMAND_TRANSLATIONS
} from "../../../shared/types";
import type { ModelConfig, OrchestratorCallType, MissionModelConfig } from "../../../shared/types";
import {
  DEFAULT_RECOVERY_LOOP_POLICY,
  DEFAULT_CONTEXT_VIEW_POLICIES,
  DEFAULT_INTEGRATION_PR_POLICY
} from "../../../shared/types";
import { resolveCallTypeModel, modelConfigToServiceModel, thinkingLevelToReasoningEffort, legacyToModelConfig } from "../../../shared/modelProfiles";
import { resolveExecutionPolicy, depthTierToPolicy, DEFAULT_EXECUTION_POLICY, buildExecutionPlanPreview } from "./executionPolicy";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createMissionService } from "../missions/missionService";
import type { createOrchestratorService } from "./orchestratorService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createLaneService } from "../lanes/laneService";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createPrService } from "../prs/prService";
import { planMissionOnce, plannerPlanToMissionSteps, MissionPlanningError } from "../missions/missionPlanningService";

function inferPrStrategy(args: { laneCount: number; lanesAreCoupled: boolean; userOverride?: PrStrategy }): PrStrategy {
  if (args.userOverride) return args.userOverride;
  if (args.laneCount === 1) return { kind: "per-lane" };
  if (args.lanesAreCoupled) return { kind: "integration" };
  return { kind: "queue" };
}

type MissionRunStartArgs = {
  missionId: string;
  runMode?: "autopilot" | "manual";
  autopilotOwnerId?: string;
  defaultExecutorKind?: OrchestratorExecutorKind;
  defaultRetryLimit?: number;
  metadata?: Record<string, unknown> | null;
  forcePlanReviewBypass?: boolean;
  plannerProvider?: OrchestratorPlannerProvider;
};

type MissionRunStartResult = {
  blockedByPlanReview: boolean;
  started: ReturnType<ReturnType<typeof createOrchestratorService>["startRunFromMission"]> | null;
  mission: MissionDetail | null;
};

type ResolvedOrchestratorConfig = {
  requirePlanReview: boolean;
  defaultDepthTier: MissionDepthTier;
  defaultPlannerProvider: "claude" | "codex" | null;
  defaultExecutionPolicy: Partial<MissionExecutionPolicy> | null;
};

type RuntimeReasoningEffort = "low" | "medium" | "high";

type MissionRuntimeProfile = {
  planning: {
    useAiPlanner: boolean;
    requirePlanReview: boolean;
    preferProvider: "claude" | "codex" | null;
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
    source: "policy" | "legacy_depth_fallback";
    legacyDepthTier: MissionDepthTier | null;
  };
};

const PLAN_REVIEW_INTERVENTION_TITLE = "Mission plan approval required";
const STEERING_DIRECTIVES_METADATA_KEY = "steeringDirectives";
const ORCHESTRATOR_CHAT_METADATA_KEY = "orchestratorChat";
const ORCHESTRATOR_CHAT_SESSION_METADATA_KEY = "orchestratorChatSession";
const MAX_PERSISTED_STEERING_DIRECTIVES = 200;
const MAX_PERSISTED_CHAT_MESSAGES = 200;
const HEALTH_SWEEP_INTERVAL_MS = 5_000;
const HEALTH_SWEEP_ACTIVE_RUN_SCAN_LIMIT = 200;
const STALE_ATTEMPT_GRACE_MS = 10_000;
const WORKER_WAITING_INPUT_INTERVENTION_COOLDOWN_MS = 120_000;
const WORKER_STAGNATION_MIN_MS = 120_000;
const WORKER_STAGNATION_REPEAT_THRESHOLD = 6;
const WORKER_EVENT_HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_CHAT_CONTEXT_CHARS = 4_000;
const MAX_CHAT_CONTEXT_MESSAGES = 8;
const MAX_CHAT_LINE_CHARS = 420;
const MAX_LATEST_CHAT_MESSAGE_CHARS = 1_500;
const SESSION_SIGNAL_RETENTION_MS = 20 * 60_000;
const MAX_STEERING_CONTEXT_DIRECTIVES = 8;
const MAX_STEERING_CONTEXT_CHARS = 1_600;
const MAX_STEERING_DIRECTIVES_PER_STEP = 24;
const ATTEMPT_RUNTIME_PERSIST_INTERVAL_MS = 2_000;
const MAX_RUNTIME_SIGNAL_PREVIEW_CHARS = 320;
const GATE_PHASE_STEP_TYPES = new Set(["test", "validation", "review", "code_review", "test_review", "integration"]);
const QUALITY_GATE_MAX_OUTPUT_CHARS = 4_000;
const DEFAULT_METRIC_TOGGLES: MissionMetricToggle[] = [
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
const KNOWN_METRIC_TOGGLES = new Set<MissionMetricToggle>(DEFAULT_METRIC_TOGGLES);
const DEFAULT_CHAT_VISIBILITY: OrchestratorChatVisibilityMode = "full";
const DEFAULT_CHAT_DELIVERY: OrchestratorChatDeliveryState = "delivered";
const DEFAULT_WORKER_CHAT_VISIBILITY: OrchestratorChatVisibilityMode = "digest_only";
const DEFAULT_THREAD_STATUS = "active";
const DEFAULT_CHAT_THREAD_TITLE = "Mission Coordinator";
const MAX_THREAD_PAGE_SIZE = 200;
const CONTEXT_CHECKPOINT_CHAT_THRESHOLD = 120;
const WORKER_MESSAGE_RETRY_BUDGET = 4;
const WORKER_MESSAGE_RETRY_BACKOFF_BASE_MS = 5_000;
const WORKER_MESSAGE_RETRY_BACKOFF_MAX_MS = 90_000;
const WORKER_MESSAGE_RETRY_INTERVENTION_COOLDOWN_MS = 90_000;
const WORKER_MESSAGE_INFLIGHT_LEASE_MS = 45_000;
const WORKER_MESSAGE_INFLIGHT_STALE_FAIL_MS = 180_000;
const PLANNER_THREAD_ID_PREFIX = "planner";
const PLANNER_THREAD_TITLE = "Planner Agent";
const PLANNER_THREAD_STEP_KEY = "planner";
const PLANNER_STREAM_FLUSH_CHARS = 1_200;
const PLANNER_STREAM_FLUSH_INTERVAL_MS = 1_500;
const MAX_PLANNER_RAW_OUTPUT_CHARS = 4_000_000;

type SessionRuntimeSignal = {
  laneId: string;
  sessionId: string;
  runtimeState: TerminalRuntimeState;
  lastOutputPreview: string | null;
  at: string;
};

type AttemptRuntimeTracker = {
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

type OrchestratorChatSessionState = {
  provider: "claude" | "codex";
  sessionId: string;
  updatedAt: string;
};

type AgentChatSessionSummaryEntry = Awaited<
  ReturnType<ReturnType<typeof createAgentChatService>["listSessions"]>
>[number];

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  settled: boolean;
};

type PlannerTurnCompletionStatus = "completed" | "failed" | "interrupted";

type PlannerTurnCompletion = {
  status: PlannerTurnCompletionStatus;
  rawOutput: string;
  error: string | null;
};

type PlannerAgentSessionState = {
  missionId: string;
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

type WorkerDeliveryContext = {
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

type WorkerDeliverySessionResolution = {
  sessionId: string | null;
  source: "sticky" | "mapped" | "lane_fallback";
  providerHint: "codex" | "claude" | null;
  summary: AgentChatSessionSummaryEntry | null;
  error: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function createDeferred<T>(): Deferred<T> {
  let settle: ((value: T) => void) | null = null;
  let reject: ((error: unknown) => void) | null = null;
  const deferred: Deferred<T> = {
    promise: new Promise<T>((resolve, rejectFn) => {
      settle = resolve;
      reject = rejectFn;
    }),
    resolve(value: T) {
      if (deferred.settled) return;
      deferred.settled = true;
      settle?.(value);
    },
    reject(error: unknown) {
      if (deferred.settled) return;
      deferred.settled = true;
      reject?.(error);
    },
    settled: false
  };
  return deferred;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseSteeringDirective(value: unknown, missionId: string): UserSteeringDirective | null {
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

function parseChatVisibility(value: unknown): OrchestratorChatVisibilityMode | null {
  if (value === "full" || value === "digest_only" || value === "metadata_only") return value;
  return null;
}

const TRANSIENT_ERROR_CLASSES = new Set(["transient", "claim_conflict", "resume_recovered"]);

function classifyFailureTier(args: {
  errorClass: string;
  retryCount: number;
  errorMessage: string | null;
}): RecoveryDiagnosisTier {
  if (TRANSIENT_ERROR_CLASSES.has(args.errorClass)) return "transient";
  if (args.errorClass === "policy") return "blocker";
  if (args.retryCount >= 2) return "blocker";
  return "semantic";
}

function parseChatDeliveryState(value: unknown): OrchestratorChatDeliveryState | null {
  if (value === "queued" || value === "delivered" || value === "failed") return value;
  return null;
}

function parseChatTarget(value: unknown): OrchestratorChatTarget | null {
  if (!isRecord(value)) return null;
  const kind = value.kind === "coordinator" || value.kind === "worker" || value.kind === "workers" ? value.kind : null;
  if (!kind) return null;
  if (kind === "coordinator") {
    return {
      kind: "coordinator",
      runId: typeof value.runId === "string" ? value.runId : null
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

function parseThreadType(value: unknown): OrchestratorChatThreadType | null {
  if (value === "mission" || value === "worker") return value;
  return null;
}

function fallbackLegacyChatMessageId(value: Record<string, unknown>, missionId: string, ordinalHint: number): string {
  const normalizedOrdinal = Number.isFinite(ordinalHint) ? Math.max(0, Math.floor(ordinalHint)) : 0;
  const rawTarget = isRecord(value.target) ? JSON.stringify(value.target) : "";
  const seed = [
    missionId,
    typeof value.role === "string" ? value.role : "",
    typeof value.content === "string" ? value.content : "",
    typeof value.timestamp === "string" ? value.timestamp : "",
    typeof value.threadId === "string" ? value.threadId : "",
    typeof value.stepKey === "string" ? value.stepKey : "",
    rawTarget,
    String(normalizedOrdinal)
  ].join("|");
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `legacy:${digest}`;
}

function parseChatMessage(value: unknown, missionId: string, ordinalHint = 0): OrchestratorChatMessage | null {
  if (!isRecord(value)) return null;
  const role = value.role === "user" || value.role === "orchestrator" || value.role === "worker"
    ? value.role
    : null;
  const content = typeof value.content === "string" ? value.content.trim() : "";
  const timestamp = typeof value.timestamp === "string" ? value.timestamp : nowIso();
  if (!role || !content.length) return null;
  return {
    id:
      typeof value.id === "string" && value.id.trim().length
        ? value.id
        : fallbackLegacyChatMessageId(value, missionId, ordinalHint),
    missionId,
    role,
    content,
    timestamp,
    stepKey: typeof value.stepKey === "string" ? value.stepKey : null,
    threadId: typeof value.threadId === "string" ? value.threadId : null,
    target: parseChatTarget(value.target),
    visibility: parseChatVisibility(value.visibility) ?? DEFAULT_CHAT_VISIBILITY,
    deliveryState: parseChatDeliveryState(value.deliveryState) ?? DEFAULT_CHAT_DELIVERY,
    sourceSessionId: typeof value.sourceSessionId === "string" ? value.sourceSessionId : null,
    attemptId: typeof value.attemptId === "string" ? value.attemptId : null,
    laneId: typeof value.laneId === "string" ? value.laneId : null,
    runId: typeof value.runId === "string" ? value.runId : null,
    metadata: isRecord(value.metadata) ? value.metadata : null
  };
}

function parseChatSessionState(value: unknown): OrchestratorChatSessionState | null {
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

function normalizeSignalText(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function digestSignalText(value: string | null | undefined): string | null {
  const normalized = normalizeSignalText(value);
  if (!normalized.length) return null;
  // Keep a compact deterministic fingerprint without importing heavier crypto deps.
  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  return String(hash);
}

function buildQuestionThreadLink(args: {
  attemptId: string;
  occurredAt: string;
  preview: string | null | undefined;
}): OrchestratorRuntimeQuestionLink {
  const attemptId = String(args.attemptId ?? "").trim();
  const threadId = `question:${attemptId}`;
  const digest = digestSignalText(args.preview) ?? "none";
  const secondBucket = Math.max(0, Math.floor(Date.parse(args.occurredAt) / 1000) || 0);
  return {
    threadId,
    messageId: `question_msg:${attemptId}:${digest}:${secondBucket}`,
    replyTo: null
  };
}

function buildQuestionReplyLink(args: {
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

function parseQuestionLink(value: unknown): OrchestratorRuntimeQuestionLink | null {
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

function detectWaitingInputSignal(text: string | null | undefined): boolean {
  const normalized = normalizeSignalText(text);
  if (!normalized.length) return false;
  return /\b(waiting for|need(?:s)? (?:your|user|operator) input|requires? (?:approval|confirmation)|please (?:confirm|choose|select|provide)|which (?:option|one)|can you clarify|press enter|y\/n|yes\/no)\b/i.test(normalized);
}

function clipTextForContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function workerStateFromRuntimeSignal(args: {
  runtimeState: TerminalRuntimeState;
  waitingForInput: boolean;
}): OrchestratorWorkerStatus {
  if (args.waitingForInput) return "waiting_input";
  if (args.runtimeState === "idle") return "idle";
  if (args.runtimeState === "running") return "working";
  if (args.runtimeState === "killed") return "disposed";
  return "working";
}

function parseTerminalRuntimeState(raw: unknown): TerminalRuntimeState | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "running" || value === "waiting-input" || value === "idle" || value === "exited" || value === "killed") {
    return value;
  }
  return null;
}

function parseJsonRecord(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function missionThreadId(missionId: string): string {
  return `mission:${missionId}`;
}

function plannerThreadId(missionId: string): string {
  return `${PLANNER_THREAD_ID_PREFIX}:${missionId}`;
}

function clampLimit(rawLimit: number | null | undefined, fallback: number, max = MAX_THREAD_PAGE_SIZE): number {
  const numeric = Number(rawLimit);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(numeric)));
}

function normalizeChatVisibility(value: unknown, fallback: OrchestratorChatVisibilityMode = DEFAULT_CHAT_VISIBILITY): OrchestratorChatVisibilityMode {
  return parseChatVisibility(value) ?? fallback;
}

function normalizeChatDeliveryState(value: unknown, fallback: OrchestratorChatDeliveryState = DEFAULT_CHAT_DELIVERY): OrchestratorChatDeliveryState {
  return parseChatDeliveryState(value) ?? fallback;
}

function normalizeThreadType(value: unknown, fallback: OrchestratorChatThreadType = "mission"): OrchestratorChatThreadType {
  return parseThreadType(value) ?? fallback;
}

function toOptionalString(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw.length > 0 ? raw : null;
}

function sanitizeChatTarget(target: OrchestratorChatTarget | null | undefined): OrchestratorChatTarget | null {
  if (!target) return null;
  if (target.kind === "coordinator") {
    return {
      kind: "coordinator",
      runId: toOptionalString(target.runId)
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
  if (target.kind === "agent") {
    return {
      kind: "agent",
      sourceAttemptId: target.sourceAttemptId,
      targetAttemptId: target.targetAttemptId,
      runId: toOptionalString(target.runId),
      laneId: toOptionalString(target.laneId)
    };
  }
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

function parseWorkerProviderHint(raw: unknown): "codex" | "claude" | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!value.length) return null;
  if (value.includes("claude")) return "claude";
  if (value.includes("codex")) return "codex";
  return null;
}

function workerThreadIdentity(target: OrchestratorChatTarget | null | undefined): string | null {
  if (!target || target.kind !== "worker") return null;
  const options = [target.attemptId, target.sessionId, target.stepId, target.stepKey, target.laneId];
  for (const value of options) {
    const normalized = toOptionalString(value);
    if (normalized) return normalized;
  }
  return null;
}

function deriveThreadTitle(args: {
  threadType: OrchestratorChatThreadType;
  target: OrchestratorChatTarget | null;
  fallback?: string | null;
}): string {
  if (args.threadType === "mission") {
    return toOptionalString(args.fallback) ?? DEFAULT_CHAT_THREAD_TITLE;
  }
  const target = args.target && args.target.kind === "worker" ? args.target : null;
  if (!target) return "Worker Chat";
  const suffix =
    toOptionalString(target.stepKey)
    ?? toOptionalString(target.stepId)
    ?? toOptionalString(target.attemptId)
    ?? toOptionalString(target.sessionId)
    ?? toOptionalString(target.laneId)
    ?? "worker";
  return `Worker ${suffix}`;
}

function readConfig(projectConfigService: ReturnType<typeof createProjectConfigService> | null | undefined): ResolvedOrchestratorConfig {
  const snapshot = projectConfigService?.get();
  const ai = snapshot?.effective?.ai;
  const orchestrator = isRecord(ai) && isRecord(ai.orchestrator) ? (ai.orchestrator as Record<string, unknown>) : {};
  const requirePlanReview = asBool(orchestrator.requirePlanReview, asBool(orchestrator.require_plan_review, false));
  const defaultDepthTierRaw = (asString(orchestrator.defaultDepthTier) ?? asString(orchestrator.default_depth_tier) ?? "").trim();
  const defaultDepthTier: MissionDepthTier =
    defaultDepthTierRaw === "light" || defaultDepthTierRaw === "standard" || defaultDepthTierRaw === "deep"
      ? defaultDepthTierRaw
      : "standard";
  const defaultPlannerProviderRaw =
    (asString(orchestrator.defaultPlannerProvider) ?? asString(orchestrator.default_planner_provider) ?? "").trim();
  const defaultPlannerProvider: "claude" | "codex" | null =
    defaultPlannerProviderRaw === "claude" || defaultPlannerProviderRaw === "codex"
      ? defaultPlannerProviderRaw
      : null;
  const defaultExecutionPolicy = isRecord(orchestrator.defaultExecutionPolicy)
    ? (orchestrator.defaultExecutionPolicy as Partial<MissionExecutionPolicy>)
    : isRecord(orchestrator.default_execution_policy)
      ? (orchestrator.default_execution_policy as Partial<MissionExecutionPolicy>)
      : null;
  return {
    requirePlanReview,
    defaultDepthTier,
    defaultPlannerProvider,
    defaultExecutionPolicy
  };
}

function mapOrchestratorStepStatus(status: OrchestratorStepStatus): MissionStepStatus {
  if (status === "running") return "running";
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  if (status === "skipped") return "skipped";
  if (status === "canceled") return "canceled";
  return "pending";
}

function deriveMissionStatusFromRun(graph: OrchestratorRunGraph, mission: MissionDetail): MissionStatus {
  if (graph.run.status === "succeeded") return "completed";
  if (graph.run.status === "succeeded_with_risk") return "completed";
  if (graph.run.status === "failed") return mission.openInterventions > 0 ? "intervention_required" : "failed";
  if (graph.run.status === "canceled") return "canceled";
  if (graph.run.status === "paused") return "intervention_required";
  if (graph.run.status === "queued") return "planning";
  return mission.openInterventions > 0 ? "intervention_required" : "in_progress";
}

function buildOutcomeSummary(graph: OrchestratorRunGraph): string {
  const total = graph.steps.length;
  const succeeded = graph.steps.filter((step) => step.status === "succeeded").length;
  const failed = graph.steps.filter((step) => step.status === "failed").length;
  const blocked = graph.steps.filter((step) => step.status === "blocked").length;
  const attempts = graph.attempts.length;
  let summary = `Run ${graph.run.id.slice(0, 8)} finished: ${succeeded}/${total} steps succeeded, ${failed} failed, ${blocked} blocked across ${attempts} attempt${attempts === 1 ? "" : "s"}.`;
  if (graph.completionEvaluation?.riskFactors?.length) {
    summary += ` Risk factors: ${graph.completionEvaluation.riskFactors.join(", ")}.`;
  }
  return summary;
}

// ─────────────────────────────────────────────────────
// Depth-to-Config Resolution
// ─────────────────────────────────────────────────────

export function resolveMissionDepthConfig(tier: MissionDepthTier): MissionDepthConfig {
  switch (tier) {
    case "light":
      return {
        tier: "light",
        planning: {
          useAiPlanner: false,
          maxPlanningTimeMs: 5_000,
          requirePlanReview: false
        },
        execution: {
          maxParallelWorkers: 1,
          defaultRetryLimit: 1,
          stepTimeoutMs: 120_000,
          maxTotalTokenBudget: 50_000,
          maxPerStepTokenBudget: 25_000
        },
        evaluation: {
          evaluateEveryStep: false,
          autoAdjustPlan: false,
          autoResolveInterventions: false,
          interventionConfidenceThreshold: 1.0
        },
        context: {
          contextProfile: "orchestrator_deterministic_v1",
          includeNarrative: false,
          docsMode: "digest_refs"
        }
      };
    case "deep":
      return {
        tier: "deep",
        planning: {
          useAiPlanner: true,
          plannerModel: "claude-opus-4-6",
          maxPlanningTimeMs: 120_000,
          requirePlanReview: false
        },
        execution: {
          maxParallelWorkers: 6,
          defaultRetryLimit: 3,
          stepTimeoutMs: 600_000,
          maxTotalTokenBudget: 2_500_000,
          maxPerStepTokenBudget: 500_000
        },
        evaluation: {
          evaluateEveryStep: true,
          evaluationModel: "claude-sonnet-4-6",
          autoAdjustPlan: true,
          autoResolveInterventions: true,
          interventionConfidenceThreshold: 0.7
        },
        context: {
          contextProfile: "orchestrator_narrative_opt_in_v1",
          includeNarrative: true,
          docsMode: "full_docs"
        }
      };
    case "standard":
    default:
      return {
        tier: "standard",
        planning: {
          useAiPlanner: true,
          plannerModel: "claude-sonnet-4-6",
          maxPlanningTimeMs: 60_000,
          requirePlanReview: false
        },
        execution: {
          maxParallelWorkers: 3,
          defaultRetryLimit: 2,
          stepTimeoutMs: 300_000,
          maxTotalTokenBudget: 500_000,
          maxPerStepTokenBudget: 150_000
        },
        evaluation: {
          evaluateEveryStep: false,
          evaluationModel: "claude-sonnet-4-6",
          autoAdjustPlan: true,
          autoResolveInterventions: true,
          interventionConfidenceThreshold: 0.85
        },
        context: {
          contextProfile: "orchestrator_deterministic_v1",
          includeNarrative: false,
          docsMode: "digest_refs"
        }
      };
  }
}

function normalizeReasoningEffort(value: unknown, fallback: RuntimeReasoningEffort): RuntimeReasoningEffort {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") return normalized;
  return fallback;
}

function deriveRuntimeProfileFromPolicy(
  policy: MissionExecutionPolicy,
  config: ResolvedOrchestratorConfig
): MissionRuntimeProfile {
  const testingEnabled = policy.testing.mode !== "none";
  const reviewEnabled = policy.codeReview.mode !== "off" || policy.testReview.mode !== "off";
  const strictGates =
    policy.validation.mode === "required"
    || policy.codeReview.mode === "required"
    || policy.testReview.mode === "required"
    || policy.completion.allowCompletionWithRisk === false;
  const integrationEnabled = policy.integration.mode === "auto";

  let maxParallelWorkers = 2;
  if (testingEnabled) maxParallelWorkers += 1;
  if (reviewEnabled) maxParallelWorkers += 1;
  if (integrationEnabled) maxParallelWorkers += 1;
  if (policy.testing.mode === "tdd") maxParallelWorkers = Math.max(maxParallelWorkers, 4);
  maxParallelWorkers = Math.max(1, Math.min(6, maxParallelWorkers));

  let stepTimeoutMs = 300_000;
  if (!testingEnabled && !reviewEnabled && !integrationEnabled) {
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
      autoAdjustPlan: policy.planning.mode !== "off" || integrationEnabled || reviewEnabled,
      autoResolveInterventions: testingEnabled || reviewEnabled || integrationEnabled,
      interventionConfidenceThreshold: strictGates ? 0.75 : 0.9,
      evaluationReasoningEffort: normalizeReasoningEffort(
        policy.codeReview.reasoningEffort ?? policy.testReview.reasoningEffort ?? policy.validation.reasoningEffort,
        strictGates ? "high" : "medium"
      ),
      interventionReasoningEffort: normalizeReasoningEffort(
        policy.integration.reasoningEffort ?? policy.planning.reasoningEffort,
        strictGates ? "high" : "medium"
      )
    },
    context: {
      contextProfile,
      includeNarrative,
      docsMode: includeNarrative ? "full_docs" : "digest_refs"
    },
    provenance: {
      source: "policy",
      legacyDepthTier: null
    }
  };
}

function deriveRuntimeProfileFromDepthConfig(
  depthConfig: MissionDepthConfig,
  config: ResolvedOrchestratorConfig
): MissionRuntimeProfile {
  const preferProvider = depthConfig.planning.plannerModel?.toLowerCase().includes("claude")
    ? "claude"
    : depthConfig.planning.plannerModel?.toLowerCase().includes("codex")
      ? "codex"
      : config.defaultPlannerProvider;
  return {
    planning: {
      useAiPlanner: depthConfig.planning.useAiPlanner,
      requirePlanReview: depthConfig.planning.requirePlanReview,
      preferProvider: preferProvider ?? null
    },
    execution: {
      maxParallelWorkers: depthConfig.execution.maxParallelWorkers,
      defaultRetryLimit: depthConfig.execution.defaultRetryLimit,
      stepTimeoutMs: depthConfig.execution.stepTimeoutMs
    },
    evaluation: {
      evaluateEveryStep: depthConfig.evaluation.evaluateEveryStep,
      autoAdjustPlan: depthConfig.evaluation.autoAdjustPlan,
      autoResolveInterventions: depthConfig.evaluation.autoResolveInterventions,
      interventionConfidenceThreshold: depthConfig.evaluation.interventionConfidenceThreshold,
      evaluationReasoningEffort: depthConfig.tier === "deep" ? "high" : "medium",
      interventionReasoningEffort: depthConfig.tier === "deep" ? "high" : "medium"
    },
    context: {
      contextProfile: depthConfig.context.contextProfile,
      includeNarrative: depthConfig.context.includeNarrative,
      docsMode: depthConfig.context.docsMode
    },
    provenance: {
      source: "legacy_depth_fallback",
      legacyDepthTier: depthConfig.tier
    }
  };
}

// ─────────────────────────────────────────────────────
// Model Capability Profiles
// ─────────────────────────────────────────────────────

export function getModelCapabilities(): GetModelCapabilitiesResult {
  const profiles: ModelCapabilityProfile[] = [
    // ── Claude models ──
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
    // ── Codex models ──
    {
      provider: "codex",
      modelId: "gpt-5.3-codex",
      displayName: "GPT-5.3 Codex",
      strengths: ["latest and most capable coding model", "excellent implementation", "testing", "code review"],
      weaknesses: ["narrative prose", "complex architectural reasoning"],
      costTier: "medium",
      bestFor: ["implementation", "review"],
      parallelCapable: true,
      reasoningTiers: ["low", "medium", "high", "extra_high"]
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
      reasoningTiers: ["low", "medium"]
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
      reasoningTiers: ["low", "medium", "high", "extra_high"]
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
      reasoningTiers: ["low", "medium", "high", "extra_high"]
    }
  ];
  return { profiles };
}

// ─────────────────────────────────────────────────────
// PM Personality prompt fragments
// ─────────────────────────────────────────────────────

const PM_SYSTEM_PREAMBLE = [
  "You are a senior Project Manager orchestrating a development team of AI agents.",
  "You think ahead, communicate proactively, and make autonomous decisions when safe.",
  "",
  "Core operating principles:",
  "1. PROACTIVE OVER REACTIVE: Don't wait for problems — anticipate them. If a step is likely to affect downstream work, flag it before it lands.",
  "2. COMMUNICATE LIKE A PM: Explain your reasoning naturally. 'Skipping the redundant lint step because implementation already ran the linter' beats 'skip_step: redundant'.",
  "3. UNBLOCK FIRST: Always prioritize work that unblocks other work. If step A blocks steps B, C, D — step A is urgent even if step E is easier.",
  "4. AUTONOMOUS WHEN SAFE: Make decisions without escalating when the action is reversible and the intent is clear. Escalate when the action is destructive, ambiguous, or contradicts user instructions.",
  "5. CONTEXT IS KING: Reference specific step outputs, file names, and error messages. Never give generic feedback without citing specifics.",
  "6. SCOPE AWARENESS: Understand the full mission graph. Know what's done, what's running, what's blocked, and what's next. Every decision should account for the bigger picture.",
  "",
  "Model capability context:",
  "- Claude Opus 4.6: Very high cost. Best for complex architectural planning and nuanced review. Do NOT use for bulk implementation.",
  "- Claude Sonnet 4.6: Medium cost. Fast, great for code review, planning, narrative, and evaluation.",
  "- Claude Haiku 4.5: Low cost, fastest Claude. Good for narrative, summaries, and quick classification.",
  "- GPT-5.3 Codex: Medium cost, latest and most capable coding model. Excellent for implementation and testing. Parallel capable.",
  "- GPT-5.3 Codex Spark: Low cost, real-time coding (>1000 tok/s). Great for quick edits and rapid iteration.",
  "- GPT-5.2 Codex: Medium cost, previous gen but still strong for implementation. Parallel capable.",
  "- GPT-5.1 Codex Max: Extended context variant for large files/repos.",
  "- Codex Mini: Low cost, small fast model for simple tasks and quick fixes.",
  "- o4-mini: Low cost, fast reasoning model for analysis and planning with speed.",
  "- o3: High cost, advanced reasoning for complex analysis and architecture.",
  "",
  "Smart task grouping guidelines:",
  "- Combine related subtasks into a single agent's scope when the model is powerful enough.",
  "- Don't split frontend+middleware+backend into 3 agents if one powerful agent (GPT-5.3 Codex) can handle it.",
  "- Don't over-split work for capable agents. Fewer, well-scoped tasks beat many tiny ones.",
  "- Reserve task splitting for genuinely independent workstreams or when mixing Claude (review) and Codex (implementation).",
  ""
].join("\n");

function extractRunFailureMessage(graph: OrchestratorRunGraph): string | null {
  const latestFailure = [...graph.attempts]
    .filter((attempt) => attempt.status === "failed")
    .sort((a, b) => Date.parse(b.completedAt ?? b.createdAt) - Date.parse(a.completedAt ?? a.createdAt))[0];
  if (!latestFailure) return graph.run.lastError ?? null;
  return latestFailure.errorMessage ?? latestFailure.resultEnvelope?.summary ?? graph.run.lastError ?? null;
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
  projectRoot?: string;
  onThreadEvent?: (event: OrchestratorThreadEvent) => void;
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
    projectRoot,
    onThreadEvent
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

  // ── Persistent Coordinator Sessions ──
  // A long-running AI session per mission run that accumulates understanding
  // by receiving runtime events as messages. Uses aiIntegrationService.executeTask
  // with sessionId for multi-turn conversation support.
  const coordinatorSessions = new Map<string, {
    sessionId: string | null;   // null until first executeTask returns a sessionId
    missionId: string;
    runId: string;
    modelConfig: ModelConfig;   // resolved model config for coordinator calls
    startedAt: string;
    eventCount: number;
    lastEventAt: string | null;
    dead: boolean;
    systemPrompt: string;
    pendingInit: Promise<void> | null;  // guards against concurrent init
  }>();

  let healthSweepTimer: NodeJS.Timeout | null = null;
  let disposed = false;

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
      threadType: "mission",
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
      const threadType: OrchestratorChatThreadType = target?.kind === "worker" ? "worker" : "mission";
      return upsertThread({
        missionId,
        threadId: requestedThreadId,
        threadType,
        title: deriveThreadTitle({
          threadType,
          target,
          fallback: args.fallbackTitle
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
        threadType: "worker",
        target,
        fallback: args.fallbackTitle
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

  const startCoordinatorSession = async (
    missionId: string,
    runId: string,
    plan: { steps: Array<{ stepKey: string; title: string; status: string; dependencyStepIds: string[] }> },
    coordinatorModelConfig?: ModelConfig | null
  ): Promise<string | null> => {
    if (!aiIntegrationService || !projectRoot) {
      logger.debug("ai_orchestrator.coordinator_session_skip", {
        missionId,
        reason: !aiIntegrationService ? "no_ai_integration_service" : "no_project_root"
      });
      return null;
    }

    try {
      const planSummary = plan.steps
        .map((s) => `- ${s.stepKey}: "${s.title}" [${s.status}]${s.dependencyStepIds.length ? ` (deps: ${s.dependencyStepIds.length})` : ""}`)
        .join("\n");

      const coordinatorSystemPrompt = [
        PM_SYSTEM_PREAMBLE,
        "",
        "You are the persistent coordinator for this mission run. You observe events and intervene when needed.",
        "",
        "MISSION PLAN:",
        planSummary,
        "",
        "AVAILABLE ACTIONS (use these as commands on their own line):",
        "  steer <stepKey> <message> — send guidance to a specific worker",
        "  skip <stepKey> <reason> — skip a step that's unnecessary",
        "  add_step <after_stepKey> <title> | <instructions> — add a new step after an existing one",
        "  broadcast <message> — send a message to all active workers",
        "  escalate <reason> — flag something for the human operator",
        "",
        "BEHAVIOR:",
        "- Most events need no action — just acknowledge and track internally.",
        "- Only intervene when something is wrong or an opportunity is spotted.",
        "- Respond in concise, casual English. No formal reports.",
        "- Keep responses to 1-3 sentences unless a complex situation requires more.",
        "- If you take an action, state what you're doing and why in one line before the command."
      ].join("\n");

      // Register the session entry immediately so events don't race ahead of init
      const resolvedConfig = coordinatorModelConfig ?? resolveOrchestratorModelConfig(missionId, "coordinator");
      const entry: typeof coordinatorSessions extends Map<string, infer V> ? V : never = {
        sessionId: null,
        missionId,
        runId,
        modelConfig: resolvedConfig,
        startedAt: nowIso(),
        eventCount: 0,
        lastEventAt: null,
        dead: false,
        systemPrompt: coordinatorSystemPrompt,
        pendingInit: null
      };
      coordinatorSessions.set(runId, entry);

      // Fire the initial "session started" turn to establish the AI session
      const initPromise = (async () => {
        try {
          const result = await aiIntegrationService.executeTask({
            feature: "orchestrator" as const,
            taskType: "review" as const,
            prompt: [
              "Mission run started. You are the persistent coordinator for this run.",
              `${plan.steps.length} steps in the plan.`,
              "Acknowledge and stand by for events. Keep this response very brief."
            ].join(" "),
            cwd: projectRoot,
            provider: resolvedConfig.provider === "codex" ? "codex" : "claude",
            model: modelConfigToServiceModel(resolvedConfig),
            systemPrompt: coordinatorSystemPrompt,
            reasoningEffort: thinkingLevelToReasoningEffort(resolvedConfig.thinkingLevel),
            permissionMode: "read-only" as const,
            oneShot: true,
            timeoutMs: 30_000
          });

          if (typeof result.sessionId === "string" && result.sessionId.trim().length > 0) {
            entry.sessionId = result.sessionId.trim();
            logger.info("ai_orchestrator.coordinator_session_started", {
              missionId,
              runId,
              sessionId: entry.sessionId,
              initResponseChars: result.text?.length ?? 0
            });
          } else {
            // No sessionId returned — provider may not support multi-turn resume.
            // Session is still usable in a degraded stateless mode (each event is independent).
            logger.warn("ai_orchestrator.coordinator_session_no_session_id", {
              missionId,
              runId,
              reason: "executeTask did not return a sessionId — coordinator will operate in stateless mode"
            });
          }
        } catch (error) {
          entry.dead = true;
          logger.warn("ai_orchestrator.coordinator_session_init_failed", {
            missionId,
            runId,
            error: error instanceof Error ? error.message : String(error)
          });
        } finally {
          entry.pendingInit = null;
        }
      })();

      entry.pendingInit = initPromise;
      // Don't await — let init happen in background so startMissionRun isn't blocked
      return runId; // Return runId as a handle; actual sessionId is set asynchronously
    } catch (error) {
      logger.warn("ai_orchestrator.coordinator_session_start_failed", {
        missionId,
        runId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  };

  const sendCoordinatorEvent = async (runId: string, eventMessage: string): Promise<void> => {
    const session = coordinatorSessions.get(runId);
    if (!session || session.dead || !aiIntegrationService || !projectRoot) return;

    // Wait for init to complete if still in progress
    if (session.pendingInit) {
      try {
        await session.pendingInit;
      } catch {
        // Init failure already handled and session marked dead
        return;
      }
    }

    if (session.dead) return; // Re-check after init

    try {
      session.eventCount++;
      session.lastEventAt = nowIso();

      const result = await aiIntegrationService.executeTask({
        feature: "orchestrator" as const,
        taskType: "review" as const,
        prompt: eventMessage,
        cwd: projectRoot,
        provider: session.modelConfig.provider === "codex" ? "codex" : "claude",
        model: modelConfigToServiceModel(session.modelConfig),
        systemPrompt: session.systemPrompt,
        reasoningEffort: thinkingLevelToReasoningEffort(session.modelConfig.thinkingLevel),
        permissionMode: "read-only" as const,
        oneShot: true,
        timeoutMs: 20_000,
        // Resume the existing session if we have a sessionId
        ...(session.sessionId ? { sessionId: session.sessionId } : {})
      });

      // Update sessionId if returned (first turn or session rotation)
      if (typeof result.sessionId === "string" && result.sessionId.trim().length > 0) {
        session.sessionId = result.sessionId.trim();
      }

      // Parse coordinator response for action commands
      const responseText = String(result.text ?? "").trim();
      if (responseText.length > 0) {
        parseAndDispatchCoordinatorActions(session.missionId, runId, responseText);
      }
    } catch (error) {
      logger.warn("ai_orchestrator.coordinator_event_failed", {
        runId,
        missionId: session.missionId,
        eventCount: session.eventCount,
        error: error instanceof Error ? error.message : String(error)
      });
      // Mark session as dead after failure so we don't keep retrying
      session.dead = true;
      logger.warn("ai_orchestrator.coordinator_session_dead", {
        runId,
        missionId: session.missionId,
        reason: "event_send_failed"
      });
    }
  };

  const parseAndDispatchCoordinatorActions = (missionId: string, runId: string, responseText: string): void => {
    // Look for action commands in the response (one per line)
    const lines = responseText.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();

      // steer <stepKey> <message>
      const steerMatch = trimmed.match(/^steer\s+(\S+)\s+(.+)$/i);
      if (steerMatch) {
        const [, stepKey, message] = steerMatch;
        logger.info("ai_orchestrator.coordinator_action_steer", { missionId, runId, stepKey, message: message.slice(0, 200) });
        emitOrchestratorMessage(missionId, `Coordinator steering ${stepKey}: ${message}`, stepKey);
        continue;
      }

      // skip <stepKey> <reason>
      const skipMatch = trimmed.match(/^skip\s+(\S+)\s+(.+)$/i);
      if (skipMatch) {
        const [, stepKey, reason] = skipMatch;
        logger.info("ai_orchestrator.coordinator_action_skip", { missionId, runId, stepKey, reason: reason.slice(0, 200) });
        emitOrchestratorMessage(missionId, `Coordinator recommends skipping ${stepKey}: ${reason}`, stepKey);
        continue;
      }

      // broadcast <message>
      const broadcastMatch = trimmed.match(/^broadcast\s+(.+)$/i);
      if (broadcastMatch) {
        const [, message] = broadcastMatch;
        logger.info("ai_orchestrator.coordinator_action_broadcast", { missionId, runId, message: message.slice(0, 200) });
        emitOrchestratorMessage(missionId, `Coordinator broadcast: ${message}`);
        continue;
      }

      // escalate <reason>
      const escalateMatch = trimmed.match(/^escalate\s+(.+)$/i);
      if (escalateMatch) {
        const [, reason] = escalateMatch;
        logger.info("ai_orchestrator.coordinator_action_escalate", { missionId, runId, reason: reason.slice(0, 200) });
        emitOrchestratorMessage(missionId, `Coordinator escalation: ${reason}`);
        continue;
      }
    }
  };

  const endCoordinatorSession = (runId: string): void => {
    const session = coordinatorSessions.get(runId);
    if (!session) return;
    coordinatorSessions.delete(runId);
    logger.info("ai_orchestrator.coordinator_session_ended", {
      runId,
      missionId: session.missionId,
      sessionId: session.sessionId,
      eventCount: session.eventCount,
      durationMs: Date.now() - Date.parse(session.startedAt)
    });
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
  }): OrchestratorChatThread => {
    return upsertThread({
      missionId: args.missionId,
      threadId: plannerThreadId(args.missionId),
      threadType: "worker",
      title: PLANNER_THREAD_TITLE,
      target: {
        kind: "worker",
        runId: null,
        stepId: null,
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
        runId: null,
        stepId: null,
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
      runId: null,
      stepKey: PLANNER_THREAD_STEP_KEY,
      metadata: metadata ?? null
    });
  };

  const flushPlannerStreamBuffer = (state: PlannerAgentSessionState, force = false): void => {
    if (!state.streamBuffer.length) return;
    if (!force) {
      const hasParagraphBreak = /\n{2,}/.test(state.streamBuffer);
      const exceededChunkThreshold = state.streamBuffer.length >= PLANNER_STREAM_FLUSH_CHARS;
      const exceededInterval = Date.now() - state.lastStreamFlushAtMs >= PLANNER_STREAM_FLUSH_INTERVAL_MS;
      if (!hasParagraphBreak && !exceededChunkThreshold && !exceededInterval) {
        return;
      }
    }

    let chunk = state.streamBuffer;
    if (!force) {
      let boundary = Math.min(state.streamBuffer.length, PLANNER_STREAM_FLUSH_CHARS);
      const lastNewline = state.streamBuffer.lastIndexOf("\n", boundary);
      if (lastNewline >= 120) {
        boundary = lastNewline + 1;
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
    const delta = String(rawDelta ?? "");
    if (!delta.length) return;
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
      | "intervention_resolved";
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

  const resolveActivePolicy = (missionId: string): MissionExecutionPolicy => {
    const metadata = getMissionMetadata(missionId);
    const config = readConfig(projectConfigService);

    // 1) Mission metadata explicit policy
    if (isRecord(metadata.executionPolicy)) {
      return resolveExecutionPolicy({
        missionMetadata: metadata.executionPolicy as Partial<MissionExecutionPolicy>
      });
    }

    // 2) Mission legacy depth (mission-local backward compatibility)
    if (typeof metadata.missionDepth === "string") {
      const tier = metadata.missionDepth as MissionDepthTier;
      if (tier === "light" || tier === "standard" || tier === "deep") {
        return depthTierToPolicy(tier);
      }
    }

    // 3) Project default execution policy
    if (config.defaultExecutionPolicy) {
      return resolveExecutionPolicy({
        projectConfig: config.defaultExecutionPolicy
      });
    }

    // 4) Project legacy depth default
    if (config.defaultDepthTier !== "standard") {
      return depthTierToPolicy(config.defaultDepthTier);
    }

    // 5) Built-in default policy
    return DEFAULT_EXECUTION_POLICY;
  };

  const resolveActiveRuntimeProfile = (missionId: string): MissionRuntimeProfile => {
    const metadata = getMissionMetadata(missionId);
    const config = readConfig(projectConfigService);

    if (isRecord(metadata.executionPolicy)) {
      const policy = resolveExecutionPolicy({
        missionMetadata: metadata.executionPolicy as Partial<MissionExecutionPolicy>
      });
      return deriveRuntimeProfileFromPolicy(policy, config);
    }

    if (typeof metadata.missionDepth === "string") {
      const tier = metadata.missionDepth as MissionDepthTier;
      if (tier === "light" || tier === "standard" || tier === "deep") {
        return deriveRuntimeProfileFromDepthConfig(resolveMissionDepthConfig(tier), config);
      }
    }

    if (config.defaultExecutionPolicy) {
      const policy = resolveExecutionPolicy({
        projectConfig: config.defaultExecutionPolicy
      });
      return deriveRuntimeProfileFromPolicy(policy, config);
    }

    if (config.defaultDepthTier !== "standard") {
      return deriveRuntimeProfileFromDepthConfig(resolveMissionDepthConfig(config.defaultDepthTier), config);
    }

    return deriveRuntimeProfileFromPolicy(DEFAULT_EXECUTION_POLICY, config);
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
      .filter((run) => run.status === "queued" || run.status === "running" || run.status === "paused");
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
      .filter((run) => run.status === "queued" || run.status === "running" || run.status === "paused");
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

  const shouldTreatAsStagnating = (attemptId: string, stagnantMs: number, stepTimeoutMs: number): boolean => {
    const tracker = ensureAttemptRuntimeTracker(attemptId);
    if (tracker.repeatCount < WORKER_STAGNATION_REPEAT_THRESHOLD) return false;
    const threshold = Math.max(
      WORKER_STAGNATION_MIN_MS,
      Math.min(12 * 60_000, Math.floor(stepTimeoutMs * 0.4))
    );
    return stagnantMs >= threshold;
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
    const explicitStepTimeout = Number(stepMeta.timeoutMs);
    const planStepTimeout = Number(planStep?.timeoutMs ?? NaN);
    const runtimeProfile = runRuntimeProfiles.get(args.runId) ?? resolveActiveRuntimeProfile(args.missionId);
    const fallback = runtimeProfile.execution.stepTimeoutMs;
    const raw =
      Number.isFinite(explicitStepTimeout) && explicitStepTimeout > 0
        ? explicitStepTimeout
        : Number.isFinite(planStepTimeout) && planStepTimeout > 0
          ? planStepTimeout
          : fallback;
    return Math.max(30_000, Math.floor(raw));
  };

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
      upsertWorkerState(attempt.attemptId, {
        runId: attempt.runId,
        stepId: attempt.stepId,
        sessionId,
        executorKind: attempt.executorKind,
        state: runtimeWorkerState
      });

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

  const getRecentSessionActivityAt = (sessionState: {
    lastOutputAt: string | null;
    transcriptPath: string | null;
  } | null): number => {
    if (!sessionState) return Number.NaN;
    let latest = Number.NaN;
    const lastOutputMs = sessionState.lastOutputAt ? Date.parse(sessionState.lastOutputAt) : Number.NaN;
    if (Number.isFinite(lastOutputMs)) latest = lastOutputMs;

    const transcriptPath = typeof sessionState.transcriptPath === "string" ? sessionState.transcriptPath.trim() : "";
    if (transcriptPath.length > 0 && fs.existsSync(transcriptPath)) {
      try {
        const stat = fs.statSync(transcriptPath);
        const transcriptMs = stat.mtimeMs;
        if (Number.isFinite(transcriptMs) && (!Number.isFinite(latest) || transcriptMs > latest)) {
          latest = transcriptMs;
        }
      } catch {
        // Best-effort only.
      }
    }
    return latest;
  };

  const getRecentAttemptEventActivityAt = (attemptId: string): number => {
    try {
      const events = orchestratorService.listRuntimeEvents({
        attemptId,
        eventTypes: ["progress", "heartbeat", "question"],
        limit: 20
      });
      for (const event of events) {
        if (event.eventType === "heartbeat") {
          const payload = isRecord(event.payload) ? event.payload : null;
          if (payload?.source === "health_sweep") continue;
        }
        const atMs = Date.parse(event.occurredAt);
        if (Number.isFinite(atMs)) return atMs;
      }
      return Number.NaN;
    } catch {
      return Number.NaN;
    }
  };

  const runHealthSweep = async (reason: string): Promise<{ sweeps: number; staleRecovered: number }> => {
    if (disposed) return { sweeps: 0, staleRecovered: 0 };
    pruneSessionRuntimeSignals();
    const runs = orchestratorService
      .listRuns({ limit: HEALTH_SWEEP_ACTIVE_RUN_SCAN_LIMIT })
      .filter((run) => run.status === "queued" || run.status === "running");
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
          const stagnationSnapshot = updateAttemptStagnationTracker(attempt.id, effectivePreview);

          upsertWorkerState(attempt.id, {
            runId: run.id,
            stepId: step.id,
            sessionId: attempt.executorSessionId,
            executorKind: attempt.executorKind,
            state: waitingForInput ? "waiting_input" : "working"
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

          if (sessionId.length > 0) {
            const eventActivityAtMs = getRecentAttemptEventActivityAt(attempt.id);
            const sessionActivityAtMs = getRecentSessionActivityAt(sessionState);
            const activityAtMs =
              Number.isFinite(eventActivityAtMs) && Number.isFinite(sessionActivityAtMs)
                ? Math.max(eventActivityAtMs, sessionActivityAtMs)
                : Number.isFinite(eventActivityAtMs)
                  ? eventActivityAtMs
                  : sessionActivityAtMs;
            const activeOutputWindowMs = Math.max(90_000, Math.min(15 * 60_000, Math.floor(timeoutMs * 0.5)));
            if (Number.isFinite(activityAtMs) && Date.now() - activityAtMs <= activeOutputWindowMs) {
              if (!shouldTreatAsStagnating(attempt.id, stagnationSnapshot.stagnantMs, timeoutMs)) {
                continue;
              }
            }
          }

          const elapsedMinutes = Math.max(1, Math.round(elapsedMs / 60_000));
          const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60_000));
          const stagnantMs = stagnationSnapshot.stagnantMs;
          const stagnating = shouldTreatAsStagnating(attempt.id, stagnantMs, timeoutMs);
          const errorMessage = stagnating
            ? `Attempt appears stagnant despite output (${Math.max(1, Math.round(stagnantMs / 60_000))}m repeated state). Marking as stuck.`
            : `Attempt exceeded timeout (${elapsedMinutes}m > ${timeoutMinutes}m). Marking as stuck.`;
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
                watchdogStagnantMs: stagnating ? stagnantMs : undefined,
                ownerId
              }
            });
            staleRecovered += 1;
            const refreshedGraph = orchestratorService.getRunGraph({ runId: run.id, timelineLimit: 0 });
            const refreshedStep = refreshedGraph.steps.find((entry) => entry.id === step.id);
            const retryQueued = isRetryQueuedForStep(refreshedStep);
            const retriesLeft = refreshedStep ? Math.max(0, refreshedStep.retryLimit - refreshedStep.retryCount) : 0;
            emitOrchestratorMessage(
              graph.run.missionId,
              retryQueued
                ? `Step "${stepTitleForMessage(step)}" looked stuck (${elapsedMinutes}m runtime). I marked it failed and scheduled a retry${retriesLeft > 0 ? ` (${retriesLeft} retries left).` : ""}.`
                : `Step "${stepTitleForMessage(step)}" looked stuck (${elapsedMinutes}m runtime). I marked it failed and no retries remain.`,
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

          if (hasCriteria && (runtimeProfile.evaluation.evaluateEveryStep || isFinalStep)) {
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

        adjustPlanFromResults({
          runId: attempt.runId,
          completedStepId: attempt.stepId,
          outcomeTags
        });
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

            if (aiIntegrationService) {
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
    const activeRun = byCreatedDesc.find((entry) => entry.status === "running" || entry.status === "queued" || entry.status === "paused");
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
    const activeRun = runs.find((entry) => entry.status === "running" || entry.status === "queued" || entry.status === "paused");
    if (activeRun) {
      try {
        const graph = orchestratorService.getRunGraph({ runId: activeRun.id, timelineLimit: 0 });
        const runningAttempt = graph.attempts
          .filter((attempt) => attempt.status === "running")
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
        if (runningAttempt?.executorKind === "claude" || runningAttempt?.executorKind === "codex") {
          return runningAttempt.executorKind;
        }
      } catch {
        // ignore
      }
    }

    const config = readConfig(projectConfigService);
    if (config.defaultPlannerProvider === "claude" || config.defaultPlannerProvider === "codex") {
      return config.defaultPlannerProvider;
    }
    const availability = aiIntegrationService?.getAvailability?.();
    if (availability?.claude) return "claude";
    if (availability?.codex) return "codex";
    return null;
  };

  const respondToChatWithAI = async (
    chatArgs: SendOrchestratorChatArgs,
    precomputedRecentChatContext?: string
  ): Promise<void> => {
    if (!aiIntegrationService || !projectRoot) return;
    const mission = missionService.get(chatArgs.missionId);
    if (!mission) return;
    const existingSession = activeChatSessions.get(chatArgs.missionId) ?? loadChatSessionStateFromMetadata(chatArgs.missionId);
    const provider = existingSession?.provider ?? resolveChatProvider(chatArgs.missionId);
    if (!provider) return;

    const steeringContext = getSteeringContext(chatArgs.missionId);
    const recentChatContext = precomputedRecentChatContext ?? buildRecentChatContext(chatArgs.missionId);
    const latestUserMessage = clipTextForContext(chatArgs.content, MAX_LATEST_CHAT_MESSAGE_CHARS);

    const prompt = [
      PM_SYSTEM_PREAMBLE,
      "Your current role: LIVE MISSION ORCHESTRATOR CHAT.",
      "This is a persistent mission thread. Use prior thread context instead of asking for repeated restatement.",
      "Communicate like a PM giving a standup — direct, specific, actionable.",
      "Lead with what matters most: blockers first, then progress, then what's next.",
      "Reference specific step names, worker outputs, and concrete metrics.",
      "If something failed, explain what happened and what you're doing about it.",
      "If you see an opportunity to optimize the remaining plan, mention it proactively.",
      "Be opinionated — if you think the user should know something, say it without being asked.",
      "If they give instructions, explain how and when those instructions apply.",
      "Do not claim completed work that has not happened.",
      "",
      `Mission: ${mission.title}`,
      `Mission prompt: ${mission.prompt.slice(0, 1_000)}`,
      `Run summary: ${summarizeRunForChat(chatArgs.missionId)}`,
      recentChatContext,
      steeringContext,
      `Latest user message: ${latestUserMessage}`,
      "",
      "Reply as the orchestrator in plain text (max 6 short sentences)."
    ].join("\n");

    const configChat = resolveOrchestratorModelConfig(chatArgs.missionId, "chat_response");
    const callArgs = {
      feature: "orchestrator" as const,
      taskType: "review" as const,
      prompt,
      cwd: projectRoot,
      provider,
      model: modelConfigToServiceModel(configChat),
      reasoningEffort: thinkingLevelToReasoningEffort(configChat.thinkingLevel),
      permissionMode: "read-only" as const,
      oneShot: true,
      timeoutMs: 30_000
    };

    let result: Awaited<ReturnType<NonNullable<typeof aiIntegrationService>["executeTask"]>>;
    try {
      result = await aiIntegrationService.executeTask({
        ...callArgs,
        ...(existingSession?.provider === provider ? { sessionId: existingSession.sessionId } : {})
      });
    } catch (error) {
      if (existingSession?.provider === provider) {
        logger.info("ai_orchestrator.chat_session_resume_failed", {
          missionId: chatArgs.missionId,
          provider,
          sessionId: existingSession.sessionId,
          error: error instanceof Error ? error.message : String(error),
          recovery: "start_fresh_session"
        });
        result = await aiIntegrationService.executeTask(callArgs);
      } else {
        throw error;
      }
    }

    if (typeof result.sessionId === "string" && result.sessionId.trim().length > 0) {
      persistChatSessionState(chatArgs.missionId, {
        provider,
        sessionId: result.sessionId.trim(),
        updatedAt: nowIso()
      });
    }

    const response = String(result.text ?? "").trim();
    if (response.length > 0) {
      emitOrchestratorMessage(chatArgs.missionId, response);
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
          `Planner online (${args.provider}:${session.model}).`,
          {
            planner: {
              event: "session_started",
              sessionId: session.id
            }
          }
        );

        const turn = beginPlannerTurn(plannerState);
        appendPlannerWorkerMessage(
          plannerState,
          "Planning request received. Building structured mission plan...",
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
        policy: args.policy
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
      return { approved: true, feedback: "Auto-approved (AI evaluation not available)" };
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
        ? resolveOrchestratorModelConfig(missionIdForAttempt, "worker_evaluation")
        : legacyToModelConfig("sonnet", evaluationReasoningEffort);

      const result = await aiIntegrationService.executeTask({
        feature: "orchestrator",
        taskType: "review",
        prompt,
        cwd: projectRoot,
        provider: configWorkerEval.provider === "codex" ? "codex" : "claude",
        model: modelConfigToServiceModel(configWorkerEval),
        reasoningEffort: thinkingLevelToReasoningEffort(configWorkerEval.thinkingLevel),
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
      return { approved: true, feedback: "Auto-approved (AI evaluation failed)" };
    }
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
    } catch (error) {
      logger.debug("ai_orchestrator.handoff_propagation_failed", {
        runId: args.runId,
        completedStepId: args.completedStepId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  // ---------------------------------------------------------------------------
  // Structured situation report: assembles a comprehensive, standardized context
  // for coordinator AI calls. Any model performs better with structured input.
  // ---------------------------------------------------------------------------

  const buildSituationReport = (args: {
    runId: string;
    trigger: string;
    triggerStepId?: string;
  }): string => {
    try {
      const graph = orchestratorService.getRunGraph({ runId: args.runId, timelineLimit: 0 });
      const missionId = graph.run.missionId;
      const mission = missionService.get(missionId);

      const succeeded = graph.steps.filter((s) => s.status === "succeeded");
      const failed = graph.steps.filter((s) => s.status === "failed");
      const running = graph.steps.filter((s) => s.status === "running");
      const blocked = graph.steps.filter((s) => s.status === "blocked");
      const pending = graph.steps.filter((s) => s.status === "pending" || s.status === "ready");
      const total = graph.steps.length;
      const pct = total > 0 ? Math.round((succeeded.length / total) * 100) : 0;

      const lines: string[] = [];
      lines.push("=== SITUATION REPORT ===");
      lines.push(`Mission: "${mission?.title ?? missionId}"`);
      lines.push(`Progress: ${succeeded.length}/${total} steps complete (${pct}%)`);
      lines.push(`Status: ${succeeded.length} succeeded, ${failed.length} failed, ${running.length} running, ${blocked.length} blocked, ${pending.length} pending`);
      lines.push(`Trigger: ${args.trigger}`);

      if (running.length > 0) {
        lines.push("");
        lines.push("Running now:");
        for (const s of running.slice(0, 5)) {
          const activeAttempt = graph.attempts
            .filter((a) => a.stepId === s.id && a.status === "running")
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
          const elapsed = activeAttempt ? `${Math.round((Date.now() - Date.parse(activeAttempt.createdAt)) / 1000)}s` : "?";
          lines.push(`  - ${s.stepKey}: "${s.title}" (${elapsed} elapsed)`);
        }
      }

      if (failed.length > 0) {
        lines.push("");
        lines.push("Failed steps:");
        for (const s of failed.slice(0, 5)) {
          const lastAttempt = graph.attempts
            .filter((a) => a.stepId === s.id)
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
          const errMsg = lastAttempt?.errorMessage?.slice(0, 150) ?? "unknown error";
          lines.push(`  - ${s.stepKey}: ${errMsg} (retries: ${s.retryCount}/${s.retryLimit})`);
        }
      }

      if (blocked.length > 0) {
        lines.push("");
        lines.push("Blocked steps:");
        for (const s of blocked.slice(0, 5)) {
          const blockMeta = isRecord(s.metadata) ? s.metadata : {};
          const blockReason = typeof blockMeta.blockedErrorMessage === "string" ? blockMeta.blockedErrorMessage.slice(0, 100) : "unknown";
          lines.push(`  - ${s.stepKey}: ${blockReason}`);
        }
      }

      // Recently completed — show last 3 for context
      const recentlyDone = succeeded
        .filter((s) => s.completedAt)
        .sort((a, b) => Date.parse(b.completedAt!) - Date.parse(a.completedAt!))
        .slice(0, 3);
      if (recentlyDone.length > 0) {
        lines.push("");
        lines.push("Recently completed:");
        for (const s of recentlyDone) {
          const lastAttempt = graph.attempts
            .filter((a) => a.stepId === s.id && a.status === "succeeded")
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
          const summary = lastAttempt?.resultEnvelope?.summary?.slice(0, 120) ?? "completed";
          lines.push(`  - ${s.stepKey}: ${summary}`);
        }
      }

      // Next up — what's ready to run
      const ready = graph.steps.filter((s) => s.status === "ready");
      if (ready.length > 0) {
        lines.push("");
        lines.push("Ready to start:");
        for (const s of ready.slice(0, 5)) {
          const deps = s.dependencyStepIds
            .map((depId) => graph.steps.find((d) => d.id === depId)?.stepKey ?? depId.slice(0, 8))
            .join(", ");
          lines.push(`  - ${s.stepKey}: "${s.title}"${deps ? ` (depends on: ${deps})` : ""}`);
        }
      }

      lines.push("=== END REPORT ===");
      return lines.join("\n");
    } catch (error) {
      return `[Situation report unavailable: ${error instanceof Error ? error.message : String(error)}]`;
    }
  };

  // Internal async helper for Tier 2 AI-driven plan adjustment
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
    const situationReport = buildSituationReport({
      runId: adjustArgs.runId,
      trigger: `step_completed:${targetStep?.stepKey ?? adjustArgs.completedStepId}`,
      triggerStepId: adjustArgs.completedStepId
    });

    // Last completed step's output for detailed analysis
    const lastAttempt = graph.attempts
      .filter((a) => a.stepId === adjustArgs.completedStepId && (a.status === "succeeded" || a.status === "failed"))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    const lastOutput = lastAttempt?.resultEnvelope?.summary?.slice(0, 1000) ?? "";
    const lastWarnings = lastAttempt?.resultEnvelope?.warnings?.slice(0, 5).join("; ") ?? "";

    const prompt = [
      PM_SYSTEM_PREAMBLE,
      "Your current role: PLAN ADJUSTER. Based on completed step results, proactively evaluate the remaining plan.",
      "",
      situationReport,
      "",
      `Last completed step output: ${lastOutput}`,
      lastWarnings ? `Warnings from last step: ${lastWarnings}` : "",
      "",
      steeringContext,
      "",
      "DECISION FRAMEWORK (choose the best action):",
      "1. no_change — plan is on track, no adjustment needed (most common)",
      "2. skip_step — a remaining step is now redundant based on what was just completed",
      "3. add_step — a gap was discovered that needs a new step to address",
      "",
      "Rules:",
      "- Only skip if you have specific evidence from the completed step that makes a downstream step unnecessary",
      "- Only add if the completed step revealed a concrete gap (not hypothetical)",
      "- Reference specific outputs, files, or errors in your reasoning",
      "Return a JSON object with your adjustments."
    ].filter(Boolean).join("\n");

    const adjustmentSchema = {
      type: "object",
      properties: {
        reasoning: { type: "string" },
        adjustments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["add_step", "skip_step", "no_change"] },
              targetStepKey: { type: "string" },
              reason: { type: "string" },
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
    const runtimeProfile = runRuntimeProfiles.get(adjustArgs.runId) ?? resolveActiveRuntimeProfile(missionId);
    const configPlanAdj = resolveOrchestratorModelConfig(missionId, "plan_adjustment");

    const result = await aiIntegrationService.executeTask({
      feature: "orchestrator",
      taskType: "planning",
      prompt,
      cwd: projectRoot,
      provider: configPlanAdj.provider === "codex" ? "codex" : "claude",
      model: modelConfigToServiceModel(configPlanAdj),
      reasoningEffort: thinkingLevelToReasoningEffort(configPlanAdj.thinkingLevel),
      jsonSchema: adjustmentSchema,
      permissionMode: "read-only",
      oneShot: true,
      timeoutMs: 30_000
    });

    const parsed = isRecord(result.structuredOutput) ? result.structuredOutput : null;
    if (!parsed || !Array.isArray(parsed.adjustments)) return;

    for (const adj of parsed.adjustments) {
      if (!isRecord(adj)) continue;
      const action = String(adj.action ?? "");
      const reason = String(adj.reason ?? "AI-suggested adjustment");

      if (action === "skip_step" && typeof adj.targetStepKey === "string") {
        const target = graph.steps.find((s) => s.stepKey === adj.targetStepKey);
        if (target && target.status !== "succeeded" && target.status !== "failed") {
          try {
            orchestratorService.skipStep({ runId: adjustArgs.runId, stepId: target.id, reason });
            logger.info("ai_orchestrator.ai_skip_step", { runId: adjustArgs.runId, stepKey: adj.targetStepKey, reason });
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
          logger.info("ai_orchestrator.ai_add_step", { runId: adjustArgs.runId, stepKey, reason });
        } catch (e) {
          logger.debug("ai_orchestrator.ai_add_step_failed", {
            runId: adjustArgs.runId,
            stepKey,
            error: e instanceof Error ? e.message : String(e)
          });
        }
      }
    }
  };

  const adjustPlanFromResults = (args: {
    runId: string;
    completedStepId: string;
    outcomeTags: string[];
  }): void => {
    // Tier 1 — Deterministic checks (always run, no AI call)
    try {
      const graph = orchestratorService.getRunGraph({ runId: args.runId, timelineLimit: 0 });
      const step = graph.steps.find((s) => s.id === args.completedStepId);
      if (!step) return;

      const attempt = graph.attempts
        .filter((a) => a.stepId === args.completedStepId)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];

      // Log policy failures for debugging
      if (step.status === "failed" && attempt?.errorClass === "policy") {
        logger.debug("ai_orchestrator.adjust_plan_policy_failure", {
          runId: args.runId,
          stepId: args.completedStepId,
          errorClass: attempt.errorClass
        });
      }

      // Track progress
      const completedCount = graph.steps.filter(
        (s) => s.status === "succeeded" || s.status === "failed" || s.status === "skipped"
      ).length;
      logger.debug("ai_orchestrator.plan_progress", {
        runId: args.runId,
        completedStepId: args.completedStepId,
        progress: `${completedCount}/${graph.steps.length}`,
        outcomeTags: args.outcomeTags
      });

      // Tier 2 — AI evaluation for complex scenarios
      const stepMeta = isRecord(step.metadata) ? step.metadata : {};
      const runtimeProfile = runRuntimeProfiles.get(args.runId) ?? resolveActiveRuntimeProfile(graph.run.missionId);
      const outputText = attempt?.resultEnvelope?.summary ?? "";
      const mentionsConcerns = /\b(warning|risk|concern|TODO|FIXME|hack|workaround|breaking)\b/i.test(outputText);

      const shouldTriggerAiAdjustment =
        runtimeProfile.evaluation.autoAdjustPlan &&
        aiIntegrationService &&
        projectRoot &&
        (
          (step.status === "failed" && step.retryCount >= step.retryLimit) ||
          stepMeta.stepType === "integration" ||
          (step.status === "succeeded" && args.outcomeTags.includes("has_warnings")) ||
          (step.status === "succeeded" && mentionsConcerns)
        );

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
        step.stepKey
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
    } catch (error) {
      logger.debug("ai_orchestrator.adjust_plan_from_results_failed", {
        runId: args.runId,
        completedStepId: args.completedStepId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
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
      const activeRun = runs.find((r) => r.status === "running" || r.status === "paused");
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
      const prompt = [
        PM_SYSTEM_PREAMBLE,
        "Your current role: INTERVENTION RESOLVER. An intervention has been raised during mission execution.",
        "Determine how to resolve this intervention. Think like a PM triaging an incident:",
        "- RETRY: If the failure looks transient (timeout, rate limit, flaky test), retry with added context about the failure so the worker avoids repeating it.",
        "- WORKAROUND: If the failure is real but a different approach could work, add a workaround step.",
        "- SKIP: If the step is non-critical and its failure doesn't affect core deliverables, skip it and note why.",
        "- ESCALATE: Only when the failure is ambiguous, affects core deliverables, or requires information you don't have. Escalation pauses the mission — use sparingly.",
        "Explain your reasoning clearly so the user can review the decision later.",
        "",
        `Mission: ${mission.title}`,
        `Mission prompt: ${mission.prompt.slice(0, 500)}`,
        "",
        `Intervention: ${interventionDesc}`,
        "",
        `Run context: ${runContext}`,
        steeringContext,
        "Available actions: retry (retry the failed step), skip (skip the step), add_workaround (add a workaround step), escalate (require user input).",
        `Only suggest auto-resolution if you are highly confident (>=${confidenceThreshold}).`,
        "Return a JSON object with your assessment."
      ].join("\n");

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

      const configIntervention = resolveOrchestratorModelConfig(args.missionId, "intervention_handling");
      const result = await aiIntegrationService.executeTask({
        feature: "orchestrator",
        taskType: "review",
        prompt,
        cwd: projectRoot,
        provider: configIntervention.provider === "codex" ? "codex" : "claude",
        model: modelConfigToServiceModel(configIntervention),
        reasoningEffort: thinkingLevelToReasoningEffort(configIntervention.thinkingLevel),
        jsonSchema: interventionSchema,
        permissionMode: "read-only",
        oneShot: true,
        timeoutMs: 30_000
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

  const resolveMissionPlannerRationale = (missionId: string): string | null => {
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
      const rationale = missionSummary?.parallelismRationale;
      return typeof rationale === "string" && rationale.length > 0 ? rationale : null;
    } catch {
      return null;
    }
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

  const syncMissionFromRun = async (runId: string, reason: string) => {
    if (!runId || syncLocks.has(runId)) return;
    syncLocks.add(runId);
    try {
      const graph = orchestratorService.getRunGraph({ runId, timelineLimit: 120 });
      const mission = missionService.get(graph.run.missionId);
      if (!mission) return;

      syncMissionStepsFromRun(graph);
      const refreshed = missionService.get(mission.id) ?? mission;
      const nextMissionStatus = deriveMissionStatusFromRun(graph, refreshed);
      if (nextMissionStatus === "completed") {
        transitionMissionStatus(mission.id, "completed", {
          outcomeSummary: refreshed.outcomeSummary ?? buildOutcomeSummary(graph),
          lastError: null
        });

        // ── PR Creation at Run End (strategy-driven) ──────────────────────────
        try {
          const runPolicy = resolveActivePolicy(mission.id);
          const integrationPrPolicy = runPolicy.integrationPr ?? DEFAULT_INTEGRATION_PR_POLICY;
          const teamManifest = runTeamManifests.get(runId);
          const graphLaneCount = new Set(graph.steps.map((s) => s.laneId).filter(Boolean)).size;
          const usedMultipleLanes = (teamManifest && teamManifest.parallelLanes.length > 1) || graphLaneCount > 1;
          const prStrategy = runPolicy.prStrategy ?? inferPrStrategy({
            laneCount: graphLaneCount,
            lanesAreCoupled: false
          });

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
              // ── Auto-resolve conflict pipeline ─────────────────────────────
              // When the direct integration PR creation fails (typically due to
              // merge conflicts), attempt an AI-assisted resolution flow using
              // the building blocks already in prService:
              //   1. simulate  ->  2. create lane  ->  3. resolve each conflict
              //   4. poll for completion  ->  5. verify  ->  6. commit PR
              // The entire pipeline is wrapped in a safety net — if auto-resolve
              // itself fails we fall back to the original "log + message" path.

              const autoResolveEnabled = integrationPrPolicy.autoResolveConflicts !== false;

              if (!autoResolveEnabled) {
                logger.info("ai_orchestrator.auto_resolve_disabled", { missionId: mission.id, runId });
                emitOrchestratorMessage(
                  mission.id,
                  `Integration PR creation failed due to merge conflicts. Auto-resolve is disabled — manual resolution is needed.\n` +
                  `Error: ${prError instanceof Error ? prError.message : String(prError)}`
                );
              } else {
                // Attempt the auto-resolve pipeline
                try {
                  emitOrchestratorMessage(
                    mission.id,
                    `Integration PR creation hit merge conflicts. Starting automatic conflict resolution...`
                  );
                  logger.info("ai_orchestrator.auto_resolve_starting", {
                    missionId: mission.id,
                    runId,
                    originalError: prError instanceof Error ? prError.message : String(prError)
                  });

                  // Step 1: Simulate integration to get a conflict map / proposal
                  const laneIdArray = [...new Set(graph.steps.map((s) => s.laneId).filter(Boolean))] as string[];
                  const baseBranch = prStrategy.targetBranch ?? mission.laneId ?? "main";
                  const isDraft = prStrategy.draft ?? integrationPrPolicy.draft ?? true;

                  emitOrchestratorMessage(mission.id, `Simulating integration for ${laneIdArray.length} lanes against ${baseBranch}...`);

                  const proposal = await prService.simulateIntegration({
                    sourceLaneIds: laneIdArray,
                    baseBranch
                  });

                  const conflictingSteps = proposal.steps.filter((s) => s.outcome === "conflict");
                  if (conflictingSteps.length === 0) {
                    // Simulation says no conflicts — the original error was likely transient
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
                    // There are real conflicts — proceed with AI resolution
                    emitOrchestratorMessage(
                      mission.id,
                      `Found ${conflictingSteps.length} lane(s) with conflicts: ${conflictingSteps.map((s) => s.laneName).join(", ")}. ` +
                      `Setting up integration lane...`
                    );

                    // Step 2: Create integration lane (merges clean steps, marks conflicts)
                    const laneResult = await prService.createIntegrationLaneForProposal({
                      proposalId: proposal.proposalId
                    });

                    logger.info("ai_orchestrator.auto_resolve_lane_created", {
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
                        `${laneResult.conflictingLanes.length} lane(s) need AI resolution.`
                      );
                    }

                    // Resolve model configuration for the integration phase
                    // (reuse `runPolicy` from outer scope — no need to re-resolve)
                    const integrationPhase = runPolicy.integration;
                    const resolveProvider = (integrationPhase?.model ?? "claude") as "claude" | "codex";
                    const resolveModel = resolveProvider === "codex" ? "codex" : "claude-sonnet-4-20250514";
                    const resolveReasoningEffort = integrationPhase?.reasoningEffort;

                    // Step 3 & 4: Resolve each conflicting lane sequentially
                    const RESOLUTION_TIMEOUT_MS = 300_000; // 5 minutes per lane
                    const POLL_INTERVAL_MS = 10_000;       // Check every 10 seconds
                    const resolutionResults: Array<{ laneId: string; success: boolean; error?: string }> = [];

                    for (const conflictLaneId of laneResult.conflictingLanes) {
                      const conflictStep = conflictingSteps.find((s) => s.laneId === conflictLaneId);
                      const laneName = conflictStep?.laneName ?? conflictLaneId;

                      emitOrchestratorMessage(
                        mission.id,
                        `Resolving conflicts for lane "${laneName}"...`
                      );

                      try {
                        // Start AI-assisted resolution with autoApprove
                        const resolutionStart = await prService.startIntegrationResolution({
                          proposalId: proposal.proposalId,
                          laneId: conflictLaneId,
                          provider: resolveProvider,
                          model: resolveModel,
                          reasoningEffort: resolveReasoningEffort,
                          autoApprove: true
                        });

                        // If chatSessionId is null-ish, the merge succeeded without conflicts
                        // (startIntegrationResolution returns null chatSessionId for clean merges)
                        if (!resolutionStart.chatSessionId) {
                          resolutionResults.push({ laneId: conflictLaneId, success: true });
                          emitOrchestratorMessage(
                            mission.id,
                            `Lane "${laneName}" merged cleanly (no AI resolution needed).`
                          );
                          continue;
                        }

                        // Step 4: Poll for resolution completion
                        const startTime = Date.now();
                        let resolved = false;

                        while (Date.now() - startTime < RESOLUTION_TIMEOUT_MS) {
                          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

                          const recheckResult = await prService.recheckIntegrationStep({
                            proposalId: proposal.proposalId,
                            laneId: conflictLaneId
                          });

                          if (recheckResult.resolution === "resolved") {
                            resolved = true;
                            break;
                          }

                          // If the resolution status is no longer "resolving" (e.g. "pending" or "failed"),
                          // the agent did not resolve it — break immediately.
                          if (recheckResult.resolution !== "resolving") {
                            break;
                          }

                          // Check if the chat session that was resolving has ended.
                          // If the agent crashed or completed without resolving all conflicts,
                          // recheckIntegrationStep may still return "resolving" (conflict markers remain).
                          // Without this check the loop would spin for the full 5-minute timeout.
                          if (agentChatService && resolutionStart.chatSessionId) {
                            const sessions = await agentChatService.listSessions(conflictLaneId);
                            const resolverSession = sessions.find(
                              (s) => s.sessionId === resolutionStart.chatSessionId
                            );
                            if (resolverSession && resolverSession.status === "ended") {
                              logger.warn("ai_orchestrator.auto_resolve_session_ended_early", {
                                missionId: mission.id,
                                laneId: conflictLaneId,
                                chatSessionId: resolutionStart.chatSessionId,
                                elapsedMs: Date.now() - startTime
                              });
                              break;
                            }
                          }
                        }

                        if (resolved) {
                          resolutionResults.push({ laneId: conflictLaneId, success: true });
                          emitOrchestratorMessage(
                            mission.id,
                            `Lane "${laneName}" conflicts resolved successfully.`
                          );
                          logger.info("ai_orchestrator.auto_resolve_lane_resolved", {
                            missionId: mission.id,
                            laneId: conflictLaneId,
                            durationMs: Date.now() - startTime
                          });
                        } else {
                          const elapsed = Math.round((Date.now() - startTime) / 1000);
                          resolutionResults.push({
                            laneId: conflictLaneId,
                            success: false,
                            error: `Resolution did not complete within ${elapsed}s`
                          });
                          emitOrchestratorMessage(
                            mission.id,
                            `Lane "${laneName}" auto-resolution did not complete (${elapsed}s elapsed). Manual intervention may be needed.`
                          );
                          logger.warn("ai_orchestrator.auto_resolve_lane_timeout", {
                            missionId: mission.id,
                            laneId: conflictLaneId,
                            elapsedMs: Date.now() - startTime
                          });
                        }
                      } catch (laneResolveError) {
                        resolutionResults.push({
                          laneId: conflictLaneId,
                          success: false,
                          error: laneResolveError instanceof Error ? laneResolveError.message : String(laneResolveError)
                        });
                        emitOrchestratorMessage(
                          mission.id,
                          `Lane "${laneName}" auto-resolution failed: ${laneResolveError instanceof Error ? laneResolveError.message : String(laneResolveError)}`
                        );
                        logger.warn("ai_orchestrator.auto_resolve_lane_failed", {
                          missionId: mission.id,
                          laneId: conflictLaneId,
                          error: laneResolveError instanceof Error ? laneResolveError.message : String(laneResolveError)
                        });
                      }
                    }

                    // Step 5: Verify — check if all lanes resolved
                    const allSucceeded = resolutionResults.every((r) => r.success);
                    const failedLanes = resolutionResults.filter((r) => !r.success);

                    if (!allSucceeded) {
                      const failedNames = failedLanes.map((r) => {
                        const step = conflictingSteps.find((s) => s.laneId === r.laneId);
                        return step?.laneName ?? r.laneId;
                      });
                      emitOrchestratorMessage(
                        mission.id,
                        `Auto-resolution partially failed. ${failedLanes.length} lane(s) still need manual resolution: ${failedNames.join(", ")}. ` +
                        `The integration lane has been created — you can continue resolution manually in the PRs tab.`
                      );
                      logger.warn("ai_orchestrator.auto_resolve_partial_failure", {
                        missionId: mission.id,
                        runId,
                        totalConflicting: laneResult.conflictingLanes.length,
                        resolved: resolutionResults.filter((r) => r.success).length,
                        failed: failedLanes.length
                      });
                    } else {
                      // Step 6: All resolved — create the integration PR
                      emitOrchestratorMessage(
                        mission.id,
                        `All conflicts resolved. Creating integration PR...`
                      );

                      const integrationLaneName = `integration/${mission.id.slice(0, 8)}`;
                      const commitResult = await prService.commitIntegration({
                        proposalId: proposal.proposalId,
                        integrationLaneName,
                        title: `[ADE] Integration: ${mission.title}`,
                        body: `Automated integration PR for mission "${mission.title}".\n\n` +
                              `Lanes: ${laneIdArray.join(", ")}\n` +
                              `Conflicts auto-resolved by AI for: ${laneResult.conflictingLanes.length} lane(s).`,
                        draft: isDraft
                      });

                      emitOrchestratorMessage(
                        mission.id,
                        `Integration PR #${commitResult.pr.githubPrNumber} created (after auto-resolving conflicts): ${commitResult.pr.githubUrl}`
                      );
                      logger.info("ai_orchestrator.integration_pr_created_after_resolve", {
                        missionId: mission.id,
                        runId,
                        prNumber: commitResult.pr.githubPrNumber,
                        url: commitResult.pr.githubUrl,
                        autoResolvedLanes: laneResult.conflictingLanes.length
                      });
                    }
                  }
                } catch (autoResolveError) {
                  // Safety net: if the auto-resolve pipeline itself fails, fall back
                  // to the original behavior of logging + messaging
                  logger.warn("ai_orchestrator.auto_resolve_pipeline_failed", {
                    missionId: mission.id,
                    runId,
                    originalError: prError instanceof Error ? prError.message : String(prError),
                    autoResolveError: autoResolveError instanceof Error ? autoResolveError.message : String(autoResolveError)
                  });
                  emitOrchestratorMessage(
                    mission.id,
                    `Integration PR creation failed and auto-resolve also failed.\n` +
                    `Original error: ${prError instanceof Error ? prError.message : String(prError)}\n` +
                    `Auto-resolve error: ${autoResolveError instanceof Error ? autoResolveError.message : String(autoResolveError)}`
                  );
                }
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
        runRuntimeProfiles.delete(runId);
        runTeamManifests.delete(runId);
        runRecoveryLoopStates.delete(runId);
        activeHealthSweepRuns.delete(runId);
        for (const [attemptId, state] of workerStates.entries()) {
          if (state.runId !== runId) continue;
          workerStates.delete(attemptId);
          attemptRuntimeTrackers.delete(attemptId);
          deletePersistedAttemptRuntimeState(attemptId);
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

    return keyed.map((entry, position) => {
      const metadata = entry.metadata;
      const explicitDeps = Array.isArray(metadata.dependencyStepKeys)
        ? metadata.dependencyStepKeys
            .map((value) => String(value ?? "").trim())
            .filter(Boolean)
        : [];
      const indexedDeps = parseNumericDependencyIndices(metadata).flatMap((depIdx) => stepKeysByIndex.get(depIdx) ?? []);
      const hasExplicitDeps = Array.isArray(metadata.dependencyStepKeys) || Array.isArray(metadata.dependencyIndices);
      const depSet = new Set([...explicitDeps, ...indexedDeps].filter((dep) => dep !== entry.stepKey));
      if (!depSet.size && !hasExplicitDeps && position > 0) {
        depSet.add(keyed[position - 1]!.stepKey);
      }
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

    const rootCandidates = descriptors
      .filter((step) => step.dependencyStepKeys.length === 0 && isParallelCandidateStepType(step.stepType))
      .sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
    if (rootCandidates.length < 2) return { createdLaneIds: [], assignedSteps: 0 };

    const laneByStepKey = new Map<string, string>();
    const createdLaneIds: string[] = [];
    laneByStepKey.set(rootCandidates[0]!.stepKey, rootCandidates[0]!.laneId ?? baseLaneId);

    for (let i = 1; i < rootCandidates.length; i += 1) {
      const root = rootCandidates[i]!;
      if (root.laneId && root.laneId !== baseLaneId) {
        laneByStepKey.set(root.stepKey, root.laneId);
        continue;
      }
      let laneId = baseLaneId;
      const requestedName = `m-${args.missionId.slice(0, 6)}-${slugify(root.title || root.stepKey)}-${i + 1}`;
      try {
        const child = await laneService.createChild({
          parentLaneId: baseLaneId,
          name: requestedName,
          description: `Auto-created by orchestrator for mission ${args.missionId} (${root.title || root.stepKey}).`,
          folder: `Mission: ${mission.title}`
        });
        laneId = child.id;
        createdLaneIds.push(child.id);
      } catch (error) {
        logger.warn("ai_orchestrator.parallel_lane_create_failed", {
          missionId: args.missionId,
          stepKey: root.stepKey,
          requestedName,
          fallbackLaneId: baseLaneId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      laneByStepKey.set(root.stepKey, laneId);
    }

    const laneByStepId = new Map<string, string>();
    const byStepKey = new Map(descriptors.map((step) => [step.stepKey, step] as const));
    const ordered = [...descriptors].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));

    for (const step of ordered) {
      const explicitNonBaseLane = step.laneId && step.laneId !== baseLaneId ? step.laneId : null;
      if (explicitNonBaseLane) {
        laneByStepId.set(step.id, explicitNonBaseLane);
        laneByStepKey.set(step.stepKey, explicitNonBaseLane);
        continue;
      }
      let laneId = step.laneId ?? baseLaneId;
      if (step.dependencyStepKeys.length > 1 || step.stepType === "integration" || step.stepType === "merge") {
        laneId = baseLaneId;
      } else if (step.dependencyStepKeys.length === 1) {
        const depKey = step.dependencyStepKeys[0]!;
        laneId = laneByStepKey.get(depKey) ?? byStepKey.get(depKey)?.laneId ?? baseLaneId;
      } else {
        laneId = laneByStepKey.get(step.stepKey) ?? laneId;
      }
      laneByStepId.set(step.id, laneId);
      laneByStepKey.set(step.stepKey, laneId);
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
      recordLaneDecision({
        missionId: args.missionId,
        stepId: step.id,
        stepKey: step.stepKey,
        laneId: nextLaneId,
        decisionType: "validated",
        validatorOutcome: "pass",
        ruleHits: ["parallel_lane_provisioning", step.dependencyStepKeys.length > 0 ? "dependency_inheritance" : "root_split"],
        rationale: `Assigned step ${step.stepKey} to lane ${nextLaneId} (from ${currentLaneId}).`,
        metadata: {
          previousLaneId: currentLaneId,
          dependencyStepKeys: step.dependencyStepKeys
        }
      });
    }

    if (createdLaneIds.length > 0 || assignedSteps > 0) {
      updateMissionMetadata(args.missionId, (metadata) => {
        metadata.parallelLanes = {
          enabled: true,
          createdLaneIds,
          assignedSteps,
          rootStepCount: rootCandidates.length,
          baseLaneId,
          updatedAt: nowIso()
        };
      });
      emitOrchestratorMessage(
        args.missionId,
        `Parallel lane provisioning complete. ${createdLaneIds.length} new lane${createdLaneIds.length === 1 ? "" : "s"} created; ${assignedSteps} step lane assignments updated.`
      );
    }

    return { createdLaneIds, assignedSteps };
  };

  // ── Team Synthesis Helpers ──────────────────────────────────
  const DOMAIN_FRONTEND_KEYWORDS = /\b(react|vue|angular|css|html|jsx|tsx|component|ui|ux|tailwind|frontend|front[\s-]?end|layout|style|dom|browser)\b/i;
  const DOMAIN_BACKEND_KEYWORDS = /\b(api|server|database|sql|graphql|rest|endpoint|backend|back[\s-]?end|migration|schema|queue|kafka|redis|postgres|mongo)\b/i;
  const DOMAIN_INFRA_KEYWORDS = /\b(docker|k8s|kubernetes|terraform|ci[\s/]?cd|deploy|infra|helm|aws|gcp|azure|pipeline|nginx|load[\s-]?balanc)\b/i;
  const THOROUGHNESS_KEYWORDS = /\b(in[\s-]?depth|end[\s-]?to[\s-]?end|comprehensive|thorough|exhaustive|complete coverage|full[\s-]?audit|deep[\s-]?dive)\b/i;
  const HIGH_PARALLELISM_KEYWORDS = /\b(highest|maximum|max[\s-]?parallel|all[\s-]?out|full[\s-]?speed)\b/i;

  const inferDomain = (prompt: string): TeamComplexityAssessment["domain"] => {
    const fe = DOMAIN_FRONTEND_KEYWORDS.test(prompt);
    const be = DOMAIN_BACKEND_KEYWORDS.test(prompt);
    const infra = DOMAIN_INFRA_KEYWORDS.test(prompt);
    if (infra && !fe && !be) return "infra";
    if (fe && be) return "fullstack";
    if (fe && !be) return "frontend";
    if (be && !fe) return "backend";
    if (fe || be || infra) return "mixed";
    return "fullstack";
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
    runtimeProfile: MissionRuntimeProfile;
    userPrompt: string;
  }): TeamManifest => {
    const { missionId, mission, policy, runtimeProfile, userPrompt } = opts;
    const steps = mission.steps;
    const descriptors = buildParallelDescriptors(steps);
    const decisionLog: TeamDecisionEntry[] = [];
    const now = nowIso();

    // ── Complexity assessment ──────────────────────────────────
    const domain = inferDomain(userPrompt);
    const thoroughnessRequested = THOROUGHNESS_KEYWORDS.test(userPrompt);
    const laneIds = new Set(descriptors.map((d) => d.laneId).filter(Boolean));
    const laneCount = Math.max(1, laneIds.size);
    const stepCount = steps.length;

    let estimatedScope: TeamComplexityAssessment["estimatedScope"];
    if (stepCount <= 3 && laneCount <= 1) estimatedScope = "small";
    else if (stepCount <= 8 && laneCount <= 2) estimatedScope = "medium";
    else if (stepCount <= 20 && laneCount <= 4) estimatedScope = "large";
    else estimatedScope = "very_large";

    // Upgrade scope if thoroughness explicitly requested
    if (thoroughnessRequested && estimatedScope === "small") estimatedScope = "medium";
    if (thoroughnessRequested && estimatedScope === "medium") estimatedScope = "large";

    const rootCandidates = descriptors.filter((d) => d.dependencyStepKeys.length === 0);
    const parallelizable = rootCandidates.length >= 2;
    const requiresIntegration = policy.integration.mode === "auto" || laneCount > 1;
    const fileZoneCount = laneCount;

    const complexity: TeamComplexityAssessment = {
      domain,
      estimatedScope,
      parallelizable,
      requiresIntegration,
      fileZoneCount,
      thoroughnessRequested
    };

    decisionLog.push({
      timestamp: now,
      decision: `Complexity assessed as ${estimatedScope} (${domain})`,
      reason: `${stepCount} steps, ${laneCount} lanes, parallelizable=${parallelizable}, thoroughness=${thoroughnessRequested}`,
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

    // ── Compute DAG max width ─────────────────────────────────
    const stepDepthMap = new Map<string, number>();
    const depsByKey = new Map<string, string[]>();
    for (const d of descriptors) {
      depsByKey.set(d.stepKey, d.dependencyStepKeys);
    }
    const computeDepth = (key: string, visited: Set<string>): number => {
      if (stepDepthMap.has(key)) return stepDepthMap.get(key)!;
      if (visited.has(key)) return 0; // cycle guard
      visited.add(key);
      const deps = depsByKey.get(key) ?? [];
      const depth = deps.length === 0 ? 0 : Math.max(...deps.map((d) => computeDepth(d, visited))) + 1;
      stepDepthMap.set(key, depth);
      return depth;
    };
    for (const d of descriptors) {
      computeDepth(d.stepKey, new Set());
    }
    const depthCounts = new Map<number, number>();
    for (const depth of stepDepthMap.values()) {
      depthCounts.set(depth, (depthCounts.get(depth) ?? 0) + 1);
    }
    const dagMaxWidth = depthCounts.size > 0 ? Math.max(...depthCounts.values()) : 1;

    decisionLog.push({
      timestamp: now,
      decision: `DAG max width = ${dagMaxWidth}`,
      reason: `${stepDepthMap.size} steps across ${depthCounts.size} depth levels`,
      source: "dag_shape"
    });

    // ── Dynamic parallelism cap ─────────────────────────────────
    // Priority: (1) AI planner cap, (2) DAG max width, (3) prompt overrides, (4) safety ceiling
    let parallelismCap: number;

    const plannerCapResolved = resolveMissionParallelismCap(missionId);
    const plannerRationale = resolveMissionPlannerRationale(missionId);

    if (plannerCapResolved !== null && plannerCapResolved >= 1 && plannerCapResolved <= 32) {
      parallelismCap = plannerCapResolved;
      decisionLog.push({
        timestamp: now,
        decision: `Parallelism cap set to ${parallelismCap} from AI planner`,
        reason: plannerRationale
          ? plannerRationale.slice(0, 200)
          : `AI planner recommended ${plannerCapResolved} parallel workstreams`,
        source: "override"
      });
    } else {
      parallelismCap = dagMaxWidth;
      decisionLog.push({
        timestamp: now,
        decision: `Parallelism cap set to ${parallelismCap} from DAG max width`,
        reason: `No valid AI planner cap; using structural DAG width as fallback`,
        source: "dag_shape"
      });
    }

    if (HIGH_PARALLELISM_KEYWORDS.test(userPrompt)) {
      parallelismCap = Math.max(parallelismCap, 16);
      decisionLog.push({
        timestamp: now,
        decision: `Parallelism override to ${parallelismCap}`,
        reason: "User prompt contains high-parallelism keywords",
        source: "prompt"
      });
    }

    // Also check if user specified a specific number
    const explicitParallelMatch = userPrompt.match(/(\d+)\s*(?:parallel|workers|lanes)/i);
    if (explicitParallelMatch) {
      const requested = Math.max(1, Math.min(32, parseInt(explicitParallelMatch[1]!, 10)));
      if (Number.isFinite(requested)) {
        parallelismCap = requested;
        decisionLog.push({
          timestamp: now,
          decision: `Parallelism set to ${parallelismCap} from explicit user request`,
          reason: `User specified "${explicitParallelMatch[0]}" in prompt`,
          source: "override"
        });
      }
    }

    // Safety ceiling
    parallelismCap = Math.min(parallelismCap, 32);

    decisionLog.push({
      timestamp: now,
      decision: `Parallelism cap set to ${parallelismCap}`,
      reason: `DAG max width ${dagMaxWidth}, scope ${estimatedScope}, lane count ${laneCount}`,
      source: "policy"
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
      (thoroughnessRequested ? "Thoroughness requested — scope upgraded. " : "") +
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

  const startMissionRun = async (args: MissionRunStartArgs): Promise<MissionRunStartResult> => {
    const missionId = String(args.missionId ?? "").trim();
    if (!missionId.length) throw new Error("missionId is required.");
    const initialMission = missionService.get(missionId);
    if (!initialMission) throw new Error(`Mission not found: ${missionId}`);

    const policy = resolveActivePolicy(missionId);
    const runtimeProfile = resolveActiveRuntimeProfile(missionId);
    const config = readConfig(projectConfigService);

    // If an AI planner provider is specified, invoke AI planning first.
    // Policy controls whether AI planning runs.
    const provider: "claude" | "codex" | null = (() => {
      if (args.plannerProvider === "claude" || args.plannerProvider === "codex") return args.plannerProvider;
      if (args.plannerProvider === "deterministic") return null;
      if (runtimeProfile.planning.preferProvider) return runtimeProfile.planning.preferProvider;
      if (config.defaultPlannerProvider) return config.defaultPlannerProvider;
      const availability = aiIntegrationService?.getAvailability?.();
      if (availability?.claude) return "claude";
      if (availability?.codex) return "codex";
      return null;
    })();
    const plannerModel = (() => {
      if (provider !== "claude") return undefined;
      return resolveMissionLaunchPlannerModel(missionId) ?? undefined;
    })();
    const attemptedAiPlanner = runtimeProfile.planning.useAiPlanner && (provider === "claude" || provider === "codex");
    if (attemptedAiPlanner) {
      transitionMissionStatus(missionId, "planning");

      // ── Planning with smart retry (max 2 attempts) ────────────────
      const resolveFallbackModel = (
        originalModel: string | undefined,
        reasonCode: string | null
      ): string | undefined => {
        if (provider !== "claude") return undefined;
        // For timeouts, prefer a faster/cheaper model
        if (reasonCode === "planner_timeout") {
          if (originalModel === "opus") return "sonnet";
          if (originalModel === "sonnet") return "haiku";
          return "sonnet"; // haiku/undefined -> sonnet (unlikely to be slower)
        }
        // For parse errors, try a different model entirely (garbled output)
        if (reasonCode === "planner_parse_error") {
          if (originalModel === "opus") return "sonnet";
          if (originalModel === "sonnet") return "opus";
          return "sonnet";
        }
        // For validation errors, retry same model (almost succeeded)
        if (reasonCode === "planner_validation_error" || reasonCode === "planner_schema_error") {
          return originalModel;
        }
        // For execution errors, try a different model
        if (originalModel === "opus") return "sonnet";
        if (originalModel === "sonnet") return "opus";
        return "sonnet";
      };

      const shouldRetry = (error: unknown): boolean => {
        if (error instanceof MissionPlanningError) {
          // planner_unavailable means no AI service at all — retrying won't help
          return error.reasonCode !== "planner_unavailable";
        }
        // Unknown errors: allow one retry
        return true;
      };

      let planningSucceeded = false;
      let lastPlanError: unknown = null;

      try {
        await planWithAI({ missionId, provider, model: plannerModel, policy });
        planningSucceeded = true;
      } catch (attempt1Error) {
        lastPlanError = attempt1Error;
        const errorMessage = attempt1Error instanceof Error ? attempt1Error.message : String(attempt1Error);
        const reasonCode = attempt1Error instanceof MissionPlanningError ? attempt1Error.reasonCode : null;

        if (shouldRetry(attempt1Error)) {
          const fallbackModel = resolveFallbackModel(plannerModel, reasonCode);
          const fallbackLabel = fallbackModel ?? "default";
          emitOrchestratorMessage(
            missionId,
            `Planning attempt 1 failed: ${errorMessage}. Retrying with ${fallbackLabel}...`
          );
          logger.warn("ai_orchestrator.planning_retry", {
            missionId,
            attempt: 1,
            reasonCode,
            originalModel: plannerModel ?? "default",
            fallbackModel: fallbackLabel
          });

          try {
            await planWithAI({ missionId, provider, model: fallbackModel, policy });
            planningSucceeded = true;
          } catch (attempt2Error) {
            lastPlanError = attempt2Error;
          }
        }
      }

      if (!planningSucceeded) {
        const errorMessage = lastPlanError instanceof Error ? lastPlanError.message : String(lastPlanError);
        transitionMissionStatus(missionId, "planning");
        transitionMissionStatus(missionId, "failed", { lastError: errorMessage });
        emitOrchestratorMessage(missionId, `Mission planning failed: ${errorMessage}`);
        return {
          blockedByPlanReview: false,
          started: null,
          mission: missionService.get(missionId)
        };
      }
    } else if (!runtimeProfile.planning.useAiPlanner && (provider === "claude" || provider === "codex")) {
      logger.info("ai_orchestrator.ai_planning_skipped_by_policy", {
        missionId,
        reason: "planning mode is off"
      });
    }

    const bypassPlanReview = args.forcePlanReviewBypass === true;
    const requireReview = config.requirePlanReview || runtimeProfile.planning.requirePlanReview;
    const mission = missionService.get(missionId) ?? initialMission;
    if (requireReview && !bypassPlanReview) {
      if (mission.status !== "plan_review") {
        transitionMissionStatus(missionId, "planning");
        transitionMissionStatus(missionId, "plan_review");
      }
      ensurePlanReviewIntervention(missionId);
      return {
        blockedByPlanReview: true,
        started: null,
        mission: missionService.get(missionId)
      };
    }

    await provisionParallelMissionLanes({
      missionId,
      runMode: args.runMode
    });

    // ── Team Synthesis Pass ──────────────────────────────────────
    const refreshedMissionForTeam = missionService.get(missionId) ?? mission;
    const teamManifest = synthesizeTeamManifest({
      missionId,
      mission: refreshedMissionForTeam,
      policy,
      runtimeProfile,
      userPrompt: refreshedMissionForTeam.prompt
    });

    // ── PRD / Architecture Doc Injection ────────────────────────
    const projectDocsContext = discoverProjectDocs();

    transitionMissionStatus(missionId, "planning");
    const plannerParallelismCap = resolveMissionParallelismCap(missionId);
    // Dynamic parallelism: prefer team manifest cap over planner/default
    const parallelismCap = teamManifest.parallelismCap
      ?? plannerParallelismCap
      ?? runtimeProfile.execution.maxParallelWorkers;
    const started = orchestratorService.startRunFromMission({
      missionId,
      runMode: args.runMode,
      autopilotOwnerId: args.autopilotOwnerId,
      defaultExecutorKind: args.defaultExecutorKind,
      defaultRetryLimit: args.defaultRetryLimit ?? runtimeProfile.execution.defaultRetryLimit,
      metadata: {
        ...(args.metadata ?? {}),
        plannerParallelismCap: parallelismCap,
        executionPolicy: policy,
        ...(runtimeProfile.provenance.legacyDepthTier ? { depthTier: runtimeProfile.provenance.legacyDepthTier } : {}),
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
      }
    });

    // Cache runtime profile, team manifest, and policy for this run
    runRuntimeProfiles.set(started.run.id, runtimeProfile);
    // Store team manifest keyed by run ID
    teamManifest.runId = started.run.id;
    runTeamManifests.set(started.run.id, teamManifest);
    logger.info("ai_orchestrator.team_synthesis_complete", {
      missionId,
      runId: started.run.id,
      workerCount: teamManifest.workers.length,
      parallelismCap: teamManifest.parallelismCap,
      complexity: teamManifest.complexity.estimatedScope,
      domain: teamManifest.complexity.domain,
      decisions: teamManifest.decisionLog.length
    });

    const plannerSummary = attemptedAiPlanner
      ? `Using AI planner (${provider ?? "auto"}).`
      : "Using deterministic planner.";

    emitOrchestratorMessage(
      missionId,
      `Starting mission with ${started.steps.length} steps. Execution profile: ${runtimeProfile.provenance.source}. ${plannerSummary}`
    );

    // ── Start Persistent Coordinator Session ─────────────────────
    // Fire-and-forget: the coordinator session initializes in the background
    // so it doesn't block mission startup. Events will queue until init completes.
    const coordinatorModelConfig = resolveOrchestratorModelConfig(missionId, "coordinator");
    void startCoordinatorSession(missionId, started.run.id, {
      steps: started.steps.map((s) => ({
        stepKey: s.stepKey,
        title: s.title,
        status: s.status,
        dependencyStepIds: s.dependencyStepIds
      }))
    }, coordinatorModelConfig).catch((error) => {
      logger.debug("ai_orchestrator.coordinator_session_launch_failed", {
        missionId,
        runId: started.run.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });

    transitionMissionStatus(missionId, "in_progress");
    void syncMissionFromRun(started.run.id, "mission_run_started");

    setTimeout(() => {
      void orchestratorService.startReadyAutopilotAttempts({
        runId: started.run.id,
        reason: "initial_ramp_up",
      }).catch(() => {});
    }, 500);

    return {
      blockedByPlanReview: false,
      started,
      mission: missionService.get(missionId)
    };
  };

  const approveMissionPlan = async (args: MissionRunStartArgs): Promise<MissionRunStartResult> => {
    const missionId = String(args.missionId ?? "").trim();
    if (!missionId.length) throw new Error("missionId is required.");
    const mission = missionService.get(missionId);
    if (!mission) throw new Error(`Mission not found: ${missionId}`);
    const runs = orchestratorService.listRuns({ missionId });
    const activeRun = runs.find((entry) => entry.status === "running" || entry.status === "paused" || entry.status === "queued") ?? null;

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
          (r) => r.status === "running" || r.status === "queued" || r.status === "paused"
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

    return {
      acknowledged: true,
      appliedAt: nowIso(),
      response: `Directive accepted (${directive.priority}). Applied to ${projectedStepCount} active step${projectedStepCount === 1 ? "" : "s"} and will guide upcoming worker runs.`
    };
  };

  const getDepthConfig = (depthArgs: GetMissionDepthConfigArgs): MissionDepthConfig => {
    return resolveMissionDepthConfig(depthArgs.tier);
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
      emitOrchestratorMessage(
        message.missionId,
        `Worker message queued for ${workerLabel}; delivery will resume once the worker session is available.`,
        target?.stepKey ?? null
      );
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
    if (thread.threadType === "mission") {
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
      target: target ?? (thread.threadType === "mission" ? { kind: "coordinator", runId: thread.runId ?? null } : null),
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
      const message = String(event.message ?? "Planner session reported an error.").trim();
      appendPlannerWorkerMessage(state, message, {
        planner: {
          event: "error",
          sessionId: state.sessionId
        }
      });
      completePlannerTurn(state, "failed", message);
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

  // ── Quality Gate Evaluation ──────────────────────────────────
  const evaluateQualityGateViaAI = async (gateEvalArgs: {
    stepOutput: string;
    stepTitle: string;
    stepType: string;
    missionTitle: string;
    missionObjective: string;
    missionId: string;
  }): Promise<{ passed: boolean; reason: string }> => {
    if (!aiIntegrationService) {
      return { passed: true, reason: "No AI integration service available — defaulting to pass" };
    }
    try {
      const prompt = `You are a quality gate evaluator. Evaluate whether this step's output meets the mission's quality bar.
A 'pass' means the output is good enough to build on. Minor imperfections are acceptable if the core deliverable is solid.
A 'fail' means critical gaps that would cause downstream steps to fail or produce incorrect results.
In your reason, be specific — cite the exact issue or the exact thing done well.

Step: "${gateEvalArgs.stepTitle}" (type: ${gateEvalArgs.stepType})
Mission: "${gateEvalArgs.missionTitle}"
Objective: "${gateEvalArgs.missionObjective}"

Step Output:
${gateEvalArgs.stepOutput.slice(0, QUALITY_GATE_MAX_OUTPUT_CHARS)}

Respond with JSON only: { "verdict": "pass" | "fail", "reason": "specific explanation with citations" }`;

      const configQualityGate = resolveOrchestratorModelConfig(gateEvalArgs.missionId, "quality_gate");
      const result = await aiIntegrationService.executeTask({
        feature: "orchestrator" as const,
        taskType: "review" as const,
        prompt,
        cwd: projectRoot ?? "",
        provider: configQualityGate.provider === "codex" ? "codex" : "claude",
        model: modelConfigToServiceModel(configQualityGate),
        reasoningEffort: thinkingLevelToReasoningEffort(configQualityGate.thinkingLevel),
        oneShot: true,
        timeoutMs: 30_000
      });

      try {
        const parsed = JSON.parse(String(result.text ?? ""));
        return {
          passed: parsed.verdict === "pass",
          reason: typeof parsed.reason === "string" ? parsed.reason : "No reason provided"
        };
      } catch {
        // If AI returns non-JSON, treat as pass (conservative)
        return { passed: true, reason: "Could not parse quality gate response — defaulting to pass" };
      }
    } catch (error) {
      logger.debug("ai_orchestrator.quality_gate_ai_eval_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      return { passed: true, reason: "Quality gate evaluation failed — defaulting to pass" };
    }
  };

  const evaluateQualityGateForStep = async (runId: string, stepId: string): Promise<void> => {
    try {
      const graph = orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
      const step = graph.steps.find((s) => s.id === stepId);
      if (!step) return;

      const stepMeta = isRecord(step.metadata) ? step.metadata : {};
      const stepType = typeof stepMeta.stepType === "string" ? stepMeta.stepType.toLowerCase() : "";
      const taskType = typeof stepMeta.taskType === "string" ? stepMeta.taskType.toLowerCase() : "";

      // Check if this is a gate-phase step
      if (!GATE_PHASE_STEP_TYPES.has(stepType) && !GATE_PHASE_STEP_TYPES.has(taskType)) return;

      const phase = stepType || taskType;

      // Get the latest attempt result
      const attempts = graph.attempts.filter((a) => a.stepId === stepId);
      const latestAttempt = attempts.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!latestAttempt) return;

      // Get step output from attempt result envelope (top-level field) or metadata fallback
      const attemptMeta = isRecord(latestAttempt.metadata) ? latestAttempt.metadata : {};
      const envelope = latestAttempt.resultEnvelope;
      const output = envelope?.summary
        ? envelope.summary
        : typeof attemptMeta.output === "string" ? attemptMeta.output : "";

      if (!output.trim()) return;

      // Get mission context
      const mission = missionService.get(graph.run.missionId);
      const missionTitle = mission?.title ?? "Unknown";
      const missionMeta = getMissionMetadata(graph.run.missionId);
      const plannerPlan = isRecord(missionMeta.plannerPlan) ? missionMeta.plannerPlan as Record<string, unknown> : {};
      const missionSummary = isRecord(plannerPlan.missionSummary) ? plannerPlan.missionSummary as Record<string, unknown> : {};
      const missionObjective = typeof missionSummary.objective === "string" ? missionSummary.objective : mission?.prompt ?? "";

      const evaluation = await evaluateQualityGateViaAI({
        stepOutput: output,
        stepTitle: step.title ?? step.id,
        stepType: phase,
        missionTitle,
        missionObjective,
        missionId: graph.run.missionId
      });

      if (!evaluation.passed) {
        logger.info("ai_orchestrator.quality_gate_failed", {
          runId,
          stepId,
          phase,
          reason: evaluation.reason
        });
        handleQualityGateFailure({ runId, stepId, phase, reason: evaluation.reason });
      } else {
        logger.debug("ai_orchestrator.quality_gate_passed", { runId, stepId, phase });
      }
    } catch (error) {
      logger.debug("ai_orchestrator.quality_gate_eval_error", {
        runId,
        stepId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  // ── Recovery Loop Coordination ────────────────────────────────
  const handleQualityGateFailure = (gateArgs: {
    runId: string;
    stepId: string;
    phase: string;
    reason: string;
  }): { triggered: boolean; exhausted: boolean; iteration: number } => {
    const { runId, stepId, phase, reason: failureReason } = gateArgs;

    try {
      const graph = orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
      const missionId = graph.run.missionId;
      const runMeta = isRecord(graph.run.metadata) ? graph.run.metadata : {};
      const policy = isRecord(runMeta.executionPolicy) ? (runMeta.executionPolicy as MissionExecutionPolicy) : resolveActivePolicy(missionId);
      const recoveryPolicy: RecoveryLoopPolicy = policy.recoveryLoop ?? DEFAULT_RECOVERY_LOOP_POLICY;

      if (!recoveryPolicy.enabled) {
        logger.debug("ai_orchestrator.recovery_loop_disabled", { runId, stepId, phase });
        return { triggered: false, exhausted: false, iteration: 0 };
      }

      // Get or initialize recovery loop state
      let state = runRecoveryLoopStates.get(runId);
      if (!state) {
        state = {
          runId,
          iterations: [],
          currentIteration: 0,
          exhausted: false,
          stopReason: null
        };
        runRecoveryLoopStates.set(runId, state);
      }

      if (state.exhausted) {
        logger.info("ai_orchestrator.recovery_loop_already_exhausted", { runId, stepId, phase });
        return { triggered: false, exhausted: true, iteration: state.currentIteration };
      }

      // Check if max iterations reached
      if (state.currentIteration >= recoveryPolicy.maxIterations) {
        state.exhausted = true;
        state.stopReason = `Max iterations (${recoveryPolicy.maxIterations}) reached`;

        if (recoveryPolicy.onExhaustion === "intervention") {
          try {
            missionService.addIntervention({
              missionId,
              interventionType: "failed_step",
              title: `Recovery loop exhausted for ${phase} gate`,
              body: `Quality gate "${phase}" on step ${stepId} failed after ${recoveryPolicy.maxIterations} recovery iterations. Last failure: ${failureReason}`,
              requestedAction: "Manual review required — recovery loop exhausted."
            });
          } catch {
            // ignore intervention creation failure
          }
        }

        emitOrchestratorMessage(
          missionId,
          `Recovery loop exhausted after ${recoveryPolicy.maxIterations} iterations for ${phase} gate on step ${stepId}. Action: ${recoveryPolicy.onExhaustion}.`
        );

        logger.info("ai_orchestrator.recovery_loop_exhausted", {
          runId,
          stepId,
          phase,
          maxIterations: recoveryPolicy.maxIterations,
          onExhaustion: recoveryPolicy.onExhaustion
        });

        return { triggered: false, exhausted: true, iteration: state.currentIteration };
      }

      // Start a new recovery iteration
      state.currentIteration += 1;
      const iteration: RecoveryLoopIteration = {
        iteration: state.currentIteration,
        triggerStepId: stepId,
        triggerPhase: phase,
        failureReason,
        fixStepId: null,
        reReviewStepId: null,
        reTestStepId: null,
        outcome: "still_failing",
        startedAt: nowIso(),
        completedAt: null
      };
      state.iterations.push(iteration);

      // Trigger recovery loop on orchestratorService if available
      if (typeof (orchestratorService as Record<string, unknown>).triggerRecoveryLoop === "function") {
        (orchestratorService as unknown as { triggerRecoveryLoop: (args: { runId: string; stepId: string; phase: string; iteration: number }) => void }).triggerRecoveryLoop({
          runId,
          stepId,
          phase,
          iteration: state.currentIteration
        });
      }

      // Emit timeline event
      recordRuntimeEvent({
        runId,
        stepId,
        eventType: "retry_scheduled",
        eventKey: `recovery_loop:${phase}:${state.currentIteration}`,
        payload: {
          phase,
          iteration: state.currentIteration,
          maxIterations: recoveryPolicy.maxIterations,
          failureReason
        }
      });

      emitOrchestratorMessage(
        missionId,
        `Recovery loop iteration ${state.currentIteration}/${recoveryPolicy.maxIterations} triggered for ${phase} gate failure on step ${stepId}: ${failureReason}`
      );

      logger.info("ai_orchestrator.recovery_loop_triggered", {
        runId,
        stepId,
        phase,
        iteration: state.currentIteration,
        maxIterations: recoveryPolicy.maxIterations
      });

      return { triggered: true, exhausted: false, iteration: state.currentIteration };
    } catch (error) {
      logger.debug("ai_orchestrator.recovery_loop_failed", {
        runId,
        stepId: gateArgs.stepId,
        phase: gateArgs.phase,
        error: error instanceof Error ? error.message : String(error)
      });
      return { triggered: false, exhausted: false, iteration: 0 };
    }
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
      select mission_id,
        coalesce(sum(case when metric = 'tokens' then value else 0 end), 0) as total_tokens,
        coalesce(sum(case when metric = 'cost' then value else 0 end), 0) as cost_estimate_usd
      from orchestrator_metrics_samples
      where (? is null or mission_id = ?) and (? is null or created_at >= ?)
      group by mission_id order by total_tokens desc limit 50
    `, [missionFilter, missionFilter, since, since]) as Array<{
      mission_id: string; total_tokens: number; cost_estimate_usd: number;
    }>;
    const missionBreakdown: UsageMissionBreakdown[] = missionRows.map((r) => {
      const ubm = missionService.get(r.mission_id);
      return {
        missionId: r.mission_id, missionTitle: ubm?.title ?? r.mission_id.slice(0, 8),
        totalTokens: Number(r.total_tokens) || 0, costEstimateUsd: Number(r.cost_estimate_usd) || 0
      };
    });
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
    if (diagArgs.tier === "transient") return defaultDiagnosis;

    try {
      const peerField = diagArgs.tier === "blocker"
        ? `"peerNotification": "1-sentence alert for sibling agents about this blocker and how it might affect them"`
        : `"peerNotification": null`;

      const prompt = `You are the orchestrator's failure diagnosis engine. An agent working on a mission step has failed. Analyze the failure and provide recovery guidance.

Step: "${diagArgs.stepTitle}" (key: ${diagArgs.stepKey})
Mission: "${diagArgs.missionTitle}"
Objective: "${diagArgs.missionObjective}"
Step Instructions: ${diagArgs.stepInstructions.slice(0, 2000)}

Failure Details:
- Error class: ${diagArgs.errorClass}
- Error message: ${diagArgs.errorMessage.slice(0, 1500)}
- Attempt output: ${diagArgs.attemptSummary.slice(0, 2000)}
- Retry: ${diagArgs.retryCount}/${diagArgs.retryLimit}
- Tier: ${diagArgs.tier}

Respond with JSON only:
{
  "classification": "1-sentence diagnosis of root cause",
  "adjustedHint": "specific instruction for the retry agent on what to do differently (be concrete: which file, which approach, what to avoid)",
  ${peerField},
  "suggestedModel": null
}`;

      const configFailureDiag = resolveOrchestratorModelConfig(diagArgs.missionId, "failure_diagnosis");
      const result = await aiIntegrationService.executeTask({
        feature: "orchestrator" as const,
        taskType: "review" as const,
        prompt,
        cwd: projectRoot ?? "",
        provider: configFailureDiag.provider === "codex" ? "codex" : "claude",
        model: modelConfigToServiceModel(configFailureDiag),
        reasoningEffort: thinkingLevelToReasoningEffort(configFailureDiag.thinkingLevel),
        oneShot: true,
        timeoutMs: 20_000
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
        errorClass: attempt.errorClass,
        retryCount: step.retryCount,
        errorMessage
      });

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

    onOrchestratorRuntimeEvent(event: OrchestratorRuntimeEvent) {
      if (disposed) return;
      if (!event.runId) return;
      updateWorkerStateFromEvent(event);
      void syncMissionFromRun(event.runId, event.reason);
      // Quality gate evaluation for completed attempts
      if (event.reason === "attempt_completed" && event.stepId) {
        void evaluateQualityGateForStep(event.runId, event.stepId).catch((error) => {
          logger.debug("ai_orchestrator.quality_gate_event_handler_failed", {
            runId: event.runId,
            stepId: event.stepId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
      // Smart recovery diagnosis for failed attempts that will be retried
      if (event.reason === "completed" && event.attemptId && event.stepId) {
        void handleFailedAttemptRecovery({
          runId: event.runId,
          stepId: event.stepId,
          attemptId: event.attemptId
        }).catch((error) => {
          logger.debug("ai_orchestrator.recovery_diagnosis_event_failed", {
            runId: event.runId,
            stepId: event.stepId,
            attemptId: event.attemptId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
      const missionId = getMissionIdForRun(event.runId);
      if (!missionId) return;
      void replayQueuedWorkerMessages({
        reason: `runtime_event:${event.reason}`,
        missionId
      }).catch((error) => {
        logger.debug("ai_orchestrator.worker_delivery_runtime_event_replay_failed", {
          runId: event.runId,
          reason: event.reason,
          error: error instanceof Error ? error.message : String(error)
        });
      });

      // ── Stream event to persistent coordinator session ──────────
      // Only stream significant events to avoid flooding the coordinator with noise.
      // "completed" on the run means the whole run is done — end the coordinator session.
      if (
        event.reason === "attempt_completed" ||
        event.reason === "step_status_changed" ||
        event.reason === "attempt_blocked" ||
        event.reason === "completed" ||
        event.reason === "step_started" ||
        event.reason === "run_failed"
      ) {
        const coordSession = coordinatorSessions.get(event.runId);
        if (coordSession && !coordSession.dead) {
          // End session on terminal run events
          if (event.reason === "completed" || event.reason === "run_failed") {
            endCoordinatorSession(event.runId);
          } else {
            const graph = orchestratorService.getRunGraph({ runId: event.runId, timelineLimit: 0 });
            if (graph) {
              const completedCount = graph.steps.filter(
                (s) => s.status === "succeeded" || s.status === "skipped"
              ).length;
              const failedCount = graph.steps.filter((s) => s.status === "failed").length;
              const totalCount = graph.steps.length;
              const pct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
              const stepKey = event.stepId
                ? graph.steps.find((s) => s.id === event.stepId)?.stepKey ?? event.stepId
                : null;
              const readySteps = graph.steps
                .filter((s) => s.status === "pending")
                .map((s) => `"${s.stepKey}"`)
                .slice(0, 5);

              const eventMessage = [
                `[EVENT] ${event.reason}${stepKey ? ` — step "${stepKey}"` : ""} (${completedCount}/${totalCount} steps done, ${pct}%${failedCount > 0 ? `, ${failedCount} failed` : ""})`,
                readySteps.length ? `Next ready: ${readySteps.join(", ")}` : null
              ].filter(Boolean).join("\n");

              void sendCoordinatorEvent(event.runId, eventMessage).catch((error) => {
                logger.debug("ai_orchestrator.coordinator_event_dispatch_failed", {
                  runId: event.runId,
                  reason: event.reason,
                  error: error instanceof Error ? error.message : String(error)
                });
              });
            }
          }
        }
      }
    },

    onSessionRuntimeSignal,
    onAgentChatEvent,

    syncMissionFromRun,

    getWorkerStates,
    planWithAI,
    evaluateWorkerPlan,
    adjustPlanFromResults,
    handleInterventionWithAI,
    steerMission,
    getDepthConfig,
    getModelCapabilities: () => getModelCapabilities(),
    resolveMissionDepthConfig: (tier: MissionDepthTier) => resolveMissionDepthConfig(tier),
    resolveActivePolicy,
    sendChat,
    getChat,
    listChatThreads,
    getThreadMessages,
    sendThreadMessage,
    sendAgentMessage,
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
      coordinatorSessions.clear();
    }
  };
}
