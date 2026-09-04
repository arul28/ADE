/**
 * ADE's own UI, from inside the guest.
 *
 * Every verb here is a v2 bridge method, and every one degrades rather than
 * throwing when the host is older: a v1 host draws no toast and the page carries
 * on, because a page that crashed on a missing toast would be worse than a page
 * that showed no toast.
 *
 * Four of them are NEW in this wave and are guarded for exactly the same reason
 * — `openPathInEditor`, `pickModel`, `pickLane` and `pickReasoningEffort`. A
 * host that has none of them still draws the whole page: the finding card's
 * editor button becomes a no-op (which is what the compiled card did when the
 * app bridge had no such verb), and the launch form's three pickers fall back to
 * their plain fields.
 */

import {
  bridge,
  type PluginWebviewLaneChoice,
  type PluginWebviewModelChoice,
  type PluginWebviewReasoningChoice,
  type PluginWebviewToast,
} from "../bridge";

/**
 * The tallest height this page will ever report.
 *
 * The host clamps too, at 2,000px. This one is a guard against a runaway
 * MEASUREMENT rather than against a tall page: a mid-layout read, a font swap
 * or a `ResizeObserver` loop can produce a number no content ever had, and
 * asking the host for it once is enough to make a popover jump.
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

export async function writeClipboard(text: string): Promise<boolean> {
  const api = bridge();
  if (api?.clipboard) {
    try {
      await api.clipboard.write(text);
      return true;
    } catch {
      return false;
    }
  }
  // The compiled page's own second path: `navigator.clipboard` when the app
  // bridge had no writer. Kept, because a guest in the hosted web client may
  // have the browser API and no bridge verb.
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
  return false;
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

/** Send the reader to one of ADE's settings pages, or to this plugin's section. */
export async function openSettings(
  target: { entryId: string } | { socketId: string },
): Promise<void> {
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
 * Open one file in the reader's configured editor.
 *
 * NEW in this wave. `true` when the host took it; `false` when the host has no
 * such verb, which is the compiled card's own behaviour — it called
 * `window.ade.app.openPathInEditor?.(…) ?? Promise.resolve()` and swallowed
 * every rejection, so a host with no editor wiring made the button a no-op
 * rather than an error. Callers use the boolean only to decide whether to say
 * anything, never to throw.
 */
export async function openPathInEditor(args: {
  rootPath: string;
  relativePath?: string;
  target?: string;
}): Promise<boolean> {
  const api = bridge();
  if (!api?.ui?.openPathInEditor) return false;
  const relativePath = args.relativePath?.trim();
  try {
    await api.ui.openPathInEditor({
      rootPath: args.rootPath,
      ...(relativePath ? { relativePath } : {}),
      target: args.target?.trim() || "default",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * ADE's own model picker, as a popover over the guest.
 *
 * `null` covers both "the reader dismissed it" and "this host has no picker",
 * and the caller treats them the same: leave the field as it was. The launch
 * form asks `hostPickers` separately when it needs to draw a fallback control
 * rather than a trigger.
 */
export function pickerRectFromClick(event: { currentTarget: EventTarget }): {
  top: number;
  left: number;
  width: number;
  height: number;
} | undefined {
  const node = event.currentTarget;
  if (!(node instanceof Element)) return undefined;
  const box = node.getBoundingClientRect();
  return { top: box.top, left: box.left, width: box.width, height: box.height };
}

export async function pickModel(request?: {
  value?: string;
  availableModelIds?: string[];
  rect?: { top: number; left: number; width?: number; height?: number };
}): Promise<PluginWebviewModelChoice | null> {
  const api = bridge();
  if (!api?.ui?.pickModel) return null;
  try {
    return (await api.ui.pickModel(request)) ?? null;
  } catch {
    return null;
  }
}

export async function pickLane(request?: {
  value?: string;
  rect?: { top: number; left: number; width?: number; height?: number };
}): Promise<PluginWebviewLaneChoice | null> {
  const api = bridge();
  if (!api?.ui?.pickLane) return null;
  try {
    return (await api.ui.pickLane(request)) ?? null;
  } catch {
    return null;
  }
}

export async function pickReasoningEffort(request: {
  model: string;
  value?: string | null;
  rect?: { top: number; left: number; width?: number; height?: number };
}): Promise<PluginWebviewReasoningChoice | null> {
  const api = bridge();
  if (!api?.ui?.pickReasoningEffort) return null;
  try {
    return (await api.ui.pickReasoningEffort(request)) ?? null;
  } catch {
    return null;
  }
}

/** Which of the host pickers this host actually answers. */
export function hostPickers(): { model: boolean; lane: boolean; reasoningEffort: boolean } {
  const ui = bridge()?.ui;
  return {
    model: typeof ui?.pickModel === "function",
    lane: typeof ui?.pickLane === "function",
    reasoningEffort: typeof ui?.pickReasoningEffort === "function",
  };
}
