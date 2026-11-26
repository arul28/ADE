/**
 * Where a window keeps its strip of project tabs across a reload
 * (`useRepositoryTabs.ts`): sessionStorage, one window until it closes.
 */
export const WINDOW_STRIP_STORAGE_KEY = "ade.projectTabs.windowStrip.v1";
const WINDOW_STRIP_OWNER_STORAGE_KEY = "ade.projectTabs.windowStrip.owner.v1";

/**
 * ADE Web: a browser tab's strip belongs to the account signed in when it was
 * kept. A sign-out and a sign-in as another account in the same tab keep
 * sessionStorage, so the strip of another account (or of an older build,
 * which named none) is dropped before the app restores it. Called once the
 * signed-in account is known.
 */
export function claimWindowStripForAccount(userId: string): void {
  try {
    const storage = window.sessionStorage;
    if (storage.getItem(WINDOW_STRIP_OWNER_STORAGE_KEY) !== userId) storage.removeItem(WINDOW_STRIP_STORAGE_KEY);
    storage.setItem(WINDOW_STRIP_OWNER_STORAGE_KEY, userId);
  } catch {
    // Storage unavailable: no strip was kept.
  }
}
