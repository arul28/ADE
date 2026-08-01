/**
 * Renamed renderer routes, and where they now live.
 *
 * ADE's shell does not use `<Route>` elements for its top-level surfaces — they
 * are pathname predicates duplicated in `App.tsx` and `AppShell.tsx` — so there
 * is no router-level redirect to hang a rename on. This is the same shape as
 * `settingsManifest.ts`'s `LEGACY_TAB_ALIASES` / `resolveSettingsTab`: every
 * path ADE has ever shipped in a deeplink, a tour step, or a bookmark stays
 * resolvable, and the app has one place to look it up.
 */
export const LEGACY_ROUTE_ALIASES: Readonly<Record<string, string>> = {
  // The Attention center became the Activity pane. The pathname survives as a
  // deep link that opens the pane over whatever tab is current.
  "/attention": "/activity",
};

/**
 * Resolve a pathname to the route that serves it today. Unknown paths come back
 * unchanged so callers can keep treating this as a total function.
 */
export function resolveLegacyRoute(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  const direct = LEGACY_ROUTE_ALIASES[normalized];
  if (direct) return direct;
  for (const [legacy, target] of Object.entries(LEGACY_ROUTE_ALIASES)) {
    if (normalized.startsWith(`${legacy}/`)) {
      return `${target}${normalized.slice(legacy.length)}`;
    }
  }
  return pathname;
}

/** Whether a pathname opens the Activity pane, under either of its names. */
export function isActivityRoute(pathname: string): boolean {
  const resolved = resolveLegacyRoute(pathname);
  return resolved === "/activity" || resolved.startsWith("/activity/");
}
