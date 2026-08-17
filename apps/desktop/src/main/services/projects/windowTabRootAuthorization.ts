/**
 * What a window's set-open-tabs call is allowed to change.
 *
 * The renderer names the tab set, so this splits one list into two very
 * different things:
 * - `tabRoots` — what the window is displaying. Renderer-supplied, and only
 *   ever used to look projects back up, so an unknown path there is harmless.
 * - `authorizedLocalRoots` — the window's local runtime scope, which
 *   `runtimeBridge` treats as "this window opened this checkout". A path that
 *   never opened must NOT earn local-runtime access just by appearing in a tab
 *   list, so only roots that resolve to a project this process actually opened
 *   pass through. Same gate `projectsForWindowTabs` applies when reading back.
 */
export function resolveWindowTabRoots(input: {
  rootPaths: readonly string[];
  /** The window's currently bound local root, always part of its tab set. */
  activeRoot: string | null;
  normalizeRoot: (rootPath: string) => string;
  /** True only for a root this process has an open project context for. */
  isOpenedProjectRoot: (root: string) => boolean;
}): { tabRoots: Set<string>; authorizedLocalRoots: string[] } {
  const tabRoots = new Set<string>();
  for (const rootPath of input.rootPaths) {
    const normalized = rootPath.trim() ? input.normalizeRoot(rootPath) : "";
    if (normalized) tabRoots.add(normalized);
  }
  if (input.activeRoot) tabRoots.add(input.activeRoot);
  const authorizedLocalRoots: string[] = [];
  for (const root of tabRoots) {
    if (input.isOpenedProjectRoot(root)) authorizedLocalRoots.push(root);
  }
  return { tabRoots, authorizedLocalRoots };
}
