import React from "react";

import { COLORS, RADII, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { useAppStore } from "../../state/appStore";
import { PluginPanelView } from "./VocabularyRenderer";
import type { VocabRenderContext } from "./vocabularyComponents";
import { PLUGIN_FIXTURES } from "./pluginFixtures";
import type { PluginCollectionRow } from "../../lib/pluginRuntimeBridge";

/**
 * `/plugins-dev` — the vocabulary renderer's acceptance surface.
 *
 * Every v1 component and every degradation path on one scrollable page, with no
 * plugin host involved: the fixtures are literal schemas and the dispatcher is
 * local. That makes this the fastest way to see a rendering change, and the only
 * way to see the failure paths on demand — a real plugin will not crash for you.
 *
 * Dev-only. It is not in the nav, not in the palette, and the route is not
 * registered in a production build.
 *
 * It also seeds the socket inspector this will grow into: the same "render a
 * schema against a fake host" harness is what inspecting a live contribution
 * needs.
 */

export function PluginsDevPage() {
  const theme = useAppStore((state) => state.theme);
  const setTheme = useAppStore((state) => state.setTheme);
  const [log, setLog] = React.useState<string[]>([]);

  const dispatch = React.useCallback<VocabRenderContext["dispatch"]>(async (action, extraArgs) => {
    const payload = { ...action.args, ...extraArgs };
    const detail = Object.keys(payload).length > 0 ? ` ${JSON.stringify(payload)}` : "";
    setLog((previous) => [`${action.action}${detail}`, ...previous].slice(0, 12));
    // One fixture action fails on purpose so the inline error path is visible
    // here rather than only in production.
    if (action.action === "destructive") throw new Error("The plugin refused that action.");
  }, []);

  const context = React.useMemo<VocabRenderContext>(
    () => ({
      pluginId: "dev-fixtures",
      rowsByBinding: new Map<string, PluginCollectionRow[]>(),
      dispatch,
      active: true,
    }),
    [dispatch],
  );

  return (
    <div style={{ height: "100%", minHeight: 0, overflow: "auto" }}>
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "28px 20px 80px", display: "grid", gap: 28 }}>
        <header style={{ display: "grid", gap: 10 }}>
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
            Plugin vocabulary v1
          </h1>
          <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
            Every component and every failure path, rendered from literal fixtures. Switch themes to
            check both palettes.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              style={outlineButton({ height: 28, padding: "0 10px", fontSize: 11 })}
            >
              Switch to {theme === "dark" ? "light" : "dark"}
            </button>
            {log.length > 0 ? (
              <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim }}>
                Last action: {log[0]}
              </span>
            ) : null}
          </div>
        </header>

        {PLUGIN_FIXTURES.map((fixture) => (
          <section key={fixture.id} style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "grid", gap: 2 }}>
              <h2
                style={{
                  margin: 0,
                  fontFamily: SANS_FONT,
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: COLORS.textPrimary,
                }}
              >
                {fixture.label}
              </h2>
              <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim }}>
                {fixture.note}
              </p>
            </div>
            <div
              style={{
                padding: 16,
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.borderMuted}`,
                borderRadius: RADII.lg,
                minWidth: 0,
              }}
            >
              <PluginPanelView schema={fixture.schema} context={context} />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export default PluginsDevPage;
