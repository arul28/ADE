/**
 * Every machine the active project can be reached on, as one list, plus the
 * small shared pieces every cross-machine surface reads through: the remote
 * connection snapshot, a timeout for one machine's read, and a cache key for a
 * pin.
 *
 * The machine list is `buildAllMachineLanes` (see `laneMachineRouting`) with
 * its enrichment inputs: the remote-runtime connection snapshot (identity,
 * version, machines connected without this repo) and This computer's sync
 * identity. The CTO's home-machine chooser and the per-machine settings pages
 * read it, so they agree with Lanes and PRs about which machines exist and
 * which are online.
 *
 * Nothing here opens its own polling loop. The union is joined through
 * `useCrossMachineLaneSync` (ref-counted), and the snapshot is a push feed.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { LaneSummary, OpenProjectBinding, RemoteRuntimeConnectionSnapshot } from "../../shared/types";
import { THIS_MACHINE_ID } from "../../shared/machineIdentity";
import { readLocalSyncStatus } from "../lib/localSyncStatusReader";
import { useAppStore, useRootAppStore } from "./appStore";
import { isAdeCloudComputer, useAdeCloudLaneComputers } from "./adeCloudLaneIndex";
import { ADE_CLOUD_NAME } from "../../shared/adeCloudMachine";
import { useCrossMachineLaneSync } from "./crossMachineLanes";
import { buildAllMachineLanes, connectionOnline, type LaneMachine } from "./laneMachineRouting";

/** A machine of the active project, with its identity and version filled in. */
export type ProjectMachine = LaneMachine;

export type ProjectMachinesState = {
  /**
   * This computer first, then the tab's machine when it is another one, then
   * every other machine with this repo, then connected machines without it.
   */
  machines: ProjectMachine[];
  /** The local sync device name ("Arul's MacBook Pro"), when known. */
  thisMachineDeviceName: string | null;
  /**
   * True once the snapshot and local identity reads have each settled (either
   * way). Before that, a short list may just mean "not read yet".
   */
  settled: boolean;
  /** Connected remote machines, counted from the snapshot. */
  connectedRemoteCount: number;
};

/**
 * The remote-runtime connection snapshot, subscribed while `active`.
 *
 * `loaded` is true once the snapshot has answered since the shared feed last
 * started (or at once while another caller keeps it live), and resolves even
 * when the bridge is missing (tests, the hosted web client), so callers never
 * wait forever. The last snapshot is kept while inactive.
 *
 * Every caller reads the one shared feed below: one snapshot read and one
 * window listener however many panes, chips and pickers ask. A listener per
 * hook added one IPC listener per mounted caller, enough to trip Node's
 * MaxListeners warning on a desktop with a few chats and computers open.
 */
export function useRemoteConnectionSnapshot(active: boolean): {
  snapshot: RemoteRuntimeConnectionSnapshot | null;
  loaded: boolean;
} {
  const state = useSyncExternalStore(
    active ? subscribeSharedSnapshot : subscribeNothing,
    readSharedSnapshotState,
    readSharedSnapshotState,
  );
  return active ? state : { snapshot: state.snapshot, loaded: false };
}

// ── One shared connection snapshot feed for the window ──────────────────────

type SharedSnapshotState = { snapshot: RemoteRuntimeConnectionSnapshot | null; loaded: boolean };

let sharedSnapshot: RemoteRuntimeConnectionSnapshot | null = null;
let sharedSnapshotState: SharedSnapshotState = { snapshot: null, loaded: false };
const sharedSnapshotListeners = new Set<() => void>();
let stopSharedSnapshot: (() => void) | null = null;

function subscribeNothing(): () => void {
  return () => undefined;
}

function readSharedSnapshotState(): SharedSnapshotState {
  return sharedSnapshotState;
}

