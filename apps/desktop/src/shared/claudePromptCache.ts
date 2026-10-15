/** The two lifetimes Claude Code writes prompt cache entries with. */
export type ClaudePromptCacheTtl = "5m" | "1h";

export const CLAUDE_PROMPT_CACHE_TTL_MS: Record<ClaudePromptCacheTtl, number> = {
  "5m": 5 * 60_000,
  "1h": 60 * 60_000,
};

export function isClaudePromptCacheTtl(value: unknown): value is ClaudePromptCacheTtl {
  return value === "5m" || value === "1h";
}

/**
 * What ADE knows about a Claude chat's prompt cache after its last turn.
 * `since` is when Claude started the lifetime: the start of the turn's last
 * model request (a write or a read both restart it). Absent when the turn
 * reported no request time; the turn's end is then the nearest known moment.
 */
export type ClaudePromptCache = { ttl: ClaudePromptCacheTtl; since?: string };

export function normalizeClaudePromptCache(value: unknown): ClaudePromptCache | null {
  if (!value || typeof value !== "object") return null;
  const { ttl, since } = value as { ttl?: unknown; since?: unknown };
  if (!isClaudePromptCacheTtl(ttl)) return null;
  return typeof since === "string" && Number.isFinite(Date.parse(since)) ? { ttl, since } : { ttl };
}

/**
 * When the lifetime started, in ms: `since`, else the turn end the caller knows.
 * Pass the start of that same turn when the turn comes from the event stream
 * rather than the summary that carries `since`: a `since` older than the turn
 * belongs to an earlier one (the summary has not caught up yet), and the turn
 * itself restarted the cache, so its end is the nearer moment.
 */
export function claudePromptCacheSinceMs(
  cache: ClaudePromptCache | null | undefined,
  turnEndedAtMs: number | null,
  turnStartedAtMs?: number | null,
): number | null {
  const since = cache?.since ? Date.parse(cache.since) : Number.NaN;
  if (!Number.isFinite(since)) return turnEndedAtMs;
  return turnStartedAtMs != null && turnEndedAtMs != null && since < turnStartedAtMs ? turnEndedAtMs : since;
}

/**
 * The lifetime a turn's main-conversation cache writes used. Claude Code picks
 * it per request (1 hour on a subscription within its limits, 5 minutes on an
 * API key, Bedrock, Vertex or extra usage), so the writes are the only truth.
 * A turn can hold both (a server tool adds a small 5-minute write behind a
 * 1-hour prefix, or the account crossed into extra usage midway): the lifetime
 * of most of what was written wins. Null when the turn wrote nothing or the
 * provider did not report the split.
 */
export function claudePromptCacheTtlOfWrites(
  cacheWriteTokens: number | null | undefined,
  cacheWrite1hTokens: number | null | undefined,
): ClaudePromptCacheTtl | null {
  if (cacheWrite1hTokens == null) return null;
  const written = Math.max(cacheWriteTokens ?? 0, cacheWrite1hTokens);
  if (written <= 0) return null;
  return cacheWrite1hTokens * 2 >= written ? "1h" : "5m";
}
