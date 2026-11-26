import { useSyncExternalStore } from "react";

/**
 * The theme a swatch is pointing at in Appearance, for the preview to paint.
 *
 * Kept outside React state so a hover re-renders only the preview, not the
 * whole Appearance page. Leaving a swatch clears it after a short delay, so
 * moving from one swatch to the next does not flash the active theme between.
 */

const CLEAR_DELAY_MS = 120;

let hoveredThemeId: string | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(next: string | null): void {
  if (next === hoveredThemeId) return;
  hoveredThemeId = next;
  for (const listener of listeners) listener();
}

/** A swatch is hovered or focused. */
export function previewThemeOnHover(themeId: string): void {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  emit(themeId);
}

/** The pointer or focus left a swatch. */
export function endThemeHoverPreview(): void {
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    clearTimer = null;
    emit(null);
  }, CLEAR_DELAY_MS);
}

/** A swatch was chosen: the preview is now the real theme. */
export function clearThemeHoverPreview(): void {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  emit(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function snapshot(): string | null {
  return hoveredThemeId;
}

export function useHoveredThemeId(): string | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Props for an element that previews `themeId` while pointed at or focused. */
export function themeHoverPreviewProps(themeId: string) {
  return {
    onPointerEnter: () => previewThemeOnHover(themeId),
    onPointerLeave: endThemeHoverPreview,
    onFocus: () => previewThemeOnHover(themeId),
    onBlur: endThemeHoverPreview,
  };
}
