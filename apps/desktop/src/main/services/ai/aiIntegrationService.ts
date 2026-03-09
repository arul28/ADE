import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { AgentModelDescriptor, AgentProvider, ExecutorOpts } from "./agentExecutor";
import type { AiApiKeyVerificationResult } from "../../../shared/types";
import {
  getDefaultModelDescriptor,
  getModelById,
  getAvailableModels,
  listModelDescriptorsForProvider,
  MODEL_REGISTRY,
  resolveModelAlias,
  enrichModelRegistry,
} from "../../../shared/modelRegistry";
import { detectAllAuth, getCachedCliAuthStatuses, verifyProviderApiKey, type DetectedAuth, type CliAuthStatus } from "./authDetector";
import { executeUnified, resumeUnified } from "./unifiedExecutor";
import { initialize as initModelsDevService } from "./modelsDevService";
import { updateModelPricing } from "../../../shared/modelProfiles";
import { isRecord } from "../shared/utils";
import type { createMemoryService } from "../memory/memoryService";

export type AiTaskType =
  | "planning"
  | "implementation"
  | "review"
  | "conflict_resolution"
  | "narrative"
  | "pr_description"
  | "terminal_summary"
  | "mission_planning"
  | "initial_context";

export type AiFeatureKey =
  | "narratives"
  | "conflict_proposals"
  | "pr_descriptions"
  | "terminal_summaries"
  | "mission_planning"
  | "orchestrator"
  | "initial_context";

export type AiProviderMode = "guest" | "subscription";

export type AiIntegrationStatus = {
  mode: AiProviderMode;
  availableProviders: {
    claude: boolean;
    codex: boolean;
  };
  models: {
    claude: AgentModelDescriptor[];
    codex: AgentModelDescriptor[];
  };
  detectedAuth?: Array<{
    type: "cli-subscription" | "api-key" | "openrouter" | "local";
    cli?: "claude" | "codex" | "gemini";
    provider?: string;
    source?: "config" | "env" | "store";
    path?: string;
    endpoint?: string;
    authenticated?: boolean;
    verified?: boolean;
  }>;
  availableModelIds?: string[];
};

export type ExecuteAiTaskArgs = {
  feature: AiFeatureKey;
  taskType: AiTaskType;
  prompt: string;
  cwd: string;
  provider?: AgentProvider;
  jsonSchema?: unknown;
  systemPrompt?: string;
  timeoutMs?: number;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: ExecutorOpts["permissions"]["mode"];
  oneShot?: boolean;
  sessionId?: string;
  projectId?: string;
  runId?: string;
  stepId?: string;
  attemptId?: string;
  memoryService?: ReturnType<typeof createMemoryService> | null;
};

export type ExecuteAiTaskResult = {
  text: string;
  structuredOutput: unknown;
  provider: AgentProvider;
  model: string | null;
  sessionId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
};

type RuntimeTaskDefaults = {
  modelId: string;
  timeoutMs: number;
};

const DEFAULT_CLAUDE_TASK_MODEL_ID = getDefaultModelDescriptor("claude")?.id ?? "anthropic/claude-sonnet-4-6";
const DEFAULT_CODEX_TASK_MODEL_ID = getDefaultModelDescriptor("codex")?.id ?? "openai/gpt-5.4-codex";

const TASK_DEFAULTS: Record<AiTaskType, RuntimeTaskDefaults> = {
  planning: {
    modelId: DEFAULT_CLAUDE_TASK_MODEL_ID,
    timeoutMs: 45_000
  },
  implementation: {
    modelId: DEFAULT_CODEX_TASK_MODEL_ID,
    timeoutMs: 120_000
  },
  review: {
    modelId: DEFAULT_CLAUDE_TASK_MODEL_ID,
    timeoutMs: 30_000
  },
  conflict_resolution: {
    modelId: DEFAULT_CLAUDE_TASK_MODEL_ID,
    timeoutMs: 60_000
  },
  narrative: {
    modelId: "anthropic/claude-haiku-4-5",
    timeoutMs: 45_000
  },
  pr_description: {
    modelId: "anthropic/claude-haiku-4-5",
    timeoutMs: 30_000
  },
  terminal_summary: {
    modelId: "anthropic/claude-haiku-4-5",
    timeoutMs: 20_000
  },
  mission_planning: {
    modelId: DEFAULT_CLAUDE_TASK_MODEL_ID,
    timeoutMs: 300_000
  },
  initial_context: {
    modelId: DEFAULT_CLAUDE_TASK_MODEL_ID,
    timeoutMs: 45_000
  }
};

