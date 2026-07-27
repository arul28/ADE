import type {
  AgentChatContextUsageState,
  AgentChatEventEnvelope,
  CodexThreadTokenUsage,
} from "../../../../shared/types";

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
  state: AgentChatContextUsageState;
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
  /** Exact context occupancy snapshot (for example Claude post-compaction usage). */
  usedTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
};

export type ContextUsageInput =
  | { kind: "codex"; provider: string; usage: CodexThreadTokenUsage; state?: AgentChatContextUsageState }
  | { kind: "generic"; provider: string; usage: GenericUsageInput; contextWindow?: number | null; state?: AgentChatContextUsageState };

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Compact token count: `1.2M`, `42.7k`, or the integer. Returns null for negative/missing. */
export function formatContextTokens(value: number | null | undefined): string | null {
  const n = nonNegative(value);
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
    const exactInputTokens = nonNegative(last.inputTokens) ?? nonNegative(total.inputTokens);
    inputTokens = positive(last.inputTokens) ?? positive(total.inputTokens);
    outputTokens = positive(last.outputTokens) ?? positive(total.outputTokens);
    cacheReadTokens = positive(last.cacheReadTokens) ?? positive(total.cacheReadTokens);
    cacheWriteTokens = positive(last.cacheWriteTokens) ?? positive(total.cacheWriteTokens);
    reasoningTokens = positive(last.reasoningTokens) ?? positive(total.reasoningTokens);
    totalTokens = positive(total.totalTokens);
    runtimeWindow = positive(input.usage.modelContextWindow);
    // Codex inputTokens already includes the cached portion → it is the occupancy.
    usedTokens =
      exactInputTokens
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
    // Exact snapshots beat the provider-specific fallback math. This is used at
    // compaction boundaries, where per-turn counters can still describe the
    // pre-compaction request even though the active context was replaced.
    const exactOccupancy = nonNegative(u.usedTokens);
    const occupancy = (inputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
    usedTokens = exactOccupancy ?? (occupancy > 0 ? occupancy : totalTokens);
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
    state: input.state ?? "measured",
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

/**
 * Reduce the event stream to the newest trustworthy context-occupancy signal.
 *
 * A completed compaction invalidates all earlier usage. Generic SDK `done` /
 * `tokens` events are deliberately ignored until an explicit later turn starts: Cursor,
 * OpenCode, Droid, and Claude can report per-turn or cumulative counters after
 * the history has already been replaced. Claude's `postTokens` boundary and
 * `context_usage`, plus Codex's live thread usage notification, are exact
 * snapshots and may update the meter immediately.
 */
export function latestContextUsageInput(
  events: AgentChatEventEnvelope[],
  provider: string,
  fallbackCodexUsage?: CodexThreadTokenUsage | null,
): ContextUsageInput | null {
  let current: ContextUsageInput | null =
    fallbackCodexUsage && provider === "codex"
      ? { kind: "codex", provider, usage: fallbackCodexUsage, state: "measured" }
      : null;
  let lastRuntimeWindow = positive(fallbackCodexUsage?.modelContextWindow);
  let compactionProtected = false;
  let protectedCompactionTurnId: string | null = null;

  const acceptGeneric = (
    usage: GenericUsageInput,
    contextWindow?: number | null,
  ): void => {
    if (compactionProtected) return;
    const runtimeWindow = positive(contextWindow);
    if (runtimeWindow != null) lastRuntimeWindow = runtimeWindow;
    current = { kind: "generic", provider, usage, contextWindow, state: "measured" };
  };

  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "status" && event.turnStatus === "started"
      && compactionProtected && event.turnId
      && (!protectedCompactionTurnId || event.turnId !== protectedCompactionTurnId)) {
      compactionProtected = false;
      protectedCompactionTurnId = null;
    }
    if (event.type === "codex_token_usage") {
      if (positive(event.usage.modelContextWindow) != null) {
        lastRuntimeWindow = positive(event.usage.modelContextWindow);
      }
      const hasContextOccupancy = typeof event.usage.last?.inputTokens === "number"
        || typeof event.usage.total?.inputTokens === "number";
      if (!hasContextOccupancy) continue;
      current = { kind: "codex", provider: provider || "codex", usage: event.usage, state: "measured" };
      continue;
    }
    if (event.type === "context_usage") {
      lastRuntimeWindow = positive(event.usage.maxTokens) ?? lastRuntimeWindow;
      // Surface the same breakdown the old inline card showed, so the composer
      // meter's hover is a complete replacement. `usedTokens` stays the total
      // occupancy (drives the ring %); the typed per-turn fields (present on
      // automatic "live" snapshots) fill the breakdown line. When they're absent
      // (SDK `/context` command payload), fall back to showing the total as input.
      const inputTokens = positive(event.usage.inputTokens);
      const outputTokens = positive(event.usage.outputTokens);
      const cacheReadTokens = positive(event.usage.cacheReadTokens);
      const cacheWriteTokens = positive(event.usage.cacheCreationTokens);
      const hasBreakdown =
        inputTokens != null || outputTokens != null || cacheReadTokens != null || cacheWriteTokens != null;
      current = {
        kind: "generic",
        provider,
        usage: {
          usedTokens: event.usage.totalTokens,
          inputTokens: hasBreakdown ? inputTokens : event.usage.totalTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          totalTokens: event.usage.totalTokens,
        },
        contextWindow: event.usage.maxTokens,
        state: event.state ?? "measured",
      };
      continue;
    }
    const startedCompaction = (event.type === "context_compact" && event.state === "started")
      || (event.type === "codex_context_compaction" && event.state === "started");
    if (startedCompaction) {
      if (current) current = { ...current, state: "compacting" };
      continue;
    }
    const completedCompaction = (event.type === "context_compact" && event.state !== "started")
      || (event.type === "codex_context_compaction" && event.state === "completed");
    if (completedCompaction) {
      compactionProtected = true;
      protectedCompactionTurnId = event.turnId ?? null;
      current = event.type === "context_compact" && event.postTokens != null
        ? {
            kind: "generic",
            provider,
            usage: { usedTokens: event.postTokens, inputTokens: event.postTokens },
            contextWindow: lastRuntimeWindow,
            state: "measured",
          }
        : current
          ? { ...current, state: "recalculating" }
          : null;
      continue;
    }
    if (event.type === "done" && event.usage) {
      acceptGeneric({
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        cacheReadTokens: event.usage.cacheReadTokens,
        cacheWriteTokens: event.usage.cacheCreationTokens,
        reasoningTokens: event.usage.reasoningTokens,
      }, event.usage.contextWindow);
      continue;
    }
    if (event.type === "tokens") {
      acceptGeneric({
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheWriteTokens: event.cacheWriteTokens,
      }, event.contextWindow);
    }
  }

  return current;
}
