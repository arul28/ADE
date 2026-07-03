export function formatRelativePastTime(timestamp: string | null | undefined, nowMs = Date.now()): string {
  if (!timestamp) return "ended";
  const thenMs = Date.parse(timestamp);
  if (!Number.isFinite(thenMs)) return "ended";
  const diffSeconds = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (diffSeconds < 45) return "just now";
  if (diffSeconds < 90) return "1m ago";
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${Math.max(1, years)}y ago`;
}
