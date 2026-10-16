/**
 * Whether the window a renderer load was issued against is still there to load
 * into.
 *
 * `loadURL` rejects for any main-frame load that does not finish, and one of
 * the ways it does not finish is that the window went away underneath it: the
 * app is quitting, or the user closed the window while the renderer was still
 * coming up. Chromium words that, and a real failure, the same way —
 * `ERR_FAILED (-2) loading '<url>'` (a missing asset is
 * `ERR_FILE_NOT_FOUND (-6)`), so the message cannot tell them apart and the
 * window's own liveness has to.
 *
 * The two checks cannot be reordered. Electron 41.5.0 keeps `id` and
 * `isDestroyed()` on a destroyed `BrowserWindow` but throws `Object has been
 * destroyed` for `webContents`; and a quit that closes a window out from under
 * an in-flight load leaves `isDestroyed()` false while
 * `webContents.isDestroyed()` is already true, so `webContents` alone is not
 * enough either.
 */
export function isWindowLoadTargetGone(win: {
  isDestroyed: () => boolean;
  webContents: { isDestroyed: () => boolean };
}): boolean {
  return win.isDestroyed() || win.webContents.isDestroyed();
}
