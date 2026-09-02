import {
  hasPluginActionOpenSettingsRequest,
  PLUGIN_OPEN_SETTINGS_ENTRY_IDS,
  pluginOpenSettingsTarget,
  readPluginActionOpenSettings,
} from "../../../shared/plugins/sdk";
import { navigateToAppTarget } from "../../lib/openExternal";
import { refusePluginAction } from "./pluginActionToast";

/**
 * Longest requested id this quotes back at the reader.
 *
 * The id comes from the plugin child, so it is untrusted length as much as
 * untrusted content. Long enough that every real entry id is quoted whole,
 * short enough that a runaway string cannot become the toast.
 */
const REQUESTED_ENTRY_ID_MAX_CHARS = 60;

/**
 * The id a result ASKED for, whether or not the closed list allows it.
 *
 * `readPluginActionOpenSettings` answers null for an unknown id and cannot say
 * which one, because its whole job is to refuse a guess. The refusal message
 * needs the word the plugin used — "billing.plans" is what its author has to
 * search for — so the raw read lives here, mirroring the same two accepted
 * shapes, and never reaches the navigation.
 */
function requestedOpenSettingsEntryId(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const request = (result as { openSettings?: unknown }).openSettings;
  const raw = typeof request === "string"
    ? request
    : typeof request === "object" && request !== null
        && typeof (request as { entryId?: unknown }).entryId === "string"
      ? (request as { entryId: string }).entryId
      : "";
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, REQUESTED_ENTRY_ID_MAX_CHARS);
}

/**
 * The `{openSettings}` action-result verb, on desktop and in the web client.
 *
 * One implementation for both, because both render plugin panels from the same
 * renderer. The destination is a closed host settings page, not a URL: ADE's
 * own Settings surface, through the same `kind: "settings"` target the
 * attention popover already uses.
 *
 * **A refused id is said out loud, not only logged.** The console line is the
 * record for whoever wrote the plugin; the reader who pressed the button is a
 * different person with a different question, and to them a press that opens
 * nothing is indistinguishable from a plugin that crashed. The phone and the
 * terminal have said so since the verb existed — they have no settings page at
 * all and answer with a refusal — so desktop and web staying silent made the
 * one client that CAN open the page the only one that would not admit when it
 * would not. The message names the plugin, the id it asked for, and the ids
 * that exist, because the author is usually the reader on a machine that just
 * ran their own plugin.
 *
 * Known ids are untouched: the closed list still decides, and an unknown one
 * still opens nothing rather than a guessed page.
 */
export function applyPluginActionOpenSettings(
  result: unknown,
  source: { pluginId: string; actionId: string },
): boolean {
  const request = readPluginActionOpenSettings(result);
  if (!request) {
    if (hasPluginActionOpenSettingsRequest(result)) {
      const asked = requestedOpenSettingsEntryId(result);
      console.warn(
        "[plugin openSettings] refused a settings page this build does not open",
        source.pluginId,
        source.actionId,
        asked,
      );
      refusePluginAction(
        source.pluginId,
        source.actionId,
        asked
          ? `There is no “${asked}” settings page. ADE opens ${PLUGIN_OPEN_SETTINGS_ENTRY_IDS.join(" and ")}.`
          : `That settings page has no name. ADE opens ${PLUGIN_OPEN_SETTINGS_ENTRY_IDS.join(" and ")}.`,
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
