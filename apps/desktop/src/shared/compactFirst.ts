import { CLAUDE_PROMPT_CACHE_TTL_MS, claudePromptCacheSinceMs, type ClaudePromptCache } from "./claudePromptCache";
import type { AgentChatEventEnvelope } from "./types/chat";

// ---------------------------------------------------------------------------
// Providers whose `/compact` is a real action ADE can run for the person, and
// therefore the only ones the "Compact first" offer can exist for. Keep in step
// with `providerSupportsManualCompact` (`contextCompaction.ts`).
// ---------------------------------------------------------------------------
const COMPACT_FIRST_PROVIDERS = new Set(["claude", "codex", "pi", "opencode"]);

export function compactFirstSupportedProvider(provider: string | null | undefined): boolean {
  return typeof provider === "string" && COMPACT_FIRST_PROVIDERS.has(provider);
}

// ---------------------------------------------------------------------------
// How long a chat must sit idle before its prompt cache is gone.
//
// The offer says "the cache expired", so this number must never be shorter than
// the real window: an early offer would cost money (the compaction would read
// the chat at full price instead of the cached one). When the window is not
// known, the longest one is assumed, which only makes the offer later.
//
// Claude's is measured per chat (the turn's own cache writes say 5 minutes or
// 1 hour; see `shared/claudePromptCache.ts`). The others are their vendor's
// documented window:
//
//   OpenAI — "Use `prompt_cache_options.ttl` to control the minimum cache
//   lifetime. The only supported value, `30m`, is also the default."
//   https://developers.openai.com/api/docs/guides/prompt-caching
//   (Models before GPT-5.6: `in_memory` is 5-10 minutes, up to an hour.)
//
//   Anthropic — 5 minutes, or 1 hour at 2x the input price.
//   https://platform.claude.com/docs/en/build-with-claude/prompt-caching
//
// Pi and OpenCode run whatever model the person picked, so their cache window
// belongs to that model's vendor, not to the harness. OpenCode reports the
// vendor (`providerID`); Pi ids carry it as a `provider/model` prefix.
// ---------------------------------------------------------------------------
const OPENAI_PROMPT_CACHE_IDLE_MS = 30 * 60 * 1000;
const ANTHROPIC_PROMPT_CACHE_IDLE_MS = 60 * 60 * 1000;
/** No known window: assume the longest, so the offer is never early. */
const UNKNOWN_PROMPT_CACHE_IDLE_MS = ANTHROPIC_PROMPT_CACHE_IDLE_MS;

/** The vendor behind a Pi or OpenCode model id, from its `provider/model` prefix. */
export function compactFirstCacheVendor(model: string | null | undefined): "anthropic" | "openai" | null {
  const id = (model ?? "").toLowerCase();
  if (!id) return null;
  if (/(^|[/:_-])(anthropic|claude)([/:_-]|$)/.test(id)) return "anthropic";
  if (/(^|[/:_-])(openai|codex)([/:_-]|$)/.test(id) || /(^|[/:_-])gpt-/.test(id)) return "openai";
  return null;
}

/** How long this chat's prompt cache lives: the wait before the offer is honest. */
export function compactFirstIdleMs(args: {
  provider: string;
  model?: string | null;
  cache?: ClaudePromptCache | null;
  /** An explicit window, from the brain's summary (`AgentChatSessionSummary.compactFirstIdleMs`). */
  idleMs?: number | null;
}): number {
  if (args.idleMs != null && Number.isFinite(args.idleMs) && args.idleMs > 0) return args.idleMs;
  if (args.provider === "claude") return CLAUDE_PROMPT_CACHE_TTL_MS[args.cache?.ttl ?? "1h"];
  // Codex runs OpenAI models through the Responses API, whatever a custom
  // `model_provider` names (config-reference: `model_providers`, `wire_api`).
  if (args.provider === "codex") return OPENAI_PROMPT_CACHE_IDLE_MS;
  return compactFirstCacheVendor(args.model) === "openai" ? OPENAI_PROMPT_CACHE_IDLE_MS : UNKNOWN_PROMPT_CACHE_IDLE_MS;
}
/**
 * `ADE_COMPACT_FIRST_IDLE_MS` shortens every provider's window for a brain, so
 * the offer can be tried without waiting out a real cache. The brain uses it
 * and sends the result on the session summary; nothing else reads the
 * environment.
 */
