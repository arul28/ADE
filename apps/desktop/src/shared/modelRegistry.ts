// ---------------------------------------------------------------------------
// Model Registry — single source of truth for all AI models
// ---------------------------------------------------------------------------

export type AuthType = "cli-subscription" | "api-key" | "oauth" | "openrouter" | "local";

export type ProviderFamily =
  | "anthropic"
  | "openai"
  | "google"
  | "mistral"
  | "deepseek"
  | "xai"
  | "meta"
  | "openrouter"
  | "ollama"
  | "lmstudio"
  | "vllm"
  | "groq"
  | "together";

export type ModelCapabilities = {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  streaming: boolean;
};

export type ModelDescriptor = {
  id: string;
  shortId: string;
  displayName: string;
  family: ProviderFamily;
  authTypes: AuthType[];
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: ModelCapabilities;
  reasoningTiers?: string[];
  color: string;
  sdkProvider: string;
  sdkModelId: string;
  cliCommand?: string;
  isCliWrapped: boolean;
  deprecated?: boolean;
};

// ---------------------------------------------------------------------------
// Registry data
// ---------------------------------------------------------------------------

const ALL_CAPS: ModelCapabilities = { tools: true, vision: true, reasoning: true, streaming: true };
const NO_REASONING: ModelCapabilities = { tools: true, vision: true, reasoning: false, streaming: true };
const BASIC_CAPS: ModelCapabilities = { tools: true, vision: false, reasoning: false, streaming: true };

