import {
  hasPluginActionOpenUrlRequest,
  readPluginActionOpenUrl,
} from "../../../shared/plugins/sdk";
import { openExternalUrl } from "../../lib/openExternal";

/**
 * The `{openUrl}` action-result verb, on desktop and in the web client.
 *
 * One implementation for both, because both render plugin panels from the same
 * renderer: `openExternalUrl` hands the URL to the main process on desktop and
 * opens a tab in the browser on the web, so a footer link behaves the same in
 * either place.
 *
 * Every open is logged with the plugin id. The URL comes from the plugin child
 * — code the user installed — so the record of what a plugin sent a reader to
 * is the accountability, and `readPluginActionOpenUrl` is the gate: `https:`
 * only, and nothing else reaches this function.
 *
 * A refused request logs rather than passing silently, for the same reason the
 * composer and webview verbs warn: a control that appears to do nothing reads
 * as a broken plugin.
 */
export function applyPluginActionOpenUrl(
  result: unknown,
  source: { pluginId: string; actionId: string },
): boolean {
  const request = readPluginActionOpenUrl(result);
  if (!request) {
    if (hasPluginActionOpenUrlRequest(result)) {
      console.warn(
        "[plugin openUrl] refused a link that is not an https URL",
        source.pluginId,
        source.actionId,
      );
    }
    return false;
  }
  console.info("[plugin openUrl] opening", source.pluginId, source.actionId, request.url);
  openExternalUrl(request.url);
  return true;
}
