/**
 * ADE's own UI, from inside the guest.
 *
 * Every verb here is a v2 bridge method, and every one degrades rather than
 * throwing when the host is older: a v1 host draws no toast and the page carries
 * on, because a page that crashed on a missing toast would be worse than a page
 * that showed no toast.
 */

import { bridge, type PluginWebviewToast } from "../bridge";

/**
 * The tallest height this page will ever report.
 *
 * The host clamps too, at 2,000px. This one is a guard against a runaway
 * MEASUREMENT rather than against a tall page: a mid-layout read, a font swap
 * or a `ResizeObserver` loop can produce a number no content ever had, and
 * asking the host for it once is enough to make a composer popover jump.
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
 * Close the placement this page is drawn in.
 *
 * A no-op in a tab or a pane, which is the host's behaviour and not this
 * module's guess: the page asks and the host decides whether there is anything
 * to close. The launch form calls it on a successful launch, exactly as the
 * compiled composer's Advanced menu closed itself on send.
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
 * The ONE height channel, and only the content-sized placements use it: the
 * `launch` surface is a `composer-picker`, which is a band the host draws
 * around rather than a viewport the page fills. A host too old to answer
 * `ui.resize` draws the placement at the size `page.css` gives it, which is
 * correct if not content-sized.
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

/** Send the reader to one of ADE's settings pages. */
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
 * This replaces the compiled `openExternalUrl`: the host decides which of the
 * two a URL deserves, exactly as it does for a socket's `{openUrl}` answer, so
 * the page does not (and may not) navigate a window itself. Every cursor.com
 * link, every PR link and every artifact download goes through here.
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
