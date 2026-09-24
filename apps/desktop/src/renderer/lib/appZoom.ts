import { useSyncExternalStore } from "react";
import {
  DEFAULT_ZOOM,
  MAX_ZOOM_LEVEL,
  MIN_ZOOM_LEVEL,
  ZOOM_LEVEL_KEY,
  ZOOM_STEP,
  applyShellHeaderInset,
  displayZoomToLevel,
  getStoredZoomLevel,
} from "./zoom";
import { syncWindowsTitleBarOverlay } from "./windowControlsOverlay";

/**
 * The window zoom, shared by every control that changes it: the View menu and
 * its shortcuts (TopBar listens for those) and the zoom buttons in the
 * settings sidebar. One module-level value, so all of them show the same
 * number and back-to-back commands build on the last applied level.
 */

let currentZoom: number | null = null;
const listeners = new Set<() => void>();

export function getAppZoom(): number {
  if (currentZoom == null) currentZoom = getStoredZoomLevel();
  return currentZoom;
}

/** Apply a display percentage, clamped, and persist it. */
export function setAppZoom(displayZoom: number): void {
  const clamped = Math.max(MIN_ZOOM_LEVEL, Math.min(MAX_ZOOM_LEVEL, displayZoom));
  window.ade.zoom.setLevel(displayZoomToLevel(clamped));
  try {
    localStorage.setItem(ZOOM_LEVEL_KEY, String(clamped));
  } catch {
    // localStorage can be unavailable in hardened contexts.
  }
  applyShellHeaderInset(clamped);
  // Windows twin of the traffic-light inset: the native caption strip is
  // sized in DIP and does not follow renderer zoom on its own.
  syncWindowsTitleBarOverlay({ displayZoom: clamped });
  currentZoom = clamped;
  for (const listener of listeners) listener();
}

export function zoomAppIn(): void {
  setAppZoom(getAppZoom() + ZOOM_STEP);
}

export function zoomAppOut(): void {
  setAppZoom(getAppZoom() - ZOOM_STEP);
}

export function resetAppZoom(): void {
  setAppZoom(DEFAULT_ZOOM);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current display zoom, re-rendering when it changes. */
export function useAppZoom(): number {
  return useSyncExternalStore(subscribe, getAppZoom);
}

/** Tests only: forget the cached level so the next read comes from storage. */
export function resetAppZoomCacheForTests(): void {
  currentZoom = null;
}
