import React from "react";
import { Box, Text } from "ink";
import type { AgentChatSlashCommand } from "../../../../desktop/src/shared/types/chat";
import { paletteCommands } from "../commands";

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
  if (!query.startsWith("/")) return null;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {rows.map((row, index) => (
        <Text key={`${row.source}:${row.name}`}>
          <Text color={index === selectedIndex ? "#A78BFA" : "gray"}>{index === selectedIndex ? "›" : " "}</Text>
          <Text color={row.source === "user" ? "#A78BFA" : "gray"}>{row.source}</Text>
          <Text> {row.name.padEnd(16)} </Text>
          <Text dimColor>{row.description}</Text>
        </Text>
      ))}
    </Box>
  );
}
