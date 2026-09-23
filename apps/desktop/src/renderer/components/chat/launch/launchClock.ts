import { useCallback, useSyncExternalStore } from "react";
import { chatLaunchStageDurationMs, formatChatLaunchDuration } from "../../../../shared/chatLaunch";

/**
 * One clock for every live launch duration on screen (setup card rows, the
 * card header, slide-out rows).
 *
 * A single interval runs only while at least one live duration is mounted, and
 * pauses its notifications while the window is hidden. Subscribers read a
 * formatted STRING through `useSyncExternalStore`, so React re-renders a
 * duration node only when its text actually changes: "1.2s" → "1.5s" moves
 * every tick, but "14s" moves once a second no matter how fast the clock runs.
 * Nothing else in a card or list re-renders for time passing.
 */

export const LAUNCH_CLOCK_TICK_MS = 250;

const listeners = new Set<() => void>();
let clockNowMs = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  clockNowMs = Date.now();
  for (const listener of listeners) listener();
}

function subscribeClock(listener: () => void): () => void {
  listeners.add(listener);
  if (timer == null) {
    clockNowMs = Date.now();
    timer = setInterval(tick, LAUNCH_CLOCK_TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer != null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/**
 * The clock's time. Before the interval has started (first render of the first
 * live duration) it catches up to the wall clock, quantised to a tick so two
 * reads in one render agree, as `useSyncExternalStore` requires.
 */
function readClockNow(): number {
  if (timer == null) clockNowMs = Math.max(clockNowMs, Math.floor(Date.now() / LAUNCH_CLOCK_TICK_MS) * LAUNCH_CLOCK_TICK_MS);
  return clockNowMs;
}

const noopSubscribe = () => () => {};

/** Test seam: how many live durations are subscribed right now. */
export function launchClockSubscriberCountForTests(): number {
  return listeners.size;
}

/**
 * Formatted duration from `startedAt` to `endedAt` (or now, while `live`).
 * Empty string when there is no start yet.
 */
export function useLaunchDurationText(startedAt: string | null, endedAt: string | null, live: boolean): string {
  const read = useCallback(
    () => (live ? formatChatLaunchDuration(chatLaunchStageDurationMs({ startedAt, endedAt }, readClockNow())) : ""),
    [endedAt, live, startedAt],
  );
  const liveText = useSyncExternalStore(live ? subscribeClock : noopSubscribe, read, read);
  return live ? liveText : formatChatLaunchDuration(chatLaunchStageDurationMs({ startedAt, endedAt }));
}
