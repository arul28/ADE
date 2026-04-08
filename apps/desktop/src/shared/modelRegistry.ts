// ---------------------------------------------------------------------------
// Model Registry — single source of truth for all AI models
// ---------------------------------------------------------------------------

export type AuthType = "cli-subscription" | "api-key" | "oauth" | "openrouter" | "local";

export type ProviderFamily =
  | "anthropic"
  | "openai"
  | "opencode"
  | "google"
  | "mistral"
  | "deepseek"
  | "xai"
  | "groq"
  | "together"
  | "openrouter"
  | "ollama"
  | "lmstudio"
  | "cursor";

export type LocalProviderFamily = Extract<ProviderFamily, "ollama" | "lmstudio">;

export type ModelCapabilities = {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  streaming: boolean;
};

export type LocalModelHarnessProfile = "verified" | "guarded" | "read_only";

export type ModelDescriptor = {
  id: string;
  shortId: string;
  aliases?: string[];
  displayName: string;
  family: ProviderFamily;
  authTypes: AuthType[];
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: ModelCapabilities;
  reasoningTiers?: string[];
  color: string;
  providerRoute: string;
  providerModelId: string;
  cliCommand?: string;
  isCliWrapped: boolean;
  deprecated?: boolean;
  /** Price per million input tokens (USD). Used for cost estimation. */
  inputPricePer1M?: number;
  /** Price per million output tokens (USD). Used for cost estimation. */
  outputPricePer1M?: number;
  /** Curated cost tier for UI display (missions model selector) */
  costTier?: "low" | "medium" | "high" | "very_high";
  /** ADE-owned safety/tooling profile for local and experimental models. */
  harnessProfile?: LocalModelHarnessProfile;
  /** Source of runtime-discovered descriptors for debugging and UI hints. */
  discoverySource?: "lmstudio-rest" | "lmstudio-openai" | "ollama";
  /** OpenCode server routing: upstream provider id (e.g. anthropic, lmstudio, opencode). */
  openCodeProviderId?: string;
  /** OpenCode server routing: model id as reported by OpenCode (may contain `/`). */
  openCodeModelId?: string;
};

export type DynamicLocalModelDescriptorOptions = {
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: Partial<ModelCapabilities>;
  reasoningTiers?: string[];
  aliases?: string[];
  harnessProfile?: LocalModelHarnessProfile;
  discoverySource?: ModelDescriptor["discoverySource"];
};

export type WorkerExecutionPath = "cli" | "api" | "local";
export type ModelProviderGroup = "claude" | "codex" | "opencode" | "cursor";

export function isModelProviderGroup(value: string | null | undefined): value is ModelProviderGroup {
  return value === "claude" || value === "codex" || value === "opencode" || value === "cursor";
}

// ---------------------------------------------------------------------------
// Registry data
// ---------------------------------------------------------------------------

const ALL_CAPS: ModelCapabilities = { tools: true, vision: true, reasoning: true, streaming: true };
const NO_REASONING: ModelCapabilities = { tools: true, vision: true, reasoning: false, streaming: true };
const BASIC_CAPS: ModelCapabilities = { tools: true, vision: false, reasoning: false, streaming: true };
/** Human-readable names for Ollama / LM Studio (shared across main, renderer, and MCP). */
export const LOCAL_PROVIDER_LABELS: Record<LocalProviderFamily, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
};
const LOCAL_PROVIDER_COLORS: Record<LocalProviderFamily, string> = {
  ollama: "#71717A",
  lmstudio: "#64748B",
};
const LOCAL_PROVIDER_ENDPOINTS: Record<LocalProviderFamily, string> = {
  ollama: "http://localhost:11434",
  lmstudio: "http://127.0.0.1:1234",
};

