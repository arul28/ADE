/**
 * "Restart ADE": the rung of every recovery ladder between Fix it and Reset
 * ADE. It quits and reopens the app through the main process (after the usual
 * quit warnings), so nobody is told to "quit and reopen ADE" by hand.
 *
 * The restart itself ends this renderer, so the only way a recovery surface
 * can know it already climbed this rung is a stamp that survives the relaunch.
 * A fix that fails again after a recent restart goes straight to Reset ADE.
 */
import { isWebClientMode } from "../../lib/webClientMode";

const RESTART_STAMP_KEY = "ade.recovery.restartRequestedAt";
/** How long a restart counts as "already tried" for the next failure. */
const RESTART_RECENT_MS = 30 * 60_000;

export function canRestartAde(): boolean {
  // The hosted web client has the bridge method but cannot relaunch anything.
  return typeof window !== "undefined"
    && !isWebClientMode()
    && typeof window.ade?.updateRelaunchApp === "function";
}

/** Resolves false when this build or window cannot relaunch itself. */
export async function restartAde(): Promise<boolean> {
  if (!canRestartAde()) return false;
  let previous: string | null = null;
  try {
    previous = window.localStorage.getItem(RESTART_STAMP_KEY);
    window.localStorage.setItem(RESTART_STAMP_KEY, String(Date.now()));
  } catch {
    // Without the stamp the next failure offers Restart again; harmless.
  }
  let restarting = false;
  try {
    restarting = await window.ade.updateRelaunchApp();
  } catch {
    restarting = false;
  }
  // Written first because an accepted restart can end this renderer before
  // the reply lands. A refused one puts back what was there, rather than
  // clearing it: another window's restart may be the one in progress.
  if (!restarting) {
    try {
      if (previous == null) window.localStorage.removeItem(RESTART_STAMP_KEY);
      else window.localStorage.setItem(RESTART_STAMP_KEY, previous);
    } catch {
      // Nothing to put back.
    }
  }
  return restarting;
}

export function restartedAdeRecently(now: number = Date.now()): boolean {
  try {
    const at = Number(window.localStorage.getItem(RESTART_STAMP_KEY));
    return Number.isFinite(at) && at > 0 && now >= at && now - at < RESTART_RECENT_MS;
  } catch {
    return false;
  }
}

/** Called once a recovery succeeds, so the next problem starts at Fix it. */
export function clearRestartStamp(): void {
  try {
    window.localStorage.removeItem(RESTART_STAMP_KEY);
  } catch {
    // Nothing to clear.
  }
}
