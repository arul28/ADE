import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { AgentModelDescriptor, AgentProvider, ExecutorOpts } from "./agentExecutor";
import type {
  AiApiKeyVerificationResult,
  AiClaudeAvailability,
  AiCustomProviderConfig,
  AiLocalProviderConfigs,
  AiProviderConnections,
  AiRuntimeConnections,
  AiRuntimeConnectionStatus,
  AiPiInstallationStatus,
  CursorCloudAgentSummary,
  CursorCloudCreateRunRequest,
  CursorCloudCreateRunResult,
  CursorCloudListAgentsResult,
  CursorCloudListRunsResult,
  CursorCloudRepository,
  CursorCloudRunSummary,
} from "../../../shared/types";
import {
  decodeOpenCodeRegistryId,
  replaceDynamicPiModelDescriptors,
  getDefaultModelDescriptor,
  getModelById,
  getAvailableModels,
  getLocalProviderDefaultEndpoint,
  isLocalProviderFamily,
  listModelDescriptorsForProvider,
  LOCAL_PROVIDER_LABELS,
  replaceDynamicOpenCodeModelDescriptors,
  resolveModelAlias,
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
  loadPersistedOpenCodeInventory,
  peekOpenCodeInventoryCache,
  probeOpenCodeProviderInventory,
} from "../opencode/openCodeInventory";
import type { DiscoveredLocalModelEntry } from "../opencode/openCodeRuntime";
import {
  clearOpenCodeBinaryCache,
  resolveOpenCodeBinary,
  type OpenCodeBinarySource,
} from "../opencode/openCodeBinaryManager";
import {
  initialize as initModelsDevService,
  getLastFetchedAt as getModelsDevLastFetchedAt,
} from "./modelsDevService";
import { isRecord } from "../shared/utils";
import { parseStructuredOutput } from "./utils";
import {
  deleteApiKey as deleteStoredApiKey,
  getAllApiKeys,
  getApiKeyStoreStatus,
  listStoredProviders,
  storeApiKey as storeStoredApiKey,
} from "./apiKeyStore";
import { inspectLocalProvider } from "./localModelDiscovery";
import {
  discoverCursorSdkModelDescriptors,
  clearCursorCliModelsCache,
  markCursorModelCachesStale,
  probeCursorSdkModelDiscovery,
} from "../chat/cursorModelsDiscovery";
import { discoverDroidCliModelDescriptors, markDroidModelCachesStale } from "../chat/droidModelsDiscovery";
import { resolveDroidExecutable } from "./droidExecutable";
import { buildProviderConnections } from "./providerConnectionStatus";
import { piModelDescriptorsFromInventory, probePiProfileInventory, resolvePiInstallation } from "./piInstallation";
import { getProviderRuntimeHealthVersion, resetProviderRuntimeHealth } from "./providerRuntimeHealth";
import { resetClaudeRuntimeProbeCache } from "./claudeRuntimeProbe";
import { runProviderTask } from "./providerTaskRunner";
import { resolveClaudeCodeExecutable } from "./claudeCodeExecutable";
import { loadCursorSdk } from "./cursorSdkLoader";

export type AiTaskType =
  | "planning"
  | "implementation"
  | "review"
  | "conflict_resolution"
  | "commit_message"
  | "narrative"
  | "pr_description"
  | "terminal_summary"
  | "session_title"
  | "session_summary"
  | "handoff_summary"
  | "continuity_summary"
  | "context_compaction"
  | "initial_context";

export type AiFeatureKey =
  | "narratives"
  | "conflict_proposals"
  | "commit_messages"
  | "pr_descriptions"
  | "terminal_summaries"
  | "orchestrator"
  | "initial_context";

export type AiProviderMode = "guest" | "subscription";

