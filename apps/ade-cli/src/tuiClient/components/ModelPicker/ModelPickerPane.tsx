import React from "react";
import { Box, Text } from "ink";
import { theme } from "../../theme";
import type { AdeCodeProvider } from "../../types";
import type { ModelPickerEntry, ModelPickerRailEntry, ModelPickerState } from "./types";

const PROVIDER_GLYPHS: Record<AdeCodeProvider, string> = {
  codex: "◇",
  claude: "✦",
  opencode: "○",
  cursor: "◈",
  droid: "▲",
  ollama: "●",
  lmstudio: "■",
};

function railGlyph(entry: ModelPickerRailEntry): string {
  if (entry.kind === "favorites") return "★";
  if (entry.kind === "recents") return "◷";
  return PROVIDER_GLYPHS[entry.provider] ?? "·";
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
  const displayed = endTruncate(query || "search models…", Math.max(8, width - 8));
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Text color={searchMode ? theme.color.violet : theme.color.borderSoft}>[</Text>
      <Text color={searchMode ? theme.color.violet : theme.color.t4}>{searchMode ? "▸" : "/"}</Text>
      <Text color={theme.color.borderSoft}> </Text>
      <Text color={query ? theme.color.t1 : theme.color.t4} dimColor={!query}>
        {displayed}
      </Text>
      <Text color={searchMode ? theme.color.violet : theme.color.borderSoft}>]</Text>
    </Box>
  );
}

function ModelPickerRail({
  entries,
  selectedIndex,
  width,
}: {
  entries: ModelPickerRailEntry[];
  selectedIndex: number;
  width: number;
}) {
  const labelWidth = Math.max(4, Math.min(9, width - 4));
  return (
    <Box flexDirection="column" marginRight={1}>
      {entries.map((entry, index) => {
        const selected = index === selectedIndex;
        return (
          <Box key={`${entry.kind}:${entry.kind === "provider" ? entry.provider : entry.label}`} flexDirection="row">
            <Text color={selected ? theme.color.violet : theme.color.t5}>
              {selected ? theme.rail : " "}
            </Text>
            <Text color={selected ? theme.color.violet : theme.color.t3}>
              {" "}
              {railGlyph(entry)}{" "}
            </Text>
            <Text color={selected ? theme.color.violet : theme.color.t2} bold={selected}>
              {endTruncate(entry.label, labelWidth)}
            </Text>
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
}: {
  entry: ModelPickerEntry;
  selected: boolean;
  active: boolean;
  width: number;
}) {
  const labelMax = Math.max(8, width - 4);
  const starColor = entry.isFavorite ? theme.color.warning : theme.color.t5;
  const brand = theme.provider(entry.family);
  const activeChip = active ? " now" : "";
  const localChip = entry.family === "ollama" || entry.family === "lmstudio" ? " local" : "";
  const chipWidth = activeChip.length + localChip.length;
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={selected ? theme.color.violet : theme.color.t5}>
          {selected ? theme.rail : " "}
        </Text>
        <Text color={starColor}>
          {entry.isFavorite ? " ★" : " ☆"}
        </Text>
        <Text color={brand.color}> {brand.glyph}</Text>
        <Text
          color={
            !entry.isAvailable
              ? theme.color.t5
              : selected
                ? theme.color.violet
                : active
                  ? theme.color.t1
                  : theme.color.t2
          }
          dimColor={!entry.isAvailable}
          bold={selected || active}
        >
          {" "}
          {endTruncate(entry.displayName, Math.max(6, labelMax - chipWidth - 4))}
        </Text>
        {active ? (
          <Text color={theme.color.violet}> now</Text>
        ) : null}
        {localChip ? (
          <Text color={theme.color.running}> local</Text>
        ) : null}
      </Box>
      {entry.subProvider ? (
        <Box marginLeft={6}>
          <Text color={theme.color.t4} dimColor>
            {endTruncate(entry.subProvider, labelMax - 2)}
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

export function ModelPickerPane({
  state,
  width,
}: {
  state: ModelPickerState;
  width: number;
}) {
  const innerWidth = Math.max(20, width - 4);
  const railEntry = state.railEntries[state.railIndex] ?? state.railEntries[0];
  const activeEntry = state.activeModelId
    ? state.entries.find((entry) => entry.modelId === state.activeModelId) ?? null
    : null;
  const headingLabel = state.query.trim()
    ? "Search results"
    : railEntry?.kind === "favorites"
      ? "Favorites"
      : railEntry?.kind === "recents"
        ? "Recents"
        : (railEntry?.label ?? "Models");

  const window = rowWindow(state.entries.length, state.focusedIndex, VISIBLE_ROW_BUDGET);
  const visibleEntries = state.entries.slice(window.start, window.end);
  const hiddenBefore = window.start;
  const hiddenAfter = state.entries.length - window.end;

  return (
    <Box flexDirection="column">
      <ModelPickerSearchBar query={state.query} searchMode={state.searchMode} width={innerWidth} />

      <Box flexDirection="column" marginBottom={1}>
        <Text color={theme.color.t4} dimColor>
          {state.entries.length} model{state.entries.length === 1 ? "" : "s"} · {headingLabel}
        </Text>
        {activeEntry ? (
          <Text color={theme.color.violet} wrap="truncate-end">
            Using {theme.provider(activeEntry.family).glyph} {endTruncate(activeEntry.displayName, Math.max(8, innerWidth - 10))}
          </Text>
        ) : null}
      </Box>

      <Box flexDirection="row">
        <ModelPickerRail
          entries={state.railEntries}
          selectedIndex={state.railIndex}
          width={Math.max(8, Math.floor(innerWidth / 4))}
        />

	        <Box flexDirection="column" flexGrow={1}>
	          <Text color={theme.color.t3} bold>
	            {headingLabel}
	          </Text>
	          {state.providerTabs.length > 1 ? (
	            <Box flexDirection="row" flexWrap="wrap">
	              {state.providerTabs.map((tab, index) => {
	                const selected = index === state.providerTabIndex;
	                return (
	                  <Text
	                    key={tab.key}
	                    color={selected ? theme.color.violet : theme.color.t4}
	                    bold={selected}
	                  >
	                    {selected ? "[" : " "}
	                    {endTruncate(tab.label, 12)}
	                    {selected ? "]" : " "}
	                    {" "}
	                  </Text>
	                );
	              })}
	            </Box>
	          ) : null}
          {state.entries.length === 0 ? (
            <Text color={theme.color.t4} dimColor>
              {state.query.trim()
                ? "No models match your search."
                : railEntry?.kind === "favorites"
                  ? "Press f on a model to pin it here."
                  : railEntry?.kind === "recents"
                    ? "Models you switch to will appear here."
                    : railEntry?.kind === "provider" && railEntry.provider === "opencode"
                      ? "Install OpenCode to use these models."
                      : railEntry?.kind === "provider" && railEntry.provider === "ollama"
                        ? "Install OpenCode to use Ollama models."
                        : railEntry?.kind === "provider" && railEntry.provider === "lmstudio"
                          ? "Install OpenCode to use LM Studio models."
                          : "No models available."}
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
                    width={innerWidth - 12}
                  />
                );
              })}
              {hiddenAfter > 0 ? (
                <Text color={theme.color.t4} dimColor>{`  ↓ ${hiddenAfter} more`}</Text>
              ) : null}
            </>
          )}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.color.t4} dimColor>
	          ↑↓ pick · ↵ select · tab rail · [ ] providers · f fav · / search · esc close
	        </Text>
      </Box>
    </Box>
  );
}
