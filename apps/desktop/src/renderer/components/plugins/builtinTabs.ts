/**
 * Built-in tabs that a plugin owns.
 *
 * Most extracted surfaces become a plugin outright: the plugin ships a panel
 * schema and the renderer draws it. The Graph cannot go that way — it is an
 * interactive xyflow canvas, and the vocabulary is deliberately data-only — so
 * it stays compiled into the app and the plugin *gates* it instead. The
 * manifest says so with `surfaces[].builtin` (see `PLUGIN_BUILTIN_SURFACE_IDS`),
 * and everything that decides what the rail shows is here, as pure functions,
 * with the storage seam kept separate so the rules are testable.
 *
 * ## What "gated" means, exactly
 *
 * - The **rail item and the palette command** follow install state.
 * - The **route does not**. `/graph` keeps working when the tab is hidden, so a
 *   deeplink minted last month still opens, and the tab is one install away.
 * - The gating plugin gets **no rail item of its own**. It has no panel to show;
 *   a second "Graph" entry that opened an empty plugin page would be a bug
 *   wearing the feature's name.
 *
 * ## Why absence is not enough to hide a tab
 *
 * Two machines can both report "ade-graph is not installed" for opposite
 * reasons: one has never heard of plugins and has always had a Graph tab, the
 * other removed it on purpose. Hiding on absence alone would silently delete a
 * tab from every existing install on upgrade day, which is the one outcome the
 * extraction must not have.
 *
 * So a gate hides only once this machine has SEEN its owner installed.
 *
 * On the desktop that is usually immediate: `pluginInstallService` seeds the
 * bundled official packages into the machine install registry on first read and
 * records a tombstone when one is removed, so the owner is present from the
 * start and its later absence is a deliberate uninstall. The two rules agree by
 * construction — a seeded install is an observed install — and this one also
 * covers the hosts that seeding cannot reach: an older desktop, and the web
 * client, which reads a registry it does not populate.
 */

import {
  PLUGIN_BUILTIN_SURFACE_IDS,
  isPluginBuiltinSurfaceId,
  type PluginBuiltinSurfaceId,
} from "../../../shared/plugins/manifest";
import type { InstalledPlugin } from "../../lib/pluginRuntimeBridge";

/** One compiled-in tab, the route it occupies, and the plugin that owns it. */
export type BuiltinTabGate = {
  builtinId: PluginBuiltinSurfaceId;
  /** The rail path this gate governs. Must match the entry in `TabNav`. */
  route: string;
  /**
   * The official plugin that owns it. Held here rather than discovered from
   * whichever installed plugin happens to declare `builtin`, so a plugin cannot
   * take over a core tab by naming it: the manifest field says "I gate the tab I
   * am registered for", and this table is the registration.
   */
  ownerPluginId: string;
};

export const BUILTIN_TAB_GATES: readonly BuiltinTabGate[] = [
  { builtinId: "graph", route: "/graph", ownerPluginId: "ade-graph" },
];

export function builtinGateForRoute(route: string): BuiltinTabGate | null {
  return BUILTIN_TAB_GATES.find((gate) => gate.route === route) ?? null;
}

export function builtinGateForPlugin(pluginId: string): BuiltinTabGate | null {
  return BUILTIN_TAB_GATES.find((gate) => gate.ownerPluginId === pluginId) ?? null;
}

/** The gate a plugin actually claims: registered owner AND a matching surface. */
export function claimedBuiltinGate(plugin: InstalledPlugin): BuiltinTabGate | null {
  const gate = builtinGateForPlugin(plugin.pluginId);
  if (!gate) return null;
  const claims = plugin.tabs.some((tab) => tab.builtin === gate.builtinId);
  // A host that predates the `builtin` field reports the surface without it.
  // The registered owner is trusted in that case: the alternative is a duplicate
  // rail item on exactly the hosts that cannot tell us otherwise.
  const hostReportsBuiltin = plugin.tabs.some((tab) => typeof tab.builtin === "string" && tab.builtin.length > 0);
  return claims || !hostReportsBuiltin ? gate : null;
}

