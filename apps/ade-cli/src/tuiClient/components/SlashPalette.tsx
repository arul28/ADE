import React from "react";
import { Box, Text } from "ink";
import type { AgentChatSlashCommand } from "../../../../desktop/src/shared/types/chat";
import { paletteCommands } from "../commands";

const VISIBLE_ROWS = 9;

export function SlashPalette({
  query,
  userCommands,
  selectedIndex,
}: {
  query: string;
  userCommands: AgentChatSlashCommand[];
  selectedIndex: number;
}) {
  const rows = paletteCommands(query, userCommands);
  if (!query.startsWith("/") || !rows.length) return null;
  const total = rows.length;
  const safeIndex = Math.max(0, Math.min(selectedIndex, total - 1));
  const half = Math.floor(VISIBLE_ROWS / 2);
  let start = Math.max(0, safeIndex - half);
  let end = Math.min(total, start + VISIBLE_ROWS);
  start = Math.max(0, end - VISIBLE_ROWS);
  const window = rows.slice(start, end);
  const aboveCount = start;
  const belowCount = total - end;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {aboveCount ? <Text dimColor>↑ {aboveCount} more</Text> : null}
      {window.map((row, index) => {
        const absoluteIndex = start + index;
        const selected = absoluteIndex === safeIndex;
        return (
          <Text key={`${row.source}:${row.name}`}>
            <Text color={selected ? "#A78BFA" : "gray"}>{selected ? "›" : " "}</Text>
            <Text color={row.source === "user" ? "#A78BFA" : "gray"}>{row.source}</Text>
            <Text> {row.name.padEnd(16)} </Text>
            <Text dimColor>{row.description}</Text>
          </Text>
        );
      })}
      {belowCount ? <Text dimColor>↓ {belowCount} more</Text> : null}
    </Box>
  );
}
