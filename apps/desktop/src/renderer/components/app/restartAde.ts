/**
 * "Restart ADE": the rung of every recovery ladder between Fix it and Reset
 * ADE. It quits and reopens the app through the main process (after the usual
 * quit warnings), so nobody is told to "quit and reopen ADE" by hand.
 *
 * The restart itself ends this renderer, so the only way a recovery surface
 * can know it already climbed this rung is a stamp that survives the relaunch.
 * A fix that fails again after a recent restart goes straight to Reset ADE.
 */
const RESTART_STAMP_KEY = "ade.recovery.restartRequestedAt";
/** How long a restart counts as "already tried" for the next failure. */
const RESTART_RECENT_MS = 30 * 60_000;

export function canRestartAde(): boolean {
  return typeof window !== "undefined" && typeof window.ade?.updateRelaunchApp === "function";
}

/** Resolves false when this build or window cannot relaunch itself. */
export async function restartAde(): Promise<boolean> {
  if (!canRestartAde()) return false;
  try {
    window.localStorage.setItem(RESTART_STAMP_KEY, String(Date.now()));
  } catch {
    // Without the stamp the next failure offers Restart again; harmless.
  }
  try {
    return await window.ade.updateRelaunchApp();
  } catch {
    return false;
  }
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
