function normalizePreviewLine(raw: string): string {
  if (!raw) return "";
  return raw.replace(/\t/g, " ").replace(/\s+/g, " ").trim();
}

const CODEX_PLACEHOLDER_PROMPTS = new Set([
  "Explain this codebase",
  "Improve documentation in @filename",
  "Implement {feature}",
  "Run /review on my current changes",
  "Summarize recent commits",
  "Use /skills to list available skills",
  "Write tests for @filename",
]);

function isGhostPromptPreview(line: string): boolean {
  const normalized = line.replace(/^[•\-\s]*/, "").replace(/^›\s*/, "").trim();
  return CODEX_PLACEHOLDER_PROMPTS.has(normalized);
}

/** Widest line we keep cells for. Previews cap at 220 chars, so this is slack. */
const MAX_LINE_CELLS = 500;
/** Cursor columns past the buffer are tracked but never allocated. */
const MAX_COL = 2_000;
/** A real escape sequence is short; anything longer is a stream that lost its terminator. */
const MAX_PENDING_CHARS = 2_048;

/**
 * Cursor state carried between chunks.
 *
 * Full-screen TUIs (Claude Code/Ink, Codex) repaint only the cells that
 * changed and skip the rest with cursor-positioning sequences — the gaps ARE
 * the spaces. A stateless "delete every CSI, keep the printables" pass deletes
 * the gaps along with the sequences, which is how `ESC[50;9H g ESC[50;12H 10s`
 * used to render as `g10s`. So the preview builder keeps a column cursor into a
 * mutable line buffer and writes at the cursor, padding what it skips.
 *
 * `pending` holds a trailing partial escape sequence: PTY chunk boundaries fall
 * mid-CSI often enough that a per-chunk regex strip leaks the tail as literal
 * text (`[53;37H` in the middle of a preview). Carrying the fragment into the
 * next chunk is what stops that.
 */
export type PreviewCursorState = {
  /** Cursor column within the current line buffer (0-based). */
  col: number;
  /** Row last addressed absolutely; null until a positioning sequence says. */
  row: number | null;
  /** Trailing bytes of an escape sequence split across a chunk boundary. */
  pending: string;
};

export function createPreviewCursorState(): PreviewCursorState {
  return { col: 0, row: null, pending: "" };
}

type EscapeScan =
  /** Sequence runs past the end of the chunk — carry it into the next one. */
  | { kind: "incomplete" }
  /** Consumed and semantically irrelevant to a one-line preview (SGR, charset, …). */
  | { kind: "ignored"; length: number }
  | { kind: "csi"; length: number; params: string; final: string };

const PARAM_BYTE_MIN = 0x30; // '0'
const PARAM_BYTE_MAX = 0x3f; // '?'
const INTERMEDIATE_MIN = 0x20; // ' '
const INTERMEDIATE_MAX = 0x2f; // '/'
const FINAL_MIN = 0x40; // '@'
const FINAL_MAX = 0x7e; // '~'

function scanStringSequence(input: string, start: number): EscapeScan {
  // OSC/APC/DCS/PM run until BEL or ST (ESC \), whichever lands first.
  const bel = input.indexOf("\u0007", start + 2);
  const st = input.indexOf("\u001b\\", start + 2);
  if (bel < 0 && st < 0) return { kind: "incomplete" };
  if (st < 0 || (bel >= 0 && bel < st)) return { kind: "ignored", length: bel + 1 - start };
  return { kind: "ignored", length: st + 2 - start };
}

