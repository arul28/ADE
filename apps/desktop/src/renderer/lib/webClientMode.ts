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
    __adeBrowserMock?: boolean;
  }
}

/** True when the renderer is running as the hosted browser web client. */
export function isWebClientMode(): boolean {
  return typeof window !== "undefined" && window.__adeWebClient === true;
}

/**
 * True when the window is a browser surface that applies CSS zoom on <body>
 * (hosted web client, or the Vite `browserMock` preview). Electron uses
 * `h-screen` because `webFrame` shrinks the CSS viewport; these surfaces must
 * fill the inverse-sized body with `h-full` so 100vh cannot outgrow the zoom.
 */
export function isCssZoomedBrowserSurface(): boolean {
  if (typeof window === "undefined") return false;
  return window.__adeWebClient === true || window.__adeBrowserMock === true;
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
  "/marketplace",
  "/settings",
]);

/**
 * Whether this renderer can render a plugin's own `/plugin/:id` tab.
 *
 * The Marketplace above is a list read through the sync adapter, so it works
 * anywhere. A plugin tab is not: it renders a panel schema and the collection
 * rows that schema binds, and a host serving neither leaves an empty shell
 * behind a nav item — worse than no nav item at all. So the tab is offered only
 * where those reads exist, which is a property of the connected host, not of
 * the build: a hosted client gains the tabs the day its adapter serves panels,
 * with no second edit here.
 *
 * The two branches are not symmetric on purpose. On desktop, a member either
 * exists on the preload namespace or it does not. On web it always "exists":
 * `webclient/adapter/infra/proxy.ts` answers every unimplemented member with a
 * stub callable, so `typeof member === "function"` is not evidence there and a
 * probe written that way would offer a tab backed by stubs returning null. Only
 * a marker the adapter sets deliberately — and strictly `true`, since the stub
 * itself is truthy — counts as a hosted host saying it can serve panels.
 */
export function pluginTabsAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const plugins = (window as Window & {
    ade?: { plugins?: Record<string, unknown> | null };
  }).ade?.plugins;
  if (!plugins) return false;
  if (isWebClientMode()) return plugins.servesPluginPanels === true;
  return typeof plugins.getPanel === "function" && typeof plugins.getCollection === "function";
}
