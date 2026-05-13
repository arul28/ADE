import React from "react";
import { Box, Text } from "ink";
import type { AgentChatProvider, AgentChatSlashCommand } from "../../../../desktop/src/shared/types/chat";
import { paletteCommands } from "../commands";
import { theme } from "../theme";

const VISIBLE_ROWS = 5;
export const SLASH_PALETTE_ROWS = VISIBLE_ROWS + 3;
const DEFAULT_PALETTE_WIDTH = 88;
const MAX_PALETTE_WIDTH = 104;
const MIN_PALETTE_WIDTH = 56;

function clampPaletteWidth(width?: number): number {
  const available = Number.isFinite(width) ? Math.floor(width ?? DEFAULT_PALETTE_WIDTH) : DEFAULT_PALETTE_WIDTH;
  return Math.max(MIN_PALETTE_WIDTH, Math.min(MAX_PALETTE_WIDTH, available));
}

const PROVIDER_LABELS: Record<AgentChatProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  droid: "Droid",
  opencode: "OpenCode",
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

export function SlashPalette({
  query,
  userCommands,
  selectedIndex,
  provider,
  width,
}: {
  query: string;
  userCommands: AgentChatSlashCommand[];
  selectedIndex: number;
  provider?: AgentChatProvider | null;
  width?: number;
}) {
  const rows = paletteCommands(query, userCommands, { provider });
  if (!query.startsWith("/") || !rows.length) return null;
  const paletteWidth = clampPaletteWidth(width);
  const total = rows.length;
  const safeIndex = Math.max(0, Math.min(selectedIndex, total - 1));
  const half = Math.floor(VISIBLE_ROWS / 2);
  let start = Math.max(0, safeIndex - half);
  let end = Math.min(total, start + VISIBLE_ROWS);
  start = Math.max(0, end - VISIBLE_ROWS);
  const window = rows.slice(start, end);
  const aboveCount = start;
  const belowCount = total - end;
  const selected = rows[safeIndex] ?? rows[0];
  const queryLabel = query.trim() || "/";
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
  const rowLines = window.map((row, index) => {
    const absoluteIndex = start + index;
    const isSelected = absoluteIndex === safeIndex;
    const command = selectedExample(row);
    return {
      selected: isSelected,
      value: bodyLine(
        `${isSelected ? theme.rail : " "} ${fillLine(command, nameWidth)} ${endTruncate(row.description, descriptionWidth)}`,
        paletteWidth,
      ),
    };
  });
  while (rowLines.length < VISIBLE_ROWS) {
    rowLines.push({ selected: false, value: bodyLine("", paletteWidth) });
  }
  const footer = bottomLine(
    `${moreSummary ? `${moreSummary} · ` : ""}↑↓ move · Tab insert · Enter run · Esc close`,
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
