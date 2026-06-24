import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme";
import type { MentionSuggestion } from "../types";

const VISIBLE_ROWS = 5;
export const MENTION_PALETTE_ROWS = VISIBLE_ROWS + 3;
const DEFAULT_PALETTE_WIDTH = 88;
const MAX_PALETTE_WIDTH = 104;
const MIN_PALETTE_WIDTH = 56;
const TYPE_COLUMN_WIDTH = 8;
const NAME_COLUMN_WIDTH = 34;

const KIND_LABELS: Record<MentionSuggestion["kind"], string> = {
  lane: "Lane",
  chat: "Chat",
  pr: "PR",
  file: "File",
  commit: "Commit",
};

function clampPaletteWidth(width?: number): number {
  const available = Number.isFinite(width)
    ? Math.floor(width ?? DEFAULT_PALETTE_WIDTH)
    : DEFAULT_PALETTE_WIDTH;
  return Math.max(MIN_PALETTE_WIDTH, Math.min(MAX_PALETTE_WIDTH, available));
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function extensionFor(path: string | undefined): string {
  if (!path) return "none";
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : "none";
}

function useLabel(suggestion: MentionSuggestion): string {
  switch (suggestion.kind) {
    case "file":
      return `Adds file context${extensionFor(suggestion.filePath ?? suggestion.label) !== "none" ? ` (${extensionFor(suggestion.filePath ?? suggestion.label)})` : ""}`;
    case "commit":
      return "Adds a commit reference";
    case "pr":
      return "Adds a pull request reference";
    case "lane":
      return "Adds a lane/worktree reference";
    case "chat":
      return "Adds a chat transcript reference";
  }
}

function endTruncate(value: string, max: number): string {
  if (max <= 1) return value.length ? "…" : "";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function textWidth(value: string): number {
  return [...value].length;
}

function padEnd(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - textWidth(value)))}`;
}

function fillLine(value: string, width: number): string {
  return padEnd(endTruncate(value, width), width);
}

function topLine(label: string, width: number): string {
  const bodyWidth = Math.max(1, width - 2);
  const content = ` ${label} `;
  return `┌${fillLine(content, bodyWidth).replace(/ +$/u, (spaces) => "─".repeat(spaces.length))}┐`;
}

function bodyLine(value: string, width: number): string {
  return `│${fillLine(` ${value}`, Math.max(1, width - 2))}│`;
}

function bottomLine(value: string, width: number): string {
  return `└${fillLine(` ${value}`, Math.max(1, width - 2)).replace(/ +$/u, (spaces) => "─".repeat(spaces.length))}┘`;
}

function paletteLine(value: string, color: string) {
  return (
    <Text backgroundColor={theme.color.surface1} color={color}>
      {value}
    </Text>
  );
}

export function MentionPalette({
  suggestions,
  selectedIndex,
  query = "",
  width,
}: {
  suggestions: MentionSuggestion[];
  selectedIndex: number;
  query?: string;
  width?: number;
}) {
  const paletteWidth = clampPaletteWidth(width);
  const nameWidth = Math.min(NAME_COLUMN_WIDTH, Math.max(20, Math.floor(paletteWidth * 0.4)));
  const detailWidth = Math.max(12, paletteWidth - TYPE_COLUMN_WIDTH - nameWidth - 9);
  const queryText = query?.trim() ?? "";
  const queryLabel = queryText ? `@${queryText}` : "@";
  if (!suggestions.length) {
    const header = topLine(`References · ${queryLabel} · 0 matches`, paletteWidth);
    const rowLines = [
      bodyLine(" No references found", paletteWidth),
      ...Array.from({ length: Math.max(0, VISIBLE_ROWS - 1) }, () => bodyLine("", paletteWidth)),
    ];
    const footer = bottomLine("Type to filter · Esc close", paletteWidth);
    return (
      <Box width={paletteWidth} flexDirection="column">
        {paletteLine(header, theme.color.violet)}
        {rowLines.map((line, index) => (
          <React.Fragment key={index}>
            {paletteLine(line, index === 0 ? theme.color.t3 : theme.color.t2)}
          </React.Fragment>
        ))}
        {paletteLine(bodyLine("No reference matches this query.", paletteWidth), theme.color.t3)}
        {paletteLine(footer, theme.color.t4)}
      </Box>
    );
  }
  const total = suggestions.length;
  const safeIndex = Math.max(0, Math.min(selectedIndex, total - 1));
  const half = Math.floor(VISIBLE_ROWS / 2);
  let start = Math.max(0, safeIndex - half);
  let end = Math.min(total, start + VISIBLE_ROWS);
  start = Math.max(0, end - VISIBLE_ROWS);
  const window = suggestions.slice(start, end);
  const selected = suggestions[safeIndex];
  const selectedTitle =
    selected.kind === "file"
      ? basename(selected.filePath ?? selected.label)
      : selected.label;
  const insertedText = selected.insertText;
  const selectedSummary = endTruncate(
    `${selectedTitle} · ${useLabel(selected)} · ${insertedText}`,
    paletteWidth - 6,
  );
  const aboveCount = start;
  const belowCount = total - end;
  const moreSummary = [
    aboveCount ? `${aboveCount} above` : null,
    belowCount ? `${belowCount} below` : null,
  ].filter(Boolean).join(" · ");
  const header = topLine(`References · ${queryLabel} · ${total} match${total === 1 ? "" : "es"}`, paletteWidth);
  const rowLines = window.map((suggestion, index) => {
    const absoluteIndex = start + index;
    const isSelected = absoluteIndex === safeIndex;
    const title = suggestion.kind === "file"
      ? basename(suggestion.filePath ?? suggestion.label)
      : suggestion.label;
    const detail = suggestion.detail ?? suggestion.filePath ?? useLabel(suggestion);
    return {
      selected: isSelected,
      value: bodyLine(
        `${isSelected ? theme.rail : " "} ${fillLine(KIND_LABELS[suggestion.kind], TYPE_COLUMN_WIDTH)} ${fillLine(title, nameWidth)} ${endTruncate(detail, detailWidth)}`,
        paletteWidth,
      ),
    };
  });
  while (rowLines.length < VISIBLE_ROWS) {
    rowLines.push({ selected: false, value: bodyLine("", paletteWidth) });
  }
  const footer = bottomLine(
    `${moreSummary ? `${moreSummary} · ` : ""}↑↓ move · Tab insert · Esc close`,
    paletteWidth,
  );

  return (
    <Box width={paletteWidth} flexDirection="column">
      {paletteLine(header, theme.color.violet)}
      {rowLines.map((line, index) => (
        <React.Fragment key={index}>
          {paletteLine(line.value, line.selected ? theme.color.t1 : theme.color.t2)}
        </React.Fragment>
      ))}
      {paletteLine(bodyLine(selectedSummary, paletteWidth), theme.color.t3)}
      {paletteLine(footer, theme.color.t4)}
    </Box>
  );
}
