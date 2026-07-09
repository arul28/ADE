// Web-client mode detection.
//
// The hosted browser web client (apps/desktop/src/renderer/webclient) reuses the
// desktop renderer's App, but only exposes the four cross-the-wire tabs and hides
// Electron/desktop-only chrome (native window controls, updater, onboarding tour,
// the extra tabs that have no sync-protocol backing). The web-client bootstrap
// stamps `window.__adeWebClient = true` before the App module loads; everything
// desktop-only reads this flag to render cleanly on web instead of showing broken
// affordances.

declare global {
  interface Window {
    __adeWebClient?: boolean;
  }
}

/** True when the renderer is running as the hosted browser web client. */
export function isWebClientMode(): boolean {
  return typeof window !== "undefined" && window.__adeWebClient === true;
}

/** The only tab routes the web client surfaces (mission: Work, Lanes, Files, PRs). */
export const WEB_CLIENT_TAB_PATHS = new Set(["/work", "/lanes", "/files", "/prs", "/chats"]);
