import React from "react";

import { COLORS, RADII, SANS_FONT, SECTION_LABEL_STYLE } from "../../lanes/laneDesignTokens";
import type { SettingsTabId } from "../../settings/settingsManifest";
import {
  PLUGIN_SETTINGS_FALLBACK_TAB,
  PLUGIN_SETTINGS_SECTIONS_ANCHOR,
  pluginSettingsSectionDomId,
  resolvePluginSettingsTab,
} from "./pluginSettingsTab";
import type { PluginSurfaceOnlyContext } from "../../../../shared/plugins/context";
import { PluginPanelHost } from "../PluginPanelHost";
import { contributionKey } from "./contributionModel";
import { SocketBoundary } from "./SocketBoundary";
import { SocketIcon } from "./socketUi";
import { brandIconsProp, usePluginBrandIcons } from "./usePluginBrandIcons";
import { usePluginSurfaceContributions, useSurfaceContributions } from "./useSurfaceContributions";

/**
 * The `settings-section` socket: a plugin's panel as a section on a settings
 * page.
 *
 * A plugin has had its own settings since `manifest.settings[]` — a form on its
 * marketplace page. What it has not had is a way to be found where the user
 * looks for settings, which is the settings page. This closes that: a Jira
 * plugin's connection panel appears under Integrations beside GitHub and
 * Linear, rather than three clicks away behind a plugin detail page.
 *
 * The anchor `section` is an opaque string, and the resolution below is why the
 * taxonomy could afford to make it one — see {@link resolvePluginSettingsTab}.
 */

/**
 * The page a section lands on, and the fallback it lands on when it names none.
 *
 * Re-exported rather than defined here: they moved to `pluginSettingsTab.ts` so
 * the `{openSettings}` verb could reach them without importing this component,
 * which mounts `PluginPanelHost`, which reaches the verb. Every existing caller
 * keeps its import.
 */
export {
  PLUGIN_SETTINGS_FALLBACK_TAB,
  PLUGIN_SETTINGS_SECTIONS_ANCHOR,
  pluginSettingsSectionDomId,
  resolvePluginSettingsTab,
};

const SETTINGS_CONTEXT: PluginSurfaceOnlyContext = { kind: "surface", surface: "settings" };

/**
 * Contributed sections for one settings page, after the page's own.
 *
 * Mounted once per page rather than once per group: a settings page renders one
 * tab at a time, so this component is asked for its own tab's sections and
 * renders nothing on the other nine.
 */
export function PluginSettingsSections({
  tab,
  active = true,
}: {
  tab: SettingsTabId;
  /** False while the settings page is mounted but not visible. */
  active?: boolean;
}) {
  const all = useSurfaceContributions("settings", "settings-section", {
    active,
    context: SETTINGS_CONTEXT,
  });
  const { identities } = usePluginSurfaceContributions("settings", active);
  // The plugin's OWN brand artwork, which the identity row cannot carry: a
  // `brand:*` token a plugin ships arrives with the package, so the closed
  // compiled catalogue has never heard of it. Without this the header drew the
  // puzzle piece for exactly the plugins that took the trouble to ship a mark,
  // while the tab rail beside it drew the mark — see `pluginIcons.tsx`.
  const brandIconsFor = usePluginBrandIcons();

  const contributions = React.useMemo(
    () => all.filter((entry) => resolvePluginSettingsTab(entry.payload.section) === tab),
    [all, tab],
  );

  if (contributions.length === 0) return null;

  return (
    <div
      // `data-settings-anchor` is what the page's search filter hides and shows.
      // The id is not a manifest anchor and never matches a query, so searching
      // settings hides contributed sections — which is right: a search for
      // "theme" should not turn up a plugin panel that merely happens to be on
      // the page. Without the attribute the filter would skip this block and
      // leave it standing alone under an otherwise-emptied page.
      data-settings-anchor={PLUGIN_SETTINGS_SECTIONS_ANCHOR}
      data-settings-group="plugins"
      data-tour="plugin:settings.settings-section"
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      <header style={{ ...SECTION_LABEL_STYLE, color: COLORS.textMuted }}>FROM PLUGINS</header>
      {contributions.map((contribution) => {
        const identity = identities.get(contribution.pluginId);
        const name = identity?.displayName ?? contribution.pluginId;
        const title = contribution.payload.title ?? name;
        const brandIcons = brandIconsFor(contribution.pluginId);
        return (
          <SocketBoundary key={contributionKey(contribution)}>
            <section
              id={pluginSettingsSectionDomId(contribution.pluginId, contribution.id)}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 10,
                padding: 14,
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.borderMuted}`,
                borderRadius: RADII.md,
              }}
            >
              <header
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontFamily: SANS_FONT,
                  fontSize: 12,
                  color: COLORS.textMuted,
                }}
              >
                <SocketIcon
                  name={identity?.icon ?? undefined}
                  {...brandIconsProp(brandIcons)}
                  size={12}
                  color={COLORS.textMuted}
                />
                <span style={{ fontWeight: 600, color: COLORS.textSecondary }}>{title}</span>
                {title === name ? null : <span style={{ opacity: 0.7 }}>· {name}</span>}
              </header>
              <PluginPanelHost
                pluginId={contribution.pluginId}
                panelId={contribution.payload.panelId}
                active={active}
                surfaceContext={SETTINGS_CONTEXT}
              />
            </section>
          </SocketBoundary>
        );
      })}
    </div>
  );
}
