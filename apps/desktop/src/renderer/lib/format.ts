/** Shared formatting utilities for the renderer. */

/** Format a byte count into a short human-readable size (e.g. "1.4 GB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** Returns a compact relative time label (e.g. "now", "2m", "1h", "3d") for sidebar cards. */
export function relativeTimeCompact(iso: string | null | undefined): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const delta = Math.max(0, Date.now() - ts);
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Returns a human-readable relative time for an ISO timestamp. */
export function relativeWhen(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const delta = Math.max(0, Date.now() - ts);
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Format an ISO timestamp to a locale string, returning a fallback for invalid/null. */
export function formatDate(ts: string | null, fallback = "-"): string {
  if (!ts) return fallback;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleString();
}

/** Format an ISO timestamp to HH:MM time string. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Format milliseconds into a compact human-readable duration. */
export function formatDurationMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "--";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/** Format subagent activity durations using the chat cards' rounded compact style. */
export function formatSubagentDurationMs(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const roundedSeconds = Math.max(1, Math.round(value / 1000));
  if (roundedSeconds >= 60) return `${Math.round(value / 60_000)}m`;
  return `${roundedSeconds}s`;
}

/** Format elapsed time since a given ISO timestamp. */
export function formatElapsedSince(startIso: string): string {
  const ms = Math.max(0, Date.now() - Date.parse(startIso));
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

/** Format a token count with K/M/B suffixes. */
export function formatTokens(n: number): string {
  const value = Number.isFinite(n) ? Math.max(0, n) : 0;
  if (value >= 999_950_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 999_950) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.floor(value));
}

/** Format a USD cost value. */
export function formatCost(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Map a status string to Tailwind text+border classes (automations style). */
export function statusToneAutomation(status: string | null): string {
  if (status === "succeeded") return "border-emerald-500/40 text-emerald-300";
  if (status === "failed") return "border-red-500/40 text-red-300";
  if (status === "running") return "border-amber-500/40 text-amber-300";
  if (status === "skipped") return "border-border text-muted-fg";
  if (status === "cancelled") return "border-border text-muted-fg";
  return "border-border text-muted-fg";
}

/** Extract a human-readable error message from an unknown thrown value. */
export function extractError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Shorten a SHA-like hash to the first 8 characters. */
export function shortSha(value: string | null | undefined): string {
  return value?.slice(0, 8) ?? "";
}

/** Map an operation status to Tailwind text+border classes (history style). */
export function statusToneOperation(status: string): string {
  if (status === "succeeded") return "text-emerald-400 border-emerald-900";
  if (status === "failed") return "text-red-400 border-red-900";
  if (status === "running") return "text-amber-400 border-amber-900";
  return "text-muted-fg border-border";
}
