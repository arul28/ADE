/**
 * Settings is a place you visit and leave. For each project this remembers
 * where you were before Settings (so the cog and the back button can return
 * you there) and the last Settings section you used (so the cog reopens it).
 *
 * The project sidebar records every route it sees. Memory only: a restart
 * returns to Work, which is also where the app opens.
 */

const DEFAULT_RETURN_ROUTE = "/work";

const returnRouteByProject = new Map<string, string>();
const settingsRouteByProject = new Map<string, string>();

function routePathname(route: string): string {
  return route.split(/[?#]/, 1)[0] ?? "";
}

export function isSettingsRoute(route: string): boolean {
  const pathname = routePathname(route);
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

/** CTO and History cover the page underneath. They are not a place Settings returns to. */
function isOverlayRoute(route: string): boolean {
  const pathname = routePathname(route);
  return pathname === "/cto" || pathname === "/history";
}

/** Records the route on screen for a project. */
export function rememberProjectRoute(projectKey: string | null, route: string): void {
  if (!projectKey || !route || isOverlayRoute(route)) return;
  if (isSettingsRoute(route)) settingsRouteByProject.set(projectKey, route);
  else returnRouteByProject.set(projectKey, route);
}

/** Where to go when you leave Settings. */
export function settingsReturnRoute(projectKey: string | null): string {
  return (projectKey && returnRouteByProject.get(projectKey)) || DEFAULT_RETURN_ROUTE;
}

/** The last Settings route used in this project, if any. */
export function lastSettingsRoute(projectKey: string | null): string | null {
  return (projectKey && settingsRouteByProject.get(projectKey)) || null;
}

export function resetSettingsReturnRoutesForTest(): void {
  returnRouteByProject.clear();
  settingsRouteByProject.clear();
}
