import {
  hasPluginActionOpenSettingsRequest,
  PLUGIN_OPEN_SETTINGS_ENTRY_IDS,
  pluginOpenSettingsTarget,
  readPluginActionOpenSettings,
} from "../../../shared/plugins/sdk";
import { navigateToAppTarget } from "../../lib/openExternal";
import { refusePluginAction } from "./pluginActionToast";
import { derivedSetFor, rowsStoreFor, sourcesStore } from "./sockets/contributionStores";
import { selectContributions } from "./sockets/contributionModel";
import {
  PLUGIN_SETTINGS_SECTIONS_ANCHOR,
  pluginSettingsSectionDomId,
  resolvePluginSettingsTab,
} from "./sockets/pluginSettingsTab";
import type { PluginSurfaceOnlyContext } from "../../../shared/plugins/context";

/** The context a `settings-section` is published and selected against. */
const SETTINGS_CONTEXT: PluginSurfaceOnlyContext = { kind: "surface", surface: "settings" };

/**
 * How long the verb waits for the settings page to draw before scrolling.
 *
 * The navigation is a route change, so the section does not exist in the DOM at
 * the moment this function returns. A frame is not enough on a page that mounts
 * ten tabs' worth of controls; a poll for a short window is, and it costs
 * nothing when the element is there on the first look.
 */
const SECTION_SCROLL_WINDOW_MS = 8_000;
const SECTION_SCROLL_INTERVAL_MS = 60;

/**
 * The plugin's own published `settings-section` contributions, right now.
 *
 * Read off the same module-level stores the settings page itself selects from,
 * so "this section exists" cannot mean one thing to the verb and another to the
 * page it navigates to. A surface nobody has revealed yet reads empty, and an
 * empty read is a refusal rather than a guess — sending a reader to a page with
 * no section on it is worse than telling them why nothing happened.
 */
function ownSettingsSections(pluginId: string) {
  const sources = sourcesStore.getSnapshot().sources;
  const rows = rowsStoreFor("settings").getSnapshot().rows;
  const set = derivedSetFor("settings", sources, rows);
  return selectContributions(set, "settings-section", SETTINGS_CONTEXT)
    .filter((contribution) => contribution.pluginId === pluginId);
}

/**
 * Scroll the named section into view once the settings page has drawn it.
 *
 * Best-effort by design. The anchor has already put the reader on the right
 * page and the right group, so a section that never appears — the page was
 * navigated away from, the plugin republished without it — costs a scroll that
 * did not happen rather than a destination that was wrong.
 */
function scrollToSectionWhenDrawn(domId: string): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const deadline = Date.now() + SECTION_SCROLL_WINDOW_MS;
  const look = (): boolean => {
    const element = document.getElementById(domId);
    if (!element) return false;
    element.scrollIntoView({ block: "start", behavior: "smooth" });
    return true;
  };
  if (look()) return;
  const observer = typeof MutationObserver === "function"
    ? new MutationObserver(() => {
      if (look() || Date.now() >= deadline) observer?.disconnect();
    })
    : null;
  observer?.observe(document.documentElement, { childList: true, subtree: true });
  const tick = (): void => {
    if (look() || Date.now() >= deadline) {
      observer?.disconnect();
      return;
    }
    window.setTimeout(tick, SECTION_SCROLL_INTERVAL_MS);
  };
  tick();
}

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
          ? `There is no “${asked}” settings page. ADE opens ${PLUGIN_OPEN_SETTINGS_ENTRY_IDS.join(" and ")}, or one of this plugin's own settings sections.`
          : `That settings page has no name. ADE opens ${PLUGIN_OPEN_SETTINGS_ENTRY_IDS.join(" and ")}, or one of this plugin's own settings sections.`,
      );
    }
    return false;
  }
  if (request.kind === "socket") {
    // Scoped to the caller's OWN socket, and the scope is the whole design.
    // `{openSettings}` was a closed list because it leaves the plugin's surface
    // for ADE's; this shape leaves it for a page the plugin is already drawn
    // on, so there is nothing to close — as long as the section it names is one
    // it published itself. A plugin naming another plugin's socket, or one it
    // never published, is refused out loud like any other unknown id.
    const section = ownSettingsSections(source.pluginId)
      .find((contribution) => contribution.id === request.socketId);
    if (!section) {
      console.warn(
        "[plugin openSettings] refused a settings section this plugin has not published",
        source.pluginId,
        source.actionId,
        request.socketId,
      );
      refusePluginAction(
        source.pluginId,
        source.actionId,
        `It asked for its “${request.socketId.slice(0, REQUESTED_ENTRY_ID_MAX_CHARS)}” settings section, which it hasn’t put on a settings page.`,
      );
      return false;
    }
    const tab = resolvePluginSettingsTab(section.payload.section);
    console.info(
      "[plugin openSettings] opening own section",
      source.pluginId,
      source.actionId,
      request.socketId,
      tab,
    );
    navigateToAppTarget({
      kind: "settings",
      tab,
      anchor: PLUGIN_SETTINGS_SECTIONS_ANCHOR,
    });
    scrollToSectionWhenDrawn(pluginSettingsSectionDomId(source.pluginId, section.id));
    return true;
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
