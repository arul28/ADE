import { useSyncExternalStore } from "react";

/**
 * Whether this window has focus and is not hidden. Decoration that loops (a
 * drifting glow, a looping screen recording) holds still while it is false:
 * each frame it draws costs the GPU, and with a blurred dialog scrim on screen
 * macOS redraws the whole window for it.
 */
function read(): boolean {
  return document.visibilityState !== "hidden" && document.hasFocus();
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

export function useWindowInFront(): boolean {
  return useSyncExternalStore(subscribe, read, () => true);
}
