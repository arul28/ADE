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
import { PluginWebviewHost, supportsPluginWebviews } from "../PluginWebviewHost";
import { useRootAppStore } from "../../../state/appStore";
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
  // The registry, for resolving a section's `webviewSurfaceId` to a page. Read
  // once here rather than per section.
  const installedPlugins = useRootAppStore((state) => state.installedPlugins);

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
              <PluginSettingsSectionBody
                pluginId={contribution.pluginId}
                panelId={contribution.payload.panelId}
                webviewSurfaceId={contribution.payload.webviewSurfaceId ?? null}
                installedPlugins={installedPlugins}
                active={active}
              />
            </section>
          </SocketBoundary>
        );
      })}
    </div>
  );
}


/**
 * The tallest a settings section's page is drawn before it scrolls inside.
 *
 * A page in a settings section is the one placement with no frame of its own:
 * every other host gives the guest a box it fills, and this one sizes itself to
 * what the page says it needs. `PluginWebviewHost` already caps the number the
 * page reports; this is the floor-and-default half — a section that has not
 * reported yet gets a readable box rather than a zero-height gap.
 */
export const PLUGIN_SETTINGS_SECTION_DEFAULT_HEIGHT = 240;
export const PLUGIN_SETTINGS_SECTION_MIN_HEIGHT = 120;

/**
 * One section's body: the plugin's own page, or the panel it falls back to.
 *
 * The fallback is not a degradation and is not announced as one. A
 * `settings-section` names a `panelId` and MAY name a `webviewSurfaceId`; the
 * panel is what the manifest promised every client would draw, and a host that
 * can draw the page draws the page. Nothing here tells the reader they are
 * looking at the second-best rendering, because on a client without a page host
 * they are looking at the only one.
 *
 * Split out of the mapped body so the height state belongs to ONE section. Held
 * in the parent's map it would have been one number shared by every plugin's
 * section on the page, and the tallest page would have set the height of them
 * all.
 */
function PluginSettingsSectionBody({
  pluginId,
  panelId,
  webviewSurfaceId,
  installedPlugins,
  active,
}: {
  pluginId: string;
  panelId: string;
  webviewSurfaceId: string | null;
  installedPlugins: readonly { pluginId: string; enabled: boolean; tabs: readonly { id: string; kind?: string; entryHtml?: string | null }[] }[];
  active: boolean;
}) {
  const [height, setHeight] = React.useState<number | null>(null);

  const entryHtml = React.useMemo(() => {
    if (!webviewSurfaceId || !supportsPluginWebviews()) return null;
    const plugin = installedPlugins.find((entry) => entry.pluginId === pluginId);
    if (!plugin?.enabled) return null;
    const surface = plugin.tabs.find((tab) => tab.id === webviewSurfaceId);
    return surface?.kind === "webview" ? surface.entryHtml ?? null : null;
  }, [installedPlugins, pluginId, webviewSurfaceId]);

  if (!entryHtml) {
    return (
      <PluginPanelHost
        pluginId={pluginId}
        panelId={panelId}
        active={active}
        surfaceContext={SETTINGS_CONTEXT}
      />
    );
  }

  return (
    <div
      style={{
        display: "flex",
        minHeight: 0,
        height: Math.max(
          PLUGIN_SETTINGS_SECTION_MIN_HEIGHT,
          height ?? PLUGIN_SETTINGS_SECTION_DEFAULT_HEIGHT,
        ),
      }}
    >
      <PluginWebviewHost
        pluginId={pluginId}
        entryHtml={entryHtml}
        active={active}
        placement="settings-section"
        surfaceId={webviewSurfaceId}
        onContentHeight={setHeight}
        context={{ subject: SETTINGS_CONTEXT }}
      />
    </div>
  );
}
