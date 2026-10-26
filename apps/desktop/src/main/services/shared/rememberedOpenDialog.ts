import path from "node:path";
import { app, dialog, type BrowserWindow, type OpenDialogOptions, type OpenDialogReturnValue } from "electron";

/** The folder the last open dialog ended in, for the next one that names none. */
let lastFolder: string | null = null;

/**
 * `dialog.showOpenDialog` that starts where the previous pick was made.
 *
 * Since Electron 43 a dialog with no `defaultPath` opens in Downloads every
 * time instead of the folder the OS remembered. A picker the caller gives no
 * folder now starts in the folder that held the last pick, as the OS panel
 * did: a picked file's folder, a picked folder's parent (home before the
 * first pick). A caller's own `defaultPath` always wins.
 */
export async function showRememberedOpenDialog(
  win: BrowserWindow | null | undefined,
  options: OpenDialogOptions,
): Promise<OpenDialogReturnValue> {
  const withFolder: OpenDialogOptions = options.defaultPath
    ? options
    : { ...options, defaultPath: lastFolder ?? app.getPath("home") };
  const result = win ? await dialog.showOpenDialog(win, withFolder) : await dialog.showOpenDialog(withFolder);
  const picked = result.canceled ? undefined : result.filePaths[0];
  if (picked) lastFolder = path.dirname(picked);
  return result;
}
