import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { AgentModelDescriptor, AgentProvider, ExecutorOpts } from "./agentExecutor";
import type {
  AiApiKeyVerificationResult,
  AiLocalProviderConfigs,
  AiProviderConnections,
  AiRuntimeConnections,
  AiRuntimeConnectionStatus,
} from "../../../shared/types";
import {
  decodeOpenCodeRegistryId,
  getDefaultModelDescriptor,
  getModelById,
  getAvailableModels,
  getLocalProviderDefaultEndpoint,
  isLocalProviderFamily,
  listModelDescriptorsForProvider,
  LOCAL_PROVIDER_LABELS,
  replaceDynamicOpenCodeModelDescriptors,
  resolveModelAlias,
  enrichModelRegistry,
  resolveProviderGroupForModel,
  type LocalProviderFamily,
} from "../../../shared/modelRegistry";
import {
  detectAllAuth,
  getCachedCliAuthStatuses,
  resetLocalProviderDetectionCache,
  verifyProviderApiKey,
  type DetectedAuth,
  type CliAuthStatus,
} from "./authDetector";
import {
  clearOpenCodeInventoryCache,
  peekOpenCodeInventoryCache,
  probeOpenCodeProviderInventory,
} from "../opencode/openCodeInventory";
import { resolveOpenCodeExecutablePath, type DiscoveredLocalModelEntry } from "../opencode/openCodeRuntime";
import { resolveOpenCodeBinary, type OpenCodeBinarySource } from "../opencode/openCodeBinaryManager";
import { initialize as initModelsDevService } from "./modelsDevService";
import { updateModelPricing } from "../../../shared/modelProfiles";
import { isRecord } from "../shared/utils";
import { parseStructuredOutput } from "./utils";
import { getApiKeyStoreStatus } from "./apiKeyStore";
import type { createMemoryService } from "../memory/memoryService";
import type { CompactionFlushService } from "../memory/compactionFlushService";
import { inspectLocalProvider } from "./localModelDiscovery";
import { discoverCursorCliModelDescriptors, clearCursorCliModelsCache } from "../chat/cursorModelsDiscovery";
import { resolveCursorAgentExecutable } from "./cursorAgentExecutable";
import { buildProviderConnections } from "./providerConnectionStatus";
import { getProviderRuntimeHealthVersion, resetProviderRuntimeHealth } from "./providerRuntimeHealth";
import { probeClaudeRuntimeHealth, resetClaudeRuntimeProbeCache } from "./claudeRuntimeProbe";
import { runProviderTask } from "./providerTaskRunner";

export type AiTaskType =
  | "planning"
  | "implementation"
  | "review"
  | "conflict_resolution"
  | "commit_message"
  | "memory_consolidation"
  | "narrative"
  | "pr_description"
  | "terminal_summary"
  | "mission_planning"
  | "initial_context";

export type AiFeatureKey =
  | "narratives"
  | "conflict_proposals"
  | "commit_messages"
  | "pr_descriptions"
  | "terminal_summaries"
  | "memory_consolidation"
  | "mission_planning"
  | "orchestrator"
  | "initial_context";

export type AiProviderMode = "guest" | "subscription";

