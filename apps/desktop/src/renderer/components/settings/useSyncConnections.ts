import { useCallback, useEffect, useRef, useState } from "react";
import {
  peerToRuntimeDeviceState,
  type SyncDeviceRuntimeState,
  type SyncRoleSnapshot,
} from "../../../shared/types";

export type SyncConnections = ReturnType<typeof useSyncConnections>;

/** Display name for a machine snapshot, preferring its per-runtime name. */
function machineDisplayName(status: SyncRoleSnapshot | null): string {
  if (!status) return "This computer";
  return status.runtimeName?.trim() || status.localDevice.name || "This computer";
}

function isRemoteBinding(
  localStatus: SyncRoleSnapshot | null,
  routedStatus: SyncRoleSnapshot | null,
): boolean {
  return Boolean(
    localStatus
      && routedStatus
      && localStatus.localDevice.deviceId !== routedStatus.localDevice.deviceId,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useSyncConnections() {
  // `status` is always the LOCAL physical machine (via getLocalStatus) so the
  // This-Mac card, pairing code, and its device tabs describe the Mac the user
  // is sitting at — never the machine a remote-bound project routes to.
  const [status, setStatus] = useState<SyncRoleSnapshot | null>(null);
  // The binding-routed snapshot; only used to detect remote binding and name
  // the machine this window is currently working on.
  const [routedStatus, setRoutedStatus] = useState<SyncRoleSnapshot | null>(null);
  const [routedDevices, setRoutedDevices] = useState<SyncDeviceRuntimeState[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    // Settle each read independently. The local snapshot is authoritative for
    // the This-Mac card; the routed status/devices are best-effort context
    // (remote-binding detection + the working machine's name). A remote-bound
    // window whose routed runtime is offline must still render the physical Mac,
    // so a routed failure never clears the local snapshot or surfaces an error.
    const [routedResult, localResult, devicesResult] = await Promise.all([
      window.ade.sync.getStatus().then(
        (routed) => ({ status: routed }),
        () => ({ status: null }),
      ),
      window.ade.sync.getLocalStatus().then(
        (localStatus) => ({ status: localStatus, error: null }),
        (localError: unknown) => ({ status: null, error: localError }),
      ),
      window.ade.sync.listDevices().then(
        (list) => ({ devices: list }),
        () => ({ devices: null }),
      ),
    ]);
    if (generation !== refreshGeneration.current) return;
    // Keep the last known routed context on failure rather than flickering it
    // away during a transient outage.
    if (routedResult.status !== null) setRoutedStatus(routedResult.status);
    if (devicesResult.devices !== null) setRoutedDevices(devicesResult.devices);
    if (!localResult.status) {
      // A routed status may describe another machine. Never substitute it for
      // an unavailable local snapshot or expose its device mutations as local.
      setStatus(null);
      setError(errorMessage(localResult.error));
      return;
    }
    setStatus(localResult.status);
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await refresh();
      } catch (refreshError) {
        if (!cancelled) setError(errorMessage(refreshError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    const dispose = window.ade.sync.onEvent((event) => {
      if (event.type !== "sync-status" || cancelled) return;
      void refresh().catch(() => {});
    });
    const refreshWhenVisible = () => {
      if (!cancelled) void refresh().catch(() => {});
    };
    const interval = window.setInterval(refreshWhenVisible, 5_000);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      cancelled = true;
      refreshGeneration.current += 1;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      dispose();
    };
  }, [refresh]);

  // When remote-bound, routed listDevices() describes that remote machine.
  // Derive this computer's connected devices from the local snapshot's live peers;
  // offline-but-paired rows are not available until a local-scoped IPC exists.
  const isRemoteBound = isRemoteBinding(status, routedStatus);
  const boundMachineName = isRemoteBound ? machineDisplayName(routedStatus) : null;
  const localMachineName = machineDisplayName(status);
  const devices = !status
    ? []
    : isRemoteBound
      ? status.connectedPeers.map((peer) => peerToRuntimeDeviceState(peer))
      : routedDevices;

  const runAction = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      await refresh();
    } catch (actionError) {
      setError(errorMessage(actionError));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  // Throwing setter for the inline PIN editor so it can surface errors next to
  // the control. Returns the authoritative snapshot rather than re-fetching.
  const setPinValue = useCallback(async (pin: string) => {
    const nextStatus = await window.ade.sync.setPin(pin);
    setStatus(nextStatus);
  }, []);

  const generatePin = useCallback(() => runAction(async () => {
    await window.ade.sync.generatePin();
    setNotice("Pairing code generated.");
  }), [runAction]);

  const clearPin = useCallback(() => runAction(async () => {
    await window.ade.sync.clearPin();
    setNotice("Pairing code removed. New devices can no longer connect.");
  }), [runAction]);

  const saveRuntimeName = useCallback((name: string) => runAction(async () => {
    const trimmed = name.trim();
    if (trimmed) {
      await window.ade.sync.setRuntimeName(trimmed);
      setNotice("Machine name updated.");
    } else {
      await window.ade.sync.clearRuntimeName();
      setNotice("Machine name cleared.");
    }
  }), [runAction]);

  const forgetDevice = useCallback((device: SyncDeviceRuntimeState) => runAction(async () => {
    await window.ade.sync.forgetDevice(device.deviceId);
    setNotice(device.connectionState === "connected" ? "Device revoked." : "Device removed.");
  }), [runAction]);

  const retryInitialLoad = useCallback(() => {
    setLoading(true);
    setError(null);
    void refresh()
      .catch((refreshError) => setError(errorMessage(refreshError)))
      .finally(() => setLoading(false));
  }, [refresh]);

  return {
    status,
    devices,
    loading,
    busy,
    notice,
    error,
    /** True when this window's project is bound to a different (remote) machine. */
    isRemoteBound,
    /** Name of the machine this window is currently working on, when remote-bound. */
    boundMachineName,
    /** Display name of this physical Mac (from the local snapshot). */
    localMachineName,
    /** Whether device/pairing mutations are known to land on this computer. */
    canManageDevices: status !== null && !isRemoteBound,
    setPinValue,
    generatePin,
    clearPin,
    saveRuntimeName,
    forgetDevice,
    retryInitialLoad,
  };
}
