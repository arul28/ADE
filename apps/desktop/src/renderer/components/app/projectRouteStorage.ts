/// Per-surface route memory: each open project tab remembers its last route
/// under `ade:project-route:<bindingKey>` so tab switches replay where the
/// user left off. Shared by ProjectTabHost (read/write on tab swaps) and
/// TopBar (read when routing back to a project from the Chats machine tab).
const PROJECT_ROUTE_STORAGE_PREFIX = "ade:project-route:";
const STORED_PROJECT_ROUTE_ROOTS = [
  "/lanes",
  "/files",
  "/work",
  "/graph",
  "/prs",
  "/review",
  "/history",
  "/automations",
  "/cto",
  "/settings",
  // Plugin tabs and `{navigate:{panelId}}` from sockets. Omitting this made
  // `/plugin/<id>` look like a click that did nothing: the URL changed, the
  // rail highlighted, and ProjectSurface kept rendering the last Work route.
  "/plugin",
] as const;

/** True when this pathname is a project surface ADE should actually mount. */
export function isProjectSurfacePathname(pathname: string): boolean {
  return STORED_PROJECT_ROUTE_ROOTS.some(
    (root) => pathname === root || pathname.startsWith(`${root}/`),
  );
}

function projectRouteStorageKey(bindingKey: string): string {
  return `${PROJECT_ROUTE_STORAGE_PREFIX}${bindingKey}`;
}

export function readStoredProjectRoute(bindingKey: string): string | null {
  try {
    const value = window.localStorage.getItem(projectRouteStorageKey(bindingKey));
    if (!value?.startsWith("/")) return null;
    if (value === "/project" || value.startsWith("/project?") || value.startsWith("/project#")) {
      writeStoredProjectRoute(bindingKey, "/work");
      return "/work";
    }
    const pathname = value.split(/[?#]/, 1)[0] ?? "";
    if (isProjectSurfacePathname(pathname)) return value;
    removeStoredProjectRoute(bindingKey);
    return null;
  } catch {
    return null;
  }
}

/** Read the last settings location without accidentally restoring another app tab. */
export function readStoredProjectSettingsRoute(bindingKey: string): string | null {
  const route = readStoredProjectRoute(bindingKey);
  if (!route) return null;
  const pathname = route.split(/[?#]/, 1)[0] ?? "";
  return pathname === "/settings" ? route : null;
}

export function writeStoredProjectRoute(bindingKey: string, route: string): void {
  try {
    window.localStorage.setItem(projectRouteStorageKey(bindingKey), route);
  } catch {
    // localStorage can be unavailable in private/test environments.
  }
}

export function removeStoredProjectRoute(bindingKey: string): void {
  try {
    window.localStorage.removeItem(projectRouteStorageKey(bindingKey));
  } catch {
    // localStorage can be unavailable in private/test environments.
  }
}
