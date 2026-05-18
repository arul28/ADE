import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "ink";
import * as HeadlessXterm from "@xterm/headless";
import type {
  ChatTerminalPreviewResult,
  TerminalSnapshotCell,
  TerminalSnapshotRow,
} from "../../../../desktop/src/shared/types";
import { useSpinFrame } from "../spinTick";
import { theme } from "../theme";

type HeadlessXtermModule = typeof HeadlessXterm;

const headlessXtermModule = ((HeadlessXterm as unknown as { default?: HeadlessXtermModule }).default
  ?? HeadlessXterm) as HeadlessXtermModule;
const { Terminal: HeadlessTerminal } = headlessXtermModule;

type TerminalPaneProps = {
  title: string;
  preview: ChatTerminalPreviewResult | null;
  liveChunks: string[];
  attached: boolean;
  width: number;
  height: number;
  hiddenBottomRows?: number;
};

type HeadlessTerminalInstance = InstanceType<typeof HeadlessTerminal>;
type XtermBufferCell = {
  getWidth(): number;
  getChars(): string;
  getFgColor(): number;
  getBgColor(): number;
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
};
type TerminalRunStyle = {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strikethrough?: boolean;
};
type TerminalRun = {
  text: string;
  style: TerminalRunStyle;
};
type TerminalStyledRow = {
  runs: TerminalRun[];
};

export const MAX_TERMINAL_PANE_COLS = 400;

function finiteFloor(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

export function clampTerminalPaneCols(width: number): number {
  return Math.max(20, Math.min(MAX_TERMINAL_PANE_COLS, finiteFloor(width, 20)));
}

function clampTerminalPaneRows(height: number): number {
  return Math.max(4, Math.min(120, finiteFloor(height, 4)));
}

const XTERM_16_COLORS = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#ffffff",
] as const;

function stripTerminalControls(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][0-2AB]/g, "")
    .replace(/\x1b(?:[@-Z\\-_]|[0-9=>])/g, "")
    .replace(/\r(?!\n)/g, "\n");
}

function rgbColor(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const safe = Math.max(0, Math.min(0xffffff, Math.floor(value)));
  return `#${safe.toString(16).padStart(6, "0")}`;
}

function paletteColor(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const index = Math.max(0, Math.min(255, Math.floor(value)));
  if (index < XTERM_16_COLORS.length) return XTERM_16_COLORS[index];
  if (index >= 16 && index <= 231) {
    const offset = index - 16;
    const r = Math.floor(offset / 36);
    const g = Math.floor((offset % 36) / 6);
    const b = offset % 6;
    const channel = (part: number) => part === 0 ? 0 : 55 + part * 40;
    return rgbColor((channel(r) << 16) + (channel(g) << 8) + channel(b));
  }
  const gray = 8 + (index - 232) * 10;
  return rgbColor((gray << 16) + (gray << 8) + gray);
}

function cellColor(mode: "default" | "palette" | "rgb", value: number | null): string | undefined {
  if (mode === "rgb") return rgbColor(value);
  if (mode === "palette") return paletteColor(value);
  return undefined;
}

function styleForCell(cell: TerminalSnapshotCell): TerminalRunStyle {
  let color = cellColor(cell.fgMode, cell.fg);
  let backgroundColor = cellColor(cell.bgMode, cell.bg);
  if (cell.inverse) {
    const nextColor = backgroundColor;
    backgroundColor = color;
    color = nextColor;
  }
  return {
    ...(color ? { color } : {}),
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(cell.bold ? { bold: true } : {}),
    ...(cell.dim ? { dim: true } : {}),
    ...(cell.italic ? { italic: true } : {}),
    ...(cell.underline ? { underline: true } : {}),
    ...(cell.inverse ? { inverse: true } : {}),
    ...(cell.strikethrough ? { strikethrough: true } : {}),
  };
}

