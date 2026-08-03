/**
 * Which window is allowed to dictate a shared PTY's size.
 *
 * A PTY has exactly one width, but it can have several viewers: the desktop app
 * and the hosted web client routinely mirror the SAME session, and both run
 * `TerminalView`, so both fit to their own element and push their own dims. The
 * host applies whichever arrived last (ptyService `resize` for the desktop,
 * `resizeBySessionId({ source: "mobile" })` for everything arriving over sync)
 * with no arbitration while both are attached — so the CLI wraps its output at
 * one viewer's width while the other renders it at a different width, and the
 * mismatch is visible as jumbled/staircased text in whichever viewer lost.
 *
 * Focus is the tiebreak: the window a human is actually typing into owns the
 * size, and a background mirror renders what it is given rather than fighting
 * for it. Regaining focus re-pushes immediately — the `focus` listener refits
 * with force — so ownership follows the user with no extra plumbing.
 *
 * This does NOT make two foreground viewers agree; that needs host arbitration.
 */

const OWNERSHIP_IDLE_MS = 60_000;

/**
 * Seeded at module load so a FRESHLY OPENED viewer owns the size straight away:
 * a window the user just opened is one they are about to use, and it should not
 * have to wait behind a long-running background mirror. Also what keeps this
 * transparent under jsdom, which reports `hasFocus()` false and dispatches no
 * interaction events.
 */
let lastLocalInteractionAtMs = Date.now();
let listenersInstalled = false;

/**
 * Starts tracking local interaction. Idempotent, and called from the mount
 * effect rather than at import time: a module that attaches document listeners
 * as a side effect of being imported is a module no test can load without
 * inheriting them.
 */
export function installPtySizeOwnershipTracking(): void {
  if (listenersInstalled) return;
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
  listenersInstalled = true;
  const noteInteraction = () => {
    lastLocalInteractionAtMs = Date.now();
  };
  document.addEventListener("pointerdown", noteInteraction, { capture: true, passive: true });
  document.addEventListener("keydown", noteInteraction, { capture: true, passive: true });
  window.addEventListener?.("focus", noteInteraction);
}

/** Whether this window is allowed to dictate the PTY's size right now. */
export function windowOwnsPtySize(): boolean {
  if (typeof document === "undefined") return true;
  // A hidden viewer is never the owner, whatever else is true of it.
  if (document.visibilityState === "hidden") return false;
  if (typeof document.hasFocus === "function" && document.hasFocus()) return true;
  // Focus alone is too strict to be the whole rule: with DevTools focused, or
  // in a tab the user is reading without having clicked, `hasFocus()` is false
  // while the user is plainly working in that window. Recent interaction covers
  // those, and it degrades the right way — a viewer nobody has touched in
  // OWNERSHIP_IDLE_MS yields to one they have.
  return Date.now() - lastLocalInteractionAtMs < OWNERSHIP_IDLE_MS;
}
