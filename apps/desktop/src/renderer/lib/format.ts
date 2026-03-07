/** Shared formatting utilities for the renderer. */

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

/** Format a token count with K/M suffixes. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
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

/** Map an operation status to Tailwind text+border classes (history style). */
export function statusToneOperation(status: string): string {
  if (status === "succeeded") return "text-emerald-400 border-emerald-900";
  if (status === "failed") return "text-red-400 border-red-900";
  if (status === "running") return "text-amber-400 border-amber-900";
  return "text-muted-fg border-border";
}
