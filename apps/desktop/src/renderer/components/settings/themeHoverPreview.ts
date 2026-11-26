import { useSyncExternalStore } from "react";

/**
 * The theme a swatch is pointing at in Appearance, for the preview to paint.
 *
 * Kept outside React state so a hover re-renders only the preview, not the
 * whole Appearance page. The pointer and the keyboard focus are tracked apart:
 * the pointer wins while it is over a swatch, and focus keeps its preview when
 * the pointer moves away. Leaving a swatch clears after a short delay, so
 * moving from one swatch to the next does not flash the active theme between.
 */

const CLEAR_DELAY_MS = 120;

let pointerThemeId: string | null = null;
let focusThemeId: string | null = null;
let shownThemeId: string | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  const next = pointerThemeId ?? focusThemeId;
  if (next === shownThemeId) return;
  shownThemeId = next;
  for (const listener of listeners) listener();
}

function cancelClear(): void {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
}

function publishSoon(): void {
  cancelClear();
  clearTimer = setTimeout(() => {
    clearTimer = null;
    publish();
  }, CLEAR_DELAY_MS);
}

/** A swatch is hovered. */
export function previewThemeOnHover(themeId: string): void {
  cancelClear();
  pointerThemeId = themeId;
  publish();
}

/** A swatch has keyboard focus. */
export function previewThemeOnFocus(themeId: string): void {
  cancelClear();
  focusThemeId = themeId;
  publish();
}

/** The pointer left a swatch. */
export function endThemeHoverPreview(): void {
  pointerThemeId = null;
  publishSoon();
}

/** Focus left a swatch. */
export function endThemeFocusPreview(): void {
  focusThemeId = null;
  publishSoon();
}

/** A swatch was chosen: the preview is now the real theme. */
export function clearThemeHoverPreview(): void {
  cancelClear();
  pointerThemeId = null;
  focusThemeId = null;
  publish();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function snapshot(): string | null {
  return shownThemeId;
}

export function useHoveredThemeId(): string | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Props for an element that previews `themeId` while pointed at or focused. */
export function themeHoverPreviewProps(themeId: string) {
  return {
    onPointerEnter: () => previewThemeOnHover(themeId),
    onPointerLeave: endThemeHoverPreview,
    onFocus: () => previewThemeOnFocus(themeId),
    onBlur: endThemeFocusPreview,
  };
}
