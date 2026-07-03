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
  terminalId?: string | null;
  /** Provider label shown in the control/preview status ("Claude", "Codex", …). Defaults to Claude Code. */
  cliLabel?: string | null;
  /**
   * Apply the Claude-specific closed-transcript chrome stripping (spinner/box
   * noise filters). Off for other providers, which get a plain control strip.
   */
  claudeChrome?: boolean;
  preview: ChatTerminalPreviewResult | null;
  liveChunks: string[];
  attached: boolean;
  width: number;
  height: number;
  hiddenBottomRows?: number;
  /**
   * Render only the terminal content rows (no header line, no outer box). Used by
   * grid tiles, which supply their own bordered chrome + title via MultiChatGrid.
   */
  bodyOnly?: boolean;
  /** Claude session still on a placeholder title: show a subtle "naming…" hint. */
  namingHint?: boolean;
  /** Rows scrolled up from the live bottom. 0 = pinned (auto-follow). */
  scrollOffset?: number;
  /** Count of new lines that arrived while scrolled up; renders the "↓ N new" chip. */
  pendingNewCount?: number;
  /**
   * Reports the maximum rows the buffer can scroll back (so app.tsx can clamp
   * keyboard scroll requests) plus the current plain-text of the visible window
   * (so app.tsx can copy the visible region via its existing writeClipboardText).
   * Cheap: only fires when the rendered window actually changes.
   */
  onViewportMetrics?: (metrics: { maxScrollable: number; visibleText: string }) => void;
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

const CLAUDE_SPINNER_RE = /^[✻✶✳✢✽·◐◑◒◓⏺●○]\s*(?:\d+|[.·…-]+)?$/;
const CLAUDE_SPINNER_STATUS_WORDS = [
  "baked",
  "churned",
  "churning",
  "cogitated",
  "crunched",
  "crunching",
  "hatching",
  "orbiting",
  "pondered",
  "thinking",
  "tinkered",
  "topsy",
  "topy",
  "working",
] as const;
const CLAUDE_SPINNER_STATUS_RE = new RegExp(
  `^[✻✶✳✢✽·◐◑◒◓]\\s*(?:${CLAUDE_SPINNER_STATUS_WORDS.join("|")})\\b`,
  "i",
);
const CLAUDE_USAGE_STATUS_RE = /^\(?\d+s\s+·\s+↓\s*[\d.]+[kKmM]?\s+tokens?\)?$/;
const TERMINAL_BOX_CHROME_RE = /^[\s╭╮╰╯│┃┌┐└┘├┤┬┴┼─━═║╔╗╚╝╟╢╤╧╪]+$/;
const CLAUDE_INPUT_CHROME_RE = /^│\s*(?:[>›?]\s*.*)?\s*│?$/;
const CLAUDE_PROMPT_CHROME_RE = /^[❯>›]\s*/;
const CLAUDE_FOOTER_CHROME_RE = /^(?:esc|ctrl|shift\+tab|tab|enter|return|auto-accept|bypass permissions|accept edits|edit mode)\b/i;
const CLAUDE_SESSION_CHROME_RE = /(?:Claude Code\s*v?\d|What's new|Welcome back|release-notes|Statusline JSON|Claude Max|Organization|MCP server failed|connector needs auth|Claude in Chrome enabled|Resume this session with:|claude --resume|for shortcuts|low\s*·\s*\/effort|Added\s*`?claude|agent_id|parent_agent_id|~\/.*(?:Projects|worktrees)|\/mcp|\/chrome)/i;
const CLAUDE_LOGO_RE = /[▐▛▜▝▘█]{2,}/;

function normalizeClosedTerminalLine(line: string): string {
  return line
    .replace(/\u00a0/g, " ")
    .replace(/^[⏺●]\s*/, "");
}

function isShortClaudeSpinnerResidue(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 10) return false;
  if (!/^[✻✶✳✢✽·◐◑◒◓….\sA-Za-z]+$/.test(trimmed)) return false;
  const letters = trimmed.replace(/[✻✶✳✢✽·◐◑◒◓….\s]/g, "").toLowerCase();
  if (!letters) return true;
  if (letters === "ok" || letters === "yes" || letters === "no") return false;
  return letters.length <= 1
    || (letters.length <= 4 && /^[a-z]+$/.test(letters))
    || CLAUDE_SPINNER_STATUS_WORDS.some((word) => word.includes(letters));
}

