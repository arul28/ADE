import React from "react";

import { useRootAppStore } from "../../state/appStore";
import { pluginSocketsAvailable } from "./sockets/contributionBridge";
import {
  isBuiltinTabVisible,
  rememberSeenBuiltinGates,
  type BuiltinGateInput,
} from "./builtinTabs";

/**
 * The rail's answer to "is this built-in tab still ours to show?".
 *
 * Reads the ROOT store, like every other plugin-registry consumer: the rail and
 * the palette render above the project-scoped store, and a project-scoped copy
 * of the registry would not update when a plugin is installed.
 *
 * `pluginSocketsAvailable` rather than `pluginTabsAvailable` is the probe on
 * purpose. The question here is not "can this client draw a plugin panel" — a
 * gated tab draws the app's own compiled page — it is "does this host report
 * plugins at all", i.e. is an empty registry a fact or an absence.
 */
export function useBuiltinGateInput(): BuiltinGateInput {
  const plugins = useRootAppStore((state) => state.installedPlugins);
  const pluginsLoaded = useRootAppStore((state) => state.pluginsLoaded);
  const pluginSupport = pluginSocketsAvailable();

  // Observing an owner is what later lets its absence mean "removed" instead of
  // "never had it". Done during render-driven memo rather than in an effect so
  // the first paint after an install already reads the updated set.
  const seen = React.useMemo(
    () => (pluginSupport && pluginsLoaded ? rememberSeenBuiltinGates(plugins) : new Set<string>()),
    [pluginSupport, plugins, pluginsLoaded],
  );

  return React.useMemo(
    () => ({ pluginSupport, pluginsLoaded, plugins, seen }),
    [pluginSupport, plugins, pluginsLoaded, seen],
  );
}

/** Filter a list of rail/palette entries down to the ones still in the product. */
export function useVisibleBuiltinRoutes(): (route: string) => boolean {
  const input = useBuiltinGateInput();
  return React.useCallback((route: string) => isBuiltinTabVisible(route, input), [input]);
}
