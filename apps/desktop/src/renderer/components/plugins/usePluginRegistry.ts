import React from "react";

import { rootAppStoreApi, useRootAppStore } from "../../state/appStore";
import { subscribeToPluginChanges, type InstalledPlugin } from "../../lib/pluginRuntimeBridge";
import { isPluginRegistrationDisabled } from "../../../shared/plugins/disabledContributions";
import {
  appliedPluginTheme,
  applyPluginTheme,
  isPreviewingPluginTheme,
  type PluginThemeDefinition,
} from "../../lib/pluginTheme";

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
  // Bumped by the web client whenever its federated adapter swaps target
  // (machine connect, project/tab switch). That swap carries no install or
  // status event of its own, so without this dependency the registry would
  // keep answering for whichever machine was active when this effect first
  // ran. Always 0 on desktop Electron, so the effect there only ever runs once.
  const pluginAdapterGeneration = useRootAppStore((state) => state.pluginAdapterGeneration);

  React.useEffect(() => {
    void rootAppStoreApi.getState().refreshInstalledPlugins();
    return subscribeToPluginChanges((event) => {
      // Panel and collection writes are the panel host's business; the registry
      // only cares about what is installed and whether it is alive.
      if (event.kind !== "installs" && event.kind !== "status") return;
      void rootAppStoreApi.getState().refreshInstalledPlugins();
    });
  }, [pluginAdapterGeneration]);

  React.useEffect(() => {
    const next = themeDefinitionFor(plugins, pluginThemeId);
    // The registry hands back a fresh array on every refresh, so this effect
    // re-runs far more often than the applied theme changes. Re-applying an
    // unchanged theme would be invisible but for one thing: applying ENDS a
    // running preview, and the Marketplace's preview is deliberately sticky —
    // it is meant to survive walking off to another tab, which is exactly when
    // a background poll would have silently reverted it.
    if (isPreviewingPluginTheme() && sameThemeDefinition(appliedPluginTheme(), next)) return;
    applyPluginTheme(next);
  }, [plugins, pluginThemeId]);
}

function sameThemeDefinition(
  a: PluginThemeDefinition | null,
  b: PluginThemeDefinition | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.pluginId === b.pluginId
    && a.displayName === b.displayName
    && JSON.stringify(a.tokens) === JSON.stringify(b.tokens);
}

/**
 * One installed plugin's automation declaration, already attributed.
 *
 * Attribution is baked in rather than left to each caller: the rule builder
 * shows every plugin's triggers in ONE list, so "issue moved" is meaningless
 * without the name beside it, and two plugins may well declare the same id.
 */
export type PluginAutomationOption = {
  pluginId: string;
  /** The plugin's display name — what the picker shows the user. */
  pluginName: string;
  /** The declaration's id (a trigger id) or handler name (a step's `action`). */
  value: string;
  label: string;
  description?: string;
};

/**
 * Every enabled plugin's declared automation triggers, flattened.
 *
 * Disabled plugins are excluded: a disabled plugin's child does not run, so it
 * cannot fire anything, and offering its triggers would build a rule that is
 * armed against nothing. An existing rule pointing at one still renders — the
 * builder falls back to the stored ids and marks them unavailable rather than
 * reading this list.
 */
export function usePluginAutomationTriggers(): PluginAutomationOption[] {
  const plugins = useRootAppStore((state) => state.installedPlugins);
  return React.useMemo(
    () =>
      plugins
        .filter((plugin) => plugin.enabled)
        .flatMap((plugin) =>
          (plugin.automationTriggers ?? [])
            .filter((declared) => !isPluginRegistrationDisabled(
              plugin.disabledContributions,
              "automationTrigger",
              declared.id,
            ))
            .map((declared) => ({
              pluginId: plugin.pluginId,
              pluginName: plugin.displayName || plugin.pluginId,
              value: declared.id,
              label: declared.label,
              ...(declared.description ? { description: declared.description } : {}),
            })),
        ),
    [plugins],
  );
}

/**
 * Every enabled plugin's declared automation steps, flattened.
 *
 * `value` is the manifest step's `action` — the handler `plugin.invoke` calls —
 * not its id, because that is what a saved rule stores and what the runtime
 * dispatches. The two are the same for most declarations; the parser defaults
 * `action` to `id` precisely so they can be.
 */
export function usePluginAutomationSteps(): PluginAutomationOption[] {
  const plugins = useRootAppStore((state) => state.installedPlugins);
  return React.useMemo(
    () =>
      plugins
        .filter((plugin) => plugin.enabled)
        .flatMap((plugin) =>
          (plugin.automationSteps ?? [])
            .filter((declared) => !isPluginRegistrationDisabled(
              plugin.disabledContributions,
              "automationStep",
              declared.id,
            ))
            .map((declared) => ({
              pluginId: plugin.pluginId,
              pluginName: plugin.displayName || plugin.pluginId,
              value: declared.action,
              label: declared.label,
              ...(declared.description ? { description: declared.description } : {}),
            })),
        ),
    [plugins],
  );
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
