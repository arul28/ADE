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
 * The lifetime a turn's main-conversation cache writes used. Claude Code picks
 * it per request (1 hour on a subscription within its limits, 5 minutes on an
 * API key, Bedrock, Vertex or extra usage), so the writes are the only truth.
 * Null when the turn wrote nothing or the provider did not report the split.
 */
export function claudePromptCacheTtlOfWrites(
  cacheWriteTokens: number | null | undefined,
  cacheWrite1hTokens: number | null | undefined,
): ClaudePromptCacheTtl | null {
  if (cacheWrite1hTokens == null) return null;
  if (cacheWrite1hTokens > 0) return "1h";
  return (cacheWriteTokens ?? 0) > 0 ? "5m" : null;
}
