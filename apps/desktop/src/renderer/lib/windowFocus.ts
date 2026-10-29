import { useSyncExternalStore } from "react";
import { isAdeAvailable } from "./adeAvailability";

/**
 * Whether the ADE window is the focused app.
 *
 * The desktop reports the OS window's focus: the page's own `blur` also fires
 * when the built-in browser pane (its own web view) takes focus, while ADE is
 * still in front. The web client, which has no such event, reads the page's
 * focus. One subscription lives as long as the page, so the value never goes
 * stale between the moments something reads it.
 */
let windowFocused = typeof document === "undefined" ? true : document.hasFocus();
const listeners = new Set<() => void>();
let started = false;

function setWindowFocused(next: boolean): void {
  if (next === windowFocused) return;
  windowFocused = next;
  for (const listener of listeners) listener();
}

function start(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  // The page taking focus means the window has it, on every host.
  window.addEventListener("focus", () => setWindowFocused(true));
  const onWindowFocusChanged = window.ade?.app?.onWindowFocusChanged;
  if (isAdeAvailable(onWindowFocusChanged)) {
    onWindowFocusChanged(setWindowFocused);
    return;
  }
  window.addEventListener("blur", () => setWindowFocused(false));
}

// Listen from the first import, so the desktop's post-load focus report is not
// missed by a chat that mounts later.
start();

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function read(): boolean {
  return windowFocused;
}

export function useWindowFocused(): boolean {
  return useSyncExternalStore(subscribe, read, () => true);
}
