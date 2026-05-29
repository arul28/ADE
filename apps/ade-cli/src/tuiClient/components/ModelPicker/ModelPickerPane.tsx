import React from "react";
import { Box, Text } from "ink";
import { theme } from "../../theme";
import type { SetupPaneRow, SetupPaneRowKind } from "../../types";
import { useHoveredHitId } from "../../hitTestRegistry";
import type { ModelPickerAuthStatus, ModelPickerEntry, ModelPickerRailEntry, ModelPickerState } from "./types";

// Brand glyph + color for a category/provider tab. Provider tabs reuse the
// canonical brand glyph/color from theme.provider() so the picker matches the
// rest of the TUI (footer, headers, chat) instead of a divergent local set.
function tabIcon(entry: ModelPickerRailEntry): { glyph: string; color: string } {
  if (entry.kind === "favorites") return { glyph: "★", color: theme.color.warning };
  if (entry.kind === "recents") return { glyph: "◷", color: theme.color.t3 };
  const brand = theme.provider(entry.provider);
  return { glyph: brand.glyph, color: brand.color };
}

// A small auth pip shown next to provider tabs. Never green for "ready" — green
// reads as a glitch in idle chrome — so a ready provider gets no pip at all and
// only problem states surface a colored dot.
function authPip(status: ModelPickerAuthStatus): { glyph: string; color: string } | null {
  if (status === "unavailable") return { glyph: "○", color: theme.color.attention };
  return null;
}