function isNoisyClosedTerminalLine(line: string): boolean {
  const normalized = normalizeClosedTerminalLine(line);
  const trimmed = normalized.trim();
  if (!trimmed) return false;
  if (CLAUDE_SPINNER_RE.test(trimmed)) return true;
  if (CLAUDE_SPINNER_STATUS_RE.test(trimmed)) return true;
  if (CLAUDE_USAGE_STATUS_RE.test(trimmed)) return true;
  if (TERMINAL_BOX_CHROME_RE.test(trimmed)) return true;
  if (CLAUDE_INPUT_CHROME_RE.test(trimmed) && /[╭╮╰╯│┃─━═]/.test(normalized)) return true;
  if (CLAUDE_PROMPT_CHROME_RE.test(trimmed)) return true;
  if (CLAUDE_FOOTER_CHROME_RE.test(trimmed)) return true;
  if (CLAUDE_SESSION_CHROME_RE.test(trimmed)) return true;
  if (CLAUDE_LOGO_RE.test(trimmed)) return true;
  if (/^·\s*esc to interrupt$/i.test(trimmed)) return true;
  if (/^←\s*for agents$/i.test(trimmed)) return true;
  return false;
}

function compactClosedTerminalTranscript(value: string): string[] {
  const lines = stripTerminalControls(value).split(/\r\n|\n|\r/);
  const compacted: string[] = [];
  let lastWasBlank = false;
  for (const rawLine of lines) {
    const line = normalizeClosedTerminalLine(rawLine).trimEnd();
    if (isNoisyClosedTerminalLine(line)) continue;
    const blank = line.trim().length === 0;
    if (blank && lastWasBlank) continue;
    compacted.push(line);
    lastWasBlank = blank;
  }
  while (compacted.length && compacted[0]!.trim().length === 0) compacted.shift();
  while (compacted.length && compacted[compacted.length - 1]!.trim().length === 0) compacted.pop();
  const numericResidueCount = compacted.filter((line) => /^\d{1,3}$/.test(line.trim())).length;
  if (numericResidueCount >= 4) {
    return compacted.filter((line) => !/^\d{1,3}$/.test(line.trim()));
  }
  const spinnerResidueCount = compacted.filter(isShortClaudeSpinnerResidue).length;
  if (spinnerResidueCount >= 4) {
    return compacted.filter((line) => !isShortClaudeSpinnerResidue(line));
  }
  return compacted;
}

/**
 * Provider-neutral closed-transcript cleanup: strip terminal control codes and
 * collapse blank runs, without the Claude-specific spinner/box noise filters.
 */
function compactTerminalTranscript(value: string): string[] {
  const lines = stripTerminalControls(value).split(/\r\n|\n|\r/);
  const compacted: string[] = [];
  let lastWasBlank = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\u00a0/g, " ").trimEnd();
    const blank = line.trim().length === 0;
    if (blank && lastWasBlank) continue;
    compacted.push(line);
    lastWasBlank = blank;
  }
  while (compacted.length && compacted[0]!.trim().length === 0) compacted.shift();
  while (compacted.length && compacted[compacted.length - 1]!.trim().length === 0) compacted.pop();
  return compacted;
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
  const style: TerminalRunStyle = {};
  if (color) style.color = color;
  if (backgroundColor) style.backgroundColor = backgroundColor;
  if (cell.bold) style.bold = true;
  if (cell.dim) style.dim = true;
  if (cell.italic) style.italic = true;
  if (cell.underline) style.underline = true;
  if (cell.inverse) style.inverse = true;
  if (cell.strikethrough) style.strikethrough = true;
  return style;
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
  const snapshot: TerminalSnapshotCell = {
    text: cell.getChars() || " ",
    fg: fgMode === "default" ? null : cell.getFgColor(),
    bg: bgMode === "default" ? null : cell.getBgColor(),
    fgMode,
    bgMode,
  };
  if (cell.isBold()) snapshot.bold = true;
  if (cell.isDim()) snapshot.dim = true;
  if (cell.isItalic()) snapshot.italic = true;
  if (cell.isUnderline()) snapshot.underline = true;
  if (cell.isInverse()) snapshot.inverse = true;
  if (cell.isStrikethrough()) snapshot.strikethrough = true;
  return snapshot;
}