export const MODEL_REGISTRY: ModelDescriptor[] = [
  // ---- Anthropic (CLI-wrapped via claude) ----
  // Claude chat surfaces in ADE use the native low/medium/high effort ladder.
  {
    id: "anthropic/claude-opus-4-6",
    shortId: "opus",
    displayName: "Claude Opus 4.6",
    family: "anthropic",
    authTypes: ["cli-subscription"],
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "max"],
    color: "#D97706",
    providerRoute: "claude-cli",
    providerModelId: "opus",
    cliCommand: "claude",
    isCliWrapped: true,
    inputPricePer1M: 5,
    outputPricePer1M: 25,
    costTier: "very_high",
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
    reasoningTiers: ["low", "medium", "high"],
    color: "#8B5CF6",
    providerRoute: "claude-cli",
    providerModelId: "sonnet",
    cliCommand: "claude",
    isCliWrapped: true,
    inputPricePer1M: 3,
    outputPricePer1M: 15,
    costTier: "medium",
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
    providerRoute: "claude-cli",
    providerModelId: "haiku",
    cliCommand: "claude",
    isCliWrapped: true,
    inputPricePer1M: 0.8,
    outputPricePer1M: 4,
    costTier: "low",
  },

  // ---- OpenAI (CLI-wrapped via codex) ----
  // ADE codex chat surfaces expose a consistent ladder:
  // low | medium | high | xhigh, except GPT-5.1-Codex-Mini which only exposes medium | high.
  {
    id: "openai/gpt-5.4-codex",
    shortId: "gpt-5.4-codex",
    aliases: ["gpt-5.4-codex"],
    displayName: "GPT-5.4",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "xhigh"],
    color: "#10A37F",
    providerRoute: "codex-cli",
    providerModelId: "gpt-5.4",
    cliCommand: "codex",
    isCliWrapped: true,
    costTier: "high",
  },
  {
    id: "openai/gpt-5.4-mini-codex",
    shortId: "gpt-5.4-mini-codex",
    aliases: ["gpt-5.4-mini-codex"],
    displayName: "GPT-5.4-Mini",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "xhigh"],
    color: "#34D399",
    providerRoute: "codex-cli",
    providerModelId: "gpt-5.4-mini",
    cliCommand: "codex",
    isCliWrapped: true,
    inputPricePer1M: 0.25,
    outputPricePer1M: 2,
    costTier: "low",
  },
  {
    id: "openai/gpt-5.3-codex",
    shortId: "gpt-5.3-codex",
    displayName: "GPT-5.3-Codex",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "xhigh"],
    color: "#10B981",
    providerRoute: "codex-cli",
    providerModelId: "gpt-5.3-codex",
    cliCommand: "codex",
    isCliWrapped: true,
    inputPricePer1M: 1.5,
    outputPricePer1M: 6,
    costTier: "high",
  },
  {
    id: "openai/gpt-5.3-codex-spark",
    shortId: "gpt-5.3-codex-spark",
    displayName: "GPT-5.3-Codex-Spark",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 192_000,
    maxOutputTokens: 16_384,
    capabilities: { tools: true, vision: false, reasoning: true, streaming: true },
    reasoningTiers: ["low", "medium", "high", "xhigh"],
    color: "#34D399",
    providerRoute: "codex-cli",
    providerModelId: "gpt-5.3-codex-spark",
    cliCommand: "codex",
    isCliWrapped: true,
    inputPricePer1M: 1,
    outputPricePer1M: 4,
    costTier: "medium",
  },
  {
    id: "openai/gpt-5.2-codex",
    shortId: "gpt-5.2-codex",
    displayName: "GPT-5.2-Codex",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "xhigh"],
    color: "#10B981",
    providerRoute: "codex-cli",
    providerModelId: "gpt-5.2-codex",
    cliCommand: "codex",
    isCliWrapped: true,
    inputPricePer1M: 1.5,
    outputPricePer1M: 6,
    costTier: "medium",
  },
  {
    id: "openai/gpt-5.1-codex-max",
    shortId: "gpt-5.1-codex-max",
    displayName: "GPT-5.1-Codex-Max",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 192_000,
    maxOutputTokens: 16_384,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "xhigh"],
    color: "#10B981",
    providerRoute: "codex-cli",
    providerModelId: "gpt-5.1-codex-max",
    cliCommand: "codex",
    isCliWrapped: true,
    inputPricePer1M: 3,
    outputPricePer1M: 12,
    costTier: "high",
  },
  {
    id: "openai/gpt-5.1-codex-mini",
    shortId: "gpt-5.1-codex-mini",
    displayName: "GPT-5.1-Codex-Mini",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["medium", "high"],
    color: "#2DD4BF",
    providerRoute: "codex-cli",
    providerModelId: "gpt-5.1-codex-mini",
    cliCommand: "codex",
    isCliWrapped: true,
    inputPricePer1M: 0.25,
    outputPricePer1M: 2,
    costTier: "low",
  },

  // ---- Cursor CLI models: discovered at runtime via `agent models` (see cursorModelsDiscovery + getResolvedAvailableModels) ----

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
    providerRoute: "openai-compatible",
    providerModelId: "auto",
    harnessProfile: "guarded",
    isCliWrapped: false,
  },
];

// ---------------------------------------------------------------------------
// Index maps (built once, refreshed on enrichment)
// ---------------------------------------------------------------------------

let byId = new Map<string, ModelDescriptor>();
let byShortId = new Map<string, ModelDescriptor | null>();
let byAlias = new Map<string, ModelDescriptor>();
let bySdkModelId = new Map<string, ModelDescriptor>();
let dynamicOpenCodeById = new Map<string, ModelDescriptor>();
let dynamicOpenCodeByAlias = new Map<string, ModelDescriptor>();

function rebuildIndexes() {
  byId = new Map<string, ModelDescriptor>();
  byShortId = new Map<string, ModelDescriptor | null>();
  byAlias = new Map<string, ModelDescriptor>();
  bySdkModelId = new Map<string, ModelDescriptor>();
  for (const m of MODEL_REGISTRY) {
    byId.set(m.id, m);
    const existingShortId = byShortId.get(m.shortId);
    if (existingShortId) {
      byShortId.set(m.shortId, null);
    } else if (!byShortId.has(m.shortId)) {
      byShortId.set(m.shortId, m);
    }
    bySdkModelId.set(m.providerModelId, m);
    for (const alias of m.aliases ?? []) {
      const normalized = alias.trim().toLowerCase();
      if (normalized.length) byAlias.set(normalized, m);
    }
  }
}

