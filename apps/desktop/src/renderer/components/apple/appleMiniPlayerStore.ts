import { useSyncExternalStore } from "react";
import type { OpenProjectBinding } from "../../../shared/types";

/**
 * Which device is floating over the chat, if any.
 *
 * A module store rather than React state because the two ends are in different
 * subtrees with no ancestor short of the page: the rail's "Float over chat"
 * lives inside the Apple pane, and the player floats over the chat column.
 * Exactly one player at a time — a second Float replaces the first, which is
 * what "float THIS device" means.
 */

export type AppleMiniPlayerTarget = {
  laneId: string | null;
  chatSessionId: string | null;
  deviceUdid: string;
  deviceName: string;
  deviceRuntime: string | null;
  family: "iphone" | "ipad";
  runtimePin: OpenProjectBinding | null;
};

let current: AppleMiniPlayerTarget | null = null;
let listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function openAppleMiniPlayer(target: AppleMiniPlayerTarget): void {
  current = target;
  emit();
}

export function closeAppleMiniPlayer(udid?: string): void {
  if (udid && current?.deviceUdid !== udid) return;
  current = null;
  emit();
}

export function getAppleMiniPlayerTarget(): AppleMiniPlayerTarget | null {
  return current;
}

export function useAppleMiniPlayerTarget(): AppleMiniPlayerTarget | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getAppleMiniPlayerTarget,
    getAppleMiniPlayerTarget,
  );
}

/** Test seam: a float from one test must not reach the next. */
export function resetAppleMiniPlayerForTests(): void {
  current = null;
  listeners = new Set();
}
