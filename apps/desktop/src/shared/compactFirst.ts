import { CLAUDE_PROMPT_CACHE_TTL_MS, claudePromptCacheSinceMs, type ClaudePromptCache } from "./claudePromptCache";
import type { AgentChatEventEnvelope } from "./types/chat";

/** How long the chat must sit idle before its prompt cache is gone; an hour when the lifetime is not known. */
export function compactFirstIdleMs(cache: ClaudePromptCache | null | undefined): number {
  return CLAUDE_PROMPT_CACHE_TTL_MS[cache?.ttl ?? "1h"];
}
/**
 * When the chat's prompt cache is gone, given when its last turn ended (and
 * started, so a `since` from an earlier turn is not trusted); null with no
 * finished turn.
 */
export function compactFirstEligibleAtMs(cache: ClaudePromptCache | null | undefined, turnEndedAtMs: number | null, turnStartedAtMs?: number | null): number | null {
  const sinceMs = claudePromptCacheSinceMs(cache, turnEndedAtMs, turnStartedAtMs);
  return turnEndedAtMs == null || sinceMs == null ? null : sinceMs + compactFirstIdleMs(cache);
}
/**
 * When the chat's last finished turn ended and started. Walks back only to
 * that turn's start, so it stays cheap while deltas stream; a turn still
 * running is skipped, and the one before it counts.
 */
export function lastFinishedTurnMs(events: readonly AgentChatEventEnvelope[]): { endedAtMs: number | null; startedAtMs: number | null } {
  let endedAtMs: number | null = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const entry = events[index];
    if (endedAtMs == null && entry?.event.type === "done") endedAtMs = finiteOrNull(Date.parse(entry.timestamp));
    else if (endedAtMs != null && entry?.event.type === "status" && entry.event.turnStatus === "started") {
      return { endedAtMs, startedAtMs: finiteOrNull(Date.parse(entry.timestamp)) };
    }
  }
  return { endedAtMs, startedAtMs: null };
}
function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
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
export function compactFirstOffer({ provider, events, contextTokens, cache, minTokens, mode = "ask", now = Date.now() }: {
  provider: string;
  events: readonly AgentChatEventEnvelope[];
  contextTokens?: number | null;
  /** The chat's prompt cache after its last turn (`AgentChatSession.promptCache`). */
  cache?: ClaudePromptCache | null;
  /** Overrides `COMPACT_FIRST_MIN_TOKENS` (`AgentChatSessionSummary.compactFirstMinTokens`). */
  minTokens?: number | null;
  mode?: "ask" | "always" | "never";
  now?: number;
}): CompactFirstOffer | null {
  if (provider !== "claude" || mode === "never") return null;
  let endedAt: number | null = null;
  let startedAt: number | null = null;
  let measured = contextTokens;
  let lastPost: number | null = null;
  for (const { event, timestamp } of events) {
    if (event.type === "status" && event.turnStatus === "started") {
      endedAt = null;
      startedAt = Date.parse(timestamp);
    }
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
  const idleMs = compactFirstIdleMs(cache);
  const eligibleAt = compactFirstEligibleAtMs(cache, endedAt, Number.isFinite(startedAt) ? startedAt : null);
  if (eligibleAt == null) return null;
  if (now < eligibleAt) return null;
  return { contextTokens: measured, estimatedPostTokens: lastPost ?? estimateCompactedTokens(measured), eligibleAt, idleMs };
}
