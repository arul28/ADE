export const CLAUDE_CHAT_CACHE_TTL_MS = 5 * 60 * 1000;

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getClaudeCacheTtlRemainingMs(
  idleSinceAt: string | null | undefined,
  nowMs = Date.now(),
): number {
  const idleSinceMs = parseTimestampMs(idleSinceAt);
  if (idleSinceMs == null) return 0;
  return Math.max(0, CLAUDE_CHAT_CACHE_TTL_MS - Math.max(0, nowMs - idleSinceMs));
}

export function formatClaudeCacheTtl(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function shouldShowClaudeCacheTtl(args: {
  provider: string | null | undefined;
  status: string | null | undefined;
  idleSinceAt: string | null | undefined;
  awaitingInput?: boolean;
  nowMs?: number;
}): boolean {
  if (args.provider !== "claude") return false;
  if (args.status !== "idle") return false;
  if (args.awaitingInput) return false;
  return getClaudeCacheTtlRemainingMs(args.idleSinceAt, args.nowMs) > 0;
}

export function buildClaudeCacheTtlTitle(remainingMs: number): string {
  const label = formatClaudeCacheTtl(remainingMs);
  return `Claude keeps prompt cache warm for about five minutes after a turn finishes. Send the next message before this reaches 0 to reuse that cache. ${label} remaining.`;
}