function styleKey(style: TerminalRunStyle): string {
  return [
    style.color ?? "",
    style.backgroundColor ?? "",
    style.bold ? "b" : "",
    style.dim ? "d" : "",
    style.italic ? "i" : "",
    style.underline ? "u" : "",
    style.inverse ? "v" : "",
    style.strikethrough ? "s" : "",
  ].join("|");
}

function styledRowFromCells(cells: TerminalSnapshotCell[], fallbackText = ""): TerminalStyledRow {
  if (!cells.length) return { runs: [{ text: fallbackText || " ", style: {} }] };
  const runs: TerminalRun[] = [];
  for (const cell of cells) {
    const text = cell.text || " ";
    const style = styleForCell(cell);
    const last = runs[runs.length - 1];
    if (last && styleKey(last.style) === styleKey(style)) {
      last.text += text;
    } else {
      runs.push({ text, style });
    }
  }
  if (!runs.length) runs.push({ text: fallbackText || " ", style: {} });
  return { runs };
}

function snapshotCellFromXtermCell(cell: XtermBufferCell | undefined): TerminalSnapshotCell {
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

function styledRowsFromTerminal(terminal: HeadlessTerminalInstance, maxRows: number): TerminalStyledRow[] {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.viewportY);
  const rows: TerminalStyledRow[] = [];
  for (let row = 0; row < Math.max(0, maxRows); row += 1) {
    const line = buffer.getLine(start + row);
    if (!line) {
      rows.push({ runs: [{ text: " ", style: {} }] });
      continue;
    }
    const cells: TerminalSnapshotCell[] = [];
    for (let column = 0; column < terminal.cols; column += 1) {
      cells.push(snapshotCellFromXtermCell(line.getCell(column) as unknown as XtermBufferCell | undefined));
    }
    rows.push(styledRowFromCells(cells, line.translateToString(true)));
  }
  return rows;
}

export function styledRowsFromSnapshotRows(rows: TerminalSnapshotRow[], maxRows: number): TerminalStyledRow[] {
  return rows.slice(0, Math.max(0, maxRows)).map((row) => styledRowFromCells(row.cells, row.text));
}

function transcriptPreviewRows(transcript: string | null | undefined, maxRows: number): TerminalStyledRow[] {
  const text = stripTerminalControls(transcript ?? "").trimEnd();
  if (!text) return [{ runs: [{ text: "No terminal output yet.", style: {} }] }];
  return text.split(/\r\n|\n|\r/).slice(-maxRows).map((line) => ({ runs: [{ text: line || " ", style: {} }] }));
}

function fallbackPreviewRows(preview: ChatTerminalPreviewResult | null, maxRows: number): TerminalStyledRow[] {
  if (!preview) return [{ runs: [{ text: "No terminal preview yet.", style: {} }] }];
  if (preview.snapshot?.visibleRows?.length) {
    return styledRowsFromSnapshotRows(preview.snapshot.visibleRows, maxRows);
  }
  return transcriptPreviewRows(preview.transcript, maxRows);
}

function terminalControlBorderColor(frame: string): string {
  return frame === "◐" || frame === "◑" ? theme.color.warning : theme.color.attention2;
}

