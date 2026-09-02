import { showToast } from "../app/toast/toastStore";
import { readPluginActionMessage } from "../../../shared/plugins/sdk";
import { rootAppStoreApi } from "../../state/appStore";

/**
 * The plugin's name as the reader knows it, or its id when nothing knows better.
 *
 * The toast is the plugin talking, and the reader pressed a control carrying the
 * plugin's label — so a machine with four plugins installed must not be told
 * only that "a plugin" refused.
 */
export function pluginDisplayName(pluginId: string): string {
  return rootAppStoreApi.getState().installedPlugins
    .find((entry) => entry.pluginId === pluginId)?.displayName ?? pluginId;
}

/**
 * One sentence from a plugin action, drawn where a socket has no inline place.
 *
 * A panel draws `{message}` inline (`PluginPanelHost`); a button on a row, a
 * chat card or the composer has nowhere to put it, so it becomes a toast. The
 * title convention is shared with {@link refusePluginAction} on purpose: every
 * refusal a press produces reads the same way, whether the sentence came from
 * the plugin or from ADE saying it could not honour what the plugin asked.
 *
 * Lives here rather than beside either caller because both `pluginActionDispatch`
 * and `pluginActionOpenSettings` need it and the first already imports the
 * second — putting it in the dispatcher would make that pair a cycle.
 */
export function showPluginActionMessage(
  result: unknown,
  pluginId: string,
  actionId: string,
): boolean {
  const message = readPluginActionMessage(result);
  if (!message) return false;
  const displayName = pluginDisplayName(pluginId);
  showToast({
    title: message.ok ? displayName : `${displayName} couldn’t do that`,
    message: message.text,
    tone: message.ok ? "info" : "error",
    id: `plugin-action-message:${pluginId}:${actionId}`,
  });
  return true;
}

/**
 * ADE's own refusal, when a press asked for something this client cannot do.
 *
 * The counterpart to {@link showPluginActionMessage}: same title, opposite
 * author. A console line is the record for whoever wrote the plugin; it is not
 * an answer for the person who pressed the button and is watching nothing
 * happen, which is indistinguishable from a plugin that crashed.
 */
export function refusePluginAction(
  pluginId: string,
  actionId: string,
  reason: string,
): void {
  showToast({
    title: `${pluginDisplayName(pluginId)} couldn’t do that`,
    message: reason,
    tone: "error",
    id: `plugin-action-refused:${pluginId}:${actionId}`,
  });
}
