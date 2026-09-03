import React from "react";

import type { PluginSurfaceContext } from "../../../../shared/plugins/context";
import type { PluginSocketKind } from "../../../../shared/plugins/sockets";
import { useRootAppStore } from "../../../state/appStore";
import { supportsPluginWebviews } from "../PluginWebviewHost";
import { openPluginActionWebview } from "./pluginActionDispatch";
import {
  PLUGIN_SOCKET_WEBVIEW_ACTION_PLACEMENT,
  resolvePluginDeclaredWebview,
} from "./pluginDeclaredWebview";
import { readPluginPromptAnchor } from "./pluginPromptStore";

/**
 * A press on a control that DECLARED a page, as the four action sockets make it.
 *
 * `webviewSurfaceId` on an action button means "pressing me opens this page".
 * Before this, it meant nothing on its own: the page opened only if the action
 * ALSO answered `{openWebview}`, which put the same fact in two places and made
 * the manifest's declaration inert — G15's whole complaint.
 *
 * ## Why the declaration replaces the invoke rather than joining it
 *
 * A declared page opens WITHOUT invoking the action, and that is the design
 * rather than a shortcut. Three reasons, in order of how much they matter:
 *
 * 1. **Double-open.** A plugin whose action still answers `{openWebview}` for
 *    the same surface — which every plugin written before the declaration
 *    existed does — would open the page twice: once here, once when the answer
 *    came back. Worse than twice, actually: the popover store toggles, so the
 *    second open would CLOSE the card the press just opened.
 * 2. **The child may not be running.** Opening a page is the one press that
 *    needs nothing from the plugin's process. Spawning a child to be told to do
 *    what the manifest already said is a cold start the reader waits through
 *    for no answer.
 * 3. **It is what the page is for.** A page reads the plugin's collections and
 *    calls `invoke` itself. The action that used to open it existed to return
 *    `{openWebview}` and nothing else.
 *
 * A contribution that declares NO surface, or one whose id resolves to nothing
 * — uninstalled, disabled, renamed, or a client with no page host — invokes
 * exactly as it always did. That fallback is why an unresolvable id is not an
 * error: the panel and the action were always the cross-client behaviour.
 */

export type PluginDeclaredWebviewPress = {
  /** Which socket the press came from. Decides where the page opens. */
  socket: PluginSocketKind;
  pluginId: string;
  /** The contribution's declared surface, if it declared one. */
  surfaceId?: string | undefined;
  /**
   * The subject the control sat on — the chat, the lane, the row. Host-known
   * and injected into the page unforgeably; null for a surface-only control.
   */
  subject: PluginSurfaceContext | null;
};

/**
 * Open a declared page for a press, or report that there was none to open.
 *
 * Returns `true` when a page opened and the caller must NOT invoke, `false`
 * when the caller should do exactly what it did before this existed.
 */
export function usePluginDeclaredWebviewPress(): (press: PluginDeclaredWebviewPress) => boolean {
  const installedPlugins = useRootAppStore((state) => state.installedPlugins);
  const supported = supportsPluginWebviews();
  return React.useCallback((press: PluginDeclaredWebviewPress): boolean => {
    const placement = PLUGIN_SOCKET_WEBVIEW_ACTION_PLACEMENT[press.socket];
    if (!placement) return false;
    const page = resolvePluginDeclaredWebview({
      pluginId: press.pluginId,
      surfaceId: press.surfaceId,
      installed: installedPlugins,
      supported,
    });
    if (!page) return false;
    openPluginActionWebview({
      pluginId: press.pluginId,
      surfaceId: page.surfaceId,
      placement,
      subject: press.subject,
      // The control that was pressed, read the same way the action path reads
      // it: a press moves focus to the button, so the active element IS the
      // control. Null centres the card, which is the honest rendering of a
      // press that came from no place on screen — a keybinding, a closed menu.
      anchor: readPluginPromptAnchor(),
    });
    return true;
  }, [installedPlugins, supported]);
}
