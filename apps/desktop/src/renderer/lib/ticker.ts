import { useEffect, useState } from "react";

/**
 * One timer per period for the whole renderer.
 *
 * A row that shows a live duration used to install its own `setInterval`, so a
 * list of working sessions ran one timer and one unbatched `setState` per row —
 * twenty working rows meant twenty timers firing twenty separate commits every
 * second. They now share a single timer per period, and because every
 * subscriber is notified from inside the one interval callback React commits
 * them all in a single pass.
 *
 * Each subscriber keeps its OWN reading, seeded when it mounts and refreshed on
 * every tick. That is the point: a reading shared through the channel would be
 * stale for any component that joins a channel which is already running, and
 * anything derived from it (a countdown, a "waiting 5m" label) would be wrong
 * until the next tick — a full minute wrong on the thirty-second channel. Only
 * the timer is shared, so every component's first paint is as fresh as the
 * per-row timer it replaced, and the tick still lands once per `periodMs`.
 */
type TickerChannel = {
  timer: number | null;
  listeners: Set<() => void>;
};

const channels = new Map<number, TickerChannel>();

function channelFor(periodMs: number): TickerChannel {
  let channel = channels.get(periodMs);
  if (!channel) {
    channel = { timer: null, listeners: new Set() };
    channels.set(periodMs, channel);
  }
  return channel;
}

/**
 * Calls `listener` from the shared timer for `periodMs`; returns the
 * unsubscribe. For a counter that writes its text straight to the DOM: on the
 * shared timer it changes in the same frame as every other ticking label, not
 * in a frame of its own.
 */
export function subscribeToTicker(periodMs: number, listener: () => void): () => void {
  const channel = channelFor(periodMs);
  channel.listeners.add(listener);
  // A timer exists exactly while the channel has listeners, so a period nobody
  // is reading costs nothing.
  if (channel.timer == null) {
    channel.timer = window.setInterval(() => {
      // Copy: a listener may unsubscribe itself while we are notifying. There is
      // deliberately no per-listener isolation — every listener is a bare
      // setState, which cannot throw. Keep it that way: one throw here would
      // abort the loop and freeze every later subscriber's clock, silently.
      for (const notify of [...channel.listeners]) notify();
    }, periodMs);
  }
  return () => {
    channel.listeners.delete(listener);
    if (channel.listeners.size === 0 && channel.timer != null) {
      window.clearInterval(channel.timer);
      channel.timer = null;
    }
  };
}

/**
 * A reading that advances once per `periodMs` while `enabled`, driven by the
 * renderer's single shared timer for that period. In the same units as
 * `Date.now()`, so callers keep subtracting their own start time.
 *
 * While `enabled` is false the reading stops advancing. Gate the render on the
 * same flag rather than showing a value derived from a stopped reading.
 */
export function useTicker(periodMs: number, enabled = true): number {
  const [reading, setReading] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    // Re-enabling: the reading froze while disabled, so refresh it before
    // subscribing rather than waiting for the first tick.
    setReading(Date.now());
    return subscribeToTicker(periodMs, () => setReading(Date.now()));
  }, [enabled, periodMs]);
  return reading;
}
