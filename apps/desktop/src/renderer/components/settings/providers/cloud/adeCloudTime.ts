/**
 * The time words of the ADE Cloud pages: one copy for the tiles, the provider
 * pages, Claude's passes and the end warning. Computed at render; nothing ticks.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** "just now", "5 min ago", "2 h ago", "3 days ago". */
export function agoText(ms: number, now: number): string {
  const delta = Math.max(0, now - ms);
  if (delta < MINUTE_MS) return "just now";
  if (delta < HOUR_MS) return `${Math.floor(delta / MINUTE_MS)} min ago`;
  if (delta < DAY_MS) return `${Math.floor(delta / HOUR_MS)} h ago`;
  const days = Math.floor(delta / DAY_MS);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** "Nov 12", or "Nov 12, 2027" outside this year. */
export function shortDate(ms: number, now: number): string {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** "today", "yesterday", else `shortDate`. */
export function dayText(ms: number, now: number): string {
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ms >= startOfToday) return "today";
  if (ms >= startOfToday - DAY_MS) return "yesterday";
  return shortDate(ms, now);
}

/** "3 days", "1 day", "0 days": the count after "Ends in". */
export function endsInDaysText(days: number): string {
  const count = Math.max(0, Math.round(days));
  return `${count} day${count === 1 ? "" : "s"}`;
}

/** An ISO time as ms, or null when it is missing or not a time. */
export function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
