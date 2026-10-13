import { CLAUDE_PROMPT_CACHE_TTL_MS, type ClaudePromptCacheTtl } from "./claudePromptCache";
import type { AgentChatEventEnvelope } from "./types/chat";

/** How long the chat must sit idle before its prompt cache is gone; an hour when the lifetime is not known. */
export function compactFirstIdleMs(cacheTtl: ClaudePromptCacheTtl | null | undefined): number {
  return CLAUDE_PROMPT_CACHE_TTL_MS[cacheTtl ?? "1h"];
}
/**
 * A compacted chat never gets smaller than its fixed part (system prompt,
 * tools, the summary's frame): two measured Claude compactions of 67k and 81k
 * both ended near 5.5k, where 2% alone would promise 1.5k.
 */
const COMPACTED_FLOOR_TOKENS = 5_000;
/** Size after compaction when the chat has none to go by: 2% of the context, never under the floor. */
export function estimateCompactedTokens(contextTokens: number): number {
  return Math.max(COMPACTED_FLOOR_TOKENS, Math.round(contextTokens * 0.02));
}
/** Smallest measured context the offer is worth showing for. */
export const COMPACT_FIRST_MIN_TOKENS = 100_000;
/**
 * `ADE_COMPACT_FIRST_MIN_TOKENS` lowers that limit for a brain, so the offer
 * can be tried on a small chat. The brain sends it on the session summary;
 * nothing else reads the environment.
 */
export function compactFirstMinTokensFromEnv(env: Record<string, string | undefined>): number | null {
  const parsed = Number(env.ADE_COMPACT_FIRST_MIN_TOKENS);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
export type CompactFirstOffer = { contextTokens: number; estimatedPostTokens: number; eligibleAt: number; idleMs: number };

/** Only measured occupancy is eligible; cumulative turn totals are never used. */
export function compactFirstOffer({ provider, events, contextTokens, cacheTtl, minTokens, mode = "ask", now = Date.now() }: {
  provider: string;
  events: readonly AgentChatEventEnvelope[];
  contextTokens?: number | null;
  /** The lifetime the chat's cache was last written with (`AgentChatSession.promptCacheTtl`). */
  cacheTtl?: ClaudePromptCacheTtl | null;
  /** Overrides `COMPACT_FIRST_MIN_TOKENS` (`AgentChatSessionSummary.compactFirstMinTokens`). */
  minTokens?: number | null;
  mode?: "ask" | "always" | "never";
  now?: number;
}): CompactFirstOffer | null {
  if (provider !== "claude" || mode === "never") return null;
  let endedAt: number | null = null;
  let measured = contextTokens;
  let lastPost: number | null = null;
  for (const { event, timestamp } of events) {
    if (event.type === "status" && event.turnStatus === "started") endedAt = null;
    if (event.type === "done") {
      endedAt = Date.parse(timestamp);
      if (contextTokens == null && event.usage?.contextTokens != null) measured = event.usage.contextTokens;
    }
    if (contextTokens == null && event.type === "context_usage" && (!event.state || event.state === "measured")) measured = event.usage.totalTokens;
    if (event.type === "context_compact" && event.state !== "started" && event.state !== "failed" && event.postTokens != null) {
      lastPost = event.postTokens;
      if (contextTokens == null) measured = lastPost;
    }
  }
  if (measured == null || !Number.isFinite(measured) || measured < (minTokens ?? COMPACT_FIRST_MIN_TOKENS) || endedAt == null || !Number.isFinite(endedAt)) return null;
  const idleMs = compactFirstIdleMs(cacheTtl);
  const eligibleAt = endedAt + idleMs;
  if (now < eligibleAt) return null;
  return { contextTokens: measured, estimatedPostTokens: lastPost ?? estimateCompactedTokens(measured), eligibleAt, idleMs };
}
