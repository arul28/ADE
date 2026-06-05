import type { CodexThreadTokenUsage } from "../../../../shared/types";

/**
 * Provider-agnostic context-usage view-model consumed by `ContextUsageDial`.
 *
 * The five chat runtimes report token usage in different shapes (Codex pushes a
 * live `CodexThreadTokenUsage` with `modelContextWindow`; the others stuff a
 * 4-field breakdown onto the terminal `done` event). `toUsageViewModel` flattens
 * any of them into one shape so a single dial renders for every provider, and
 * resolves the context-window percentage with a registry fallback when the
 * runtime doesn't report one. Pure — no React / model-registry imports — so it
 * is cheap to unit-test.
 */
export type ContextUsageViewModel = {
  provider: string;
  /** Effective context window for the active model, or null when unknown. */
  contextWindow: number | null;
  /** Tokens counted against the window (current context occupancy, see below). */
  usedTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  /** clamp(usedTokens / contextWindow, 0, 1), or null when the window is unknown. */
  ratio: number | null;
  /** Where the window came from: the runtime stream vs the static model registry. */
  windowSource: "runtime" | "registry" | null;
};

export type GenericUsageInput = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
};

export type ContextUsageInput =
  | { kind: "codex"; provider: string; usage: CodexThreadTokenUsage }
  | { kind: "generic"; provider: string; usage: GenericUsageInput; contextWindow?: number | null };

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Compact token count: `1.2M`, `42.7k`, or the integer. Returns null for non-positive. */
export function formatContextTokens(value: number | null | undefined): string | null {
  const n = positive(value);
  if (n == null) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/**
 * Map a provider usage payload into the unified view-model.
 *
 * `fallbackContextWindow` is the active model's registry window (resolved by the
 * caller, which has the model id) — used only when the runtime doesn't report
 * one of its own.
 *
 * "Context occupancy" math: we want "how full is the window", i.e. the size of
 * the prompt the model is carrying — not lifetime cumulative usage.
 * - Codex `inputTokens` already includes cached tokens, so the last turn's
 *   `inputTokens` IS the occupancy.
 * - The other providers report cache separately from `inputTokens`, so the
 *   occupancy is `input + cacheRead + cacheWrite`.
 */
export function toUsageViewModel(
  input: ContextUsageInput | null,
  fallbackContextWindow?: number | null,
): ContextUsageViewModel | null {
  if (!input) return null;

  let inputTokens: number | null;
  let outputTokens: number | null;
  let cacheReadTokens: number | null;
  let cacheWriteTokens: number | null;
  let reasoningTokens: number | null;
  let totalTokens: number | null;
  let runtimeWindow: number | null;
  let usedTokens: number | null;

  if (input.kind === "codex") {
    const last = input.usage.last ?? {};
    const total = input.usage.total ?? {};
    inputTokens = positive(last.inputTokens) ?? positive(total.inputTokens);
    outputTokens = positive(last.outputTokens) ?? positive(total.outputTokens);
    cacheReadTokens = positive(last.cacheReadTokens) ?? positive(total.cacheReadTokens);
    cacheWriteTokens = positive(last.cacheWriteTokens) ?? positive(total.cacheWriteTokens);
    reasoningTokens = positive(last.reasoningTokens) ?? positive(total.reasoningTokens);
    totalTokens = positive(total.totalTokens);
    runtimeWindow = positive(input.usage.modelContextWindow);
    // Codex inputTokens already includes the cached portion → it is the occupancy.
    usedTokens =
      inputTokens
      ?? (positive(last.outputTokens) != null ? (last.inputTokens ?? 0) + (last.outputTokens ?? 0) || null : null)
      ?? totalTokens;
  } else {
    const u = input.usage;
    inputTokens = positive(u.inputTokens);
    outputTokens = positive(u.outputTokens);
    cacheReadTokens = positive(u.cacheReadTokens);
    cacheWriteTokens = positive(u.cacheWriteTokens);
    reasoningTokens = positive(u.reasoningTokens);
    totalTokens = positive(u.totalTokens);
    runtimeWindow = positive(input.contextWindow);
    // Non-codex providers report cache separately from input → sum for occupancy.
    const occupancy = (inputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
    usedTokens = occupancy > 0 ? occupancy : totalTokens;
  }

  const contextWindow = runtimeWindow ?? positive(fallbackContextWindow);
  const windowSource: ContextUsageViewModel["windowSource"] =
    runtimeWindow != null ? "runtime" : contextWindow != null ? "registry" : null;
  const ratio =
    contextWindow != null && usedTokens != null ? clamp01(usedTokens / contextWindow) : null;

  // Nothing meaningful to display → null (preserves the old hide-when-empty behavior).
  if (usedTokens == null && inputTokens == null && outputTokens == null) {
    return null;
  }

  return {
    provider: input.provider,
    contextWindow,
    usedTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    ratio,
    windowSource,
  };
}
