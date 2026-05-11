import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme";

const ROWS = [
  " ████    █████    ██████",
  "██  ██   ██  ██   ██    ",
  "██████   ██  ██   █████ ",
  "██  ██   ██  ██   ██    ",
  "██  ██   █████    ██████",
];

export function AdeWordmark() {
  return (
    <Box flexDirection="column" alignItems="flex-start">
      {ROWS.map((row, index) => (
        <Text key={index} color={theme.color.accent} bold>
          {row}
        </Text>
      ))}
    </Box>
  );
}