export function validateModelRegistry(models: ModelDescriptor[] = MODEL_REGISTRY): void {
  const ids = new Set<string>();
  const aliases = new Set<string>();

  for (const model of models) {
    if (!model.id.trim()) {
      throw new Error("Model registry contains an entry with an empty id.");
    }
    if (ids.has(model.id)) {
      throw new Error(`Model registry contains a duplicate id: ${model.id}`);
    }
    ids.add(model.id);

    if (!model.shortId.trim()) {
      throw new Error(`Model registry entry ${model.id} is missing a shortId.`);
    }

    for (const alias of model.aliases ?? []) {
      const normalizedAlias = alias.trim().toLowerCase();
      if (!normalizedAlias) continue;
      if (aliases.has(normalizedAlias)) {
        throw new Error(`Model registry contains a duplicate alias: ${normalizedAlias}`);
      }
      aliases.add(normalizedAlias);
    }
  }
}

validateModelRegistry();
rebuildIndexes();

export function isLocalProviderFamily(value: string): value is LocalProviderFamily {
  return value === "ollama" || value === "lmstudio";
}

/** First path segment of `provider/modelId` when it is a known local provider. */
export function parseLocalProviderFromModelId(modelId: string): LocalProviderFamily | null {
  const provider = String(modelId ?? "").trim().split("/", 1)[0]?.toLowerCase() ?? "";
  return isLocalProviderFamily(provider) ? provider : null;
}

/** Model name segment after `provider/` for local refs; empty string if missing. */
export function getLocalModelIdTail(modelId: string, provider: LocalProviderFamily): string {
  return String(modelId ?? "").trim().slice(provider.length + 1).trim();
}

/**
 * Descriptor for OpenCode permission/runtime decisions when the registry has no row yet.
 * `getModelById` returns undefined for refs such as `ollama/auto`; this still returns a
 * guarded local descriptor so the UI matches main-process harness behavior.
 */
export function getModelDescriptorForPermissionMode(modelId: string): ModelDescriptor | undefined {
  const resolved = getModelById(modelId);
  if (resolved) return resolved;
  const provider = parseLocalProviderFromModelId(modelId);
  if (!provider) return undefined;
  const tail = getLocalModelIdTail(modelId, provider);
  if (!tail.length || tail === "auto") {
    return createDynamicLocalModelDescriptor(provider, "auto", { harnessProfile: "guarded" });
  }
  return createDynamicLocalModelDescriptor(provider, tail);
}

function parseDynamicLocalModelRef(modelRef: string): { provider: LocalProviderFamily; modelId: string } | null {
  const normalized = modelRef.trim();
  if (!normalized.length) return null;
  const separatorIndex = normalized.indexOf("/");
  if (separatorIndex <= 0) return null;
  const provider = normalized.slice(0, separatorIndex).trim().toLowerCase();
  if (!isLocalProviderFamily(provider)) return null;
  const modelId = normalized.slice(separatorIndex + 1).trim();
  if (!modelId.length || modelId === "auto") return null;
  return { provider, modelId };
}

function toDynamicLocalDisplayName(provider: LocalProviderFamily, modelId: string): string {
  return `${modelId} (${LOCAL_PROVIDER_LABELS[provider]})`;
}

export function createDynamicLocalModelDescriptor(
  provider: LocalProviderFamily,
  modelId: string,
  options?: DynamicLocalModelDescriptorOptions,
): ModelDescriptor {
  const normalizedModelId = modelId.trim();
  const displayName = options?.displayName?.trim() || toDynamicLocalDisplayName(provider, normalizedModelId);
  const capabilities: ModelCapabilities = {
    ...BASIC_CAPS,
    ...(options?.capabilities ?? {}),
  };
  const aliases = [
    `${provider}:${normalizedModelId}`,
    ...(options?.aliases ?? []),
  ].filter((value, index, list) => {
    const normalized = value.trim();
    return normalized.length > 0 && list.findIndex((entry) => entry.trim().toLowerCase() === normalized.toLowerCase()) === index;
  });
  return {
    id: `${provider}/${normalizedModelId}`,
    shortId: normalizedModelId,
    displayName,
    family: provider,
    authTypes: ["local"],
    contextWindow: options?.contextWindow ?? 128_000,
    maxOutputTokens: options?.maxOutputTokens ?? 8_192,
    capabilities,
    color: LOCAL_PROVIDER_COLORS[provider],
    providerRoute: "openai-compatible",
    providerModelId: normalizedModelId,
    ...(options?.reasoningTiers?.length ? { reasoningTiers: [...options.reasoningTiers] } : {}),
    aliases,
    isCliWrapped: false,
    harnessProfile: options?.harnessProfile ?? "guarded",
    ...(options?.discoverySource ? { discoverySource: options.discoverySource } : {}),
  };
}

