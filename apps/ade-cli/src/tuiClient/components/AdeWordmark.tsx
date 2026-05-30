import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme";

/**
 * ADE wordmark — solid, logo-style letterforms with a layered 3D drop shadow.
 *
 * The face is uniform bright brand violet (like the white letters on the real
 * app icon), and a three-step diagonal shadow falls down-right in progressively
 * deeper violets, giving real extruded depth. The shadow only lands on the
 * outer bottom-right *rim* of the silhouette (computed by flooding the exterior
 * from the border, then skipping any cell with a face directly below or right)
 * so letter counters and notches stay open and crisp instead of filling in.
 *
 * The whole thing is composited once at module load into a flat list of colored
 * runs per row — rendering is a trivial pure map, zero runtime state, zero idle
 * re-renders.
 */

// Solid 6×N glyph sprites (`#` = filled, `.` = empty). Bold, blocky forms that
// echo the app icon: peaked A with a counter, rounded D, chunky E.
const GLYPH_A = [
  "..####..",
  ".##..##.",
  "##....##",
  "########",
  "##....##",
  "##....##",
];
const GLYPH_D = [
  "######..",
  "##...##.",
  "##....##",
  "##....##",
  "##...##.",
  "######..",
];
const GLYPH_E = [
  "#######",
  "##.....",
  "#####..",
  "#####..",
  "##.....",
  "#######",
];

// face / shadow-layer-1 / 2 / 3
type Cell = "F" | "1" | "2" | "3" | " ";
type Run = { text: string; color: string | null };

const SHADOW_COLORS: Record<"1" | "2" | "3", string> = {
  "1": theme.color.violetDeep,
  "2": theme.color.violetDeeper,
  "3": theme.color.violetDeepest,
};

/** Join the three glyphs side by side with `gap` blank columns between them. */
function faceRows(gap: number): string[] {
  const sep = " ".repeat(gap);
  return GLYPH_A.map((_, r) => `${GLYPH_A[r]}${sep}${GLYPH_D[r]}${sep}${GLYPH_E[r]}`);
}

/**
 * Stamp the solid face plus a `depth`-step layered diagonal drop shadow onto a
 * canvas. The shadow only lands on exterior rim cells (no face directly below
 * or to the right), so it hugs the outer bottom-right edge and never fills the
 * open counters/notches. Nearest face diagonal sets the shadow layer (1 =
 * closest/brightest deep violet … depth = farthest/darkest). Face drawn last.
 */
function buildCanvas(face: string[], depth: number): Cell[][] {
  const h = face.length;
  const w = face[0]!.length;
  const H = h + depth;
  const W = w + depth;
  const isFace = (r: number, c: number) => r >= 0 && c >= 0 && r < h && c < w && face[r]![c] === "#";
  const canvas: Cell[][] = Array.from({ length: H }, () => Array.from({ length: W }, () => " " as Cell));

  // Flood the exterior from the border so enclosed counters are excluded.
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

  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (!outside[r]![c]) continue;
      // Rim only: skip cells that sit directly above or left of the face, so the
      // shadow doesn't bleed into interior notches.
      if (isFace(r + 1, c) || isFace(r, c + 1)) continue;
      for (let k = 1; k <= depth; k++) {
        if (isFace(r - k, c - k)) { canvas[r]![c] = String(k) as Cell; break; }
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

/** Collapse a canvas into per-row runs of same-colored cells. */
function canvasToRuns(canvas: Cell[][]): Run[][] {
  return canvas.map((row) => {
    const runs: Run[] = [];
    let text = "";
    let color: string | null = null;
    const flush = () => { if (text) runs.push({ text, color }); text = ""; };
    for (const cell of row) {
      const ch = cell === " " ? " " : "█";
      const cellColor = cell === "F" ? theme.color.violet : cell === " " ? null : SHADOW_COLORS[cell];
      if (cellColor !== color) { flush(); color = cellColor; }
      text += ch;
    }
    flush();
    return runs;
  });
}

// Full: wide letter gaps + 3-layer shadow. Compact: tighter, 2-layer shadow.
const FULL_RUNS = canvasToRuns(buildCanvas(faceRows(2), 3));
const COMPACT_RUNS = canvasToRuns(buildCanvas(faceRows(1), 2));

// 8+gap+8+gap+7 + depth shadow cols. Full: 27+3 = 30. Compact: 25+2 = 27.
export const ADE_WORDMARK_FULL_WIDTH = 30;
export const ADE_WORDMARK_COMPACT_WIDTH = 27;

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