export const MODEL_REGISTRY: ModelDescriptor[] = [
  // ---- Anthropic (CLI-wrapped via claude) ----
  // Note: "max" thinking is API-only for Opus; CLI subscribers get up to "high"
  {
    id: "anthropic/claude-opus-4-6",
    shortId: "opus",
    displayName: "Claude Opus 4.6",
    family: "anthropic",
    authTypes: ["cli-subscription"],
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high"],
    color: "#D97706",
    sdkProvider: "ai-sdk-provider-claude-code",
    sdkModelId: "opus",
    cliCommand: "claude",
    isCliWrapped: true,
  },
  {
    id: "anthropic/claude-sonnet-4-6",
    shortId: "sonnet",
    displayName: "Claude Sonnet 4.6",
    family: "anthropic",
    authTypes: ["cli-subscription"],
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "max"],
    color: "#8B5CF6",
    sdkProvider: "ai-sdk-provider-claude-code",
    sdkModelId: "sonnet",
    cliCommand: "claude",
    isCliWrapped: true,
  },
  {
    id: "anthropic/claude-haiku-4-5",
    shortId: "haiku",
    displayName: "Claude Haiku 4.5",
    family: "anthropic",
    authTypes: ["cli-subscription"],
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    capabilities: NO_REASONING,
    color: "#06B6D4",
    sdkProvider: "ai-sdk-provider-claude-code",
    sdkModelId: "haiku",
    cliCommand: "claude",
    isCliWrapped: true,
  },

  // ---- Anthropic (API key direct) ----
  {
    id: "anthropic/claude-opus-4-6-api",
    shortId: "opus-api",
    displayName: "Claude Opus 4.6 (API)",
    family: "anthropic",
    authTypes: ["api-key"],
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "max"],
    color: "#D97706",
    sdkProvider: "@ai-sdk/anthropic",
    sdkModelId: "claude-opus-4-6",
    isCliWrapped: false,
  },
  {
    id: "anthropic/claude-sonnet-4-6-api",
    shortId: "sonnet-api",
    displayName: "Claude Sonnet 4.6 (API)",
    family: "anthropic",
    authTypes: ["api-key"],
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "max"],
    color: "#8B5CF6",
    sdkProvider: "@ai-sdk/anthropic",
    sdkModelId: "claude-sonnet-4-6",
    isCliWrapped: false,
  },
  {
    id: "anthropic/claude-haiku-4-5-api",
    shortId: "haiku-api",
    displayName: "Claude Haiku 4.5 (API)",
    family: "anthropic",
    authTypes: ["api-key"],
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    capabilities: NO_REASONING,
    color: "#06B6D4",
    sdkProvider: "@ai-sdk/anthropic",
    sdkModelId: "claude-haiku-4-5-20251001",
    isCliWrapped: false,
  },

  // ---- OpenAI (CLI-wrapped via codex) ----
  // Codex reasoning tiers: minimal | low | medium | high | xhigh (per config.toml reference)
  // xhigh is model-dependent (gpt-5.1+ support it)
  {
    id: "openai/gpt-5.3-codex",
    shortId: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 192_000,
    maxOutputTokens: 16_384,
    capabilities: ALL_CAPS,
    reasoningTiers: ["minimal", "low", "medium", "high", "xhigh"],
    color: "#10B981",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "gpt-5.3-codex",
    cliCommand: "codex",
    isCliWrapped: true,
  },
  {
    id: "openai/gpt-5.3-codex-spark",
    shortId: "gpt-5.3-codex-spark",
    displayName: "GPT-5.3 Codex Spark",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 192_000,
    maxOutputTokens: 16_384,
    capabilities: { tools: true, vision: false, reasoning: true, streaming: true },
    reasoningTiers: ["minimal", "low", "medium"],
    color: "#34D399",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "gpt-5.3-codex-spark",
    cliCommand: "codex",
    isCliWrapped: true,
  },
  {
    id: "openai/gpt-5.2-codex",
    shortId: "gpt-5.2-codex",
    displayName: "GPT-5.2 Codex",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 192_000,
    maxOutputTokens: 16_384,
    capabilities: ALL_CAPS,
    reasoningTiers: ["minimal", "low", "medium", "high", "xhigh"],
    color: "#10B981",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "gpt-5.2-codex",
    cliCommand: "codex",
    isCliWrapped: true,
  },
  {
    id: "openai/gpt-5.1-codex-max",
    shortId: "gpt-5.1-codex-max",
    displayName: "GPT-5.1 Codex Max",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 192_000,
    maxOutputTokens: 16_384,
    capabilities: ALL_CAPS,
    reasoningTiers: ["minimal", "low", "medium", "high", "xhigh"],
    color: "#10B981",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "gpt-5.1-codex-max",
    cliCommand: "codex",
    isCliWrapped: true,
  },
  {
    id: "openai/codex-mini-latest",
    shortId: "codex-mini",
    displayName: "Codex Mini",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 192_000,
    maxOutputTokens: 16_384,
    capabilities: NO_REASONING,
    color: "#34D399",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "codex-mini-latest",
    cliCommand: "codex",
    isCliWrapped: true,
  },
  {
    id: "openai/o4-mini",
    shortId: "o4-mini",
    displayName: "o4-mini",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 192_000,
    maxOutputTokens: 16_384,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high"],
    color: "#6EE7B7",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "o4-mini",
    cliCommand: "codex",
    isCliWrapped: true,
  },
  {
    id: "openai/o3",
    shortId: "o3",
    displayName: "o3",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 192_000,
    maxOutputTokens: 16_384,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high"],
    color: "#059669",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "o3",
    cliCommand: "codex",
    isCliWrapped: true,
  },

  // ---- OpenAI (API key direct) ----
  {
    id: "openai/gpt-4.1",
    shortId: "gpt-4.1",
    displayName: "GPT-4.1",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    capabilities: NO_REASONING,
    color: "#10B981",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "gpt-4.1",
    isCliWrapped: false,
  },
  {
    id: "openai/gpt-4.1-mini",
    shortId: "gpt-4.1-mini",
    displayName: "GPT-4.1 Mini",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    capabilities: NO_REASONING,
    color: "#34D399",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "gpt-4.1-mini",
    isCliWrapped: false,
  },
  {
    id: "openai/o4-mini-api",
    shortId: "o4-mini-api",
    displayName: "o4-mini (API)",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high"],
    color: "#6EE7B7",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "o4-mini",
    isCliWrapped: false,
  },

  // ---- Google (Gemini 3.x — current) ----
  {
    id: "google/gemini-3.1-pro",
    shortId: "gemini-pro",
    displayName: "Gemini 3.1 Pro",
    family: "google",
    authTypes: ["api-key"],
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high"],
    color: "#F59E0B",
    sdkProvider: "@ai-sdk/google",
    sdkModelId: "gemini-3.1-pro-preview",
    isCliWrapped: false,
  },
  {
    id: "google/gemini-3-flash",
    shortId: "gemini-flash",
    displayName: "Gemini 3 Flash",
    family: "google",
    authTypes: ["api-key"],
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "high"],
    color: "#FBBF24",
    sdkProvider: "@ai-sdk/google",
    sdkModelId: "gemini-3-flash-preview",
    isCliWrapped: false,
  },

  // ---- Google (Gemini 2.x — deprecated, kept for backward compat) ----
  {
    id: "google/gemini-2.5-pro",
    shortId: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro (Legacy)",
    family: "google",
    authTypes: ["api-key"],
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    capabilities: ALL_CAPS,
    color: "#F59E0B",
    sdkProvider: "@ai-sdk/google",
    sdkModelId: "gemini-2.5-pro",
    isCliWrapped: false,
    deprecated: true,
  },
  {
    id: "google/gemini-2.5-flash",
    shortId: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash (Legacy)",
    family: "google",
    authTypes: ["api-key"],
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    capabilities: NO_REASONING,
    color: "#FBBF24",
    sdkProvider: "@ai-sdk/google",
    sdkModelId: "gemini-2.5-flash",
    isCliWrapped: false,
    deprecated: true,
  },

  // ---- DeepSeek ----
  {
    id: "deepseek/deepseek-r1",
    shortId: "deepseek-r1",
    displayName: "DeepSeek R1",
    family: "deepseek",
    authTypes: ["api-key"],
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    capabilities: { tools: true, vision: false, reasoning: true, streaming: true },
    color: "#3B82F6",
    sdkProvider: "@ai-sdk/deepseek",
    sdkModelId: "deepseek-reasoner",
    isCliWrapped: false,
  },
  {
    id: "deepseek/deepseek-chat",
    shortId: "deepseek-chat",
    displayName: "DeepSeek Chat",
    family: "deepseek",
    authTypes: ["api-key"],
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    capabilities: BASIC_CAPS,
    color: "#60A5FA",
    sdkProvider: "@ai-sdk/deepseek",
    sdkModelId: "deepseek-chat",
    isCliWrapped: false,
  },

  // ---- Mistral ----
  {
    id: "mistral/codestral-latest",
    shortId: "codestral",
    displayName: "Codestral",
    family: "mistral",
    authTypes: ["api-key"],
    contextWindow: 256_000,
    maxOutputTokens: 8_192,
    capabilities: BASIC_CAPS,
    color: "#F97316",
    sdkProvider: "@ai-sdk/mistral",
    sdkModelId: "codestral-latest",
    isCliWrapped: false,
  },

  // ---- xAI ----
  {
    id: "xai/grok-3",
    shortId: "grok-3",
    displayName: "Grok 3",
    family: "xai",
    authTypes: ["api-key"],
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    capabilities: ALL_CAPS,
    color: "#EF4444",
    sdkProvider: "@ai-sdk/xai",
    sdkModelId: "grok-3",
    isCliWrapped: false,
  },

  // ---- OpenRouter ----
  {
    id: "openrouter/auto",
    shortId: "openrouter-auto",
    displayName: "OpenRouter Auto",
    family: "openrouter",
    authTypes: ["openrouter"],
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    capabilities: ALL_CAPS,
    color: "#A855F7",
    sdkProvider: "@openrouter/ai-sdk-provider",
    sdkModelId: "openrouter/auto",
    isCliWrapped: false,
  },

  // ---- Local (Ollama) ----
  {
    id: "ollama/llama-3.3",
    shortId: "llama-3.3",
    displayName: "Llama 3.3 (Local)",
    family: "ollama",
    authTypes: ["local"],
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    capabilities: BASIC_CAPS,
    color: "#71717A",
    sdkProvider: "@ai-sdk/openai-compatible",
    sdkModelId: "auto",
    isCliWrapped: false,
  },
  {
    id: "lmstudio/auto",
    shortId: "lmstudio-auto",
    displayName: "LM Studio (Auto)",
    family: "lmstudio",
    authTypes: ["local"],
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    capabilities: BASIC_CAPS,
    color: "#64748B",
    sdkProvider: "@ai-sdk/openai-compatible",
    sdkModelId: "auto",
    isCliWrapped: false,
  },
  {
    id: "vllm/auto",
    shortId: "vllm-auto",
    displayName: "vLLM (Auto)",
    family: "vllm",
    authTypes: ["local"],
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    capabilities: BASIC_CAPS,
    color: "#475569",
    sdkProvider: "@ai-sdk/openai-compatible",
    sdkModelId: "auto",
    isCliWrapped: false,
  },
];

