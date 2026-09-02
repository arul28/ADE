/**
 * Compiled surfaces owned by official plugins.
 *
 * A manifest `builtin` contribution does not render a vocabulary panel. It
 * names a surface that is compiled into ADE — the iOS Simulator and Electron
 * Control panes — and says "installing me is what puts this in the product".
 * Graph, Review, History, Linear and Cursor Cloud run the other way: ADE
 * already ships them compiled, and the owner plugin replaces them.
 *
 * ## Hidden is the default, and it is a default, not a fallback
 *
 * Every answer here starts at "not visible" and is moved only by a positive
 * fact: this host publishes plugins, its registry has resolved, and the
 * registered owner is in it and enabled. Before the registry loads, on a host
 * with no plugin support, after an uninstall, and while the owner is disabled,
 * the surface is absent — and those cases are indistinguishable on purpose, so
 * there is no state in which a surface appears because ADE was unsure.
 *
 * That is the reverse of how this file read in round 1, when the surfaces were
 * seeded onto every machine and hiding one had to be earned. Nothing is seeded
 * now, so there is no existing install to protect and no reason to remember
 * what was once seen: a machine with no plugins has no iOS Simulator pane, and
 * that is the correct product, not a degraded one. Graph, Review and History
 * SUPERSEDE, so the same unknowns leave those compiled tabs in place.
 *
 * ## Visibility is not the whole gate
 *
 * A rail item is a signpost, not access control. Routes, deeplinks, restored
 * routes and programmatic reveals reach these surfaces without passing a rail,
 * so each of those checks the same predicate rather than trusting that the way
 * in was hidden. `isBuiltinSurfaceVisible` is that one predicate.
 *
 * ## Where the table lives
 *
 * The surface→owner table and the bare "is the owner installed" test are in
 * `shared/plugins/builtinSurfaces.ts`, because the main process asks the same
 * question when it decides whether a system prompt may advertise a surface. The
 * renderer-only part — the three-fact rule and the React hooks over the root
 * store — stays here.
 */

import type { PluginBuiltinSurfaceId } from "../../../shared/plugins/manifest";
import {
  BUILTIN_SURFACE_OWNERS,
  builtinSurfaceInstalled,
  builtinSurfaceOwner,
  builtinSurfaceOwnerForPlugin,
  builtinSurfaceOwnerForRoute,
  builtinSurfacePresence,
  type BuiltinSurfaceOwner,
} from "../../../shared/plugins/builtinSurfaces";
import type { InstalledPlugin } from "../../lib/pluginRuntimeBridge";

export type BuiltinTabGate = BuiltinSurfaceOwner;

export const BUILTIN_TAB_GATES: readonly BuiltinTabGate[] = BUILTIN_SURFACE_OWNERS;

export function builtinGateForRoute(route: string): BuiltinTabGate | null {
  return builtinSurfaceOwnerForRoute(route);
}

export function builtinGateForPlugin(pluginId: string): BuiltinTabGate | null {
  return builtinSurfaceOwnerForPlugin(pluginId);
}

export function builtinGateForSurface(builtinId: PluginBuiltinSurfaceId): BuiltinTabGate {
  return builtinSurfaceOwner(builtinId);
}

/** The gate a plugin actually claims: registered owner AND a matching surface. */
export function claimedBuiltinGate(plugin: InstalledPlugin): BuiltinTabGate | null {
  const gate = builtinGateForPlugin(plugin.pluginId);
  if (!gate) return null;
  // A plugin that SUPERSEDES a surface claims nothing to draw. It brings its own
  // tab, and the rail must show that tab rather than suppress it in favour of a
  // compiled page this plugin exists to replace — which is what the legacy-host
  // fallback below would otherwise do, since such a plugin never declares
  // `builtin` on any of its surfaces.
  if (builtinSurfacePresence(gate.builtinId) === "supersedes") return null;
  const claims = plugin.tabs.some((tab) => tab.builtin === gate.builtinId);
  // A host that predates the `builtin` field reports the surface without it.
  // The registered owner is trusted in that case: the alternative is a duplicate
  // rail item on exactly the hosts that cannot tell us otherwise.
  const hostReportsBuiltin = plugin.tabs.some(
    (tab) => typeof tab.builtin === "string" && tab.builtin.length > 0,
  );
  return claims || !hostReportsBuiltin ? gate : null;
}