export type DynamicOpenCodeModelDescriptorOptions = {
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: Partial<ModelCapabilities>;
  reasoningTiers?: string[];
  aliases?: string[];
  color?: string;
  /** When set with openCodeModelId, registry id is derived so model ids may contain `/`. */
  openCodeProviderId?: string;
  openCodeModelId?: string;
};

/** Stable ADE id for an OpenCode-backed model: `opencode/<providerId>/<encodeURIComponent(modelId)>`. */
export function encodeOpenCodeRegistryId(openCodeProviderId: string, openCodeModelId: string): string {
  const p = openCodeProviderId.trim();
  const m = openCodeModelId.trim();
  return `opencode/${p}/${encodeURIComponent(m)}`;
}

export function decodeOpenCodeRegistryId(id: string): { openCodeProviderId: string; openCodeModelId: string } | null {
  const trimmed = id.trim();
  const prefix = "opencode/";
  if (!trimmed.toLowerCase().startsWith(prefix)) return null;
  const rest = trimmed.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash >= rest.length - 1) return null;
  const providerId = rest.slice(0, slash);
  const encodedModel = rest.slice(slash + 1);
  try {
    const modelId = decodeURIComponent(encodedModel);
    if (!providerId.trim().length || !modelId.trim().length) return null;
    return { openCodeProviderId: providerId, openCodeModelId: modelId };
  } catch {
    return null;
  }
}

function formatOpenCodeDisplayName(modelId: string): string {
  return modelId
    .split(/[-_/]+/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function parseDynamicOpenCodeModelRef(modelId: string): { modelId: string } | null {
  if (decodeOpenCodeRegistryId(modelId)) return null;
  const trimmed = modelId.trim();
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith("opencode/")) return null;
  const raw = trimmed.slice("opencode/".length).trim();
  if (!raw.length) return null;
  return { modelId: raw };
}

/** Map an OpenCode upstream provider ID to the ADE ProviderFamily for correct grouping and display. */
const OPENCODE_PROVIDER_FAMILY_MAP: Record<string, ProviderFamily> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  mistral: "mistral",
  deepseek: "deepseek",
  xai: "xai",
  openrouter: "openrouter",
  ollama: "ollama",
  lmstudio: "lmstudio",
  groq: "groq",
  together: "together",
};

const OPENCODE_PROVIDER_COLORS: Record<string, string> = {
  anthropic: "#D97706",
  openai: "#10A37F",
  google: "#F59E0B",
  mistral: "#F97316",
  deepseek: "#3B82F6",
  xai: "#DC2626",
  openrouter: "#6B7280",
  ollama: "#71717A",
  lmstudio: "#64748B",
  groq: "#06B6D4",
  together: "#22C55E",
};

const LOCAL_OPENCODE_PROVIDERS = new Set(["ollama", "lmstudio"]);

export function createDynamicOpenCodeModelDescriptor(
  modelId: string,
  options?: DynamicOpenCodeModelDescriptorOptions,
): ModelDescriptor {
  const opPid = options?.openCodeProviderId?.trim();
  const opMid = options?.openCodeModelId?.trim();
  const normalizedModelId = modelId.trim();
  const usesPairedIds = Boolean(opPid && opMid);
  const id = usesPairedIds ? encodeOpenCodeRegistryId(opPid!, opMid!) : `opencode/${normalizedModelId}`;
  const shortId = usesPairedIds ? opMid! : normalizedModelId;
  const providerModelId = usesPairedIds ? `${opPid}/${opMid}` : normalizedModelId;
  const displayName =
    options?.displayName?.trim()
    || (usesPairedIds ? formatOpenCodeDisplayName(opMid!) : formatOpenCodeDisplayName(normalizedModelId));
  const capabilities: ModelCapabilities = {
    tools: options?.capabilities?.tools ?? true,
    vision: options?.capabilities?.vision ?? false,
    reasoning: options?.capabilities?.reasoning ?? true,
    streaming: options?.capabilities?.streaming ?? true,
  };
  const aliases = options?.aliases?.map((alias) => alias.trim()).filter(Boolean) ?? [];
  const family: ProviderFamily = (opPid && OPENCODE_PROVIDER_FAMILY_MAP[opPid]) || "opencode";
  const isLocal = opPid ? LOCAL_OPENCODE_PROVIDERS.has(opPid) : false;
  const authTypes: AuthType[] = isLocal ? ["local"] : ["api-key"];
  const color = options?.color ?? (opPid && OPENCODE_PROVIDER_COLORS[opPid]) ?? "#2563EB";
  return {
    id,
    shortId,
    displayName,
    family,
    authTypes,
    contextWindow: options?.contextWindow ?? 200_000,
    maxOutputTokens: options?.maxOutputTokens ?? 32_000,
    capabilities,
    color,
    providerRoute: "opencode",
    providerModelId,
    ...(usesPairedIds ? { openCodeProviderId: opPid, openCodeModelId: opMid } : {}),
    ...(options?.reasoningTiers?.length ? { reasoningTiers: [...options.reasoningTiers] } : {}),
    ...(aliases.length ? { aliases } : {}),
    isCliWrapped: false,
  };
}

