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
 * `loaded` is true once the snapshot has answered since `active` last turned
 * on, and resolves even when the bridge is missing (tests, the hosted web
 * client), so callers never wait forever. The last snapshot is kept while
 * inactive.
 */
export function useRemoteConnectionSnapshot(active: boolean): {
  snapshot: RemoteRuntimeConnectionSnapshot | null;
  loaded: boolean;
} {
  const [snapshot, setSnapshot] = useState<RemoteRuntimeConnectionSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!active) {
      setLoaded(false);
      return undefined;
    }
    const bridge = typeof window === "undefined" ? undefined : window.ade?.remoteRuntime;
    if (typeof bridge?.getConnectionSnapshot !== "function") {
      // No other machines can exist without the remote runtime bridge.
      setLoaded(true);
      return undefined;
    }
    let cancelled = false;
    const apply = (next: RemoteRuntimeConnectionSnapshot | null | undefined) => {
      if (cancelled) return;
      if (next) setSnapshot((current) => (current && current.updatedAt > next.updatedAt ? current : next));
      setLoaded(true);
    };
    void bridge.getConnectionSnapshot().then(apply, () => apply(null));
    const unsubscribe = typeof bridge.onConnectionSnapshotChanged === "function"
      ? bridge.onConnectionSnapshotChanged((next) => apply(next))
      : undefined;
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [active]);
  return { snapshot, loaded };
}

// ── One shared connection state per remote target ───────────────────────────

let sharedSnapshot: RemoteRuntimeConnectionSnapshot | null = null;
const sharedSnapshotListeners = new Set<() => void>();
let stopSharedSnapshot: (() => void) | null = null;

function startSharedSnapshot(): () => void {
  const bridge = typeof window === "undefined" ? undefined : window.ade?.remoteRuntime;
  if (typeof bridge?.getConnectionSnapshot !== "function") return () => undefined;
  let stopped = false;
  const apply = (next: RemoteRuntimeConnectionSnapshot | null | undefined) => {
    if (stopped || !next) return;
    if (sharedSnapshot && sharedSnapshot.updatedAt > next.updatedAt) return;
    sharedSnapshot = next;
    for (const listener of sharedSnapshotListeners) listener();
  };
  void bridge.getConnectionSnapshot().then(apply, () => undefined);
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

/** The machine list for the active project tab. */
export function useProjectMachines(active = true): ProjectMachinesState {
  useCrossMachineLaneSync(active);
  const projectBinding = useAppStore((state) => state.projectBinding);
  const unionMachines = useRootAppStore((state) => state.crossMachineLanesByMachineId);
  const { snapshot, loaded: snapshotLoaded } = useRemoteConnectionSnapshot(active);
  const local = useThisMachineIdentity(active);

  const machines = useMemo<ProjectMachine[]>(() => {
    const all = buildAllMachineLanes({
      activeBinding: projectBinding ?? null,
      // Machines only; the lane rows are not read here.
      activeLanes: NO_LANES,
      machines: unionMachines ?? {},
      connections: snapshot?.connections ?? [],
      thisMachineDeviceId: local.deviceId,
    });
    const withRepo = [...all.machines];
    // This computer leads the list wherever it sits in the union.
    const thisIndex = withRepo.findIndex((machine) => machine.machineId === THIS_MACHINE_ID);
    if (thisIndex > 0) withRepo.unshift(...withRepo.splice(thisIndex, 1));
    const withoutRepo = all.machinesWithoutRepo;
    const thisWithoutRepo = withoutRepo.filter((machine) => machine.isThisMachine);
    return [
      ...thisWithoutRepo,
      ...withRepo,
      ...withoutRepo.filter((machine) => !machine.isThisMachine),
    ];
  }, [local.deviceId, projectBinding, snapshot, unionMachines]);

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
