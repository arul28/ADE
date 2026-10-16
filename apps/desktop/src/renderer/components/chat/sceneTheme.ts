import { useSyncExternalStore } from "react";

import { SCENE_FALLBACK_THEME, sceneThemeSignature, type SceneTheme } from "../../../shared/chatScene";

/**
 * ADE's resolved theme, as a scene frame needs it, kept current.
 *
 * The frame is another origin and cannot read ADE's stylesheet, so it is handed
 * resolved values. They used to be read once per mount, so a theme switch left
 * every open scene in the old palette and `color-scheme: dark` was hardcoded,
 * which made scrollbars and form controls wrong in every light theme.
 *
 * One observer on `<html>` for the whole app, not one per scene: a theme switch
 * restyles the document once, and every scene listening hears one change.
 */

function resolvedFontSize(probe: CSSStyleDeclaration): number {
  // Assistant prose renders at `--chat-font-size * 13 / 14` (MarkdownBlock).
  const chat = parseFloat(probe.getPropertyValue("--chat-font-size"));
  return Number.isFinite(chat) && chat > 0 ? Math.round((chat * 13) / 14 * 10) / 10 : SCENE_FALLBACK_THEME.fontSize;
}

export function readSceneTheme(): SceneTheme {
  if (typeof window === "undefined" || typeof document === "undefined") return SCENE_FALLBACK_THEME;
  try {
    const root = document.documentElement;
    const probe = window.getComputedStyle(root);
    const read = (name: string, fallback: string) => {
      const value = probe.getPropertyValue(name).trim();
      return value.length ? value : fallback;
    };
    const fg = read("--color-fg", SCENE_FALLBACK_THEME.fg);
    return {
      bg: read("--chat-canvas-bg", read("--color-bg", SCENE_FALLBACK_THEME.bg)),
      // Resolved against the resolved fg, so it means the same thing inside
      // the frame as it does here.
      surface: `color-mix(in srgb, ${fg} 4%, transparent)`,
      border: read("--color-border", SCENE_FALLBACK_THEME.border),
      fg,
      fgMuted: read("--color-muted-fg", SCENE_FALLBACK_THEME.fgMuted),
      accent: read("--color-accent", SCENE_FALLBACK_THEME.accent),
      success: read("--color-success", SCENE_FALLBACK_THEME.success),
      warning: read("--color-warning", SCENE_FALLBACK_THEME.warning),
      danger: read("--color-error", SCENE_FALLBACK_THEME.danger),
      fontSans: read("--font-sans", SCENE_FALLBACK_THEME.fontSans),
      fontMono: read("--font-mono", SCENE_FALLBACK_THEME.fontMono),
      scheme: root.getAttribute("data-theme") === "light" ? "light" : "dark",
      fontSize: resolvedFontSize(probe),
    };
  } catch {
    return SCENE_FALLBACK_THEME;
  }
}

let current: SceneTheme | null = null;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function refresh(): void {
  const next = readSceneTheme();
  if (current && sceneThemeSignature(current) === sceneThemeSignature(next)) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!observer && typeof MutationObserver === "function" && typeof document !== "undefined") {
    // Theme, radius, font and size preferences all land as attributes or
    // inline custom properties on <html>.
    observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && observer) {
      observer.disconnect();
      observer = null;
      // Re-read on the next subscribe: nothing kept it current meanwhile.
      current = null;
    }
  };
}

function getSnapshot(): SceneTheme {
  if (!current) current = readSceneTheme();
  return current;
}

/** The current scene theme; re-renders the caller when ADE's theme changes. */
export function useSceneTheme(): SceneTheme {
  return useSyncExternalStore(subscribe, getSnapshot, () => SCENE_FALLBACK_THEME);
}
