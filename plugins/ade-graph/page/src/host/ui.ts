/**
 * ADE's own UI, from inside the guest.
 *
 * Every verb here is a bridge method, and every one degrades rather than
 * throwing when the host is older than the verb: a host with no toast draws no
 * toast and the page carries on. A page that crashed on a missing toast would
 * be worse than a page that showed none.
 *
 * Two verbs in this file are NEW in this wave — `ui.openPathInEditor` and
 * `ui.pickLane`. Both are guarded here. `openPath` falls back to the
 * `ade://file` deeplink. `pickLane` is absent on an older host; callers that
 * need a fallback check {@link hasLanePicker} rather than treating dismiss as
 * "type an id".
 */

import { bridge, type PluginWebviewEditorTarget, type PluginWebviewToast } from "../bridge";

/**
 * The tallest height this page will ever report.
 *
 * The host clamps too, at 2,000px. This one is a guard against a runaway
 * MEASUREMENT rather than against a tall page: a mid-layout read, a font swap
 * or a `ResizeObserver` loop can produce a number no content ever had.
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
 * False when the host cannot ask — every caller is a destructive step, and "the
 * reader did not confirm" is the safe reading of "nobody was asked".
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

/**
 * Close the placement this page is drawn in.
 *
 * A no-op in a tab or a pane, which is the host's behaviour and not this
 * module's guess: the page asks and the host decides.
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

/** Tell the host how tall this page's content is. Answers what was reported. */
export function reportHeight(height: number): number | null {
  const api = bridge();
  if (!api?.ui?.resize) return null;
  if (!Number.isFinite(height) || height <= 0) return null;
  const clamped = Math.min(Math.ceil(height), MAX_REPORTED_HEIGHT);
  try {
    api.ui.resize({ height: clamped });
    return clamped;
  } catch {
    return null;
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
 * Reveal a worktree folder, or open one file at one line, in the reader's editor.
 *
 * MISSING contract: `ui.openPathInEditor` is added by the platform batch of this
 * wave. Until a host answers it the page falls back to the `ade://file`
 * deeplink, which every shipped host already routes — a file opens correctly and
 * a bare folder does nothing, which is the honest degradation.
 */
export async function openPath(target: PluginWebviewEditorTarget): Promise<void> {
  const api = bridge();
  if (!api) return;
  if (api.ui?.openPathInEditor) {
    try {
      await api.ui.openPathInEditor(target);
      return;
    } catch {
      // Fall through to the deeplink.
    }
  }
  const filePath = target.target?.path;
  if (!filePath) return;
  const line = target.target?.line;
  const query = new URLSearchParams({ path: filePath });
  if (typeof line === "number" && Number.isFinite(line)) query.set("line", String(Math.max(1, Math.round(line))));
  await openLink(`ade://file?${query.toString()}`);
}

/**
 * ADE's own lane picker, as a popover over the guest.
 *
 * `null` is only a dismissal (or an excluded lane the host cannot filter). An
 * older host has no verb — {@link hasLanePicker} is false there, which is how
 * callers tell "type an id" from "the reader walked away".
 */
export function hasLanePicker(): boolean {
  return typeof bridge()?.ui?.pickLane === "function";
}

export async function pickLane(options?: {
  title?: string;
  excludeLaneIds?: string[];
}): Promise<string | null> {
  const api = bridge();
  if (!api?.ui?.pickLane) return null;
  try {
    const chosen = await api.ui.pickLane();
    const laneId = typeof chosen?.laneId === "string" && chosen.laneId.length > 0 ? chosen.laneId : null;
    if (laneId && options?.excludeLaneIds?.includes(laneId)) return null;
    return laneId;
  } catch {
    return null;
  }
}