export type AiIntegrationStatus = {
  mode: AiProviderMode;
  availableProviders: {
    claude: boolean;
    codex: boolean;
    cursor: boolean;
  };
  models: {
    claude: AgentModelDescriptor[];
    codex: AgentModelDescriptor[];
    cursor: AgentModelDescriptor[];
  };
  detectedAuth?: Array<{
    type: "cli-subscription" | "api-key" | "openrouter" | "local";
    cli?: "claude" | "codex" | "cursor";
    provider?: string;
    source?: "config" | "env" | "store";
    endpointSource?: "auto" | "config";
    path?: string;
    endpoint?: string;
    preferredModelId?: string | null;
    authenticated?: boolean;
    verified?: boolean;
  }>;
  providerConnections?: AiProviderConnections;
  runtimeConnections?: AiRuntimeConnections;
  availableModelIds?: string[];
  /** True when the `opencode` CLI is on PATH (ADE still spawns the OpenCode server via the SDK). */
  opencodeBinaryInstalled?: boolean;
  /** Where the resolved `opencode` binary came from ("user-installed", "bundled", or "missing"). */
  opencodeBinarySource?: OpenCodeBinarySource;
  /** Last inventory probe error, if any (empty models when set after a failed probe). */
  opencodeInventoryError?: string | null;
  /** All providers reported by OpenCode's provider.list() — used to dynamically populate the settings UI and model picker. */
  opencodeProviders?: Array<{ id: string; name: string; connected: boolean; modelCount: number }>;
  apiKeyStore?: {
    secureStorageAvailable: boolean;
    legacyPlaintextDetected: boolean;
    decryptionFailed: boolean;
    encryptedStorePath?: string | null;
    legacyPlaintextPath?: string | null;
  };
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

const DEFAULT_AI_FEATURE_FLAGS: Record<AiFeatureKey, boolean> = {
  narratives: true,
  conflict_proposals: true,
  commit_messages: false,
  pr_descriptions: true,
  terminal_summaries: true,
  memory_consolidation: true,
  mission_planning: true,
  orchestrator: true,
  initial_context: true,
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
  commit_message: {
    modelId: "anthropic/claude-haiku-4-5",
    timeoutMs: 20_000
  },
  memory_consolidation: {
    modelId: "anthropic/claude-haiku-4-5",
    timeoutMs: 45_000
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
    timeoutMs: 120_000
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

function extractConfiguredLocalProviders(
  snapshot: ReturnType<ReturnType<typeof createProjectConfigService>["get"]>,
): AiLocalProviderConfigs {
  const aiConfig = extractAiConfig(snapshot);
  const localProvidersRaw = isRecord(aiConfig.localProviders) ? aiConfig.localProviders : {};
  const out: AiLocalProviderConfigs = {};

  for (const provider of ["ollama", "lmstudio"] as const) {
    const raw = isRecord(localProvidersRaw[provider]) ? localProvidersRaw[provider] : null;
    if (!raw) continue;
    const entry: NonNullable<AiLocalProviderConfigs[typeof provider]> = {};
    if (typeof raw.enabled === "boolean") entry.enabled = raw.enabled;
    if (typeof raw.autoDetect === "boolean") entry.autoDetect = raw.autoDetect;
    if (typeof raw.endpoint === "string" && raw.endpoint.trim().length > 0) {
      entry.endpoint = raw.endpoint.trim();
    }
    if (raw.preferredModelId === null) {
      entry.preferredModelId = null;
    } else if (typeof raw.preferredModelId === "string" && raw.preferredModelId.trim().length > 0) {
      entry.preferredModelId = raw.preferredModelId.trim();
    }
    if (Object.keys(entry).length) out[provider] = entry;
  }

  return out;
}

function toCliAvailability(auth: DetectedAuth[]): { claude: boolean; codex: boolean; cursor: boolean } {
  return {
    claude: auth.some((entry) => entry.type === "cli-subscription" && entry.cli === "claude"),
    codex: auth.some((entry) => entry.type === "cli-subscription" && entry.cli === "codex"),
    cursor: auth.some((entry) => entry.type === "cli-subscription" && entry.cli === "cursor"),
  };
}

function hasUsableDetectedAuth(auth: DetectedAuth[]): boolean {
  return auth.some((entry) => {
    if (entry.type === "cli-subscription") {
      return entry.authenticated || !entry.verified;
    }
    return true;
  });
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
      endpointSource: entry.endpointSource,
      preferredModelId: entry.preferredModelId ?? null,
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

function apiProviderLabel(provider: string): string {
  const labels: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google AI",
    mistral: "Mistral",
    deepseek: "DeepSeek",
    xai: "xAI",
    groq: "Groq",
    together: "Together AI",
    openrouter: "OpenRouter",
    ollama: "Ollama",
    lmstudio: "LM Studio",
  };
  return labels[provider] ?? provider;
}

function toCliRuntimeConnection(status: NonNullable<AiProviderConnections>[keyof AiProviderConnections]): AiRuntimeConnectionStatus {
  const source = status.sources.find((entry) => entry.detected && entry.kind === "local-credentials")?.source;
  return {
    provider: status.provider,
    label: apiProviderLabel(status.provider),
    kind: "cli",
    configured: status.authAvailable || status.runtimeDetected,
    authAvailable: status.authAvailable,
    runtimeDetected: status.runtimeDetected,
    runtimeAvailable: status.runtimeAvailable,
    health: status.runtimeAvailable ? "ready" : status.runtimeDetected ? "reachable" : "not_configured",
    ...(source ? { source: source === "cursor-env" ? "env" : "store" as const } : {}),
    path: status.path,
    blocker: status.blocker,
    lastCheckedAt: status.lastCheckedAt,
  };
}

function normalizeConfiguredLocalProvider(
  configs: AiLocalProviderConfigs,
  provider: LocalProviderFamily,
): {
  enabled: boolean;
  endpoint?: string;
  autoDetect: boolean;
  preferredModelId?: string | null;
} {
  const entry = configs[provider];
  return {
    enabled: entry?.enabled ?? true,
    ...(typeof entry?.endpoint === "string" && entry.endpoint.trim().length
      ? { endpoint: entry.endpoint.trim() }
      : {}),
    autoDetect: entry?.autoDetect ?? true,
    preferredModelId: entry?.preferredModelId ?? null,
  };
}

function createLocalRuntimeConnectionFromInspection(args: {
  provider: LocalProviderFamily;
  endpoint: string;
  source: "config" | "auto";
  inspection: Awaited<ReturnType<typeof inspectLocalProvider>>;
  checkedAt: string;
}): AiRuntimeConnectionStatus {
  const label = LOCAL_PROVIDER_LABELS[args.provider];
  const loadedModelIds = args.inspection.loadedModels
    .filter((model) => model.loaded !== false)
    .map((model) => `${args.provider}/${model.modelId}`);
  let blocker: string | null = null;
  if (args.inspection.health === "reachable_no_models") {
    blocker = `${label} is reachable, but no models are currently loaded.`;
  } else if (args.inspection.health === "unreachable") {
    blocker = `${label} did not respond at ${args.endpoint}.`;
  }
  return {
    provider: args.provider,
    label,
    kind: "local",
    configured: true,
    authAvailable: args.inspection.health === "ready",
    runtimeDetected: args.inspection.reachable,
    runtimeAvailable: args.inspection.health === "ready",
    health: args.inspection.health,
    source: args.source,
    endpoint: args.endpoint,
    blocker,
    ...(loadedModelIds.length ? { loadedModelIds } : {}),
    lastCheckedAt: args.checkedAt,
  };
}

async function buildLocalRuntimeConnection(args: {
  provider: LocalProviderFamily;
  configuredLocalProviders: AiLocalProviderConfigs;
  auth: DetectedAuth[];
  checkedAt: string;
}): Promise<AiRuntimeConnectionStatus> {
  const providerConfig = normalizeConfiguredLocalProvider(args.configuredLocalProviders, args.provider);
  const label = LOCAL_PROVIDER_LABELS[args.provider];
  if (!providerConfig.enabled) {
    return {
      provider: args.provider,
      label,
      kind: "local",
      configured: false,
      authAvailable: false,
      runtimeDetected: false,
      runtimeAvailable: false,
      health: "not_configured",
      blocker: `${label} is disabled in project AI settings.`,
      lastCheckedAt: args.checkedAt,
    };
  }

  const detected = args.auth.find(
    (entry): entry is Extract<DetectedAuth, { type: "local" }> =>
      entry.type === "local" && entry.provider === args.provider,
  );
  if (detected) {
    const inspection = await inspectLocalProvider(args.provider, detected.endpoint);
    return createLocalRuntimeConnectionFromInspection({
      provider: args.provider,
      endpoint: detected.endpoint,
      source: detected.endpointSource === "config" ? "config" : "auto",
      inspection,
      checkedAt: args.checkedAt,
    });
  }

  const configuredEndpoint = providerConfig.endpoint;
  if (configuredEndpoint) {
    const manualInspection = await inspectLocalProvider(args.provider, configuredEndpoint);
    if (manualInspection.reachable || !providerConfig.autoDetect) {
      const status = createLocalRuntimeConnectionFromInspection({
        provider: args.provider,
        endpoint: configuredEndpoint,
        source: "config",
        inspection: manualInspection,
        checkedAt: args.checkedAt,
      });
      if (!manualInspection.reachable && !providerConfig.autoDetect) {
        status.health = "unreachable";
      }
      return status;
    }
  }

  if (providerConfig.autoDetect) {
    const autoEndpoint = getLocalProviderDefaultEndpoint(args.provider);
    if (!configuredEndpoint || autoEndpoint.replace(/\/+$/, "") !== configuredEndpoint.replace(/\/+$/, "")) {
      const autoInspection = await inspectLocalProvider(args.provider, autoEndpoint);
      if (autoInspection.reachable) {
        return createLocalRuntimeConnectionFromInspection({
          provider: args.provider,
          endpoint: autoEndpoint,
          source: "auto",
          inspection: autoInspection,
          checkedAt: args.checkedAt,
        });
      }
    }

    const fallbackEndpoint = configuredEndpoint ?? autoEndpoint;
    const fallbackSource = configuredEndpoint ? "config" : "auto";
    const blocker = configuredEndpoint
      ? `${label} is configured for ${configuredEndpoint}, but the runtime did not respond.`
      : `${label} did not respond at ${autoEndpoint}.`;

    return {
      provider: args.provider,
      label,
      kind: "local",
      configured: true,
      authAvailable: false,
      runtimeDetected: false,
      runtimeAvailable: false,
      health: "unreachable",
      source: fallbackSource,
      endpoint: fallbackEndpoint,
      blocker,
      lastCheckedAt: args.checkedAt,
    };
  }

  return {
    provider: args.provider,
    label,
    kind: "local",
    configured: false,
    authAvailable: false,
    runtimeDetected: false,
    runtimeAvailable: false,
    health: "not_configured",
    blocker: `No ${label} runtime with loaded models was detected.`,
    lastCheckedAt: args.checkedAt,
  };
}

async function buildRuntimeConnections(args: {
  configuredLocalProviders: AiLocalProviderConfigs;
  auth: DetectedAuth[];
  providerConnections: AiProviderConnections;
}): Promise<AiRuntimeConnections> {
  const checkedAt = new Date().toISOString();
  const runtimeConnections: AiRuntimeConnections = {
    claude: toCliRuntimeConnection(args.providerConnections.claude),
    codex: toCliRuntimeConnection(args.providerConnections.codex),
    cursor: toCliRuntimeConnection(args.providerConnections.cursor),
  };

  for (const authEntry of args.auth) {
    if (authEntry.type === "api-key") {
      runtimeConnections[authEntry.provider] = {
        provider: authEntry.provider,
        label: apiProviderLabel(authEntry.provider),
        kind: "api-key",
        configured: true,
        authAvailable: true,
        runtimeDetected: true,
        runtimeAvailable: true,
        health: "ready",
        source: authEntry.source,
        blocker: null,
        lastCheckedAt: checkedAt,
      };
      continue;
    }
    if (authEntry.type === "openrouter") {
      runtimeConnections.openrouter = {
        provider: "openrouter",
        label: "OpenRouter",
        kind: "openrouter",
        configured: true,
        authAvailable: true,
        runtimeDetected: true,
        runtimeAvailable: true,
        health: "ready",
        source: authEntry.source,
        blocker: null,
        lastCheckedAt: checkedAt,
      };
    }
  }

  for (const provider of ["ollama", "lmstudio"] as const) {
    runtimeConnections[provider] = await buildLocalRuntimeConnection({
      provider,
      configuredLocalProviders: args.configuredLocalProviders,
      auth: args.auth,
      checkedAt,
    });
  }

  return runtimeConnections;
}

const LOCAL_FAMILIES = new Set<string>(["ollama", "lmstudio"]);

function extractDiscoveredLocalModels(connections: AiRuntimeConnections): DiscoveredLocalModelEntry[] {
  const entries: DiscoveredLocalModelEntry[] = [];
  for (const [provider, conn] of Object.entries(connections)) {
    if (!LOCAL_FAMILIES.has(provider) || !conn.loadedModelIds?.length) continue;
    for (const fullId of conn.loadedModelIds) {
      const slash = fullId.indexOf("/");
      const modelId = slash > 0 ? fullId.slice(slash + 1) : fullId;
      entries.push({ provider: provider as LocalProviderFamily, modelId });
    }
  }
  return entries;
}

export function createAiIntegrationService(args: {
  db: AdeDb;
  logger: Logger;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  projectRoot: string;
}) {
  const { db, logger, projectConfigService, projectRoot } = args;
  let compactionFlushService: CompactionFlushService | null = null;

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

  const detectAuth = async (options?: { force?: boolean }): Promise<DetectedAuth[]> => {
    const snapshot = projectConfigService.get();
    return await detectAllAuth(extractConfiguredApiKeys(snapshot), {
      ...options,
      localProviders: extractConfiguredLocalProviders(snapshot),
    });
  };

  const deriveMode = (args: {
    snapshot: ReturnType<ReturnType<typeof createProjectConfigService>["get"]>;
    auth?: DetectedAuth[];
    providerConnections?: AiProviderConnections;
  }): AiProviderMode => {
    if (args.snapshot.effective.providerMode === "subscription") {
      return "subscription";
    }
    if (
      args.providerConnections
      && (args.providerConnections.claude.authAvailable
        || args.providerConnections.codex.authAvailable
        || args.providerConnections.cursor.authAvailable)
    ) {
      return "subscription";
    }
    if (args.auth && hasUsableDetectedAuth(args.auth)) {
      return "subscription";
    }
    if (Object.keys(extractConfiguredApiKeys(args.snapshot)).length > 0) {
      return "subscription";
    }
    const cachedCli = getCachedCliAuthStatuses();
    if (cachedCli.some((entry) => entry.installed && (entry.authenticated || !entry.verified))) {
      return "subscription";
    }
    return "guest";
  };

  const getAvailabilitySync = () => {
    const statuses = getCachedCliAuthStatuses();
    const claude = statuses.find((entry) => entry.cli === "claude");
    const codex = statuses.find((entry) => entry.cli === "codex");
    const cursor = statuses.find((entry) => entry.cli === "cursor");
    return {
      claude: Boolean(claude?.installed && (claude.authenticated || !claude.verified)),
      codex: Boolean(codex?.installed && (codex.authenticated || !codex.verified)),
      cursor: Boolean(cursor?.installed && (cursor.authenticated || !cursor.verified)),
    };
  };

  const getAvailabilityAsync = async () => {
    const auth = await detectAuth();
    const availability = toCliAvailability(auth);
    return {
      ...availability,
      detectedAuth: auth,
      availableModels: await getResolvedAvailableModels(auth),
    };
  };

  const getResolvedAvailableModels = async (auth: DetectedAuth[]) => {
    // Local model discovery is handled by OpenCode via probeOpenCodeProviderInventory
    // which populates dynamic OpenCode descriptors (including local providers).

    let available = getAvailableModels(auth);

    const hasCursorCliAuth = auth.some(
      (entry) =>
        entry.type === "cli-subscription"
        && entry.cli === "cursor"
        && entry.authenticated !== false,
    );
    if (hasCursorCliAuth) {
      try {
        const { path: agentPath } = resolveCursorAgentExecutable();
        const cursorModels = await discoverCursorCliModelDescriptors(agentPath);
        available = [
          ...available.filter((descriptor) => !(descriptor.family === "cursor" && descriptor.isCliWrapped)),
          ...cursorModels,
        ];
      } catch {
        // Cursor CLI missing or `agent models` failed — omit dynamic Cursor list
      }
    }

    return available;
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
    return deriveMode({ snapshot });
  };

  const getFeatureFlag = (feature: AiFeatureKey): boolean => {
    const snapshot = projectConfigService.get();
    const aiConfig = extractAiConfig(snapshot);
    const features = isRecord(aiConfig.features) ? aiConfig.features : {};
    const value = features[feature];
    return value == null ? DEFAULT_AI_FEATURE_FLAGS[feature] : Boolean(value);
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

  const resolveModelForTask = async (
    taskType: AiTaskType,
    modelIdHint?: string,
    authHint?: DetectedAuth[],
  ): Promise<string> => {
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
    const auth = authHint ?? await detectAuth();
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

  const executeProviderTaskPath = async (
    args: ExecuteAiTaskArgs,
    auth?: DetectedAuth[],
  ): Promise<ExecuteAiTaskResult> => {
    const modelId = args.model;
    if (!modelId) throw new Error("model is required for provider task execution");
    const descriptor = getModelById(modelId) ?? resolveModelAlias(modelId);
    if (!descriptor) {
      throw new Error(`Unknown model '${modelId}'.`);
    }

    const start = Date.now();
    const result = await runProviderTask({
      cwd: args.cwd,
      descriptor,
      auth,
      prompt: args.prompt,
      system: args.systemPrompt,
      timeoutMs: args.timeoutMs,
      jsonSchema: args.jsonSchema,
      permissionMode: args.permissionMode,
      feature: args.feature,
      sessionId: args.sessionId,
      projectConfig: projectConfigService.get().effective,
    });
    const durationMs = Date.now() - start;
    const provider = resolveProviderGroupForModel(descriptor) as AgentProvider;
    const structuredOutput = result.structuredOutput ?? (args.jsonSchema ? parseStructuredOutput(result.text) : null);
    const inputTokens = result.inputTokens ?? null;
    const outputTokens = result.outputTokens ?? null;
    logUsage({
      feature: args.feature,
      provider,
      model: descriptor.id,
      inputTokens,
      outputTokens,
      durationMs,
      success: true,
      sessionId: result.sessionId,
    });
    return {
      text: result.text,
      structuredOutput,
      provider,
      model: descriptor.id,
      sessionId: result.sessionId,
      inputTokens,
      outputTokens,
      durationMs,
    };
  };

  const executeTask = async (args: ExecuteAiTaskArgs): Promise<ExecuteAiTaskResult> => {
    const requestId = randomUUID();
    const auth = await detectAuth();
    const snapshot = projectConfigService.get();
    const mode = deriveMode({ snapshot, auth });
    if (mode === "guest") {
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

    const resolvedModelId = explicitDescriptor?.id ?? await resolveModelForTask(args.taskType, requestedModel ?? undefined, auth);
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
      const result = await executeProviderTaskPath({
        ...args,
        model: resolvedModelId,
      }, auth);
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
    const available = await getResolvedAvailableModels(auth);
    let family: string;
    if (provider === "codex") {
      family = "openai";
    } else if (provider === "cursor") {
      family = "cursor";
    } else {
      family = "anthropic";
    }
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
      : listModelDescriptorsForProvider(provider)
          .map((descriptor) => ({ id: descriptor.id, label: descriptor.displayName }));
    modelListCache.set(provider, { models: fallback, cachedAt: now });
    return fallback;
  };

  const STATUS_CACHE_TTL_MS = 30_000; // 30 seconds
  let statusCache: { result: AiIntegrationStatus; cachedAt: number; runtimeHealthVersion: number } | null = null;

  const executeReadOnlyOneShotTask = async (args: {
    feature: AiFeatureKey;
    taskType: AiTaskType;
    cwd: string;
    prompt: string;
    timeoutMs?: number;
    model?: string;
    jsonSchema?: unknown;
    reasoningEffort?: string | null;
  }): Promise<ExecuteAiTaskResult> => {
    return await executeTask({
      feature: args.feature,
      taskType: args.taskType,
      prompt: args.prompt,
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
      model: args.model,
      ...(args.jsonSchema ? { jsonSchema: args.jsonSchema } : {}),
      ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
      permissionMode: "read-only",
      oneShot: true
    });
  };

  return {
    getMode,

    getStatus: async (options?: { force?: boolean; refreshOpenCodeInventory?: boolean }): Promise<AiIntegrationStatus> => {
      const now = Date.now();
      let runtimeHealthVersion = getProviderRuntimeHealthVersion();
      if (
        !options?.force
        && options?.refreshOpenCodeInventory !== true
        && statusCache
        && statusCache.runtimeHealthVersion === runtimeHealthVersion
        && now - statusCache.cachedAt < STATUS_CACHE_TTL_MS
      ) {
        return statusCache.result;
      }
      if (options?.force) {
        resetProviderRuntimeHealth();
        resetClaudeRuntimeProbeCache();
        resetLocalProviderDetectionCache();
        clearCursorCliModelsCache();
        modelListCache.clear();
        runtimeHealthVersion = getProviderRuntimeHealthVersion();
      }
      const auth = await detectAuth(options);
      const available = await getResolvedAvailableModels(auth);
      // detectAuth -> detectAllAuth already called detectCliAuthStatuses() and
      // populated the cache, so this reads instantly from cache:
      const cliStatuses = getCachedCliAuthStatuses();
      const claudeCli = cliStatuses.find((entry) => entry.cli === "claude");
      if (claudeCli?.installed && options?.force) {
        await probeClaudeRuntimeHealth({
          projectRoot,
          logger,
          force: true,
        });
        runtimeHealthVersion = getProviderRuntimeHealthVersion();
      }
      const providerConnections = await buildProviderConnections(cliStatuses);
      const configuredLocalProviders = extractConfiguredLocalProviders(projectConfigService.get());
      const runtimeConnections = await buildRuntimeConnections({
        configuredLocalProviders,
        auth,
        providerConnections,
      });
      const availability = {
        claude: providerConnections.claude.runtimeAvailable,
        codex: providerConnections.codex.runtimeAvailable,
        cursor: providerConnections.cursor.runtimeAvailable,
      };
      const runtimeFilteredAvailable = available.filter((descriptor) => {
        if (!descriptor.isCliWrapped) return true;
        if (descriptor.family === "anthropic") return providerConnections.claude.runtimeAvailable;
        if (descriptor.family === "openai") return providerConnections.codex.runtimeAvailable;
        if (descriptor.family === "cursor") return providerConnections.cursor.runtimeAvailable;
        return true;
      });

      const opencodeBinaryInfo = resolveOpenCodeBinary();
      const opencodeBinaryInstalled = Boolean(opencodeBinaryInfo.path);
      const opencodeBinarySource = opencodeBinaryInfo.source;
      let opencodeInventoryError: string | null = null;
      let opencodeModelIds: string[] = [];
      let opencodeProviders: AiIntegrationStatus["opencodeProviders"] = [];
      const effectiveConfig = projectConfigService.get().effective;
      // Extract discovered local models from runtime connections so we can
      // inject them into the OpenCode provider config.  This bridges ADE's
      // local model discovery (LM Studio /v1/models, Ollama /api/tags, etc.)
      // with OpenCode's static provider model list.
      const discoveredLocalModels = extractDiscoveredLocalModels(runtimeConnections);
      if (!opencodeBinaryInstalled) {
        clearOpenCodeInventoryCache();
        replaceDynamicOpenCodeModelDescriptors([]);
      } else if (options?.refreshOpenCodeInventory === true) {
        const probed = await probeOpenCodeProviderInventory({
          projectRoot,
          projectConfig: effectiveConfig,
          logger,
          force: true,
          discoveredLocalModels,
        });
        opencodeInventoryError = probed.error;
        opencodeModelIds = probed.modelIds;
        opencodeProviders = probed.providers;
      } else {
        const peeked = peekOpenCodeInventoryCache({
          projectRoot,
          projectConfig: effectiveConfig,
        });
        if (peeked) {
          opencodeInventoryError = peeked.error;
          opencodeModelIds = peeked.modelIds;
          opencodeProviders = peeked.providers;
        } else {
          // No cache yet — auto-probe on first getStatus so free/connected models appear immediately.
          const probed = await probeOpenCodeProviderInventory({
            projectRoot,
            projectConfig: effectiveConfig,
            logger,
            discoveredLocalModels,
          });
          opencodeInventoryError = probed.error;
          opencodeModelIds = probed.modelIds;
          opencodeProviders = probed.providers;
        }
      }

      // When OpenCode inventory has models for a local provider, remove the
      // duplicate ADE-discovered entries (e.g. "lmstudio/qwen3.5-9b") to avoid
      // showing the same model twice with different display names.
      const opencodeLocalModelIds = new Set<string>();
      for (const ocId of opencodeModelIds) {
        const decoded = decodeOpenCodeRegistryId(ocId);
        if (decoded && isLocalProviderFamily(decoded.openCodeProviderId)) {
          opencodeLocalModelIds.add(`${decoded.openCodeProviderId}/${decoded.openCodeModelId}`);
        }
      }
      const baseAvailableIds = runtimeFilteredAvailable
        .map((descriptor) => descriptor.id)
        .filter((id) => !opencodeLocalModelIds.has(id));
      const mergedAvailableIds = [...new Set([...baseAvailableIds, ...opencodeModelIds])];

      const result: AiIntegrationStatus = {
        mode: deriveMode({ snapshot: projectConfigService.get(), auth, providerConnections }),
        availableProviders: availability,
        models: {
          claude: availability.claude ? await listModels("claude") : [],
          codex: availability.codex ? await listModels("codex") : [],
          cursor: availability.cursor ? await listModels("cursor") : [],
        },
        detectedAuth: redactDetectedAuth(auth, cliStatuses),
        providerConnections,
        runtimeConnections,
        availableModelIds: mergedAvailableIds,
        opencodeBinaryInstalled,
        opencodeBinarySource,
        opencodeInventoryError,
        opencodeProviders,
        apiKeyStore: getApiKeyStoreStatus(),
      };
      statusCache = { result, cachedAt: Date.now(), runtimeHealthVersion };
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

    getAvailabilityAsync,
    resolveModelForTask,
    setCompactionFlushService(service: CompactionFlushService | null) {
      compactionFlushService = service;
    },

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
      return await executeReadOnlyOneShotTask({
        feature: "conflict_proposals",
        taskType: "conflict_resolution",
        cwd: args.cwd,
        prompt: args.prompt,
        timeoutMs: args.timeoutMs,
        model: args.model,
        jsonSchema: args.jsonSchema
      });
    },

    async draftPrDescription(args: {
      laneId: string;
      cwd: string;
      prompt: string;
      timeoutMs?: number;
      model?: string;
      reasoningEffort?: string | null;
    }): Promise<ExecuteAiTaskResult> {
      return await executeReadOnlyOneShotTask({
        feature: "pr_descriptions",
        taskType: "pr_description",
        cwd: args.cwd,
        prompt: args.prompt,
        timeoutMs: args.timeoutMs,
        model: args.model,
        reasoningEffort: args.reasoningEffort
      });
    },

    async generateCommitMessage(args: {
      cwd: string;
      prompt: string;
      timeoutMs?: number;
      model?: string;
      reasoningEffort?: string | null;
    }): Promise<ExecuteAiTaskResult> {
      return await executeReadOnlyOneShotTask({
        feature: "commit_messages",
        taskType: "commit_message",
        cwd: args.cwd,
        prompt: args.prompt,
        timeoutMs: args.timeoutMs,
        model: args.model,
        reasoningEffort: args.reasoningEffort
      });
    },

    async summarizeTerminal(args: {
      cwd: string;
      prompt: string;
      timeoutMs?: number;
      model?: string;
      jsonSchema?: unknown;
    }): Promise<ExecuteAiTaskResult> {
      return await executeReadOnlyOneShotTask({
        feature: "terminal_summaries",
        taskType: "terminal_summary",
        cwd: args.cwd,
        prompt: args.prompt,
        timeoutMs: args.timeoutMs,
        model: args.model,
        jsonSchema: args.jsonSchema
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
    }
  };
}
