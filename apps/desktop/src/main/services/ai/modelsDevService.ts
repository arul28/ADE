// ---------------------------------------------------------------------------
// models.dev Integration — fetches dynamic model metadata from the open API
// ---------------------------------------------------------------------------

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelsDevModelData = {
  cost?: { input: number; output: number };
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  toolCall?: boolean;
  vision?: boolean;
};

type ModelsDevApiEntry = {
  id?: string;
  name?: string;
  context_length?: number;
  max_output?: number;
  input_cost?: number;
  output_cost?: number;
  cost?: {
    input?: number;
    output?: number;
  };
  limit?: {
    context?: number;
    output?: number;
  };
  tool_call?: boolean;
  reasoning?: boolean;
  vision?: boolean;
  modalities?: {
    text?: {
      input?: boolean;
      output?: boolean;
    };
    image?: {
      input?: boolean;
      output?: boolean;
    };
  };
  supports_tools?: boolean;
  supports_vision?: boolean;
  supports_reasoning?: boolean;
  [key: string]: unknown;
};

type ModelsDevProviderEnvelope = {
  id?: string;
  name?: string;
  models?: Record<string, ModelsDevApiEntry | unknown>;
};

type ModelsDevApiResponse = {
  [provider: string]: ModelsDevApiEntry[] | ModelsDevProviderEnvelope | unknown;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 10_000;
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const CACHE_DIR = join(homedir(), ".ade");
const CACHE_FILE = join(CACHE_DIR, "models-dev-cache.json");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let modelDataMap: Map<string, ModelsDevModelData> = new Map();
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseApiResponse(data: ModelsDevApiResponse): Map<string, ModelsDevModelData> {
  const result = new Map<string, ModelsDevModelData>();

  const parseEntry = (entry: ModelsDevApiEntry, fallbackId?: string): void => {
    const modelId = [entry.id, entry.name, fallbackId]
      .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)
      ?.trim() ?? "";
    if (!modelId.length) return;

    const parsed: ModelsDevModelData = {};

    // New schema: cost.input/output are already per-million token prices.
    if (typeof entry.cost?.input === "number" && typeof entry.cost?.output === "number") {
      parsed.cost = {
        input: entry.cost.input,
        output: entry.cost.output,
      };
    } else if (typeof entry.input_cost === "number" && typeof entry.output_cost === "number") {
      // Legacy schema: costs reported per token.
      parsed.cost = {
        input: entry.input_cost * 1_000_000,
        output: entry.output_cost * 1_000_000,
      };
    }

    const contextWindow = typeof entry.limit?.context === "number"
      ? entry.limit.context
      : entry.context_length;
    if (typeof contextWindow === "number" && contextWindow > 0) {
      parsed.contextWindow = contextWindow;
    }

    const maxOutputTokens = typeof entry.limit?.output === "number"
      ? entry.limit.output
      : entry.max_output;
    if (typeof maxOutputTokens === "number" && maxOutputTokens > 0) {
      parsed.maxOutputTokens = maxOutputTokens;
    }

    const supportsReasoning = typeof entry.reasoning === "boolean"
      ? entry.reasoning
      : entry.supports_reasoning;
    if (typeof supportsReasoning === "boolean") {
      parsed.reasoning = supportsReasoning;
    }

    const supportsTools = typeof entry.tool_call === "boolean"
      ? entry.tool_call
      : entry.supports_tools;
    if (typeof supportsTools === "boolean") {
      parsed.toolCall = supportsTools;
    }

    if (typeof entry.vision === "boolean") {
      parsed.vision = entry.vision;
    } else if (typeof entry.supports_vision === "boolean") {
      parsed.vision = entry.supports_vision;
    } else if (entry.modalities?.image?.input === true || entry.modalities?.image?.output === true) {
      parsed.vision = true;
    }

    result.set(modelId, parsed);
  };

  for (const [, providerModels] of Object.entries(data)) {
    // Legacy schema: provider -> array of models
    if (Array.isArray(providerModels)) {
      for (const entry of providerModels as ModelsDevApiEntry[]) {
        parseEntry(entry);
      }
      continue;
    }

    // Current schema: provider -> { id, name, models: { modelKey: entry } }
    if (providerModels && typeof providerModels === "object" && !Array.isArray(providerModels)) {
      const envelope = providerModels as ModelsDevProviderEnvelope;
      const models = envelope.models;
      if (!models || typeof models !== "object" || Array.isArray(models)) continue;

      for (const [modelKey, rawModel] of Object.entries(models)) {
        if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) continue;
        parseEntry(rawModel as ModelsDevApiEntry, modelKey);
      }
    }
  }

  return result;
}

async function fetchFromApi(): Promise<Map<string, ModelsDevModelData>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(API_URL, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`models.dev API returned ${response.status}`);
    }
    const data = (await response.json()) as ModelsDevApiResponse;
    return parseApiResponse(data);
  } finally {
    clearTimeout(timeout);
  }
}

async function persistToCache(data: Map<string, ModelsDevModelData>): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const serialized = JSON.stringify(Object.fromEntries(data), null, 2);
    await writeFile(CACHE_FILE, serialized, "utf-8");
  } catch {
    // Non-critical — cache write failures are silently ignored
  }
}

async function loadFromCache(): Promise<Map<string, ModelsDevModelData>> {
  try {
    const raw = await readFile(CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, ModelsDevModelData>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the models.dev service: fetch fresh data, fall back to cache.
 * Returns the fetched data map for immediate consumption.
 */
export async function initialize(): Promise<Map<string, ModelsDevModelData>> {
  try {
    modelDataMap = await fetchFromApi();
    await persistToCache(modelDataMap);
    console.info(`[models.dev] Fetched metadata for ${modelDataMap.size} models`);
  } catch (err) {
    console.warn(`[models.dev] API fetch failed, loading from cache: ${err instanceof Error ? err.message : err}`);
    modelDataMap = await loadFromCache();
    if (modelDataMap.size > 0) {
      console.info(`[models.dev] Loaded ${modelDataMap.size} models from cache`);
    } else {
      console.warn("[models.dev] No cached data available, using hardcoded fallbacks");
    }
  }

  // Schedule periodic refreshes (non-blocking)
  if (!refreshTimer) {
    refreshTimer = setInterval(async () => {
      try {
        const fresh = await fetchFromApi();
        modelDataMap = fresh;
        await persistToCache(fresh);
        console.info(`[models.dev] Refreshed metadata for ${fresh.size} models`);
      } catch (err) {
        console.warn(`[models.dev] Background refresh failed: ${err instanceof Error ? err.message : err}`);
      }
    }, REFRESH_INTERVAL_MS);

    // Don't block process exit
    if (refreshTimer.unref) refreshTimer.unref();
  }

  initialized = true;
  return modelDataMap;
}

/** Get model data by providerModelId. Returns undefined if not found. */
export function getModelData(providerModelId: string): ModelsDevModelData | undefined {
  return modelDataMap.get(providerModelId);
}

/** Get pricing for a model by providerModelId. Returns undefined if not available. */
export function getPricing(providerModelId: string): { input: number; output: number } | undefined {
  return modelDataMap.get(providerModelId)?.cost;
}

/** Whether the service has been initialized. */
export function isInitialized(): boolean {
  return initialized;
}

/** Stop the refresh timer (for testing/cleanup). */
export function shutdown(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
