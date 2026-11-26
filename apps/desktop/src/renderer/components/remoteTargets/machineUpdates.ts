import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { RemoteRuntimeConnectionSnapshot, RemoteRuntimeUpdateAndRestartResult } from "../../../shared/types";
import { extractError } from "../../lib/format";
import { captureError } from "../../../shared/sentry/capture";
import { UNKNOWN_UPDATE_IMPACT } from "../../../shared/updateImpact";
import { useAutoUpdateSnapshot } from "../app/useAutoUpdateSnapshot";
import { confirmMachineTrackSwitch, confirmMachineUpdates, type MachineWithImpact } from "./MachineUpdateImpact";
import { updateTrackLabel, type UpdateTrack } from "../../../shared/updateTrack";
import {
  connectedMachinesFromSnapshot,
  isMachineVersionCurrent,
  knownAdeVersions,
  machinesBehindOnTheirTrack,
  machineUpdateTrack,
  type ConnectedMachine,
  type MachineUpdateTarget,
} from "./remoteMachineModel";
import {
  describeMachineUpdateAttempt,
  machineUpdateAttemptFromResult,
  machineUpdateGraceMs,
  MACHINE_UPDATE_RECHECK_MS,
  type MachineUpdateAttempt,
} from "./machineUpdateStatus";
import { isAdeAvailable } from "../../lib/adeAvailability";
import { adeCloudEnabled } from "../../state/cloudAccess";
import { selfUpdatingCloudMachineKeys } from "../../../shared/adeCloud";

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
  /**
   * The track each machine was last switched to from here, by machine id.
   * A machine reports only its running build, so until the new track's build
   * lands this is what its row shows (`machineShownTrack`).
   */
  trackChoices: Readonly<Record<string, UpdateTrack>>;
};

/**
 * Whether this machine's update is a download the person installs by hand
 * (a Linux `.deb`). The host's report wins; a refused attempt covers a report
 * that was stale or came from an older connection snapshot.
 */
export function machineUpdateIsManual(
  machine: { updateInstallMode?: string | null },
  attempt?: { updateInstallMode?: string | null } | null,
): boolean {
  return (machine.updateInstallMode ?? attempt?.updateInstallMode) === "manual_download";
}

let state: MachineUpdatesState = {
  updatingIds: new Set(),
  checkingIds: new Set(),
  attempts: {},
  trackChoices: {},
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
 * The connected machines, kept current by main's connection snapshot. Null
 * until ADE has read them; `failed` when the read failed and no push has
 * arrived since, so an error never reads as "no machines".
 */
export function useConnectedMachines(): { machines: ConnectedMachine[] | null; failed: boolean } {
  const [snapshot, setSnapshot] = useState<RemoteRuntimeConnectionSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // Whichever arrives later wins; an older read must not replace a newer push.
    const accept = (next: RemoteRuntimeConnectionSnapshot) => {
      if (cancelled) return;
      setFailed(false);
      setSnapshot((current) => (current && current.updatedAt > next.updatedAt ? current : next));
    };
    void window.ade.remoteRuntime.getConnectionSnapshot().then(accept).catch(() => {
      if (!cancelled) setFailed(true);
    });
    const unsubscribe = window.ade.remoteRuntime.onConnectionSnapshotChanged?.(accept);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);
  const machines = useMemo(() => (snapshot ? connectedMachinesFromSnapshot(snapshot) : null), [snapshot]);
  return { machines, failed };
}

/** Whether this client can move another machine to the other update track. */
export function canSwitchMachineTracks(): boolean {
  const remoteRuntime = window.ade?.remoteRuntime as { switchUpdateTrack?: unknown } | undefined;
  return isAdeAvailable(remoteRuntime?.switchUpdateTrack);
}

/** The track a machine's row shows: the one it was just switched to from here, else its build's. */
export function machineShownTrack(machine: ConnectedMachine, current: MachineUpdatesState = state): UpdateTrack {
  return current.trackChoices[machine.id] ?? machineUpdateTrack(machine);
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
    && describeMachineUpdateAttempt(attempt, { ...machine, connected: true }, nowMs).inFlight;
}

/**
 * Every ADE build this computer knows of, on either track (`knownAdeVersions`),
 * from its update snapshot. A machine is offered the newest one on its own
 * track (`machineUpdateTargetVersion`).
 */
export function useKnownAdeVersions(): string[] {
  const snapshot = useAutoUpdateSnapshot();
  const { currentVersion, version, latestKnownVersion } = snapshot;
  const latestStable = snapshot.latestByTrack?.stable ?? null;
  const latestBeta = snapshot.latestByTrack?.beta ?? null;
  return useMemo(
    () => knownAdeVersions({ currentVersion, version, latestKnownVersion, latestByTrack: { stable: latestStable, beta: latestBeta } }),
    [currentVersion, version, latestKnownVersion, latestStable, latestBeta],
  );
}

