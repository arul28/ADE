import { useEffect, useState, useSyncExternalStore } from "react";
import { extractError } from "../../lib/format";
import { captureError } from "../../../shared/sentry/capture";
import { UNKNOWN_UPDATE_IMPACT } from "../../../shared/updateImpact";
import { confirmMachineUpdates, type MachineWithImpact } from "./MachineUpdateImpact";
import {
  connectedMachinesFromSnapshot,
  describeMachineUpdateAttempt,
  machineUpdateAttemptFromResult,
  machineUpdateGraceMs,
  isMachineVersionCurrent,
  machinesBehindOnTheirTrack,
  type ConnectedMachine,
  type MachineUpdateAttempt,
  type MachineUpdateTarget,
} from "./remoteMachineModel";
import { isAdeAvailable } from "../../lib/adeAvailability";

/**
 * "Update & restart" for other machines, as one store.
 *
 * A machine's update is one fact, and four places start or show it: the
 * Machines list, General settings, the Account page and this computer's
 * install dialog. Held per component, an update started in one read as idle
 * in the others and was forgotten when its page closed.
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

/**
 * False in the browser client, whose `remoteRuntime` is a partial namespace
 * that cannot ask a machine to update.
 */
export function canUpdateOtherMachines(): boolean {
  const remoteRuntime = window.ade?.remoteRuntime as { updateAndRestart?: unknown } | undefined;
  return isAdeAvailable(remoteRuntime?.updateAndRestart);
}

/**
 * Asked, confirming, updating, or not back yet on the version it was sent to:
 * a second request for it must wait. A host coalesces only a call still in
 * flight, so a restart that is still landing is guarded here.
 */
export function isMachineUpdateBusy(
  current: MachineUpdatesState,
  machine: ConnectedMachine,
  nowMs = Date.now(),
): boolean {
  if (current.updatingIds.has(machine.id) || current.checkingIds.has(machine.id)) return true;
  const attempt = current.attempts[machine.id];
  return attempt != null
    && describeMachineUpdateAttempt(attempt, { connected: true, version: machine.version }, nowMs).inFlight;
}

/**
 * Connected machines behind the newest build this computer knows on their
 * own track (`knownAdeVersions`), each with the version it would be sent.
 * Never rejects.
 */
export async function listOutdatedConnectedMachines(known: readonly string[]): Promise<MachineUpdateTarget[]> {
  if (known.length === 0 || !canUpdateOtherMachines()) return [];
  try {
    const snapshot = await window.ade.remoteRuntime.getConnectionSnapshot();
    return machinesBehindOnTheirTrack(connectedMachinesFromSnapshot(snapshot), known);
  } catch {
    return [];
  }
}

/** What an update would stop on each machine. A machine that cannot answer is "unknown". */
export async function readMachinesUpdateImpact<T extends ConnectedMachine>(
  machines: readonly T[],
): Promise<Array<T & { impact: MachineWithImpact["impact"] }>> {
  return await Promise.all(machines.map(async (machine) => ({
    ...machine,
    impact: await window.ade.remoteRuntime.getUpdateImpact(machine.id).catch(() => UNKNOWN_UPDATE_IMPACT),
  })));
}

/**
 * The version each machine reports right now, read just before an update is
 * sent. The confirmation asked every machine a question first, which reconnects
 * one that restarted, so this is fresher than the list the person clicked on.
 */
async function readLiveVersions(): Promise<Map<string, string | null>> {
  try {
    const snapshot = await window.ade.remoteRuntime.getConnectionSnapshot();
    return new Map(connectedMachinesFromSnapshot(snapshot).map((machine) => [machine.id, machine.version]));
  } catch (error) {
    // Sending without the re-read is safe: the host refuses a version it
    // already has. Reported because the snapshot read should not fail.
    captureError(error, { fingerprint: ["machine-updates", "live-version-read"] });
    return new Map();
  }
}