function publishSharedSnapshot(loaded: boolean): void {
  if (sharedSnapshotState.snapshot === sharedSnapshot && sharedSnapshotState.loaded === loaded) return;
  sharedSnapshotState = { snapshot: sharedSnapshot, loaded };
  for (const listener of sharedSnapshotListeners) listener();
}

function startSharedSnapshot(): () => void {
  const bridge = typeof window === "undefined" ? undefined : window.ade?.remoteRuntime;
  if (typeof bridge?.getConnectionSnapshot !== "function") {
    // No other machines can exist without the remote runtime bridge.
    publishSharedSnapshot(true);
    return () => undefined;
  }
  // A restarted feed has not answered yet; its last snapshot stays readable.
  publishSharedSnapshot(false);
  let stopped = false;
  const apply = (next: RemoteRuntimeConnectionSnapshot | null | undefined) => {
    if (stopped) return;
    if (next && !(sharedSnapshot && sharedSnapshot.updatedAt > next.updatedAt)) sharedSnapshot = next;
    publishSharedSnapshot(true);
  };
  void bridge.getConnectionSnapshot().then(apply, () => apply(null));
  const unsubscribe = typeof bridge.onConnectionSnapshotChanged === "function"
    ? bridge.onConnectionSnapshotChanged((next) => apply(next))
    : undefined;
  return () => {
    stopped = true;
    unsubscribe?.();
  };
}

function subscribeSharedSnapshot(listener: () => void): () => void {
  sharedSnapshotListeners.add(listener);
  if (sharedSnapshotListeners.size === 1) stopSharedSnapshot = startSharedSnapshot();
  return () => {
    sharedSnapshotListeners.delete(listener);
    if (sharedSnapshotListeners.size > 0) return;
    stopSharedSnapshot?.();
    stopSharedSnapshot = null;
    // Nobody listens: the next caller waits for a fresh answer, not this one.
    sharedSnapshotState = { snapshot: sharedSnapshot, loaded: false };
  };
}

/**
 * "offline" when the connection snapshot lists the target and it is not
 * connected; "online" when it is connected; "unknown" before the first
 * snapshot, and for a target the snapshot does not list (the hosted web
 * client lists none). Pure.
 */
export function remoteTargetState(
  snapshot: Pick<RemoteRuntimeConnectionSnapshot, "connections"> | null,
  targetId: string,
): "online" | "offline" | "unknown" {
  const connection = snapshot?.connections.find((entry) => entry.target.id === targetId);
  if (!connection) return "unknown";
  return connectionOnline(connection) ? "online" : "offline";
}

/**
 * Whether the remote target is connected, from one shared snapshot feed for
 * every caller (one read and one listener in the window, however many hooks
 * ask). Returns a string, so a snapshot push that changes nothing for this
 * target renders nothing. Null target: "unknown", and no feed.
 */
export function useRemoteTargetState(targetId: string | null): "online" | "offline" | "unknown" {
  const subscribe = useMemo(
    () => (targetId ? subscribeSharedSnapshot : () => () => undefined),
    [targetId],
  );
  return useSyncExternalStore(
    subscribe,
    () => (targetId ? remoteTargetState(sharedSnapshot, targetId) : "unknown"),
    () => "unknown",
  );
}

/**
 * A mark for the target's current connection: its `connectedAt` while it is
 * connected (not held after a drop), else "". A new connection, such as an
 * ADE Cloud computer's new brain after a wake, gives a new mark. Same shared
 * feed as `useRemoteTargetState`; null target: "", and no feed.
 */
export function useRemoteConnectionMark(targetId: string | null): string {
  const subscribe = useMemo(
    () => (targetId ? subscribeSharedSnapshot : () => () => undefined),
    [targetId],
  );
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!targetId) return "";
      const connection = sharedSnapshot?.connections.find((entry) => entry.target.id === targetId);
      if (!connection || connection.state !== "connected" || typeof connection.reconnectingSinceMs === "number") return "";
      return String(connection.connectedAt ?? "");
    },
    () => "",
  );
}