// ---------------------------------------------------------------------------
// Index maps (built once, refreshed on enrichment)
// ---------------------------------------------------------------------------

let byId = new Map<string, ModelDescriptor>();
let byShortId = new Map<string, ModelDescriptor>();

function rebuildIndexes() {
  byId = new Map<string, ModelDescriptor>();
  byShortId = new Map<string, ModelDescriptor>();
  for (const m of MODEL_REGISTRY) {
    byId.set(m.id, m);
    byShortId.set(m.shortId, m);
  }
}

rebuildIndexes();

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

export function getModelById(id: string): ModelDescriptor | undefined {
  return byId.get(id);
}

export function getModelsByFamily(family: ProviderFamily): ModelDescriptor[] {
  return MODEL_REGISTRY.filter((m) => m.family === family);
}

export function getModelsByAuth(authType: AuthType): ModelDescriptor[] {
  return MODEL_REGISTRY.filter((m) => m.authTypes.includes(authType));
}

export function getDefaultModel(authType: AuthType): ModelDescriptor {
  const defaults: Partial<Record<AuthType, string>> = {
    "cli-subscription": "anthropic/claude-sonnet-4-6",
    "api-key": "anthropic/claude-sonnet-4-6-api",
    openrouter: "openrouter/auto",
    local: "ollama/llama-3.3",
  };
  const id = defaults[authType];
  if (id) {
    const model = byId.get(id);
    if (model) return model;
  }
  const candidates = getModelsByAuth(authType);
  if (candidates.length > 0) return candidates[0];
  return MODEL_REGISTRY[0];
}

