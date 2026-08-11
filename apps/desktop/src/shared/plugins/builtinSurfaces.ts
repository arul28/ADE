/**
 * Which official plugin owns each compiled surface, and the one pure question
 * "is that owner installed and enabled here?".
 *
 * The renderer answers this from the plugin registry it already holds in the
 * root store; the main process answers it by reading `state.json` off disk. The
 * table and the predicate are the part that must not diverge between them — a
 * surface the rail hides but the CTO prompt still advertises is the same bug in
 * two directions — so they live here, in shared, with no React and no
 * filesystem. Each side brings its own records and its own caching.
 *
 * The React hooks and the "we do not know yet" rules stay in the renderer's
 * `builtinTabs.ts`, which derives from this. What moved is only the table and
 * the membership test.
 */

import type { PluginBuiltinSurfaceId } from "./manifest";

export type BuiltinSurfaceOwner = {
  builtinId: PluginBuiltinSurfaceId;
  /** Null for compiled panes that live inside Work rather than at a route. */
  route: string | null;
  /**
   * The official plugin that owns it. Held in this table rather than discovered
   * from whichever installed plugin happens to declare `builtin`, so a plugin
   * cannot take over a core surface by naming it: the manifest field says "I
   * gate the surface I am registered for", and this table is the registration.
   */
  ownerPluginId: string;
  /** What to call it when ADE has to explain that it is not here. */
  title: string;
};

export const BUILTIN_SURFACE_OWNERS: readonly BuiltinSurfaceOwner[] = [
  { builtinId: "graph", route: "/graph", ownerPluginId: "ade-graph", title: "Graph" },
  { builtinId: "review", route: "/review", ownerPluginId: "ade-review", title: "Review" },
  { builtinId: "history", route: "/history", ownerPluginId: "ade-history", title: "History" },
  { builtinId: "linear", route: null, ownerPluginId: "ade-linear", title: "Linear" },
  { builtinId: "ios", route: null, ownerPluginId: "ade-ios-sim", title: "iOS Simulator" },
  { builtinId: "app-control", route: null, ownerPluginId: "ade-app-control", title: "App Control" },
];

export function builtinSurfaceOwnerForRoute(route: string): BuiltinSurfaceOwner | null {
  return BUILTIN_SURFACE_OWNERS.find((owner) => owner.route === route) ?? null;
}

export function builtinSurfaceOwnerForPlugin(pluginId: string): BuiltinSurfaceOwner | null {
  return BUILTIN_SURFACE_OWNERS.find((owner) => owner.ownerPluginId === pluginId) ?? null;
}

export function builtinSurfaceOwner(builtinId: PluginBuiltinSurfaceId): BuiltinSurfaceOwner {
  const owner = BUILTIN_SURFACE_OWNERS.find((candidate) => candidate.builtinId === builtinId);
  if (!owner) throw new Error(`No owner registered for builtin surface ${builtinId}`);
  return owner;
}

/**
 * The shape both sides already have: the renderer's `InstalledPlugin` and the
 * main process's `PluginInstallRecord` both carry these two fields, and nothing
 * else about either is needed to answer the question.
 */
export type BuiltinSurfaceInstallRecord = {
  pluginId: string;
  enabled: boolean;
};

/**
 * The pure half of the gate: the registry says this surface's owner is here and
 * switched on.
 *
 * Deliberately NOT the whole renderer predicate. It knows nothing about whether
 * the registry has loaded or whether this host publishes plugins at all, and a
 * caller that cannot establish those has to treat a false-y registry as "not
 * installed" itself — which is what `isBuiltinSurfaceVisible` does.
 */
export function builtinSurfaceInstalled(
  builtinId: PluginBuiltinSurfaceId,
  installedRecords: Iterable<BuiltinSurfaceInstallRecord>,
): boolean {
  const ownerId = builtinSurfaceOwner(builtinId).ownerPluginId;
  for (const record of installedRecords) {
    if (record.pluginId === ownerId && record.enabled) return true;
  }
  return false;
}
