/**
 * ADE's own UI, from inside the guest.
 *
 * Every verb here is an optional bridge method, and every one degrades rather
 * than throwing when the host is older: a v1 host draws no toast and the page
 * carries on, because a page that crashed on a missing toast would be worse than
 * a page that showed no toast.
 */

import { bridge, type PluginWebviewToast } from "../bridge";

/** Raise a toast in ADE's own stack. Answers the toast id, or null. */
export async function toast(next: PluginWebviewToast): Promise<string | null> {
  const api = bridge();
  if (!api?.ui) return null;
  try {
    const result = await api.ui.toast(next);
    return result?.id ?? null;
  } catch {
    return null;
  }
}

export async function dismissToast(id: string): Promise<void> {
  const api = bridge();
  if (!api?.ui) return;
  try {
    await api.ui.dismissToast(id);
  } catch {
    // A toast that has already gone is not an error worth showing.
  }
}

/**
 * Ask a yes/no above the guest.
 *
 * False when the host cannot ask — the caller is always a destructive step, and
 * "the reader did not confirm" is the safe reading of "nobody was asked".
 */
export async function confirm(request: {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  const api = bridge();
  if (!api?.ui) return false;
  try {
    return (await api.ui.confirm(request)) === true;
  } catch {
    return false;
  }
}

export async function writeClipboard(text: string): Promise<boolean> {
  const api = bridge();
  if (!api?.clipboard) return false;
  try {
    await api.clipboard.write(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a path in ADE's own editor.
 *
 * STUBBED on the platform side, so it is reached through the same guard every
 * other optional verb uses and answers `false` rather than throwing when the
 * host has no such verb. The caller is the inspect list: an element the host
 * matched to a source file draws its `file:line` as a press, and a host that
 * cannot open it draws the same line as plain text.
 */
export async function openPathInEditor(request: {
  rootPath: string;
  relativePath?: string;
  target?: string;
}): Promise<boolean> {
  const api = bridge();
  if (!api?.ui?.openPathInEditor) return false;
  const relativePath = request.relativePath?.trim();
  try {
    await api.ui.openPathInEditor({
      rootPath: request.rootPath,
      ...(relativePath ? { relativePath } : {}),
      target: request.target?.trim() || "default",
    });
    return true;
  } catch {
    // A path this host could not open. It says so itself.
    return false;
  }
}

/** Whether this host can open a path at all, for a row that should not look live otherwise. */
export function canOpenPathInEditor(): boolean {
  return typeof bridge()?.ui?.openPathInEditor === "function";
}

/**
 * Close the placement this page is drawn in.
 *
 * A no-op in a tab or a pane, which is the host's behaviour and not this
 * module's guess: the page asks and the host decides whether there is anything
 * to close.
 */
export async function closeSurface(): Promise<void> {
  const api = bridge();
  if (!api?.surface) return;
  try {
    await api.surface.close();
  } catch {
    // Already closed.
  }
}

/**
 * Open an `ade://` deeplink, or an `http(s)` URL in the reader's real browser.
 *
 * The host decides which of the two a URL deserves, exactly as it does for a
 * socket's `{openUrl}` answer, so the page does not have to know whether ADE's
 * own browser is available in this window.
 */
export async function openLink(url: string): Promise<void> {
  const api = bridge();
  if (!api) return;
  try {
    await api.openDeeplink(url);
  } catch {
    // A URL the host refused. It says so itself.
  }
}

/**
 * Follow the host's `changed` events.
 *
 * The compiled pane held `appControl.onEvent`, a live host subscription that
 * pushed session transitions and screencast frames. A page cannot hold one: the
 * placement is destroyed when it hides, and the frames belong to the host engine
 * anyway. This is the half that survives — the child republishes its status row
 * on every session transition, the host turns that into a `changed`, and the
 * page re-reads `pageStatus`.
 *
 * Returns the unsubscribe, or a no-op on a host with no events.
 */
export function onHostChanged(listener: () => void): () => void {
  const api = bridge();
  if (!api) return () => {};
  try {
    return api.events.on("changed", () => listener());
  } catch {
    return () => {};
  }
}
