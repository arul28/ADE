/**
 * ADE's own UI, from inside the guest.
 *
 * Every verb here is a v2 bridge method, and every one degrades rather than
 * throwing when the host is older: a v1 host draws no toast and the page carries
 * on, because a page that crashed on a missing toast would be worse than a page
 * that showed no toast.
 */

import { bridge, type PluginWebviewComposerAttach, type PluginWebviewToast } from "../bridge";

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
