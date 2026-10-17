import { rootAppStoreApi } from "../state/appStore";
import { isWebClientMode } from "./webClientMode";

/**
 * Activity hooks behind the desktop "Star ADE on GitHub" pill. Both write the
 * root store (the pill's prefs are root-only) and do nothing in the browser
 * web client, which never shows the pill.
 */

/** The user sent a chat message from this desktop app. */
export function recordStarPillMessageSent(): void {
  if (isWebClientMode()) return;
  const state = rootAppStoreApi.getState();
  if (state.starPill.hasSentMessage) return;
  state.updateStarPill((prev) => ({ ...prev, hasSentMessage: true }));
}

/** The user created a new chat thread from this desktop app. */
export function recordStarPillThreadCreated(): void {
  if (isWebClientMode()) return;
  const state = rootAppStoreApi.getState();
  // Nothing reads the counter once the user has starred.
  if (state.starPill.starred) return;
  state.updateStarPill((prev) => ({ ...prev, threadsCreated: prev.threadsCreated + 1 }));
}
