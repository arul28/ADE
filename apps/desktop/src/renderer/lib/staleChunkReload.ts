/**
 * A deploy replaces the web client's hashed chunks. A tab opened before it
 * still asks for the old names, and the next lazy screen fails with "Failed to
 * fetch dynamically imported module" (ADE-WEB-5). Reloading picks up the new
 * build, so the client reloads once instead of showing the crash screen.
 *
 * Once per minute per tab (a sessionStorage stamp): a chunk that is missing
 * from the new build too must surface as the error it is, not loop reloads.
 * Web client only; the desktop loads its chunks from app.asar, which a running
 * app never swaps under itself.
 */

const RELOAD_STAMP_KEY = "ade:stale-chunk-reload-at";
const RELOAD_GUARD_MS = 60_000;

const CHUNK_LOAD_FAILURE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS for/i;

let reloading = false;

export function isChunkLoadFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return CHUNK_LOAD_FAILURE.test(message);
}

/** True while this page is reloading for a stale chunk; the failure it hit is not a bug. */
export function isStaleChunkReloadPending(): boolean {
  return reloading;
}

/**
 * Reload for a failed chunk when the guard allows. True when a reload is under
 * way (started now or earlier), so the caller can skip its crash report.
 */
export function reloadForStaleChunk(error: unknown): boolean {
  if (reloading) return true;
  if (!isChunkLoadFailure(error)) return false;
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_STAMP_KEY)) || 0;
    if (Date.now() - last < RELOAD_GUARD_MS) return false;
    window.sessionStorage.setItem(RELOAD_STAMP_KEY, String(Date.now()));
  } catch {
    // No storage means no loop guard; let the error show instead.
    return false;
  }
  reloading = true;
  window.location.reload();
  return true;
}

/**
 * Vite's dynamic-import helper raises `vite:preloadError` for a failed chunk
 * or preload. The event is not cancelled: the import still rejects, and the
 * error boundary skips its report while the reload is pending.
 */
export function installStaleChunkReload(): void {
  window.addEventListener("vite:preloadError", (event) => {
    reloadForStaleChunk((event as Event & { payload?: unknown }).payload);
  });
}
