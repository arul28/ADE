import { randomUUID } from "node:crypto";
import type {
  MissionDetail,
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
  projectConfigService?: ReturnType<typeof createProjectConfigService> | null;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService> | null;
  projectRoot?: string;
}) {
  const { db, logger, missionService, orchestratorService, projectConfigService, aiIntegrationService, projectRoot } = args;
  const syncLocks = new Set<string>();
  const workerStates = new Map<string, OrchestratorWorkerState>();
  const activeSteeringDirectives = new Map<string, UserSteeringDirective[]>();
  const runDepthConfigs = new Map<string, MissionDepthConfig>();
  const chatMessages = new Map<string, OrchestratorChatMessage[]>();
  const activeChatSessions = new Map<string, OrchestratorChatSessionState>();
  const chatTurnQueues = new Map<string, Promise<void>>();

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
    return [
      "",
      "Active user steering directives (apply these to your decisions):",
      ...directives.map((d, i) =>
        `  ${i + 1}. [${d.priority}] ${d.directive}${d.targetStepKey ? ` (target: ${d.targetStepKey})` : ""}`
      ),
      ""
    ].join("\n");
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
                  ? `Step "${step.stepKey}" passed evaluation. ${evalResult.feedback}`
                  : `Step "${step.stepKey}" failed evaluation: ${evalResult.feedback}.`,
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
        const retriesLeft = step ? step.retryLimit - step.retryCount : 0;
        emitOrchestratorMessage(
          graph.run.missionId,
          `Step "${stepTitle}" failed: ${attempt.errorMessage ?? "unknown error"}. ${retriesLeft > 0 ? `Retrying (${retriesLeft} retries left).` : "No retries remaining."}`,
          stepKey
        );
        if (step && step.retryCount >= step.retryLimit) {
          try {
            const intervention = missionService.addIntervention({
              missionId: graph.run.missionId,
              interventionType: "failed_step",
              title: `Step "${step.stepKey}" failed after ${step.retryCount} retries`,
              body: `Step ${step.stepKey} exhausted all ${step.retryLimit} retries. Last error: ${attempt.errorMessage ?? "unknown"}`,
              requestedAction: "Review and decide whether to retry, skip, or add a workaround."
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
      return `Run ${targetRun.id.slice(0, 8)} is ${targetRun.status}. Progress ${done}/${total}. Running ${running}. Failed ${failed}. Blocked ${blocked}.`;
    } catch {
      return `Latest run ${targetRun.id.slice(0, 8)} is ${targetRun.status}.`;
    }
  };

  const formatRecentChatContext = (messages: OrchestratorChatMessage[], limit = 12): string => {
    const recent = messages.slice(-limit);
    if (!recent.length) return "";
    const lines = recent.map((entry) => {
      const role = entry.role === "user" ? "User" : entry.role === "worker" ? "Worker" : "Orchestrator";
      return `- ${role}: ${entry.content}`;
    });
    return ["Recent mission chat:", ...lines, ""].join("\n");
  };

  const buildRecentChatContext = (missionId: string, limit = 12): string => {
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
      `Latest user message: ${chatArgs.content}`,
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
        `Planning complete. Created ${plannedSteps.length} steps: ${plannedSteps.map((s) => s.title).join(", ")}. ${planning.run.degraded ? "Note: AI planning was unavailable, used deterministic fallback." : ""}`
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
        `Analyzing results from step "${step.stepKey}". ${shouldTriggerAiAdjustment ? "Triggering AI plan adjustment." : "No plan adjustments needed."}`,
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

  const startMissionRun = async (args: MissionRunStartArgs): Promise<MissionRunStartResult> => {
    const missionId = String(args.missionId ?? "").trim();
    if (!missionId.length) throw new Error("missionId is required.");
    const mission = missionService.get(missionId);
    if (!mission) throw new Error(`Mission not found: ${missionId}`);

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

    emitOrchestratorMessage(
      missionId,
      `Starting mission with ${started.steps.length} steps. Depth tier: ${depthConfig.tier}. ${attemptedAiPlanner ? `Using AI planner (${provider ?? "auto"}).` : "Using deterministic planner."}`
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

    return {
      acknowledged: true,
      appliedAt: nowIso(),
      response: `Directive accepted (${directive.priority}). Will be applied at the next AI decision point.`
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
    } else {
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

  return {
    startMissionRun,

    approveMissionPlan,

    onOrchestratorRuntimeEvent(event: OrchestratorRuntimeEvent) {
      if (!event.runId) return;
      updateWorkerStateFromEvent(event);
      syncMissionFromRun(event.runId, event.reason);
    },

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
    getChat
  };
}