function endTruncate(value: string, max: number): string {
  if (max <= 1) return value.length ? "…" : "";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function ModelPickerSearchBar({
  query,
  searchMode,
  width,
}: {
  query: string;
  searchMode: boolean;
  width: number;
}) {
  const placeholder = "search models…";
  const displayed = endTruncate(query || placeholder, Math.max(8, width - 4));
  return (
    <Box flexDirection="row">
      <Text color={searchMode ? theme.color.violet : theme.color.t4}>{"⌕ "}</Text>
      <Text color={query ? theme.color.t1 : theme.color.t4} dimColor={!query}>
        {displayed}
      </Text>
      {searchMode ? <Text color={theme.color.violet}>▏</Text> : null}
    </Box>
  );
}

// Horizontal category/provider tab row. Replaces the old truncated vertical
// rail: every label is shown in full, the active tab is violet + bold and
// bracketed, and the brand glyph carries the provider color so the row reads at
// a glance. Wraps gracefully on narrow panes.
function CategoryTabs({
  entries,
  selectedIndex,
  hoveredId,
}: {
  entries: ModelPickerRailEntry[];
  selectedIndex: number;
  hoveredId: string | null;
}) {
  if (!entries.length) return null;
  return (
    <Box flexDirection="row" flexWrap="wrap">
      {entries.map((entry, index) => {
        const selected = index === selectedIndex;
        const hovered = hoveredId === `right:model-picker:rail:${index}`;
        const accent = selected || hovered;
        const icon = tabIcon(entry);
        const pip = entry.kind === "provider" ? authPip(entry.authStatus) : null;
        return (
          <Box
            key={`${entry.kind}:${entry.kind === "provider" ? entry.provider : entry.label}`}
            flexDirection="row"
            marginRight={1}
          >
            <Text color={accent ? theme.color.violet : theme.color.t5}>{selected ? "[" : " "}</Text>
            <Text color={accent ? theme.color.violet : icon.color}>{icon.glyph}</Text>
            <Text color={accent ? theme.color.violet : theme.color.t2} bold={selected}>
              {" "}
              {entry.label}
            </Text>
            {pip ? <Text color={pip.color}>{` ${pip.glyph}`}</Text> : null}
            <Text color={accent ? theme.color.violet : theme.color.t5}>{selected ? "]" : " "}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// Secondary chip row for sub-providers within a provider (e.g. several routes
// that serve the same family). Only shown when the layout produced >1 tab.
function SubProviderChips({
  tabs,
  selectedIndex,
  hoveredId,
}: {
  tabs: { key: string; label: string }[];
  selectedIndex: number;
  hoveredId: string | null;
}) {
  if (tabs.length <= 1) return null;
  return (
    <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
      {tabs.map((tab, index) => {
        const selected = index === selectedIndex;
        const hovered = hoveredId === `right:model-picker:provider-tab:${tab.key}`;
        const accent = selected || hovered;
        return (
          <Box key={tab.key} flexDirection="row" marginRight={1}>
            <Text color={accent ? theme.color.violet : theme.color.t5}>{selected ? "‹" : " "}</Text>
            <Text color={accent ? theme.color.violet : theme.color.t3} bold={selected}>
              {endTruncate(tab.label, 18)}
            </Text>
            <Text color={accent ? theme.color.violet : theme.color.t5}>{selected ? "›" : " "}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function ModelListRow({
  entry,
  selected,
  active,
  width,
  hovered,
  nameWidth,
}: {
  entry: ModelPickerEntry;
  selected: boolean;
  active: boolean;
  width: number;
  hovered: boolean;
  nameWidth: number;
}) {
  const accent = selected || hovered;
  const brand = theme.provider(entry.family);
  const isLocal = entry.family === "ollama" || entry.family === "lmstudio";
  const reasoningChip = (selected || active) && entry.reasoningLabel ? entry.reasoningLabel : null;
  const nameColor = !entry.isAvailable
    ? theme.color.t5
    : accent
      ? theme.color.violet
      : active
        ? theme.color.t1
        : theme.color.t2;
  const name = endTruncate(entry.displayName, Math.max(6, nameWidth));
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {/* Selection rail */}
        <Text color={accent ? theme.color.violet : theme.color.t5}>{selected ? theme.rail : " "}</Text>
        {/* Favorite star (amber when pinned) */}
        <Text color={entry.isFavorite ? theme.color.warning : theme.color.t5}>
          {entry.isFavorite ? "★" : "☆"}
        </Text>
        {/* Brand glyph (provider color, dimmed when unavailable) */}
        <Text color={entry.isAvailable ? brand.color : theme.color.t5}>{` ${brand.glyph} `}</Text>
        {/* Model name */}
        <Text color={nameColor} dimColor={!entry.isAvailable} bold={selected || active}>
          {name}
        </Text>
        {/* Active marker */}
        {active ? <Text color={theme.color.violet}>{"  ● now"}</Text> : null}
        {/* Local-runtime chip */}
        {isLocal && entry.isAvailable ? (
          <Text color={theme.color.t4} dimColor>{"  local"}</Text>
        ) : null}
        {/* Reasoning chip on the focused/active row */}
        {reasoningChip ? (
          <Text color={theme.color.t4} dimColor>{`  ${reasoningChip}`}</Text>
        ) : null}
      </Box>
      {entry.subProvider ? (
        <Box marginLeft={4}>
          <Text color={theme.color.t4} dimColor>
            {endTruncate(entry.subProvider, Math.max(8, width - 4))}
          </Text>
        </Box>
      ) : null}
      {!entry.isAvailable ? (
        <Box marginLeft={4}>
          <Text color={theme.color.t4} dimColor>
            Configure provider in ADE/OpenCode
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

// Settings footer laid out as a labeled grid, visually separated from the list
// by a divider. The primary "apply" action is rendered as a distinct violet,
// bracketed button; the remaining settings are dim labeled value chips.
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
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.color.border}>{divider}</Text>
      {settingRows.length ? (
        <Box flexDirection="row" marginTop={1}>
          <Text color={theme.color.t4} dimColor>SETTINGS</Text>
        </Box>
      ) : null}
      {settingRows.length ? (
        <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
          {settingRows.map((row) => {
            const focused = footerFocus === row.kind;
            const hovered = hoveredId === `right:model-picker:setting:${row.kind}`;
            const accent = focused || hovered;
            const labelColor = row.disabled ? theme.color.t5 : theme.color.t4;
            const valueColor = row.disabled
              ? theme.color.t5
              : accent
                ? theme.color.violet
                : theme.color.t2;
            return (
              <Box key={row.kind} flexDirection="row" marginRight={2}>
                <Text color={accent ? theme.color.violet : theme.color.t5}>{focused ? theme.rail : " "}</Text>
                <Text color={labelColor} dimColor={!row.disabled}>
                  {endTruncate(row.label.toLowerCase(), 14)}{" "}
                </Text>
                <Text color={valueColor} bold={focused}>
                  {endTruncate(row.value, 16)}
                </Text>
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
            const color = applyRow.disabled
              ? theme.color.t5
              : accent
                ? theme.color.violet
                : theme.color.violetDeep;
            return (
              <Text color={color} bold={accent}>
                {`[ ${endTruncate(applyRow.label, 24)} ]`}
              </Text>
            );
          })()}
        </Box>
      ) : null}
    </Box>
  );
}

const VISIBLE_ROW_BUDGET = 12;

function rowWindow(rowCount: number, selected: number, capacity: number): { start: number; end: number } {
  if (rowCount <= capacity) return { start: 0, end: rowCount };
  const half = Math.floor(capacity / 2);
  let start = Math.max(0, selected - half);
  let end = start + capacity;
  if (end > rowCount) {
    end = rowCount;
    start = end - capacity;
  }
  return { start, end };
}

function emptyStateLabel(state: ModelPickerState, railEntry: ModelPickerRailEntry | undefined): string {
  if (state.query.trim()) return "No models match your search.";
  if (railEntry?.kind === "favorites") return "Press f on a model to pin it here.";
  if (railEntry?.kind === "recents") return "Models you switch to will appear here.";
  if (railEntry?.kind === "provider" && railEntry.provider === "opencode") return "Install OpenCode to use these models.";
  if (railEntry?.kind === "provider" && railEntry.provider === "ollama") return "Install OpenCode to use Ollama models.";
  if (railEntry?.kind === "provider" && railEntry.provider === "lmstudio") return "Install OpenCode to use LM Studio models.";
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
  const railEntry = state.railEntries[state.railIndex] ?? state.railEntries[0];
  const activeEntry = state.activeModelId
    ? state.entries.find((entry) => entry.modelId === state.activeModelId) ?? null
    : null;

  const window = rowWindow(state.entries.length, state.focusedIndex, VISIBLE_ROW_BUDGET);
  const visibleEntries = state.entries.slice(window.start, window.end);
  const hiddenBefore = window.start;
  const hiddenAfter = state.entries.length - window.end;
  // Reserve space for star + glyph (6 cols) and the "● now" marker so columns align.
  const nameWidth = Math.max(6, innerWidth - 14);

  return (
    <Box flexDirection="column">
      {/* Context line under the parent "MODEL" title. */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color={theme.color.t4} dimColor>
          {state.entries.length} model{state.entries.length === 1 ? "" : "s"}
          {state.laneLabel ? ` · ${endTruncate(state.laneLabel, Math.max(6, innerWidth - 18))}` : ""}
        </Text>
        {activeEntry ? (
          <Text color={theme.color.violet} wrap="truncate-end">
            {`● now `}
            <Text color={theme.provider(activeEntry.family).color}>{theme.provider(activeEntry.family).glyph}</Text>
            {` ${endTruncate(activeEntry.displayName, Math.max(8, innerWidth - 12))}`}
          </Text>
        ) : null}
        {state.activeProviderAuthStatus === "unavailable" && state.activeProviderSignInHint ? (
          <Text color={theme.color.attention} wrap="truncate-end">
            {`Sign in: ${state.activeProviderSignInHint}`}
          </Text>
        ) : null}
      </Box>

      {/* Search affordance. */}
      <Box marginBottom={1}>
        <ModelPickerSearchBar query={state.query} searchMode={state.searchMode} width={innerWidth} />
      </Box>

      {/* Category / provider tab row (only when not searching). */}
      {state.query.trim() ? null : (
        <CategoryTabs entries={state.railEntries} selectedIndex={state.railIndex} hoveredId={hoveredId} />
      )}

      {/* Sub-provider chips for the active provider. */}
      <SubProviderChips tabs={state.providerTabs} selectedIndex={state.providerTabIndex} hoveredId={hoveredId} />

      {/* Model list. */}
      <Box flexDirection="column" marginTop={1}>
        {state.entries.length === 0 ? (
          <Text color={theme.color.t4} dimColor>
            {emptyStateLabel(state, railEntry)}
          </Text>
        ) : (
          <>
            {hiddenBefore > 0 ? (
              <Text color={theme.color.t4} dimColor>{`  ↑ ${hiddenBefore} earlier`}</Text>
            ) : null}
            {visibleEntries.map((entry, sliceIndex) => {
              const flatIndex = window.start + sliceIndex;
              const selected = flatIndex === state.focusedIndex;
              const active = state.activeModelId != null && entry.modelId === state.activeModelId;
              return (
                <ModelListRow
                  key={entry.modelId || `entry-${flatIndex}`}
                  entry={entry}
                  selected={selected}
                  active={active}
                  hovered={hoveredId === `right:model-picker:entry:${entry.modelId}`}
                  width={innerWidth}
                  nameWidth={nameWidth}
                />
              );
            })}
            {hiddenAfter > 0 ? (
              <Text color={theme.color.t4} dimColor>{`  ↓ ${hiddenAfter} more`}</Text>
            ) : null}
          </>
        )}
      </Box>

      {/* Settings footer. */}
      <SettingsFooter
        rows={state.settingsRows}
        footerFocus={state.footerFocus}
        width={innerWidth}
        hoveredId={hoveredId}
      />

      {/* Key hints. */}
      <Box marginTop={1}>
        <Text color={theme.color.t4} dimColor>
          {`↑↓ pick · ↵ select · tab category · s ${state.showAll ? "available" : "all"} · f fav · / search · esc close`}
        </Text>
      </Box>
    </Box>
  );
}
