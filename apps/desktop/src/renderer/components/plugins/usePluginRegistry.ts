import React from "react";

import { rootAppStoreApi, useRootAppStore } from "../../state/appStore";
import { subscribeToPluginChanges, type InstalledPlugin } from "../../lib/pluginRuntimeBridge";
import { applyPluginTheme, type PluginThemeDefinition } from "../../lib/pluginTheme";

/**
 * Keeps the root store's plugin registry in step with the host, and keeps the
 * applied plugin theme in step with the registry.
 *
 * Mounted once, at the app root. Two reasons it lives there rather than in the
 * tab rail: the rail is not the only reader, and a registry that only refreshed
 * while some particular component happened to be mounted would go stale in
 * exactly the cases that matter (installing a plugin from the Marketplace,
 * a plugin crashing while you are on another tab).
 *
 * The theme half is deliberately derived rather than stored twice. The store
 * persists a plugin *id*; the tokens live in the registry entry. So a theme
 * whose plugin was uninstalled — or which has not loaded yet — resolves to
 * nothing and the built-in palette stays in effect, instead of a dangling id
 * painting a half-remembered palette.
 */

function themeDefinitionFor(
  plugins: readonly InstalledPlugin[],
  pluginThemeId: string | null,
): PluginThemeDefinition | null {
  if (!pluginThemeId) return null;
  const plugin = plugins.find((entry) => entry.pluginId === pluginThemeId);
  if (!plugin?.theme || !plugin.enabled) return null;
  return {
    pluginId: plugin.pluginId,
    displayName: plugin.theme.displayName || plugin.displayName,
    tokens: plugin.theme.tokens,
  };
}

export function usePluginRegistrySync(): void {
  const plugins = useRootAppStore((state) => state.installedPlugins);
  const pluginThemeId = useRootAppStore((state) => state.pluginThemeId);

  React.useEffect(() => {
    void rootAppStoreApi.getState().refreshInstalledPlugins();
    return subscribeToPluginChanges((event) => {
      // Panel and collection writes are the panel host's business; the registry
      // only cares about what is installed and whether it is alive.
      if (event.kind !== "installs" && event.kind !== "status") return;
      void rootAppStoreApi.getState().refreshInstalledPlugins();
    });
  }, []);

  React.useEffect(() => {
    applyPluginTheme(themeDefinitionFor(plugins, pluginThemeId));
  }, [plugins, pluginThemeId]);
}

/** The applied theme's definition, or null. Shared by Appearance and the sync hook. */
export function usePluginThemeDefinition(): PluginThemeDefinition | null {
  const plugins = useRootAppStore((state) => state.installedPlugins);
  const pluginThemeId = useRootAppStore((state) => state.pluginThemeId);
  return React.useMemo(() => themeDefinitionFor(plugins, pluginThemeId), [plugins, pluginThemeId]);
}

/** Every installed plugin that ships a theme. Drives the Appearance swatch row. */
export function usePluginThemes(): PluginThemeDefinition[] {
  const plugins = useRootAppStore((state) => state.installedPlugins);
  return React.useMemo(
    () =>
      plugins
        .filter((plugin) => plugin.enabled && plugin.theme !== null)
        .map((plugin) => ({
          pluginId: plugin.pluginId,
          displayName: plugin.theme?.displayName || plugin.displayName,
          tokens: plugin.theme?.tokens ?? {},
        })),
    [plugins],
  );
}
