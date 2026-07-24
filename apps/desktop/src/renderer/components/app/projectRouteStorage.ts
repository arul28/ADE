/// Per-surface route memory: each open project tab remembers its last route
/// under `ade:project-route:<bindingKey>` so tab switches replay where the
/// user left off. Shared by ProjectTabHost (read/write on tab swaps) and
/// TopBar (read when routing back to a project from the Chats machine tab).
const PROJECT_ROUTE_STORAGE_PREFIX = "ade:project-route:";

function projectRouteStorageKey(bindingKey: string): string {
  return `${PROJECT_ROUTE_STORAGE_PREFIX}${bindingKey}`;
}

export function readStoredProjectRoute(bindingKey: string): string | null {
  try {
    const value = window.localStorage.getItem(projectRouteStorageKey(bindingKey));
    return value?.startsWith("/") ? value : null;
  } catch {
    return null;
  }
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
