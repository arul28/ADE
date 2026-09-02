import {
  hasPluginActionOpenSettingsRequest,
  pluginOpenSettingsTarget,
  readPluginActionOpenSettings,
} from "../../../shared/plugins/sdk";
import { navigateToAppTarget } from "../../lib/openExternal";

/**
 * The `{openSettings}` action-result verb, on desktop and in the web client.
 *
 * One implementation for both, because both render plugin panels from the same
 * renderer. The destination is a closed host settings page, not a URL: ADE's
 * own Settings surface, through the same `kind: "settings"` target the
 * attention popover already uses.
 *
 * A refused request logs rather than passing silently, for the same reason the
 * `{openUrl}` verb warns: a control that appears to do nothing reads as a
 * broken plugin.
 */
export function applyPluginActionOpenSettings(
  result: unknown,
  source: { pluginId: string; actionId: string },
): boolean {
  const request = readPluginActionOpenSettings(result);
  if (!request) {
    if (hasPluginActionOpenSettingsRequest(result)) {
      console.warn(
        "[plugin openSettings] refused a settings page this build does not open",
        source.pluginId,
        source.actionId,
      );
    }
    return false;
  }
  const target = pluginOpenSettingsTarget(request.entryId);
  console.info(
    "[plugin openSettings] opening",
    source.pluginId,
    source.actionId,
    request.entryId,
  );
  navigateToAppTarget({
    kind: "settings",
    tab: target.tab,
    anchor: target.anchor,
  });
  return true;
}