const CODEX_FALLBACK_MODELS: AgentModelDescriptor[] = listModelDescriptorsForProvider("codex")
  .map((descriptor) => ({ id: descriptor.id, label: descriptor.displayName }));

function toStringOrNull(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length ? text : null;
}

function toNumberOrNull(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toTextPreview(value: string, maxChars = 800): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
}

function toJsonPreview(value: unknown, maxChars = 800): string | null {
  if (value == null) return null;
  try {
    return toTextPreview(JSON.stringify(value), maxChars);
  } catch {
    return toTextPreview(String(value), maxChars);
  }
}

function resolveUnifiedToolMode(args: {
  feature: AiFeatureKey;
  taskType: AiTaskType;
  permissionMode?: ExecutorOpts["permissions"]["mode"];
}): "planning" | "coding" | "none" {
  if (args.taskType === "mission_planning") {
    return "planning";
  }
  if (args.feature === "orchestrator" && args.permissionMode === "read-only") {
    return "planning";
  }
  if (args.permissionMode === "read-only") {
    return "none";
  }
  return "coding";
}

function startOfDayIso(now = new Date()): string {
  const utc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);
  return new Date(utc).toISOString();
}

function extractAiConfig(snapshot: ReturnType<ReturnType<typeof createProjectConfigService>["get"]>): Record<string, unknown> {
  return isRecord(snapshot.effective.ai) ? snapshot.effective.ai : {};
}

function extractConfiguredApiKeys(snapshot: ReturnType<ReturnType<typeof createProjectConfigService>["get"]>): Record<string, string> {
  const aiConfig = extractAiConfig(snapshot);
  const apiKeysRaw = isRecord(aiConfig.apiKeys) ? aiConfig.apiKeys : {};
  const out: Record<string, string> = {};

  for (const [provider, rawValue] of Object.entries(apiKeysRaw)) {
    const key = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!key) continue;
    out[provider.trim().toLowerCase()] = key;
  }

  return out;
}

function toCliAvailability(auth: DetectedAuth[]): { claude: boolean; codex: boolean } {
  return {
    claude: auth.some((entry) => entry.type === "cli-subscription" && entry.cli === "claude"),
    codex: auth.some((entry) => entry.type === "cli-subscription" && entry.cli === "codex"),
  };
}

function redactDetectedAuth(
  auth: DetectedAuth[],
  cliStatuses: CliAuthStatus[],
): NonNullable<AiIntegrationStatus["detectedAuth"]> {
  const redacted = auth.map((entry) => {
    if (entry.type === "cli-subscription") {
      return {
        type: entry.type,
        cli: entry.cli,
        path: entry.path,
        authenticated: entry.authenticated,
        verified: entry.verified,
      };
    }
    if (entry.type === "api-key") {
      return {
        type: entry.type,
        provider: entry.provider,
        source: entry.source,
      };
    }
    if (entry.type === "openrouter") {
      return {
        type: entry.type,
        provider: "openrouter",
        source: entry.source,
      };
    }
    return {
      type: entry.type,
      provider: entry.provider,
      endpoint: entry.endpoint,
    };
  });

  for (const cliStatus of cliStatuses) {
    if (!cliStatus.installed) continue;
    const existingIndex = redacted.findIndex(
      (entry) => entry.type === "cli-subscription" && entry.cli === cliStatus.cli,
    );
    const normalizedEntry = {
      type: "cli-subscription" as const,
      cli: cliStatus.cli,
      path: cliStatus.path ?? cliStatus.cli,
      authenticated: cliStatus.authenticated,
      verified: cliStatus.verified,
    };
    if (existingIndex >= 0) {
      redacted[existingIndex] = normalizedEntry;
    } else {
      redacted.push(normalizedEntry);
    }
  }

  return redacted;
}

