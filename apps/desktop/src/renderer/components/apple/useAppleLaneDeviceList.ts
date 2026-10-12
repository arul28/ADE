import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type {
  AppleDeviceDiskUsage,
  AppleInstalledRuntime,
  AppleInstalledSimulator,
  AppleLaneDevice,
  AppleNewDeviceSpec,
  AppleSimulatorOwner,
  AppleSimulatorOwnershipInfo,
  IosSimulatorStatus,
  OpenProjectBinding,
} from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { laneDeviceBooted } from "./appleDeviceState";

const STATUS_POLL_MS = 6_000;

export type AppleLaneDeviceBootedRead = { udid: string };

export type AppleLaneDeviceList = {
  status: IosSimulatorStatus | null;
  installed: AppleInstalledSimulator[];
  laneDevice: AppleLaneDevice | null;
  /**
   * Who owns the OTHER installed simulators (round 5's picker).
   *
   * The picker cannot tell a free device from one lane B is mid-test in
   * without this, which is how it came to offer Open on a device it should
   * not have — and how an agent came to ask a human for permission instead of
   * creating its own.
   */
  owners: AppleSimulatorOwner[];
  /** Measured by a SECOND `deviceList`, after the list has painted. */
  disk: AppleDeviceDiskUsage | null;
  /** Who each device belongs to; arrives with `disk`. */
  ownership: AppleSimulatorOwnershipInfo[];
  measuringDisk: boolean;
  /** Installed runtimes and their device types, for the Create control. */
  runtimes: AppleInstalledRuntime[];
  /** The service's default runtime and model, where the Create control starts. */
  defaultNewDevice: AppleNewDeviceSpec | null;
  refreshing: boolean;
  /**
   * A list read has answered for this lane and chat. Until one has, an empty
   * `installed` and a null `laneDevice` mean "not known yet", not "none".
   */
  listLoaded: boolean;
  /** The last list read for this lane and chat failed. */
  listFailed: boolean;
  /** Why it failed, when `listFailed`. */
  listError: unknown;
  /**
   * The last list read that found the lane's device booted, else null. A new
   * object per read, so the same device read as booted twice is two readings.
   */
  bootedRead: AppleLaneDeviceBootedRead | null;
  /** Read the status and the list again. */
  refreshList: () => void;
  /** The lane gave its device up: forget it now and re-read. */
  dropLaneDevice: () => void;
  /** Patch one device's power in the listed state, ahead of the re-read that confirms it. */
  markInstalledState: (udid: string, next: "Booted" | "Shutdown") => void;
};

/**
 * The service status and the lane's device list, for the Apple pane.
 *
 * The status is polled while the pane is on screen; the list is read on mount
 * and on every `refreshList`.
 */