export function TerminalPane({
  title,
  preview,
  liveChunks,
  attached,
  width,
  height,
  hiddenBottomRows = 0,
}: TerminalPaneProps) {
  const spinFrame = useSpinFrame();
  const effectiveHiddenBottomRows = attached ? 0 : hiddenBottomRows;
  const contentWidth = attached ? Math.max(1, width - 2) : width;
  const visibleHeight = attached ? Math.max(1, height - 1) : height;
  const cols = clampTerminalPaneCols(contentWidth);
  const rows = clampTerminalPaneRows(visibleHeight);
  const emulatedRows = clampTerminalPaneRows(rows + Math.max(0, finiteFloor(effectiveHiddenBottomRows, 0)));
  const snapshotCols = preview?.snapshot?.cols ?? null;
  const snapshotMatchesLayout = snapshotCols == null
    || snapshotCols === cols
    || (attached && snapshotCols != null && Math.abs(snapshotCols - cols) <= 2);
  const useSnapshotRows = Boolean(
    preview?.snapshot?.visibleRows?.length
      && (preview.session.status === "running" || !preview.transcript)
      && snapshotMatchesLayout,
  );
  const snapshotRows = useMemo(
    () => useSnapshotRows && preview?.snapshot?.visibleRows
      ? styledRowsFromSnapshotRows(preview.snapshot.visibleRows, rows)
      : null,
    [cols, preview?.snapshot, rows, useSnapshotRows],
  );
  const seed = useSnapshotRows ? "" : preview?.transcript ?? "";
  const terminalRef = useRef<HeadlessTerminalInstance | null>(null);
  const chunkIndexRef = useRef(0);
  const [renderTick, setRenderTick] = useState(0);

  useEffect(() => {
    const terminal = new HeadlessTerminal({
      allowProposedApi: true,
      cols,
      rows: emulatedRows,
      scrollback: 2_000,
    });
    terminalRef.current = terminal;
    chunkIndexRef.current = 0;
    if (seed) {
      terminal.write(seed, () => setRenderTick((tick) => tick + 1));
    } else {
      setRenderTick((tick) => tick + 1);
    }
    return () => {
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
    };
  }, [cols, emulatedRows, preview?.terminalId, seed]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (terminal.cols !== cols || terminal.rows !== emulatedRows) {
      terminal.resize(cols, emulatedRows);
      setRenderTick((tick) => tick + 1);
    }
  }, [cols, emulatedRows]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const start = chunkIndexRef.current;
    if (liveChunks.length < start) chunkIndexRef.current = 0;
    for (let index = chunkIndexRef.current; index < liveChunks.length; index += 1) {
      terminal.write(liveChunks[index] ?? "", () => setRenderTick((tick) => tick + 1));
    }
    chunkIndexRef.current = liveChunks.length;
  }, [liveChunks]);

  const lines = useMemo(() => {
    if (snapshotRows?.length) return snapshotRows.slice(0, rows);
    if (preview?.transcript && preview.session.status !== "running" && !liveChunks.length) {
      return transcriptPreviewRows(preview.transcript, rows);
    }
    const terminal = terminalRef.current;
    if (terminal) return styledRowsFromTerminal(terminal, rows);
    return fallbackPreviewRows(preview, rows);
  }, [liveChunks.length, preview, renderTick, rows, snapshotRows]);

  const status = attached
    ? "CLAUDE CONTROL · Ctrl+T returns to ADE · Ctrl+] escape"
    : preview?.session.status === "running"
      ? effectiveHiddenBottomRows > 0 ? "ADE prompt sends to Claude Code" : "live preview"
      : preview?.session.resumeCommand
        ? "closed, resumable"
        : "closed";

  const content = (
    <>
      <Box width={contentWidth}>
        <Text color={attached ? theme.color.warning : theme.color.accent}>
          {attached ? `${spinFrame} ${title}` : title}
        </Text>
        <Text color={theme.color.mutedFg}>  {status}</Text>
      </Box>
      <Box flexDirection="column" width={contentWidth} height={visibleHeight} overflow="hidden">
        {lines.slice(0, visibleHeight).map((line, index) => (
          <Text key={index} wrap="truncate">
            {line.runs.map((run, runIndex) => (
              <Text
                key={`${runIndex}:${run.text}`}
                color={run.style.color}
                backgroundColor={run.style.backgroundColor}
                bold={run.style.bold}
                dimColor={run.style.dim}
                italic={run.style.italic}
                underline={run.style.underline}
                inverse={run.style.inverse}
                strikethrough={run.style.strikethrough}
              >
                {run.text || " "}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
    </>
  );

  if (attached) {
    return (
      <Box
        flexDirection="column"
        width={width}
        height={height + 2}
        borderStyle="round"
        borderColor={terminalControlBorderColor(spinFrame)}
      >
        {content}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height + 2}>
      {content}
    </Box>
  );
}