/** Everything the rules need, gathered by the caller once per render. */
export type BuiltinGateInput = {
  /** True when this build/host exposes plugins at all. */
  pluginSupport: boolean;
  /** False until the registry has resolved once. */
  pluginsLoaded: boolean;
  plugins: readonly InstalledPlugin[];
};

/**
 * The one predicate. Every rail item, command, pane, route and deeplink that
 * leads to a compiled surface asks this and nothing else.
 *
 * All three conditions are positive facts, so "we do not know yet" and "it is
 * not installed" both answer false. That is the whole hide-everything rule.
 */
export function isBuiltinSurfaceVisible(
  builtinId: PluginBuiltinSurfaceId,
  input: BuiltinGateInput,
): boolean {
  const resolved = input.pluginSupport && input.pluginsLoaded;
  if (builtinSurfacePresence(builtinId) === "supersedes") {
    // The mirror image, and the unknowns fall the other way on purpose. A
    // superseded surface is one ADE has always shipped, so an unresolved
    // registry, a host with no plugin support and an uninstalled owner all mean
    // "draw it" — the product without the plugin must be exactly the product it
    // was before the plugin existed. Only a positive "the owner is here" takes
    // it away, which is also the moment the plugin's own entry point appears, so
    // the two are never on screen together.
    return !(resolved && builtinSurfaceInstalled(builtinId, input.plugins));
  }
  if (!resolved) return false;
  return builtinSurfaceInstalled(builtinId, input.plugins);
}

/**
 * The same question asked by route.
 *
 * A route with no gate is one of ADE's own pages and is always allowed — this
 * function is a filter over a mixed list, not a routing allowlist.
 */
export function isBuiltinTabVisible(route: string, input: BuiltinGateInput): boolean {
  const gate = builtinGateForRoute(route);
  return gate ? isBuiltinSurfaceVisible(gate.builtinId, input) : true;
}

/**
 * Where a compiled route should send someone once a superseding plugin owns it.
 *
 * Enables surfaces have nowhere to go when the owner is gone — the page is not
 * part of this ADE. Supersedes surfaces do: the plugin's own tab is the
 * replacement, so a bookmark or a stored last-route at `/review` must open
 * `/plugin/ade-review` rather than a dead end or `/work`.
 */
export function supersededCompiledRouteReplacement(
  route: string,
  input: BuiltinGateInput,
): string | null {
  const gate = builtinGateForRoute(route);
  if (!gate?.route) return null;
  if (builtinSurfacePresence(gate.builtinId) !== "supersedes") return null;
  if (isBuiltinSurfaceVisible(gate.builtinId, input)) return null;
  if (!(input.pluginSupport && input.pluginsLoaded)) return null;
  return `/plugin/${encodeURIComponent(gate.ownerPluginId)}`;
}

/**
 * Plugins that should NOT get a rail item of their own, because the surface
 * they gate is already drawn by ADE.
 */
export function pluginOwnsBuiltinTab(plugin: InstalledPlugin): boolean {
  return claimedBuiltinGate(plugin) !== null;
}

/**
 * Where `/plugin/<id>` should send someone when that plugin gates a compiled
 * surface. Null when it does not, which is every ordinary plugin — and also
 * every pane owner, whose surface lives inside Work and has no route to send
 * them to.
 */
export function builtinRouteForPluginRoute(
  pluginId: string,
  plugins: readonly InstalledPlugin[],
): string | null {
  const plugin = plugins.find((entry) => entry.pluginId === pluginId);
  if (!plugin?.enabled) return null;
  return claimedBuiltinGate(plugin)?.route ?? null;
}
