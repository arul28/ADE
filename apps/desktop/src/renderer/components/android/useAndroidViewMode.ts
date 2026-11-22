import { useCallback, useEffect, useState } from "react";
import type { Device3DFailure } from "../device/Device3DView";
import { readAndroidViewMode, writeAndroidViewMode, type AndroidViewMode } from "./androidDeviceState";

/**
 * The Android pane's view mode (3D or flat), as on the Apple pane: saved per
 * project, and flat while the 3D view cannot draw here (Apple §A1). `retry3D`
 * asks the 3D view to try again with a fresh mount (`viewNonce`).
 */
export function useAndroidViewMode(projectRoot: string | null) {
  const [viewMode, setViewModeState] = useState<AndroidViewMode>(() => readAndroidViewMode(projectRoot));
  const [threeFailure, setThreeFailure] = useState<Device3DFailure | null>(null);
  const [viewNonce, setViewNonce] = useState(0);
  useEffect(() => {
    setViewModeState(readAndroidViewMode(projectRoot));
    setThreeFailure(null);
  }, [projectRoot]);
  const setViewMode = useCallback((next: AndroidViewMode) => {
    setViewModeState(next);
    if (next === "3d") setThreeFailure(null);
    writeAndroidViewMode(projectRoot, next);
  }, [projectRoot]);
  /** The 3D view cannot draw here: fall back to flat and say so once. */
  const handleThreeUnavailable = useCallback((reason: Device3DFailure) => {
    setThreeFailure(reason);
    setViewModeState("flat");
  }, []);
  const retry3D = useCallback(() => {
    setViewMode("3d");
    setViewNonce((nonce) => nonce + 1);
  }, [setViewMode]);
  const dismiss3DFailure = useCallback(() => setThreeFailure(null), []);
  /** A fresh mount of the 3D view: the camera goes back to its start. */
  const resetView = useCallback(() => setViewNonce((nonce) => nonce + 1), []);
  return {
    threeD: viewMode === "3d" && threeFailure === null,
    threeFailure,
    viewNonce,
    setViewMode,
    handleThreeUnavailable,
    retry3D,
    dismiss3DFailure,
    resetView,
  };
}
