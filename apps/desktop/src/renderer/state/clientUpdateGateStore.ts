import { useSyncExternalStore } from "react";
import {
  EMPTY_CLIENT_UPDATE_GATE_STATE,
  type ClientUpdateGateState,
} from "../../shared/clientUpdateGate";
import { setSentryUpdateGateResolver } from "../../shared/sentry/eventFilter";

/**
 * The window's copy of `clientUpdateGate` state: one read and one change
 * listener for the whole window, however many surfaces ask (the update
 * screen, every other machine's work surface). Main reads the account
 * server; nothing here polls.
 */

let state: ClientUpdateGateState = EMPTY_CLIENT_UPDATE_GATE_STATE;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

// The window's own Sentry hooks: its traces never reach main's, and dropping
// its errors here saves the trip. `self` is only ever required for this
// build's own version (ADE Web's is never required).
setSentryUpdateGateResolver(() => ({
  requirement: state.self,
  version: state.self.required ? state.self.currentVersion : null,
}));

function apply(next: ClientUpdateGateState | null | undefined): void {
  if (!next || next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

function start(): () => void {
  const bridge = typeof window === "undefined" ? undefined : window.ade?.clientUpdateGate;
  if (typeof bridge?.getState !== "function") return () => undefined;
  let stopped = false;
  void bridge.getState().then((next) => {
    if (!stopped) apply(next);
  }, () => undefined);
  const unsubscribe = typeof bridge.onChange === "function" ? bridge.onChange((next) => apply(next)) : undefined;
  return () => {
    stopped = true;
    unsubscribe?.();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) stop = start();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stop?.();
    stop = null;
  };
}

const read = () => state;

export function useClientUpdateGate(): ClientUpdateGateState {
  return useSyncExternalStore(subscribe, read, read);
}

/** Reads `/client/minimum` again (the screen's Retry). Never rejects. */
export async function refreshClientUpdateGate(): Promise<void> {
  const refresh = window.ade?.clientUpdateGate?.refresh;
  if (typeof refresh !== "function") return;
  apply(await refresh().catch(() => null));
}
