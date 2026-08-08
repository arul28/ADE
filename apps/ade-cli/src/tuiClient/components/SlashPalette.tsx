import React from "react";
import { Box, Text } from "ink";
import type { AgentChatProvider, AgentChatSlashCommand } from "../../../../desktop/src/shared/types/chat";
import { paletteCommands, type CommandPlacement } from "../commands";
import { theme } from "../theme";

const PLACEMENT_GLYPHS: Record<CommandPlacement, string> = {
  right: "↗",
  chat: "✉",
  inline: "·",
  overlay: "◇",
};

function placementGlyph(placement?: CommandPlacement): string {
  if (!placement) return " ";
  return PLACEMENT_GLYPHS[placement] ?? " ";
}

const MIN_VISIBLE_ROWS = 6;
const MAX_VISIBLE_ROWS = 14;
const CHROME_ROWS = 3; // header + selected-summary + footer
const DEFAULT_PALETTE_WIDTH = 88;
const MAX_PALETTE_WIDTH = 132;

// The palette grows with the available terminal height: more commands visible
// on bigger screens, clamped so it never dominates a short terminal.
export function slashPaletteVisibleRows(maxRows?: number): number {
  if (!Number.isFinite(maxRows)) return MIN_VISIBLE_ROWS;
  return Math.max(MIN_VISIBLE_ROWS, Math.min(MAX_VISIBLE_ROWS, Math.floor(maxRows ?? 0) - CHROME_ROWS));
}

// Total rows the palette occupies (visible command rows + chrome) — used by the
// caller to reserve overlay height so it lines up with the prompt.
export function slashPaletteReservedRows(maxRows?: number): number {
  return slashPaletteVisibleRows(maxRows) + CHROME_ROWS;
}

// Back-compat default reservation when no height budget is supplied.
export const SLASH_PALETTE_ROWS = MIN_VISIBLE_ROWS + CHROME_ROWS;

function clampPaletteWidth(width?: number): number {
  const available = Number.isFinite(width) ? Math.floor(width ?? DEFAULT_PALETTE_WIDTH) : DEFAULT_PALETTE_WIDTH;
  const safeAvailable = Math.max(1, available - 2);
  return Math.min(MAX_PALETTE_WIDTH, safeAvailable);
}

const PROVIDER_LABELS: Record<AgentChatProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  droid: "Droid",
  opencode: "OpenCode",
  pi: "Pi",
};

function providerLabel(provider?: AgentChatProvider | null): string {
  if (!provider) return "all providers";
  return PROVIDER_LABELS[provider] ?? provider;
}

type PaletteRow = ReturnType<typeof paletteCommands>[number];

function selectedExample(row: PaletteRow): string {
  if (row.argumentHint) return `${row.name} ${row.argumentHint}`;
  return row.name;
}

function endTruncate(value: string, max: number): string {
  if (max <= 1) return value.length ? "…" : "";
  if (textWidth(value) <= max) return value;
  const ellipsis = "…";
  const ellipsisWidth = textWidth(ellipsis);
  let width = 0;
  let result = "";
  for (const char of value) {
    const nextWidth = textWidth(char);
    if (width + nextWidth + ellipsisWidth > max) break;
    result += char;
    width += nextWidth;
  }
  return `${result}${ellipsis}`;
}

function terminalCellWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  return codePoint > 0x7f ? 2 : 1;
}

function textWidth(value: string): number {
  return [...value].reduce((width, char) => width + terminalCellWidth(char), 0);
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

export function SlashPalette({
  query,
  userCommands,
  selectedIndex,
  provider,
  width,
  maxRows,
}: {
  query: string;
  userCommands: AgentChatSlashCommand[];
  selectedIndex: number;
  provider?: AgentChatProvider | null;
  width?: number;
  maxRows?: number;
}) {
  const rows = paletteCommands(query, userCommands, { provider });
  if (!query.startsWith("/")) return null;
  const paletteWidth = clampPaletteWidth(width);
  const visibleRows = slashPaletteVisibleRows(maxRows);
  const queryLabel = query.trim() || "/";
  if (!rows.length) {
    const header = topLine(`Commands · ${providerLabel(provider)} · ${queryLabel} · 0 matches`, paletteWidth);
    const rowLines = [
      bodyLine(" No matching commands", paletteWidth),
      ...Array.from({ length: Math.max(0, visibleRows - 1) }, () => bodyLine("", paletteWidth)),
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
        {paletteLine(bodyLine("No command matches this query.", paletteWidth), theme.color.t3)}
        {paletteLine(footer, theme.color.t4)}
      </Box>
    );
  }
  const total = rows.length;
  const safeIndex = Math.max(0, Math.min(selectedIndex, total - 1));
  const half = Math.floor(visibleRows / 2);
  let start = Math.max(0, safeIndex - half);
  let end = Math.min(total, start + visibleRows);
  start = Math.max(0, end - visibleRows);
  const window = rows.slice(start, end);
  const aboveCount = start;
  const belowCount = total - end;
  const selected = rows[safeIndex] ?? rows[0];
  const nameWidth = Math.max(20, Math.min(36, Math.floor(paletteWidth * 0.42)));
  const descriptionWidth = Math.max(12, paletteWidth - nameWidth - 8);
  const selectedSummary = endTruncate(
    `${selectedExample(selected)} · ${selected.description}`,
    paletteWidth - 6,
  );
  const moreSummary = [
    aboveCount ? `${aboveCount} above` : null,
    belowCount ? `${belowCount} below` : null,
  ].filter(Boolean).join(" · ");
  const header = topLine(`Commands · ${providerLabel(provider)} · ${queryLabel} · ${total} match${total === 1 ? "" : "es"}`, paletteWidth);
  const rowLines: Array<
    | { kind: "blank"; value: string }
    | {
        kind: "row";
        selected: boolean;
        value: string;
      }
  > = window.map((row, index) => {
    const absoluteIndex = start + index;
    const isSelected = absoluteIndex === safeIndex;
    const command = selectedExample(row);
    const rail = isSelected ? theme.rail : " ";
    const glyph = placementGlyph(row.placement);
    const rowText = `${rail} ${glyph} ${fillLine(command, nameWidth)} ${endTruncate(row.description, descriptionWidth)}`;
    return {
      kind: "row" as const,
      selected: isSelected,
      value: bodyLine(rowText, paletteWidth),
    };
  });
  while (rowLines.length < visibleRows) {
    rowLines.push({ kind: "blank" as const, value: bodyLine("", paletteWidth) });
  }
  const footer = bottomLine(
    `${moreSummary ? `${moreSummary} · ` : ""}↑↓ move · Tab insert · Enter run · Esc close`,
    paletteWidth,
  );

  return (
    <Box width={paletteWidth} flexDirection="column">
      {paletteLine(header, theme.color.violet)}
      {rowLines.map((line, index) => {
        if (line.kind === "blank") {
          return (
            <React.Fragment key={index}>
              {paletteLine(line.value, theme.color.t2)}
            </React.Fragment>
          );
        }
        const textColor = line.selected ? theme.color.t1 : theme.color.t2;
        return (
          <Text key={index} backgroundColor={theme.color.surface1} color={textColor}>
            {line.value}
          </Text>
        );
      })}
      {paletteLine(bodyLine(selectedSummary, paletteWidth), theme.color.t3)}
      {paletteLine(footer, theme.color.t4)}
    </Box>
  );
}
