/**
 * The main process's answer to "does this machine have that compiled surface?".
 *
 * The renderer asks the same question of the registry it holds in memory. Main
 * has no such store, so it reads `state.json` — the lenient read, because a
 * registry this build cannot parse must not turn into an advertisement for
 * surfaces that may not be there.
 *
 * Used by the things that TALK about surfaces rather than draw them: the CTO
 * system prompt's page list, the agent bootstrap's skill roster. Capability is
 * never gated here — an uninstalled surface's skill still loads and its actions
 * still run; what stops is ADE telling an agent to go use it.
 *
 * The membership test is `builtinSurfaceDrawn`, not `builtinSurfaceInstalled`,
 * so the name of this function means what a reader expects for BOTH polarities:
 * the set is the surfaces this ADE actually presents. For a surface a plugin
 * SUPERSEDES those are opposites — the built-in Cursor Cloud is in the product
 * exactly while `ade-cursor-cloud` is not — and advertising it off the install
 * flag would point an agent at the page the plugin just replaced.
 */

import { PLUGIN_BUILTIN_SURFACE_IDS, type PluginBuiltinSurfaceId } from "../../../shared/plugins/manifest";
import { builtinSurfaceDrawn } from "../../../shared/plugins/builtinSurfaces";
import { readPluginInstallRecords, resolvePluginsRoot } from "./pluginRegistryFile";

export function readInstalledBuiltinSurfaces(
  pluginsRoot: string = resolvePluginsRoot(),
): ReadonlySet<PluginBuiltinSurfaceId> {
  const records = [...readPluginInstallRecords(pluginsRoot).values()];
  return new Set(
    PLUGIN_BUILTIN_SURFACE_IDS.filter((builtinId) => builtinSurfaceDrawn(builtinId, records)),
  );
}