function scanEscape(input: string, start: number): EscapeScan {
  const next = input[start + 1];
  if (next === undefined) return { kind: "incomplete" };

  if (next === "[") {
    let i = start + 2;
    while (i < input.length) {
      const code = input.charCodeAt(i);
      if (code < PARAM_BYTE_MIN || code > PARAM_BYTE_MAX) break;
      i += 1;
    }
    const paramsEnd = i;
    while (i < input.length) {
      const code = input.charCodeAt(i);
      if (code < INTERMEDIATE_MIN || code > INTERMEDIATE_MAX) break;
      i += 1;
    }
    if (i >= input.length) return { kind: "incomplete" };
    const finalCode = input.charCodeAt(i);
    const length = i + 1 - start;
    if (finalCode < FINAL_MIN || finalCode > FINAL_MAX) return { kind: "ignored", length };
    return { kind: "csi", length, params: input.slice(start + 2, paramsEnd), final: input[i] ?? "" };
  }

  if (next === "]" || next === "_" || next === "P" || next === "^") {
    return scanStringSequence(input, start);
  }

  if (next === "(" || next === ")") {
    if (start + 2 >= input.length) return { kind: "incomplete" };
    return { kind: "ignored", length: 3 };
  }

  return { kind: "ignored", length: 2 };
}

function parseParams(raw: string): number[] {
  if (!raw || raw.startsWith("?") || raw.startsWith(">") || raw.startsWith("<")) return [];
  return raw.split(";").map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });
}

function clampCol(col: number): number {
  if (!Number.isFinite(col) || col < 0) return 0;
  return Math.min(MAX_COL, Math.floor(col));
}