function isBlankDefaultCell(cell: TerminalSnapshotCell): boolean {
  return (cell.text || " ") === " "
    && cell.fg == null
    && cell.bg == null
    && cell.fgMode === "default"
    && cell.bgMode === "default"
    && !cell.bold
    && !cell.dim
    && !cell.italic
    && !cell.underline
    && !cell.inverse
    && !cell.strikethrough;
}

function isBlankStyledRow(row: TerminalStyledRow): boolean {
  return row.runs.every((run) => run.text.trim().length === 0 && Object.keys(run.style).length === 0);
}

function styledRowsFromTerminal(
  terminal: HeadlessTerminalInstance,
  maxRows: number,
  scrollUpRows = 0,
): TerminalStyledRow[] {
  const buffer = terminal.buffer.active;
  // viewportY is the live bottom. Scrolling up reads earlier lines, clamped so
  // we never index before the start of the buffer (which includes scrollback).
  const baseStart = Math.max(0, buffer.viewportY);
  const start = Math.max(0, baseStart - Math.max(0, Math.floor(scrollUpRows)));
  const rows: TerminalStyledRow[] = [];
  for (let row = 0; row < Math.max(0, maxRows); row += 1) {
    const line = buffer.getLine(start + row);
    if (!line) {
      rows.push({ runs: [{ text: " ", style: {} }] });
      continue;
    }
    const fallbackText = line.translateToString(true);
    if (!fallbackText) {
      rows.push({ runs: [{ text: " ", style: {} }] });
      continue;
    }
    const cells: TerminalSnapshotCell[] = [];
    let lastContentColumn = -1;
    const scanColumns = Math.min(terminal.cols, fallbackText.length);
    for (let column = 0; column < scanColumns; column += 1) {
      const cell = snapshotCellFromXtermCell(line.getCell(column) as unknown as XtermBufferCell | undefined);
      cells.push(cell);
      if (!isBlankDefaultCell(cell)) lastContentColumn = column;
    }
    if (lastContentColumn >= 0) cells.length = lastContentColumn + 1;
    rows.push(styledRowFromCells(lastContentColumn >= 0 ? cells : [], fallbackText));
  }
  while (rows.length > 1 && isBlankStyledRow(rows[rows.length - 1]!)) rows.pop();
  return rows;
}

/** Rows of scrollback above the live viewport that can still be revealed by scrolling up. */
function terminalMaxScrollableRows(terminal: HeadlessTerminalInstance | null): number {
  if (!terminal) return 0;
  return Math.max(0, terminal.buffer.active.viewportY);
}

/** Flatten styled rows to plain text for clipboard copy (reuses app's writeClipboardText). */
function plainTextFromStyledRows(rows: TerminalStyledRow[]): string {
  return rows
    .map((row) => row.runs.map((run) => run.text).join("").replace(/\s+$/u, ""))
    .join("\n");
}

export function styledRowsFromSnapshotRows(rows: TerminalSnapshotRow[], maxRows: number): TerminalStyledRow[] {
  return rows.slice(0, Math.max(0, maxRows)).map((row) => styledRowFromCells(row.cells, row.text));
}

function transcriptPreviewRows(transcript: string | null | undefined, maxRows: number, claudeChrome: boolean): TerminalStyledRow[] {
  const lines = claudeChrome
    ? compactClosedTerminalTranscript(transcript ?? "")
    : compactTerminalTranscript(transcript ?? "");
  if (!lines.length) {
    return [{ runs: [{ text: "Terminal closed. Resume the chat to view live output.", style: {} }] }];
  }
  return lines.slice(-maxRows).map((line) => ({ runs: [{ text: line || " ", style: {} }] }));
}

