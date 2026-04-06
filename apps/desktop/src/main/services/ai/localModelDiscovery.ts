import type { DetectedAuth } from "./authDetector";
import type { LocalModelHarnessProfile, LocalProviderFamily, ModelCapabilities, ModelDescriptor } from "../../../shared/modelRegistry";

export type DiscoveredLocalModel = {
  provider: LocalProviderFamily;
  modelId: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: Partial<ModelCapabilities>;
  reasoningTiers?: string[];
  harnessProfile?: LocalModelHarnessProfile;
  discoverySource?: ModelDescriptor["discoverySource"];
};

export type LocalProviderConnectionHealth =
  | "ready"
  | "reachable_no_models"
  | "unreachable";

export type LocalProviderInspection = {
  provider: LocalProviderFamily;
  endpoint: string;
  reachable: boolean;
  health: LocalProviderConnectionHealth;
  loadedModels: DiscoveredLocalModel[];
};

const CACHE_TTL_MS = 30_000;
let inspectionCacheGeneration = 0;

let discoverCache: {
  key: string;
  generation: number;
  cachedAt: number;
  models: DiscoveredLocalModel[];
} | null = null;

let inspectionCache = new Map<string, { generation: number; cachedAt: number; inspection: LocalProviderInspection }>();

function buildCacheKey(auth: DetectedAuth[]): string {
  return auth
    .filter((entry): entry is Extract<DetectedAuth, { type: "local" }> => entry.type === "local")
    .map((entry) => `${entry.provider}:${entry.endpoint}`)
    .sort()
    .join("|");
}

function buildInspectionKey(provider: LocalProviderFamily, endpoint: string): string {
  return `${provider}:${endpoint.replace(/\/+$/, "")}`;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

function normalizeReasoningTier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized.length) return null;
  if (normalized === "max") return "xhigh";
  if (normalized === "none" || normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "xhigh") {
    return normalized;
  }
  return null;
}

function dedupeReasoningTiers(values: Array<string | null | undefined>): string[] | undefined {
  const seen = new Set<string>();
  const tiers: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    tiers.push(value);
  }
  return tiers.length ? tiers : undefined;
}

function normalizeReasoningConfig(value: unknown): { tiers?: string[]; supportsReasoning: boolean } {
  if (typeof value === "boolean") {
    return value ? { tiers: ["low", "medium", "high"], supportsReasoning: true } : { supportsReasoning: false };
  }
  if (typeof value === "string") {
    const tier = normalizeReasoningTier(value);
    return { ...(tier ? { tiers: [tier] } : {}), supportsReasoning: Boolean(tier) };
  }
  if (Array.isArray(value)) {
    const tiers = dedupeReasoningTiers(value.map((entry) => normalizeReasoningTier(entry)));
    return { ...(tiers ? { tiers } : {}), supportsReasoning: Boolean(tiers?.length) };
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const enabled = normalizeBoolean(record.enabled) ?? normalizeBoolean(record.supported) ?? normalizeBoolean(record.available);
    const tiers = dedupeReasoningTiers([
      ...((Array.isArray(record.supported_efforts) ? record.supported_efforts : []) as unknown[]).map((entry) => normalizeReasoningTier(entry)),
      ...((Array.isArray(record.supportedEfforts) ? record.supportedEfforts : []) as unknown[]).map((entry) => normalizeReasoningTier(entry)),
      ...((Array.isArray(record.efforts) ? record.efforts : []) as unknown[]).map((entry) => normalizeReasoningTier(entry)),
      ...((Array.isArray(record.levels) ? record.levels : []) as unknown[]).map((entry) => normalizeReasoningTier(entry)),
      normalizeReasoningTier(record.default_effort),
      normalizeReasoningTier(record.defaultEffort),
    ]);
    return {
      ...(tiers ? { tiers } : {}),
      supportsReasoning: enabled ?? Boolean(tiers?.length),
    };
  }
  return { supportsReasoning: false };
}

function inferVisionFromModelId(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return /(\bvl\b|vision|llava|gemma[-_ ]?(3|4)|qwen2\.?5[-_ ]?vl|llama[-_ ]?3\.2.*vision)/i.test(lower);
}

function inferNativeToolSupport(modelId: string): boolean {
  return /(qwen|llama[-_ ]?3\.(1|2)|ministral|mistral|gpt-oss)/i.test(modelId);
}

function inferHarnessProfile(args: {
  modelId: string;
  type?: string | null;
  trainedForToolUse?: boolean;
}): LocalModelHarnessProfile {
  if (args.type === "embedding") return "read_only";
  if (args.trainedForToolUse) return "verified";
  return inferNativeToolSupport(args.modelId) ? "verified" : "guarded";
}

