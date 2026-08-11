/**
 * Test support for the compiled surfaces official plugins own.
 *
 * The product hides Graph, Review, History, Linear, iOS Simulator and App
 * Control unless the owning plugin is installed and enabled on this machine,
 * and hidden is the default rather than a fallback. A suite that renders one of
 * those surfaces is therefore describing a machine that HAS it, and has to say
 * so — which is the point of making this explicit instead of seeding plugins
 * globally in `setup.ts`: a suite that forgets to ask still sees the shipped
 * default, so a gate that stops working shows up as a failing test.
 */

import { BUILTIN_TAB_GATES } from "../renderer/components/plugins/builtinTabs";
import { rootAppStoreApi } from "../renderer/state/appStore";
import type { PluginBuiltinSurfaceId } from "../shared/plugins/manifest";
import type { PluginClientInstalled } from "../shared/plugins/sdk";

function installedPluginFor(builtinId: PluginBuiltinSurfaceId): PluginClientInstalled {
  const gate = BUILTIN_TAB_GATES.find((candidate) => candidate.builtinId === builtinId);
  if (!gate) throw new Error(`No owner registered for builtin surface ${builtinId}`);
  return {
    pluginId: gate.ownerPluginId,
    displayName: gate.title,
    version: "1.0.0",
    enabled: true,
    icon: null,
    accent: null,
    status: "none",
    tabs: [{
      id: gate.builtinId,
      title: gate.title,
      panelId: `${gate.builtinId}-panel`,
      builtin: gate.builtinId,
    }],
    theme: null,
  };
}

/**
 * Put the named surfaces' owners on this machine, installed and enabled.
 *
 * Also publishes `window.ade.plugins`, because a host that does not expose
 * plugins at all cannot report a positive install and every surface stays
 * hidden regardless of the registry. The merge is deliberate: suites install
 * their own `window.ade` mock, and this has to add to it rather than replace
 * whatever IPC they set up. A mock defined AFTER this call drops the key
 * again, so those literals carry `plugins` themselves.
 */
export function seedBuiltinSurfacePlugins(builtinIds: readonly PluginBuiltinSurfaceId[]): void {
  const existing = (window as unknown as { ade?: Record<string, unknown> }).ade;
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: { ...(existing ?? {}), plugins: (existing?.plugins ?? {}) },
  });
  rootAppStoreApi.setState({
    installedPlugins: builtinIds.map(installedPluginFor),
    pluginsLoaded: true,
  });
}

/** Back to a machine with no plugins, which is what a fresh install looks like. */
export function resetBuiltinSurfacePlugins(): void {
  rootAppStoreApi.setState({ installedPlugins: [], pluginsLoaded: false });
}
