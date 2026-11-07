import type { OpenProjectBinding } from "../../../shared/types";
import { laneOnMachineKey } from "../../lib/chatMachineRouting";
import { useAppStore } from "../../state/appStore";

/**
 * "Show the device picker for this lane": the tool card menu's "Choose
 * another device", which acts before the Android pane is on screen.
 *
 * The pane's picker is its own state, so the menu asks here and the pane
 * takes the ask when it mounts (or at once, when it is already mounted).
 * Keyed by the lane on its machine, so an ask for one lane never opens the
 * picker of another lane or another machine.
 */

const pending = new Set<string>();
const listeners = new Set<() => void>();

function keyFor(laneId: string, runtimePin: OpenProjectBinding | null): string {
  return laneOnMachineKey(runtimePin, useAppStore.getState().projectBinding, laneId);
}

export function requestAndroidPicker(laneId: string, runtimePin: OpenProjectBinding | null): void {
  pending.add(keyFor(laneId, runtimePin));
  for (const listener of [...listeners]) listener();
}

/** True once per ask: the ask is gone after this reads it. */
export function takeAndroidPickerRequest(laneId: string, runtimePin: OpenProjectBinding | null): boolean {
  return pending.delete(keyFor(laneId, runtimePin));
}

export function subscribeAndroidPickerRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
