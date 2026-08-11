import React from "react";

import { useRootAppStore } from "../../state/appStore";
import { pluginSocketsAvailable } from "./sockets/contributionBridge";
import {
  isBuiltinTabVisible,
  isBuiltinSurfaceVisible,
  type BuiltinGateInput,
} from "./builtinTabs";
import type { PluginBuiltinSurfaceId } from "../../../shared/plugins/manifest";

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
