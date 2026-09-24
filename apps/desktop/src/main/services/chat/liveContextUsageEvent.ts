import type {
  AgentChatContextUsage,
  AgentChatContextUsageCategory,
  AgentChatContextUsageState,
  AgentChatEvent,
} from "../../../shared/types";

type ContextUsageEvent = Extract<AgentChatEvent, { type: "context_usage" }>;

/** Percent of the window, clamped to 0–100 and rounded to two decimals. */
export function contextPercentage(tokens: number, maxTokens: number): number {
  if (!(maxTokens > 0) || !Number.isFinite(tokens)) return 0;
  return Math.round(Math.max(0, Math.min(100, (tokens / maxTokens) * 100)) * 100) / 100;
}

/**
 * The one builder for a provider's live context-occupancy sample. Every
 * runtime that reads a used/max pair (ACP, Cursor, Droid, OpenCode, Pi) goes
 * through here, so the meter gets the same clamping and rounding everywhere.
 */
export function liveContextUsageEvent(args: {
  used: number;
  max: number;
  turnId?: string | null;
  model?: string | null;
  rawMaxTokens?: number | null;
  categories?: AgentChatContextUsageCategory[];
  breakdown?: Pick<AgentChatContextUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens"> | null;
  state?: AgentChatContextUsageState;
  origin?: ContextUsageEvent["origin"];
}): ContextUsageEvent {
  const used = Math.max(0, args.used);
  const max = Math.max(0, args.max);
  const breakdown = args.breakdown ?? {};
  return {
    type: "context_usage",
    origin: args.origin ?? "live",
    usage: {
      categories: args.categories ?? [],
      totalTokens: used,
      maxTokens: max,
      ...(args.rawMaxTokens != null ? { rawMaxTokens: args.rawMaxTokens } : {}),
      percentage: contextPercentage(used, max),
      ...(args.model ? { model: args.model } : {}),
      ...(breakdown.inputTokens !== undefined ? { inputTokens: breakdown.inputTokens } : {}),
      ...(breakdown.outputTokens !== undefined ? { outputTokens: breakdown.outputTokens } : {}),
      ...(breakdown.cacheReadTokens !== undefined ? { cacheReadTokens: breakdown.cacheReadTokens } : {}),
      ...(breakdown.cacheCreationTokens !== undefined ? { cacheCreationTokens: breakdown.cacheCreationTokens } : {}),
    },
    ...(args.state ? { state: args.state } : {}),
    ...(args.turnId ? { turnId: args.turnId } : {}),
  };
}
