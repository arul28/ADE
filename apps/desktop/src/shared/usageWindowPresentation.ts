/**
 * How a quota window names itself and how full it reads — the pieces of the
 * usage vocabulary that more than one client speaks.
 *
 * The renderer's `components/usage/usageWindowFormat` re-exports these so its
 * own callers are unchanged; the `ade` CLI imports them directly. Before this
 * module the CLI kept a hand-copied table, which is how a "5-hour" card could
 * read as `five_hour` in the terminal and "5-hour" in the app.
 *
 * Presentation only: no clock of its own (every function takes `nowMs`), no
 * Electron, no DOM.
 */
import type { UsageWindowType } from "./types/usage";

/** The window fields that decide its name. Satisfied by `UsageWindow`. */
export type UsageWindowLabelInput = {
  /**
   * `(string & {})` rather than a bare `string`: a plain union with `string`
   * collapses to `string`, which would cost renderer callers their exhaustive
   * checking of `UsageWindowType` while still letting the CLI hand over a raw
   * window type it read off the wire.
   */
  windowType: UsageWindowType | (string & {});
  windowDurationMs?: number | null;
};

/** The window fields that decide its fill. Satisfied by `UsageWindow`. */
export type UsageWindowFillInput = {
  resetsAt: string;
  percentUsed: number;
};

/**
 * Milliseconds until a window resets, floored at zero.
 *
 * Note the same name is taken by an unrelated function in
 * `main/services/usage/providerQuotaParsers`, which reads the *host's* clock
 * and takes no `nowMs` — import this one only where a caller-supplied `nowMs`
 * is the point (a render pass, a CLI print).
 */
export function computeResetsInMs(resetsAt: string, nowMs: number): number {
  if (!resetsAt) return 0;
  const parsed = new Date(resetsAt).getTime();
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed - nowMs);
}

/** "5-hour" / "Weekly" / "90-min" — the window, named once for every client. */
export function windowLabel(window: UsageWindowLabelInput): string {
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
 *
 * A non-finite `percentUsed` reads as 0 as well: clamping alone would pass NaN
 * straight through `Math.min`/`Math.max`, and a NaN reaching a bar width or a
 * CLI `toFixed` is a blank or `NaN%` gauge rather than a safe empty one.
 */
export function displayPercent(window: UsageWindowFillInput, nowMs: number): number {
  const resetsInMs = computeResetsInMs(window.resetsAt, nowMs);
  const value = resetsInMs <= 0 || !Number.isFinite(window.percentUsed) ? 0 : window.percentUsed;
  return Math.max(0, Math.min(100, value));
}
