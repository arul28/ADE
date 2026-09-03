import { useSyncExternalStore } from "react";

import type { PluginActionPrompt } from "../../../../shared/plugins/sdk";

/**
 * The single question a plugin action may have on screen.
 *
 * A renderer-only store on the same pattern as `pluginWebviewOverlayStore`,
 * and for the same reason: the callers are plain functions, not components.
 * A plugin button anywhere — a toolbar, a row menu, a chat header, a panel —
 * may answer `{prompt}` instead of finishing, and that question has to reach a
 * host mounted once in `AppShell` without threading a handle through every
 * control that can dispatch an action.
 *
 * One at a time, and a second open REPLACES the first. Two questions stacked
 * over each other is never what a reader meant, and the replaced one is simply
 * dropped: cancelling a prompt invokes nothing, so nothing is owed.
 *
 * The store holds the CONTINUATION rather than the plugin call. Both dispatch
 * paths — `runPluginSocketAction` and the panel host's own `dispatch` — build
 * their arguments differently, and a store that re-invoked on their behalf
 * would have to know both. It hands back the text; they re-invoke themselves.
 */

/** Where the control sat when it was pressed, in viewport coordinates. */
export type PluginPromptAnchor = { x: number; y: number; width: number; height: number };

export type PluginPromptRequest = {
  /** Bumped on every open, so the host remounts for a second question. */
  token: number;
  pluginId: string;
  /** The action that asked. Shown to nobody; used for the console warning. */
  actionId: string;
  /** The question, already read and bounded by `readPluginActionPrompt`. */
  prompt: PluginActionPrompt;
  /**
   * The title to draw when the prompt declared none — the control's own label,
   * which is the word the reader just pressed. Null falls back to the plugin.
   */
  fallbackTitle: string | null;
  /** Null when the press had no locatable control; the card then centres. */
  anchor: PluginPromptAnchor | null;
  /**
   * Re-invoke the action with this text.
   *
   * Called through {@link submitPluginPrompt}, never directly, so the closing
   * always happens first: the re-invocation may put something on screen, and a
   * question still standing over it is a second thing to dismiss.
   */
  onSubmit: (text: string) => void;
};

let current: PluginPromptRequest | null = null;
let nextToken = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): PluginPromptRequest | null {
  return current;
}

/**
 * The rect of the control that is being pressed right now, for anchoring.
 *
 * Read from the focused element rather than passed down, because the dispatch
 * functions are not components and have no ref to the button. A press moves
 * focus to the control, so at the moment an action is invoked the active
 * element IS the control — and when it is not (a keybinding, a bridge event,
 * a menu that already closed), the answer is null and the card centres, which
 * is the honest rendering of "this did not come from a place on screen".
 *
 * Sampled at INVOKE time by the caller, never when the answer comes back: by
 * then the menu the button lived in may be gone.
 */
export function readPluginPromptAnchor(): PluginPromptAnchor | null {
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  if (!active || typeof (active as HTMLElement).getBoundingClientRect !== "function") return null;
  if (active === document.body || active === document.documentElement) return null;
  const rect = (active as HTMLElement).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/** Ask the reader a plugin's question. Returns the request token. */
export function openPluginPrompt(request: Omit<PluginPromptRequest, "token">): number {
  const token = nextToken;
  nextToken += 1;
  current = { ...request, token };
  emit();
  return token;
}

/**
 * Take the question down. A no-op when none is open, and when `token` names a
 * question that has already been replaced by a newer one.
 */
export function closePluginPrompt(token?: number): void {
  if (!current) return;
  if (token !== undefined && current.token !== token) return;
  current = null;
  emit();
}

/** Subscribe a component to the open question. */
export function usePluginPrompt(): PluginPromptRequest | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Answer the open question: take the card down, then run the continuation.
 *
 * The order is the contract, which is why it lives here rather than in the card
 * — one caller cannot get it wrong on behalf of the others. A no-op when no
 * question is open.
 */
export function submitPluginPrompt(text: string): void {
  const request = current;
  if (!request) return;
  current = null;
  emit();
  request.onSubmit(text);
}

/**
 * Watch the standing question from outside React.
 *
 * The webview relay needs it. `ui.prompt` has to answer the page EXACTLY once —
 * with the text on submit, and with `null` when the reader walks away — and a
 * dismissal is not an event this store has: it is the current request becoming
 * something else. A subscriber can see that; `onSubmit` alone cannot, so a page
 * that asked a question the reader ignored would hold its promise until main's
 * ten-minute timeout.
 *
 * Exported rather than re-implemented because the alternative is a second
 * prompt UI for pages only, which is the drift the socket path's own comment
 * warns about.
 */
export function subscribePluginPrompt(listener: () => void): () => void {
  return subscribe(listener);
}

/** The open question, for a caller that is not a component. */
export function getPluginPrompt(): PluginPromptRequest | null {
  return current;
}
