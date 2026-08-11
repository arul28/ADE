/**
 * Where a `plugin` deeplink goes, decided without a router.
 *
 * The rule is the compiled surfaces' hide-everything rule (`components/plugins/
 * builtinTabs.ts`) asked of an ordinary plugin: this host publishes plugins, its
 * registry has resolved, and the named plugin is in it and enabled. All three
 * are positive facts, so "we do not know yet" and "it is not installed" answer
 * the same — a link never opens the shell of a tab while ADE works out whether
 * the plugin is there.
 *
 * Pure and separate from `App.tsx` so the decision can be read and tested on its
 * own; the dispatcher only has to obey the answer.
 */

import type { BuiltinGateInput } from "../plugins/builtinTabs";

export type PluginDeeplinkTarget = {
  pluginId: string;
  panelId: string;
  context?: Record<string, unknown> | null;
};

export type PluginDeeplinkRouting =
  /** Navigate here. */
  | { kind: "open"; path: string }
  /** Say so plainly, under this name. */
  | { kind: "refuse"; title: string };

export function resolvePluginDeeplinkRouting(
  target: PluginDeeplinkTarget,
  input: BuiltinGateInput,
): PluginDeeplinkRouting {
  const plugin = input.pluginSupport && input.pluginsLoaded
    ? input.plugins.find((entry) => entry.pluginId === target.pluginId) ?? null
    : null;
  if (!plugin?.enabled) {
    // The plugin's own name when the registry knows it, so the refusal reads
    // like the thing the reader clicked rather than an internal id.
    return { kind: "refuse", title: plugin?.displayName || target.pluginId };
  }
  const params = new URLSearchParams();
  params.set("panel", target.panelId);
  if (target.context) {
    // Encoded once, by URLSearchParams. Serializing by hand is how the same
    // object ends up double-escaped on one surface and not another.
    try {
      params.set("ctx", JSON.stringify(target.context));
    } catch {
      // A context that will not serialize is dropped, never fatal — the panel
      // is what the link was for.
    }
  }
  return { kind: "open", path: `/plugin/${encodeURIComponent(target.pluginId)}?${params.toString()}` };
}