/** Everything the rules need, gathered by the caller once per render. */
export type BuiltinGateInput = {
  /** True when this build/host exposes plugins at all. */
  pluginSupport: boolean;
  /** False until the registry has resolved once. */
  pluginsLoaded: boolean;
  plugins: readonly InstalledPlugin[];
  /** Gate ids this machine has previously observed as installed. */
  seen: ReadonlySet<string>;
};

/**
 * Whether a core rail entry should be drawn.
 *
 * Every uncertainty resolves to "show it". A hidden tab is only ever the result
 * of a positive fact — this machine knows about plugins, has loaded its
 * registry, has met the owner before, and does not have it now.
 */
export function isBuiltinTabVisible(route: string, input: BuiltinGateInput): boolean {
  const gate = builtinGateForRoute(route);
  if (!gate) return true;
  if (!input.pluginSupport || !input.pluginsLoaded) return true;
  const owner = input.plugins.find((plugin) => plugin.pluginId === gate.ownerPluginId);
  if (owner) return owner.enabled;
  return !input.seen.has(gate.builtinId);
}

/**
 * Plugins that should NOT get a rail item of their own, because they gate a
 * built-in tab that is already in the rail.
 */
export function pluginOwnsBuiltinTab(plugin: InstalledPlugin): boolean {
  return claimedBuiltinGate(plugin) !== null;
}

/**
 * Where `/plugin/<id>` should send someone when that plugin gates a built-in
 * tab. Null when it does not, which is every ordinary plugin.
 */
export function builtinRouteForPluginRoute(
  pluginId: string,
  plugins: readonly InstalledPlugin[],
): string | null {
  const plugin = plugins.find((entry) => entry.pluginId === pluginId);
  if (!plugin) return null;
  const gate = claimedBuiltinGate(plugin);
  return gate ? gate.route : null;
}

/* ── Observed-owner memory ──────────────────────────────────────────────── */

/**
 * Its own key, holding its own array.
 *
 * Deliberately not a field in a shared preferences blob: surfaces that share one
 * stored map overwrite each other's slices, which is a bug this codebase has
 * already paid for once.
 */
export const BUILTIN_TAB_SEEN_STORAGE_KEY = "ade.plugins.builtinTabsSeen";

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    // Access itself throws in a locked-down embedding. A machine that cannot
    // remember simply keeps every built-in tab, which is the safe direction.
    return null;
  }
}

export function readSeenBuiltinGates(): Set<string> {
  const store = storage();
  if (!store) return new Set();
  try {
    const raw = store.getItem(BUILTIN_TAB_SEEN_STORAGE_KEY);
    if (!raw) return new Set();
    const decoded: unknown = JSON.parse(raw);
    if (!Array.isArray(decoded)) return new Set();
    return new Set(decoded.filter(isPluginBuiltinSurfaceId));
  } catch {
    return new Set();
  }
}

/**
 * Record every gate whose owner is installed right now, and answer with the set
 * as it now stands.
 *
 * Called on registry refresh. Writes only when the set actually grew — this runs
 * on every plugin change event, and a needless `setItem` on each one is churn on
 * the main thread for no gain.
 */
export function rememberSeenBuiltinGates(plugins: readonly InstalledPlugin[]): Set<string> {
  const seen = readSeenBuiltinGates();
  let grew = false;
  for (const plugin of plugins) {
    const gate = builtinGateForPlugin(plugin.pluginId);
    if (!gate || seen.has(gate.builtinId)) continue;
    seen.add(gate.builtinId);
    grew = true;
  }
  if (!grew) return seen;
  const store = storage();
  try {
    store?.setItem(BUILTIN_TAB_SEEN_STORAGE_KEY, JSON.stringify([...seen]));
  } catch {
    // Quota or a private-mode store. The rail stays as it is for this session.
  }
  return seen;
}

/** Test seam. */
export function forgetSeenBuiltinGates(): void {
  try {
    storage()?.removeItem(BUILTIN_TAB_SEEN_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Every gate id, for callers that need the closed list without the table. */
export const BUILTIN_TAB_IDS: readonly PluginBuiltinSurfaceId[] = PLUGIN_BUILTIN_SURFACE_IDS;