/**
 * Whether slow-connection mode is on for the connection to this machine
 * (`shared/slowLinkMode.ts`). Same shared feed; null target: false, no feed.
 */
export function useSlowLinkActive(targetId: string | null): boolean {
  const subscribe = useMemo(
    () => (targetId ? subscribeSharedSnapshot : () => () => undefined),
    [targetId],
  );
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!targetId) return false;
      const connection = sharedSnapshot?.connections.find((entry) => entry.target.id === targetId);
      return connection?.state === "connected" && connection.slowLink?.active === true;
    },
    () => false,
  );
}

/**
 * The last measured round trip to this machine, in ms, while it is connected;
 * null before the first measure. Same shared feed; null target: null.
 */
export function useLinkRoundTripMs(targetId: string | null): number | null {
  const subscribe = useMemo(
    () => (targetId ? subscribeSharedSnapshot : () => () => undefined),
    [targetId],
  );
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!targetId) return null;
      const connection = sharedSnapshot?.connections.find((entry) => entry.target.id === targetId);
      if (connection?.state !== "connected") return null;
      const rtt = connection.slowLink?.rttMs ?? connection.route?.latencyMs;
      return typeof rtt === "number" ? rtt : null;
    },
    () => null,
  );
}

/** Round trip from which a terminal shows typed characters before the echo. */
export const TYPE_AHEAD_RTT_MS = 200;

/**
 * The round trip to this machine when its terminals should guess typed
 * characters (`terminalTypeAhead.ts`), else null: slow-connection mode on, or
 * a round trip of `TYPE_AHEAD_RTT_MS` or more. The machine's "Off" setting
 * turns it off. Same shared feed; null target: null.
 */
export function useTypeAheadRoundTripMs(targetId: string | null): number | null {
  const subscribe = useMemo(
    () => (targetId ? subscribeSharedSnapshot : () => () => undefined),
    [targetId],
  );
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!targetId) return null;
      const connection = sharedSnapshot?.connections.find((entry) => entry.target.id === targetId);
      if (connection?.state !== "connected" || connection.target.slowLinkMode === "off") return null;
      const rtt = connection.slowLink?.rttMs ?? connection.route?.latencyMs ?? null;
      if (connection.slowLink?.active) return typeof rtt === "number" ? rtt : TYPE_AHEAD_RTT_MS;
      return typeof rtt === "number" && rtt >= TYPE_AHEAD_RTT_MS ? rtt : null;
    },
    () => null,
  );
}

/** This computer's sync identity, read once per activation through the shared reader. */
function useThisMachineIdentity(active: boolean): {
  deviceId: string | null;
  name: string | null;
  loaded: boolean;
} {
  const [identity, setIdentity] = useState<{ deviceId: string | null; name: string | null; loaded: boolean }>({
    deviceId: null,
    name: null,
    loaded: false,
  });
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    if (typeof window === "undefined" || typeof window.ade?.sync?.getLocalStatus !== "function") {
      setIdentity((current) => (current.loaded ? current : { ...current, loaded: true }));
      return () => { cancelled = true; };
    }
    void readLocalSyncStatus().then(
      (status) => {
        if (cancelled) return;
        const deviceId = status?.localDevice?.deviceId?.trim() || null;
        const name = status?.localDevice?.name?.trim() || null;
        setIdentity({ deviceId, name, loaded: true });
      },
      () => {
        if (cancelled) return;
        setIdentity((current) => ({ ...current, loaded: true }));
      },
    );
    return () => { cancelled = true; };
  }, [active]);
  return identity;
}

const NO_LANES: readonly LaneSummary[] = [];

/** Whether a machine of the list is one of the account's ADE Cloud computers (a lane's, a CTO home, any). */
export function isAdeCloudProjectMachine(
  machine: Pick<ProjectMachine, "hostname" | "machineId" | "isThisMachine">,
  index?: Parameters<typeof isAdeCloudComputer>[1],
): boolean {
  return !machine.isThisMachine && isAdeCloudComputer({ hostname: machine.hostname, machineKey: machine.machineId }, index);
}

