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

/**
 * Vertical brand ramp for the wordmark, expressed purely in theme tokens. Top
 * rows glow with the brighter brand violet (`theme.color.violet` / `accent`)
 * and ease down to the deeper violet (`theme.color.violetDeep`) at the shadow
 * row, giving the figlet a lit-from-above, branded feel instead of a flat
 * two-tone block. The upper stops hold the bright brand violet (`violet` and
 * its `accent` alias) before easing into the deep violet base, keeping the
 * ramp a tasteful violet → violet-deep gradient with no off-brand colors.
 */
const WORDMARK_RAMP = [
  theme.color.violet,
  theme.color.accent,
  theme.color.violetDeep,
] as const;

/**
 * Map a row's position (0 = top, 1 = bottom) onto the brand ramp. Pure and
 * deterministic, so the wordmark renders identically every time with zero
 * dependence on runtime state — keeping idle re-renders at zero.
 */
function rampColorFor(position: number): string {
  const lastStop = WORDMARK_RAMP.length - 1;
  const scaled = Math.min(lastStop, Math.max(0, Math.round(position * lastStop)));
  return WORDMARK_RAMP[scaled]!;
}

export function AdeWordmark({ compact = false }: { compact?: boolean } = {}) {
  const rows = compact ? COMPACT_ROWS : FACE_ROWS;
  const lastIndex = Math.max(1, rows.length - 1);
  return (
    <Box flexDirection="column" alignItems="flex-start">
      {rows.map((row, index) => {
        const isShadow = index === rows.length - 1;
        // The shadow row always sits at the deepest violet so the wordmark
        // keeps its grounded base; the face rows ride the vertical ramp.
        const color = isShadow
          ? theme.color.violetDeep
          : rampColorFor(index / lastIndex);
        return (
          <Text key={index} color={color} bold>
            {row}
          </Text>
        );
      })}
    </Box>
  );
}