function inferFallbackCapabilities(modelId: string): {
  capabilities: Partial<ModelCapabilities>;
  harnessProfile: LocalModelHarnessProfile;
} {
  const lower = modelId.toLowerCase();
  if (/embedding|embed|bge-|nomic-embed|gte-|e5-|rerank|reranker/.test(lower)) {
    return {
      capabilities: { tools: false, vision: false, reasoning: false, streaming: true },
      harnessProfile: "read_only",
    };
  }
  const harnessProfile = inferHarnessProfile({ modelId });
  const reasoning = /\breason(ing)?\b|qwq|r1|deepseek-r1|phi-4.*reasoning|nemotron/i.test(lower);
  return {
    capabilities: {
      tools: true,
      vision: inferVisionFromModelId(modelId),
      reasoning,
      streaming: true,
    },
    harnessProfile,
  };
}

function toLoadedInstanceDisplayName(baseDisplayName: string | null, instanceId: string, multiInstance: boolean): string | undefined {
  const display = baseDisplayName?.trim() || instanceId;
  return multiInstance ? `${display} (${instanceId})` : display;
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    if (!response.ok) return null;
    return await response.json() as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function inspectLmStudioProvider(endpoint: string, timeoutMs: number): Promise<LocalProviderInspection> {
  const base = endpoint.replace(/\/+$/, "");
  const restPayload = await fetchJson(`${base}/api/v1/models`, timeoutMs);

  if (restPayload && typeof restPayload === "object") {
    const models = Array.isArray((restPayload as { models?: unknown[] }).models)
      ? (restPayload as { models: Array<Record<string, unknown>> }).models
      : [];

    const discovered: DiscoveredLocalModel[] = [];

    for (const model of models) {
      const loadedInstances = Array.isArray(model.loaded_instances) ? model.loaded_instances as Array<Record<string, unknown>> : [];
      if (!loadedInstances.length) continue;

      const type = normalizeString(model.type);
      const displayName = normalizeString(model.display_name) ?? normalizeString(model.key);
      const maxContextLength = normalizeNumber(model.max_context_length);
      const capabilitiesRecord = model.capabilities && typeof model.capabilities === "object"
        ? model.capabilities as Record<string, unknown>
        : null;
      const trainedForToolUse = normalizeBoolean(capabilitiesRecord?.trained_for_tool_use) ?? false;
      const reasoning = normalizeReasoningConfig((model as Record<string, unknown>).reasoning);
      const multiInstance = loadedInstances.length > 1;

      for (const instance of loadedInstances) {
        const instanceId = normalizeString(instance.id);
        if (!instanceId) continue;
        const config = instance.config && typeof instance.config === "object"
          ? instance.config as Record<string, unknown>
          : null;
        const contextWindow = normalizeNumber(config?.context_length) ?? maxContextLength;
        const harnessProfile = inferHarnessProfile({ modelId: instanceId, type, trainedForToolUse });
        discovered.push({
          provider: "lmstudio",
          modelId: instanceId,
          displayName: toLoadedInstanceDisplayName(displayName, instanceId, multiInstance),
          ...(contextWindow ? { contextWindow } : {}),
          maxOutputTokens: 8_192,
          capabilities: {
            tools: type !== "embedding",
            vision: normalizeBoolean(capabilitiesRecord?.vision) ?? inferVisionFromModelId(instanceId),
            reasoning: reasoning.supportsReasoning,
            streaming: true,
          },
          ...(reasoning.tiers?.length ? { reasoningTiers: reasoning.tiers } : {}),
          harnessProfile,
          discoverySource: "lmstudio-rest",
        });
      }
    }

    return {
      provider: "lmstudio",
      endpoint,
      reachable: true,
      health: discovered.length ? "ready" : "reachable_no_models",
      loadedModels: discovered,
    };
  }

  const openAiPayload = await fetchJson(`${base}/v1/models`, timeoutMs);
  const models = Array.isArray((openAiPayload as { data?: unknown[] } | null)?.data)
    ? ((openAiPayload as { data: Array<Record<string, unknown>> }).data)
    : [];
  const discovered = models
    .map((entry) => normalizeString(entry.id))
    .filter((modelId): modelId is string => Boolean(modelId))
    .map((modelId) => {
      const fallback = inferFallbackCapabilities(modelId);
      return {
        provider: "lmstudio" as const,
        modelId,
        displayName: modelId,
        maxOutputTokens: 8_192,
        capabilities: fallback.capabilities,
        harnessProfile: fallback.harnessProfile,
        discoverySource: "lmstudio-openai" as const,
      } satisfies DiscoveredLocalModel;
    });

  return {
    provider: "lmstudio",
    endpoint,
    reachable: openAiPayload != null,
    health: !openAiPayload ? "unreachable" : discovered.length ? "ready" : "reachable_no_models",
    loadedModels: discovered,
  };
}

async function inspectOpenAiCompatibleProvider(
  provider: Exclude<LocalProviderFamily, "lmstudio">,
  endpoint: string,
  timeoutMs: number,
): Promise<LocalProviderInspection> {
  const base = endpoint.replace(/\/+$/, "");
  const path = provider === "ollama" ? "/api/tags" : "/v1/models";
  const payload = await fetchJson(`${base}${path}`, timeoutMs);
  if (payload == null) {
    return {
      provider,
      endpoint,
      reachable: false,
      health: "unreachable",
      loadedModels: [],
    };
  }

  const discovered = provider === "ollama"
    ? (Array.isArray((payload as { models?: unknown[] }).models)
      ? (payload as { models: Array<Record<string, unknown>> }).models
      : [])
      .map((entry) => normalizeString(entry.name))
      .filter((modelId): modelId is string => Boolean(modelId))
      .map((modelId) => {
        const fallback = inferFallbackCapabilities(modelId);
        return {
          provider,
          modelId,
          displayName: modelId,
          maxOutputTokens: 8_192,
          capabilities: fallback.capabilities,
          harnessProfile: fallback.harnessProfile,
          discoverySource: provider,
        } satisfies DiscoveredLocalModel;
      })
    : (Array.isArray((payload as { data?: unknown[] }).data)
      ? (payload as { data: Array<Record<string, unknown>> }).data
      : [])
      .map((entry) => normalizeString(entry.id))
      .filter((modelId): modelId is string => Boolean(modelId))
      .map((modelId) => {
        const fallback = inferFallbackCapabilities(modelId);
        return {
          provider,
          modelId,
          displayName: modelId,
          maxOutputTokens: 8_192,
          capabilities: fallback.capabilities,
          harnessProfile: fallback.harnessProfile,
          discoverySource: provider,
        } satisfies DiscoveredLocalModel;
      });

  return {
    provider,
    endpoint,
    reachable: true,
    health: discovered.length ? "ready" : "reachable_no_models",
    loadedModels: discovered,
  };
}

export async function inspectLocalProvider(
  provider: LocalProviderFamily,
  endpoint: string,
  timeoutMs = 2_000,
): Promise<LocalProviderInspection> {
  const key = buildInspectionKey(provider, endpoint);
  const generation = inspectionCacheGeneration;
  const cached = inspectionCache.get(key);
  const now = Date.now();
  if (cached && cached.generation === generation && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.inspection;
  }

  const inspection = provider === "lmstudio"
    ? await inspectLmStudioProvider(endpoint, timeoutMs)
    : await inspectOpenAiCompatibleProvider(provider, endpoint, timeoutMs);

  if (generation === inspectionCacheGeneration) {
    inspectionCache.set(key, { generation, cachedAt: now, inspection });
  }
  return inspection;
}

export function clearLocalProviderInspectionCache(): void {
  inspectionCacheGeneration += 1;
  inspectionCache = new Map<string, { generation: number; cachedAt: number; inspection: LocalProviderInspection }>();
  discoverCache = null;
}

export async function discoverLocalModels(auth: DetectedAuth[]): Promise<DiscoveredLocalModel[]> {
  const key = buildCacheKey(auth);
  const generation = inspectionCacheGeneration;
  const now = Date.now();
  if (
    discoverCache
    && discoverCache.generation === generation
    && discoverCache.key === key
    && now - discoverCache.cachedAt < CACHE_TTL_MS
  ) {
    return discoverCache.models;
  }

  const providers = auth.filter((entry): entry is Extract<DetectedAuth, { type: "local" }> => entry.type === "local");
  const discovered = await Promise.all(
    providers.map(async (entry) => {
      const inspection = await inspectLocalProvider(entry.provider, entry.endpoint);
      return inspection.loadedModels;
    }),
  );

  const deduped = new Map<string, DiscoveredLocalModel>();
  for (const providerModels of discovered) {
    for (const model of providerModels) {
      deduped.set(`${model.provider}/${model.modelId}`, model);
    }
  }

  const models = [...deduped.values()].sort((left, right) => {
    if (left.provider !== right.provider) return left.provider.localeCompare(right.provider);
    return left.modelId.localeCompare(right.modelId);
  });

  if (generation === inspectionCacheGeneration) {
    discoverCache = { key, generation, cachedAt: now, models };
  }
  return models;
}