/**
 * The machine list for the active project tab. Every ADE Cloud computer in it
 * reads "ADE Cloud", never its own name. `ownOnly` leaves ADE Cloud computers
 * out: for a list of the person's own computers (machine-level settings, the
 * `.env` tip), where ADE Cloud has its own place.
 */
export function useProjectMachines(active = true, options: { ownOnly?: boolean } = {}): ProjectMachinesState {
  const ownOnly = options.ownOnly === true;
  useCrossMachineLaneSync(active);
  const projectBinding = useAppStore((state) => state.projectBinding);
  const unionMachines = useRootAppStore((state) => state.crossMachineLanesByMachineId);
  const { snapshot, loaded: snapshotLoaded } = useRemoteConnectionSnapshot(active);
  const local = useThisMachineIdentity(active);
  const cloudIndex = useAdeCloudLaneComputers();
  const laneComputers = cloudIndex.computers;

  const machines = useMemo<ProjectMachine[]>(() => {
    const all = buildAllMachineLanes({
      activeBinding: projectBinding ?? null,
      // Machines only; the lane rows are not read here.
      activeLanes: NO_LANES,
      machines: unionMachines ?? {},
      connections: snapshot?.connections ?? [],
      thisMachineDeviceId: local.deviceId,
      // A cloud lane's computer reads "ADE Cloud".
      adeCloud: { computers: laneComputers },
    });
    const withRepo = [...all.machines];
    // This computer leads the list wherever it sits in the union.
    const thisIndex = withRepo.findIndex((machine) => machine.machineId === THIS_MACHINE_ID);
    if (thisIndex > 0) withRepo.unshift(...withRepo.splice(thisIndex, 1));
    const withoutRepo = all.machinesWithoutRepo;
    const thisWithoutRepo = withoutRepo.filter((machine) => machine.isThisMachine);
    const ordered = [
      ...thisWithoutRepo,
      ...withRepo,
      ...withoutRepo.filter((machine) => !machine.isThisMachine),
    ];
    // ADE Cloud is one machine: no cloud computer shows its own name.
    return ordered.flatMap((machine) => {
      if (!isAdeCloudProjectMachine(machine, cloudIndex)) return [machine];
      if (ownOnly) return [];
      return [machine.machineName === ADE_CLOUD_NAME ? machine : { ...machine, machineName: ADE_CLOUD_NAME }];
    });
  }, [cloudIndex, laneComputers, local.deviceId, ownOnly, projectBinding, snapshot, unionMachines]);

  const connectedRemoteCount = useMemo(
    () => (snapshot?.connections ?? []).filter(connectionOnline).length,
    [snapshot],
  );

  return {
    machines,
    thisMachineDeviceName: local.name,
    // A snapshot kept from an earlier activation still counts as an answer.
    settled: (snapshotLoaded || snapshot != null) && local.loaded,
    connectedRemoteCount,
  };
}

/** Upper bound on one machine's read, so a wedged machine never holds a list. */
export const MACHINE_READ_TIMEOUT_MS = 8_000;

/** Reject after `ms`; the underlying call is left to settle on its own. */
export function withMachineTimeout<T>(
  promise: Promise<T>,
  machineName: string,
  ms = MACHINE_READ_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${machineName} did not answer in time`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * A call sent to another machine is timed out; the tab machine's own call is
 * left as is (it never had a timeout, and its pin is set like any other).
 */
export function onMachine<T>(
  promise: Promise<T>,
  machine: { pin: OpenProjectBinding | null; machineName: string; isActiveBinding: boolean } | null | undefined,
): Promise<T> {
  return machine?.pin && !machine.isActiveBinding ? withMachineTimeout(promise, machine.machineName) : promise;
}