export function useAppleLaneDeviceList({
  laneId,
  sessionId,
  hidden,
  runtimePinRef,
  onError,
}: {
  laneId: string | null;
  sessionId: string | null;
  hidden: boolean;
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  onError: (cause: unknown) => void;
}): AppleLaneDeviceList {
  const [status, setStatus] = useState<IosSimulatorStatus | null>(null);
  const [installed, setInstalled] = useState<AppleInstalledSimulator[]>([]);
  const [owners, setOwners] = useState<AppleSimulatorOwner[]>([]);
  const [disk, setDisk] = useState<AppleDeviceDiskUsage | null>(null);
  const [ownership, setOwnership] = useState<AppleSimulatorOwnershipInfo[]>([]);
  const [runtimes, setRuntimes] = useState<AppleInstalledRuntime[]>([]);
  const [defaultNewDevice, setDefaultNewDevice] = useState<AppleNewDeviceSpec | null>(null);
  const [measuringDisk, setMeasuringDisk] = useState(false);
  const [listNonce, setListNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // The outcome of the list reads for one lane and chat; another key's is not
  // this one's.
  const listKey = `${laneId ?? ""}\u0000${sessionId ?? ""}`;
  const [listRead, setListRead] = useState<
    { key: string; loaded: boolean; failed: boolean; error: unknown } | null
  >(null);
  const current = listRead?.key === listKey ? listRead : null;
  const listLoaded = current?.loaded ?? false;
  const listFailed = current?.failed ?? false;
  const listLoadedRef = useRef(listLoaded);
  listLoadedRef.current = listLoaded;
  // Keyed like `listRead`, so another lane's device never stands in for this
  // one's, not even for the frame before its list loads.
  const [laneRead, setLaneRead] = useState<
    { key: string; device: AppleLaneDevice | null; bootedRead: AppleLaneDeviceBootedRead | null } | null
  >(null);
  const laneDevice = laneRead?.key === listKey ? laneRead.device : null;
  const bootedRead = laneRead?.key === listKey ? laneRead.bootedRead : null;
  const switching = useAppStore((state) => state.projectTransition !== null);
  const switchingRef = useRef(switching);
  // Counts every switch start and end, so a read can tell one happened under it.
  const switchEdgesRef = useRef(0);
  // Read through a ref so a new closure from the pane never re-reads the list.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const refreshList = useCallback(() => setListNonce((nonce) => nonce + 1), []);

  const dropLaneDevice = useCallback(() => {
    setLaneRead((current) => (current ? { ...current, device: null } : current));
    refreshList();
  }, [refreshList]);

  const markInstalledState = useCallback((udid: string, next: "Booted" | "Shutdown") => {
    setInstalled((current) => (
      current.some((entry) => entry.udid === udid && entry.state !== next)
        ? current.map((entry) => (entry.udid === udid ? { ...entry, state: next } : entry))
        : current
    ));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const next = await window.ade.iosSimulator.getStatus(runtimePinRef.current);
        if (!cancelled) setStatus(next);
      } catch (cause: unknown) {
        if (!cancelled) onErrorRef.current(cause);
      }
    };
    void read();
    const timer = window.setInterval(() => {
      if (!hidden) void read();
    }, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hidden, listNonce, runtimePinRef]);

  useEffect(() => {
    let cancelled = false;
    const switchEdges = switchEdgesRef.current;
    setRefreshing(true);
    void window.ade.iosSimulator
      .deviceList({ laneId, chatSessionId: sessionId, installed: true, runtimes: true }, runtimePinRef.current)
      .then((next) => {
        if (cancelled) return;
        setListRead({ key: listKey, loaded: true, failed: false, error: null });
        setInstalled(next.installed);
        setRuntimes(next.runtimes ?? []);
        setDefaultNewDevice(next.defaultNewDevice ?? null);
        setLaneRead({
          key: listKey,
          device: next.lane,
          bootedRead: next.lane && laneDeviceBooted(next) ? { udid: next.lane.udid } : null,
        });
        setOwners(next.owners ?? []);
        /*
         * Disk is the picker's line and nothing else's, and the picker is on
         * screen exactly when this lane owns no device. So it is asked for in
         * a second, `installed: false` call that only measures — the first
         * call must not wait behind a `du` over a 20 GB device store, which
         * on this owner's machine is the difference between a list that
         * paints and a list that hangs.
         */
        if (next.lane || next.installed.length === 0) {
          // No second read: drop the last one, or deleted devices keep their tags.
          setDisk(null);
          setOwnership([]);
          return;
        }
        setMeasuringDisk(true);
        void window.ade.iosSimulator
          .deviceList(
            { laneId, chatSessionId: sessionId, installed: false, disk: true },
            runtimePinRef.current,
          )
          .then((measured) => {
            if (cancelled) return;
            setDisk(measured.disk ?? null);
            setOwnership(measured.ownership ?? []);
          })
          // A measurement that fails costs the line its number, never the page.
          .catch(() => undefined)
          .finally(() => {
            if (!cancelled) setMeasuringDisk(false);
          });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const loaded = listLoadedRef.current;
        setListRead({ key: listKey, loaded, failed: true, error: cause });
        // Unloaded, the pane shows the failure in place of the picker.
        if (loaded) onErrorRef.current(cause);
        // A read that met a project switch is retried once the switch is over:
        // now, or by the effect below when the switch ends.
        if (switchEdgesRef.current !== switchEdges && !switchingRef.current) refreshList();
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
      // A cancelled measurement never reaches its own `finally` reset.
      setMeasuringDisk(false);
    };
  }, [laneId, listKey, listNonce, refreshList, runtimePinRef, sessionId]);

  useEffect(() => {
    if (switching === switchingRef.current) return;
    const switchEnded = !switching;
    switchEdgesRef.current += 1;
    switchingRef.current = switching;
    if (switchEnded && listFailed) refreshList();
  }, [listFailed, refreshList, switching]);

  return {
    status,
    installed,
    laneDevice,
    owners,
    disk,
    ownership,
    measuringDisk,
    runtimes,
    defaultNewDevice,
    refreshing,
    listLoaded,
    listFailed,
    listError: current?.error ?? null,
    bootedRead,
    refreshList,
    dropLaneDevice,
    markInstalledState,
  };
}
