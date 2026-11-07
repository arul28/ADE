import { useCallback, useEffect, useState, type MutableRefObject } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AndroidEmulatorPreloadApi } from "../../../shared/types/androidEmulator";
import type { DeviceOrientation } from "../../../shared/types/deviceOrientation";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { describeAndroidError } from "./androidDeviceState";

/**
 * Which way up the Android pane's device is.
 *
 * The brain reads it from the display (the home screen of a phone stays
 * portrait, so the video's shape cannot say). The pane reads it after the
 * device changes and whenever the video changes shape. A rotate from any
 * caller pushes `android.device.orientation`; the pane's one event listener
 * gives that to `setOrientation`. A failed rotate goes back to the old value.
 */
export function useAndroidOrientation({
  api,
  laneId,
  avdName,
  pinKey,
  runtimePinRef,
  streamShape,
  onRotateError,
}: {
  api: AndroidEmulatorPreloadApi | null;
  laneId: string;
  avdName: string | null;
  pinKey: string | null;
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  /** `WxH` of the video, or null before the first frame. */
  streamShape: string | null;
  onRotateError: (caught: unknown) => void;
}): {
  /** Null until read. */
  orientation: DeviceOrientation | null;
  setOrientation: (orientation: DeviceOrientation) => void;
  rotate: (next: DeviceOrientation) => void;
} {
  const [orientation, setOrientation] = useState<DeviceOrientation | null>(null);

  useEffect(() => {
    setOrientation(null);
  }, [laneId, pinKey, avdName]);

  useEffect(() => {
    if (!api?.getDeviceSettings || !streamShape) return undefined;
    let cancelled = false;
    void api.getDeviceSettings({ laneId, fields: "orientation" }, runtimePinRef.current)
      .then((settings) => {
        if (!cancelled && settings.orientation) setOrientation(settings.orientation);
      })
      .catch((caught: unknown) => {
        // The rail keeps the last orientation it knew; the next shape change reads again.
        logRendererDebugEvent("android.orientation_read_failed", { error: describeAndroidError(caught).sentence });
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the machine, not the pin object (CLAUDE.md "key effects on pin?.key").
  }, [api, laneId, pinKey, runtimePinRef, streamShape]);

  const rotate = useCallback((next: DeviceOrientation) => {
    if (!api) return;
    const before = orientation;
    setOrientation(next);
    // The new size reaches the view with the stream's next config record (~1 s).
    void api.rotate({ laneId, orientation: next }, runtimePinRef.current).catch((caught: unknown) => {
      setOrientation(before);
      onRotateError(caught);
    });
  }, [api, laneId, onRotateError, orientation, runtimePinRef]);

  return { orientation, setOrientation, rotate };
}
