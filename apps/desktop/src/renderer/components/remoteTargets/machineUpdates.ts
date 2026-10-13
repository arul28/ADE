import { useEffect, useState, useSyncExternalStore } from "react";
import { extractError } from "../../lib/format";
import { confirmMachineUpdates, type OutdatedMachine } from "../app/updateRunningWork";
import {
  machineUpdateAttemptFromResult,
  machineUpdateGraceMs,
  type MachineUpdateAttempt,
} from "./remoteMachineModel";

/**
 * "Update & restart" for other machines, as one store.
 *
 * A machine's update is one fact, and three places show it: the Machines list,
 * General settings and the Account page. Held per component, an update started
 * in one read as idle in the others and was forgotten when its page closed.
 */
export type MachineUpdatesState = {
  /** Machines whose `machine.updateAndRestart` call is in flight. */
  updatingIds: ReadonlySet<string>;
  /** Machines being asked what an update would stop, before the confirmation. */
  checkingIds: ReadonlySet<string>;
  /** What the last update run left behind, by machine id. */
  attempts: Readonly<Record<string, MachineUpdateAttempt>>;
};

let state: MachineUpdatesState = {
  updatingIds: new Set(),
  checkingIds: new Set(),
  attempts: {},
};
const listeners = new Set<() => void>();

function setState(patch: Partial<MachineUpdatesState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function withIds(current: ReadonlySet<string>, ids: readonly string[], present: boolean): ReadonlySet<string> {
  const next = new Set(current);
  for (const id of ids) {
    if (present) next.add(id);
    else next.delete(id);
  }
  return next;
}

/** False in the browser client, which cannot ask a machine to update. */
export function canUpdateOtherMachines(): boolean {
  const remoteRuntime = window.ade.remoteRuntime as { updateAndRestart?: unknown } | undefined;
  return typeof remoteRuntime?.updateAndRestart === "function";
}

async function runMachineUpdate(machine: OutdatedMachine, targetVersion: string | null): Promise<void> {
  const { [machine.id]: _previous, ...otherAttempts } = state.attempts;
  setState({
    updatingIds: withIds(state.updatingIds, [machine.id], true),
    attempts: otherAttempts,
  });
  let attempt: MachineUpdateAttempt;
  try {
    const result = await window.ade.remoteRuntime.updateAndRestart(machine.id, targetVersion);
    attempt = machineUpdateAttemptFromResult(result, `${machine.name} updated — reconnecting…`, Date.now());
  } catch (error) {
    attempt = {
      ok: false,
      message: extractError(error),
      pendingVersion: null,
      downloading: false,
      startedAtMs: Date.now(),
    };
  }
  setState({
    updatingIds: withIds(state.updatingIds, [machine.id], false),
    attempts: { ...state.attempts, [machine.id]: attempt },
  });
}

/**
 * Every "Update & restart" goes through here: it names what is running on
 * each machine and waits for a yes before anything restarts.
 */
export async function requestMachineUpdates(
  machines: readonly OutdatedMachine[],
  targetVersion: string | null,
): Promise<void> {
  // A machine already being asked or updated is not asked a second time.
  const idle = machines.filter((machine) =>
    !state.updatingIds.has(machine.id) && !state.checkingIds.has(machine.id));
  if (idle.length === 0 || !canUpdateOtherMachines()) return;
  const ids = idle.map((machine) => machine.id);
  setState({ checkingIds: withIds(state.checkingIds, ids, true) });
  let confirmed = false;
  try {
    confirmed = await confirmMachineUpdates(idle, targetVersion);
  } finally {
    setState({ checkingIds: withIds(state.checkingIds, ids, false) });
  }
  if (!confirmed) return;
  await Promise.all(idle.map((machine) => runMachineUpdate(machine, targetVersion)));
}

/**
 * The store, plus a clock that moves when an in-flight update's grace runs
 * out, so a machine that never came back on the new version gets told so
 * instead of "reconnecting…".
 */
export function useMachineUpdates(): MachineUpdatesState & { nowMs: number } {
  const current = useSyncExternalStore(subscribe, () => state, () => state);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    let nextDeadlineMs: number | null = null;
    for (const attempt of Object.values(current.attempts)) {
      if (!attempt.pendingVersion) continue;
      const deadlineMs = attempt.startedAtMs + machineUpdateGraceMs(attempt);
      if (deadlineMs <= nowMs) continue;
      nextDeadlineMs = nextDeadlineMs == null ? deadlineMs : Math.min(nextDeadlineMs, deadlineMs);
    }
    if (nextDeadlineMs == null) return;
    const timer = window.setTimeout(
      () => setNowMs(Date.now()),
      Math.max(0, nextDeadlineMs - Date.now()) + 250,
    );
    return () => window.clearTimeout(timer);
  }, [current.attempts, nowMs]);
  // Read at render: the state above only moves at a deadline, and an attempt
  // that started since must not be judged against an older time.
  return { ...current, nowMs: Date.now() };
}
