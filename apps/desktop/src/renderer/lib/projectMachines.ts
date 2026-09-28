/**
 * Every machine the active project can be reached on, as one list.
 *
 * Two surfaces need "which machines exist for this repo, and how do I call
 * each one": the CTO's home-machine chooser and the per-machine settings
 * groups. Both derive from the same two sources the Work tab already keeps
 * warm — the tab's binding and the shared cross-machine union — plus the
 * remote-runtime connection snapshot for names, global identities, and
 * machines that are connected but hold no checkout of this repo.
 *
 * Nothing here opens its own polling loop. The union is joined through
 * `useCrossMachineLaneUnion` (ref-counted), and the snapshot is a push feed.
 *
 * Routing rule, the one that matters: `pin === null` means "the tab's own
 * binding". Every other reachable machine carries a concrete binding. A machine
 * with no binding (no checkout here, or never read) is listed but is not
 * `routable`, and callers must not send it anything.
 */

import { useEffect, useMemo, useState } from "react";
import type {
  OpenProjectBinding,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeConnectionStatus,
} from "../../shared/types";
import {
  THIS_MACHINE_ID,
  THIS_MACHINE_NAME,
  machineNameForBinding,
} from "../../shared/machineIdentity";
import { useCrossMachineLaneUnion } from "../state/crossMachineLanes";
import { useAppStore, useRootAppStore } from "../state/appStore";
import { readLocalSyncStatus } from "./localSyncStatusReader";

export type ProjectMachine = {
  /** `THIS_MACHINE_ID`, or the remote-runtime target id. Local to this desktop. */
  id: string;
  /** Absolute machine name. Never the word "remote". */
  name: string;
  /** The physical machine this ADE window runs on. */
  isThisMachine: boolean;
  /** The machine the project tab is bound to (the unpinned default). */
  isBound: boolean;
  online: boolean;
  /** Whether this machine holds a checkout of the active repo. */
  hasRepo: boolean;
  /**
   * Pass to any pin-aware preload call. Null = the tab's binding, which is only
   * ever true for the bound machine. Meaningless when `routable` is false.
   */
  pin: OpenProjectBinding | null;
  /** True when a call can be addressed to this machine's checkout of the repo. */
  routable: boolean;
  /**
   * Account-wide identity: the sync device id. Local for This computer, the
   * paired host identity for paired machines. Null for SSH targets and while
   * the local sync status is still loading.
   */
  deviceId: string | null;
  /** Network host name, when the target record carries one. */
  hostname: string | null;
  /** ADE runtime version the machine reported, when connected. Null for This computer. */
  version: string | null;
};

