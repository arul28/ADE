import fs from "node:fs";
import type { ModelDescriptor } from "../../../shared/modelRegistry";
import { resolveAdeCacheFile } from "../shared/adeCacheFile";
import { writeTextAtomic } from "../shared/utils";
import type { Logger } from "../logging/logger";
import { acquireCopilotSdkConnection, releaseCopilotSdkConnection } from "./copilotSdkPool";

type CopilotModel = {
  id?: unknown;
  name?: unknown;
  policy?: { state?: unknown };
  capabilities?: { supports?: { vision?: unknown; reasoningEffort?: unknown }; limits?: { max_context_window_tokens?: unknown; max_output_tokens?: unknown; max_prompt_tokens?: unknown } };
  supportedReasoningEfforts?: unknown;
  defaultReasoningEffort?: unknown;
  billing?: { multiplier?: unknown; tokenPrices?: { longContext?: { contextMax?: unknown } } };
  supportedContextTiers?: unknown;
};

/** What an account with no model list (the Auto-only plan) is offered. */
const COPILOT_AUTO_ONLY: readonly CopilotModel[] = [
  { id: "auto", name: "Auto", capabilities: { limits: { max_context_window_tokens: 128_000, max_output_tokens: 32_000 } } },
];

function copilotModelDescriptor(model: CopilotModel, id: string): ModelDescriptor {
  const context = model.capabilities?.limits?.max_context_window_tokens;
  const output = model.capabilities?.limits?.max_output_tokens;
  const longContextWindow = model.billing?.tokenPrices?.longContext?.contextMax;
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.filter((effort): effort is string => typeof effort === "string")
    : [];
  return {
    id: `github-copilot/${id}`,
    shortId: id,
    displayName: typeof model.name === "string" && model.name.trim() ? model.name.trim() : id,
    family: "github-copilot",
    authTypes: ["cli-subscription"],
    contextWindow: typeof context === "number" && context > 0 ? context : 128_000,
    maxOutputTokens: typeof output === "number" && output > 0 ? output : 32_000,
    capabilities: { tools: true, vision: model.capabilities?.supports?.vision === true, reasoning: efforts.length > 0, streaming: true },
    ...(efforts.length ? { reasoningTiers: efforts } : {}),
    ...(typeof model.defaultReasoningEffort === "string" ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
    ...(Array.isArray(model.supportedContextTiers)
      ? { supportedContextTiers: model.supportedContextTiers.filter((tier): tier is string => typeof tier === "string") }
      : {}),
    ...(typeof longContextWindow === "number" && Number.isFinite(longContextWindow) && longContextWindow > 0 ? { longContextWindow } : {}),
    ...(typeof model.billing?.multiplier === "number" ? { billingMultiplier: model.billing.multiplier } : {}),
    color: "#8250df",
    providerRoute: "copilot-sdk",
    providerModelId: id,
    cliCommand: "copilot",
    isCliWrapped: false,
  };
}

export function copilotSdkModelDescriptors(models: readonly unknown[]): ModelDescriptor[] {
  const rows: ModelDescriptor[] = [];
  const seen = new Set<string>();
  for (const value of models) {
    if (!value || typeof value !== "object") continue;
    const model = value as CopilotModel;
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id || seen.has(id) || model.policy?.state === "disabled") continue;
    seen.add(id);
    rows.push(copilotModelDescriptor(model, id));
  }
  return rows.length ? rows : COPILOT_AUTO_ONLY.map((model) => copilotModelDescriptor(model, "auto"));
}

/**
 * Ask Copilot for this account's models and save them. Both the AI status poll
 * and the chat model catalog refresh through here, so the cache is written one way.
 */
export async function refreshCopilotModelCatalog(args: {
  cliPath: string;
  baseDirectory: string;
  baseEnv: NodeJS.ProcessEnv;
  logger?: Logger;
}): Promise<CopilotModelCatalogCache> {
  const connection = await acquireCopilotSdkConnection(args);
  try {
    const descriptors = copilotSdkModelDescriptors(await connection.pooled.request<unknown[]>("models"));
    try {
      return writeCopilotModelCatalogCache(descriptors);
    } catch (error) {
      args.logger?.warn("agent_chat.copilot_model_cache_write_failed", { error: error instanceof Error ? error.message : String(error) });
      return { savedAt: Date.now(), descriptors };
    }
  } finally {
    releaseCopilotSdkConnection(connection.poolKey, connection.generation);
  }
}

/** A saved list younger than this is served without asking Copilot again. */
export const COPILOT_MODELS_TTL_MS = 6 * 60 * 60_000;
const COPILOT_MODELS_CACHE_VERSION = 1;
const COPILOT_MODELS_CACHE_FILE = "copilot-model-catalog-cache.json";

export type CopilotModelCatalogCache = { savedAt: number; descriptors: ModelDescriptor[] };

/** The last model list Copilot gave this machine, or null when there is none. */
export function readCopilotModelCatalogCache(): CopilotModelCatalogCache | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveAdeCacheFile(COPILOT_MODELS_CACHE_FILE), "utf8")) as Record<string, unknown>;
    if (parsed.version !== COPILOT_MODELS_CACHE_VERSION || typeof parsed.savedAt !== "number" || !Array.isArray(parsed.descriptors)) return null;
    const descriptors = parsed.descriptors.filter((entry): entry is ModelDescriptor => Boolean(
      entry && typeof entry === "object" && (entry as ModelDescriptor).family === "github-copilot"
      && typeof (entry as ModelDescriptor).id === "string" && typeof (entry as ModelDescriptor).providerModelId === "string",
    ));
    return descriptors.length ? { savedAt: parsed.savedAt, descriptors } : null;
  } catch {
    return null;
  }
}

/** Save a live model list so the next read (and the next launch) serves it without a Copilot runtime. */
export function writeCopilotModelCatalogCache(descriptors: ModelDescriptor[]): CopilotModelCatalogCache {
  const next = { savedAt: Date.now(), descriptors };
  writeTextAtomic(resolveAdeCacheFile(COPILOT_MODELS_CACHE_FILE), JSON.stringify({ version: COPILOT_MODELS_CACHE_VERSION, ...next }));
  return next;
}
