import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  MissionDetail,
  MissionStep,
  MissionDepthTier,
  MissionDepthConfig,
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
  TerminalRuntimeState,
  SteerMissionArgs,
  SteerMissionResult,
  GetMissionDepthConfigArgs,
  GetModelCapabilitiesResult,
  UserSteeringDirective,
  OrchestratorChatMessage,
  SendOrchestratorChatArgs,
  GetOrchestratorChatArgs
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createMissionService } from "../missions/missionService";
import type { createOrchestratorService } from "./orchestratorService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createLaneService } from "../lanes/laneService";
import { planMissionOnce, plannerPlanToMissionSteps } from "../missions/missionPlanningService";

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
};

const PLAN_REVIEW_INTERVENTION_TITLE = "Mission plan approval required";
const STEERING_DIRECTIVES_METADATA_KEY = "steeringDirectives";
const ORCHESTRATOR_CHAT_METADATA_KEY = "orchestratorChat";
const ORCHESTRATOR_CHAT_SESSION_METADATA_KEY = "orchestratorChatSession";
const MAX_PERSISTED_STEERING_DIRECTIVES = 200;
const MAX_PERSISTED_CHAT_MESSAGES = 200;
const HEALTH_SWEEP_INTERVAL_MS = 15_000;
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
  lastPersistedAtMs: number;
};

type OrchestratorChatSessionState = {
  provider: "claude" | "codex";
  sessionId: string;
  updatedAt: string;
};

