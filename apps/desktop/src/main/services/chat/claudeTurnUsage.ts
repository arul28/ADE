import { resolveClaudeCliModel } from "../ai/claudeModelUtils";
import { asRecord, finiteNumberOrNull } from "../shared/utils";

/**
 * What a Claude turn's model requests say that its `result` message does not.
 *
 * The result's `usage` sums every request in the turn, so it cannot say how
 * many requests there were or what the context held when the turn ended. Each
 * main-thread `message_start` stream event is one request, and its usage is
 * that request's whole input side. Subagent requests arrive with a
 * `parent_tool_use_id` and are filtered out before they reach this tally.
 */
export type ClaudeTurnRequestTally = {
  requestCount: number;
  /** Input side (uncached input + cache read + cache write) of the last request. */
  contextTokens: number | null;
};

export function createClaudeTurnRequestTally(): ClaudeTurnRequestTally {
  return { requestCount: 0, contextTokens: null };
}

/** Counts one main-thread `message_start` and keeps its input side. */
export function recordClaudeRequestStart(
  tally: ClaudeTurnRequestTally,
  usage: Record<string, unknown> | null | undefined,
): void {
  tally.requestCount += 1;
  const input = finiteNumberOrNull(usage?.input_tokens);
  const cacheRead = finiteNumberOrNull(usage?.cache_read_input_tokens);
  const cacheWrite = finiteNumberOrNull(usage?.cache_creation_input_tokens);
  if (input == null && cacheRead == null && cacheWrite == null) return;
  tally.contextTokens = Math.max(0, input ?? 0) + Math.max(0, cacheRead ?? 0) + Math.max(0, cacheWrite ?? 0);
}

type ClaudeDoneUsage = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  thinkingTokens?: number | null;
  cacheWrite1hTokens?: number | null;
  contextTokens?: number | null;
  contextWindow?: number | null;
  requestCount?: number | null;
};

/**
 * The done event's usage with the turn's request count, its closing context
 * size, and the model's context window added. A turn that made no request and
 * has no usage stays without one, so no usage row is invented.
 */
export function withClaudeTurnRequestUsage<T extends ClaudeDoneUsage>(
  usage: T | undefined,
  tally: ClaudeTurnRequestTally,
  contextWindow: number | null | undefined,
): (T & ClaudeDoneUsage) | undefined {
  if (!usage && tally.requestCount === 0) return usage;
  return {
    ...(usage ?? {}),
    ...(tally.contextTokens != null ? { contextTokens: tally.contextTokens } : {}),
    ...(tally.requestCount > 0 ? { requestCount: tally.requestCount } : {}),
    ...(contextWindow != null && contextWindow > 0 ? { contextWindow } : {}),
  } as T & ClaudeDoneUsage;
}

function reportedModelName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/**
 * The model that answered, from ModelUsage (keyed by the model that served each
 * request), with that model's context window. One key is that model. Several
 * keys mean subagents or side calls ran on other models; the one that wrote
 * the most output carried the turn, and a tie names no one.
 */
export function pickClaudeLeadingModelUsage(
  modelUsage: Record<string, unknown>,
): { model: string; contextWindow: number | null } | undefined {
  const entries = Object.entries(modelUsage)
    .map(([key, row]) => ({
      model: reportedModelName(key),
      outputTokens: finiteNumberOrNull(asRecord(row)?.outputTokens ?? asRecord(row)?.output_tokens) ?? 0,
      contextWindow: finiteNumberOrNull(asRecord(row)?.contextWindow ?? asRecord(row)?.context_window),
    }))
    .filter((entry): entry is { model: string; outputTokens: number; contextWindow: number | null } => entry.model !== null);
  if (entries.length === 0) return undefined;
  const top = Math.max(...entries.map((entry) => entry.outputTokens));
  const leaders = entries.filter((entry) => entry.outputTokens === top);
  const leader = entries.length === 1 ? entries[0] : leaders.length === 1 && top > 0 ? leaders[0] : undefined;
  return leader ? { model: leader.model, contextWindow: leader.contextWindow } : undefined;
}

/**
 * `done.servedModel` for Claude: the ModelUsage candidate, only when it names a
 * different model than the session asked for.
 *
 * `resolveModelId` maps a reported name to its ADE model id through the table
 * the done payload uses, so `opus` asking for Opus and `claude-opus-5-5[1m]`
 * answering is not a difference. A name that table does not know is compared
 * by its Claude CLI model.
 */
export function resolveClaudeServedModel(args: {
  candidate: string | null | undefined;
  sessionModel: string;
  sessionModelId: string | null;
  resolveModelId: (served: string) => string | undefined;
}): string | null {
  const served = reportedModelName(args.candidate);
  if (!served) return null;
  const servedModelId = args.resolveModelId(served);
  if (servedModelId) {
    return args.sessionModelId && servedModelId === args.sessionModelId ? null : served;
  }
  return resolveClaudeCliModel(served) === resolveClaudeCliModel(args.sessionModel) ? null : served;
}