export function getAvailableModels(
  detectedAuth: Array<{ type: AuthType; cli?: string; provider?: string }>,
): ModelDescriptor[] {
  const hasAuth = (matcher: (auth: { type: AuthType; cli?: string; provider?: string }) => boolean): boolean =>
    detectedAuth.some((auth) => matcher(auth));

  const hasMappedCli = (family: ProviderFamily): boolean => {
    const requiredCli = family === "openai"
      ? "codex"
      : family === "anthropic"
        ? "claude"
        : family === "google"
          ? "gemini"
          : null;
    if (!requiredCli) return hasAuth((auth) => auth.type === "cli-subscription");
    return hasAuth(
      (auth) => auth.type === "cli-subscription" && (!auth.cli || auth.cli === requiredCli)
    );
  };

  const hasMappedLocal = (family: ProviderFamily): boolean => {
    const requiredProvider = family === "ollama" || family === "lmstudio" || family === "vllm"
      ? family
      : null;
    if (!requiredProvider) return hasAuth((auth) => auth.type === "local");
    return hasAuth(
      (auth) => auth.type === "local" && (!auth.provider || auth.provider === requiredProvider)
    );
  };

  const hasAuthForModel = (model: ModelDescriptor): boolean =>
    model.authTypes.some((authType) => {
      if (authType === "cli-subscription") return hasMappedCli(model.family);
      if (authType === "api-key") {
        return hasAuth(
          (auth) => auth.type === "api-key" && (!auth.provider || auth.provider === model.family)
        );
      }
      if (authType === "openrouter") return hasAuth((auth) => auth.type === "openrouter");
      if (authType === "local") return hasMappedLocal(model.family);
      if (authType === "oauth") return hasAuth((auth) => auth.type === "oauth");
      return false;
    });

  return MODEL_REGISTRY.filter((model) => !model.deprecated && hasAuthForModel(model));
}

