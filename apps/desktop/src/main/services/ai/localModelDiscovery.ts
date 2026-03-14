import type { DetectedAuth } from "./authDetector";
import type { LocalProviderFamily } from "../../../shared/modelRegistry";

export type DiscoveredLocalModel = {
  provider: LocalProviderFamily;
  modelId: string;
};

const CACHE_TTL_MS = 30_000;

let cache: {
  key: string;
  cachedAt: number;
  models: DiscoveredLocalModel[];
} | null = null;

function buildCacheKey(auth: DetectedAuth[]): string {
  return auth
    .filter((entry): entry is Extract<DetectedAuth, { type: "local" }> => entry.type === "local")
    .map((entry) => `${entry.provider}:${entry.endpoint}`)
    .sort()
    .join("|");
}

async function fetchLocalModelIds(
  provider: LocalProviderFamily,
  endpoint: string,
): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const url = provider === "ollama"
      ? `${endpoint.replace(/\/+$/, "")}/api/tags`
      : `${endpoint.replace(/\/+$/, "")}/v1/models`;
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    if (!response.ok) return [];
    const payload = await response.json() as unknown;
    if (provider === "ollama") {
      const models = Array.isArray((payload as { models?: unknown[] })?.models)
        ? ((payload as { models?: Array<{ name?: unknown }> }).models ?? [])
        : [];
      return models
        .map((entry) => (typeof entry?.name === "string" ? entry.name.trim() : ""))
        .filter(Boolean);
    }
    const models = Array.isArray((payload as { data?: unknown[] })?.data)
      ? ((payload as { data?: Array<{ id?: unknown }> }).data ?? [])
      : [];
    return models
      .map((entry) => (typeof entry?.id === "string" ? entry.id.trim() : ""))
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function discoverLocalModels(auth: DetectedAuth[]): Promise<DiscoveredLocalModel[]> {
  const key = buildCacheKey(auth);
  const now = Date.now();
  if (cache && cache.key === key && now - cache.cachedAt < CACHE_TTL_MS) {
    return cache.models;
  }

  const providers = auth.filter((entry): entry is Extract<DetectedAuth, { type: "local" }> => entry.type === "local");
  const discovered = await Promise.all(
    providers.map(async (entry) => {
      const modelIds = await fetchLocalModelIds(entry.provider, entry.endpoint);
      return modelIds.map((modelId) => ({ provider: entry.provider, modelId }));
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

  cache = { key, cachedAt: now, models };
  return models;
}