function isDynamicOpenCodeDescriptor(descriptor: ModelDescriptor): boolean {
  return (descriptor.openCodeProviderId != null || descriptor.providerRoute === "opencode") && !byId.has(descriptor.id);
}

export function replaceDynamicOpenCodeModelDescriptors(descriptors: ModelDescriptor[]): void {
  dynamicOpenCodeById = new Map<string, ModelDescriptor>();
  dynamicOpenCodeByAlias = new Map<string, ModelDescriptor>();

  for (const descriptor of descriptors) {
    if (!isDynamicOpenCodeDescriptor(descriptor)) continue;
    dynamicOpenCodeById.set(descriptor.id, descriptor);
    for (const alias of descriptor.aliases ?? []) {
      const normalized = alias.trim().toLowerCase();
      if (normalized.length) dynamicOpenCodeByAlias.set(normalized, descriptor);
    }
  }
}

export function getDynamicOpenCodeModelDescriptors(): ModelDescriptor[] {
  return [...dynamicOpenCodeById.values()];
}

export function getLocalProviderDefaultEndpoint(provider: LocalProviderFamily): string {
  return LOCAL_PROVIDER_ENDPOINTS[provider];
}

/**
 * Ensures a local provider endpoint includes the `/v1` suffix required by
 * `@ai-sdk/openai-compatible` (which appends `/chat/completions` directly).
 * Safe to call on endpoints that already end with `/v1`.
 */
export function ensureOpenCodeBaseURL(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) return trimmed;
  return `${trimmed}/v1`;
}

// ---------------------------------------------------------------------------
// Cursor CLI — dynamic descriptors (`cursor/<providerModelId>` from `agent models`)
// ---------------------------------------------------------------------------

export type CursorCliLineGroup = "auto" | "anthropic" | "composer" | "openai" | "google" | "grok" | "other";

/** Order of Cursor CLI sub-sections inside the subscription bucket model picker. */
export const CURSOR_CLI_LINE_ORDER: CursorCliLineGroup[] = [
  "auto",
  "anthropic",
  "composer",
  "openai",
  "google",
  "grok",
  "other",
];

export function cursorCliLineGroupFromSdkId(providerModelId: string): CursorCliLineGroup {
  const s = providerModelId.trim().toLowerCase();
  if (s === "auto") return "auto";
  if (s.includes("composer")) return "composer";
  if (/claude|sonnet|opus|haiku/.test(s)) return "anthropic";
  if (/gemini/.test(s)) return "google";
  if (/grok/.test(s)) return "grok";
  if (/^gpt|^o\d|codex/.test(s)) return "openai";
  return "other";
}

export function cursorCliLineGroupLabel(group: CursorCliLineGroup): string {
  const labels: Record<CursorCliLineGroup, string> = {
    auto: "Auto",
    anthropic: "Anthropic (via Cursor)",
    composer: "Cursor Composer",
    openai: "OpenAI (via Cursor)",
    google: "Google (via Cursor)",
    grok: "xAI Grok (via Cursor)",
    other: "Other (via Cursor)",
  };
  return labels[group] ?? "Cursor";
}

function formatCursorSdkFallbackDisplayName(providerModelId: string): string {
  return providerModelId
    .split(/[-_/]+/g)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function colorForCursorSdkId(providerModelId: string): string {
  const s = providerModelId.toLowerCase();
  if (s === "auto") return "#A78BFA";
  if (/claude|sonnet|opus|haiku/.test(s)) return "#D97706";
  if (/composer/.test(s)) return "#8B5CF6";
  if (/gemini/.test(s)) return "#4285F4";
  if (/grok/.test(s)) return "#1DA1F2";
  if (/^gpt|^o\d|codex/.test(s)) return "#10A37F";
  return "#71717A";
}

export function parseDynamicCursorModelRef(modelId: string): { providerModelId: string } | null {
  const trimmed = modelId.trim();
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith("cursor/")) return null;
  const sdk = trimmed.slice("cursor/".length).trim();
  if (!sdk.length) return null;
  if (!/^[\w.-]+$/i.test(sdk)) return null;
  return { providerModelId: sdk };
}

export function createDynamicCursorCliModelDescriptor(
  providerModelId: string,
  cliDisplayName?: string | null,
): ModelDescriptor {
  const id = `cursor/${providerModelId}`;
  const display =
    typeof cliDisplayName === "string" && cliDisplayName.trim().length
      ? cliDisplayName.trim()
      : formatCursorSdkFallbackDisplayName(providerModelId);
  return {
    id,
    shortId: providerModelId,
    displayName: display,
    family: "cursor",
    authTypes: ["cli-subscription"],
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    capabilities: ALL_CAPS,
    color: colorForCursorSdkId(providerModelId),
    providerRoute: "cursor-cli",
    providerModelId,
    cliCommand: "cursor",
    isCliWrapped: true,
  };
}

