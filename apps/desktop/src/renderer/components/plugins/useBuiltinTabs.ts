import React from "react";

import { useRootAppStore } from "../../state/appStore";
import { pluginSocketsAvailable } from "./sockets/contributionBridge";
import {
  isBuiltinTabVisible,
  isBuiltinSurfaceVisible,
  type BuiltinGateInput,
} from "./builtinTabs";
import { PLUGIN_BUILTIN_SURFACE_IDS, type PluginBuiltinSurfaceId } from "../../../shared/plugins/manifest";

/**
 * The rail's answer to "is this built-in tab still ours to show?".
 *
 * Reads the ROOT store, like every other plugin-registry consumer: the rail and
 * the palette render above the project-scoped store, and a project-scoped copy
 * of the registry would not update when a plugin is installed.
 *
 * `pluginSocketsAvailable` is the broad host capability probe: gated surfaces
 * draw compiled UI, but only a plugin-aware host can provide the positive
 * installed fact required to expose one.
 */
export function useBuiltinGateInput(): BuiltinGateInput {
  const plugins = useRootAppStore((state) => state.installedPlugins);
  const pluginsLoaded = useRootAppStore((state) => state.pluginsLoaded);
  const pluginSupport = pluginSocketsAvailable();

  return React.useMemo(
    () => ({ pluginSupport, pluginsLoaded, plugins }),
    [pluginSupport, plugins, pluginsLoaded],
  );
}

/** Filter a list of rail/palette entries down to the ones still in the product. */
export function useVisibleBuiltinRoutes(): (route: string) => boolean {
  const input = useBuiltinGateInput();
  return React.useCallback((route: string) => isBuiltinTabVisible(route, input), [input]);
}

export function useBuiltinSurfaceVisible(builtinId: PluginBuiltinSurfaceId): boolean {
  const input = useBuiltinGateInput();
  return isBuiltinSurfaceVisible(builtinId, input);
}

/**
 * The same answer, asked for an id the caller does not know at render time.
 *
 * `useBuiltinSurfaceVisible` fixes its surface in the call, which is right for
 * a component that draws one vendor's thing. It cannot serve a caller that
 * filters a LIST whose entries each name their own surface — a trigger source,
 * a settings tab, an automation template — because a hook may not be called in
 * a loop over data. Such a caller used to name every vendor it knew and call
 * the hook once per name, which is the shape that made a Jira-class plugin edit
 * a shared picker to be seen at all.
 *
 * So the gate hands back the predicate instead of an answer. One
 * `useBuiltinGateInput()` per render, and the polarity rule stays in the one
 * place that owns it — an `"enables"` surface reads every unknown as hidden and
 * a `"supersedes"` surface reads every unknown as drawn. A caller must not
 * reimplement that; it asks.
 */
export function useBuiltinSurfaceGate(): (builtinId: PluginBuiltinSurfaceId) => boolean {
  const input = useBuiltinGateInput();
  return React.useCallback(
    (builtinId: PluginBuiltinSurfaceId) => isBuiltinSurfaceVisible(builtinId, input),
    [input],
  );
}

/**
 * The whole set, for code that hands the answer to something outside the render
 * tree — an agent's bootstrap roster, for instance.
 *
 * Null means "not known yet", which is NOT the same as the empty set here. A
 * hidden rail item costs a user nothing while the registry resolves, but a
 * roster trimmed on an unresolved registry would tell an agent a skill is
 * missing on a machine that has it, and the agent has no way to find out later.
 */
export function useInstalledBuiltinSurfaces(): ReadonlySet<PluginBuiltinSurfaceId> | null {
  const input = useBuiltinGateInput();
  return React.useMemo(() => {
    if (input.pluginSupport && !input.pluginsLoaded) return null;
    return new Set(
      PLUGIN_BUILTIN_SURFACE_IDS.filter((builtinId) => isBuiltinSurfaceVisible(builtinId, input)),
    );
  }, [input]);
}
