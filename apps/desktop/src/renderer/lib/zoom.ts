/**
 * Shared zoom-level utilities used by AppShell and TopBar.
 *
 * Electron zoom level is log-based: level 0 = 100%, each +/-1 ~= +/-20%.
 * Formula: factor = 1.2^level, so level = log(factor) / log(1.2).
 * We add a +10% offset so the displayed "100%" actually renders at 110%.
 */

export const ZOOM_LEVEL_KEY = "ade:zoom-level";
export const MIN_ZOOM_LEVEL = 70;
export const MAX_ZOOM_LEVEL = 150;
export const ZOOM_OFFSET = 10;
export const DEFAULT_ZOOM = 100;
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