function fallbackPreviewRows(preview: ChatTerminalPreviewResult | null, maxRows: number, claudeChrome: boolean): TerminalStyledRow[] {
  if (!preview) return [{ runs: [{ text: "No terminal preview yet.", style: {} }] }];
  if (preview.snapshot?.visibleRows?.length) {
    return styledRowsFromSnapshotRows(preview.snapshot.visibleRows, maxRows);
  }
  return transcriptPreviewRows(preview.transcript, maxRows, claudeChrome);
}

function terminalControlBorderColor(frame: string): string {
  return frame === "◐" || frame === "◑" ? theme.color.warning : theme.color.attention2;
}

function TerminalPaneComponent({
  title,
  terminalId,
  cliLabel,
  claudeChrome = true,
  preview,
  liveChunks,
  attached,
  width,
  height,
  hiddenBottomRows = 0,
  bodyOnly = false,
  namingHint = false,
  scrollOffset = 0,
  pendingNewCount = 0,
  onViewportMetrics,
}: TerminalPaneProps) {
  const spinFrame = useSpinFrame();
  // Scrollback only applies to the live (non-attached) preview. When attached,
  // Claude owns the terminal and we always follow the bottom.
  const effectiveScrollOffset = attached ? 0 : Math.max(0, Math.floor(scrollOffset));
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
  const terminalKey = terminalId ?? preview?.terminalId ?? title;
  const seed = (useSnapshotRows ? preview?.snapshot?.serialized : preview?.transcript) ?? "";
  const seedKind = preview?.session.status === "running" ? "running" : "static";
  const seedKey = `${seedKind}:${terminalKey}:${seed}`;
  const seedEagerly = !useSnapshotRows;
  const terminalInstanceSeedKey = liveChunks.length === 0 && seedEagerly ? seedKey : "";
  const latestSeedRef = useRef({ key: terminalKey, kind: seedKind, seed, seedKey, eager: seedEagerly });
  const terminalRef = useRef<HeadlessTerminalInstance | null>(null);
  const chunkIndexRef = useRef(0);
  const seededKeyRef = useRef<string | null>(null);
  const [renderTick, setRenderTick] = useState(0);

  latestSeedRef.current = { key: terminalKey, kind: seedKind, seed, seedKey, eager: seedEagerly };

  useEffect(() => {
    const terminal = new HeadlessTerminal({
      allowProposedApi: true,
      cols,
      rows: emulatedRows,
      scrollback: 2_000,
    });
    terminalRef.current = terminal;
    chunkIndexRef.current = 0;
    seededKeyRef.current = null;
    const seedState = latestSeedRef.current;
    if (seedState.eager && seedState.seed) {
      seededKeyRef.current = seedState.seedKey;
      terminal.write(seedState.seed, () => setRenderTick((tick) => tick + 1));
    } else {
      setRenderTick((tick) => tick + 1);
    }
    return () => {
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
    };
  }, [cols, emulatedRows, terminalInstanceSeedKey, terminalKey]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || liveChunks.length > 0) return;
    const seedState = latestSeedRef.current;
    if (!seedState.eager) return;
    if (!seedState.seed) return;
    if (seededKeyRef.current === seedState.seedKey) return;
    if (seedState.kind === "running" && seededKeyRef.current?.startsWith(`running:${seedState.key}:`)) {
      return;
    }
    terminal.reset();
    chunkIndexRef.current = 0;
    seededKeyRef.current = seedState.seedKey;
    terminal.write(`\x1bc${seedState.seed}`, () => setRenderTick((tick) => tick + 1));
  }, [liveChunks.length, seed, seedEagerly, seedKey, seedKind, terminalKey]);

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
    // Incremental write: only the chunks past chunkIndexRef are fed to xterm, so
    // the write cursor keeps advancing as new chunks append (this is what the
    // app.tsx ref/timer flush relies on — no destructive per-chunk slice(-500)
    // that would pin length and freeze this loop). If the owner trims the array
    // (length shrinks below our cursor), reset xterm and replay the retained
    // tail so the visible buffer stays consistent without duplication.
    let resetBeforeWrite = false;
    if (liveChunks.length < chunkIndexRef.current) {
      terminal.reset();
      chunkIndexRef.current = 0;
      resetBeforeWrite = true;
    }
    const nextChunks = liveChunks.slice(chunkIndexRef.current);
    const data = nextChunks.join("");
    if (data) {
      const seedState = latestSeedRef.current;
      let writeData = data;
      if (chunkIndexRef.current === 0 && seedState.seed && seededKeyRef.current !== seedState.seedKey) {
        terminal.reset();
        seededKeyRef.current = seedState.seedKey;
        resetBeforeWrite = true;
        writeData = `${seedState.seed}${data}`;
      }
      terminal.write(`${resetBeforeWrite ? "\x1bc" : ""}${writeData}`, () => setRenderTick((tick) => tick + 1));
    }
    chunkIndexRef.current = liveChunks.length;
  }, [liveChunks]);

  const lines = useMemo(() => {
    if (snapshotRows?.length && liveChunks.length === 0) return snapshotRows.slice(0, rows);
    if (preview?.transcript && preview.session.status !== "running" && !liveChunks.length) {
      return transcriptPreviewRows(preview.transcript, rows, claudeChrome);
    }
    const terminal = terminalRef.current;
    if (terminal) return styledRowsFromTerminal(terminal, rows, effectiveScrollOffset);
    return fallbackPreviewRows(preview, rows, claudeChrome);
  }, [claudeChrome, effectiveScrollOffset, liveChunks.length, preview, renderTick, rows, snapshotRows]);

  // Surface scrollback bounds + the current visible text to the owner so it can
  // clamp keyboard scroll requests and copy the visible region. Cheap: gated on
  // the values that actually change the window. Only meaningful for the live
  // (non-attached) xterm-backed preview.
  const reportMetrics = onViewportMetrics;
  useEffect(() => {
    if (!reportMetrics) return;
    const terminal = terminalRef.current;
    const maxScrollable = snapshotRows?.length ? 0 : terminalMaxScrollableRows(terminal);
    reportMetrics({ maxScrollable, visibleText: plainTextFromStyledRows(lines) });
  }, [lines, reportMetrics, snapshotRows]);

  const controlLabel = cliLabel?.trim() || "Claude";
  const status = attached
    ? `${controlLabel.toUpperCase()} CONTROL · Ctrl+T returns to ADE · Ctrl+] escape`
    : preview?.session.status === "running"
      ? effectiveHiddenBottomRows > 0 ? `ADE prompt sends to ${controlLabel}` : "live preview"
      : preview?.session.resumeCommand
        ? "closed, resumable · Enter resumes"
        : "closed";

  const scrolledBack = !attached && effectiveScrollOffset > 0;
  const showNewChip = scrolledBack && pendingNewCount > 0;
  const bodyContent = (
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
  );

  // Grid tiles draw their own border + title chrome (MultiChatGrid), so they
  // render the terminal body only — no header line, no outer box height padding.
  if (bodyOnly) {
    return bodyContent;
  }

  const content = (
    <>
      <Box width={contentWidth}>
        <Text color={attached ? theme.color.warning : theme.color.accent}>
          {attached ? `${spinFrame} ${title}` : title}
        </Text>
        <Text color={theme.color.mutedFg}>  {status}</Text>
        {namingHint && !attached ? (
          <Text color={theme.color.accent}>{`  ${spinFrame} naming…`}</Text>
        ) : null}
        {showNewChip ? (
          // Amber "attention" chip: new output landed while the user is reading
          // scrollback. Press End / Shift+Down-to-bottom to jump and clear it.
          <Text color={theme.color.warning}>{`  ↓ ${pendingNewCount} new`}</Text>
        ) : scrolledBack ? (
          <Text color={theme.color.mutedFg}>{`  ↑ scrollback · End to follow`}</Text>
        ) : null}
      </Box>
      {bodyContent}
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

export const TerminalPane = React.memo(TerminalPaneComponent);
