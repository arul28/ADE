/**
 * A repaint signal for colour consumers that read CSS through JavaScript.
 *
 * Nearly every surface in ADE names its colours in CSS, so a plugin theme swap
 * — which is one `<style>` element being rewritten, see `pluginTheme.ts` —
 * repaints them for free: the cascade re-resolves, the browser paints, nothing
 * in React has to know. A handful of surfaces cannot work that way. xterm wants
 * a JavaScript object of literal colour strings; the activity heatmap builds
 * inline `style` objects; a chart hands colours to SVG presentation attributes,
 * which do not resolve `var()` at all. Those readers call `getComputedStyle`
 * once, keep the answer, and have no way to learn that the answer changed.
 *
 * `PLUGIN_THEME_CHANGED_EVENT` is that missing edge. This module turns it into
 * a number that only ever goes up, so a component can list it in a `useMemo`
 * dependency array beside `theme` and re-read its colours on either change.
 *
 * The counter is module-level rather than per-component so every consumer sees
 * the same revision, and the `window` listener is installed once and shared by
 * all subscribers — a heatmap with 365 cells and a dozen terminals must not
 * mean a dozen listeners.
 */

import { useSyncExternalStore } from "react";

import { PLUGIN_THEME_CHANGED_EVENT } from "./pluginTheme";

let revision = 0;

const subscribers = new Set<() => void>();

let listening = false;

function handlePluginThemeChanged(): void {
  revision += 1;
  for (const notify of [...subscribers]) notify();
}

function subscribe(onStoreChange: () => void): () => void {
  subscribers.add(onStoreChange);
  // Guarded rather than assumed: this module is imported by node-environment
  // tests and by any non-DOM render path, where `window` does not exist.
  if (!listening && typeof window !== "undefined") {
    window.addEventListener(PLUGIN_THEME_CHANGED_EVENT, handlePluginThemeChanged);
    listening = true;
  }
  return () => {
    subscribers.delete(onStoreChange);
    if (subscribers.size === 0 && listening && typeof window !== "undefined") {
      window.removeEventListener(PLUGIN_THEME_CHANGED_EVENT, handlePluginThemeChanged);
      listening = false;
    }
  };
}

function getSnapshot(): number {
  return revision;
}

/** The current revision without subscribing. Exported for non-React readers. */
export function getPluginThemeRevision(): number {
  return revision;
}

/**
 * Returns a number that increments every time the injected plugin-theme
 * stylesheet changes. The value itself means nothing; only its identity does.
 *
 * Use it as a `useMemo`/`useEffect` dependency next to the app theme:
 *
 * ```ts
 * const revision = usePluginThemeRevision();
 * const colors = useMemo(() => buildColors(), [theme, revision]);
 * ```
 */
export function usePluginThemeRevision(): number {
  // Server snapshot is the same counter: there is no server render in this app,
  // but `useSyncExternalStore` requires the third argument for any code path
  // that hydrates, and a diverging constant would be a silent mismatch.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Reads a CSS custom property off the document element.
 *
 * `getComputedStyle` returns `""` for a property that is not declared — and for
 * any property at all when the document has no view — so the fallback is what
 * keeps a JS colour reader working in a test environment, before the stylesheet
 * has loaded, and on a theme that simply does not set the token.
 */
export function readThemeColor(name: string, fallback: string): string {
  if (typeof document === "undefined" || !document.documentElement) return fallback;
  let raw = "";
  try {
    raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  } catch {
    // jsdom and hardened environments can throw rather than return "".
    return fallback;
  }
  const value = raw.trim();
  return value.length > 0 ? value : fallback;
}
