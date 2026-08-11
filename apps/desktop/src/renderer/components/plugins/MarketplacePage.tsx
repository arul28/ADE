import React from "react";

import { COLORS, RADII, SANS_FONT } from "../lanes/laneDesignTokens";
import { useRootAppStore } from "../../state/appStore";
import { pluginIcon } from "./pluginIcons";

/**
 * Route placeholder for the Marketplace.
 *
 * The gallery, detail view, install flow and machine-coverage rail are a later
 * wave. This exists so `/marketplace` is a real route from the moment the nav
 * entry appears — a nav item that leads to a 404 is worse than no nav item —
 * and it says plainly what it is rather than pretending to be under
 * construction. It lists what is installed, which is the one thing it can
 * answer honestly today.
 */
export function MarketplacePage() {
  const plugins = useRootAppStore((state) => state.installedPlugins);
  const refreshInstalledPlugins = useRootAppStore((state) => state.refreshInstalledPlugins);

  React.useEffect(() => {
    void refreshInstalledPlugins();
  }, [refreshInstalledPlugins]);

  return (
    <div style={{ height: "100%", minHeight: 0, overflow: "auto" }} data-tour="plugin:marketplace.page">
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "28px 20px", display: "grid", gap: 20 }}>
        <div style={{ display: "grid", gap: 6 }}>
          <h1
            style={{
              margin: 0,
              fontFamily: SANS_FONT,
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: "-0.015em",
              color: COLORS.textPrimary,
            }}
          >
            Marketplace
          </h1>
          <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
            Browsing and installing arrive with the plugin directory. Plugins already on this machine
            are listed below.
          </p>
        </div>

        {plugins.length === 0 ? (
          <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textDim }}>
            No plugins installed.
          </p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 2 }}>
            {plugins.map((plugin) => {
              const Icon = pluginIcon(plugin.icon);
              return (
                <li
                  key={plugin.pluginId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 12px",
                    border: `1px solid ${COLORS.borderMuted}`,
                    borderRadius: RADII.md,
                    background: COLORS.recessedBg,
                  }}
                >
                  <Icon size={16} weight="regular" color={plugin.accent ?? COLORS.textMuted} aria-hidden />
                  <span style={{ display: "grid", gap: 1, minWidth: 0 }}>
                    <span
                      style={{
                        fontFamily: SANS_FONT,
                        fontSize: 12.5,
                        fontWeight: 500,
                        color: COLORS.textPrimary,
                      }}
                    >
                      {plugin.displayName}
                    </span>
                    <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim }}>
                      {plugin.version}
                      {plugin.enabled ? "" : " · off"}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default MarketplacePage;
