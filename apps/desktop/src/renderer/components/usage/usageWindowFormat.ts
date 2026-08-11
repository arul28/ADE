/**
 * Formatting and pacing vocabulary for quota windows.
 *
 * One place to phrase "82% used, resets in 3h", so the pace bars inside the
 * top-bar popover and the "updated 2m ago" line above them cannot describe one
 * window in two different dialects. Live quota lives only in that popover now;
 * the Usage page is spend and history.
 */
import type { UsagePacing, UsageWindow } from "../../../shared/types";

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * Milliseconds until a window resets, floored at zero.
 *
 * Internal: the exported formatters are the vocabulary. Note the same name is
 * taken by an unrelated function in `main/services/usage/providerQuotaParsers`,
 * which reads the *host's* clock and takes no `nowMs` — exporting this one
 * invited importing the wrong one.
 */
function computeResetsInMs(resetsAt: string, nowMs: number): number {
  if (!resetsAt) return 0;
  const parsed = new Date(resetsAt).getTime();
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed - nowMs);
}

export function formatResetIn(resetsAt: string, nowMs: number): string {
  const ms = computeResetsInMs(resetsAt, nowMs);
  if (ms <= 0) return "resetting now";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${mins}m`;
  return `resets in ${mins}m`;
}

export function formatUsagePercent(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

/** "45m" / "3.2h" / "2d 4h" — how much headroom is left. Internal. */
function formatHoursShort(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  const days = Math.floor(hours / 24);
  const rem = Math.round(hours % 24);
  return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "today 3pm" / "tomorrow 9am" / "Tue 3pm" — when the quota would run dry. Internal. */
function formatClock(targetMs: number, nowMs: number): string {
  const d = new Date(targetMs);
  const hours = d.getHours();
  const ampm = hours >= 12 ? "pm" : "am";
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  const dayDiff = Math.round((startOfDay(targetMs) - startOfDay(nowMs)) / 86_400_000);
  const prefix = dayDiff <= 0 ? "today" : dayDiff === 1 ? "tomorrow" : WEEKDAYS[d.getDay()];
  return `${prefix} ${h12}${ampm}`;
}

export function windowLabel(window: UsageWindow): string {
  if (window.windowType === "five_hour" && window.windowDurationMs && window.windowDurationMs > 0) {
    const minutes = Math.round(window.windowDurationMs / 60_000);
    if (minutes < 60) return `${minutes}-min`;
    const hours = minutes / 60;
    return Number.isInteger(hours) ? `${hours}-hour` : `${hours.toFixed(1)}-hour`;
  }
  switch (window.windowType) {
    case "five_hour":
      return "5-hour";
    case "weekly":
      return "Weekly";
    case "monthly":
      return "Monthly";
    case "weekly_oauth_apps":
      return "OAuth apps";
    case "weekly_cowork":
      return "Cowork";
    default:
      return window.windowType;
  }
}

/**
 * A window past its reset time reads as 0, not as its last-known fill.
 * The snapshot can outlive the window it describes by a refresh interval.
 */
export function displayPercent(window: UsageWindow, nowMs: number): number {
  const resetsInMs = computeResetsInMs(window.resetsAt, nowMs);
  const value = resetsInMs <= 0 ? 0 : window.percentUsed;
  return Math.max(0, Math.min(100, value));
}

export type PaceVisual = { label: string; arrow: string; tone: "calm" | "warm" | "hot" | "cool" };

/**
 * Maps computed pacing to a calm/warm/hot read. "ahead" means burning faster
 * than a steady pace through the window; "behind" means headroom.
 */
export function paceVisual(pacing?: UsagePacing | null): PaceVisual | null {
  if (!pacing || pacing.weekElapsedPercent <= 0) return null;
  const { status, deltaPercent } = pacing;
  const mag = Math.round(Math.abs(deltaPercent));
  if (status === "on-track" || mag < 1) return { label: "on track", arrow: "", tone: "calm" };
  let tone: PaceVisual["tone"];
  if (status === "far-ahead") tone = "hot";
  else if (status === "ahead" || status === "slightly-ahead") tone = "warm";
  else tone = "cool";
  const ahead = deltaPercent >= 0;
  return { label: `${mag}% ${ahead ? "ahead" : "behind"}`, arrow: ahead ? "▴" : "▾", tone };
}

/** Full sentence for a bar's tooltip: fill, headroom, and reset. */
export function headroomTitle(window: UsageWindow, nowMs: number): string {
  const reset = formatResetIn(window.resetsAt, nowMs);
  const pacing = window.pacing;
  const pct = Math.round(displayPercent(window, nowMs));
  if (!pacing || pacing.etaHours == null) return `${pct}% used · ${reset}`;
  if (pacing.etaHours <= 0) return `Quota exhausted · ${reset}`;
  const left = formatHoursShort(pacing.etaHours);
  return pacing.willLastToReset
    ? `~${left} of headroom at this pace · ${reset}`
    : `~${left} left at this pace — would run dry before reset · ${reset}`;
}

/** "trending to 87% by reset · runs dry ~tomorrow 3pm" */
export function trendSentence(pacing: UsagePacing | null | undefined, nowMs: number): string | null {
  if (!pacing || pacing.weekElapsedPercent <= 0) return null;
  const parts = [`trending to ${Math.round(pacing.projectedWeeklyPercent)}% by reset`];
  if (pacing.etaHours != null && pacing.etaHours > 0 && !pacing.willLastToReset) {
    parts.push(`runs dry ~${formatClock(nowMs + pacing.etaHours * 3_600_000, nowMs)}`);
  } else if (pacing.willLastToReset) {
    parts.push("lasts to reset");
  }
  return parts.join(" · ");
}

/** Relative age of a provider's last successful read. */
export function formatUpdatedAge(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "not updated";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "not updated";
  const ageMs = nowMs - parsed;
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.max(1, Math.floor(ageMs / 60_000))}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.floor(ageMs / 86_400_000)}d ago`;
}
