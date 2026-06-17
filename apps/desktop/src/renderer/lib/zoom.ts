/**
 * Shared zoom-level utilities used by AppShell and TopBar.
 *
 * Electron zoom level is log-based: level 0 = 100%, each +/-1 ~= +/-20%.
 * Formula: factor = 1.2^level, so level = log(factor) / log(1.2).
 * We add a +10% offset so the displayed "100%" actually renders at 110%.
 */

import { isMac } from "./platform";

export const ZOOM_LEVEL_KEY = "ade:zoom-level";
export const MIN_ZOOM_LEVEL = 70;
export const MAX_ZOOM_LEVEL = 150;
export const ZOOM_OFFSET = 10;
export const DEFAULT_ZOOM = 100;
/** Display-percentage step for one zoom-in/zoom-out increment. */
export const ZOOM_STEP = 10;
const LEGACY_DEFAULT_ZOOM = 110;

/** Clamp and normalize a raw zoom-level value. */
export function normalizeZoomLevel(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_ZOOM;
  if (raw === LEGACY_DEFAULT_ZOOM) return DEFAULT_ZOOM;
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, Math.trunc(raw)));
}

/** Convert a display percentage (70-150) to an Electron zoom level. */
export function displayZoomToLevel(displayZoom: number): number {
  return Math.log((Math.trunc(displayZoom) + ZOOM_OFFSET) / 100) / Math.log(1.2);
}

/** Read the persisted zoom level from localStorage, applying migration. */
export function getStoredZoomLevel(): number {
  try {
    const raw = parseInt(localStorage.getItem(ZOOM_LEVEL_KEY) || `${DEFAULT_ZOOM}`, 10);
    const normalized = normalizeZoomLevel(raw);
    const rawValue = Number.isFinite(raw) ? raw : DEFAULT_ZOOM;
    if (rawValue !== normalized) {
      localStorage.setItem(ZOOM_LEVEL_KEY, String(normalized));
    }
    return normalized;
  } catch {
    return DEFAULT_ZOOM;
  }
}

/**
 * Effective render factor for a display percentage. Because of the +10% offset,
 * a displayed 100% renders at factor 1.1, 70% at 0.8, 150% at 1.6, etc.
 */
export function zoomFactorForDisplay(displayZoom: number): number {
  return (Math.trunc(displayZoom) + ZOOM_OFFSET) / 100;
}

/**
 * Physical clearance (in DIP) reserved at the start of the title bar for the
 * native macOS traffic lights. Matches the legacy 80px CSS value at the default
 * zoom (80px × factor 1.1 ≈ 88 DIP).
 */
export const SHELL_HEADER_TRAFFIC_LIGHT_DIP = 88;

/**
 * CSS px to reserve at the start of the title bar so the macOS traffic lights
 * clear the ADE logo at the given display zoom.
 *
 * Electron's `webFrame` zoom scales the whole renderer, but the native traffic
 * lights are drawn by the OS at a fixed screen position and do NOT scale. A
 * static CSS reservation therefore shrinks on screen as the page zooms out,
 * letting the logo slide under the lights. Dividing the fixed DIP clearance by
 * the live zoom factor keeps the on-screen reservation constant at every level.
 */
export function shellHeaderInsetPx(displayZoom: number): number {
  const factor = zoomFactorForDisplay(displayZoom);
  if (!Number.isFinite(factor) || factor <= 0) {
    return SHELL_HEADER_TRAFFIC_LIGHT_DIP;
  }
  return Math.round(SHELL_HEADER_TRAFFIC_LIGHT_DIP / factor);
}

/**
 * Sync the title bar's start padding to the current zoom so the macOS traffic
 * lights never overlap the logo. No-op off macOS (no native traffic lights) and
 * outside a DOM; there the static `--shell-header-padding-start` default stands.
 */
export function applyShellHeaderInset(displayZoom: number): void {
  if (!isMac) return;
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(
    "--shell-header-padding-start",
    `${shellHeaderInsetPx(displayZoom)}px`,
  );
}
