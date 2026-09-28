import type { ThreadModelSelection } from "./types.js";

/** The model fields a runtime summary may carry, all unverified. */
export type ModelSummaryFields = { provider?: unknown; model?: unknown; modelId?: unknown };

/** What to use for a field the summary left out. */
export type ModelSelectionFallback = { provider?: string; model?: string; modelId?: string };

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * The model a summary describes, completed with the catalog display name.
 *
 * The one rule for every place the SDK reports a model — open, resume, list,
 * `setModel`, `update` — so a thread and its row in `threads.list()` can never
 * disagree about what to show:
 *   - each field is the runtime's value, then the fallback's;
 *   - `modelId` falls back further to `model`, because a runtime that reports
 *     only the provider-native token still names the model;
 *   - `displayName` is looked up by `modelId`, then by `model`.
 *
 * Null when neither a model id nor a model token is known.
 */
export function modelSelectionOf(
  summary: ModelSummaryFields | null | undefined,
  names: ReadonlyMap<string, string>,
  fallback: ModelSelectionFallback = {},
): ThreadModelSelection | null {
  const provider = nonEmpty(summary?.provider) ?? fallback.provider ?? "";
  const model = nonEmpty(summary?.model) ?? fallback.model ?? "";
  const modelId = nonEmpty(summary?.modelId) ?? fallback.modelId ?? model;
  if (!modelId && !model) return null;
  return {
    modelId,
    provider,
    model,
    displayName: names.get(modelId) ?? names.get(model) ?? null,
  };
}