/** Sort Cursor CLI models for pickers: line group order, then display name. */
export function sortCursorCliDescriptorsForPicker(descriptors: ModelDescriptor[]): ModelDescriptor[] {
  const rank = (g: CursorCliLineGroup) => {
    const i = CURSOR_CLI_LINE_ORDER.indexOf(g);
    return i === -1 ? CURSOR_CLI_LINE_ORDER.length : i;
  };
  return [...descriptors].sort((a, b) => {
    const ga = cursorCliLineGroupFromSdkId(a.providerModelId);
    const gb = cursorCliLineGroupFromSdkId(b.providerModelId);
    const ra = rank(ga);
    const rb = rank(gb);
    if (ra !== rb) return ra - rb;
    return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
  });
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

export function getModelById(id: string): ModelDescriptor | undefined {
  const cached = byId.get(id);
  if (cached) return cached;
  const dynamicOpenCode = dynamicOpenCodeById.get(id);
  if (dynamicOpenCode) return dynamicOpenCode;
  const openCodeDecoded = decodeOpenCodeRegistryId(id);
  if (openCodeDecoded) {
    return createDynamicOpenCodeModelDescriptor("", {
      openCodeProviderId: openCodeDecoded.openCodeProviderId,
      openCodeModelId: openCodeDecoded.openCodeModelId,
    });
  }
  const local = parseDynamicLocalModelRef(id);
  if (local) return createDynamicLocalModelDescriptor(local.provider, local.modelId);
  const openCode = parseDynamicOpenCodeModelRef(id);
  if (openCode) return createDynamicOpenCodeModelDescriptor(openCode.modelId);
  const cursor = parseDynamicCursorModelRef(id);
  return cursor ? createDynamicCursorCliModelDescriptor(cursor.providerModelId) : undefined;
}

export function getAvailableModels(
  detectedAuth: Array<{ type: AuthType; cli?: string; provider?: string; authenticated?: boolean }>,
): ModelDescriptor[] {
  const hasAuth = (matcher: (auth: { type: AuthType; cli?: string; provider?: string; authenticated?: boolean }) => boolean): boolean =>
    detectedAuth.some((auth) => matcher(auth));

  const FAMILY_TO_CLI: Partial<Record<ProviderFamily, string>> = {
    openai: "codex",
    anthropic: "claude",
    google: "gemini",
    cursor: "cursor",
  };

  const hasMappedCli = (family: ProviderFamily): boolean => {
    const requiredCli = FAMILY_TO_CLI[family] ?? null;
    if (!requiredCli) return hasAuth((auth) => auth.type === "cli-subscription" && auth.authenticated !== false);
    return hasAuth(
      (auth) => auth.type === "cli-subscription" && auth.authenticated !== false && (!auth.cli || auth.cli === requiredCli)
    );
  };

  const hasMappedLocal = (family: ProviderFamily): boolean => {
    const requiredProvider = family === "ollama" || family === "lmstudio"
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

  const staticModels = MODEL_REGISTRY.filter((model) => !model.deprecated && hasAuthForModel(model));
  const dynamicOpenCodeLocals = getDynamicOpenCodeModelDescriptors().filter(
    (model) => model.authTypes.includes("local") && hasAuthForModel(model),
  );
  if (!dynamicOpenCodeLocals.length) return staticModels;

  const providersWithDynamicLocals = new Set(dynamicOpenCodeLocals.map((model) => model.family));
  const filteredStatic = staticModels.filter(
    (model) => !(model.authTypes.includes("local") && providersWithDynamicLocals.has(model.family)),
  );
  return [...filteredStatic, ...dynamicOpenCodeLocals];
}

export function resolveModelAlias(alias: string): ModelDescriptor | undefined {
  const normalized = alias.trim().toLowerCase();
  return byId.get(normalized)
    ?? byShortId.get(normalized)
    ?? byAlias.get(normalized)
    ?? dynamicOpenCodeByAlias.get(normalized)
    ?? undefined;
}

export function resolveModelDescriptor(modelRef: string): ModelDescriptor | undefined {
  const normalized = modelRef.trim();
  if (!normalized.length) return undefined;
  return getModelById(normalized) ?? resolveModelAlias(normalized);
}

function matchesProviderGroup(
  descriptor: ModelDescriptor,
  providerHint?: ModelProviderGroup,
): boolean {
  if (!providerHint) return true;
  return resolveProviderGroupForModel(descriptor) === providerHint;
}

export function resolveModelDescriptorForProvider(
  modelRef: string | null | undefined,
  providerHint?: ModelProviderGroup,
): ModelDescriptor | undefined {
  const normalized = String(modelRef ?? "").trim().toLowerCase();
  if (!normalized.length) return undefined;

  const exactId = getModelById(normalized);
  if (exactId && !exactId.deprecated && matchesProviderGroup(exactId, providerHint)) {
    return exactId;
  }

  const candidates = MODEL_REGISTRY.filter((descriptor) => {
    if (descriptor.deprecated) return false;
    if (!matchesProviderGroup(descriptor, providerHint)) return false;
    return descriptor.id.toLowerCase() === normalized
      || descriptor.shortId.toLowerCase() === normalized
      || descriptor.providerModelId.toLowerCase() === normalized
      || (descriptor.aliases ?? []).some((alias) => alias.trim().toLowerCase() === normalized);
  });
  if (!candidates.length) {
    if (providerHint === "cursor") {
      const prefixed = normalized.includes("/") ? normalized : `cursor/${normalized}`;
      const direct = getModelById(prefixed);
      if (direct && !direct.deprecated) return direct;
    }
    return undefined;
  }

  const exactShortId = candidates.find((descriptor) => descriptor.shortId.toLowerCase() === normalized);
  if (exactShortId) return exactShortId;

  const exactSdkMatch = candidates
    .filter((descriptor) => descriptor.providerModelId.toLowerCase() === normalized)
    .sort((left, right) => Number(left.isCliWrapped) - Number(right.isCliWrapped))[0];
  if (exactSdkMatch) return exactSdkMatch;

  return candidates[0];
}

export function resolveModelIdForProvider(
  modelRef: string | null | undefined,
  providerHint?: ModelProviderGroup,
): string | undefined {
  return resolveModelDescriptorForProvider(modelRef, providerHint)?.id;
}

export function resolveCliProviderForModel(
  descriptor: ModelDescriptor,
): "claude" | "codex" | "cursor" | null {
  if (!descriptor.isCliWrapped) return null;
  if (descriptor.family === "cursor") return "cursor";
  if (descriptor.family === "anthropic") return "claude";
  if (descriptor.family === "openai") return "codex";
  return null;
}

/**
 * Resolve a model descriptor to its provider group ("claude" | "codex" | "cursor" | "opencode").
 * CLI-wrapped models map to their CLI runtime; all others map to "opencode".
 */
export function resolveProviderGroupForModel(
  descriptor: ModelDescriptor,
): ModelProviderGroup {
  return resolveCliProviderForModel(descriptor) ?? "opencode";
}

/**
 * Resolve the chat session provider and model ref for a model descriptor.
 * CLI-wrapped models route to their native runtime (claude/codex/cursor);
 * everything else goes through the OpenCode runtime.
 */
export function resolveChatProviderForDescriptor(
  descriptor: ModelDescriptor,
): { provider: ModelProviderGroup; model: string } {
  const provider = resolveProviderGroupForModel(descriptor);
  return { provider, model: getRuntimeModelRefForDescriptor(descriptor, provider) };
}

export function getRuntimeModelRefForDescriptor(
  descriptor: ModelDescriptor,
  providerHint?: ModelProviderGroup,
): string {
  const provider = providerHint ?? resolveProviderGroupForModel(descriptor);
  if (provider === "claude") {
    return descriptor.shortId;
  }
  if (provider === "codex" || provider === "cursor") {
    return descriptor.providerModelId;
  }
  return descriptor.id;
}

export function classifyWorkerExecutionPath(
  descriptor: ModelDescriptor,
): WorkerExecutionPath {
  if (resolveCliProviderForModel(descriptor)) return "cli";
  if (descriptor.authTypes.includes("local")) return "local";
  return "api";
}

function listProviderModelsInternal(provider: ModelProviderGroup): ModelDescriptor[] {
  return MODEL_REGISTRY.filter((descriptor) => {
    if (descriptor.deprecated) return false;
    if (provider === "claude") return descriptor.isCliWrapped && descriptor.family === "anthropic";
    if (provider === "codex") return descriptor.isCliWrapped && descriptor.family === "openai";
    if (provider === "cursor") return descriptor.isCliWrapped && descriptor.family === "cursor";
    return !descriptor.isCliWrapped;
  });
}

function parseVersionSegments(value: string): number[] {
  const match = value.match(/gpt-(\d+(?:\.\d+)*)/i);
  if (!match?.[1]) return [];
  return match[1]
    .split(".")
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
}

function compareVersionSegmentsDesc(left: number[], right: number[]): number {
  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (leftValue !== rightValue) return rightValue - leftValue;
  }
  return 0;
}

function pickPreferredModel(
  models: ModelDescriptor[],
  predicates: Array<(model: ModelDescriptor) => boolean>,
): ModelDescriptor | undefined {
  for (const predicate of predicates) {
    const match = models.find(predicate);
    if (match) return match;
  }
  return models[0];
}

function pickDefaultClaudeModel(models: ModelDescriptor[]): ModelDescriptor | undefined {
  return pickPreferredModel(models, [
    (model) => /\bsonnet\b/i.test(model.displayName) || /\bsonnet\b/i.test(model.providerModelId),
    (model) => /\bopus\b/i.test(model.displayName) || /\bopus\b/i.test(model.providerModelId),
    (model) => /\bhaiku\b/i.test(model.displayName) || /\bhaiku\b/i.test(model.providerModelId),
  ]);
}

function pickDefaultCodexModel(models: ModelDescriptor[]): ModelDescriptor | undefined {
  const standard = models
    .filter((model) => /gpt-\d+(?:\.\d+)*(?:-codex)?$/i.test(model.id) || /gpt-\d+(?:\.\d+)*$/i.test(model.providerModelId))
    .sort((left, right) => {
      const versionCompare = compareVersionSegmentsDesc(
        parseVersionSegments(left.id),
        parseVersionSegments(right.id),
      );
      if (versionCompare !== 0) return versionCompare;
      return left.displayName.localeCompare(right.displayName);
    });
  if (standard[0]) return standard[0];
  return pickPreferredModel(models, [
    (model) => /codex-mini/i.test(model.providerModelId),
    (model) => /spark/i.test(model.providerModelId),
  ]);
}

function pickDefaultOpenCodeModel(models: ModelDescriptor[]): ModelDescriptor | undefined {
  return pickPreferredModel(models, [
    (model) => model.family === "openai" && /\bgpt-5\.4\b/i.test(`${model.displayName} ${model.providerModelId}`),
    (model) => model.id === "opencode/anthropic/claude-sonnet-4-6" || (model.family === "anthropic" && model.providerRoute === "opencode"),
    (model) => model.family === "anthropic" && /\bsonnet\b/i.test(model.displayName),
    (model) => model.family === "anthropic",
    (model) => model.family === "openai",
  ]);
}

/** Default when choosing among Cursor CLI models from `agent models` (prefers Auto, then Sonnet, Composer, GPT‑5.4). */
export function pickDefaultCursorDescriptorFromCliList(models: ModelDescriptor[]): ModelDescriptor | undefined {
  return pickPreferredModel(models, [
    (m) => m.providerModelId === "auto",
    (m) => /sonnet/i.test(m.providerModelId) || /sonnet/i.test(m.displayName),
    (m) => /composer/i.test(m.providerModelId),
    (m) => /gpt-5\.4/i.test(m.providerModelId),
  ]);
}

function pickDefaultModelForProvider(
  provider: ModelProviderGroup,
  models: ModelDescriptor[],
): ModelDescriptor | undefined {
  if (provider === "claude") return pickDefaultClaudeModel(models);
  if (provider === "codex") return pickDefaultCodexModel(models);
  if (provider === "cursor") return pickDefaultCursorDescriptorFromCliList(models);
  return pickDefaultOpenCodeModel(models);
}

export function getDefaultModelDescriptor(
  provider: ModelProviderGroup,
): ModelDescriptor | undefined {
  const models = listProviderModelsInternal(provider);
  if (provider === "cursor" && models.length === 0) {
    return pickDefaultCursorDescriptorFromCliList([createDynamicCursorCliModelDescriptor("auto", "Auto")]);
  }
  return pickDefaultModelForProvider(provider, models);
}

export function listModelDescriptorsForProvider(
  provider: ModelProviderGroup,
): ModelDescriptor[] {
  const models = listProviderModelsInternal(provider);
  const preferred = pickDefaultModelForProvider(provider, models);
  if (!preferred) return models;
  return [preferred, ...models.filter((model) => model.id !== preferred.id)];
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
    const enrichment = enrichments.get(descriptor.providerModelId);
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
// Pricing helpers
// ---------------------------------------------------------------------------

/**
 * Get pricing for a model by its providerModelId (e.g. "claude-sonnet-4-6").
 * Returns per-million-token pricing. Checks dynamic overrides first,
 * then falls back to the static pricing in MODEL_REGISTRY.
 */
export function getModelPricing(providerModelId: string): { input: number; output: number } | undefined {
  const override = _dynamicPricingOverrides[providerModelId];
  if (override) return override;
  const model = bySdkModelId.get(providerModelId);
  if (model?.inputPricePer1M != null && model?.outputPricePer1M != null) {
    return { input: model.inputPricePer1M, output: model.outputPricePer1M };
  }
  return undefined;
}

/** Dynamic pricing overrides — merged from models.dev at runtime */
const _dynamicPricingOverrides: Record<string, { input: number; output: number }> = {};

/**
 * Merge dynamic pricing updates (e.g. from models.dev) into the pricing system.
 * Returns the number of entries updated.
 */
export function updateModelPricingInRegistry(updates: Record<string, { input: number; output: number }>): number {
  let count = 0;
  for (const [modelId, pricing] of Object.entries(updates)) {
    if (pricing.input >= 0 && pricing.output >= 0) {
      _dynamicPricingOverrides[modelId] = pricing;
      count++;
    }
  }
  return count;
}
