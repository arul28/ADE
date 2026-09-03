import {
  resolveSettingsHash,
  resolveSettingsTab,
  type SettingsTabId,
} from "../../settings/settingsManifest";

/**
 * Which settings page a `settings-section` lands on.
 *
 * Its own module, and not because it is long. Two things need the answer and
 * they must not import each other: the component that DRAWS the sections, and
 * the `{openSettings}` verb that sends a reader to the page one of them is on.
 * The verb module is reached from `PluginPanelHost`, which the component
 * mounts, so a function living in the component would close that ring.
 */

/**
 * Where a section lands when it names no page, or names one this build has
 * never heard of.
 *
 * General rather than a page of its own. A "Plugins" settings *tab* would be
 * empty on every install that has no plugin contributing to settings, which is
 * almost all of them, and an always-present tab that is usually blank teaches
 * the user to stop opening it. A group at the foot of the first page is present
 * exactly when something is in it.
 */
export const PLUGIN_SETTINGS_FALLBACK_TAB: SettingsTabId = "general";

/**
 * The anchor every contributed settings section shares.
 *
 * One anchor for the group rather than one per section, and that is the honest
 * granularity: the sections a plugin contributes to a page are drawn together
 * under a single "FROM PLUGINS" heading, so the group IS where a section is.
 * Exported so the component that stamps it and the verb that navigates to it
 * cannot spell it differently.
 */
export const PLUGIN_SETTINGS_SECTIONS_ANCHOR = "plugin-sections";

/**
 * Resolve a payload's `section` to a real settings page.
 *
 * Three passes, widest to narrowest, because a plugin author has three
 * plausible mental models of "which settings page" and all three should work:
 * the tab id (`integrations`), a tab id ADE has since renamed (`github`, which
 * the manifest's legacy aliases still resolve), and the anchor of a specific
 * card (`github-connection`) — the last being what `settingsRouteFor` produces,
 * so a plugin that copied a route out of a deeplink lands somewhere sensible.
 *
 * Anything else falls back rather than failing to parse, which is the promise
 * `PluginSettingsSectionPayload` makes: settings page ids are ADE's own
 * furniture and they move, and a plugin should not disappear when they do.
 */
export function resolvePluginSettingsTab(section: string | undefined): SettingsTabId {
  if (!section) return PLUGIN_SETTINGS_FALLBACK_TAB;
  return resolveSettingsTab(section)
    ?? resolveSettingsHash(section)?.tab
    ?? PLUGIN_SETTINGS_FALLBACK_TAB;
}

/**
 * The DOM id one contributed section carries.
 *
 * The group anchor above is what a `{openSettings: {socketId}}` navigates to,
 * because that is the granularity the settings page's own scroll machinery
 * works at. This is the finer half: with the group on screen, the verb scrolls
 * the named section into view, so a plugin drawing three sections on the same
 * page lands the reader on the one it asked for rather than on the heading.
 *
 * Both ids come from values the manifest parser has already bounded — a plugin
 * id and a socket id — so nothing here has to escape anything.
 */
export function pluginSettingsSectionDomId(pluginId: string, socketId: string): string {
  return `plugin-section-${pluginId}-${socketId}`;
}
