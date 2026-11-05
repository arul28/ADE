import { useCallback, type MutableRefObject } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { showToast } from "../app/toast/toastStore";
import { describeAndroidError, type AndroidErrorDescription } from "./androidDeviceState";

/**
 * The picker's Storage section: every AVD with its size on disk, Clean up and
 * one delete, on the lane's machine. Each change reads the inventory again.
 */
export function useAndroidStorageActions({
  api,
  laneId,
  runtimePinRef,
  readInventory,
  onError,
}: {
  api: Window["ade"]["androidEmulator"] | null;
  laneId: string;
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  readInventory: () => Promise<void>;
  onError: (error: AndroidErrorDescription) => void;
}) {
  /** Storage: every AVD with its size on disk, on the lane's machine. */
  const readSizes = useCallback(async () => {
    if (!api) return [];
    const measured = await api.listDevices({ laneId, measureSizes: true }, runtimePinRef.current);
    return measured.avds;
  }, [api, laneId, runtimePinRef]);

  /** Storage › Clean up: one delete at a time (each takes the AVD's lock), one toast. */
  const cleanUp = useCallback((names: string[]) => {
    if (!api || names.length === 0) return;
    const pin = runtimePinRef.current;
    void (async () => {
      let deleted = 0;
      for (const name of names) {
        try {
          const result = await api.deleteDevice({ avdName: name }, pin);
          if (result.deleted) deleted += 1;
        } catch (caught: unknown) {
          onError(describeAndroidError(caught));
        }
      }
      if (deleted > 0) showToast({ id: "android-avd-cleanup", tone: "success", title: `Deleted ${deleted} device${deleted === 1 ? "" : "s"}` });
      void readInventory();
    })();
  }, [api, onError, readInventory, runtimePinRef]);

  const deleteAvd = useCallback((name: string) => {
    if (!api) return;
    void api.deleteDevice({ avdName: name }, runtimePinRef.current)
      .then((result) => {
        if (result.deleted) showToast({ id: "android-avd-delete", tone: "success", title: `Deleted ${name}` });
      })
      .catch((caught: unknown) => onError(describeAndroidError(caught)))
      .finally(() => void readInventory());
  }, [api, onError, readInventory, runtimePinRef]);

  return { readSizes, cleanUp, deleteAvd };
}
