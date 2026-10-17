import { useTicker } from "./ticker";

/**
 * Live elapsed milliseconds since an ISO start timestamp, ticking once a second
 * while `running`. Null for an absent or unparseable timestamp, so callers
 * render no duration rather than `NaN`.
 *
 * Anchored to the real start timestamp rather than to mount time, so a row
 * scrolled out of the virtualizer and back keeps the true elapsed instead of
 * restarting from zero. The tick comes from the renderer's shared one-second
 * timer (see `./ticker`), so a transcript holding many live rows runs one timer
 * rather than one per row; the commit still lands once a second and reaches
 * only the rows reading it.
 *
 * A leaf that must not commit at all per second should not use this: mutate its
 * own DOM through a ref instead, the way `WorkingIndicator` does for the message
 * list.
 */
export function useLiveDurationMs(startedAt: string | null, running: boolean): number | null {
  const startMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const anchored = Number.isFinite(startMs) ? startMs : null;
  const nowMs = useTicker(1_000, running && anchored != null);
  if (anchored == null) return null;
  return Math.max(0, nowMs - anchored);
}
