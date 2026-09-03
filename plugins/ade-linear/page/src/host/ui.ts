/**
 * ADE's own UI, from inside the guest.
 *
 * Every verb here is a v2 bridge method, and every one degrades rather than
 * throwing when the host is older: a v1 host draws no toast and the page carries
 * on, because a page that crashed on a missing toast would be worse than a page
 * that showed no toast.
 */

import { bridge, type PluginWebviewComposerAttach, type PluginWebviewToast } from "../bridge";

/**
 * The tallest height this page will ever report.
 *
 * The host clamps too, at 2,000px. This one is a guard against a runaway
 * MEASUREMENT rather than against a tall page: a mid-layout read, a font swap
 * or a `ResizeObserver` loop can produce a number no content ever had, and
 * asking the host for it once is enough to make a settings section jump.
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

/** ADE's one-field prompt. Null when dismissed or unavailable. */
export async function prompt(request: unknown): Promise<unknown> {
  const api = bridge();
  if (!api?.ui) return null;
  try {
    return await api.ui.prompt(request);
  } catch {
    return null;
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

export async function readClipboard(): Promise<string> {
  const api = bridge();
  if (!api?.clipboard) return "";
  try {
    return await api.clipboard.read();
  } catch {
    return "";
  }
}

/** Attach an issue chip to the chat composer. */
export async function composerAttach(issue: PluginWebviewComposerAttach): Promise<void> {
  const api = bridge();
  if (!api?.composer) return;
  try {
    await api.composer.attach(issue);
  } catch {
    // The composer is gone; nothing to attach to.
  }
}

export async function composerInsert(text: string): Promise<void> {
  const api = bridge();
  if (!api?.composer) return;
  try {
    await api.composer.insert(text);
  } catch {
    // As above.
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
 * The ONE height channel. Before the bridge grew `ui.resize` the page reported
 * its height two other ways — writing `documentElement.style.height` for a host
 * that measured the guest document, and posting an `ade:plugin-webview-height`
 * frame to the parent for a host that listened — and neither was a bridge verb,
 * so neither was something a host was obliged to honour or a page could rely
 * on. Both are gone. A host too old to answer `ui.resize` draws the placement
 * at the size `page.css` gives it, which is correct if not content-sized.
 *
 * Returns the height actually reported, or null when nothing was, so a caller
 * can skip a repeat report without measuring the clamp itself.
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
 * Answer the ADE dialog this page is drawn inside.
 *
 * Only the `dialog-picker` placement has it — every other placement refuses it
 * `not_permitted`, and a host that has no dialog verb at all gets `false` here
 * without a throw, which is what makes the picker entry safe to render
 * anywhere. `true` means the host took the answer.
 *
 * `null` is a real answer: it clears a previous choice, which a dialog must be
 * able to hear or a chosen issue could never be undone from inside the page.
 */
export async function submitDialog(issue: PluginWebviewComposerAttach | null): Promise<boolean> {
  const api = bridge();
  if (!api?.dialog) return false;
  try {
    await api.dialog.submit({ issue });
    return true;
  } catch {
    return false;
  }
}

/** Send the reader to one of ADE's settings pages, or to this plugin's section. */
export async function openSettings(target: { entryId: string } | { socketId: string }): Promise<void> {
  const api = bridge();
  if (!api?.openSettings) return;
  try {
    await api.openSettings(target);
  } catch {
    // A settings entry this host does not know.
  }
}

/**
 * Open an `ade://` deeplink, or an `http(s)` URL in the reader's real browser.
 *
 * This replaces `openUrlInAdeBrowser` and `openExternalUrl` together: the host
 * decides which of the two a URL deserves, exactly as it does for a socket's
 * `{openUrl}` answer, so the page does not have to know whether ADE's own
 * browser is available in this window.
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
