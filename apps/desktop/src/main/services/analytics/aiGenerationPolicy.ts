import { MODEL_REGISTRY } from "../../../shared/modelRegistry";
import type { ProductAnalyticsAiGeneration } from "../../../shared/types/productAnalytics";
import { PROVIDER_VALUES } from "./productAnalyticsPolicy";

let catalogModelIds: ReadonlySet<string> | null = null;

/**
 * A model id leaves the machine only when it names a model in ADE's built-in
 * catalog. Local, custom-endpoint and runtime-discovered models can carry a
 * name the person chose, so they report as `other`.
 */
function catalogModelId(value: unknown): string {
  if (typeof value !== "string") return "other";
  const id = value.trim();
  if (!id || id.length > 120) return "other";
  catalogModelIds ??= new Set(MODEL_REGISTRY.map((model) => model.id));
  return catalogModelIds.has(id) ? id : "other";
}

function boundedCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(1_000_000_000, Math.floor(value))
    : null;
}


/**
 * PostHog's LLM-analytics properties for one settled agent turn: provider,
 * catalog model, token counts, cost and latency. Content-free by construction:
 * there is no input, output, tool, or prompt field to fill.
 */
export function sanitizeAiGenerationProperties(
  payload: ProductAnalyticsAiGeneration | undefined,
): Record<string, string | number | boolean> | null {
  if (!payload || typeof payload !== "object") return null;
  if (payload.status !== "completed" && payload.status !== "interrupted" && payload.status !== "failed") return null;
  if (payload.feature !== "chat" && payload.feature !== "automations") return null;
  const provider = typeof payload.provider === "string" ? payload.provider.trim().toLowerCase() : "";
  const properties: Record<string, string | number | boolean> = {
    $ai_provider: PROVIDER_VALUES.has(provider) ? provider : "other",
    $ai_model: catalogModelId(payload.model),
    $ai_span_name: "agent_turn",
    $ai_is_error: payload.status === "failed",
    feature: payload.feature,
    outcome: payload.status === "completed" ? "completed" : payload.status === "interrupted" ? "cancelled" : "failure",
  };
  const counts: Array<[string, unknown]> = [
    ["$ai_input_tokens", payload.inputTokens],
    ["$ai_output_tokens", payload.outputTokens],
    ["$ai_cache_read_input_tokens", payload.cacheReadTokens],
    ["$ai_cache_creation_input_tokens", payload.cacheCreationTokens],
    ["$ai_reasoning_tokens", payload.reasoningTokens],
  ];
  for (const [key, value] of counts) {
    const count = boundedCount(value);
    if (count != null) properties[key] = count;
  }
  if (typeof payload.costUsd === "number" && Number.isFinite(payload.costUsd) && payload.costUsd >= 0) {
    properties.$ai_total_cost_usd = Math.min(10_000, Math.round(payload.costUsd * 1_000_000) / 1_000_000);
  }
  if (typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs) && payload.durationMs >= 0) {
    properties.$ai_latency = Math.min(86_400, Math.round(payload.durationMs) / 1_000);
  }
  return properties;
}