/**
 * The machine keys of the cloud computers that update themselves, read from
 * the account (no pin: cloud access is the account's). Empty when ADE Cloud is
 * off or the read fails, so a machine then keeps today's Update button.
 * Never rejects.
 */
export async function readSelfUpdatingCloudKeys(): Promise<Set<string>> {
  const listMachines = window.ade?.cloud?.listMachines;
  if (!adeCloudEnabled() || !isAdeAvailable(listMachines)) return new Set();
  return selfUpdatingCloudMachineKeys(await listMachines().catch(() => null));
}

/** Leaves out the cloud computers that update themselves: they are never "behind". */
export function withoutSelfUpdatingCloud<T extends Pick<ConnectedMachine, "id" | "colorKey">>(machines: readonly T[], keys: ReadonlySet<string>): T[] {
  return keys.size === 0 ? [...machines] : machines.filter((machine) => !keys.has(machine.colorKey ?? machine.id));
}

/**
 * Connected machines behind the newest build this computer knows on their
 * own track (`knownAdeVersions`), each with the version it would be sent.
 * A cloud computer that updates itself is never one. Never rejects.
 */
export async function listOutdatedConnectedMachines(known: readonly string[]): Promise<MachineUpdateTarget[]> {
  if (known.length === 0 || !canUpdateOtherMachines()) return [];
  try {
    const snapshot = await window.ade.remoteRuntime.getConnectionSnapshot();
    const behind = machinesBehindOnTheirTrack(connectedMachinesFromSnapshot(snapshot), known)
      .filter((machine) => !machineUpdateIsManual(machine));
    // The cloud list is read only when something is behind.
    return behind.length ? withoutSelfUpdatingCloud(behind, await readSelfUpdatingCloudKeys()) : behind;
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
  return await runMachineCall(
    machine,
    () => window.ade.remoteRuntime.updateAndRestart(machine.id, targetVersion),
    `${machine.name} updated — reconnecting…`,
  );
}

/** One update-shaped call to a machine, tracked in the store as an update attempt. */
async function runMachineCall(
  machine: ConnectedMachine,
  call: () => Promise<RemoteRuntimeUpdateAndRestartResult>,
  okMessage: string,
  onResult?: (result: RemoteRuntimeUpdateAndRestartResult) => void,
): Promise<MachineUpdateAttempt> {
  const { [machine.id]: _previous, ...otherAttempts } = state.attempts;
  setState({
    updatingIds: withIds(state.updatingIds, [machine.id], true),
    attempts: otherAttempts,
  });
  let attempt: MachineUpdateAttempt;
  try {
    const result = await call();
    onResult?.(result);
    attempt = machineUpdateAttemptFromResult(result, okMessage, Date.now());
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
  const idle = machines.filter((machine) => !machineUpdateIsManual(machine, state.attempts[machine.id]) && !state.updatingIds.has(machine.id));
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
  const idle = machines.filter((machine) => !machineUpdateIsManual(machine, state.attempts[machine.id]) && !isMachineUpdateBusy(state, machine));
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
 * "Stable / Beta" on a machine's row: names what is running there, and on yes
 * asks that machine to switch (its own database guard, then the install of
 * that track's build). The outcome shows as the row's update line. Going back
 * to the track its build is on installs nothing, so it is not asked about.
 */
export async function requestMachineTrackSwitch(machine: ConnectedMachine, track: UpdateTrack): Promise<void> {
  if (!canSwitchMachineTracks() || isMachineUpdateBusy(state, machine) || machineShownTrack(machine) === track) return;
  const switchUpdateTrack = window.ade.remoteRuntime.switchUpdateTrack;
  if (!switchUpdateTrack) return;
  if (track !== machineUpdateTrack(machine)) {
    setState({ checkingIds: withIds(state.checkingIds, [machine.id], true) });
    let confirmed = false;
    try {
      const [withImpact] = await readMachinesUpdateImpact([machine]);
      confirmed = withImpact ? await confirmMachineTrackSwitch(withImpact, track) : false;
    } finally {
      setState({ checkingIds: withIds(state.checkingIds, [machine.id], false) });
    }
    if (!confirmed) return;
  }
  await runMachineCall(
    machine,
    () => switchUpdateTrack(machine.id, track),
    `${machine.name} is switching to ${updateTrackLabel(track)} — reconnecting…`,
    (result) => {
      if (result.ok) setState({ trackChoices: { ...state.trackChoices, [machine.id]: track } });
    },
  );
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
      const graceEndMs = attempt.startedAtMs + machineUpdateGraceMs(attempt);
      if (graceEndMs <= clockMs) continue;
      // Before the grace ends, look again every so often: a brain that came
      // back on the old version fails the attempt a minute after it started
      // (`MACHINE_UPDATE_OLD_BRAIN_SETTLE_MS`), and nothing else redraws then.
      const deadlineMs = Math.min(graceEndMs, clockMs + MACHINE_UPDATE_RECHECK_MS);
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
