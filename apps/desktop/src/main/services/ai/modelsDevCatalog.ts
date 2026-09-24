// ---------------------------------------------------------------------------
// models.dev catalog parsing — the one place ADE reads model prices and limits.
//
// models.dev lists the same model under many providers: the vendor itself and
// dozens of resellers and gateways, each with its own price. A bare model id
// (`claude-sonnet-4-5`) must resolve to the vendor's own row, never to whichever
// reseller happened to be read last, so every consumer (registry enrichment,
// usage cost) goes through `pickModelsDevEntries`.
// ---------------------------------------------------------------------------

export const MODELS_DEV_API_URL = "https://models.dev/api.json";

export type ModelsDevRateBlock = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
};

export type ModelsDevCost = ModelsDevRateBlock & {
  /**
   * Long-context pricing: each entry applies once a request's context passes
   * `tier.size` tokens (OpenAI GPT-5.4+ at 272k, xAI Grok at 200k, ...).
   */
  tiers?: Array<ModelsDevRateBlock & { tier?: { type?: string; size?: number } }>;
  /** Older single-tier form of the same pricing, fixed at 200k. */
  context_over_200k?: ModelsDevRateBlock;
};

export type ModelsDevEntry = {
  id?: string;
  name?: string;
  cost?: ModelsDevCost;
  limit?: { context?: number; output?: number };
  reasoning?: boolean;
  tool_call?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  [key: string]: unknown;
};

export type PickedModelsDevEntry = { providerId: string; entry: ModelsDevEntry };

/** The vendor that sets a model family's list price. */
const VENDOR_BY_MODEL_PREFIX: Array<[RegExp, string]> = [
  [/^claude-/, "anthropic"],
  [/^(?:gpt-|o\d|codex-|chatgpt-)/, "openai"],
  [/^gemini-/, "google"],
  [/^grok-/, "xai"],
  [/^deepseek-/, "deepseek"],
  [/^kimi-/, "moonshotai"],
  [/^glm-/, "zai"],
  [/^qwen/, "alibaba"],
  [/^(?:mistral|codestral|devstral|magistral|ministral)-/, "mistral"],
  [/^minimax-/i, "minimax"],
  [/^llama-/, "meta"],
];

function vendorForModel(modelId: string): string | null {
  const lower = modelId.toLowerCase();
  for (const [pattern, vendor] of VENDOR_BY_MODEL_PREFIX) {
    if (pattern.test(lower)) return vendor;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip a reseller's vendor path (`anthropic/claude-x`) down to the model id. */
export function bareModelsDevId(modelKey: string): string {
  const parts = modelKey.trim().split("/");
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

/**
 * Walk every provider in a models.dev payload, yielding each model once per
 * provider that lists it.
 */
export function forEachModelsDevEntry(
  data: unknown,
  visit: (providerId: string, modelKey: string, entry: ModelsDevEntry) => void,
): void {
  if (!isRecord(data)) return;
  for (const [providerId, envelope] of Object.entries(data)) {
    if (!isRecord(envelope) || !isRecord(envelope.models)) continue;
    for (const [modelKey, entry] of Object.entries(envelope.models)) {
      if (isRecord(entry)) visit(providerId, modelKey, entry as ModelsDevEntry);
    }
  }
}

/**
 * One row per bare model id, preferring (1) the model's own vendor, (2) a
 * reseller row that names that vendor in its key (`anthropic/claude-x`), then
 * (3) the first provider that lists it.
 */
export function pickModelsDevEntries(data: unknown): Map<string, PickedModelsDevEntry> {
  const picked = new Map<string, PickedModelsDevEntry & { rank: number }>();
  forEachModelsDevEntry(data, (providerId, modelKey, entry) => {
    const bareId = bareModelsDevId(modelKey);
    if (!bareId) return;
    const vendor = vendorForModel(bareId);
    const keyVendor = modelKey.includes("/") ? modelKey.split("/")[0]!.toLowerCase() : null;
    const rank = vendor && providerId === vendor ? 3 : vendor && keyVendor === vendor ? 2 : 1;
    const existing = picked.get(bareId);
    if (!existing || rank > existing.rank) picked.set(bareId, { providerId, entry, rank });
  });
  return new Map([...picked].map(([id, { providerId, entry }]) => [id, { providerId, entry }]));
}
