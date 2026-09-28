import { useSyncExternalStore } from "react";
import type { FloatingPlayerFrame } from "./floatingPlayerLayout";

/**
 * The floating players on screen and where they are, so a new one opens clear
 * of them. Each player registers its frame while it is shown; a player only
 * makes room for players that were placed before it, so two never chase each
 * other around the column.
 */
type Slot = { frame: FloatingPlayerFrame; order: number };

const slots = new Map<string, Slot>();
const listeners = new Set<() => void>();
let nextOrder = 0;
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function setFloatingPlayerSlot(id: string, frame: FloatingPlayerFrame | null): void {
  const current = slots.get(id);
  if (!frame) {
    if (!current) return;
    slots.delete(id);
    notify();
    return;
  }
  if (
    current
    && current.frame.x === frame.x
    && current.frame.y === frame.y
    && current.frame.width === frame.width
    && current.frame.height === frame.height
  ) return;
  slots.set(id, { frame, order: current?.order ?? nextOrder++ });
  notify();
}

/** The frames of the players placed before `id` (all of them for a player not placed yet). */
export function floatingPlayerFramesBefore(id: string): FloatingPlayerFrame[] {
  const mine = slots.get(id)?.order ?? Number.POSITIVE_INFINITY;
  return [...slots.entries()]
    .filter(([key, slot]) => key !== id && slot.order < mine)
    .map(([, slot]) => slot.frame);
}

export function useFloatingPlayerSlotsVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => version,
  );
}