export type AiIntegrationStatus = {
  mode: AiProviderMode;
  availableProviders: {
    claude: AiClaudeAvailability;
    codex: boolean;
    cursor: boolean;
    droid: boolean;
  };
  models: {
    claude: AgentModelDescriptor[];
    codex: AgentModelDescriptor[];
    cursor: AgentModelDescriptor[];
    droid: AgentModelDescriptor[];
  };
  detectedAuth?: Array<{
    type: "cli-subscription" | "api-key" | "oauth" | "openrouter" | "local";
    cli?: "claude" | "codex" | "cursor" | "droid";
    provider?: string;
    source?: "config" | "env" | "store" | "file";
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
  opencodeProviders?: Array<{ id: string; name: string; connected: boolean; modelCount: number; availableModelCount?: number }>;
  /** True when opencodeProviders came from the persisted disk cache rather than a live/warm probe. */
  opencodeProvidersStale?: boolean;
  /** Epoch ms of the last successful models.dev fetch (or cache mtime on fallback); null if never fetched. */
  modelsDevLastFetchedAt?: number | null;
  /** Effective ai.customProviders — surfaced so the settings UI can do authoritative full-list writes. */
  customProviders?: AiCustomProviderConfig[];
  /** Effective ai.customModelSlugs — surfaced so the settings UI can do authoritative full-list writes. */
  customModelSlugs?: string[];
  piInstallation?: AiPiInstallationStatus;
  apiKeyStore?: {
    secureStorageAvailable: boolean;
    macosKeychainAvailable?: boolean;
    macosKeychainService?: string | null;
    macosKeychainError?: string | null;
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
  imagePaths?: string[];
  permissionMode?: ExecutorOpts["permissions"]["mode"];
  oneShot?: boolean;
  sessionId?: string;
  projectId?: string;
  runId?: string;
  stepId?: string;
  attemptId?: string;
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
  orchestrator: true,
  initial_context: true,
};

const DEFAULT_CLAUDE_TASK_MODEL_ID = getDefaultModelDescriptor("claude")?.id ?? "anthropic/claude-sonnet-5";
const DEFAULT_CODEX_TASK_MODEL_ID = getDefaultModelDescriptor("codex")?.id ?? "openai/gpt-5.6-sol";

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
  session_title: {
    modelId: "anthropic/claude-haiku-4-5",
    timeoutMs: 20_000
  },
  session_summary: {
    modelId: "anthropic/claude-haiku-4-5",
    timeoutMs: 45_000
  },
  handoff_summary: {
    modelId: "anthropic/claude-haiku-4-5",
    timeoutMs: 45_000
  },
  continuity_summary: {
    modelId: "anthropic/claude-haiku-4-5",
    timeoutMs: 45_000
  },
  context_compaction: {
    modelId: "anthropic/claude-haiku-4-5",
    timeoutMs: 120_000
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

function detectClaudeAuthModeFromEntries(auth: DetectedAuth[]): AiClaudeAvailability["auth"]["mode"] {
  if (auth.some((entry) => entry.type === "api-key" && entry.provider === "anthropic")) return "api_key";
  if (auth.some((entry) => entry.type === "cli-subscription" && entry.cli === "claude")) return "oauth";
  return "none";
}

function detectClaudeAuthModeFromConnection(
  connection: AiProviderConnections["claude"],
): AiClaudeAvailability["auth"]["mode"] {
  const localCredentials = connection.sources.find((source) => source.kind === "local-credentials" && source.detected);
  if (localCredentials?.source === "claude-credentials-file" || localCredentials?.source === "macos-keychain") return "oauth";
  if (localCredentials) return "api_key";
  const cli = connection.sources.find((source) => source.kind === "cli" && source.detected);
  if (cli || connection.authAvailable) return "oauth";
  return "none";
}

function resolveBundledClaudeBinary(): Pick<AiClaudeAvailability["binary"], "present" | "source" | "path"> {
  const resolved = resolveClaudeCodeExecutable({ env: { PATH: "" } });
  return resolved.source === "bundled"
    ? { present: true, source: "bundled", path: resolved.path }
    : { present: false, source: "missing", path: null };
}

function buildClaudeAvailabilityFromConnection(
  connection: AiProviderConnections["claude"],
): AiClaudeAvailability {
  const bundledBinary = resolveBundledClaudeBinary();
  const binary = bundledBinary.present
    ? bundledBinary
    : {
        present: connection.runtimeDetected,
        source: connection.runtimeDetected ? "path" as const : "missing" as const,
        path: connection.path,
      };
  const authMode = detectClaudeAuthModeFromConnection(connection);
  const binaryOnlyBlockers = [
    "could not find the claude cli",
    "cli not found",
    "claude cli is installed",
    "add that bin directory",
  ];
  const normalizedBlocker = connection.blocker?.toLowerCase() ?? "";
  const blockerIsOnlyAboutPath = binary.source === "bundled"
    && binaryOnlyBlockers.some((needle) => normalizedBlocker.includes(needle));
  const ready = binary.present
    && connection.authAvailable
    && (connection.runtimeAvailable || blockerIsOnlyAboutPath || !connection.blocker);
  return {
    binary,
    auth: {
      ready,
      mode: ready ? authMode : "none",
      detail: ready ? null : connection.blocker,
    },
  };
}

function buildClaudeAvailabilityFromCliStatus(status: CliAuthStatus | null): AiClaudeAvailability {
  const bundledBinary = resolveBundledClaudeBinary();
  const installed = Boolean(status?.installed);
  const ready = Boolean(status?.installed && (status.authenticated || !status.verified));
  const binary = bundledBinary.present
    ? bundledBinary
    : {
        present: installed,
        source: installed ? "path" as const : "missing" as const,
        path: status?.path ?? null,
      };
  return {
    binary,
    auth: {
      ready: binary.present && ready,
      mode: binary.present && ready ? "oauth" : "none",
      detail: binary.present && ready ? null : installed ? "Claude CLI is installed but no active login was detected." : "Claude authentication was not detected.",
    },
  };
}

function toCliAvailability(auth: DetectedAuth[]): {
  claude: AiClaudeAvailability;
  codex: boolean;
  cursor: boolean;
  droid: boolean;
} {
  const bundledBinary = resolveBundledClaudeBinary();
  const cliAuth = auth.find((entry) => entry.type === "cli-subscription" && entry.cli === "claude") as
    | Extract<DetectedAuth, { type: "cli-subscription" }>
    | undefined;
  const claudeBinary = bundledBinary.present
    ? bundledBinary
    : {
        present: Boolean(cliAuth),
        source: cliAuth ? "path" as const : "missing" as const,
        path: cliAuth?.path ?? null,
      };
  const claudeAuthReady = auth.some((entry) =>
    (entry.type === "cli-subscription" && entry.cli === "claude")
    || (entry.type === "api-key" && entry.provider === "anthropic")
  );
  return {
    claude: {
      binary: claudeBinary,
      auth: {
        ready: claudeBinary.present && claudeAuthReady,
        mode: claudeBinary.present && claudeAuthReady ? detectClaudeAuthModeFromEntries(auth) : "none",
        detail: claudeBinary.present && claudeAuthReady ? null : "Claude authentication was not detected.",
      },
    },
    codex: auth.some((entry) => entry.type === "cli-subscription" && entry.cli === "codex"),
    cursor: auth.some((entry) => entry.type === "api-key" && entry.provider === "cursor"),
    droid: auth.some((entry) => entry.type === "cli-subscription" && entry.cli === "droid"),
  };
}

function getCursorApiKeyFromAuth(auth: DetectedAuth[]): string | null {
  const entry = auth.find(
    (candidate): candidate is Extract<DetectedAuth, { type: "api-key" }> =>
      candidate.type === "api-key" && candidate.provider === "cursor",
  );
  return entry?.key?.trim() || null;
}

function readString(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length ? text : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeCursorCloudAgent(raw: unknown): CursorCloudAgentSummary {
  const record = isRecord(raw) ? raw : {};
  const target = isRecord(record.target) ? record.target : {};
  const agentId = readString(record.agentId) ?? readString(record.id) ?? "";
  const repos = Array.isArray(record.repos)
    ? record.repos.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  const status = readString(record.status)?.toLowerCase();
  return {
    agentId,
    name: readString(record.name) ?? "Cursor cloud agent",
    summary: readString(record.summary) ?? "",
    ...(status === "running" || status === "finished" || status === "error" ? { status } : {}),
    archived: typeof record.archived === "boolean" ? record.archived : undefined,
    lastModified: readNumber(record.lastModified),
    createdAt: readNumber(record.createdAt),
    repos,
    webUrl: readString(record.webUrl) ?? readString(target.url) ?? (agentId ? `https://cursor.com/agents?id=${encodeURIComponent(agentId)}` : null),
  };
}

function normalizeCursorCloudRun(raw: unknown, fallbackAgentId?: string | null): CursorCloudRunSummary {
  const record = isRecord(raw) ? raw : {};
  const model = isRecord(record.model) ? record.model : {};
  return {
    runId: readString(record.id) ?? readString(record.runId) ?? "",
    agentId: readString(record.agentId) ?? fallbackAgentId ?? "",
    status: readString(record.status) ?? "unknown",
    modelId: readString(model.id) ?? readString(record.modelId),
    durationMs: readNumber(record.durationMs),
    result: record.result,
    git: record.git,
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

function redactPiDetectedAuth(
  piInstallation: AiPiInstallationStatus | null | undefined,
): NonNullable<AiIntegrationStatus["detectedAuth"]> {
  if (!piInstallation?.providers?.length) return [];
  return piInstallation.providers.flatMap((provider) => {
    if (!provider.configured || !provider.authType) return [];
    const source = provider.authSource === "environment"
      ? "env" as const
      : provider.authSource === "stored"
        ? "file" as const
        : provider.authSource === "models_json_key" || provider.authSource === "models_json_command"
          ? "config" as const
          : undefined;
    const path = provider.authSource === "stored"
      ? piInstallation.authPath
      : provider.authSource === "models_json_key" || provider.authSource === "models_json_command"
        ? piInstallation.modelsPath
        : undefined;
    return [{
      type: provider.authType === "oauth"
        ? "oauth" as const
        : provider.authType === "local"
          ? "local" as const
          : "api-key" as const,
      provider: provider.id,
      ...(source ? { source } : {}),
      ...(path ? { path } : {}),
      authenticated: true,
      verified: true,
    }];
  });
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

function toCliRuntimeConnection(status: NonNullable<NonNullable<AiProviderConnections>[keyof AiProviderConnections]>): AiRuntimeConnectionStatus {
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
    ...(source ? { source: source === "cursor-env" || source === "factory-env" ? "env" : "store" as const } : {}),
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
    ...(args.providerConnections.pi ? { pi: toCliRuntimeConnection(args.providerConnections.pi) } : {}),
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

const AI_STATUS_SLOW_PHASE_MS = 120;

type AiStatusPhaseTiming = {
  name: string;
  durationMs: number;
};

function agentModelsFromAvailable(
  available: Array<Pick<ModelDescriptorForStatus, "family" | "id" | "displayName" | "isCliWrapped">>,
  family: string,
): AgentModelDescriptor[] {
  return available
    .filter((descriptor) => descriptor.family === family)
    .map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.displayName,
      description: `${descriptor.family}${descriptor.isCliWrapped ? " (CLI)" : " (API/local)"}`,
    }));
}

type ModelDescriptorForStatus = ReturnType<typeof getAvailableModels>[number];

function buildStatusModelLists(
  available: ModelDescriptorForStatus[],
  availability: AiIntegrationStatus["availableProviders"],
): AiIntegrationStatus["models"] {
  return {
    claude: availability.claude.auth.ready ? agentModelsFromAvailable(available, "anthropic") : [],
    codex: availability.codex ? agentModelsFromAvailable(available, "openai") : [],
    cursor: availability.cursor ? agentModelsFromAvailable(available, "cursor") : [],
    droid: availability.droid ? agentModelsFromAvailable(available, "factory") : [],
  };
}

export function createAiIntegrationService(args: {
  db: AdeDb;
  logger: Logger;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  projectRoot: string;
  enableDynamicModelMetadata?: boolean;
}) {
  const { db, logger, projectConfigService, projectRoot } = args;

  // Non-blocking: fetch models.dev data and enrich pricing + registry. The
  // enrichment step lives inside modelsDevService.initialize() so the periodic
  // 6h refresh and explicit refreshNow() re-apply it too. Headless CLI readiness
  // commands disable this so default doctor/auth runs remain local-only and do
  // not touch provider/model networks.
  if (args.enableDynamicModelMetadata !== false) initModelsDevService().catch((err) => {
    logger.warn("ai.modelsdev.init_failed", { error: err instanceof Error ? err.message : String(err) });
  });

  const detectAuth = async (options?: { force?: boolean; shallowCliAuth?: boolean }): Promise<DetectedAuth[]> => {
    const snapshot = projectConfigService.get();
    return await detectAllAuth(extractConfiguredApiKeys(snapshot), {
      force: options?.force,
      localProviders: extractConfiguredLocalProviders(snapshot),
      skipCliAuthProbe: options?.shallowCliAuth === true,
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
        || args.providerConnections.cursor.authAvailable
        || args.providerConnections.droid.authAvailable
        || Boolean(args.providerConnections.pi?.authAvailable))
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
    const droid = statuses.find((entry) => entry.cli === "droid");
    let cursorStoredAuth = false;
    try {
      cursorStoredAuth = Boolean(getAllApiKeys().cursor?.trim());
    } catch {
      // API key store may not be initialized yet
    }
    return {
      claude: buildClaudeAvailabilityFromCliStatus(claude ?? null),
      codex: Boolean(codex?.installed && (codex.authenticated || !codex.verified)),
      cursor: Boolean(process.env.CURSOR_API_KEY?.trim() || cursorStoredAuth),
      droid: Boolean(droid?.installed && (droid.authenticated || !droid.verified)),
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

  const getResolvedAvailableModels = async (
    auth: DetectedAuth[],
    options?: { discoverCliModels?: boolean },
  ) => {
    // Local model discovery is handled by OpenCode via probeOpenCodeProviderInventory
    // which populates dynamic OpenCode descriptors (including local providers).

    let available = getAvailableModels(auth);
    const discoveryMode = options?.discoverCliModels === true ? "probe" : "cached-or-fallback";
    // "cached-or-fallback" serves last-known-good rows and warms the cache in
    // the background when cold, so a verified key surfaces models on passive
    // status reads (availableModelIds, mobile, TUI) without an active probe.
    const cursorDiscoveryMode = options?.discoverCliModels === true ? "probe" : "cached-or-fallback";

    const cursorApiKey = getCursorApiKeyFromAuth(auth);
    if (cursorApiKey) {
      let cursorModels: Awaited<ReturnType<typeof discoverCursorSdkModelDescriptors>> = [];
      try {
        cursorModels = await discoverCursorSdkModelDescriptors(cursorApiKey, { mode: cursorDiscoveryMode });
      } catch {
        cursorModels = [];
      }
      if (cursorModels.length) {
        available = [
          ...available.filter((descriptor) => !(descriptor.family === "cursor" && descriptor.isCliWrapped)),
          ...cursorModels,
        ];
      }
    }

    const hasDroidCliAuth = auth.some(
      (entry) =>
        entry.type === "cli-subscription"
        && entry.cli === "droid"
        && entry.authenticated !== false,
    );
    const hasDroidApiKey = Boolean(process.env.FACTORY_API_KEY?.trim());
    if (hasDroidCliAuth || hasDroidApiKey) {
      try {
        const { path: droidPath } = resolveDroidExecutable({ auth });
        const droidModels = await discoverDroidCliModelDescriptors(droidPath, { mode: discoveryMode });
        available = [
          ...available.filter((descriptor) => !(descriptor.family === "factory" && descriptor.isCliWrapped)),
          ...droidModels,
        ];
      } catch {
        // Droid CLI missing or model discovery failed — omit dynamic Droid list
      }
    }

    return available;
  };

  const verifyApiKeyConnection = async (provider: string): Promise<AiApiKeyVerificationResult> => {
    const normalizedProvider = String(provider ?? "").trim().toLowerCase();
    let invalidateInFinally = true;
    try {
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
      if (providerName === "cursor" && verification.ok) {
        invalidateProviderReadinessCaches();
        invalidateInFinally = false;
        try {
          const discovery = await probeCursorSdkModelDiscovery(apiEntry.key, { timeoutMs: 3_000 });
          if (discovery.failureKind === "auth") {
            return {
              ...verification,
              ok: false,
              message:
                "Cursor account verification succeeded, but Cursor rejected this API key for agent/model access. Re-enter a key from the Cursor dashboard API page.",
              source: apiEntry.source,
            };
          }
        } catch (error) {
          logger.warn("ai.cursor.discovery_probe_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return {
        ...verification,
        source: apiEntry.source,
      };
    } finally {
      if (invalidateInFinally) {
        invalidateProviderReadinessCaches();
      }
    }
  };

  const requireCursorCloudApiKey = async (): Promise<string> => {
    const key = getCursorApiKeyFromAuth(await detectAuth());
    if (!key) {
      throw new Error("Add a Cursor API key before using Cursor Cloud agents.");
    }
    return key;
  };

  const listCursorCloudRepositories = async (): Promise<CursorCloudRepository[]> => {
    const apiKey = await requireCursorCloudApiKey();
    const { Cursor } = await loadCursorSdk();
    const repos = await Cursor.repositories.list({ apiKey });
    return repos
      .map((repo) => ({ url: String(repo.url ?? "").trim() }))
      .filter((repo) => repo.url.length > 0);
  };

  const listCursorCloudAgents = async (args?: {
    includeArchived?: boolean;
    limit?: number;
    cursor?: string | null;
  }): Promise<CursorCloudListAgentsResult> => {
    const apiKey = await requireCursorCloudApiKey();
    const { Agent } = await loadCursorSdk();
    const result = await Agent.list({
      runtime: "cloud",
      apiKey,
      includeArchived: args?.includeArchived,
      limit: args?.limit,
      cursor: args?.cursor?.trim() || undefined,
    });
    return {
      items: result.items.map(normalizeCursorCloudAgent),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  };

  const listCursorCloudRuns = async (args: {
    agentId: string;
    limit?: number;
    cursor?: string | null;
  }): Promise<CursorCloudListRunsResult> => {
    const agentId = args.agentId.trim();
    if (!agentId) throw new Error("Cursor cloud agent id is required.");
    const apiKey = await requireCursorCloudApiKey();
    const { Agent } = await loadCursorSdk();
    const result = await Agent.listRuns(agentId, {
      runtime: "cloud",
      apiKey,
      limit: args.limit,
      cursor: args.cursor?.trim() || undefined,
    });
    return {
      items: result.items.map((run) => normalizeCursorCloudRun(run, agentId)),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  };

  const createCursorCloudRun = async (
    args: CursorCloudCreateRunRequest,
  ): Promise<CursorCloudCreateRunResult> => {
    const promptText = args.promptText.trim();
    const repoUrl = args.repoUrl.trim();
    if (!promptText) throw new Error("Prompt is required.");
    if (!repoUrl) throw new Error("Cursor cloud repo is required.");
    const idempotencyKey = args.idempotencyKey?.trim() || undefined;
    const apiKey = await requireCursorCloudApiKey();
    const { Agent } = await loadCursorSdk();
    const agent = await Agent.create({
      apiKey,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(args.modelId?.trim() ? { model: { id: args.modelId.trim() } } : {}),
      ...(args.agentName?.trim() ? { name: args.agentName.trim() } : {}),
      cloud: {
        repos: [{
          url: repoUrl,
          ...(args.startingRef?.trim() ? { startingRef: args.startingRef.trim() } : {}),
        }],
        workOnCurrentBranch: args.workOnCurrentBranch === true,
        autoCreatePR: args.autoCreatePR === true,
        skipReviewerRequest: args.skipReviewerRequest !== false,
      },
    });
    const run = await agent.send(promptText, idempotencyKey ? { idempotencyKey } : undefined);
    const agentSummary: CursorCloudAgentSummary = {
      agentId: agent.agentId,
      name: args.agentName?.trim() || "Cursor cloud agent",
      summary: promptText.slice(0, 180),
      status: "running",
      archived: false,
      repos: [repoUrl],
      webUrl: `https://cursor.com/agents?id=${encodeURIComponent(agent.agentId)}`,
    };
    return {
      agent: agentSummary,
      run: normalizeCursorCloudRun(run, agent.agentId),
    };
  };

  const archiveCursorCloudAgent = async (agentId: string): Promise<void> => {
    const id = agentId.trim();
    if (!id) throw new Error("Cursor cloud agent id is required.");
    const apiKey = await requireCursorCloudApiKey();
    const { Agent } = await loadCursorSdk();
    await Agent.archive(id, { apiKey });
  };

  const unarchiveCursorCloudAgent = async (agentId: string): Promise<void> => {
    const id = agentId.trim();
    if (!id) throw new Error("Cursor cloud agent id is required.");
    const apiKey = await requireCursorCloudApiKey();
    const { Agent } = await loadCursorSdk();
    await Agent.unarchive(id, { apiKey });
  };

  const deleteCursorCloudAgent = async (agentId: string): Promise<void> => {
    const id = agentId.trim();
    if (!id) throw new Error("Cursor cloud agent id is required.");
    const apiKey = await requireCursorCloudApiKey();
    const { Agent } = await loadCursorSdk();
    await Agent.delete(id, { apiKey });
  };

  const getCursorCloudAgent = async (agentId: string): Promise<CursorCloudAgentSummary | null> => {
    const id = agentId.trim();
    if (!id) throw new Error("Cursor cloud agent id is required.");
    const apiKey = await requireCursorCloudApiKey();
    const { Agent } = await loadCursorSdk();
    try {
      const raw = await Agent.get(id, { apiKey });
      return normalizeCursorCloudAgent(raw);
    } catch {
      return null;
    }
  };

  const listCursorCloudArtifacts = async (
    agentId: string,
  ): Promise<Array<{ path: string; sizeBytes?: number; updatedAt?: string | null; mimeType?: string | null }>> => {
    const id = agentId.trim();
    if (!id) throw new Error("Cursor cloud agent id is required.");
    const apiKey = await requireCursorCloudApiKey();
    const { Agent } = await loadCursorSdk();
    const cloudAgent = await Agent.resume(id, { apiKey });
    try {
      const artifacts = await cloudAgent.listArtifacts();
      return artifacts.map((entry) => ({
        path: entry.path,
        sizeBytes: entry.sizeBytes,
        updatedAt: entry.updatedAt ?? null,
      }));
    } finally {
      try {
        await (cloudAgent as { [Symbol.asyncDispose]?: () => Promise<void> })[Symbol.asyncDispose]?.();
      } catch {
        try { (cloudAgent as { close?: () => void }).close?.(); } catch { /* ignore */ }
      }
    }
  };

  const downloadCursorCloudArtifact = async (args: {
    agentId: string;
    path: string;
  }): Promise<{ path: string; contents: string; mimeType: string | null; sizeBytes: number }> => {
    const id = args.agentId.trim();
    const artifactPath = typeof args.path === "string" ? args.path : "";
    if (!id) throw new Error("Cursor cloud agent id is required.");
    if (!artifactPath.length) throw new Error("Cursor cloud artifact path is required.");
    const apiKey = await requireCursorCloudApiKey();
    const { Agent } = await loadCursorSdk();
    const cloudAgent = await Agent.resume(id, { apiKey });
    try {
      const buffer = await cloudAgent.downloadArtifact(artifactPath);
      return {
        path: artifactPath,
        contents: Buffer.from(buffer).toString("base64"),
        mimeType: null,
        sizeBytes: buffer.byteLength,
      };
    } finally {
      try {
        await (cloudAgent as { [Symbol.asyncDispose]?: () => Promise<void> })[Symbol.asyncDispose]?.();
      } catch {
        try { (cloudAgent as { close?: () => void }).close?.(); } catch { /* ignore */ }
      }
    }
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

  /**
   * Successful requests for `feature` so far today.
   *
   * This reads `ai_usage_log` directly, and that table replicates, so the count
   * spans every machine on the account — `dailyLimit` is an account-wide cap,
   * not a per-machine one. Anything that stops the table replicating (making it
   * local-only, filtering it out of a peer's changesets) turns the cap into a
   * per-machine one and multiplies the user's ceiling by their machine count.
   * See the note beside `ai_usage_log` in kvDb's LOCAL_ONLY_CRR_EXCLUDED_TABLES.
   */
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

    // Resolve from alias (e.g. "sonnet" -> "anthropic/claude-sonnet-5")
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
      imagePaths: args.imagePaths,
      reasoningEffort: args.reasoningEffort ?? null,
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

    if (args.taskType !== "session_title" && !getFeatureFlag(args.feature)) {
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
    const available = await getResolvedAvailableModels(auth, { discoverCliModels: true });
    let family: string;
    if (provider === "codex") {
      family = "openai";
    } else if (provider === "cursor") {
      family = "cursor";
    } else if (provider === "droid") {
      family = "factory";
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
  const statusRequestsInFlight = new Map<string, Promise<AiIntegrationStatus>>();
  let providerReadinessCacheGeneration = 0;

  const invalidateProviderReadinessCaches = (): void => {
    providerReadinessCacheGeneration += 1;
    statusCache = null;
    statusRequestsInFlight.clear();
    modelListCache.clear();
    resetProviderRuntimeHealth();
    resetClaudeRuntimeProbeCache();
    resetLocalProviderDetectionCache();
    // Keep last-known-good cursor/droid model rows: generic readiness
    // invalidation runs on every forced status refresh and on verifying ANY
    // provider's key, and blanking the dynamic model lists here made cursor
    // models vanish from every surface right after a successful verification.
    // A cursor key change does a full clear at the storeApiKey/deleteApiKey
    // call sites; droid auth is file-based, so it has no such call site.
    markCursorModelCachesStale();
    markDroidModelCachesStale();
    clearOpenCodeBinaryCache();
    clearOpenCodeInventoryCache();
    replaceDynamicOpenCodeModelDescriptors([]);
    replaceDynamicPiModelDescriptors([]);
  };

  const executeReadOnlyOneShotTask = async (args: {
    feature: AiFeatureKey;
    taskType: AiTaskType;
    cwd: string;
    prompt: string;
    systemPrompt?: string;
    timeoutMs?: number;
    model?: string;
    jsonSchema?: unknown;
    reasoningEffort?: string | null;
    imagePaths?: string[];
  }): Promise<ExecuteAiTaskResult> => {
    return await executeTask({
      feature: args.feature,
      taskType: args.taskType,
      prompt: args.prompt,
      systemPrompt: args.systemPrompt,
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
      model: args.model,
      ...(args.jsonSchema ? { jsonSchema: args.jsonSchema } : {}),
      ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
      ...(args.imagePaths?.length ? { imagePaths: args.imagePaths } : {}),
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
        invalidateProviderReadinessCaches();
        runtimeHealthVersion = getProviderRuntimeHealthVersion();
      }
      const requestGeneration = providerReadinessCacheGeneration;
      const requestKey = [
        options?.force === true ? "force" : "default",
        options?.refreshOpenCodeInventory === true ? "refresh-opencode" : "reuse-opencode",
        String(runtimeHealthVersion),
        String(requestGeneration),
      ].join(":");
      const existingRequest = statusRequestsInFlight.get(requestKey);
      if (existingRequest) {
        return existingRequest;
      }

      const request = (async (): Promise<AiIntegrationStatus> => {
        const requestId = randomUUID();
        const totalStartedAt = Date.now();
        const phases: AiStatusPhaseTiming[] = [];
        const shouldProbeCliModels = options?.force === true || options?.refreshOpenCodeInventory === true;
        const phaseContext = {
          requestId,
          force: options?.force === true,
          refreshOpenCodeInventory: options?.refreshOpenCodeInventory === true,
          probeCliModels: shouldProbeCliModels,
        };
        const recordPhase = (name: string, startedAt: number) => {
          const durationMs = Date.now() - startedAt;
          phases.push({ name, durationMs });
          if (durationMs >= AI_STATUS_SLOW_PHASE_MS) {
            logger.info("ai.status.phase", {
              ...phaseContext,
              phase: name,
              durationMs,
            });
          }
        };
        const timePhase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
          const startedAt = Date.now();
          try {
            return await fn();
          } finally {
            recordPhase(name, startedAt);
          }
        };
        const timeSyncPhase = <T>(name: string, fn: () => T): T => {
          const startedAt = Date.now();
          try {
            return fn();
          } finally {
            recordPhase(name, startedAt);
          }
        };
        const phaseSummary = () => phases
          .filter((phase) => phase.durationMs >= 10)
          .map((phase) => ({ phase: phase.name, durationMs: phase.durationMs }));

        try {
          const auth = await timePhase("detect_auth", () => detectAuth({
            force: options?.force,
            shallowCliAuth: !shouldProbeCliModels,
          }));
          const available = await timePhase("resolve_available_models", () =>
            getResolvedAvailableModels(auth, { discoverCliModels: shouldProbeCliModels })
          );
          // detectAuth -> detectAllAuth already called detectCliAuthStatuses() and
          // populated the cache, so this reads instantly from cache:
          const cliStatuses = timeSyncPhase("read_cli_auth_cache", () => getCachedCliAuthStatuses());
          const piInstallation = timeSyncPhase("resolve_pi_installation", () => resolvePiInstallation());
          const piProfileInventory = await timePhase("pi_inventory", () => probePiProfileInventory(piInstallation));
          replaceDynamicPiModelDescriptors(piModelDescriptorsFromInventory(piProfileInventory));
          // Keep AI status refresh non-interactive. Starting a throwaway Claude
          // Agent SDK runtime here can trigger Claude's OAuth/API-key bootstrap
          // in the browser, even though the user only asked to refresh status.
          // Real Claude chat sessions report runtime health when they start.
          const providerConnections = await timePhase("build_provider_connections", () => buildProviderConnections(cliStatuses, {
            piInstallation,
            piInventory: piProfileInventory,
          }));
          const configuredLocalProviders = timeSyncPhase(
            "read_local_provider_config",
            () => extractConfiguredLocalProviders(projectConfigService.get()),
          );
          const runtimeConnections = await timePhase("build_runtime_connections", () => buildRuntimeConnections({
            configuredLocalProviders,
            auth,
            providerConnections,
          }));
          const availability: AiIntegrationStatus["availableProviders"] = {
            claude: buildClaudeAvailabilityFromConnection(providerConnections.claude),
            codex: providerConnections.codex.runtimeAvailable,
            cursor: providerConnections.cursor.runtimeAvailable,
            droid: providerConnections.droid.runtimeAvailable,
          };
          const runtimeFilteredAvailable = timeSyncPhase("filter_available_models", () => available.filter((descriptor) => {
            if (!descriptor.isCliWrapped) return true;
            if (descriptor.family === "anthropic") return availability.claude.auth.ready;
            if (descriptor.family === "openai") return providerConnections.codex.runtimeAvailable;
            if (descriptor.family === "cursor") return providerConnections.cursor.runtimeAvailable;
            if (descriptor.family === "factory") return providerConnections.droid.runtimeAvailable;
            return true;
          }));

          const opencodeBinaryInfo = timeSyncPhase("resolve_opencode_binary", () => resolveOpenCodeBinary());
          const opencodeBinaryInstalled = Boolean(opencodeBinaryInfo.path);
          const opencodeBinarySource = opencodeBinaryInfo.source;
          const effectiveConfig = timeSyncPhase("read_effective_config", () => projectConfigService.get().effective);
          // Extract discovered local models from runtime connections so we can
          // inject them into the OpenCode provider config. This bridges ADE's
          // local model discovery with OpenCode's static provider model list.
          const discoveredLocalModels = timeSyncPhase("extract_local_models", () => extractDiscoveredLocalModels(runtimeConnections));
          const opencodeInventory = await timePhase("opencode_inventory", async () => {
            if (!opencodeBinaryInstalled) {
              clearOpenCodeInventoryCache();
              replaceDynamicOpenCodeModelDescriptors([]);
              return {
                error: null as string | null,
                modelIds: [] as string[],
                catalogModelIds: [] as string[],
                providers: [] as NonNullable<AiIntegrationStatus["opencodeProviders"]>,
                stale: false,
              };
            }
            if (options?.refreshOpenCodeInventory === true) {
              const probed = await probeOpenCodeProviderInventory({
                projectRoot,
                projectConfig: effectiveConfig,
                logger,
                force: true,
                discoveredLocalModels,
              });
              // A transient probe failure (e.g. server launch hiccup) must not
              // collapse the settings chips to empty when we have a persisted
              // list — serve it flagged stale, keeping the error visible.
              if (probed.error && !probed.providers.length) {
                const persisted = loadPersistedOpenCodeInventory(projectRoot);
                if (persisted.length) {
                  return { ...probed, providers: persisted, stale: true };
                }
              }
              return { ...probed, stale: false };
            }
            const peeked = peekOpenCodeInventoryCache({
              projectRoot,
              projectConfig: effectiveConfig,
            });
            if (peeked) return { ...peeked, stale: false };
            // Cold status reads stay cheap. Runtime catalog refreshes are owned
            // by agentChatService.getModelCatalog() and only run when a client
            // opens a dynamic runtime rail. Surface the last persisted provider
            // list (flagged stale) so chips render before the first warm probe.
            return {
              error: null as string | null,
              modelIds: [] as string[],
              catalogModelIds: [] as string[],
              providers: loadPersistedOpenCodeInventory(projectRoot),
              stale: true,
            };
          });

          // When OpenCode inventory has models for a local provider, remove the
          // duplicate ADE-discovered entries to avoid showing the same model twice.
          const mergedAvailableIds = timeSyncPhase("merge_available_model_ids", () => {
            const opencodeLocalModelIds = new Set<string>();
            for (const ocId of opencodeInventory.modelIds) {
              const decoded = decodeOpenCodeRegistryId(ocId);
              if (decoded && isLocalProviderFamily(decoded.openCodeProviderId)) {
                opencodeLocalModelIds.add(`${decoded.openCodeProviderId}/${decoded.openCodeModelId}`);
              }
            }
            const baseAvailableIds = runtimeFilteredAvailable
              .map((descriptor) => descriptor.id)
              .filter((id) => !opencodeLocalModelIds.has(id));
            return [...new Set([
              ...baseAvailableIds,
              ...opencodeInventory.modelIds,
              ...piProfileInventory.availableModelIds,
            ])];
          });
          const models = timeSyncPhase("build_model_lists", () => buildStatusModelLists(runtimeFilteredAvailable, availability));

          const result: AiIntegrationStatus = {
            mode: timeSyncPhase("derive_mode", () => deriveMode({ snapshot: projectConfigService.get(), auth, providerConnections })),
            availableProviders: availability,
            models,
            detectedAuth: timeSyncPhase("redact_auth", () => [
              ...redactDetectedAuth(auth, cliStatuses),
              ...redactPiDetectedAuth(piProfileInventory),
            ]),
            providerConnections,
            runtimeConnections,
            availableModelIds: mergedAvailableIds,
            opencodeBinaryInstalled,
            opencodeBinarySource,
            opencodeInventoryError: opencodeInventory.error,
            opencodeProviders: opencodeInventory.providers,
            opencodeProvidersStale: opencodeInventory.stale,
            modelsDevLastFetchedAt: getModelsDevLastFetchedAt(),
            customProviders: effectiveConfig?.ai?.customProviders,
            customModelSlugs: effectiveConfig?.ai?.customModelSlugs,
            piInstallation: piProfileInventory,
            apiKeyStore: timeSyncPhase("api_key_store_status", () => getApiKeyStoreStatus()),
          };
          if (requestGeneration === providerReadinessCacheGeneration) {
            statusCache = { result, cachedAt: Date.now(), runtimeHealthVersion };
          }
          logger.info("ai.status.summary", {
            ...phaseContext,
            durationMs: Date.now() - totalStartedAt,
            phaseCount: phases.length,
            phases: phaseSummary(),
            authCount: auth.length,
            availableModelCount: mergedAvailableIds.length,
            providerAvailability: availability,
            opencodeModelCount: opencodeInventory.modelIds.length,
          });
          return result;
        } catch (error) {
          logger.warn("ai.status.failed", {
            ...phaseContext,
            durationMs: Date.now() - totalStartedAt,
            phases: phaseSummary(),
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      })();

      statusRequestsInFlight.set(requestKey, request);
      try {
        return await request;
      } finally {
        if (statusRequestsInFlight.get(requestKey) === request) {
          statusRequestsInFlight.delete(requestKey);
        }
      }
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
    storeApiKey(provider: string, key: string): void {
      storeStoredApiKey(provider, key);
      if (provider.trim().toLowerCase() === "cursor") clearCursorCliModelsCache();
      invalidateProviderReadinessCaches();
    },
    deleteApiKey(provider: string): void {
      deleteStoredApiKey(provider);
      if (provider.trim().toLowerCase() === "cursor") clearCursorCliModelsCache();
      invalidateProviderReadinessCaches();
    },
    listApiKeys(): string[] {
      return listStoredProviders();
    },
    listCursorCloudRepositories,
    listCursorCloudAgents,
    listCursorCloudRuns,
    createCursorCloudRun,
    archiveCursorCloudAgent,
    unarchiveCursorCloudAgent,
    deleteCursorCloudAgent,
    getCursorCloudAgent,
    listCursorCloudArtifacts,
    downloadCursorCloudArtifact,

    getAvailabilityAsync,
    resolveModelForTask,
    invalidateProviderReadinessCaches,

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
      imagePaths?: string[];
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
      reasoningEffort?: string | null;
      imagePaths?: string[];
      jsonSchema?: unknown;
      systemPrompt?: string;
      taskType?: Extract<AiTaskType, "terminal_summary" | "session_title" | "session_summary" | "handoff_summary" | "continuity_summary" | "context_compaction">;
    }): Promise<ExecuteAiTaskResult> {
      return await executeReadOnlyOneShotTask({
        feature: "terminal_summaries",
        taskType: args.taskType ?? "terminal_summary",
        cwd: args.cwd,
        prompt: args.prompt,
        timeoutMs: args.timeoutMs,
        model: args.model,
        reasoningEffort: args.reasoningEffort,
        imagePaths: args.imagePaths,
        jsonSchema: args.jsonSchema,
        systemPrompt: args.systemPrompt
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
