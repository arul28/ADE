import { existsSync } from "node:fs";
import path from "node:path";
import type { WebContents } from "electron";
import type { Logger } from "../logging/logger";

// Process-wide registry of the built-in browser's tab `WebContents`, shared by
// every collection's browser service and read by Now Playing
// (`home/browserMediaSessions.ts`): which `WebContents` are browser tabs, who
// wants to hear about new ones, and which may keep playing while hidden.

/** Every live browser tab's `WebContents` (not ADE's own UI, not a popup it does not manage). */
export const MANAGED_BROWSER_WEB_CONTENTS = new WeakSet<WebContents>();

/**
 * Tabs that keep their sound while hidden. A hidden tab is muted, except one a
 * person was listening to: media that started while the tab was on screen
 * (unmuted), or that someone pressed play on from Now Playing. Cleared when
 * the tab loads a new document.
 */
export const BACKGROUND_AUDIO_WEB_CONTENTS = new WeakSet<WebContents>();

const browserWebContentsListeners = new Set<(wc: WebContents) => void>();

/** Hears every browser tab's `WebContents` as it is set up (Now Playing listens for media). */
export function onBuiltInBrowserWebContents(listener: (wc: WebContents) => void): () => void {
  browserWebContentsListeners.add(listener);
  return () => browserWebContentsListeners.delete(listener);
}

/** Tell every `onBuiltInBrowserWebContents` listener about a tab just set up. */
export function announceBuiltInBrowserWebContents(wc: WebContents): void {
  for (const listener of browserWebContentsListeners) {
    try {
      listener(wc);
    } catch {
      // A listener's failure is its own.
    }
  }
}

/** One of the built-in browser's tabs (not ADE's own UI, not a popup it does not manage). */
export function isBuiltInBrowserWebContents(wc: WebContents | null | undefined): boolean {
  return Boolean(wc && MANAGED_BROWSER_WEB_CONTENTS.has(wc));
}

/** Let a hidden tab play out loud: a person asked for it (Now Playing's play button). */
export function allowBuiltInBrowserBackgroundAudio(wc: WebContents): void {
  if (wc.isDestroyed() || !MANAGED_BROWSER_WEB_CONTENTS.has(wc)) return;
  BACKGROUND_AUDIO_WEB_CONTENTS.add(wc);
  try {
    if (wc.isAudioMuted()) wc.setAudioMuted(false);
  } catch {
    // ignore optional platform support differences
  }
}

/**
 * The browser-media preload (`preload/browserMedia.ts`) on a tab session, once:
 * it lets Now Playing press the page's own media session buttons. A session is
 * only remembered once the preload is registered, so a failed attempt is
 * retried by the next tab on that session.
 */
const BROWSER_MEDIA_PRELOAD_SESSIONS = new WeakSet<Electron.Session>();
export function registerBrowserMediaPreload(browserSession: Electron.Session, logger: () => Logger | null): void {
  if (BROWSER_MEDIA_PRELOAD_SESSIONS.has(browserSession)) return;
  const filePath = path.join(__dirname, "..", "preload", "browserMedia.cjs");
  if (!existsSync(filePath) || typeof browserSession.registerPreloadScript !== "function") return;
  try {
    browserSession.registerPreloadScript({ type: "frame", id: "ade-browser-media", filePath });
    BROWSER_MEDIA_PRELOAD_SESSIONS.add(browserSession);
  } catch (error) {
    logger()?.warn("built_in_browser.media_preload_failed", {
      err: error instanceof Error ? error.message : String(error),
    });
  }
}
