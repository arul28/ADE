/**
 * ADE's own UI, from inside the guest.
 *
 * Every verb here is an optional bridge method, and every one degrades rather
 * than throwing when the host is older or narrower: a host with no toast draws
 * no toast and the pane carries on, because a page that crashed on a missing
 * toast would be worse than a page that showed no toast.
 */

import { bridge, type PluginWebviewToast } from "../bridge";

/**
 * The tallest height this page will ever report.
 *
 * The host clamps too. This one is a guard against a runaway MEASUREMENT
 * rather than against a tall page: a mid-layout read, a font swap or a
 * `ResizeObserver` loop can produce a number no content ever had, and asking
 * the host for it once is enough to make a placement jump.
 */
const MAX_REPORTED_HEIGHT = 4000;

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
 * False when the host cannot ask — every caller is a destructive step (Stop the
 * simulator, Take over a session someone else owns), and "the reader did not
 * confirm" is the safe reading of "nobody was asked". The compiled pane used
 * `window.confirm`, which a guest must not: a modal inside the frame blocks the
 * host's own event loop and cannot be dismissed by the chrome around it.
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
 * Tell the host how tall this page's content is.
 *
 * The ONE height channel. A host too old to answer `ui.resize` draws the
 * placement at the size `page.css` gives it, which is correct if not
 * content-sized. Returns the height actually reported, or null when nothing
 * was, so a caller can skip a repeat report without measuring the clamp itself.
 */
export function reportHeight(height: number): number | null {
  const api = bridge();
  if (!api?.ui?.resize) return null;
  if (!Number.isFinite(height) || height <= 0) return null;
  const clamped = Math.min(Math.ceil(height), MAX_REPORTED_HEIGHT);
  try {
    api.ui.resize({ height: clamped });
    return clamped;
  } catch {
    // A host whose element has already gone. Nothing to size.
    return null;
  }
}

/**
 * Open a source file in the reader's editor.
 *
 * STUBBED CONTRACT — the host half is landing in parallel, so this is a guard
 * around an optional member exactly like `ui.toast`. `false` when the host has
 * no editor verb, which is what Preview Lab's "Open Xcode" row reads to decide
 * whether to draw the control at all.
 *
 * `relativePath` is the file inside `rootPath`. `target` is the editor id
 * (`"default"` for the system handler), not the path.
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
    return false;
  }
}

/**
 * Turn an absolute or already-relative path into a path inside `rootPath`.
 *
 * Preview Lab's Open Xcode answers a host path that may be absolute. The plugin
 * verb wants the bit inside the project root, and a page that stuffed the
 * absolute path into `target` would be naming an editor id ADE does not have.
 */
export function relativePathFromRoot(rootPath: string, filePath: string): string {
  const root = rootPath.replace(/\/+$/, "");
  const file = filePath.trim();
  if (!file) return "";
  if (file === root) return "";
  if (file.startsWith(`${root}/`)) return file.slice(root.length + 1);
  return file.replace(/^\/+/, "");
}

/** Whether this host can open a path at all, for a control that should not draw otherwise. */
export function canOpenPathInEditor(): boolean {
  return Boolean(bridge()?.ui?.openPathInEditor);
}

/**
 * Open an `ade://` deeplink, or an `http(s)` URL in the reader's real browser.
 *
 * This is what replaced `window.ade.app.openExternal` in the compiled pane's
 * "Setup docs" row: the host decides which of the two a URL deserves, so the
 * page does not have to know whether ADE's own browser is available in this
 * window.
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
