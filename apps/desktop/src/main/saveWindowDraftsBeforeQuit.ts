import type { BrowserWindow } from "electron";
import { APP_WILL_QUIT_EVENT } from "../shared/appWillQuit";

/** How long a quit waits for the windows to save their drafts before teardown. */
const WINDOW_DRAFTS_SAVE_LIMIT_MS = 500;

type QuitLog = (event: string, meta: Record<string, unknown>) => void;

/**
 * Every window saves what it still holds in a short save delay (a chat box or
 * CLI box draft) before teardown destroys it; a destroyed window runs no page
 * lifecycle event. `executeJavaScript` resolves after the event's listeners
 * have run. A window that does not answer costs at most
 * WINDOW_DRAFTS_SAVE_LIMIT_MS, so a wedged renderer never holds the quit.
 */
export async function saveWindowDraftsBeforeQuit(windows: readonly BrowserWindow[], warn: QuitLog): Promise<void> {
  const script = `window.dispatchEvent(new Event(${JSON.stringify(APP_WILL_QUIT_EVENT)}))`;
  const saves = windows
    .filter((win) => !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isCrashed())
    .map((win) => win.webContents.executeJavaScript(script).then(
      () => undefined,
      (error: unknown) => {
        warn("desktop.quit_window_drafts_failed", { errorText: error instanceof Error ? error.message : String(error) });
      },
    ));
  if (saves.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finished = await Promise.race([
    Promise.all(saves).then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), WINDOW_DRAFTS_SAVE_LIMIT_MS);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!finished) {
    warn("desktop.quit_window_drafts_timeout", { windows: saves.length, limitMs: WINDOW_DRAFTS_SAVE_LIMIT_MS });
  }
}
