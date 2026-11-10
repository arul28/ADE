import { useSyncExternalStore } from "react";
import { cloudMachineSettling, type CloudMachinesResult } from "../../../shared/adeCloud";
import { extractError } from "../../lib/format";
import { noteCloudLaneMachines } from "../../state/adeCloudLaneIndex";

/** While a box is waking, sleeping or resizing, how often its state is read again. */
const SETTLING_POLL_MS = 4_000;
/** A box that never settles stops the quick re-reads after this; focus reads again. */
const SETTLING_POLL_LIMIT_MS = 5 * 60_000;
/** A surface that opens this soon after a read shares it instead of asking again. */
const JOIN_LAST_READ_MS = 2_000;

export type CloudMachinesState = {
  /** The last answer; it stays while a refresh runs, so the cards never flicker. */
  result: CloudMachinesResult | null;
  loading: boolean;
  /** ADE could not ask at all (the call threw). */
  loadError: string | null;
  refresh: () => void;
};

type Snapshot = Omit<CloudMachinesState, "refresh">;

const EMPTY: Snapshot = { result: null, loading: false, loadError: null };

let snapshot = EMPTY;
const listeners = new Set<() => void>();
/**
 * Surfaces that want the quick re-reads while a box settles (the machine
 * cards). A surface that only needs the list in memory (the composer's Run
 * on menu) subscribes without them, so it never starts that timer itself.
 */
let settlingSubscribers = 0;
let generation = 0;
let lastReadAt = 0;
let settlingSince: number | null = null;
let settlingTimer: number | null = null;
let stopWatching: (() => void) | null = null;

function publish(next: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function clearSettlingTimer(): void {
  if (settlingTimer != null) window.clearTimeout(settlingTimer);
  settlingTimer = null;
}

function scheduleSettlingRead(result: CloudMachinesResult | null): void {
  clearSettlingTimer();
  if (settlingSubscribers === 0 || !result?.machines.some((machine) => cloudMachineSettling(machine.state))) {
    settlingSince = null;
    return;
  }
  settlingSince ??= Date.now();
  if (Date.now() - settlingSince > SETTLING_POLL_LIMIT_MS) return;
  settlingTimer = window.setTimeout(load, SETTLING_POLL_MS);
}

function load(): void {
  const listMachines = window.ade?.cloud?.listMachines;
  if (!listMachines || listeners.size === 0) return;
  const current = ++generation;
  lastReadAt = Date.now();
  publish({ loading: true });
  void listMachines().then(
    (result) => {
      if (current !== generation) return;
      // The lane computers outlive this read, for the composer and chat chips.
      if (result?.state === "ok") noteCloudLaneMachines(result.machines);
      publish({ result, loadError: null });
      scheduleSettlingRead(result);
    },
    (error: unknown) => {
      if (current === generation) publish({ loadError: extractError(error) });
    },
  ).finally(() => {
    if (current === generation) publish({ loading: false });
  });
}

function startWatching(): void {
  const off = window.ade?.cloud?.onStatusChanged?.(load);
  window.addEventListener("focus", load);
  stopWatching = () => {
    off?.();
    window.removeEventListener("focus", load);
    stopWatching = null;
  };
}

function subscribeWith(listener: () => void, settle: boolean): () => void {
  const first = listeners.size === 0;
  listeners.add(listener);
  if (settle) settlingSubscribers += 1;
  if (first) startWatching();
  if (first || Date.now() - lastReadAt > JOIN_LAST_READ_MS) load();
  return () => {
    listeners.delete(listener);
    if (settle) {
      settlingSubscribers -= 1;
      if (settlingSubscribers === 0) {
        clearSettlingTimer();
        settlingSince = null;
      }
    }
    if (listeners.size > 0) return;
    stopWatching?.();
    clearSettlingTimer();
    settlingSince = null;
    generation += 1;
    snapshot = EMPTY;
  };
}

const subscribe = (listener: () => void) => subscribeWith(listener, true);
const subscribeQuiet = (listener: () => void) => subscribeWith(listener, false);
const subscribeNothing = () => () => undefined;
const readSnapshot = () => snapshot;
const readEmpty = () => EMPTY;

/**
 * The account's ADE Cloud boxes for the machine list. Account-level: it asks
 * this desktop's main process with no pin (cloud access is the account's).
 *
 * One shared read however many surfaces show it. Read when the first surface
 * opens, on window focus and when the integration changes, never on a standing
 * poll; only while a box is moving between states does it read again every few
 * seconds, until the box settles.
 */
export function useCloudMachines(enabled: boolean, options?: { settle?: boolean }): CloudMachinesState {
  const settle = options?.settle ?? true;
  const state = useSyncExternalStore(
    enabled ? (settle ? subscribe : subscribeQuiet) : subscribeNothing,
    enabled ? readSnapshot : readEmpty,
    readEmpty,
  );
  return { ...state, refresh: load };
}