export function createAiIntegrationService(args: {
  db: AdeDb;
  logger: Logger;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
}) {
  const { db, logger, projectConfigService } = args;

  // Non-blocking: fetch models.dev data and enrich pricing + registry
  initModelsDevService().then((modelData) => {
    if (modelData.size === 0) return;

    // Update MODEL_PRICING with fresh cost data
    const pricingUpdates: Record<string, { input: number; output: number }> = {};
    const enrichments = new Map<string, { contextWindow?: number; maxOutputTokens?: number }>();

    for (const [modelId, data] of modelData) {
      if (data.cost) {
        pricingUpdates[modelId] = data.cost;
      }
      if (data.contextWindow || data.maxOutputTokens) {
        enrichments.set(modelId, {
          contextWindow: data.contextWindow,
          maxOutputTokens: data.maxOutputTokens,
        });
      }
    }

    const pricingCount = updateModelPricing(pricingUpdates);
    const enrichCount = enrichModelRegistry(enrichments);
    logger.info("ai.modelsdev.enriched", { pricingCount, enrichCount });
  }).catch((err) => {
    logger.warn("ai.modelsdev.init_failed", { error: err instanceof Error ? err.message : String(err) });
  });

  const detectAuth = async (): Promise<DetectedAuth[]> => {
    const snapshot = projectConfigService.get();
    return await detectAllAuth(extractConfiguredApiKeys(snapshot));
  };

  const getAvailabilitySync = () => {
    const statuses = getCachedCliAuthStatuses();
    const claude = statuses.find((entry) => entry.cli === "claude");
    const codex = statuses.find((entry) => entry.cli === "codex");
    return {
      claude: Boolean(claude?.installed && (claude.authenticated || !claude.verified)),
      codex: Boolean(codex?.installed && (codex.authenticated || !codex.verified)),
    };
  };

  const getAvailabilityAsync = async () => {
    const auth = await detectAuth();
    const availability = toCliAvailability(auth);
    return {
      ...availability,
      detectedAuth: auth,
      availableModels: getAvailableModels(auth),
    };
  };

  const verifyApiKeyConnection = async (provider: string): Promise<AiApiKeyVerificationResult> => {
    const normalizedProvider = String(provider ?? "").trim().toLowerCase();
    const auth = await detectAuth();

    const apiEntry =
      normalizedProvider === "openrouter"
        ? auth.find((entry): entry is Extract<DetectedAuth, { type: "openrouter" }> => entry.type === "openrouter")
        : auth.find(
            (entry): entry is Extract<DetectedAuth, { type: "api-key" }> =>
              entry.type === "api-key" && entry.provider === normalizedProvider
          );

    if (!apiEntry) {
      return {
        provider: normalizedProvider,
        ok: false,
        message: "No API key configured for this provider.",
        verifiedAt: new Date().toISOString(),
      };
    }

    const providerName = apiEntry.type === "openrouter" ? "openrouter" : apiEntry.provider;
    const verification = await verifyProviderApiKey(providerName, apiEntry.key);
    return {
      ...verification,
      source: apiEntry.source,
    };
  };

  const getMode = (): AiProviderMode => {
    const snapshot = projectConfigService.get();
    return snapshot.effective.providerMode === "subscription" ? "subscription" : "guest";
  };

  const getFeatureFlag = (feature: AiFeatureKey): boolean => {
    const snapshot = projectConfigService.get();
    const aiConfig = extractAiConfig(snapshot);
    const features = isRecord(aiConfig.features) ? aiConfig.features : {};
    const value = features[feature];
    return value == null ? true : Boolean(value);
  };

  const getDailyBudgetLimit = (feature: AiFeatureKey): number | null => {
    const snapshot = projectConfigService.get();
    const aiConfig = extractAiConfig(snapshot);
    const budgets = isRecord(aiConfig.budgets) ? aiConfig.budgets : {};
    const entry = isRecord(budgets[feature]) ? (budgets[feature] as Record<string, unknown>) : {};

    const daily = toNumberOrNull(entry.dailyLimit);
    if (daily == null || daily <= 0) return null;
    return daily;
  };

  const countDailyUsage = (feature: AiFeatureKey): number => {
    const row = db.get<{ count: number }>(
      `
        select count(*) as count
        from ai_usage_log
        where feature = ?
          and timestamp >= ?
          and success = 1
      `,
      [feature, startOfDayIso()]
    );

    return Number(row?.count ?? 0);
  };

  /** Batch version: fetch all feature counts in a single query instead of N individual queries. */
  const countDailyUsageBatch = (features: AiFeatureKey[]): Map<AiFeatureKey, number> => {
    const result = new Map<AiFeatureKey, number>();
    if (!features.length) return result;
    const placeholders = features.map(() => "?").join(",");
    const rows = db.all<{ feature: string; count: number }>(
      `
        select feature, count(*) as count
        from ai_usage_log
        where feature in (${placeholders})
          and timestamp >= ?
          and success = 1
        group by feature
      `,
      [...features, startOfDayIso()]
    );
    for (const f of features) result.set(f, 0);
    for (const row of rows) result.set(row.feature as AiFeatureKey, Number(row.count ?? 0));
    return result;
  };

  const checkBudget = (feature: AiFeatureKey): void => {
    const limit = getDailyBudgetLimit(feature);
    if (limit == null) return;

    const used = countDailyUsage(feature);
    if (used >= limit) {
      throw new Error(`Daily AI budget reached for '${feature}' (${used}/${limit}).`);
    }
  };

  const logUsage = (args: {
    feature: AiFeatureKey;
    provider: AgentProvider;
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number;
    success: boolean;
    sessionId: string | null;
  }) => {
    db.run(
      `
        insert into ai_usage_log(
          id,
          timestamp,
          feature,
          provider,
          model,
          input_tokens,
          output_tokens,
          duration_ms,
          success,
          session_id
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        randomUUID(),
        new Date().toISOString(),
        args.feature,
        args.provider,
        args.model,
        args.inputTokens,
        args.outputTokens,
        Math.max(0, Math.floor(args.durationMs)),
        args.success ? 1 : 0,
        args.sessionId
      ]
    );
  };

  const resolveModelForTask = async (taskType: AiTaskType, modelIdHint?: string): Promise<string> => {
    const snapshot = projectConfigService.get();
    const aiConfig = extractAiConfig(snapshot);
    const taskRouting = isRecord(aiConfig.taskRouting) ? aiConfig.taskRouting : {};
    const taskOverride = isRecord(taskRouting[taskType]) ? (taskRouting[taskType] as Record<string, unknown>) : {};
    const overrideModelId = toStringOrNull(taskOverride.model);
    const requestedModelHint = modelIdHint ?? overrideModelId ?? undefined;

    // If explicit model ID provided and valid, use it
    if (requestedModelHint) {
      const exact = getModelById(requestedModelHint);
      if (exact) return exact.id;
    }

    // Resolve from alias (e.g. "sonnet" -> "anthropic/claude-sonnet-4-6")
    if (requestedModelHint) {
      const resolved = resolveModelAlias(requestedModelHint);
      if (resolved) return resolved.id;
    }

    // Check task defaults and map provider family to model ID.
    const defaults = TASK_DEFAULTS[taskType];
    const auth = await detectAuth();
    const available = getAvailableModels(auth);

    if (!available.length) {
      throw new Error("No AI providers detected. Install Claude Code CLI, Codex CLI, or configure an API key.");
    }

    const preferredDescriptor = getModelById(defaults.modelId) ?? resolveModelAlias(defaults.modelId);
    if (preferredDescriptor) {
      const exactMatch = available.find((candidate) => candidate.id === preferredDescriptor.id || candidate.shortId === preferredDescriptor.shortId);
      if (exactMatch) return exactMatch.id;
      const familyMatch = available.find((candidate) => candidate.family === preferredDescriptor.family);
      if (familyMatch) return familyMatch.id;
    }

    // Fall back to first available
    return available[0].id;
  };

  const consumeEventStream = async (
    stream: AsyncIterable<{ type: string; [key: string]: unknown }>,
    feature: AiFeatureKey,
    modelId: string,
  ): Promise<ExecuteAiTaskResult> => {
    const start = Date.now();
    let text = "";
    let structuredOutput: unknown = null;
    let sessionId: string | null = null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let model: string | null = null;

    for await (const event of stream) {
      if (event.type === "text") text += event.content;
      if (event.type === "structured_output") structuredOutput = event.data;
      if (event.type === "done") {
        sessionId = event.sessionId as string | null;
        inputTokens = (event.usage as { inputTokens?: number })?.inputTokens ?? null;
        outputTokens = (event.usage as { outputTokens?: number })?.outputTokens ?? null;
        model = (event.model as string) ?? null;
      }
      if (event.type === "error") throw new Error(event.message as string);
    }

    const durationMs = Date.now() - start;
    const descriptor = getModelById(modelId);

    logUsage({
      feature,
      provider: (descriptor?.family ?? "unknown") as AgentProvider,
      model,
      inputTokens,
      outputTokens,
      durationMs,
      success: true,
      sessionId
    });

    return {
      text,
      structuredOutput,
      provider: (descriptor?.family ?? "unknown") as AgentProvider,
      model,
      sessionId,
      inputTokens,
      outputTokens,
      durationMs
    };
  };

  const executeViaUnifiedPath = async (args: ExecuteAiTaskArgs): Promise<ExecuteAiTaskResult> => {
    const modelId = args.model;
    if (!modelId) throw new Error("model is required for unified execution path");

    const hasFullRunContext = args.projectId && args.runId && args.stepId && args.attemptId;

    return consumeEventStream(
      executeUnified({
        modelId,
        prompt: args.prompt,
        system: args.systemPrompt,
        cwd: args.cwd,
        tools: resolveUnifiedToolMode({
          feature: args.feature,
          taskType: args.taskType,
          permissionMode: args.permissionMode,
        }),
        timeout: args.timeoutMs,
        jsonSchema: args.jsonSchema,
        reasoningEffort: args.reasoningEffort,
        projectId: args.projectId,
        runId: args.runId,
        stepId: args.stepId,
        attemptId: args.attemptId,
        ...(hasFullRunContext ? { db, enableCompaction: true } : {}),
        ...(args.memoryService ? { memoryService: args.memoryService } : {}),
        ...(args.memoryService && args.runId
          ? { addSharedFact: args.memoryService.addSharedFact.bind(args.memoryService) }
          : {}),
      }),
      args.feature,
      modelId,
    );
  };

  const executeTask = async (args: ExecuteAiTaskArgs): Promise<ExecuteAiTaskResult> => {
    const requestId = randomUUID();
    if (getMode() === "guest") {
      logger.warn("ai.task.skipped_guest_mode", {
        requestId,
        taskType: args.taskType,
        feature: args.feature
      });
      throw new Error("No AI provider is available. Install and authenticate Claude Code and/or Codex CLI.");
    }

    if (!getFeatureFlag(args.feature)) {
      logger.warn("ai.task.skipped_feature_disabled", {
        requestId,
        taskType: args.taskType,
        feature: args.feature
      });
      throw new Error(`AI feature '${args.feature}' is disabled in settings.`);
    }

    checkBudget(args.feature);
    const requestedModel = toStringOrNull(args.model);
    const explicitDescriptor = requestedModel
      ? (getModelById(requestedModel) ?? resolveModelAlias(requestedModel))
      : null;
    if (requestedModel && !explicitDescriptor) {
      throw new Error(`Unknown model '${requestedModel}'.`);
    }

    const resolvedModelId = explicitDescriptor?.id ?? await resolveModelForTask(args.taskType, requestedModel ?? undefined);
    logger.info("ai.task.begin", {
      requestId,
      taskType: args.taskType,
      feature: args.feature,
      model: resolvedModelId,
      timeoutMs: args.timeoutMs ?? null,
      permissionMode: args.permissionMode ?? null,
      hasJsonSchema: args.jsonSchema != null,
      promptChars: args.prompt.length,
      promptPreview: toTextPreview(args.prompt),
    });

    try {
      const result = await executeViaUnifiedPath({
        ...args,
        model: resolvedModelId,
      });
      logger.info("ai.task.done", {
        requestId,
        taskType: args.taskType,
        feature: args.feature,
        provider: result.provider,
        model: result.model,
        sessionId: result.sessionId,
        durationMs: result.durationMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        textChars: result.text.length,
        textPreview: toTextPreview(result.text),
        structuredOutputPreview: toJsonPreview(result.structuredOutput),
      });
      return result;
    } catch (error) {
      logger.warn("ai.task.failed", {
        requestId,
        taskType: args.taskType,
        feature: args.feature,
        model: resolvedModelId,
        promptChars: args.prompt.length,
        promptPreview: toTextPreview(args.prompt),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const MODEL_LIST_CACHE_TTL_MS = 120_000; // 2 minutes
  const modelListCache = new Map<string, { models: AgentModelDescriptor[]; cachedAt: number }>();

  const listModels = async (provider: AgentProvider): Promise<AgentModelDescriptor[]> => {
    const now = Date.now();
    const cached = modelListCache.get(provider);
    if (cached && now - cached.cachedAt < MODEL_LIST_CACHE_TTL_MS) {
      return cached.models;
    }

    const auth = await detectAuth();
    const available = getAvailableModels(auth);
    const family = provider === "codex" ? "openai" : "anthropic";
    const models = available
      .filter((descriptor) => descriptor.family === family)
      .map((descriptor) => ({
        id: descriptor.id,
        label: descriptor.displayName,
        description: `${descriptor.family}${descriptor.isCliWrapped ? " (CLI)" : " (API/local)"}`,
      }));

    if (models.length > 0) {
      modelListCache.set(provider, { models, cachedAt: now });
      return models;
    }

    const fallback = provider === "codex"
      ? CODEX_FALLBACK_MODELS
      : listModelDescriptorsForProvider("claude")
          .map((descriptor) => ({ id: descriptor.id, label: descriptor.displayName }));
    modelListCache.set(provider, { models: fallback, cachedAt: now });
    return fallback;
  };

  const STATUS_CACHE_TTL_MS = 30_000; // 30 seconds
  let statusCache: { result: AiIntegrationStatus; cachedAt: number } | null = null;

  return {
    getMode,

    getStatus: async (): Promise<AiIntegrationStatus> => {
      const now = Date.now();
      if (statusCache && now - statusCache.cachedAt < STATUS_CACHE_TTL_MS) {
        return statusCache.result;
      }
      const auth = await detectAuth();
      const available = getAvailableModels(auth);
      // detectAuth -> detectAllAuth already called detectCliAuthStatuses() and
      // populated the cache, so this reads instantly from cache:
      const cliStatuses = getCachedCliAuthStatuses();
      const availability = toCliAvailability(auth);
      const result: AiIntegrationStatus = {
        mode: getMode(),
        availableProviders: availability,
        models: {
          claude: availability.claude ? await listModels("claude") : [],
          codex: availability.codex ? await listModels("codex") : CODEX_FALLBACK_MODELS
        },
        detectedAuth: redactDetectedAuth(auth, cliStatuses),
        availableModelIds: available.map((descriptor) => descriptor.id),
      };
      statusCache = { result, cachedAt: Date.now() };
      return result;
    },

    executeTask,

    listModels,

    getFeatureFlag,

    getDailyUsage(feature: AiFeatureKey): number {
      return countDailyUsage(feature);
    },

    getDailyUsageBatch(features: AiFeatureKey[]): Map<AiFeatureKey, number> {
      return countDailyUsageBatch(features);
    },

    getDailyBudgetLimit,

    getAvailability: getAvailabilitySync,
    verifyApiKeyConnection,

    // New unified methods
    getAvailabilityAsync,
    resolveModelForTask,
    executeViaUnified: executeViaUnifiedPath,

    // Backward-compatible convenience methods used by migrated services.
    async generateNarrative(args: {
      laneId: string;
      cwd: string;
      prompt: string;
      timeoutMs?: number;
      model?: string;
    }): Promise<ExecuteAiTaskResult> {
      return await executeTask({
        feature: "narratives",
        taskType: "narrative",
        prompt: args.prompt,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
        model: args.model,
        permissionMode: "read-only",
        oneShot: true
      });
    },

    async requestConflictProposal(args: {
      laneId: string;
      cwd: string;
      prompt: string;
      timeoutMs?: number;
      model?: string;
      jsonSchema?: unknown;
    }): Promise<ExecuteAiTaskResult> {
      return await executeTask({
        feature: "conflict_proposals",
        taskType: "conflict_resolution",
        prompt: args.prompt,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
        model: args.model,
        jsonSchema: args.jsonSchema,
        permissionMode: "read-only",
        oneShot: true
      });
    },

    async draftPrDescription(args: {
      laneId: string;
      cwd: string;
      prompt: string;
      timeoutMs?: number;
      model?: string;
    }): Promise<ExecuteAiTaskResult> {
      return await executeTask({
        feature: "pr_descriptions",
        taskType: "pr_description",
        prompt: args.prompt,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
        model: args.model,
        permissionMode: "read-only",
        oneShot: true
      });
    },

    async summarizeTerminal(args: {
      cwd: string;
      prompt: string;
      timeoutMs?: number;
      model?: string;
      jsonSchema?: unknown;
    }): Promise<ExecuteAiTaskResult> {
      return await executeTask({
        feature: "terminal_summaries",
        taskType: "terminal_summary",
        prompt: args.prompt,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
        model: args.model,
        jsonSchema: args.jsonSchema,
        permissionMode: "read-only",
        oneShot: true
      });
    },

    async generateInitialContext(args: {
      cwd: string;
      prompt: string;
      timeoutMs?: number;
      model?: string;
      provider?: AgentProvider;
      reasoningEffort?: string | null;
      jsonSchema?: unknown;
    }): Promise<ExecuteAiTaskResult> {
      return await executeTask({
        feature: "initial_context",
        taskType: "initial_context",
        prompt: args.prompt,
        cwd: args.cwd,
        provider: args.provider,
        timeoutMs: args.timeoutMs,
        model: args.model,
        ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
        jsonSchema: args.jsonSchema,
        permissionMode: "read-only",
        oneShot: true
      });
    },

    async resumeTask(args: {
      previousAttemptId: string;
      feature: AiFeatureKey;
      taskType: AiTaskType;
      prompt: string;
      cwd: string;
      model?: string;
      timeoutMs?: number;
      projectId?: string;
      attemptId?: string;
      runId?: string;
      stepId?: string;
    }): Promise<ExecuteAiTaskResult> {
      const modelId = await resolveModelForTask(args.taskType, args.model);

      return consumeEventStream(
        resumeUnified({
          modelId,
          prompt: args.prompt,
          cwd: args.cwd,
          timeout: args.timeoutMs,
          tools: "coding",
          previousAttemptId: args.previousAttemptId,
          db,
          projectId: args.projectId,
          attemptId: args.attemptId,
          runId: args.runId,
          stepId: args.stepId,
          enableCompaction: true,
        }),
        args.feature,
        modelId,
      );
    }
  };
}
