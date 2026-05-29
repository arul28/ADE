import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme";

export type CommandPaletteItem = {
  key: string;
  kind: "command" | "lane" | "chat";
  label: string;
  detail: string;
};

const VISIBLE_ROWS = 7;
export const COMMAND_PALETTE_ROWS = VISIBLE_ROWS + 3;
const DEFAULT_PALETTE_WIDTH = 92;
const MAX_PALETTE_WIDTH = 112;

function endTruncate(value: string, max: number): string {
  if (max <= 1) return value.length ? "…" : "";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function padEnd(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - value.length))}`;
}

function fillLine(value: string, width: number): string {
  return padEnd(endTruncate(value, width), width);
}

function bodyLine(value: string, width: number): string {
  return `│${fillLine(` ${value}`, Math.max(1, width - 2))}│`;
}

function topLine(label: string, width: number): string {
  const bodyWidth = Math.max(1, width - 2);
  const content = ` ${label} `;
  return `┌${fillLine(content, bodyWidth).replace(/ +$/u, (spaces) => "─".repeat(spaces.length))}┐`;
}

function bottomLine(value: string, width: number): string {
  return `└${fillLine(` ${value}`, Math.max(1, width - 2)).replace(/ +$/u, (spaces) => "─".repeat(spaces.length))}┘`;
}

function paletteLine(value: string, color: string, key?: React.Key) {
  return (
    <Text key={key} backgroundColor={theme.color.surface1} color={color}>
      {value}
    </Text>
  );
}

function glyph(kind: CommandPaletteItem["kind"]): string {
  if (kind === "lane") return "◇";
  if (kind === "chat") return "◉";
  return "↗";
}

export function CommandPalette({
  query,
  items,
  selectedIndex,
  width,
}: {
  query: string;
  items: CommandPaletteItem[];
  selectedIndex: number;
  width?: number;
}) {
  const paletteWidth = Math.min(MAX_PALETTE_WIDTH, Math.max(56, Math.floor(width ?? DEFAULT_PALETTE_WIDTH) - 2));
  const total = items.length;
  const safeIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, total - 1)));
  const half = Math.floor(VISIBLE_ROWS / 2);
  let start = Math.max(0, safeIndex - half);
  let end = Math.min(total, start + VISIBLE_ROWS);
  start = Math.max(0, end - VISIBLE_ROWS);
  const window = items.slice(start, end);
  const selected = items[safeIndex] ?? null;
  const labelWidth = Math.max(18, Math.floor(paletteWidth * 0.42));
  const detailWidth = Math.max(12, paletteWidth - labelWidth - 8);
  const header = topLine(`Command palette · ${query || "all"} · ${total}`, paletteWidth);
  const rows = window.map((item, index) => {
    const absoluteIndex = start + index;
    const selectedRow = absoluteIndex === safeIndex;
    return {
      selected: selectedRow,
      value: bodyLine(
        `${selectedRow ? theme.rail : " "} ${glyph(item.kind)} ${fillLine(item.label, labelWidth)} ${endTruncate(item.detail, detailWidth)}`,
        paletteWidth,
      ),
    };
  });
  while (rows.length < VISIBLE_ROWS) rows.push({ selected: false, value: bodyLine("", paletteWidth) });
  const footer = bottomLine("↑↓ move · Enter open/run · Esc close", paletteWidth);

  return (
    <Box width={paletteWidth} flexDirection="column">
      {paletteLine(header, theme.color.violet, "header")}
      {rows.map((row, index) => paletteLine(row.value, row.selected ? theme.color.t1 : theme.color.t2, `row:${index}`))}
      {paletteLine(bodyLine(selected ? `${selected.label} · ${selected.detail}` : "No matches", paletteWidth), theme.color.t3, "detail")}
      {paletteLine(footer, theme.color.t4, "footer")}
    </Box>
  );
}
