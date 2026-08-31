/**
 * Where a `plugin` or `issue` deeplink goes, decided without a router.
 *
 * The rule is the compiled surfaces' hide-everything rule (`components/plugins/
 * builtinTabs.ts`) asked of an ordinary plugin: this host publishes plugins, its
 * registry has resolved, and the named plugin is in it and enabled. All three
 * are positive facts, so "we do not know yet" and "it is not installed" answer
 * the same — a link never opens the shell of a tab while ADE works out whether
 * the plugin is there.
 *
 * An `issue` link asks the same question one step later: first who owns the
 * tracker on this machine, then that same gate. When nobody owns it and the
 * tracker is Linear, the answer is the compiled Linear surface — which is where
 * `ade://linear-issue/…` has always gone, and must keep going.
 *
 * Pure and separate from `App.tsx` so the decision can be read and tested on its
 * own; the dispatcher only has to obey the answer.
 */

import {
  PLUGIN_ISSUE_PANEL_ID,
  issueDeeplinkContext,
  type DeeplinkIssueTarget,
} from "../../../shared/deeplinks";
import { CORE_ISSUE_PLUGIN_ID, ISSUE_PROVIDER_LINEAR } from "../../../shared/issueRef";
import {
  PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES,
  pluginUtf8ByteLength,
} from "../../../shared/plugins/sdk";
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

/**
 * The gate, asked once: this host publishes plugins, its registry has resolved,
 * and the named plugin is in it. Null when any of the three is not a fact.
 */
function gatedPlugin(
  pluginId: string,
  input: BuiltinGateInput,
): BuiltinGateInput["plugins"][number] | null {
  return input.pluginSupport && input.pluginsLoaded
    ? input.plugins.find((entry) => entry.pluginId === pluginId) ?? null
    : null;
}

export function resolvePluginDeeplinkRouting(
  target: PluginDeeplinkTarget,
  input: BuiltinGateInput,
): PluginDeeplinkRouting {
  const plugin = gatedPlugin(target.pluginId, input);
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
      const json = JSON.stringify(target.context);
      // The same ceiling, measured the same way, as the URL parser, `ade link
      // --ctx` and iOS. A context that would not survive being minted into a
      // link must not reach a panel by this route either, or one surface's
      // panel renders with a context the others could never deliver.
      if (json && pluginUtf8ByteLength(json) <= PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES) {
        params.set("ctx", json);
      }
    } catch {
      // A context that will not serialize is dropped, never fatal — the panel
      // is what the link was for.
    }
  }
  return { kind: "open", path: `/plugin/${encodeURIComponent(target.pluginId)}?${params.toString()}` };
}

/**
 * Which plugin, if any, speaks for a tracker on this machine.
 *
 * Supplied by the caller rather than looked up here, so the resolver stays a
 * pure function of facts the caller already has. `panelId` is optional: a plugin
 * that registers no issue panel falls back to the one it actually publishes.
 */
export type IssueProviderOwner = {
  provider: string;
  pluginId: string;
  panelId?: string | null;
};

export type IssueDeeplinkRouting =
  | PluginDeeplinkRouting
  /**
   * Nobody owns `linear` here, so the compiled Linear surface does. The caller
   * still has to pass `isBuiltinSurfaceVisible("linear", …)` — this says which
   * destination the link named, not that it may be opened.
   */
  | { kind: "builtin-linear"; issueIdentifier: string; branch: string | null };

/**
 * Where an `issue` deeplink goes.
 *
 * Resolution order, and every step is a positive fact:
 *
 * 1. The link names a plugin → that plugin, through the same presence gate as
 *    {@link resolvePluginDeeplinkRouting}. `core` names ADE itself and is not a
 *    plugin, so it is read as naming nobody.
 * 2. The plugin it names is not here, but one is registered as the owner of the
 *    provider → that plugin. A link is minted on one machine and opened on
 *    another, where the same tracker is routinely served by a plugin with a
 *    different id; honouring the local owner is what makes such a link open at
 *    all, and it still passes the same gate.
 * 3. Nobody owns it and the provider is `linear` → the compiled Linear surface,
 *    exactly where `linear-issue` has always gone.
 * 4. Otherwise → refused, under the name of whoever the link asked for. Not the
 *    Marketplace: the reader is told the tracker is not set up here, the same
 *    way a link into an uninstalled plugin panel is answered.
 */
export function resolveIssueDeeplinkRouting(
  target: DeeplinkIssueTarget,
  input: BuiltinGateInput,
  owners: readonly IssueProviderOwner[] = [],
): IssueDeeplinkRouting {
  const provider = target.provider.trim().toLowerCase();
  const named = target.pluginId?.trim() || "";
  const namedPluginId = named && named !== CORE_ISSUE_PLUGIN_ID ? named : null;
  const owner = owners.find((entry) => entry.provider.trim().toLowerCase() === provider) ?? null;
  // The link's own plugin first, the local owner of the provider second.
  const candidates = [namedPluginId, owner?.pluginId ?? null]
    .filter((id): id is string => Boolean(id))
    .filter((id, index, all) => all.indexOf(id) === index);

  if (candidates.length === 0) {
    if (provider === ISSUE_PROVIDER_LINEAR) {
      return {
        kind: "builtin-linear",
        issueIdentifier: target.issueKey,
        branch: target.branch ?? null,
      };
    }
    return { kind: "refuse", title: provider };
  }

  const pluginId = candidates.find((id) => gatedPlugin(id, input)?.enabled) ?? candidates[0];
  const plugin = gatedPlugin(pluginId, input);
  if (!plugin?.enabled) {
    return { kind: "refuse", title: plugin?.displayName || pluginId };
  }
  const panelId = (pluginId === owner?.pluginId ? owner.panelId?.trim() : "")
    || plugin.tabs.find((tab) => tab.panelId === PLUGIN_ISSUE_PANEL_ID)?.panelId
    || plugin.tabs[0]?.panelId
    || "";
  if (!panelId) {
    // Installed, enabled, and publishing nothing to draw the issue in. Refusing
    // beats routing to `?panel=`, which renders an empty plugin shell.
    return { kind: "refuse", title: plugin.displayName || pluginId };
  }
  return resolvePluginDeeplinkRouting(
    { pluginId, panelId, context: issueDeeplinkContext({ ...target, provider }) },
    input,
  );
}