export function compactFirstIdleMsFromEnv(env: Record<string, string | undefined>): number | null {
  const parsed = Number(env.ADE_COMPACT_FIRST_IDLE_MS);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
/**
 * When the chat's prompt cache is gone, given when its last turn ended (and
 * started, so a `since` from an earlier turn is not trusted); null with no
 * finished turn. Claude times the entry from the request that wrote or read it
 * (`since`); every other provider counts from the end of the turn, because no
 * cache write is reported to us.
 */
export function compactFirstEligibleAtMs(
  args: { provider: string; model?: string | null; cache?: ClaudePromptCache | null; idleMs?: number | null },
  turnEndedAtMs: number | null,
  turnStartedAtMs?: number | null,
): number | null {
  if (turnEndedAtMs == null || !Number.isFinite(turnEndedAtMs)) return null;
  const idleMs = compactFirstIdleMs(args);
  if (args.provider !== "claude") return turnEndedAtMs + idleMs;
  const sinceMs = claudePromptCacheSinceMs(args.cache ?? null, turnEndedAtMs, turnStartedAtMs);
  return sinceMs == null ? null : sinceMs + idleMs;
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
/** Smallest measured context the offer is worth showing for: Claude Code's own idle-compaction floor. */
export const COMPACT_FIRST_MIN_TOKENS = 200_000;
/**
 * `ADE_COMPACT_FIRST_MIN_TOKENS` lowers that limit for a brain, so the offer
 * can be tried on a small chat. The brain sends it on the session summary;
 * nothing else reads the environment.
 */
export function compactFirstMinTokensFromEnv(env: Record<string, string | undefined>): number | null {
  const parsed = Number(env.ADE_COMPACT_FIRST_MIN_TOKENS);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
export type CompactFirstOffer = { provider: string; contextTokens: number; estimatedPostTokens: number; eligibleAt: number; idleMs: number };

type CompactFirstArgs = {
  provider: string;
  /** The chat's model; Pi and OpenCode name its vendor here (their cache window follows it). */
  model?: string | null;
  events: readonly AgentChatEventEnvelope[];
  contextTokens?: number | null;
  /** The chat's prompt cache after its last turn (`AgentChatSession.promptCache`), Claude only. */
  cache?: ClaudePromptCache | null;
  /** The resolved window from the brain's summary; overrides the table above. */
  idleMs?: number | null;
  /** Overrides `COMPACT_FIRST_MIN_TOKENS` (`AgentChatSessionSummary.compactFirstMinTokens`). */
  minTokens?: number | null;
  mode?: "ask" | "always" | "never";
};

/** Only measured occupancy is eligible; cumulative turn totals are never used. */
export function compactFirstOffer({ now = Date.now(), ...args }: CompactFirstArgs & { now?: number }): CompactFirstOffer | null {
  const offer = compactFirstCandidate(args);
  return offer && now >= offer.eligibleAt ? offer : null;
}

/**
 * Claude Code's own idle compaction fires at this share of a one-hour cache's
 * life: late enough that the chat is truly idle, early enough that the cache
 * is still warm and the compaction reads the chat at the cached price.
 */
const WARM_IDLE_COMPACT_FRACTION = 0.9;

/**
 * When "Always compact first" compacts an idle chat by itself, as Claude Code
 * does: 54 minutes into a one-hour cache, for a chat at least the offer's
 * size. Null when that does not apply (another mode or provider, a 5-minute or
 * unknown cache, a small chat); the chat then compacts on the next send.
 */
export function warmIdleCompactAtMs(args: CompactFirstArgs): number | null {
  if (args.provider !== "claude" || args.mode !== "always" || args.cache?.ttl !== "1h") return null;
  const offer = compactFirstCandidate(args);
  return offer ? offer.eligibleAt - (1 - WARM_IDLE_COMPACT_FRACTION) * offer.idleMs : null;
}

function compactFirstCandidate({ provider, model, events, contextTokens, cache, idleMs: idleMsOverride, minTokens, mode = "ask" }: CompactFirstArgs): CompactFirstOffer | null {
  if (!compactFirstSupportedProvider(provider) || mode === "never") return null;
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
    // Codex reports its occupancy as the thread's per-request counter, not
    // Claude's `context_usage`; `last.inputTokens` already includes the cached
    // portion, so it is the number the meter shows (`contextUsageModel`).
    if (contextTokens == null && event.type === "codex_token_usage") {
      const lastInput = event.usage?.last?.inputTokens;
      if (lastInput != null && Number.isFinite(lastInput) && lastInput > 0) measured = lastInput;
    }
    if (event.type === "context_compact" && event.state !== "started" && event.state !== "failed" && event.postTokens != null) {
      lastPost = event.postTokens;
      if (contextTokens == null) measured = lastPost;
    }
  }
  if (measured == null || !Number.isFinite(measured) || measured < (minTokens ?? COMPACT_FIRST_MIN_TOKENS) || endedAt == null || !Number.isFinite(endedAt)) return null;
  const idleMs = compactFirstIdleMs({ provider, model, cache, idleMs: idleMsOverride });
  const eligibleAt = compactFirstEligibleAtMs({ provider, model, cache, idleMs: idleMsOverride }, endedAt, Number.isFinite(startedAt) ? startedAt : null);
  if (eligibleAt == null) return null;
  return { provider, contextTokens: measured, estimatedPostTokens: lastPost ?? estimateCompactedTokens(measured), eligibleAt, idleMs };
}
