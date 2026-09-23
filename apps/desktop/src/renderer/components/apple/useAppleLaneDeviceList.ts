import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type {
  AppleDeviceDiskUsage,
  AppleInstalledSimulator,
  AppleLaneDevice,
  AppleSimulatorOwner,
  IosSimulatorStatus,
  OpenProjectBinding,
} from "../../../shared/types";
import { laneDeviceBooted } from "./appleDeviceState";

const STATUS_POLL_MS = 6_000;

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
  measuringDisk: boolean;
  refreshing: boolean;
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
  onLaneDeviceBooted,
  onError,
}: {
  laneId: string | null;
  sessionId: string | null;
  hidden: boolean;
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  /** A list read found the lane's device booted. */
  onLaneDeviceBooted: (udid: string) => void;
  onError: (cause: unknown) => void;
}): AppleLaneDeviceList {
  const [status, setStatus] = useState<IosSimulatorStatus | null>(null);
  const [installed, setInstalled] = useState<AppleInstalledSimulator[]>([]);
  const [laneDevice, setLaneDevice] = useState<AppleLaneDevice | null>(null);
  const [owners, setOwners] = useState<AppleSimulatorOwner[]>([]);
  const [disk, setDisk] = useState<AppleDeviceDiskUsage | null>(null);
  const [measuringDisk, setMeasuringDisk] = useState(false);
  const [listNonce, setListNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // Read through refs so a new closure from the pane never re-reads the list.
  const onBootedRef = useRef(onLaneDeviceBooted);
  onBootedRef.current = onLaneDeviceBooted;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const refreshList = useCallback(() => setListNonce((nonce) => nonce + 1), []);

  const dropLaneDevice = useCallback(() => {
    setLaneDevice(null);
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
    setRefreshing(true);
    void window.ade.iosSimulator
      .deviceList({ laneId, chatSessionId: sessionId, installed: true }, runtimePinRef.current)
      .then((next) => {
        if (cancelled) return;
        setInstalled(next.installed);
        setLaneDevice(next.lane);
        if (next.lane && laneDeviceBooted(next)) onBootedRef.current(next.lane.udid);
        setOwners(next.owners ?? []);
        /*
         * Disk is the picker's line and nothing else's, and the picker is on
         * screen exactly when this lane owns no device. So it is asked for in
         * a second, `installed: false` call that only measures — the first
         * call must not wait behind a `du` over a 20 GB device store, which
         * on this owner's machine is the difference between a list that
         * paints and a list that hangs.
         */
        if (next.lane || next.installed.length === 0) return;
        setMeasuringDisk(true);
        void window.ade.iosSimulator
          .deviceList(
            { laneId, chatSessionId: sessionId, installed: false, disk: true },
            runtimePinRef.current,
          )
          .then((measured) => {
            if (!cancelled) setDisk(measured.disk ?? null);
          })
          // A measurement that fails costs the line its number, never the page.
          .catch(() => undefined)
          .finally(() => {
            if (!cancelled) setMeasuringDisk(false);
          });
      })
      .catch((cause: unknown) => {
        if (!cancelled) onErrorRef.current(cause);
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [laneId, listNonce, runtimePinRef, sessionId]);

  return {
    status,
    installed,
    laneDevice,
    owners,
    disk,
    measuringDisk,
    refreshing,
    refreshList,
    dropLaneDevice,
    markInstalledState,
  };
}
