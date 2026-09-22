/**
 * Formatting and pacing vocabulary for quota windows.
 *
 * One place to phrase "82% used, resets in 3h", so the pace bars inside the
 * top-bar popover and the "updated 2m ago" line above them cannot describe one
 * window in two different dialects. Live quota lives only in that popover now;
 * the Usage page is spend and history.
 */
import type { UsagePacing, UsageWindow } from "../../../shared/types";
import type { UsageWindowLabelInput } from "../../../shared/usageWindowPresentation";
import {
  computeResetsInMs,
  displayPercent,
  windowLabel,
} from "../../../shared/usageWindowPresentation";

// The window's name and its fill are spoken by the `ade` CLI too, so they live
// in shared and are re-exported here: renderer callers keep importing them from
// the vocabulary module they already use.
export { displayPercent, windowLabel } from "../../../shared/usageWindowPresentation";

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function formatResetIn(resetsAt: string, nowMs: number): string {
  if (!resetsAt || !Number.isFinite(Date.parse(resetsAt))) return "";
  const ms = computeResetsInMs(resetsAt, nowMs);
  if (ms <= 0) return "resetting now";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${mins}m`;
  return `resets in ${mins}m`;
}

/**
 * "6d 7h" / "4h 5m" / "5m" — a bare countdown for a segment chip, where the
 * glyph beside it already says "resets". `formatResetIn` keeps the sentence
 * form for anywhere the words carry the meaning.
 */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * "5h" / "wk" / "mo" — the window's name in a two-across meter row.
 *
 * The popover now puts a provider's windows side by side inside one account
 * row, roughly 190px each. "Weekly" spelled out ate a third of that, so the
 * meter carries the abbreviation and the full `windowLabel` stays on the
 * accessible name and in the details panel, where there is room for it.
 */
export function shortWindowLabel(window: UsageWindowLabelInput): string {
  switch (window.windowType) {
    case "five_hour": {
      const minutes = window.windowDurationMs ? Math.round(window.windowDurationMs / 60_000) : 300;
      if (minutes > 0 && minutes < 60) return `${minutes}m`;
      const hours = minutes > 0 ? minutes / 60 : 5;
      return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
    }
    case "weekly":
      return "wk";
    case "monthly":
      return "mo";
    // Named in full. Stacked bars have the width for it, and "apps" was a
    // three-letter riddle for what is actually the OAuth-apps allowance.
    case "weekly_oauth_apps":
      return "OAuth apps";
    case "weekly_cowork":
      return "Cowork";
    default:
      return windowLabel(window);
  }
}

/** Absolute reset time, e.g. "9/14 1:29 AM", beside the countdown. */
export function formatResetClock(resetsAt: string): string | null {
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return null;
  return new Date(at).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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

export type PaceVisual = { label: string; arrow: string; tone: "calm" | "warm" | "hot" | "cool" };

/**
 * Maps computed pacing to a calm/warm/hot read. "ahead" means burning faster
 * than a steady pace through the window; "behind" means headroom.
 */
export function paceVisual(pacing?: UsagePacing | null): PaceVisual | null {
  if (!pacing || pacing.weekElapsedPercent <= 0) return null;
  const { status, deltaPercent } = pacing;
  const mag = Math.round(Math.abs(deltaPercent));
  if (status === "on-track" || mag < 1) return { label: "on pace", arrow: "", tone: "calm" };
  let tone: PaceVisual["tone"];
  if (status === "far-ahead") tone = "hot";
  else if (status === "ahead" || status === "slightly-ahead") tone = "warm";
  else tone = "cool";
  const ahead = deltaPercent >= 0;
  // "12% ahead of pace" rather than "12% ahead": on its own line beside an
  // email, "12% ahead" reads as ahead of *something else on the row*.
  return { label: `${mag}% ${ahead ? "ahead of" : "behind"} pace`, arrow: ahead ? "▴" : "▾", tone };
}

/** Full sentence for a bar's tooltip: fill, headroom, and reset. */
export function headroomTitle(window: UsageWindow, nowMs: number): string {
  const reset = formatResetIn(window.resetsAt, nowMs);
  const pacing = window.pacing;
  const pct = Math.round(displayPercent(window, nowMs));
  const resetSuffix = reset ? ` · ${reset}` : "";
  if (!pacing || pacing.etaHours == null) return `${pct}% used${resetSuffix}`;
  if (pacing.etaHours <= 0) return `Quota exhausted${resetSuffix}`;
  const left = formatHoursShort(pacing.etaHours);
  return pacing.willLastToReset
    ? `~${left} of headroom at this pace${resetSuffix}`
    : `~${left} left at this pace — would run dry before reset${resetSuffix}`;
}

/**
 * The projection and its outcome, as two short phrases.
 *
 * One joined sentence was too long for the 300px details panel and truncated
 * mid-word; split, each half is its own one-line row and neither is cut.
 */
export function paceOutlook(
  pacing: UsagePacing | null | undefined,
  nowMs: number,
): { projected: string; outcome: string | null } | null {
  if (!pacing || pacing.weekElapsedPercent <= 0) return null;
  const projected = `${Math.round(pacing.projectedWeeklyPercent)}% by reset`;
  if (pacing.etaHours != null && pacing.etaHours > 0 && !pacing.willLastToReset) {
    return { projected, outcome: `runs dry ~${formatClock(nowMs + pacing.etaHours * 3_600_000, nowMs)}` };
  }
  if (pacing.willLastToReset) return { projected, outcome: "lasts to reset" };
  return { projected, outcome: null };
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