function alreadyCurrentAttempt(version: string): MachineUpdateAttempt {
  return {
    ok: true,
    message: `Already on ${version} — nothing to update, nothing restarted.`,
    pendingVersion: null,
    downloading: false,
    startedAtMs: Date.now(),
  };
}

async function runMachineUpdate(machine: ConnectedMachine, targetVersion: string | null): Promise<MachineUpdateAttempt> {
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
  return attempt;
}

/**
 * Runs an update the person already agreed to, on each machine not already
 * updating, and resolves with each one's outcome once every host has replied.
 * Each machine is sent its own `targetVersion`, a build on its own track; null
 * lets that machine take the newest build on its track.
 */
export async function runMachineUpdates<T extends MachineUpdateTarget>(
  machines: readonly T[],
): Promise<Array<{ machine: T; attempt: MachineUpdateAttempt }>> {
  // The person already said yes to these machines, so only one whose update
  // call is still running is left out (the host would coalesce it anyway).
  const idle = machines.filter((machine) => !state.updatingIds.has(machine.id));
  // A machine that already runs its target (the list read a stale version)
  // is not sent anything: an update it does not need would still restart it
  // on older hosts, stopping whatever runs there. The host refuses too; this
  // is the first of the two guards.
  const live = idle.some((machine) => machine.targetVersion)
    ? await readLiveVersions()
    : new Map<string, string | null>();
  return await Promise.all(idle.map(async (machine) => {
    const { targetVersion } = machine;
    const liveVersion = live.get(machine.id) ?? null;
    if (targetVersion && isMachineVersionCurrent(liveVersion, targetVersion)) {
      const attempt = alreadyCurrentAttempt(liveVersion ?? targetVersion);
      setState({ attempts: { ...state.attempts, [machine.id]: attempt } });
      return { machine, attempt };
    }
    return { machine, attempt: await runMachineUpdate(machine, targetVersion) };
  }));
}

/**
 * "Update & restart" from a machine row or "Update all": names what is
 * running on each machine and waits for a yes before anything restarts.
 */
export async function requestMachineUpdates(machines: readonly MachineUpdateTarget[]): Promise<void> {
  // A machine already being asked or updated is not asked a second time.
  const idle = machines.filter((machine) => !isMachineUpdateBusy(state, machine));
  if (idle.length === 0 || !canUpdateOtherMachines()) return;
  const ids = idle.map((machine) => machine.id);
  setState({ checkingIds: withIds(state.checkingIds, ids, true) });
  let confirmed = false;
  try {
    confirmed = await confirmMachineUpdates(await readMachinesUpdateImpact(idle));
  } finally {
    setState({ checkingIds: withIds(state.checkingIds, ids, false) });
  }
  if (confirmed) await runMachineUpdates(idle);
}

/**
 * The store, plus a clock that moves when an in-flight update's grace runs
 * out, so a machine that never came back on the new version gets told so
 * instead of "reconnecting…".
 */
export function useMachineUpdates(): MachineUpdatesState & { nowMs: number } {
  const current = useSyncExternalStore(subscribe, () => state, () => state);
  const [clockMs, setClockMs] = useState(() => Date.now());
  useEffect(() => {
    let nextDeadlineMs: number | null = null;
    for (const attempt of Object.values(current.attempts)) {
      if (!attempt.pendingVersion) continue;
      const deadlineMs = attempt.startedAtMs + machineUpdateGraceMs(attempt);
      if (deadlineMs <= clockMs) continue;
      nextDeadlineMs = nextDeadlineMs == null ? deadlineMs : Math.min(nextDeadlineMs, deadlineMs);
    }
    if (nextDeadlineMs == null) return;
    const timer = window.setTimeout(
      () => setClockMs(Date.now()),
      Math.max(0, nextDeadlineMs - Date.now()) + 250,
    );
    return () => window.clearTimeout(timer);
  }, [current.attempts, clockMs]);
  // Read at render: the clock above only moves at a deadline, and an attempt
  // that started since must not be judged against an older time.
  return { ...current, nowMs: Date.now() };
}