export type ProjectMachinesState = {
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

function connectionOnline(connection: RemoteRuntimeConnectionStatus | undefined): boolean {
  return connection?.state === "connected";
}

function connectionDeviceId(connection: RemoteRuntimeConnectionStatus | undefined): string | null {
  const identity = connection?.target.pairedMachine?.hostIdentity?.trim();
  return identity || null;
}

/**
 * Subscribe to the connection snapshot. Resolves `loaded` even when the bridge
 * is missing (tests, the hosted web client), so callers never wait forever.
 */
function useConnectionSnapshot(active: boolean): {
  snapshot: RemoteRuntimeConnectionSnapshot | null;
  loaded: boolean;
} {
  const [snapshot, setSnapshot] = useState<RemoteRuntimeConnectionSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let latest = Number.NEGATIVE_INFINITY;
    const apply = (next: RemoteRuntimeConnectionSnapshot | null | undefined) => {
      if (cancelled) return;
      if (next && next.updatedAt >= latest) {
        latest = next.updatedAt;
        setSnapshot(next);
      }
      setLoaded(true);
    };
    const bridge = typeof window === "undefined" ? undefined : window.ade?.remoteRuntime;
    if (typeof bridge?.getConnectionSnapshot !== "function") {
      setLoaded(true);
      return () => { cancelled = true; };
    }
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

/** This computer's sync identity, read once per mount through the shared reader. */
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

/**
 * The machine list for the active project tab.
 *
 * Order: This computer first, then the bound machine when it is another one,
 * then every other machine with this repo, then connected machines without it,
 * then saved machines that are offline.
 */
export function useProjectMachines(active = true): ProjectMachinesState {
  // Joining the shared union is what keeps the other machines' slices warm; the
  // return value is not needed here.
  useCrossMachineLaneUnion(active);
  const projectBinding = useAppStore((state) => state.projectBinding);
  const unionMachines = useRootAppStore((state) => state.crossMachineLanesByMachineId);
  const { snapshot, loaded: snapshotLoaded } = useConnectionSnapshot(active);
  const local = useThisMachineIdentity(active);

  const machines = useMemo<ProjectMachine[]>(() => {
    const connections = snapshot?.connections ?? [];
    const connectionById = new Map(connections.map((connection) => [connection.target.id, connection]));
    const boundRemote = projectBinding?.kind === "remote" ? projectBinding : null;
    const result: ProjectMachine[] = [];
    const seen = new Set<string>();

    // This computer.
    const thisEntry = unionMachines?.[THIS_MACHINE_ID] ?? null;
    const thisBound = !boundRemote;
    const thisPin = thisBound ? null : (thisEntry?.binding ?? null);
    result.push({
      id: THIS_MACHINE_ID,
      name: THIS_MACHINE_NAME,
      isThisMachine: true,
      isBound: thisBound,
      online: true,
      hasRepo: thisBound ? projectBinding != null : Boolean(thisEntry?.binding),
      pin: thisPin,
      routable: thisBound ? projectBinding != null : thisPin != null,
      deviceId: local.deviceId,
      hostname: null,
      version: null,
    });
    seen.add(THIS_MACHINE_ID);

    // The bound machine, when it is another one.
    if (boundRemote) {
      const connection = connectionById.get(boundRemote.targetId);
      result.push({
        id: boundRemote.targetId,
        name: connection?.target.name?.trim() || machineNameForBinding(boundRemote),
        isThisMachine: false,
        isBound: true,
        // Before the first snapshot lands, the bound machine is assumed reachable:
        // the tab would not be bound to it otherwise.
        online: connection ? connectionOnline(connection) : true,
        hasRepo: true,
        pin: null,
        routable: true,
        deviceId: connectionDeviceId(connection),
        hostname: connection?.target.hostname ?? boundRemote.hostname ?? null,
        version: connection?.version ?? null,
      });
      seen.add(boundRemote.targetId);
    }

    // Every other machine the union found this repo on.
    for (const entry of Object.values(unionMachines ?? {})) {
      if (seen.has(entry.machineId)) continue;
      const targetId = entry.targetId ?? entry.machineId;
      const connection = connectionById.get(targetId);
      const pin = entry.binding ?? null;
      result.push({
        id: entry.machineId,
        name: entry.machineName?.trim() || connection?.target.name?.trim() || entry.machineId,
        isThisMachine: false,
        isBound: false,
        online: entry.online !== false && (connection ? connectionOnline(connection) : true),
        hasRepo: true,
        pin,
        routable: pin != null,
        deviceId: connectionDeviceId(connection),
        hostname: connection?.target.hostname ?? null,
        version: connection?.version ?? null,
      });
      seen.add(entry.machineId);
    }

    // Saved machines with no checkout of this repo (or not read yet).
    const rest = connections
      .filter((connection) => !seen.has(connection.target.id))
      .sort((a, b) => Number(connectionOnline(b)) - Number(connectionOnline(a)));
    for (const connection of rest) {
      result.push({
        id: connection.target.id,
        name: connection.target.name?.trim() || connection.target.hostname || connection.target.id,
        isThisMachine: false,
        isBound: false,
        online: connectionOnline(connection),
        hasRepo: false,
        pin: null,
        routable: false,
        deviceId: connectionDeviceId(connection),
        hostname: connection.target.hostname ?? null,
        version: connection.version ?? null,
      });
    }
    return result;
  }, [local.deviceId, projectBinding, snapshot, unionMachines]);

  const connectedRemoteCount = useMemo(
    () => (snapshot?.connections ?? []).filter(connectionOnline).length,
    [snapshot],
  );

  return {
    machines,
    thisMachineDeviceName: local.name,
    settled: snapshotLoaded && local.loaded,
    connectedRemoteCount,
  };
}

/** Stable identity for a pin, for keying caches. `bound` for the tab's binding. */
export function pinKey(pin: OpenProjectBinding | null | undefined): string {
  return pin ? pin.key : "bound";
}
