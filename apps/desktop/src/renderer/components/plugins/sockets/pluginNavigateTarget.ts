/**
 * Where a `{navigate}` from a socket press actually goes.
 *
 * Pure, and separate from the dispatcher, because the decision has four inputs
 * that arrive from four different places — the plugin's answer, the socket the
 * press came from, the installed registry, and the Work rail's own contribution
 * list — and every one of them is worth a test that does not mount a chat.
 *
 * ## The rule, and why the default is not the tab
 *
 * A plugin names a panel. It does not name a place, because it cannot: the
 * desktop has a Work tools rail, iOS and the terminal do not, and a manifest
 * that hard-coded one would be wrong on three clients out of four. So the client
 * decides, and the decision follows the press:
 *
 * - A press from INSIDE a conversation — `chat-header-action`, `composer-action`
 *   — opens the plugin's Work pane, when the plugin declares one that draws this
 *   panel. That is what "open the stories panel without leaving the chat" means,
 *   and routing it to `/plugin/<id>` instead took the whole tab away from the
 *   conversation the button sat above.
 * - Every other press keeps the tab route, which is where a toolbar button, a
 *   palette command or a row menu item has always sent people.
 * - `target` on the navigation overrides both, in either direction.
 *
 * ## Refusing is an answer
 *
 * The other half of this module is the one the alpha run needed most: a
 * navigation that CANNOT land says so. A panel id no manifest declares, a plugin
 * that was uninstalled between the press and the answer, a plugin the reader
 * switched off — each of those used to change nothing on screen, which is
 * indistinguishable from a plugin that silently failed. They resolve to
 * {@link PluginNavigateUnreachable} here and the dispatcher says it out loud.
 *
 * Both refusals are deliberately skippable, and for the same reason: "we do not
 * know yet" must never read as "it is not there". `registryLoaded` false and
 * `declaredPanelIds` null each mean "do not judge", and the navigation takes the
 * route it has always taken. Refusing a perfectly good press because a read had
 * not landed yet would be a worse bug than the silence this replaces — it is the
 * same rule the compiled surfaces state at length in `builtinTabs.ts`, arrived at
 * from the opposite direction.
 */

import type { PluginActionNavigation } from "../../../../shared/plugins/sdk";
import type { PluginSocketKind } from "../../../../shared/plugins/sockets";
import { pluginPanelSlotId } from "./panelSlotId";

/**
 * Sockets whose press happens inside a conversation.
 *
 * The two that receive a chat rather than a tab (`sockets.ts` and the context
 * table in the plugin skill). They are the whole reason `target` exists: a
 * button here belongs to the chat it sits on, so the panel it opens should too.
 */
export const PLUGIN_CHAT_SCOPED_SOCKETS: readonly PluginSocketKind[] = [
  "chat-header-action",
  "composer-action",
];

export function isPluginChatScopedSocket(socket: PluginSocketKind | undefined): boolean {
  return socket !== undefined && PLUGIN_CHAT_SCOPED_SOCKETS.includes(socket);
}

/** Open the plugin's pane in the Work tools rail, beside the conversation. */
export type PluginNavigateToolsPane = {
  kind: "tools-pane";
  pluginId: string;
  panelId: string;
  /** `plugin:<pluginId>:<panelId>` — what the rail persists as its selected tab. */
  slotId: string;
  context: Record<string, unknown> | null;
};

/** Open `/plugin/<id>?panel=…`, the addressable route a deeplink also produces. */
export type PluginNavigateTab = {
  kind: "tab";
  pluginId: string;
  panelId: string;
  context: Record<string, unknown> | null;
};

/** Nothing can mount. `reason` is written for the person who pressed the button. */
export type PluginNavigateUnreachable = {
  kind: "unreachable";
  pluginId: string;
  panelId: string;
  /** The plugin's own name where the registry knows it, else its id. */
  displayName: string;
  reason: string;
};

export type PluginNavigateResolution =
  | PluginNavigateToolsPane
  | PluginNavigateTab
  | PluginNavigateUnreachable;

/** As much of an installed plugin as this decision needs. */
export type PluginNavigatePluginInput = {
  displayName: string;
  enabled: boolean;
  /** `panelId` of every `tab` / `webview` surface the host serves for it. */
  surfacePanelIds: readonly string[];
};

export type PluginNavigateInput = {
  pluginId: string;
  navigation: PluginActionNavigation;
  /** The socket the press came from. Absent behaves as a non-chat press. */
  socket?: PluginSocketKind;
  /**
   * False until the plugin registry has resolved once.
   *
   * Load-bearing: `installedPlugins` is an empty array before the first read
   * lands, so without this a press made in that window would be refused with
   * "it isn't installed" about a plugin that plainly is.
   */
  registryLoaded: boolean;
  /** Null when the resolved registry has no such plugin. */
  plugin: PluginNavigatePluginInput | null;
  /** Panel ids this plugin draws in the Work tools rail, right now. */
  railPanelIds: readonly string[];
  /**
   * Every panel id the manifest declares, or null when nobody could read it.
   * Null disables the unknown-panel refusal; it never invents one.
   */
  declaredPanelIds: readonly string[] | null;
};

export function resolvePluginNavigateTarget(
  input: PluginNavigateInput,
): PluginNavigateResolution {
  const { navigation, pluginId, plugin, railPanelIds, declaredPanelIds } = input;
  const panelId = navigation.panelId;
  const context = navigation.context ?? null;
  const displayName = plugin?.displayName || pluginId;

  if (!input.registryLoaded) {
    // Nothing is known yet. Route the way ADE always has and say nothing.
    return { kind: "tab", pluginId, panelId, context };
  }
  if (!plugin) {
    return {
      kind: "unreachable",
      pluginId,
      panelId,
      displayName,
      reason: "It isn’t installed on this computer any more.",
    };
  }
  if (!plugin.enabled) {
    return {
      kind: "unreachable",
      pluginId,
      panelId,
      displayName,
      reason: "It’s switched off. Turn it back on from the Marketplace.",
    };
  }

  const inRail = railPanelIds.includes(panelId);
  // A surface or a rail pane naming this panel is proof it exists whatever the
  // manifest read said, so both count before the declared list is consulted.
  const known = inRail
    || plugin.surfacePanelIds.includes(panelId)
    || declaredPanelIds === null
    || declaredPanelIds.includes(panelId);
  if (!known) {
    return {
      kind: "unreachable",
      pluginId,
      panelId,
      displayName,
      reason: `It asked for a panel called “${panelId}”, which it doesn’t have.`,
    };
  }

  // Explicit beats derived; derived prefers the rail only for a press that
  // happened inside a conversation, and only where the rail can actually draw
  // this panel. Everything else is the tab route, which is always reachable for
  // an installed and enabled plugin.
  const wants = navigation.target
    ?? (isPluginChatScopedSocket(input.socket) && inRail ? "tools-pane" : "tab");
  if (wants === "tools-pane" && inRail) {
    return {
      kind: "tools-pane",
      pluginId,
      panelId,
      slotId: pluginPanelSlotId(pluginId, panelId),
      context,
    };
  }
  return { kind: "tab", pluginId, panelId, context };
}
