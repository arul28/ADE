import type { PluginWebviewDialogSubmit } from "../../../../shared/plugins/webviewBridge";

/**
 * Where a `dialog.submit` from a `dialog-picker` guest lands.
 *
 * The sibling of `./dialogTarget`, and deliberately a second module rather than
 * a second verb on that one. `dialogTarget` answers "a plugin ACTION returned
 * `{dialog:{setField}}` — which dialog is on screen?", and its answer is the
 * most recently registered dialog of that KIND, because an action carries a
 * context that names a kind and nothing narrower. This one answers a different
 * question with a much sharper key: a page inside a dialog said "here is the
 * issue", and the guest it said it from is known exactly — main derived the
 * `guestKey` from the `webContents` that called, and no page can forge it.
 *
 * So the registration is per GUEST. Two Create-lane dialogs cannot be open at
 * once today, but a settings-section page and a dialog picker CAN be, and a
 * store keyed on "the newest dialog" would hand one page's answer to a form the
 * other page is sitting in. The key removes the question.
 *
 * ## Nothing is dropped
 *
 * {@link submitPluginWebviewDialogAnswer} answers every call: the handler's own
 * verdict, or a refusal sentence when no dialog is listening on that guest. On
 * the other end is a page holding a promise, and the relay's one rule is that
 * every request is answered exactly once — see `pluginWebviewRelay.ts`.
 */

/**
 * What a dialog does with a page's answer.
 *
 * Returns whether the answer landed. `false` is the honest report of a form
 * that cannot take it right now — mid-submit, or a value the dialog's own
 * validation refused — and the page hears it as a rejected promise rather than
 * a silent success it would draw as "selected".
 */
export type PluginWebviewDialogHandler = (answer: PluginWebviewDialogSubmit) => boolean;

const handlers = new Map<string, PluginWebviewDialogHandler>();

/**
 * Listen for a `dialog.submit` from one guest; returns the unregister function.
 *
 * Registering the same `guestKey` twice replaces the handler, which is what a
 * remounted section wants: Chromium reuses `webContents` ids, so the newest
 * registration for a key is by definition the guest currently on screen.
 */
export function registerPluginWebviewDialogHandler(
  guestKey: string,
  handler: PluginWebviewDialogHandler,
): () => void {
  handlers.set(guestKey, handler);
  return () => {
    // Compared by identity, the same rule `pluginWebviewGuestRegistry` keeps: a
    // handler that was already replaced must not have the live one removed by
    // the outgoing registration's cleanup.
    if (handlers.get(guestKey) === handler) handlers.delete(guestKey);
  };
}

/** Drop a registration by key. Safe for a key that never registered. */
export function unregisterPluginWebviewDialogHandler(guestKey: string): void {
  handlers.delete(guestKey);
}

/** Whether a dialog is listening on this guest. For a caller drawing state. */
export function hasPluginWebviewDialogHandler(guestKey: string): boolean {
  return handlers.has(guestKey);
}

/**
 * Hand one guest's answer to the dialog drawing it.
 *
 * Three outcomes and the caller needs all three apart, which is why this
 * returns a verdict rather than a boolean: `"applied"` landed, `"refused"`
 * reached the dialog and was turned down, and `"unlistened"` found no dialog on
 * that guest at all — a page in a tab calling `dialog.submit`, or a dialog that
 * closed while the page was still deciding.
 */
export function submitPluginWebviewDialogAnswer(
  guestKey: string,
  answer: PluginWebviewDialogSubmit,
): "applied" | "refused" | "unlistened" {
  const handler = handlers.get(guestKey);
  if (!handler) return "unlistened";
  return handler(answer) ? "applied" : "refused";
}

/** Test seam: forget every registration. */
export function resetPluginWebviewDialogHandlers(): void {
  handlers.clear();
}
