import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme";

/**
 * Detailed ADE wordmark in the ANSI-Shadow figlet style: 12 rows tall × 36
 * cells wide. The last row is the shadow and tints to a deeper violet.
 */
const FACE_ROWS = [
  "    █████╗      ██████╗     ███████╗",
  "   ██╔══██╗     ██╔══██╗    ██╔════╝",
  "   ██║  ██║     ██║  ██║    ██║     ",
  "   ██║  ██║     ██║  ██║    ██║     ",
  "   ███████║     ██║  ██║    █████╗  ",
  "   ███████║     ██║  ██║    █████╗  ",
  "   ██╔══██║     ██║  ██║    ██║     ",
  "   ██╔══██║     ██║  ██║    ██║     ",
  "   ██║  ██║     ██║  ██║    ██║     ",
  "   ██║  ██║     ██║  ██║    ██║     ",
  "   ██║  ██║     ██████╔╝    ███████╗",
  "   ╚═╝  ╚═╝     ╚═════╝     ╚══════╝",
];

/**
 * Compact fallback used when the hero card is too narrow for the big version.
 * 6 rows tall — same height as the previous wordmark — with shadow corners.
 */
const COMPACT_ROWS = [
  " █████╗  ██████╗  ███████╗",
  "██╔══██╗ ██╔══██╗ ██╔════╝",
  "███████║ ██║  ██║ █████╗  ",
  "██╔══██║ ██║  ██║ ██╔══╝  ",
  "██║  ██║ ██████╔╝ ███████╗",
  "╚═╝  ╚═╝ ╚═════╝  ╚══════╝",
];

export const ADE_WORDMARK_FULL_WIDTH = 36;
export const ADE_WORDMARK_COMPACT_WIDTH = 26;

export function AdeWordmark({ compact = false }: { compact?: boolean } = {}) {
  const rows = compact ? COMPACT_ROWS : FACE_ROWS;
  return (
    <Box flexDirection="column" alignItems="flex-start">
      {rows.map((row, index) => {
        const isShadow = index === rows.length - 1;
        return (
          <Text
            key={index}
            color={isShadow ? theme.color.violetDeep : theme.color.accent}
            bold
          >
            {row}
          </Text>
        );
      })}
    </Box>
  );
}
