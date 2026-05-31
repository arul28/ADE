/**
 * Roots that must be treated as "in use" for project-context retention and rebalance.
 * Includes window bindings plus in-flight opens (pending IPC authorization and init promises).
 */
export function collectRootsBoundToWindows(args: {
  windowProjectRoots: Iterable<string | null>;
  windowProjectTabRoots: Iterable<Set<string>>;
  windowPendingProjectRoots: Iterable<Map<string, number>>;
  projectInitPromises: Iterable<string>;
}): Set<string> {
  const roots = new Set<string>();
  for (const root of args.windowProjectRoots) {
    if (root) roots.add(root);
  }
  for (const tabRoots of args.windowProjectTabRoots) {
    for (const root of tabRoots) roots.add(root);
  }
  for (const pendingRoots of args.windowPendingProjectRoots) {
    for (const root of pendingRoots.keys()) roots.add(root);
  }
  for (const root of args.projectInitPromises) {
    roots.add(root);
  }
  return roots;
}
