import type { IBufferCell, Terminal } from "@xterm/xterm";
import type { TerminalSnapshotCell, TerminalSnapshotRow } from "../../../shared/types";

/**
 * Alternate-screen switches. A full-screen CLI (Claude Code) draws on the
 * alternate buffer, which has no scrollback and is cleared on exit, so its
 * final screen is nearly empty. Played into the normal buffer instead, the
 * conversation it printed stays in the scrollback.
 */
const ALTERNATE_SCREEN_SWITCH = /\x1b\[\?(?:1049|1047|47)[hl]/g;

/** True when the transcript switched to the alternate screen at least once. */
export function transcriptUsesAlternateScreen(transcript: string): boolean {
  return /\x1b\[\?(?:1049|1047|47)h/.test(transcript);
}
/** The replay height when the original one is unknown. */
const DEFAULT_PREVIEW_ROWS = 40;
const MIN_PREVIEW_ROWS = 10;
const MAX_PREVIEW_ROWS = 300;
const PREVIEW_SCROLLBACK = 4_000;
const MIN_PREVIEW_COLS = 20;
const MAX_PREVIEW_COLS = 400;

function snapshotCell(cell: IBufferCell | undefined): TerminalSnapshotCell {
  if (!cell || cell.getWidth() === 0 || cell.isInvisible()) {
    return { text: " ", fg: null, bg: null, fgMode: "default", bgMode: "default" };
  }
  const fgMode = cell.isFgRGB() ? "rgb" : cell.isFgPalette() ? "palette" : "default";
  const bgMode = cell.isBgRGB() ? "rgb" : cell.isBgPalette() ? "palette" : "default";
  return {
    text: cell.getChars() || " ",
    fg: fgMode === "default" ? null : cell.getFgColor(),
    bg: bgMode === "default" ? null : cell.getBgColor(),
    fgMode,
    bgMode,
    ...(cell.isBold() ? { bold: true } : {}),
    ...(cell.isDim() ? { dim: true } : {}),
    ...(cell.isItalic() ? { italic: true } : {}),
    ...(cell.isUnderline() ? { underline: true } : {}),
    ...(cell.isInverse() ? { inverse: true } : {}),
    ...(cell.isStrikethrough() ? { strikethrough: true } : {}),
  };
}

/**
 * The last `maxRows` non-blank-ended rows of a raw terminal transcript, as the
 * machine's own preview gives them, played into an xterm that is never put on
 * screen. The web client has no stored snapshot, and the desktop's stored one
 * of a full-screen CLI that exited is the empty normal screen. Null when the
 * emulator does not load.
 */
export async function previewRowsFromTranscript(
  transcript: string,
  size: { cols: number; rows?: number | null },
  maxRows: number,
): Promise<TerminalSnapshotRow[] | null> {
  if (!transcript) return null;
  let TerminalCtor: typeof Terminal;
  try {
    ({ Terminal: TerminalCtor } = await import("@xterm/xterm"));
  } catch {
    return null;
  }
  // The terminal's own size: a CLI places text by row and column, and a
  // smaller replay clamps its moves onto the last row and column.
  const width = Math.max(MIN_PREVIEW_COLS, Math.min(MAX_PREVIEW_COLS, Math.floor(size.cols) || 80));
  const height = Math.max(MIN_PREVIEW_ROWS, Math.min(MAX_PREVIEW_ROWS, Math.floor(size.rows ?? 0) || DEFAULT_PREVIEW_ROWS));
  const term = new TerminalCtor({
    cols: width,
    rows: height,
    scrollback: PREVIEW_SCROLLBACK,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((resolve) => term.write(transcript.replace(ALTERNATE_SCREEN_SWITCH, ""), resolve));
    const buffer = term.buffer.normal;
    let end = buffer.length;
    while (end > 0 && !buffer.getLine(end - 1)?.translateToString(true).trim()) end -= 1;
    const start = Math.max(0, end - maxRows);
    const reusable = buffer.getNullCell();
    const rows: TerminalSnapshotRow[] = [];
    for (let y = start; y < end; y += 1) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const cells: TerminalSnapshotCell[] = [];
      for (let x = 0; x < width; x += 1) cells.push(snapshotCell(line.getCell(x, reusable)));
      rows.push({ cells, text: line.translateToString(true), wrapped: line.isWrapped });
    }
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  } finally {
    term.dispose();
  }
}
