import { useSyncExternalStore } from "react";

import type { OpenProjectBinding } from "../../../shared/types";
import type { MacDesktopStatus, MacDesktopStopResult } from "../../../shared/types/macDesktop";

/**
 * The one place the pane and the tool card read a lane's desktop from.
 *
 * The card and the pane used to read `getStatus` on their own and keep what
 * they last knew when a read failed. So the card said "Mac Desktop active ·
 * 1 window" about a display that was already gone, while the pane sat on
 * "Checking Mac Desktop…". Both now write every read, and every failed read,
 * here, and both draw from the newest entry. A read that failed is recorded as
 * `confirmed: false`: nothing may claim a live screen the host did not just
 * confirm.
 *
 * Stops are recorded here too. Closing the tab sends a stop and does not wait
 * for it, so a pane reopened a moment later used to read a display that was
 * about to go, then flip to Off when the event came. The pane now waits for a
 * stop in flight and says "Stopping Mac Desktop…" instead.
 */

export type MacDesktopStatusEntry = {
  /** The last status the host answered with, or null before any answer. */
  status: MacDesktopStatus | null;
  /** False when the newest read failed or timed out. */
  confirmed: boolean;
};

/** Past this a `getStatus` that has not answered counts as failed. */
export const MAC_DESKTOP_READ_TIMEOUT_MS = 10_000;
/** A stop that takes longer than this no longer holds the pane back. */
export const MAC_DESKTOP_STOP_WAIT_MS = 10_000;
export const MAC_DESKTOP_NOT_ANSWERING = "Mac Desktop is not answering.";

const entries = new Map<string, MacDesktopStatusEntry>();
const listeners = new Map<string, Set<() => void>>();
const pendingStops = new Map<string, Promise<unknown>>();

/** One key per lane per machine: the same lane id on two machines is two screens. */
export function macDesktopStatusKey(laneId: string, pin: OpenProjectBinding | null | undefined): string {
  return `${pin?.key ?? "local"}::${laneId}`;
}

function emit(key: string): void {
  for (const listener of [...(listeners.get(key) ?? [])]) listener();
}

export function publishMacDesktopStatus(key: string, entry: MacDesktopStatusEntry): void {
  const current = entries.get(key);
  if (current && current.status === entry.status && current.confirmed === entry.confirmed) return;
  entries.set(key, entry);
  emit(key);
}

/** Marks the newest entry as unconfirmed, keeping what it last said. */
export function publishMacDesktopUnconfirmed(key: string): void {
  const current = entries.get(key);
  publishMacDesktopStatus(key, { status: current?.status ?? null, confirmed: false });
}

export function readMacDesktopStatusEntry(key: string | null): MacDesktopStatusEntry | null {
  return key ? entries.get(key) ?? null : null;
}

function subscribe(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}

const NO_SUBSCRIPTION = () => () => {};

/** The newest entry for one lane, or null before anything read it. */
export function useMacDesktopStatusEntry(key: string | null): MacDesktopStatusEntry | null {
  return useSyncExternalStore(
    key ? (listener) => subscribe(key, listener) : NO_SUBSCRIPTION,
    () => readMacDesktopStatusEntry(key),
    () => readMacDesktopStatusEntry(key),
  );
}

/**
 * Rejects with `message` when `promise` has not settled in `ms`.
 *
 * The call itself is not cancelled; its late answer is simply not waited for.
 */
export function withMacDesktopTimeout<T>(
  promise: Promise<T>,
  ms: number = MAC_DESKTOP_READ_TIMEOUT_MS,
  message: string = MAC_DESKTOP_NOT_ANSWERING,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Calls `onChange` when the runtime behind the pane may have changed.
 *
 * A brain that restarted, or a runtime that reconnected, starts with no
 * displays and so never sends `display-destroyed` for the ones that died with
 * the old brain. Without a re-read on these signals the pane and the card kept
 * showing a display that no longer existed. The same three signals the Work
 * pane's tool publish already follows: the local runtime's status, the
 * project's binding, and the paired machines' connection snapshot.
 */
export function subscribeMacDesktopRuntimeChanges(onChange: () => void): () => void {
  const ade = typeof window === "undefined" ? undefined : window.ade;
  const disposers = [
    ade?.app?.onRuntimeStatusChanged?.(() => onChange()),
    ade?.app?.onProjectBindingChanged?.(() => onChange()),
    ade?.remoteRuntime?.onConnectionSnapshotChanged?.(() => onChange()),
  ];
  return () => {
    for (const dispose of disposers) {
      if (typeof dispose === "function") dispose();
    }
  };
}

/** A stop for this lane that has not answered yet, or null. */
export function macDesktopPendingStop(key: string): Promise<unknown> | null {
  return pendingStops.get(key) ?? null;
}

/**
 * Stops one lane's display and records the stop while it runs.
 *
 * Every stop in the renderer goes through here: the pane's Stop, its Reset,
 * and closing the tab. On success the lane is recorded as Off, so the card
 * stops saying "active" at once instead of waiting for an event.
 */
export function stopMacDesktopLane(args: {
  laneId: string;
  chatSessionId?: string | null;
  runtimePin: OpenProjectBinding | null;
}): Promise<MacDesktopStopResult> {
  const api = window.ade?.macDesktop;
  if (!api?.stop) return Promise.reject(new Error("Mac Desktop is not available on this surface."));
  const key = macDesktopStatusKey(args.laneId, args.runtimePin);
  const stop = api.stop(
    { laneId: args.laneId, chatSessionId: args.chatSessionId ?? null },
    args.runtimePin ?? undefined,
  );
  pendingStops.set(key, stop);
  const settled = stop.then(
    (result) => {
      const current = entries.get(key)?.status ?? null;
      if (current) {
        publishMacDesktopStatus(key, {
          status: { ...current, display: null, windows: [], recording: null },
          confirmed: true,
        });
      }
      return result;
    },
  ).finally(() => {
    if (pendingStops.get(key) === stop) pendingStops.delete(key);
  });
  return settled;
}

/** Test seam: one test's entries must not answer the next one's reads. */
export function resetMacDesktopStatusStoreForTests(): void {
  entries.clear();
  listeners.clear();
  pendingStops.clear();
}
