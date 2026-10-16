import { useCallback, useSyncExternalStore } from "react";

/**
 * One timer per period for the whole renderer.
 *
 * A row that shows a live duration used to install its own `setInterval`, so a
 * list of working sessions ran one timer and one unbatched `setState` per row —
 * twenty working rows meant twenty timers firing twenty separate commits every
 * second. They now share a single timer per period and React commits every
 * subscriber in one pass.
 *
 * The tick still lands once per `periodMs`, so every value a component derives
 * from it is the same value its own timer produced. This changes how many
 * timers run, not when the numbers move.
 */
type TickerChannel = {
  timer: number | null;
  /** The reading the current period published; stable between ticks. */
  nowMs: number;
  listeners: Set<() => void>;
};

const channels = new Map<number, TickerChannel>();

function channelFor(periodMs: number): TickerChannel {
  let channel = channels.get(periodMs);
  if (!channel) {
    channel = { timer: null, nowMs: Date.now(), listeners: new Set() };
    channels.set(periodMs, channel);
  }
  return channel;
}

function subscribeToChannel(periodMs: number, listener: () => void): () => void {
  const channel = channelFor(periodMs);
  channel.listeners.add(listener);
  // A timer exists exactly while the channel has listeners, so an idle channel
  // holds a reading that may be arbitrarily old. Take a fresh one on the way in
  // rather than showing a stale duration until the first tick.
  if (channel.timer == null) {
    channel.nowMs = Date.now();
    channel.timer = window.setInterval(() => {
      channel.nowMs = Date.now();
      // Copy: a listener may unsubscribe itself while we are notifying. Each
      // listener is isolated — with a timer per component a throwing listener
      // could only break its own tick, and sharing one timer must not turn one
      // bad subscriber into a frozen clock for every other component.
      for (const notify of [...channel.listeners]) {
        try {
          notify();
        } catch (error) {
          console.error("[ticker] listener threw", error);
        }
      }
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
 * The shared reading for `periodMs`, refreshed once per period while at least
 * one component is subscribed. Returns a timestamp in the same units as
 * `Date.now()`, so callers keep subtracting their own start time.
 */
export function useTicker(periodMs: number, enabled = true): number {
  const read = useCallback(() => channelFor(periodMs).nowMs, [periodMs]);
  const watch = useCallback(
    (listener: () => void) =>
      enabled ? subscribeToChannel(periodMs, listener) : () => {},
    [enabled, periodMs],
  );
  return useSyncExternalStore(watch, read, read);
}
