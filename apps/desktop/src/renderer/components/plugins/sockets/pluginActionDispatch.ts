import { showToast } from "../../app/toast/toastStore";
import { navigateToAppTarget } from "../../../lib/openExternal";
import {
  hasPluginActionComposerRequest,
  readPluginActionComposerEdit,
  readPluginActionNavigation,
} from "../../../../shared/plugins/sdk";
import type { PluginSurfaceContext } from "../../../../shared/plugins/context";
import {
  pluginSocketInvokeTimeoutMs,
  type PluginSocketKind,
} from "../../../../shared/plugins/sockets";
import { invokePluginSocketAction } from "./contributionBridge";
import { applyPluginComposerEdit } from "./composerTarget";
import { applyPluginDialogEdit } from "./dialogTarget";

/**
 * One invocation of a plugin action from a socket, response verbs included.
 *
 * A plain function rather than a hook because not every caller is a component:
 * the chat-card action bridge is a window listener installed once for the app,
 * and it has to honour `{navigate}` and `{composer:{…}}` exactly the way a
 * button press does. Two implementations of "what a plugin's answer means"
 * would drift, and the drift would be invisible — one surface honouring a verb
 * another silently drops.
 *
 * Failures surface as a toast rather than a console line: a plugin control that
 * appears to do nothing is indistinguishable from a plugin that is broken, and
 * the person who pressed it is the one who can act on the difference.
 *
 * The returned promise settles when the action and its response verbs are done,
 * so a caller drawing a busy state knows when to stop. It never rejects — the
 * toast is the error path.
 */
export function runPluginSocketAction(
  pluginId: string,
  actionId: string,
  context: PluginSurfaceContext,
  options?: {
    /**
     * Which socket the press came from. Sets the round-trip budget: a
     * `composer-action` that records or transcribes runs for minutes by design,
     * while a button on a row keeps the 60s default.
     */
    socket?: PluginSocketKind;
    /** Explicit budget, for a caller with no socket to name. Host-clamped. */
    timeoutMs?: number;
    /**
     * Extra arguments beside `context`. The one caller today is the chat-card
     * bridge, which sends the card the button belonged to — an action fired
     * from a transcript row has to know which row, and the session context
     * alone cannot say.
     */
    args?: Record<string, unknown>;
  },
): Promise<void> {
  return invokePluginSocketAction(
    pluginId,
    actionId,
    { context, ...(options?.args ?? {}) },
    { timeoutMs: options?.timeoutMs ?? pluginSocketInvokeTimeoutMs(options?.socket) },
  )
    .then((result) => {
      // Applied before navigation, which may take the composer off screen: an
      // action that writes a draft and then opens its own panel should do both,
      // in the order the plugin can predict.
      const edit = readPluginActionComposerEdit(result);
      if (edit) applyPluginComposerEdit(edit, { context, pluginId, actionId });
      else if (hasPluginActionComposerRequest(result)) {
        // The plugin asked and this client refused: a non-string verb, an empty
        // insert, or text over PLUGIN_COMPOSER_TEXT_MAX_BYTES.
        console.warn("[plugin composer] ignored a malformed composer edit", pluginId, actionId);
      }
      // The dialog verb, on the same footing and for the same reason: an
      // invocation made from one of ADE's dialogs may write one allowlisted
      // field of it. `applyPluginDialogEdit` is a no-op for every other
      // context, so this costs a `kind` check on a row menu item.
      applyPluginDialogEdit(result, { context, pluginId, actionId });
      // An action may ask to be followed: "I filed the issue, here it is."
      // Routed through the ordinary navigation target rather than a direct
      // `navigate`, so it passes the same installed-and-enabled gate a `plugin`
      // deeplink does and lands on the same addressable URL.
      const navigation = readPluginActionNavigation(result);
      if (!navigation) return;
      navigateToAppTarget({
        kind: "plugin",
        pluginId,
        panelId: navigation.panelId,
        context: navigation.context ?? null,
      });
    })
    .catch((cause: unknown) => {
      showToast({
        title: "Plugin action failed",
        message: cause instanceof Error ? cause.message : `${pluginId} couldn’t run ${actionId}.`,
        tone: "error",
      });
    });
}
