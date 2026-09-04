/// Per-surface route memory: each open project tab remembers its last route
/// under `ade:project-route:<bindingKey>` so tab switches replay where the
/// user left off. Shared by ProjectTabHost (read/write on tab swaps) and
/// TopBar (read when routing back to a project from the Chats machine tab).
const PROJECT_ROUTE_STORAGE_PREFIX = "ade:project-route:";
/// Last Settings URL, kept apart from the project surface slot. Leaving
/// Settings for a plugin tab used to overwrite that slot, so the rail's next
/// Settings click always opened bare `/settings` and reset the tab.
const SETTINGS_PLACE_STORAGE_PREFIX = "ade:project-settings-place:";
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

function settingsPlaceStorageKey(bindingKey: string): string {
  return `${SETTINGS_PLACE_STORAGE_PREFIX}${bindingKey}`;
}

function settingsPathname(route: string): string {
  return route.split(/[?#]/, 1)[0] ?? "";
}

function isSettingsRouteValue(route: string): boolean {
  const pathname = settingsPathname(route);
  return pathname === "/settings" || pathname.startsWith("/settings/");
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

export function writeStoredSettingsPlace(bindingKey: string, route: string): void {
  if (!isSettingsRouteValue(route)) return;
  try {
    window.localStorage.setItem(settingsPlaceStorageKey(bindingKey), route);
  } catch {
    // localStorage can be unavailable in private/test environments.
  }
}

export function readStoredSettingsPlace(bindingKey: string): string | null {
  try {
    const value = window.localStorage.getItem(settingsPlaceStorageKey(bindingKey));
    if (!value?.startsWith("/")) return null;
    if (!isSettingsRouteValue(value)) return null;
    return value;
  } catch {
    return null;
  }
}

/** Read the last settings location without accidentally restoring another app tab. */
export function readStoredProjectSettingsRoute(bindingKey: string): string | null {
  const stored = readStoredSettingsPlace(bindingKey);
  if (stored) return stored;
  const route = readStoredProjectRoute(bindingKey);
  if (!route) return null;
  return isSettingsRouteValue(route) ? route : null;
}

/**
 * Where the Settings rail item and "Go to Settings" should land.
 *
 * A dedicated settings place survives leaving for a plugin tab. Deeplinks that
 * name a tab or hash still win — those navigate to a specific URL instead of
 * calling this.
 */
export function settingsNavTarget(bindingKey: string | null, projectRoot: string | null): string {
  if (bindingKey) {
    const stored = readStoredProjectSettingsRoute(bindingKey);
    if (stored) return stored;
  }
  if (projectRoot && projectRoot !== bindingKey) {
    const stored = readStoredProjectSettingsRoute(projectRoot);
    if (stored) return stored;
  }
  return "/settings";
}

export function writeStoredProjectRoute(bindingKey: string, route: string): void {
  try {
    window.localStorage.setItem(projectRouteStorageKey(bindingKey), route);
    if (isSettingsRouteValue(route)) writeStoredSettingsPlace(bindingKey, route);
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
