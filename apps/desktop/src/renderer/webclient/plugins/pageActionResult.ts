/**
 * What a plugin page's `invoke` answer MEANS, applied to the hosted web client.
 *
 * A socket press already gets this: `runPluginSocketAction` invokes the action
 * and then walks the control-flow verbs a handler may answer with — a message,
 * a composer edit, a dialog field, an overlay, a link, a settings destination, a
 * sign-in, a navigation, a question. A page calling `adePlugin.invoke` is the
 * same handler answering the same shapes, so it gets the same walk; without it
 * a plugin that returns `{navigate}` from a page does nothing, while the same
 * handler pressed from a socket moves the app.
 *
 * This applies the verbs and returns the question, if the handler asked one. The
 * prompt hop belongs to the caller because only the caller can re-invoke and
 * hand the SECOND result back to the page — the page is waiting on a promise
 * that must resolve to what the action finally returned, not to the question.
 *
 * The order is `runPluginSocketAction`'s, deliberately and to the letter. Two
 * readings of a plugin's answer that differ by one verb's position is exactly
 * the drift that module's own header warns about, and the fix is to collapse
 * both into one exported applier the moment the desktop relay grows its
 * `actionResult` handler — see the note in the platform report.
 */

import type { PluginSurfaceContext } from "../../../shared/plugins/context";
import {
  hasPluginActionComposerRequest,
  hasPluginActionPromptRequest,
  hasPluginActionWebviewRequest,
  readPluginActionComposerEdit,
  readPluginActionNavigation,
  readPluginActionPrompt,
  readPluginActionWebview,
  type PluginActionPrompt,
} from "../../../shared/plugins/sdk";
import { showPluginActionMessage } from "../../components/plugins/pluginActionToast";
import { applyPluginActionAuthSession } from "../../components/plugins/pluginActionAuthSession";
import { applyPluginActionOpenSettings } from "../../components/plugins/pluginActionOpenSettings";
import { applyPluginActionOpenUrl } from "../../components/plugins/pluginActionOpenUrl";
import { applyPluginComposerEdit } from "../../components/plugins/sockets/composerTarget";
import { applyPluginDialogEdit } from "../../components/plugins/sockets/dialogTarget";
import {
  applyPluginActionNavigation,
} from "../../components/plugins/sockets/pluginActionDispatch";
import { openPluginWebviewOverlay } from "../../components/plugins/sockets/pluginWebviewOverlayStore";
import { rootAppStoreApi } from "../../state/appStore";

export type PluginPageAnswerSource = {
  pluginId: string;
  actionId: string;
  /** The subject the page is attached to. Null for a full tab. */
  context: PluginSurfaceContext | null;
  /**
   * True when this result is already the answer to a question. One hop: a
   * second `{prompt}` is dropped rather than asked, so a plugin cannot build a
   * wizard out of the verb or trap the reader in a loop.
   */
  answeringPrompt: boolean;
};

/**
 * Apply every verb but the question; report the question.
 *
 * Never throws: a page's promise resolves with what the handler returned even
 * when one verb could not be honoured on this client, the same way a socket
 * press draws its result even when the navigation had nowhere to go.
 */
export function applyPluginPageActionAnswers(
  result: unknown,
  source: PluginPageAnswerSource,
): { prompt: PluginActionPrompt | null } {
  const { pluginId, actionId, context } = source;
  showPluginActionMessage(result, pluginId, actionId);

  const edit = readPluginActionComposerEdit(result);
  if (edit) applyPluginComposerEdit(edit, { context, pluginId, actionId });
  else if (hasPluginActionComposerRequest(result)) {
    console.warn("[plugin page composer] ignored a malformed composer edit", pluginId, actionId);
  }

  applyPluginDialogEdit(result, { context, pluginId, actionId });

  const overlay = readPluginActionWebview(result);
  if (overlay) {
    const plugin = rootAppStoreApi.getState().installedPlugins.find((entry) => entry.pluginId === pluginId);
    const surfaceExists = plugin?.enabled && plugin.tabs.some((tab) => tab.id === overlay.surfaceId);
    if (surfaceExists) {
      openPluginWebviewOverlay({
        pluginId,
        surfaceId: overlay.surfaceId,
        subject: context,
        ...(overlay.context ? { pointer: overlay.context } : {}),
      });
    } else {
      console.warn("[plugin page webview] openWebview named an unknown surface", pluginId, overlay.surfaceId);
    }
  } else if (hasPluginActionWebviewRequest(result)) {
    console.warn("[plugin page webview] ignored a malformed openWebview request", pluginId, actionId);
  }

  applyPluginActionOpenUrl(result, { pluginId, actionId });
  const openedSettings = applyPluginActionOpenSettings(result, { pluginId, actionId });
  applyPluginActionAuthSession(result, { pluginId, actionId });

  const navigation = openedSettings ? null : readPluginActionNavigation(result);
  if (navigation) {
    applyPluginActionNavigation(navigation, { pluginId, context, anchor: null });
  }

  if (source.answeringPrompt) return { prompt: null };
  const prompt = readPluginActionPrompt(result);
  if (!prompt) {
    if (hasPluginActionPromptRequest(result)) {
      console.warn("[plugin page prompt] ignored a malformed prompt", pluginId, actionId);
    }
    return { prompt: null };
  }
  return { prompt };
}
