import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AndroidLaneDeviceStatus } from "../../../shared/types/androidEmulator";
import { describeAndroidError, type AndroidErrorDescription } from "./androidDeviceState";

/**
 * The lane's extra devices in the pane: start, stop and remove one, the card
 * that shows a call in flight, and which device the last refused start was
 * for, so "Start anyway" and "Restart adb and start" start that same device
 * again. Every call goes to the lane's machine (`pinRef.current`).
 */
export function useAndroidExtraDevices({
  api,
  laneId,
  pinRef,
  pinKey,
  readStatus,
  readInventory,
  pickerShownRef,
  onError,
}: {
  api: Window["ade"]["androidEmulator"] | null;
  laneId: string;
  pinRef: MutableRefObject<OpenProjectBinding | null>;
  /** The pin's key: a new lane or machine forgets the call in flight. */
  pinKey: string | null;
  readStatus: () => Promise<void>;
  readInventory: () => Promise<void>;
  /** The picker is on screen: a call reads the device list again after it. */
  pickerShownRef: MutableRefObject<boolean>;
  onError: (error: AndroidErrorDescription | null) => void;
}) {
  /** The extra device a start, stop or remove is in flight for. */
  const [pendingExtra, setPendingExtra] = useState<string | null>(null);
  /** The extra whose last start was refused (the memory guard, adb); null when it was the lane's device. */
  const refusedExtraRef = useRef<string | null>(null);
  /** The lane and machine a call was made for: an answer for another one changes nothing on screen. */
  const scope = `${laneId}\u0000${pinKey ?? ""}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  // A new lane or machine: the old call's card and refusal are not this one's.
  useEffect(() => {
    setPendingExtra(null);
    refusedExtraRef.current = null;
  }, [laneId, pinKey]);

  /**
   * One call on one of the lane's extra devices: a spinner on its card while
   * it runs, the pane's error line when it fails, a re-read after. The lane's
   * device and its stream are left as they are.
   */
  const runExtra = useCallback(async (avdName: string, call: () => Promise<unknown>): Promise<void> => {
    const calledFor = scopeRef.current;
    setPendingExtra(avdName);
    onError(null);
    refusedExtraRef.current = null;
    try {
      await call();
    } catch (caught: unknown) {
      if (scopeRef.current !== calledFor) return;
      refusedExtraRef.current = avdName;
      onError(describeAndroidError(caught));
    } finally {
      if (scopeRef.current === calledFor) setPendingExtra(null);
      void readStatus();
      if (pickerShownRef.current) void readInventory();
    }
  }, [onError, pickerShownRef, readInventory, readStatus]);

  /** Boots an extra; `force` past the memory guard, `restartAdb` after the person agreed to restart adb. */
  const startExtra = useCallback((avdName: string, options: { force?: boolean; restartAdb?: boolean } = {}) => {
    if (!api) return;
    void runExtra(avdName, () => api.start({
      laneId,
      device: avdName,
      ...(options.force ? { force: true } : {}),
      ...(options.restartAdb ? { restartAdb: true } : {}),
    }, pinRef.current));
  }, [api, laneId, pinRef, runExtra]);

  const stopExtra = useCallback((avdName: string) => {
    if (!api) return;
    void runExtra(avdName, () => api.stop({ laneId, device: avdName }, pinRef.current));
  }, [api, laneId, pinRef, runExtra]);

  /** ADE made every extra for this lane, so removing one deletes it. */
  const removeExtra = useCallback((avdName: string) => {
    if (!api) return;
    void runExtra(avdName, () => api.releaseDevice({ laneId, device: avdName, deleteCreated: true }, pinRef.current));
  }, [api, laneId, pinRef, runExtra]);

  /**
   * Starts the device the last refused start was for again, with `options`:
   * true when that was an extra (started here), false when it was the lane's
   * own device (the caller starts it).
   */
  const startRefusedAgain = useCallback((options: { force?: boolean; restartAdb?: boolean }): boolean => {
    const extra = refusedExtraRef.current;
    if (!extra) return false;
    startExtra(extra, options);
    return true;
  }, [startExtra]);

  /** A start of the lane's own device began: a later refusal is that device's. */
  const forgetRefused = useCallback(() => {
    refusedExtraRef.current = null;
  }, []);

  /** The extra a card shows as busy: a call on it, or a promote of it in flight. */
  const pendingName = (promoting: string | null, lane: AndroidLaneDeviceStatus | null | undefined): string | null =>
    pendingExtra ?? (promoting && lane?.extras?.some((extra) => extra.device.avdName === promoting) ? promoting : null);

  return { pendingExtra, pendingName, startExtra, stopExtra, removeExtra, startRefusedAgain, forgetRefused };
}
