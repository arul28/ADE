/**
 * Shared formatting utilities for PR UI components.
 * Consolidates duplicated timestamp-formatting and error-formatting logic.
 */

/** Relative "time ago" label: "just now", "3m ago", "2h ago", "5d ago", or a short date. */
export function formatTimeAgo(iso: string | null): string {
  if (!iso) return "---";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Compact relative label without "ago" suffix: "now", "3m", "2h", "5d", "2mo". */
export function formatTimeAgoCompact(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

/** Full date/time label: "Jan 15, 2026, 02:30 PM" */
export function formatTimestampFull(iso: string | null): string {
  if (!iso) return "---";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Short date/time label: "Jan 15, 02:30 PM" */
export function formatTimestampShort(iso: string | null): string {
  if (!iso) return "---";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Extract a human-readable error message from an unknown thrown value. */
export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
