import React from "react";

import { useRootAppStore } from "../../../state/appStore";
import type { PluginBrandGlyph } from "../../../../shared/plugins/vocabularyBrandIcons";

/**
 * One plugin's own shipped brand glyphs, for whichever socket is drawing it.
 *
 * ADE compiles five vendor marks in, and a `brand:*` token outside that closed
 * set can only be resolved from the artwork the PACKAGE shipped — the host
 * sanitizes it into `ade.brandIcons` at install and hands it back on the
 * installed record. A renderer that does not pass those rows draws the puzzle
 * piece for exactly the plugins that took the trouble to ship a mark, which is
 * what happened on the top bar: `PluginToolbarActions` drew a puzzle piece for
 * `brand:linear` while the tab rail two pixels away drew Linear's own logo.
 *
 * So it is a hook rather than a prop threaded from six places. Every socket
 * renderer already knows the contribution's `pluginId`, and this is the only
 * lookup any of them needs; a shared one is what stops the next socket from
 * quietly rejoining the puzzle-piece group. The resolver is memoized on the
 * installed list's identity so a hundred rows share one map, which is the same
 * perf law `contributionStores` is built on: a row never fetches, and a row
 * never rebuilds a map either.
 *
 * `undefined` for a plugin the registry has not loaded yet — the caller spreads
 * nothing and gets the compiled catalogue's answer, which is what it drew
 * before this existed.
 */
export function usePluginBrandIcons(): (
  pluginId: string,
) => Readonly<Record<string, PluginBrandGlyph>> | undefined {
  const installedPlugins = useRootAppStore((state) => state.installedPlugins);
  return React.useMemo(() => {
    const byPluginId = new Map<string, Readonly<Record<string, PluginBrandGlyph>>>();
    // Guarded because this hook is reached from row menus on four tabs, and a
    // registry that has not loaded is the normal state for the first frames of
    // a launch. An icon lookup is the last thing that should take a tab down
    // with it — the honest answer while there is no registry is "no rows".
    if (!Array.isArray(installedPlugins)) return () => undefined;
    for (const plugin of installedPlugins) {
      if (plugin.brandIcons) byPluginId.set(plugin.pluginId, plugin.brandIcons);
    }
    return (pluginId: string) => byPluginId.get(pluginId);
  }, [installedPlugins]);
}

/**
 * The spread form, because every call site is the same three lines otherwise.
 *
 * `SocketIcon` and friends take `brandIcons` as an OPTIONAL prop under
 * `exactOptionalPropertyTypes`, so passing `undefined` explicitly is a type
 * error and each caller would otherwise write its own ternary. This returns the
 * object to spread: the rows when there are rows, nothing when there are not.
 */
export function brandIconsProp(
  brandIcons: Readonly<Record<string, PluginBrandGlyph>> | undefined,
): { brandIcons?: Readonly<Record<string, PluginBrandGlyph>> } {
  return brandIcons ? { brandIcons } : {};
}