export function derivePreviewFromChunk(args: {
  previousLine: string;
  previousPreview: string | null;
  chunk: string;
  maxChars?: number;
  previousCursor?: PreviewCursorState | null;
}): { nextLine: string; preview: string | null; nextCursor: PreviewCursorState } {
  const maxChars = Number.isFinite(args.maxChars) ? Math.max(20, Math.floor(args.maxChars ?? 220)) : 220;
  const previousCursor = args.previousCursor ?? null;
  const cells: string[] = Array.from(args.previousLine ?? "");
  let col = previousCursor ? clampCol(previousCursor.col) : cells.length;
  let row = previousCursor?.row ?? null;
  let preview = args.previousPreview ?? null;
  let pending = "";

  /**
   * Ends the line being assembled and publishes it as the preview.
   *
   * `keepColumn` exists because the VERTICAL moves (VPA `d`, CUU `A`, CUD `B`)
   * change the row and leave the column exactly where it was on a real
   * terminal. Resetting to 0 for those made the next glyphs land at the left
   * edge, so a TUI that hops up a row to amend a value rewrote the wrong cells.
   * `\n`, CNL `E` and CPL `F` genuinely do move to column 0.
   */
  const captureLine = (options: { keepColumn?: boolean } = {}) => {
    const normalized = normalizePreviewLine(cells.join(""));
    if (normalized.length && !isGhostPromptPreview(normalized)) preview = normalized;
    cells.length = 0;
    if (!options.keepColumn) col = 0;
  };

  const eraseCells = (from: number, to: number) => {
    for (let cell = Math.max(0, from); cell < Math.min(to, cells.length); cell += 1) {
      cells[cell] = " ";
    }
  };

  const writeChar = (ch: string) => {
    if (col < MAX_LINE_CELLS) {
      while (cells.length < col) cells.push(" ");
      cells[col] = ch;
    }
    col = clampCol(col + 1);
  };

  const applyCsi = (params: string, final: string) => {
    const values = parseParams(params);
    const first = values[0];
    switch (final) {
      case "H":
      case "f": {
        // Absolute positioning is how a TUI hops between rows. A row change
        // ends the line we were assembling; a same-row hop only moves the
        // cursor, and the cells it skipped stay as the spaces they represent.
        const nextRow = Math.max(1, first && first > 0 ? first : 1);
        if (row !== null && nextRow !== row) captureLine();
        row = nextRow;
        col = clampCol((values[1] && values[1]! > 0 ? values[1]! : 1) - 1);
        return;
      }
      case "d": {
        const nextRow = Math.max(1, first && first > 0 ? first : 1);
        if (row !== null && nextRow !== row) captureLine({ keepColumn: true });
        row = nextRow;
        return;
      }
      case "A":
      case "B": {
        const delta = Math.max(1, first && first > 0 ? first : 1);
        captureLine({ keepColumn: true });
        if (row !== null) row = Math.max(1, final === "A" ? row - delta : row + delta);
        return;
      }
      case "E":
      case "F": {
        const delta = Math.max(1, first && first > 0 ? first : 1);
        captureLine();
        if (row !== null) row = Math.max(1, final === "E" ? row + delta : row - delta);
        return;
      }
      case "G":
      case "`":
        col = clampCol((first && first > 0 ? first : 1) - 1);
        return;
      case "C":
        col = clampCol(col + Math.max(1, first && first > 0 ? first : 1));
        return;
      case "D":
        col = clampCol(col - Math.max(1, first && first > 0 ? first : 1));
        return;
      case "K": {
        const mode = first ?? 0;
        if (mode === 0) cells.length = Math.min(cells.length, col);
        else if (mode === 1) eraseCells(0, col + 1);
        else cells.length = 0;
        return;
      }
      case "J": {
        const mode = first ?? 0;
        if (mode === 0) cells.length = Math.min(cells.length, col);
        else if (mode === 1) eraseCells(0, col + 1);
        else {
          // A full clear wipes what we were assembling but never the preview
          // we already captured — the repaint that follows supplies the next.
          cells.length = 0;
          col = 0;
          row = null;
        }
        return;
      }
      case "X": {
        const count = Math.max(1, first && first > 0 ? first : 1);
        eraseCells(col, col + count);
        return;
      }
      default:
        return;
    }
  };

  const input = `${previousCursor?.pending ?? ""}${args.chunk ?? ""}`;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] ?? "";
    if (ch === "\u001b") {
      const scan = scanEscape(input, i);
      if (scan.kind === "incomplete") {
        pending = input.slice(i);
        break;
      }
      if (scan.kind === "csi") applyCsi(scan.params, scan.final);
      i += scan.length - 1;
      continue;
    }
    if (ch === "\n") {
      captureLine();
      if (row !== null) row += 1;
      continue;
    }
    if (ch === "\r") {
      // Return the cursor, keep the cells. A progress line that rewrites
      // itself overwrites what it needs and clears the rest with EL, exactly
      // as it would on a real terminal — dropping the buffer here would
      // discard the parts of the line the program deliberately left standing.
      col = 0;
      continue;
    }
    if (ch === "\b") {
      col = clampCol(col - 1);
      continue;
    }
    if (ch === "\t") {
      col = clampCol(col + 8 - (col % 8));
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) continue;
    writeChar(ch);
  }

  // A stream that lost its terminator would otherwise grow `pending` without
  // bound. Keep the TAIL rather than dropping everything: the bytes nearest the
  // boundary are the ones a genuine split escape sequence needs, so trimming
  // preserves the recoverable case while clearing discarded the next sequence
  // along with the runaway one.
  //
  // The tail must be RE-ANCHORED on an ESC, though. `pending` is only ever set
  // to `input.slice(i)` at an ESC, and the parser prepends it to the next chunk
  // expecting it to still start with one. A blind slice cuts that ESC off, and
  // the sequence body then parses as ordinary characters — up to 2 KB of
  // escape-garbage written into the preview as literal text. No ESC in the
  // tail means nothing recoverable is left, so drop it.
  if (pending.length > MAX_PENDING_CHARS) {
    const tail = pending.slice(-MAX_PENDING_CHARS);
    const escAt = tail.lastIndexOf("\u001b");
    pending = escAt === -1 ? "" : tail.slice(escAt);
  }

  const currentLine = normalizePreviewLine(cells.join(""));
  if (currentLine.length && !isGhostPromptPreview(currentLine)) preview = currentLine;

  if (preview && preview.length > maxChars) {
    preview = `${preview.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  }

  return {
    nextLine: cells.join(""),
    preview,
    nextCursor: { col: clampCol(col), row, pending },
  };
}
