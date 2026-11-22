/**
 * The DOM event main dispatches in every ADE window when a quit begins.
 *
 * Teardown ends with `BrowserWindow.destroy()`, which runs no page lifecycle
 * event (`pagehide`, `beforeunload`), so an edit a window still holds in a
 * short save delay (a chat box or CLI box draft) was lost on Quit. Main runs
 * the dispatch through `executeJavaScript`, which resolves after every
 * listener has run, so a listener that saves synchronously is done before
 * teardown starts.
 */
export const APP_WILL_QUIT_EVENT = "ade:app-will-quit";