export function resolveModelAlias(alias: string): ModelDescriptor | undefined {
  const normalized = alias.trim().toLowerCase();
  const direct = byId.get(normalized) ?? byShortId.get(normalized);
  if (direct) return direct;

  // Legacy unprefixed Claude IDs (kept for backward compatibility).
  if (normalized.includes("claude-sonnet")) {
    return byId.get("anthropic/claude-sonnet-4-6");
  }
  if (normalized.includes("claude-opus")) {
    return byId.get("anthropic/claude-opus-4-6");
  }
  if (normalized.includes("claude-haiku")) {
    return byId.get("anthropic/claude-haiku-4-5");
  }

  return undefined;
}

/**
 * Given a model ID, return all non-deprecated models in the same family.
 * Used to restrict mid-session model changes to compatible models only.
 */
export function getCompatibleModels(currentModelId: string): ModelDescriptor[] {
  const current = byId.get(currentModelId);
  if (!current) return MODEL_REGISTRY.filter((m) => !m.deprecated);
  return MODEL_REGISTRY.filter((m) => !m.deprecated && m.family === current.family);
}

// ---------------------------------------------------------------------------
// Runtime enrichment — mutate existing entries in-place with fresh data
// ---------------------------------------------------------------------------

export type ModelEnrichment = {
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: Partial<ModelCapabilities>;
};

/**
 * Enrich existing registry entries in-place with fresh data (e.g. from models.dev).
 * Only updates fields that are provided and truthy.
 */
export function enrichModelRegistry(enrichments: Map<string, ModelEnrichment>): number {
  let updated = 0;
  for (const descriptor of MODEL_REGISTRY) {
    const enrichment = enrichments.get(descriptor.sdkModelId);
    if (!enrichment) continue;

    if (enrichment.contextWindow && enrichment.contextWindow > 0) {
      descriptor.contextWindow = enrichment.contextWindow;
    }
    if (enrichment.maxOutputTokens && enrichment.maxOutputTokens > 0) {
      descriptor.maxOutputTokens = enrichment.maxOutputTokens;
    }
    if (enrichment.capabilities) {
      Object.assign(descriptor.capabilities, enrichment.capabilities);
    }
    updated++;
  }
  return updated;
}

// ---------------------------------------------------------------------------
// MODEL_FAMILIES — UI grouping with display names and icons
// ---------------------------------------------------------------------------

export const MODEL_FAMILIES: Record<
  ProviderFamily,
  { displayName: string; icon: string }
> = {
  anthropic: { displayName: "Anthropic", icon: "anthropic" },
  openai: { displayName: "OpenAI", icon: "openai" },
  google: { displayName: "Google", icon: "google" },
  mistral: { displayName: "Mistral", icon: "mistral" },
  deepseek: { displayName: "DeepSeek", icon: "deepseek" },
  xai: { displayName: "xAI", icon: "xai" },
  meta: { displayName: "Meta", icon: "meta" },
  openrouter: { displayName: "OpenRouter", icon: "openrouter" },
  ollama: { displayName: "Ollama", icon: "ollama" },
  lmstudio: { displayName: "LM Studio", icon: "lmstudio" },
  vllm: { displayName: "vLLM", icon: "vllm" },
  groq: { displayName: "Groq", icon: "groq" },
  together: { displayName: "Together", icon: "together" },
};
