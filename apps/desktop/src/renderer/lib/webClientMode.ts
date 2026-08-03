// Web-client mode detection.
//
// The hosted browser web client (apps/desktop/src/renderer/webclient) reuses the
// desktop renderer's App, but only exposes the tabs whose reads and writes cross
// the sync protocol, and hides Electron/desktop-only chrome (native window
// controls, updater, onboarding tour, the tabs with no sync-protocol backing).
// The web-client bootstrap stamps `window.__adeWebClient = true` before the App
// module loads; everything desktop-only reads this flag to render cleanly on web
// instead of showing broken affordances.

declare global {
  interface Window {
    __adeWebClient?: boolean;
  }
}

/** True when the renderer is running as the hosted browser web client. */
export function isWebClientMode(): boolean {
  return typeof window !== "undefined" && window.__adeWebClient === true;
}

/**
 * The tab routes the web client surfaces, and the gate `TabNav` reads.
 *
 * Review and Automations stay off the list: neither has a `review.*` or
 * `automations.*` action registered host-side, so both would render a live-looking
 * surface whose writes go nowhere. Every route here has to stay reachable through
 * the web shell's `APP_ROUTE_ROOTS` — the CommandPalette can navigate to any of
 * them regardless of what the nav shows.
 */
export const WEB_CLIENT_TAB_PATHS = new Set([
  "/work",
  "/lanes",
  "/files",
  "/prs",
  "/chats",
  "/cto",
  "/graph",
  "/history",
  "/settings",
]);
