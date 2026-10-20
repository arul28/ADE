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
  billing?: { multiplier?: unknown; tokenPrices?: CopilotTierPrices & { longContext?: CopilotTierPrices } };
  supportedContextTiers?: unknown;
};

/** One context tier's prompt budget. `contextMax` is the deprecated name for `maxPromptTokens`. */
type CopilotTierPrices = { maxPromptTokens?: unknown; contextMax?: unknown };

function positiveTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function tierPromptBudget(tier: CopilotTierPrices | undefined): number | undefined {
  return positiveTokens(tier?.maxPromptTokens) ?? positiveTokens(tier?.contextMax);
}

/**
 * Copilot's own models carry their context tiers in `billing.tokenPrices`: a
 * model with a `longContext` price offers the long tier. `supportedContextTiers`
 * is only filled by providers with no pricing to publish, so both are read.
 */
function copilotContextTiers(model: CopilotModel): string[] {
  const listed = Array.isArray(model.supportedContextTiers)
    ? model.supportedContextTiers.filter((tier): tier is string => typeof tier === "string")
    : [];
  const priced = model.billing?.tokenPrices?.longContext ? ["default", "long_context"] : [];
  return [...new Set([...priced, ...listed])];
}

/** What an account with no model list (the Auto-only plan) is offered. */
const COPILOT_AUTO_ONLY: readonly CopilotModel[] = [
  { id: "auto", name: "Auto", capabilities: { limits: { max_context_window_tokens: 128_000, max_output_tokens: 32_000 } } },
];

function copilotModelDescriptor(model: CopilotModel, id: string): ModelDescriptor {
  const limits = model.capabilities?.limits;
  const output = limits?.max_output_tokens;
  // Windows are prompt budgets per tier, as the Copilot CLI's picker shows them.
  // `max_context_window_tokens` is the largest tier's whole window, so it is
  // only the last fallback.
  const context = tierPromptBudget(model.billing?.tokenPrices)
    ?? positiveTokens(limits?.max_prompt_tokens)
    ?? positiveTokens(limits?.max_context_window_tokens);
  const longContextWindow = tierPromptBudget(model.billing?.tokenPrices?.longContext);
  const contextTiers = copilotContextTiers(model);
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.filter((effort): effort is string => typeof effort === "string")
    : [];
  return {
    id: `github-copilot/${id}`,
    shortId: id,
    displayName: typeof model.name === "string" && model.name.trim() ? model.name.trim() : id,
    family: "github-copilot",
    authTypes: ["cli-subscription"],
    contextWindow: context ?? 128_000,
    maxOutputTokens: typeof output === "number" && output > 0 ? output : 32_000,
    capabilities: { tools: true, vision: model.capabilities?.supports?.vision === true, reasoning: efforts.length > 0, streaming: true },
    ...(efforts.length ? { reasoningTiers: efforts } : {}),
    ...(typeof model.defaultReasoningEffort === "string" ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
    ...(contextTiers.length ? { supportedContextTiers: contextTiers } : {}),
    ...(longContextWindow ? { longContextWindow } : {}),
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
// 2: context tiers and windows read from `billing.tokenPrices`.
const COPILOT_MODELS_CACHE_VERSION = 2;
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
