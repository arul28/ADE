import { useCallback, useSyncExternalStore } from "react";

/**
 * The last frame each lane's desktop painted, and nothing else.
 *
 * Three surfaces want to show a lane's screen without owning its stream: the
 * Work pane's own panel (which produces the frames), the floating mini view in
 * the thread, and the Lanes tab's hover peek. Only one of them can hold the
 * decoder — a second WebCodecs reader would cost a second encoder client on the
 * Mac — so the other two read the last picture from here.
 *
 * Deliberately NOT a poller and not React state at the top of the tree. The
 * panel writes at most a few frames a second; a store with per-lane subscriber
 * sets means a write for lane A cannot re-render a row for lane B, and a lane
 * nobody is watching costs one map entry. `useSyncExternalStore` gives the
 * readers a snapshot with a stable identity, so an unchanged frame is a bail-out
 * rather than a render.
 *
 * The frame is a data URL rather than an `ImageBitmap` because the readers put
 * it straight into an `<img>`, and an ImageBitmap handed to three consumers has
 * an ownership question none of them can answer.
 */

export type MacDesktopFrame = {
  laneId: string;
  /** A `data:image/...` URL. Whatever the producer could cheaply encode. */
  dataUrl: string;
  width: number;
  height: number;
  /** `Date.now()` when the frame was decoded. */
  at: number;
  /** The caption of the action that produced it, when one is known. */
  caption: string | null;
};

const frames = new Map<string, MacDesktopFrame>();
const subscribers = new Map<string, Set<() => void>>();

function notify(laneId: string): void {
  const listeners = subscribers.get(laneId);
  if (!listeners) return;
  for (const listener of [...listeners]) listener();
}

export function setMacDesktopFrame(frame: MacDesktopFrame): void {
  frames.set(frame.laneId, frame);
  notify(frame.laneId);
}

/** Replaces only the caption, keeping the picture and its identity. */
export function captionMacDesktopFrame(laneId: string, caption: string | null): void {
  const current = frames.get(laneId);
  if (!current || current.caption === caption) return;
  frames.set(laneId, { ...current, caption });
  notify(laneId);
}

export function getMacDesktopFrame(laneId: string | null | undefined): MacDesktopFrame | null {
  if (!laneId) return null;
  return frames.get(laneId) ?? null;
}

export function clearMacDesktopFrame(laneId: string): void {
  if (!frames.delete(laneId)) return;
  notify(laneId);
}

/** Test-only reset. Module state outlives a test file otherwise. */
export function resetMacDesktopFrames(): void {
  const laneIds = [...frames.keys()];
  frames.clear();
  for (const laneId of laneIds) notify(laneId);
}

export function subscribeMacDesktopFrame(laneId: string, listener: () => void): () => void {
  let listeners = subscribers.get(laneId);
  if (!listeners) {
    listeners = new Set();
    subscribers.set(laneId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) subscribers.delete(laneId);
  };
}

/**
 * The lane's last frame, or null.
 *
 * A null `laneId` subscribes to nothing at all rather than to a sentinel key,
 * so a row with no lane costs no subscription.
 */
export function useMacDesktopFrame(laneId: string | null | undefined): MacDesktopFrame | null {
  const subscribe = useCallback(
    (listener: () => void) => (laneId ? subscribeMacDesktopFrame(laneId, listener) : () => undefined),
    [laneId],
  );
  const snapshot = useCallback(() => getMacDesktopFrame(laneId), [laneId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
