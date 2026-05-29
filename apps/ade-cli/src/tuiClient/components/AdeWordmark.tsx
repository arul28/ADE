import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme";

/**
 * ADE wordmark — solid, logo-style letterforms with a real diagonal 3D
 * extrusion (not the old hollow ANSI-shadow outline). The face letters are
 * filled blocks tinted with the brand violet (lit from above), and a deeper
 * violet extrusion drops down-right to give it depth. Shorter than the prior
 * 12-row figlet so it doesn't dominate the hero card.
 *
 * The whole thing is composited once at module load into a flat list of
 * colored runs per row, so rendering is a trivial pure map — zero runtime
 * state, zero idle re-renders.
 */

// Solid 6×7 glyph sprites (`#` = filled, `.` = empty). Letterforms chosen to
// echo the app icon: peaked A with a counter, rounded D, blocky E.
const GLYPH_A = [
  "..###..",
  ".##.##.",
  "##...##",
  "#######",
  "##...##",
  "##...##",
];
const GLYPH_D = [
  "#####..",
  "##..##.",
  "##...##",
  "##...##",
  "##..##.",
  "#####..",
];
const GLYPH_E = [
  "#######",
  "##.....",
  "#####..",
  "##.....",
  "##.....",
  "#######",
];

type Cell = "F" | "S" | " ";
type Run = { text: string; color: string | null };

/** Join the three glyphs side by side with `gap` blank columns between them. */
function faceRows(gap: number): string[] {
  const sep = " ".repeat(gap);
  return GLYPH_A.map((_, r) => `${GLYPH_A[r]}${sep}${GLYPH_D[r]}${sep}${GLYPH_E[r]}`);
}

/**
 * Stamp the solid face plus a `depth`-step diagonal drop shadow (down-right)
 * onto a canvas. The shadow only lands on *exterior* cells — found by flooding
 * inward from the border through non-face cells — so letter counters (the holes
 * in A and D) stay open and crisp like the real logo, instead of filling with
 * shadow. The face is drawn last so it always sits on top.
 */
function buildCanvas(face: string[], depth: number): Cell[][] {
  const h = face.length;
  const w = face[0]!.length;
  const H = h + depth;
  const W = w + depth;
  const isFace = (r: number, c: number) => r >= 0 && c >= 0 && r < h && c < w && face[r]![c] === "#";
  const canvas: Cell[][] = Array.from({ length: H }, () => Array.from({ length: W }, () => " " as Cell));

  // Flood-fill the exterior from the border so enclosed counters are excluded.
  const outside: boolean[][] = Array.from({ length: H }, () => Array<boolean>(W).fill(false));
  const stack: Array<[number, number]> = [];
  for (let r = 0; r < H; r++) stack.push([r, 0], [r, W - 1]);
  for (let c = 0; c < W; c++) stack.push([0, c], [H - 1, c]);
  while (stack.length) {
    const [r, c] = stack.pop()!;
    if (r < 0 || c < 0 || r >= H || c >= W || outside[r]![c] || isFace(r, c)) continue;
    outside[r]![c] = true;
    stack.push([r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]);
  }

  // Shadow: an exterior cell that is the down-right drop of a face cell.
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (!outside[r]![c]) continue;
      for (let k = 1; k <= depth; k++) {
        if (isFace(r - k, c - k)) { canvas[r]![c] = "S"; break; }
      }
    }
  }
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (face[r]![c] === "#") canvas[r]![c] = "F";
    }
  }
  return canvas;
}

/**
 * Brand ramp for the face: top rows glow with the brighter brand violet and
 * ease toward the deeper violet lower down, for a lit-from-above feel.
 */
const FACE_RAMP = [theme.color.violet, theme.color.accent, theme.color.violetDeep] as const;

function faceColorFor(position: number): string {
  const last = FACE_RAMP.length - 1;
  const scaled = Math.min(last, Math.max(0, Math.round(position * last)));
  return FACE_RAMP[scaled]!;
}

/** Collapse a canvas into per-row runs of same-colored cells. */
function canvasToRuns(canvas: Cell[][]): Run[][] {
  const lastIndex = Math.max(1, canvas.length - 1);
  return canvas.map((row, r) => {
    const faceColor = faceColorFor(r / lastIndex);
    const runs: Run[] = [];
    let text = "";
    let color: string | null = null;
    const flush = () => { if (text) runs.push({ text, color }); text = ""; };
    for (const cell of row) {
      const ch = cell === " " ? " " : "█";
      const cellColor = cell === "F" ? faceColor : cell === "S" ? theme.color.violetDeep : null;
      if (cellColor !== color) { flush(); color = cellColor; }
      text += ch;
    }
    flush();
    return runs;
  });
}

// Solid letters + a 1-step exterior drop shadow. Full uses wider letter gaps.
const FULL_RUNS = canvasToRuns(buildCanvas(faceRows(2), 1));
const COMPACT_RUNS = canvasToRuns(buildCanvas(faceRows(1), 1));

// 7+gap+7+gap+7 + 1 shadow col. Full: 25+1 = 26. Compact: 23+1 = 24.
export const ADE_WORDMARK_FULL_WIDTH = 26;
export const ADE_WORDMARK_COMPACT_WIDTH = 24;

export function AdeWordmark({ compact = false }: { compact?: boolean } = {}) {
  const rows = compact ? COMPACT_RUNS : FULL_RUNS;
  return (
    <Box flexDirection="column" alignItems="flex-start">
      {rows.map((rowRuns, index) => (
        <Text key={index} bold>
          {rowRuns.map((run, runIndex) =>
            run.color === null ? (
              <Text key={runIndex}>{run.text}</Text>
            ) : (
              <Text key={runIndex} color={run.color}>{run.text}</Text>
            ),
          )}
        </Text>
      ))}
    </Box>
  );
}
