import React from "react";
import { Box, Text } from "ink";
import { theme } from "../../theme";
import type { SetupPaneRow, SetupPaneRowKind } from "../../types";
import { useHoveredHitId } from "../../hitTestRegistry";
import { KeyHints } from "../designKit";
import type { ModelPickerAuthStatus, ModelPickerEntry, ModelPickerRailEntry, ModelPickerState } from "./types";
// The model list is a FIXED-height window so a long catalog (e.g. OpenCode's
// dozens of providers) scrolls inside its own region instead of shoving the
// settings footer around. Settings stay stickied below. Geometry constants +
// the windowing function live in modelPickerGeometry so the click hit-test in
// app.tsx computes identical rects from a SINGLE source.
import { MODEL_LIST_ROWS, RAIL_WIDTH, rowWindow, modelPickerGeometry } from "./modelPickerGeometry";

function endTruncate(value: string, max: number): string {
  if (max <= 1) return value.length ? "…" : "";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

// Brand glyph + color for a category/provider rail entry, reusing the canonical
// provider identity so the picker matches the rest of the TUI.
function railIcon(entry: ModelPickerRailEntry): { glyph: string; color: string } {
  if (entry.kind === "favorites") return { glyph: "★", color: theme.color.warning };
  if (entry.kind === "recents") return { glyph: "◷", color: theme.color.t3 };
  const brand = theme.provider(entry.provider);
  return { glyph: brand.glyph, color: brand.color };
}

// Amber pip for a provider that needs sign-in; nothing for a ready provider
// (green would read as idle chrome).
function authPip(status: ModelPickerAuthStatus): { glyph: string; color: string } | null {
  if (status === "unavailable") return { glyph: "○", color: theme.color.attention };
  return null;
}

function settingIcon(kind: SetupPaneRowKind): string {
  switch (kind) {
    case "reasoning": return "✦";
    case "permission": return "◆";
    case "codex-fast": return "↯";
    case "output-style": return "✎";
    case "refresh-status": return "↻";
    case "open-settings": return "↗";
    default: return "·";
  }
}

// ── Vertical icon rail (categories / provider families) ──────────────────────

function VerticalRail({
  entries,
  selectedIndex,
  hoveredId,
}: {
  entries: ModelPickerRailEntry[];
  selectedIndex: number;
  hoveredId: string | null;
}) {
  return (
    <Box flexDirection="column" width={RAIL_WIDTH} flexShrink={0}>
      {entries.map((entry, index) => {
        const selected = index === selectedIndex;
        const hovered = hoveredId === `right:model-picker:rail:${index}`;
        const accent = selected || hovered;
        const icon = railIcon(entry);
        const pip = entry.kind === "provider" ? authPip(entry.authStatus) : null;
        return (
          <Box key={`${entry.kind}:${entry.kind === "provider" ? entry.provider : entry.label}`} flexDirection="row">
            <Text color={selected ? theme.color.violet : theme.color.t5}>{selected ? "▶" : " "}</Text>
            <Text color={accent ? theme.color.violet : icon.color} bold={selected}>{icon.glyph}</Text>
            {pip ? <Text color={pip.color}>{pip.glyph}</Text> : <Text>{" "}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}

// ── Compact sub-provider selector ────────────────────────────────────────────
// Replaces the old wrap-everything chip block: shows the ACTIVE group only,
// with a count and the [ ] switch hint. Bounded to a single row.
function SubProviderSelector({
  tabs,
  selectedIndex,
  width,
}: {
  tabs: { key: string; label: string }[];
  selectedIndex: number;
  width: number;
}) {
  if (tabs.length <= 1) return null;
  const safe = Math.max(0, Math.min(selectedIndex, tabs.length - 1));
  const active = tabs[safe];
  if (!active) return null;
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Text color={theme.color.t5}>{"‹ "}</Text>
      <Text color={theme.color.violet} bold>{endTruncate(active.label, Math.max(8, width - 18))}</Text>
      <Text color={theme.color.t4} dimColor>{`  ${safe + 1}/${tabs.length}`}</Text>
      <Text color={theme.color.t5}>{" › "}</Text>
      <Text color={theme.color.accent}>{"[ ]"}</Text>
    </Box>
  );
}

// ── Model list row (single line — no overlapping second line) ────────────────

// Fixed prefix drawn before every name: selection rail (1) + favorite star (1)
// + " glyph " (space + brand glyph + space = 3) = 5 cols.
const ROW_PREFIX_WIDTH = 5;
// Per-row suffixes, measured to the character so the name reservation is exact
// and a row can never wrap onto a second line (the geometry assumes 1 line each):
//   active     -> "  ● now"     (7 cols)
//   unavailable-> "  · sign in" (11 cols)
const ROW_SUFFIX_ACTIVE = "  ● now".length;
const ROW_SUFFIX_UNAVAILABLE = "  · sign in".length;
const ROW_NAME_MIN = 6;

function ModelListRow({
  entry,
  selected,
  active,
  hovered,
  contentWidth,
}: {
  entry: ModelPickerEntry;
  selected: boolean;
  active: boolean;
  hovered: boolean;
  contentWidth: number;
}) {
  const accent = selected || hovered;
  const brand = theme.provider(entry.family);
  const nameColor = !entry.isAvailable
    ? theme.color.t5
    : accent
      ? theme.color.violet
      : active
        ? theme.color.t1
        : theme.color.t2;
  // Reserve the EXACT suffix this row draws (active and unavailable are mutually
  // exclusive — an active model is by definition available). The name column is
  // whatever is left after the fixed prefix and this row's suffix.
  const suffixWidth = active
    ? ROW_SUFFIX_ACTIVE
    : !entry.isAvailable
      ? ROW_SUFFIX_UNAVAILABLE
      : 0;
  const nameWidth = Math.max(ROW_NAME_MIN, contentWidth - ROW_PREFIX_WIDTH - suffixWidth);
  return (
    <Box flexDirection="row">
      {/* Selection rail (violet) — selection is shown by COLOR, not indentation. */}
      <Text color={selected ? theme.color.violet : theme.color.t5}>{selected ? theme.rail : " "}</Text>
      <Text color={entry.isFavorite ? theme.color.warning : theme.color.t5}>{entry.isFavorite ? "★" : "☆"}</Text>
      <Text color={entry.isAvailable ? brand.color : theme.color.t5}>{` ${brand.glyph} `}</Text>
      <Text color={nameColor} dimColor={!entry.isAvailable} bold={selected}>
        {endTruncate(entry.displayName, nameWidth)}
      </Text>
      {active ? <Text color={theme.color.violet}>{"  ● now"}</Text> : null}
      {!entry.isAvailable ? <Text color={theme.color.t5} dimColor>{"  · sign in"}</Text> : null}
    </Box>
  );
}

// ── Sticky settings footer ───────────────────────────────────────────────────

function SettingsFooter({
  rows,
  footerFocus,
  width,
  hoveredId,
}: {
  rows: SetupPaneRow[];
  footerFocus: SetupPaneRowKind | null;
  width: number;
  hoveredId: string | null;
}) {
  if (!rows.length) return null;
  const visibleRows = rows.filter((row) => row.kind !== "provider" && row.kind !== "model");
  if (!visibleRows.length) return null;
  const settingRows = visibleRows.filter((row) => row.kind !== "apply");
  const applyRow = visibleRows.find((row) => row.kind === "apply") ?? null;
  const divider = "─".repeat(Math.max(4, width));

  return (
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      <Text color={theme.color.border}>{divider}</Text>
      {settingRows.length ? (
        <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
          {settingRows.map((row) => {
            const focused = footerFocus === row.kind;
            const hovered = hoveredId === `right:model-picker:setting:${row.kind}`;
            const accent = focused || hovered;
            const labelColor = row.disabled ? theme.color.t5 : theme.color.t4;
            const valueColor = row.disabled ? theme.color.t5 : accent ? theme.color.violet : theme.color.t2;
            return (
              <Box key={row.kind} flexDirection="row" marginRight={2}>
                <Text color={accent ? theme.color.violet : theme.color.t5}>{focused ? theme.rail : " "}</Text>
                <Text color={row.disabled ? theme.color.t5 : accent ? theme.color.violet : theme.color.t3}>{`${settingIcon(row.kind)} `}</Text>
                <Text color={labelColor} dimColor={!row.disabled}>{endTruncate(row.label.toLowerCase(), 12)}{" "}</Text>
                <Text color={valueColor} bold={focused}>{endTruncate(row.value, 14)}</Text>
              </Box>
            );
          })}
        </Box>
      ) : null}
      {applyRow ? (
        <Box marginTop={1}>
          {(() => {
            const focused = footerFocus === "apply";
            const hovered = hoveredId === "right:model-picker:setting:apply";
            const accent = focused || hovered;
            const color = applyRow.disabled ? theme.color.t5 : accent ? theme.color.violet : theme.color.violetDeep;
            return <Text color={color} bold={accent}>{`[ ${endTruncate(applyRow.label, 20)} ]`}</Text>;
          })()}
        </Box>
      ) : null}
    </Box>
  );
}

// ── Windowing ────────────────────────────────────────────────────────────────
// rowWindow + RAIL_WIDTH + MODEL_LIST_ROWS are imported from modelPickerGeometry
// (the single geometry source shared with the app.tsx click hit-test).

// ── Dev-only hit-test verifier ───────────────────────────────────────────────
// Gated on ADE_DEBUG_HITTEST. Lists the relative (paneTop/paneLeft = 0) rects
// the SHARED geometry helper produces for the current state, so a developer can
// cross-check that the painted rows line up with the clickable rects. Static
// (no timers, idle = zero extra re-renders); neutral chrome colors only.
function DebugHitOverlay({ state }: { state: ModelPickerState }) {
  if (!process.env.ADE_DEBUG_HITTEST) return null;
  const geometry = modelPickerGeometry({
    paneLeft: 0,
    paneTop: 0,
    paneWidth: 40,
    state,
    rows: 100,
  });
  const fmt = (id: string, r: { x: number; y: number; w: number; h: number }) =>
    `${id}  y${r.y} x${r.x} ${r.w}×${r.h}`;
  const lines: string[] = [
    fmt("search", geometry.search),
    ...geometry.rail.map((entry) => fmt(`rail[${entry.id.split(":").pop()}]`, entry.rect)),
    ...geometry.entries.map((entry) => fmt(`entry#${entry.index}`, entry.rect)),
    ...geometry.settings.map((entry) => fmt(`set:${entry.id.split(":").pop()}`, entry.rect)),
    ...(geometry.apply ? [fmt("apply", geometry.apply)] : []),
  ];
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor={theme.color.border} paddingX={1}>
      <Text color={theme.color.t4} dimColor>hit-test geometry (ADE_DEBUG_HITTEST)</Text>
      {lines.map((line, index) => (
        <Text key={`dbg-${index}`} color={theme.color.t5} dimColor>{line}</Text>
      ))}
    </Box>
  );
}

function emptyStateLabel(state: ModelPickerState, railEntry: ModelPickerRailEntry | undefined): string {
  if (state.query.trim()) return "No models match your search.";
  if (railEntry?.kind === "favorites") return "Press f on a model to pin it here.";
  if (railEntry?.kind === "recents") return "Models you switch to appear here.";
  if (railEntry?.kind === "provider" && railEntry.authStatus === "unavailable") return "Sign in to use this provider.";
  return "No models available.";
}

export function ModelPickerPane({
  state,
  width,
}: {
  state: ModelPickerState;
  width: number;
}) {
  const hoveredId = useHoveredHitId();
  const innerWidth = Math.max(20, width - 4);
  const searching = state.query.trim().length > 0;
  const railEntry = state.railEntries[state.railIndex] ?? state.railEntries[0];
  const activeEntry = state.activeModelId
    ? state.entries.find((entry) => entry.modelId === state.activeModelId) ?? null
    : null;

  const window = rowWindow(state.entries.length, state.focusedIndex, MODEL_LIST_ROWS);
  const visibleEntries = state.entries.slice(window.start, window.end);
  const hiddenAfter = state.entries.length - window.end;
  const hiddenBefore = window.start;
  // Content sits right of the icon rail (full width while searching). Each row
  // reserves its OWN prefix + (active/unavailable) suffix from contentWidth, so
  // the precise name width is computed per row inside ModelListRow — guaranteeing
  // every row stays exactly one line at any terminal width.
  const contentWidth = searching ? innerWidth : Math.max(14, innerWidth - RAIL_WIDTH - 2);

  // The list always occupies exactly MODEL_LIST_ROWS rows (padded with blanks)
  // so the settings footer never shifts as the catalog length changes.
  const listRows: React.ReactNode[] = [];
  if (state.entries.length === 0) {
    listRows.push(
      <Text key="empty" color={theme.color.t4} dimColor wrap="truncate-end">
        {endTruncate(emptyStateLabel(state, railEntry), contentWidth)}
      </Text>,
    );
  } else {
    visibleEntries.forEach((entry, sliceIndex) => {
      const flatIndex = window.start + sliceIndex;
      listRows.push(
        <ModelListRow
          key={entry.modelId || `entry-${flatIndex}`}
          entry={entry}
          selected={flatIndex === state.focusedIndex}
          active={state.activeModelId != null && entry.modelId === state.activeModelId}
          hovered={hoveredId === `right:model-picker:entry:${entry.modelId}`}
          contentWidth={contentWidth}
        />,
      );
    });
  }
  while (listRows.length < MODEL_LIST_ROWS) {
    listRows.push(<Text key={`pad-${listRows.length}`}> </Text>);
  }

  return (
    <Box flexDirection="column">
      {/* Header (fixed). */}
      <Box flexDirection="column" marginBottom={1} flexShrink={0}>
        <Text color={theme.color.t4} dimColor wrap="truncate-end">
          {state.entries.length} model{state.entries.length === 1 ? "" : "s"}
          {state.laneLabel ? ` · ${endTruncate(state.laneLabel, Math.max(6, innerWidth - 18))}` : ""}
        </Text>
        {activeEntry ? (
          <Text color={theme.color.violet} wrap="truncate-end">
            {"● now "}
            <Text color={theme.provider(activeEntry.family).color}>{theme.provider(activeEntry.family).glyph}</Text>
            {` ${endTruncate(activeEntry.displayName, Math.max(8, innerWidth - 12))}`}
          </Text>
        ) : null}
        {state.activeProviderAuthStatus === "unavailable" && state.activeProviderSignInHint ? (
          <Text color={theme.color.attention} wrap="truncate-end">{`Sign in: ${state.activeProviderSignInHint}`}</Text>
        ) : null}
      </Box>

      {/* Search (fixed). */}
      <Box marginBottom={1} flexShrink={0}>
        <Text color={state.searchMode ? theme.color.violet : theme.color.t4}>{"⌕ "}</Text>
        <Text color={state.query ? theme.color.t1 : theme.color.t4} dimColor={!state.query} wrap="truncate-end">
          {endTruncate(state.query || "search models…", Math.max(8, innerWidth - 2))}
        </Text>
        {state.searchMode ? <Text color={theme.color.violet}>▏</Text> : null}
      </Box>

      {/* Bounded model region: icon rail + fixed-height windowed list. */}
      {searching ? (
        <Box flexDirection="column" flexShrink={0}>{listRows}</Box>
      ) : (
        <Box flexDirection="row" flexShrink={0}>
          <VerticalRail entries={state.railEntries} selectedIndex={state.railIndex} hoveredId={hoveredId} />
          <Box
            flexDirection="column"
            flexGrow={1}
            borderStyle="single"
            borderColor={theme.color.border}
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            paddingLeft={1}
          >
            <SubProviderSelector tabs={state.providerTabs} selectedIndex={state.providerTabIndex} width={contentWidth} />
            {listRows}
          </Box>
        </Box>
      )}
      {(hiddenBefore > 0 || hiddenAfter > 0) ? (
        <Text color={theme.color.t4} dimColor>
          {hiddenBefore > 0 ? `↑ ${hiddenBefore} ` : ""}{hiddenAfter > 0 ? `↓ ${hiddenAfter} more` : ""}
        </Text>
      ) : null}

      {/* Sticky settings footer. */}
      <SettingsFooter rows={state.settingsRows} footerFocus={state.footerFocus} width={innerWidth} hoveredId={hoveredId} />

      {/* Key hints. */}
      <KeyHints
        items={[
          ["↑↓", "models"],
          ["tab", "category"],
          ["[ ]", "group"],
          ["↵", "pick"],
          ["f", "fav"],
          ["/", "search"],
          ["esc", "close"],
        ]}
      />

      <DebugHitOverlay state={state} />
    </Box>
  );
}
