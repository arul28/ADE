import { CLAUDE_PROMPT_CACHE_TTL_MS, claudePromptCacheSinceMs, type ClaudePromptCache, type ClaudePromptCacheTtl } from "../../shared/claudePromptCache";

/** The 1-hour cache needs no countdown until it is nearly gone. */
const LONG_CACHE_WARNING_MS = 10 * 60_000;
/**
 * The 1-hour countdown ends a little before the hour: measured cache misses
 * climb from 55 minutes idle, and a message started at 0:10 has to reach Claude
 * before the entry is gone.
 */
const LONG_CACHE_EARLY_END_MS = 5 * 60_000;

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** When the countdown shows and ends, as time since the turn finished. */
function countdownWindowMs(cacheTtl: ClaudePromptCacheTtl): { showAfterMs: number; endMs: number } {
  if (cacheTtl === "5m") return { showAfterMs: 0, endMs: CLAUDE_PROMPT_CACHE_TTL_MS["5m"] };
  const endMs = CLAUDE_PROMPT_CACHE_TTL_MS["1h"] - LONG_CACHE_EARLY_END_MS;
  return { showAfterMs: endMs - LONG_CACHE_WARNING_MS, endMs };
}

/**
 * Where the chat's countdown stands. `remainingMs` is 0 once it is over, while
 * a turn runs, or when the chat's cache is unknown; `showInMs` is how long the
 * badge stays hidden before its window opens (0 while it shows). Time counts
 * from `cache.since`, else from the turn end (`idleSinceAt`).
 */
export function claudeCacheCountdown(
  idleSinceAt: string | null | undefined,
  cache: ClaudePromptCache | null | undefined,
  nowMs = Date.now(),
): { remainingMs: number; showInMs: number } {
  const idleSinceMs = parseTimestampMs(idleSinceAt);
  const sinceMs = claudePromptCacheSinceMs(cache, idleSinceMs);
  if (idleSinceMs == null || sinceMs == null || !cache) return { remainingMs: 0, showInMs: 0 };
  const elapsedMs = Math.max(0, nowMs - sinceMs);
  const { showAfterMs, endMs } = countdownWindowMs(cache.ttl);
  return { remainingMs: Math.max(0, endMs - elapsedMs), showInMs: Math.max(0, showAfterMs - elapsedMs) };
}

export function formatClaudeCacheTtl(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Whether to mount the badge: an idle Claude chat with a known prompt cache
 * whose countdown is not over. The badge itself stays hidden until its window
 * opens (`claudeCacheCountdown().showInMs`).
 */
export function shouldShowClaudeCacheTtl(args: {
  provider: string | null | undefined;
  status: string | null | undefined;
  idleSinceAt: string | null | undefined;
  cache: ClaudePromptCache | null | undefined;
  awaitingInput?: boolean;
  nowMs?: number;
}): boolean {
  if (args.provider !== "claude") return false;
  if (args.status !== "idle") return false;
  if (args.awaitingInput) return false;
  return claudeCacheCountdown(args.idleSinceAt, args.cache, args.nowMs).remainingMs > 0;
}
