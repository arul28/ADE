import React from "react";

import { COLORS, RADII, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { useAppStore } from "../../state/appStore";
import { PluginPanelView } from "./VocabularyRenderer";
import type { VocabRenderContext } from "./vocabularyComponents";
import { PLUGIN_FIXTURES, pluginFixtureRows, type PluginFixture } from "./pluginFixtures";
import {
  VOCAB_STATE_COLLECTION,
  bindingKey,
  collectVocabSelectionDeclarations,
  collectVocabStateDeclarations,
  parsePluginPanel,
  vocabApplyStateChange,
  vocabClearRowSelection,
  vocabGroupKey,
  vocabInitialPanelSelection,
  vocabInitialPanelState,
  vocabListKey,
  vocabListNextPage,
  vocabPanelContentNodes,
  vocabResolveStateOptions,
  vocabRowRange,
  vocabSelectRowRange,
  vocabStateOptionsBindingKey,
  vocabStateRows,
  vocabToggleRowSelection,
  type VocabGroupNode,
  type VocabListNode,
  type VocabPanelSelection,
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
  const parsedPanel = React.useMemo(() => {
    const parsed = parsePluginPanel(fixture.schema);
    return parsed.ok ? parsed.panel : null;
  }, [fixture.schema]);

  const contentNodes = React.useMemo(
    () => (parsedPanel ? vocabPanelContentNodes(parsedPanel) : null),
    [parsedPanel],
  );

  // The fixture rows are static, so an `optionsFrom` resolves once here rather
  // than per render — but through the same shared resolver the real host uses,
  // so a bound control looks the same on this page as it does in a panel.
  const fixtureRows = React.useMemo(() => pluginFixtureRows(fixture), [fixture]);

  const declarations = React.useMemo(() => {
    if (!contentNodes || !parsedPanel) return [];
    return collectVocabStateDeclarations(contentNodes, (binding) => vocabResolveStateOptions(
      binding,
      fixtureRows.get(vocabStateOptionsBindingKey(binding)),
    ), parsedPanel.chrome);
  }, [contentNodes, fixtureRows, parsedPanel]);

  const selectionDeclarations = React.useMemo(
    () => (contentNodes ? collectVocabSelectionDeclarations(contentNodes) : []),
    [contentNodes],
  );

  const [panelState, setPanelState] = React.useState<VocabPanelState>(
    () => vocabInitialPanelState(declarations),
  );
  const [selection, setSelection] = React.useState<VocabPanelSelection>(
    () => vocabInitialPanelSelection(selectionDeclarations),
  );
  const [anchor, setAnchor] = React.useState<Record<string, string>>({});
  const [groupOverrides, setGroupOverrides] = React.useState<Record<string, boolean>>({});
  const [listPages, setListPages] = React.useState<Record<string, number>>({});

  const setStateValue = React.useCallback((stateKey: string, value: string) => {
    const declaration = declarations.find((entry) => entry.stateKey === stateKey);
    if (!declaration) return;
    setPanelState((previous) => vocabApplyStateChange(previous, declaration, value));
  }, [declarations]);

  const toggleRow = React.useCallback((
    stateKey: string,
    rowKey: string,
    visibleKeys?: readonly string[],
  ) => {
    const declaration = selectionDeclarations.find((entry) => entry.stateKey === stateKey);
    if (!declaration) return;
    if (visibleKeys) {
      const range = vocabRowRange(visibleKeys, anchor[stateKey], rowKey);
      setSelection((previous) => vocabSelectRowRange(previous, declaration, range));
      return;
    }
    setSelection((previous) => vocabToggleRowSelection(previous, declaration, rowKey));
    setAnchor((previous) => ({ ...previous, [stateKey]: rowKey }));
  }, [anchor, selectionDeclarations]);

  const clearSelection = React.useCallback((stateKey: string) => {
    const declaration = selectionDeclarations.find((entry) => entry.stateKey === stateKey);
    if (!declaration) return;
    setSelection((previous) => vocabClearRowSelection(previous, declaration));
  }, [selectionDeclarations]);

  const groupOpen = React.useCallback(
    (node: VocabGroupNode) => groupOverrides[vocabGroupKey(node)] ?? node.defaultOpen ?? true,
    [groupOverrides],
  );

  const toggleGroup = React.useCallback((node: VocabGroupNode) => {
    const key = vocabGroupKey(node);
    setGroupOverrides((previous) => ({
      ...previous,
      [key]: !(previous[key] ?? node.defaultOpen ?? true),
    }));
  }, []);

  const listPage = React.useCallback(
    (node: VocabListNode) => listPages[vocabListKey(node)] ?? 1,
    [listPages],
  );

  const showMoreListRows = React.useCallback((node: VocabListNode, total: number) => {
    const key = vocabListKey(node);
    setListPages((previous) => {
      const next = vocabListNextPage(total, previous[key] ?? 1);
      return next === (previous[key] ?? 1) ? previous : { ...previous, [key]: next };
    });
  }, []);

  const rowsByBinding = React.useMemo(() => {
    const rows = new Map(fixtureRows);
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
  }, [declarations, fixtureRows, panelState]);

  const context = React.useMemo<VocabRenderContext>(
    () => ({
      pluginId: "dev-fixtures",
      rowsByBinding,
      dispatch,
      active: true,
      state: panelState,
      setStateValue,
      declarations,
      selection,
      selectionDeclarations,
      toggleRow,
      clearSelection,
      groupOpen,
      toggleGroup,
      listPage,
      showMoreListRows,
    }),
    [
      clearSelection,
      declarations,
      dispatch,
      groupOpen,
      listPage,
      panelState,
      rowsByBinding,
      selection,
      selectionDeclarations,
      setStateValue,
      showMoreListRows,
      toggleGroup,
      toggleRow,
    ],
  );

  return <PluginPanelView schema={fixture.schema} context={context} />;
}

export default PluginsDevPage;
