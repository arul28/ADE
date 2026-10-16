/**
 * A boolean toolbar/view preference remembered in `localStorage`.
 *
 * Diff surfaces each keep a per-view toggle (ignore whitespace, the file tree);
 * this is the one place that reads and writes them, so a blocked storage write
 * (private mode, quota) never fails the toggle and the `"1"`/`"0"` encoding
 * cannot drift between callers.
 */
export function readPersistedFlag(prefix: string, key: string | undefined): boolean {
  if (!key || typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(`${prefix}${key}`) === "1";
  } catch {
    return false;
  }
}

export function writePersistedFlag(prefix: string, key: string | undefined, value: boolean): void {
  if (!key || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${prefix}${key}`, value ? "1" : "0");
  } catch {
    // A blocked storage write is not worth failing the toggle over.
  }
}
