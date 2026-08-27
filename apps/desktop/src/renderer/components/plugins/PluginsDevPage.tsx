import React from "react";

import { COLORS, RADII, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { useAppStore } from "../../state/appStore";
import { PluginPanelView } from "./VocabularyRenderer";
import type { VocabRenderContext } from "./vocabularyComponents";
import { PLUGIN_FIXTURES, pluginFixtureRows, type PluginFixture } from "./pluginFixtures";
import {
  VOCAB_STATE_COLLECTION,
  bindingKey,
  collectVocabStateDeclarations,
  parsePluginPanel,
  vocabApplyStateChange,
  vocabInitialPanelState,
  vocabStateRows,
  type VocabPanelState,
} from "../../../shared/plugins/vocabulary";

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
              <FixturePanel fixture={fixture} dispatch={dispatch} />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * One fixture, with its own panel state.
 *
 * State is per-panel by contract, so the dev page holds it per fixture rather
 * than sharing one map across the page — two fixtures both declaring
 * `statusFilter` must not move together, and a page-level store is exactly the
 * bug a real host would then be free to ship.
 */
function FixturePanel({
  fixture,
  dispatch,
}: {
  fixture: PluginFixture;
  dispatch: VocabRenderContext["dispatch"];
}) {
  const declarations = React.useMemo(() => {
    const parsed = parsePluginPanel(fixture.schema);
    return parsed.ok ? collectVocabStateDeclarations(parsed.panel.body) : [];
  }, [fixture.schema]);
  const [panelState, setPanelState] = React.useState<VocabPanelState>(
    () => vocabInitialPanelState(declarations),
  );

  const setStateValue = React.useCallback((stateKey: string, value: string) => {
    const declaration = declarations.find((entry) => entry.stateKey === stateKey);
    if (!declaration) return;
    setPanelState((previous) => vocabApplyStateChange(previous, declaration, value));
  }, [declarations]);

  const rowsByBinding = React.useMemo(() => {
    const rows = pluginFixtureRows(fixture);
    if (declarations.length > 0) {
      rows.set(
        bindingKey({ collection: VOCAB_STATE_COLLECTION }),
        vocabStateRows(declarations, panelState).map((row) => ({
          collection: VOCAB_STATE_COLLECTION,
          key: row.key,
          value: row,
          updatedAt: "",
        })),
      );
    }
    return rows;
  }, [declarations, fixture, panelState]);

  const context = React.useMemo<VocabRenderContext>(
    () => ({
      pluginId: "dev-fixtures",
      rowsByBinding,
      dispatch,
      active: true,
      state: panelState,
      setStateValue,
    }),
    [dispatch, panelState, rowsByBinding, setStateValue],
  );

  return <PluginPanelView schema={fixture.schema} context={context} />;
}

export default PluginsDevPage;