function nowIso(): string {
  return new Date().toISOString();
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

function parseChatMessage(value: unknown, missionId: string): OrchestratorChatMessage | null {
  if (!isRecord(value)) return null;
  const role = value.role === "user" || value.role === "orchestrator" || value.role === "worker"
    ? value.role
    : null;
  const content = typeof value.content === "string" ? value.content.trim() : "";
  const timestamp = typeof value.timestamp === "string" ? value.timestamp : nowIso();
  if (!role || !content.length) return null;
  return {
    id: typeof value.id === "string" && value.id.trim().length ? value.id : randomUUID(),
    missionId,
    role,
    content,
    timestamp,
    stepKey: typeof value.stepKey === "string" ? value.stepKey : null,
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
  return {
    requirePlanReview,
    defaultDepthTier,
    defaultPlannerProvider
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
  return `Run ${graph.run.id.slice(0, 8)} finished: ${succeeded}/${total} steps succeeded, ${failed} failed, ${blocked} blocked across ${attempts} attempt${attempts === 1 ? "" : "s"}.`;
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
  "You are a senior Project Manager orchestrating a development team.",
  "You delegate work to AI agents — you do not implement code yourself.",
  "Your job is to plan, evaluate, adjust, and steer mission execution.",
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
  laneService?: ReturnType<typeof createLaneService> | null;
  projectConfigService?: ReturnType<typeof createProjectConfigService> | null;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService> | null;
  projectRoot?: string;
}) {
  const { db, logger, missionService, orchestratorService, laneService, projectConfigService, aiIntegrationService, projectRoot } = args;
  const syncLocks = new Set<string>();
  const workerStates = new Map<string, OrchestratorWorkerState>();
  const activeSteeringDirectives = new Map<string, UserSteeringDirective[]>();
  const runDepthConfigs = new Map<string, MissionDepthConfig>();
  const chatMessages = new Map<string, OrchestratorChatMessage[]>();
  const activeChatSessions = new Map<string, OrchestratorChatSessionState>();
  const chatTurnQueues = new Map<string, Promise<void>>();
  const activeHealthSweepRuns = new Set<string>();
  const sessionRuntimeSignals = new Map<string, SessionRuntimeSignal>();
  const attemptRuntimeTrackers = new Map<string, AttemptRuntimeTracker>();
  const sessionSignalQueues = new Map<string, Promise<void>>();
  let healthSweepTimer: NodeJS.Timeout | null = null;

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
      .map((entry) => parseChatMessage(entry, missionId))
      .filter((entry): entry is OrchestratorChatMessage => !!entry)
      .slice(-MAX_PERSISTED_CHAT_MESSAGES);
    if (parsed.length > 0) {
      chatMessages.set(missionId, parsed);
    }
    return parsed;
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

  const appendChatMessage = (message: OrchestratorChatMessage) => {
    const existing = chatMessages.has(message.missionId)
      ? chatMessages.get(message.missionId) ?? []
      : loadChatMessagesFromMetadata(message.missionId);
    const next = [...existing, message].slice(-MAX_PERSISTED_CHAT_MESSAGES);
    chatMessages.set(message.missionId, next);
    try {
      updateMissionMetadata(message.missionId, (metadata) => {
        metadata[ORCHESTRATOR_CHAT_METADATA_KEY] = next;
      });
    } catch (error) {
      logger.debug("ai_orchestrator.chat_persist_failed", {
        missionId: message.missionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const emitOrchestratorMessage = (
    missionId: string,
    content: string,
    stepKey?: string | null,
    metadata?: Record<string, unknown> | null
  ): OrchestratorChatMessage => {
    const msg: OrchestratorChatMessage = {
      id: randomUUID(),
      missionId,
      role: "orchestrator",
      content,
      timestamp: new Date().toISOString(),
      stepKey: stepKey ?? null,
      metadata: metadata ?? null
    };
    appendChatMessage(msg);
    return msg;
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

  const resolveActiveDepthConfig = (missionId: string): MissionDepthConfig => {
    // Check mission metadata for depth tier
    const row = db.get<{ metadata_json: string | null }>(
      `select metadata_json from missions where id = ? limit 1`,
      [missionId]
    );
    if (row?.metadata_json) {
      try {
        const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
        if (typeof meta.missionDepth === "string") {
          const tier = meta.missionDepth as MissionDepthTier;
          if (tier === "light" || tier === "standard" || tier === "deep") {
            return resolveMissionDepthConfig(tier);
          }
        }
      } catch { /* ignore */ }
    }
    const config = readConfig(projectConfigService);
    return resolveMissionDepthConfig(config.defaultDepthTier);
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
      }
      tracker.lastPersistedAtMs = Math.max(tracker.lastPersistedAtMs, Math.floor(eventMs));
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
    const depthConfig = runDepthConfigs.get(args.runId) ?? resolveActiveDepthConfig(args.missionId);
    const fallback = depthConfig.execution.stepTimeoutMs;
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
        recordRuntimeEvent({
          runId: attempt.runId,
          stepId: attempt.stepId,
          attemptId: attempt.attemptId,
          sessionId,
          eventType: "question",
          eventKey: `question:${attempt.attemptId}:${digestSignalText(signal.lastOutputPreview) ?? "none"}:${Math.floor(Date.parse(signal.at) / 1000)}`,
          occurredAt: signal.at,
          payload: {
            preview: signal.lastOutputPreview,
            runtimeState: signal.runtimeState
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
      syncMissionFromRun(attempt.runId, "runtime_signal_session_end");
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
    pruneSessionRuntimeSignals();
    const runs = orchestratorService
      .listRuns({ limit: 1_000 })
      .filter((run) => run.status === "queued" || run.status === "running");
    let sweeps = 0;
    let staleRecovered = 0;

    for (const run of runs) {
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
            recordRuntimeEvent({
              runId: run.id,
              stepId: step.id,
              attemptId: attempt.id,
              sessionId,
              eventType: "question",
              eventKey: `sweep_question:${attempt.id}:${digestSignalText(effectivePreview) ?? "none"}:${Math.floor(Date.now() / 10_000)}`,
              payload: {
                source: "health_sweep",
                preview: effectivePreview
              }
            });
            const tracker = ensureAttemptRuntimeTracker(attempt.id);
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
        syncMissionFromRun(run.id, `health_sweep:${reason}`);
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

    return { sweeps, staleRecovered };
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
        }
      } else if (attempt.status === "succeeded") {
        attemptRuntimeTrackers.delete(attempt.id);
        deletePersistedAttemptRuntimeState(attempt.id);
        const outcomeTags = extractOutcomeTags(attempt);
        upsertWorkerState(attempt.id, {
          stepId: attempt.stepId,
          runId: attempt.runId,
          sessionId: attempt.executorSessionId,
          executorKind: attempt.executorKind,
          state: "completed",
          outcomeTags,
          completedAt: attempt.completedAt ?? nowIso()
        });
        emitOrchestratorMessage(
          graph.run.missionId,
          `Step "${stepTitle}" completed successfully.`,
          stepKey
        );

        // Evaluation loop: evaluate step if depth config requires it
        const step = graph.steps.find((s) => s.id === attempt.stepId);
        if (step && aiIntegrationService) {
          const depthConfig = runDepthConfigs.get(attempt.runId) ?? resolveActiveDepthConfig(graph.run.missionId);
          const isFinalStep = graph.steps.every(
            (s) => s.id === step.id || s.status === "succeeded" || s.status === "failed" || s.status === "skipped"
          );
          const stepMeta = isRecord(step.metadata) ? step.metadata : {};
          const completionCriteria = typeof stepMeta.completionCriteria === "string" ? stepMeta.completionCriteria : "";
          const hasCriteria = completionCriteria.length > 0 && completionCriteria !== "step_done";

          if (hasCriteria && (depthConfig.evaluation.evaluateEveryStep || isFinalStep)) {
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

        adjustPlanFromResults({
          runId: attempt.runId,
          completedStepId: attempt.stepId,
          outcomeTags
        });
      } else if (attempt.status === "failed") {
        attemptRuntimeTrackers.delete(attempt.id);
        deletePersistedAttemptRuntimeState(attempt.id);
        const outcomeTags = extractOutcomeTags(attempt);
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
              const depthConfig = runDepthConfigs.get(attempt.runId) ?? resolveActiveDepthConfig(graph.run.missionId);
              if (depthConfig.evaluation.autoResolveInterventions) {
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
      "Respond directly to the user. Keep it concise and practical.",
      "If they ask for status, summarize run progress, active workers, and blockers.",
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

    const callArgs = {
      feature: "orchestrator" as const,
      taskType: "review" as const,
      prompt,
      cwd: projectRoot,
      provider,
      reasoningEffort: "medium",
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

  /**
   * Plan a mission using AI.
   *
   * Delegation model: the leader process (this service) assembles the prompt
   * and parses the structured result, but all planning *reasoning* is
   * delegated to an external CLI process via `aiIntegrationService.executeTask()`
   * (which spawns a Claude or Codex CLI subprocess). The leader never performs
   * the AI inference itself — it only orchestrates prompt assembly and result
   * integration into the mission's step list.
   *
   * For the "light" depth tier the AI planner is skipped entirely — the
   * caller checks `depthConfig.planning.useAiPlanner` and returns early
   * before invoking this function (see `startMissionRun`).
   */
  const planWithAI = async (args: {
    missionId: string;
    provider: "claude" | "codex";
    model?: string;
  }): Promise<void> => {
    const mission = missionService.get(args.missionId);
    if (!mission) {
      logger.warn("ai_orchestrator.plan_with_ai_mission_not_found", { missionId: args.missionId });
      return;
    }

    if (!aiIntegrationService || !projectRoot) {
      logger.warn("ai_orchestrator.plan_with_ai_not_available", {
        missionId: args.missionId,
        hasAiService: !!aiIntegrationService,
        hasProjectRoot: !!projectRoot,
        fallback: "deterministic"
      });
      return;
    }

    try {
      const plannerEngine: MissionPlannerEngine = args.provider === "codex" ? "codex_cli" : "claude_cli";
      const planning = await planMissionOnce({
        missionId: args.missionId,
        title: mission.title,
        prompt: mission.prompt,
        laneId: mission.laneId,
        plannerEngine,
        projectRoot,
        aiIntegrationService,
        logger
      });

      const plannedSteps = plannerPlanToMissionSteps({
        plan: planning.plan,
        requestedEngine: planning.run.requestedEngine,
        resolvedEngine: planning.run.resolvedEngine,
        executorPolicy: "both",
        degraded: planning.run.degraded,
        reasonCode: planning.run.reasonCode,
        validationErrors: planning.run.validationErrors
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
          const fallbackDetail = planning.run.degraded
            ? ` Note: AI planning fell back to deterministic (${planning.run.reasonCode ?? "unknown"}${planning.run.reasonDetail ? `: ${planning.run.reasonDetail}` : ""}).`
            : "";
          return `Planning complete. Created ${plannedSteps.length} steps: ${preview}.${fallbackDetail}`;
        })()
      );

      logger.info("ai_orchestrator.plan_with_ai_completed", {
        missionId: args.missionId,
        provider: args.provider,
        resolvedEngine: planning.run.resolvedEngine,
        degraded: planning.run.degraded,
        stepCount: plannedSteps.length
      });
    } catch (error) {
      logger.warn("ai_orchestrator.plan_with_ai_failed", {
        missionId: args.missionId,
        error: error instanceof Error ? error.message : String(error),
        fallback: "deterministic_steps_retained"
      });
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
        "Evaluate: output quality, scope compliance, alignment with mission goals, and completeness.",
        "Be pragmatic — minor warnings are acceptable if the core deliverable is met.",
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

      // Resolve reasoning effort based on the depth tier of the active run
      const depthTier = (() => {
        for (const [, config] of runDepthConfigs) {
          return config.tier;
        }
        return "standard" as MissionDepthTier;
      })();
      const evaluationReasoningEffort = depthTier === "deep" ? "high" : "medium";

      const result = await aiIntegrationService.executeTask({
        feature: "orchestrator",
        taskType: "review",
        prompt,
        cwd: projectRoot,
        provider: args.provider,
        reasoningEffort: evaluationReasoningEffort,
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
    const prompt = [
      PM_SYSTEM_PREAMBLE,
      "Your current role: PLAN ADJUSTER. Based on completed step results, determine if the remaining plan needs adjustments.",
      "",
      `Run ID: ${adjustArgs.runId}`,
      `Completed steps: ${completed.length}/${graph.steps.length}`,
      `Remaining steps: ${remaining.map((s) => `${s.stepKey} (${s.status})`).join(", ") || "none"}`,
      `Last completed step: ${targetStep?.stepKey ?? adjustArgs.completedStepId} — status: ${targetStep?.status ?? "unknown"}`,
      steeringContext,
      "Available actions: add_step (add a new corrective step), skip_step (skip a remaining step), no_change.",
      "Only add corrective steps when genuinely needed — avoid over-engineering the plan.",
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

    // Resolve reasoning effort based on the depth tier of the run
    const adjustDepthConfig = runDepthConfigs.get(adjustArgs.runId);
    const adjustReasoningEffort = adjustDepthConfig?.tier === "deep" ? "high" : "medium";

    const result = await aiIntegrationService.executeTask({
      feature: "orchestrator",
      taskType: "planning",
      prompt,
      cwd: projectRoot,
      reasoningEffort: adjustReasoningEffort,
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
      const shouldTriggerAiAdjustment =
        aiIntegrationService &&
        projectRoot &&
        (
          (step.status === "failed" && step.retryCount >= step.retryLimit) ||
          stepMeta.stepType === "integration" ||
          (step.status === "succeeded" && args.outcomeTags.includes("has_warnings"))
        );

      emitOrchestratorMessage(
        graph.run.missionId,
        `Analyzing results from step "${stepTitleForMessage(step)}". ${shouldTriggerAiAdjustment ? "Triggering AI plan adjustment." : "No plan adjustments needed."}`,
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

      const depthConfig = resolveActiveDepthConfig(args.missionId);
      const confidenceThreshold = depthConfig.evaluation.interventionConfidenceThreshold;
      const steeringContext = getSteeringContext(args.missionId);
      const prompt = [
        PM_SYSTEM_PREAMBLE,
        "Your current role: INTERVENTION RESOLVER. An intervention has been raised during mission execution.",
        "Determine if it can be auto-resolved or if it needs human attention.",
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

      // Interventions are important decisions — always use high reasoning effort
      const result = await aiIntegrationService.executeTask({
        feature: "orchestrator",
        taskType: "review",
        prompt,
        cwd: projectRoot,
        provider: args.provider,
        reasoningEffort: "high",
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

  const syncMissionFromRun = (runId: string, reason: string) => {
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
          description: `Auto-created by orchestrator for mission ${args.missionId} (${root.title || root.stepKey}).`
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

  const startMissionRun = async (args: MissionRunStartArgs): Promise<MissionRunStartResult> => {
    const missionId = String(args.missionId ?? "").trim();
    if (!missionId.length) throw new Error("missionId is required.");
    const initialMission = missionService.get(missionId);
    if (!initialMission) throw new Error(`Mission not found: ${missionId}`);

    // Resolve depth config from mission metadata or args
    const depthConfig = resolveActiveDepthConfig(missionId);
    const config = readConfig(projectConfigService);

    // If an AI planner provider is specified, invoke AI planning first
    // For "light" tier, skip AI planning entirely (deterministic only)
    const provider: "claude" | "codex" | null = (() => {
      if (args.plannerProvider === "claude" || args.plannerProvider === "codex") return args.plannerProvider;
      if (args.plannerProvider === "deterministic") return null;
      if (config.defaultPlannerProvider) return config.defaultPlannerProvider;
      const availability = aiIntegrationService?.getAvailability?.();
      if (availability?.claude) return "claude";
      if (availability?.codex) return "codex";
      return null;
    })();
    const attemptedAiPlanner = depthConfig.planning.useAiPlanner && (provider === "claude" || provider === "codex");
    if (attemptedAiPlanner) {
      await planWithAI({ missionId, provider });
    } else if (!depthConfig.planning.useAiPlanner && (provider === "claude" || provider === "codex")) {
      logger.info("ai_orchestrator.ai_planning_skipped_by_depth", {
        missionId,
        tier: depthConfig.tier,
        reason: "light tier uses deterministic planning only"
      });
    }

    const bypassPlanReview = args.forcePlanReviewBypass === true;
    const requireReview = config.requirePlanReview || depthConfig.planning.requirePlanReview;
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

    transitionMissionStatus(missionId, "planning");
    const plannerParallelismCap = resolveMissionParallelismCap(missionId);
    const parallelismCap = plannerParallelismCap ?? depthConfig.execution.maxParallelWorkers;
    const started = orchestratorService.startRunFromMission({
      missionId,
      runMode: args.runMode,
      autopilotOwnerId: args.autopilotOwnerId,
      defaultExecutorKind: args.defaultExecutorKind,
      defaultRetryLimit: args.defaultRetryLimit ?? depthConfig.execution.defaultRetryLimit,
      metadata: {
        ...(args.metadata ?? {}),
        plannerParallelismCap: parallelismCap,
        depthTier: depthConfig.tier,
        depthConfig: {
          maxParallelWorkers: depthConfig.execution.maxParallelWorkers,
          evaluateEveryStep: depthConfig.evaluation.evaluateEveryStep,
          autoAdjustPlan: depthConfig.evaluation.autoAdjustPlan,
          autoResolveInterventions: depthConfig.evaluation.autoResolveInterventions,
          interventionConfidenceThreshold: depthConfig.evaluation.interventionConfidenceThreshold
        }
      }
    });

    // Cache depth config for this run
    runDepthConfigs.set(started.run.id, depthConfig);

    const plannerMeta = (() => {
      const metadata = getMissionMetadata(missionId);
      const planner = isRecord(metadata.planner) ? metadata.planner : null;
      if (!planner) return null;
      return {
        degraded: planner.degraded === true,
        reasonCode: typeof planner.reasonCode === "string" ? planner.reasonCode : null
      };
    })();
    const plannerSummary = (() => {
      if (!attemptedAiPlanner) return "Using deterministic planner.";
      if (!plannerMeta) return `Using AI planner (${provider ?? "auto"}).`;
      if (!plannerMeta.degraded) return `Using AI planner (${provider ?? "auto"}).`;
      return `AI planner attempted (${provider ?? "auto"}) and fell back to deterministic${plannerMeta.reasonCode ? ` (${plannerMeta.reasonCode})` : ""}.`;
    })();

    emitOrchestratorMessage(
      missionId,
      `Starting mission with ${started.steps.length} steps. Depth tier: ${depthConfig.tier}. ${plannerSummary}`
    );

    transitionMissionStatus(missionId, "in_progress");
    syncMissionFromRun(started.run.id, "mission_run_started");

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

    logger.info("ai_orchestrator.mission_steered", {
      missionId,
      priority: directive.priority,
      targetStepKey: directive.targetStepKey ?? "all",
      directivePreview: directive.directive.slice(0, 100)
    });

    const projectedStepCount = projectSteeringDirectiveToActiveSteps(directive);

    const resolvedInterventions: string[] = [];
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
          recordRuntimeEvent({
            runId,
            stepId: typeof meta?.stepId === "string" ? meta.stepId : null,
            attemptId: typeof meta?.attemptId === "string" ? meta.attemptId : null,
            sessionId: typeof meta?.sessionId === "string" ? meta.sessionId : null,
            eventType: "intervention_resolved",
            eventKey: `intervention_resolved:${intervention.id}:${directive.priority}`,
            payload: {
              interventionId: intervention.id,
              reason: "steering_directive",
              priority: directive.priority,
              directive: clipTextForContext(directive.directive, 220)
            }
          });
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

  const sendChat = (chatArgs: SendOrchestratorChatArgs): OrchestratorChatMessage => {
    const msg: OrchestratorChatMessage = {
      id: randomUUID(),
      missionId: chatArgs.missionId,
      role: "user",
      content: chatArgs.content,
      timestamp: new Date().toISOString(),
      stepKey: null,
      metadata: null
    };
    appendChatMessage(msg);
    const recentChatContext = formatRecentChatContext(chatMessages.get(chatArgs.missionId) ?? [msg]);
    const statusIntent = /\b(status|progress|stuck|heartbeat|worker|lane)\b/i.test(chatArgs.content);
    if (statusIntent) {
      void (async () => {
        try {
          const sweep = await runHealthSweep("chat_status");
          const summary = summarizeRunForChat(chatArgs.missionId);
          const recoveryNote =
            sweep.staleRecovered > 0
              ? ` Recovered ${sweep.staleRecovered} stale attempt${sweep.staleRecovered === 1 ? "" : "s"} during health sweep.`
              : "";
          emitOrchestratorMessage(chatArgs.missionId, `${summary}${recoveryNote}`.trim());
        } catch {
          emitOrchestratorMessage(chatArgs.missionId, summarizeRunForChat(chatArgs.missionId));
        }
      })();
    }

    // Also store as a steering directive (preserves existing behavior)
    try {
      steerMission({
        missionId: chatArgs.missionId,
        directive: chatArgs.content,
        priority: "instruction"
      });
    } catch { /* ignore if mission not found */ }

    if (aiIntegrationService && projectRoot) {
      enqueueChatResponse(chatArgs, recentChatContext);
    } else if (!statusIntent) {
      emitOrchestratorMessage(
        chatArgs.missionId,
        "Directive received. I will apply it at the next planning/evaluation decision point."
      );
    }

    return msg;
  };

  const getChat = (chatArgs: GetOrchestratorChatArgs): OrchestratorChatMessage[] => {
    return chatMessages.get(chatArgs.missionId) ?? loadChatMessagesFromMetadata(chatArgs.missionId);
  };

  const startHealthSweepLoop = () => {
    if (healthSweepTimer) return;
    healthSweepTimer = setInterval(() => {
      void runHealthSweep("interval");
    }, HEALTH_SWEEP_INTERVAL_MS);
    void runHealthSweep("startup");
  };

  const onSessionRuntimeSignal = (signal: SessionRuntimeSignal): void => {
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
        await processSessionRuntimeSignal(normalizedSignal);
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

  hydratePersistedAttemptRuntimeState();
  hydrateRuntimeSignalsFromEventBus();
  startHealthSweepLoop();

  return {
    startMissionRun,

    approveMissionPlan,

    onOrchestratorRuntimeEvent(event: OrchestratorRuntimeEvent) {
      if (!event.runId) return;
      updateWorkerStateFromEvent(event);
      syncMissionFromRun(event.runId, event.reason);
    },

    onSessionRuntimeSignal,

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
    sendChat,
    getChat,
    runHealthSweep: (reason = "manual") => runHealthSweep(reason),
    dispose: () => {
      if (healthSweepTimer) {
        clearInterval(healthSweepTimer);
        healthSweepTimer = null;
      }
    }
  };
}
