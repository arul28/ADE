import React, { useMemo } from "react";
import { Box, Text } from "ink";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import type { LocalNotice } from "../types";
import {
  parseInlineRuns,
  compactPath,
  webSearchResultPreviewLines,
  type AssistantMarkdownBlock,
  type HighlightedToken,
  type InlineRun,
  type RenderedChatLine,
} from "../format";
import {
  aggregateChatBlocks,
  type ActivityBundleEntry,
  type AggregatedBlock,
  type FileChangeEntry,
  type PlanStep,
  type RuntimeActivityEntry,
  type ToolCallEntry,
  type WorkToolStatus,
} from "../aggregate";
import { theme } from "../theme";
import { useBrailleSpin, useDotPulse, useShimmerTick, useSpinFrame } from "../spinTick";
import {
  ADE_WORDMARK_COMPACT_WIDTH,
  ADE_WORDMARK_FULL_WIDTH,
  AdeWordmark,
} from "./AdeWordmark";
import { laneIconGlyph } from "./Header";
import type { AdeCodeProvider } from "../types";
import {
  MOSAIC_FENCE_LANGUAGE,
  parseMosaicCard,
  summarizeMosaicCard,
} from "../../../../desktop/src/shared/chatMosaic";
import {
  hardWrapDisplayText,
  sliceByDisplayCells,
  splitByDisplayCells,
  terminalDisplayWidth,
  truncateDisplayEnd,
} from "../displayWidth";

// Hero halo target: when no chat content is visible, let the hero stretch to a
// roomy reading width instead of staying narrow against an empty pane.
const HERO_TARGET_HALO_WIDTH = 78;
const HERO_MIN_HALO_WIDTH = 28;
const HERO_WORDMARK_FULL_MIN_USABLE = ADE_WORDMARK_FULL_WIDTH + 2;
const HERO_WORDMARK_COMPACT_MIN_USABLE = ADE_WORDMARK_COMPACT_WIDTH + 2;
const DEFAULT_VIEW_WIDTH = 88;
const BLANK_ROW_TEXT = " ";
// Placeholder frame for historical (non-live) blocks. Non-live blocks never
// read the animation frame, so any fixed value keeps their rows identical while
// letting us memoize them independently of the spinner tick.
const STATIC_SPIN_FRAME = "◐";
// Shared empty set so callers that don't track group expansion (plain-text
// export, scroll-height probe) don't each allocate one per call.
const EMPTY_EXPANDED_GROUP_IDS: Set<string> = new Set();

type RenderedChatRow = {
  id: string;
  text: string;
  tone: RenderedChatLine["tone"] | "indicator" | "work" | "plan" | "footer";
  color?: string;
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
  rail?: string | null;
  runs?: InlineRun[];
  sourceRowIndex?: number | null;
  /**
   * When set, this row is a clickable work-group header (tool calls / file
   * changes). The transcript click handler maps a click on this row back to
   * this id and toggles it in `expandedLineIds` to collapse/expand the group.
   */
  expandableGroupId?: string;
  /** Click action for rows that open another pane instead of toggling in place. */
  actionId?: string;
};

export type ChatTextSelection = {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
};

export type ChatVisibleSelectionRow = {
  sourceRow: number | null;
  text: string;
  /** Set when this visible row is a clickable work-group header (see
   *  RenderedChatRow.expandableGroupId). Lets the click handler toggle the
   *  group without re-deriving block layout. */
  expandableId?: string | null;
  actionId?: string | null;
};

// Expansion keys for collapsible work-log groups (tool calls / file changes)
// live in the same `expandedLineIds` set as failure expansions. The prefix
// keeps a group key from colliding with a raw event line id used elsewhere.
export const WORK_GROUP_EXPAND_PREFIX = "workgroup:";
export function workGroupExpandKey(blockId: string): string {
  return `${WORK_GROUP_EXPAND_PREFIX}${blockId}`;
}

export const WORK_FILE_DIFF_PREFIX = "workfilediff:";
export function workFileDiffKey(blockId: string, itemId: string): string {
  return `${WORK_FILE_DIFF_PREFIX}${encodeURIComponent(blockId)}:${encodeURIComponent(itemId)}`;
}

function textWidth(value: string): number {
  return terminalDisplayWidth(value);
}

function repeat(value: string, count: number): string {
  return value.repeat(Math.max(0, count));
}

function padRight(value: string, width: number): string {
  return `${value}${repeat(" ", width - textWidth(value))}`;
}

function alignRight(value: string, width: number): string {
  return `${repeat(" ", width - textWidth(value))}${value}`;
}

function maxRenderedLineWidth(lines: string[]): number {
  return lines.reduce((max, line) => Math.max(max, textWidth(line)), 0);
}

function truncateEnd(value: string, max: number): string {
  return truncateDisplayEnd(value, max);
}

function hardWrapWord(word: string, width: number): string[] {
  return hardWrapDisplayText(word, width);
}

function wrapText(value: string, width: number, firstPrefix = "", restPrefix = firstPrefix): string[] {
  const availableFirst = Math.max(1, width - textWidth(firstPrefix));
  const availableRest = Math.max(1, width - textWidth(restPrefix));
  const rows: string[] = [];
  for (const rawLine of value.split(/\r?\n/)) {
    const words = rawLine.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      rows.push(firstPrefix);
      continue;
    }
    let prefix = firstPrefix;
    let limit = availableFirst;
    let current = "";
    for (const word of words) {
      if (textWidth(word) > limit) {
        if (current) {
          rows.push(`${prefix}${current}`);
          prefix = restPrefix;
          limit = availableRest;
          current = "";
        }
        const chunks = hardWrapWord(word, limit);
        for (const chunk of chunks.slice(0, -1)) {
          rows.push(`${prefix}${chunk}`);
          prefix = restPrefix;
          limit = availableRest;
        }
        current = chunks[chunks.length - 1] ?? "";
        continue;
      }
      const next = current ? `${current} ${word}` : word;
      if (textWidth(next) > limit && current) {
        rows.push(`${prefix}${current}`);
        prefix = restPrefix;
        limit = availableRest;
        current = word;
      } else {
        current = next;
      }
    }
    if (current) rows.push(`${prefix}${current}`);
  }
  return rows;
}

function runsPlainText(runs: InlineRun[]): string {
  return runs.map((run) => run.text).join("");
}

function wrapInlineRuns(runs: InlineRun[], width: number, firstPrefix: string, restPrefix: string): InlineRun[][] {
  type Segment = { text: string; style: Omit<InlineRun, "text">; isSpace: boolean };
  const segments: Segment[] = [];
  for (const run of runs) {
    const parts = run.text.split(/(\s+)/);
    const style: Omit<InlineRun, "text"> = {};
    if (run.bold) style.bold = true;
    if (run.italic) style.italic = true;
    if (run.code) style.code = true;
    if (run.link) style.link = true;
    if (run.href) style.href = run.href;
    for (const part of parts) {
      if (!part) continue;
      const isSpace = /^\s+$/.test(part);
      segments.push({ text: isSpace ? " " : part, style, isSpace });
    }
  }

  const lines: InlineRun[][] = [];
  let currentRuns: InlineRun[] = [];
  let currentWidth = textWidth(firstPrefix);
  let prefix = firstPrefix;
  let limit = width;

  const flush = () => {
    while (currentRuns.length) {
      const tail = currentRuns[currentRuns.length - 1]!;
      if (/^\s+$/.test(tail.text)) currentRuns.pop();
      else break;
    }
    const row: InlineRun[] = prefix ? [{ text: prefix }, ...currentRuns] : currentRuns;
    lines.push(row);
    currentRuns = [];
    currentWidth = textWidth(restPrefix);
    prefix = restPrefix;
  };

  for (const seg of segments) {
    if (seg.isSpace) {
      if (currentRuns.length) {
        currentRuns.push({ text: seg.text, ...seg.style });
        currentWidth += 1;
      }
      continue;
    }
    const segWidth = textWidth(seg.text);
    if (currentRuns.length && currentWidth + segWidth > limit) {
      flush();
    }
    if (segWidth > limit - currentWidth) {
      const room = Math.max(1, limit - currentWidth);
      const chunks = hardWrapWord(seg.text, room);
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const chunk = chunks[chunkIndex]!;
        currentRuns.push({ text: chunk, ...seg.style });
        currentWidth += textWidth(chunk);
        if (chunkIndex < chunks.length - 1) flush();
      }
      continue;
    }
    currentRuns.push({ text: seg.text, ...seg.style });
    currentWidth += segWidth;
  }
  if (currentRuns.length) flush();
  if (!lines.length) lines.push([{ text: firstPrefix }]);
  return lines;
}

function HeroDivider({ width }: { width: number }) {
  return <Text color={theme.color.border} dimColor>{"─".repeat(Math.max(4, width))}</Text>;
}

function HeroMetaRow({
  label,
  value,
  color,
  valueWidth,
}: {
  label: string;
  value: string;
  color?: string;
  valueWidth: number;
}) {
  const labelWidth = 9;
  const paddedValue = padRight(truncateEnd(value, Math.max(1, valueWidth)), Math.max(1, valueWidth));
  return (
    <Box flexDirection="row">
      <Text dimColor>{padRight(label, labelWidth)}</Text>
      <Text color={color ?? theme.color.fg}>{paddedValue}</Text>
    </Box>
  );
}

export function BootHero({
  projectName,
  laneName,
  lane,
  provider,
  modelDisplay,
  width = DEFAULT_VIEW_WIDTH,
  worktreeAvailable = true,
}: {
  projectName: string;
  laneName: string;
  lane?: LaneSummary | null;
  provider?: AdeCodeProvider | null;
  modelDisplay?: string | null;
  width?: number;
  worktreeAvailable?: boolean;
}) {
  const laneColor = theme.lane(lane ?? null);
  const laneGlyph = laneIconGlyph(lane?.icon ?? null);
  const trimmedProject = projectName.trim();
  const projectLabel = trimmedProject || "—";
  const branchLabel = lane?.branchRef?.trim() || "—";
  const brand = provider ? theme.provider(provider) : null;
  const modelLabel = brand
    ? `${brand.glyph} ${brand.label}${modelDisplay ? ` · ${modelDisplay}` : ""}`
    : "—";

  const haloWidth = Math.max(HERO_MIN_HALO_WIDTH, Math.min(HERO_TARGET_HALO_WIDTH, width - 2));
  const cardWidth = haloWidth - 4;
  const usableWidth = Math.max(4, cardWidth - 8);
  const heroValueWidth = Math.max(4, usableWidth - 9);
  let wordmarkVariant: "full" | "compact" | "none" = "none";
  if (usableWidth >= HERO_WORDMARK_FULL_MIN_USABLE) {
    wordmarkVariant = "full";
  } else if (usableWidth >= HERO_WORDMARK_COMPACT_MIN_USABLE) {
    wordmarkVariant = "compact";
  }

  return (
    <Box flexDirection="column" alignItems="center" paddingY={1}>
      <Box width={haloWidth} justifyContent="center">
        <Text color={theme.color.violetDeep} dimColor>
          {"·".repeat(Math.max(8, haloWidth - 12))}
        </Text>
      </Box>
      <Box
        borderStyle="round"
        borderColor={theme.color.accentDim}
        paddingX={1}
        width={haloWidth}
        flexDirection="column"
      >
        <Box
          borderStyle="bold"
          borderColor={theme.color.accent}
          paddingX={2}
          paddingY={1}
          flexDirection="column"
          width={cardWidth}
        >
          <Box flexDirection="column" paddingX={1}>
            <Box flexDirection="column" alignItems="center">
              {wordmarkVariant === "full" && <AdeWordmark />}
              {wordmarkVariant === "compact" && <AdeWordmark compact />}
              {wordmarkVariant === "none" && (
                <Text color={theme.color.accent} bold>A · D · E</Text>
              )}
              <Box height={1} />
              <Text color={theme.color.t3}>AGENTIC DEVELOPMENT ENVIRONMENT</Text>
            </Box>
            <Box height={1} />
            <HeroDivider width={usableWidth} />
            <Box height={1} />
            <HeroMetaRow label="project" value={projectLabel} valueWidth={heroValueWidth} />
            <HeroMetaRow label="lane" value={`${laneGlyph} ${laneName}`} color={laneColor} valueWidth={heroValueWidth} />
            <HeroMetaRow label="branch" value={branchLabel === "—" ? branchLabel : `⎇ ${branchLabel}`} valueWidth={heroValueWidth} />
            <HeroMetaRow label="model" value={modelLabel} color={brand?.color} valueWidth={heroValueWidth} />
            <Box height={1} />
            <HeroDivider width={usableWidth} />
            <Box height={1} />
            {worktreeAvailable ? (
              <Text>
                <Text color={theme.color.accent} bold>type</Text>
                <Text dimColor>{" to chat   "}</Text>
                <Text color={theme.color.accent} bold>/</Text>
                <Text dimColor>{" cmds   "}</Text>
                <Text color={theme.color.accent} bold>@</Text>
                <Text dimColor>{" files   "}</Text>
                <Text color={theme.color.accent} bold>?</Text>
                <Text dimColor>{" help"}</Text>
              </Text>
            ) : (
              <Text>
                <Text color={theme.color.error} bold>worktree missing</Text>
                <Text dimColor>{"  restore lane before chat"}</Text>
              </Text>
            )}
          </Box>
        </Box>
      </Box>
      <Box width={haloWidth} justifyContent="center">
        <Text color={theme.color.violetDeep} dimColor>
          {"·".repeat(Math.max(8, haloWidth - 12))}
        </Text>
      </Box>
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown rendering
// ─────────────────────────────────────────────────────────────────────────────

function inlineRowsFromText(
  text: string,
  width: number,
  id: string,
  firstPrefix: string,
  restPrefix: string,
  options: { color?: string; dim?: boolean; bold?: boolean; italic?: boolean } = {},
): RenderedChatRow[] {
  const runs = parseInlineRuns(text);
  const hasFormatting = runs.some((run) => run.bold || run.italic || run.code || run.link);
  if (!hasFormatting) {
    return wrapText(text, width, firstPrefix, restPrefix).map((line) => ({
      id,
      tone: "assistant" as const,
      text: line,
      color: options.color ?? theme.color.fg,
      dim: options.dim,
      bold: options.bold,
      italic: options.italic,
    }));
  }
  const lineRuns = wrapInlineRuns(runs, width, firstPrefix, restPrefix);
  return lineRuns.map((lineSegments) => ({
    id,
    tone: "assistant" as const,
    text: runsPlainText(lineSegments),
    runs: lineSegments,
    color: options.color ?? theme.color.fg,
    dim: options.dim,
    bold: options.bold,
    italic: options.italic,
  }));
}

function tableRows(
  block: Extract<AssistantMarkdownBlock, { kind: "table" }>,
  width: number,
  id: string,
): RenderedChatRow[] {
  const columns = Math.max(block.headers.length, ...block.rows.map((row) => row.length));
  if (columns === 0) return [];
  const headerCells = padCells(block.headers, columns);
  const bodyCells = block.rows.map((row) => padCells(row, columns));

  const intrinsic = new Array<number>(columns).fill(0);
  for (let col = 0; col < columns; col += 1) {
    const headerLen = textWidth(headerCells[col] ?? "");
    intrinsic[col] = Math.max(intrinsic[col]!, headerLen);
    for (const row of bodyCells) {
      intrinsic[col] = Math.max(intrinsic[col]!, textWidth(row[col] ?? ""));
    }
  }

  const minCell = 3;
  const borderChars = columns + 1;
  const padChars = columns * 2;
  const available = Math.max(columns * (minCell + 2) + borderChars, width - 2);
  let target = available - borderChars - padChars;
  if (target < columns * minCell) target = columns * minCell;
  const intrinsicSum = intrinsic.reduce((acc, value) => acc + value, 0) || 1;
  const colWidths = new Array<number>(columns).fill(minCell);
  let remaining = target;
  for (let col = 0; col < columns; col += 1) {
    const share = Math.max(minCell, Math.floor((intrinsic[col]! / intrinsicSum) * target));
    colWidths[col] = share;
    remaining -= share;
  }
  // Distribute leftover space to the widest columns.
  let pointer = 0;
  while (remaining > 0) {
    colWidths[pointer % columns]! += 1;
    remaining -= 1;
    pointer += 1;
  }

  const buildRule = (left: string, mid: string, right: string): string => {
    const segments = colWidths.map((w) => repeat("─", w + 2));
    return `${left}${segments.join(mid)}${right}`;
  };

  const wrapCells = (cells: string[]): string[][] => {
    return cells.map((cell, col) => {
      const w = colWidths[col]!;
      if (textWidth(cell) <= w) return [cell];
      return wrapText(cell, w);
    });
  };

  const renderCellRow = (cells: string[]): string[] => {
    const wrappedCells = wrapCells(cells);
    const height = Math.max(1, ...wrappedCells.map((lines) => lines.length));
    const lines: string[] = [];
    for (let line = 0; line < height; line += 1) {
      const parts: string[] = [];
      for (let col = 0; col < columns; col += 1) {
        const cellLine = wrappedCells[col]?.[line] ?? "";
        parts.push(` ${padRight(cellLine, colWidths[col]!)} `);
      }
      lines.push(`│${parts.join("│")}│`);
    }
    return lines;
  };

  const out: RenderedChatRow[] = [];
  const push = (text: string, opts: Partial<RenderedChatRow> = {}) => {
    out.push({ id, tone: "assistant", text, color: theme.color.borderActive, rail: null, ...opts });
  };
  push(buildRule("┌", "┬", "┐"));
  for (const line of renderCellRow(headerCells)) push(line, { color: theme.color.fg, bold: true });
  push(buildRule("├", "┼", "┤"));
  for (const row of bodyCells) {
    for (const line of renderCellRow(row)) push(line, { color: theme.color.fg });
  }
  push(buildRule("└", "┴", "┘"));
  return out;
}

function padCells(cells: string[], width: number): string[] {
  const out = cells.slice(0, width);
  while (out.length < width) out.push("");
  return out;
}

const HIGHLIGHT_COLOR: Record<NonNullable<HighlightedToken["category"]>, string> = {
  keyword: theme.color.codeKeyword,
  string: theme.color.codeString,
  number: theme.color.codeNumber,
  comment: theme.color.codeComment,
  function: theme.color.codeFunction,
  type: theme.color.codeType,
  variable: theme.color.codeVariable,
  tag: theme.color.codeTag,
  meta: theme.color.codeMeta,
};

function tokensToRuns(tokens: HighlightedToken[]): InlineRun[] {
  return tokens.map((token) => {
    const color = token.category ? HIGHLIGHT_COLOR[token.category] : theme.color.t1;
    const run: InlineRun = { text: token.text, color };
    if (token.bold) run.bold = true;
    if (token.italic) run.italic = true;
    return run;
  });
}

function markdownRows(blocks: AssistantMarkdownBlock[], width: number, id: string): RenderedChatRow[] {
  const rows: RenderedChatRow[] = [];
  let prevKind: AssistantMarkdownBlock["kind"] | null = null;

  for (const block of blocks) {
    if (prevKind) {
      rows.push(spacerRow(`${id}:md-spacer:${rows.length}`, "assistant"));
    }
    if (block.kind === "heading") {
      rows.push(...inlineRowsFromText(block.text, width, id, "", "", { color: theme.color.accent, bold: true }));
    } else if (block.kind === "bullet") {
      rows.push(...inlineRowsFromText(block.text, width, id, "• ", "  "));
    } else if (block.kind === "numbered") {
      const prefix = `${block.number}. `;
      rows.push(...inlineRowsFromText(block.text, width, id, prefix, repeat(" ", textWidth(prefix))));
    } else if (block.kind === "quote") {
      rows.push(...inlineRowsFromText(block.text, width, id, "> ", "> ", { dim: true }));
    } else if (block.kind === "code") {
      // A valid ```mosaic fence collapses to one dim summary line here; the
      // interactive card only renders on desktop. Parse failure → plain block.
      const mosaicSpec = block.language === MOSAIC_FENCE_LANGUAGE
        ? parseMosaicCard((block.lines.length ? block.lines : [""]).join("\n"))
        : null;
      if (mosaicSpec) {
        rows.push(...inlineRowsFromText(summarizeMosaicCard(mosaicSpec), width, id, "  ", "  ", { dim: true, color: theme.color.t2 }));
      } else {
      const label = block.language ? ` ${block.language} ` : "";
      const ruleWidth = Math.max(1, Math.min(width - 5, 24));
      rows.push({
        id,
        tone: "assistant",
        text: `  ┌─${label}${repeat("─", Math.max(0, ruleWidth - label.length))}`,
        color: theme.color.border,
        dim: true,
      });
      const codeLines = block.lines.length ? block.lines : [""];
      const tokensPerLine = block.tokens && block.tokens.length === codeLines.length ? block.tokens : null;
      const available = Math.max(1, width - 4);
      for (let lineIndex = 0; lineIndex < codeLines.length; lineIndex += 1) {
        const codeLine = codeLines[lineIndex] ?? "";
        if (!codeLine) {
          rows.push({ id, tone: "assistant", text: "  │ ", color: theme.color.border, dim: true });
          continue;
        }
        if (tokensPerLine) {
          const lineTokens = tokensPerLine[lineIndex] ?? [];
          if (!lineTokens.length) {
            rows.push({ id, tone: "assistant", text: "  │ ", color: theme.color.border, dim: true });
            continue;
          }
          // Hard-wrap by width across the token sequence so we keep colored runs intact.
          const wrapped = wrapInlineRuns(tokensToRuns(lineTokens), available, "  │ ", "  │ ");
          for (const lineSegments of wrapped) {
            rows.push({
              id: `${id}:code:${lineIndex}`,
              tone: "assistant",
              text: runsPlainText(lineSegments),
              runs: lineSegments,
              rail: null,
            });
          }
          continue;
        }
        // No tokens (unknown language): render plain code text in t1 with wrap.
        const chunks = hardWrapWord(codeLine, available);
        for (const chunk of chunks) {
          rows.push({
            id,
            tone: "assistant",
            text: `  │ ${chunk}`,
            color: theme.color.t1,
          });
        }
      }
      rows.push({ id, tone: "assistant", text: "  └", color: theme.color.border, dim: true });
      }
    } else if (block.kind === "table") {
      rows.push(...tableRows(block, width, id));
    } else if (block.kind === "hr") {
      rows.push({ id, tone: "assistant", text: repeat("─", Math.min(width, 72)), color: theme.color.border, dim: true });
    } else {
      rows.push(...inlineRowsFromText(block.text, width, id, "", ""));
    }
    prevKind = block.kind;
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Block renderers
// ─────────────────────────────────────────────────────────────────────────────

const LINK_COLOR = theme.color.info;
const WORK_STATUS_COLOR: Record<WorkToolStatus, string> = {
  running: theme.color.violet,
  ok: theme.color.running,
  failed: theme.color.error,
};
const ACTIVITY_STATUS_COLOR: Record<RuntimeActivityEntry["status"], string> = {
  running: theme.color.violet,
  ok: theme.color.running,
  failed: theme.color.error,
  info: theme.color.t4,
};

// Runtime-activity entries to render inline before collapsing into "+N more".
// Tool calls and file changes are NOT capped — they stack one line per entry,
// matching the desktop work log.
const GROUP_VISIBLE_CAP = 3;
// Per-row arg/command cap for the plain-text copy form. Matches the desktop
// work log's summarizeInlineText cap (140); the rendered row is truncated to
// the actual pane width by ChatRow (wrap="truncate-end"), so this only bounds
// what very wide terminals show.
const LONG_LINE_TRUNCATE_AT = 140;

function formatDurationMs(ms: number | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remSeconds}s`;
}

function statusGlyph(status: WorkToolStatus, spinFrame: string): string {
  if (status === "failed") return "✗";
  if (status === "running") return spinFrame;
  return "✓";
}

function activityStatusGlyph(status: RuntimeActivityEntry["status"], spinFrame: string): string {
  if (status === "failed") return "✗";
  if (status === "running") return spinFrame;
  if (status === "ok") return "✓";
  return "·";
}

function truncateLongLine(value: string): string {
  if (textWidth(value) <= LONG_LINE_TRUNCATE_AT) return value;
  return `${[...value].slice(0, LONG_LINE_TRUNCATE_AT - 1).join("")}…`;
}

function groupHeaderRuns(
  label: string,
  total: number,
  liveSummary: { ok: number; failed: number } | null,
  spinFrame: string,
): InlineRun[] {
  const runs: InlineRun[] = [
    { text: "▸ ", color: theme.color.t3 },
    { text: `${label} (${total})`, color: theme.color.t2, bold: true },
  ];
  if (liveSummary) {
    const tail: string[] = [];
    if (liveSummary.ok > 0) tail.push(`${liveSummary.ok} ok`);
    if (liveSummary.failed > 0) tail.push(`${liveSummary.failed} failed`);
    if (tail.length) {
      runs.push({ text: "  ·  ", color: theme.color.t4 });
      runs.push({ text: tail.join(" · "), color: theme.color.t4 });
    }
  } else {
    runs.push({ text: "  ", color: theme.color.t4 });
    runs.push({ text: spinFrame, color: theme.color.violet });
    runs.push({ text: " working…", color: theme.color.violet, italic: true });
  }
  return runs;
}

function moreLineRow(blockId: string, remaining: number): RenderedChatRow {
  return {
    id: `${blockId}:more`,
    tone: "work",
    text: `    + ${remaining} more`,
    color: theme.color.t4,
    italic: true,
    rail: null,
  };
}

// Runtime-activity chatter still collapses behind "+N more"; tool calls and
// file changes render every entry, one line each, exactly like the desktop
// work log — consecutive calls stack instead of disappearing into a tail.
function visibleEntries<T>(entries: T[]): { shown: T[]; remaining: number } {
  if (entries.length <= GROUP_VISIBLE_CAP) return { shown: entries, remaining: 0 };
  // Prefer the most recent entries; older ones collapse into the "+N more" tail.
  const shown = entries.slice(-GROUP_VISIBLE_CAP);
  return { shown, remaining: entries.length - shown.length };
}

// Build the indented per-call line shown when a tool group is expanded. ChatRow
// truncates to the pane width so a long arg can never wrap onto a second row.
function toolCallEntryRow(
  blockId: string,
  entry: ToolCallEntry,
  spinFrame: string,
): RenderedChatRow {
  const glyph = statusGlyph(entry.status, spinFrame);
  const dur = formatDurationMs(entry.durationMs);
  const arg = entry.arg ? truncateLongLine(entry.arg) : "";
  const runs: InlineRun[] = [
    { text: "    " },
    { text: glyph, color: WORK_STATUS_COLOR[entry.status] },
    { text: ` ${entry.tool}`, color: theme.color.t1 },
  ];
  if (arg) runs.push({ text: `  ${arg}`, color: theme.color.t3 });
  if (dur) runs.push({ text: `  ${dur}`, color: theme.color.t4 });
  return {
    id: `${blockId}:${entry.itemId}`,
    tone: "work",
    text: runsPlainText(runs),
    runs,
    rail: null,
  };
}

// Codex web-search hits render as dim `title — domain` sub-rows beneath the
// expanded `search` entry (parity with the desktop work log's source chips).
// Empty unless the entry carries results, so nothing renders without data.
function webSearchResultRows(blockId: string, entry: ToolCallEntry): RenderedChatRow[] {
  const lines = webSearchResultPreviewLines(entry.results, entry.resultsTotal, 3);
  return lines.map((line, index) => ({
    id: `${blockId}:${entry.itemId}:result-${index}`,
    tone: "work",
    text: `      ${truncateLongLine(line)}`,
    color: theme.color.t4,
    rail: null,
  }));
}

// Tool calls collapse to ONE clickable header row by default — desktop/mobile
// work-log parity: `▸ Tool calls (N)  ✓ shell <last command>`. The collapsed
// preview shows the most recent call so live progress stays visible without the
// turn's calls stacking into a tall block. Clicking the header (see the
// transcript click handler in app.tsx, keyed off `expandableGroupId`) flips its
// id in `expandedLineIds`, stacking every call one line each under a `▾` header.
function toolCallsGroupRows(
  block: Extract<AggregatedBlock, { kind: "tool-calls-group" }>,
  spinFrame: string,
  expandedGroupIds: Set<string>,
): RenderedChatRow[] {
  if (!block.entries.length) return [];
  const expandKey = workGroupExpandKey(block.id);
  const expanded = expandedGroupIds.has(expandKey);
  const total = block.entries.length;

  const headerRuns: InlineRun[] = [
    { text: expanded ? "▾ " : "▸ ", color: theme.color.t3 },
    { text: "Tool calls", color: theme.color.t2, bold: true },
    { text: ` (${total})`, color: theme.color.t4 },
  ];
  if (!expanded) {
    const latest = block.entries[block.entries.length - 1]!;
    const glyph = statusGlyph(latest.status, spinFrame);
    const arg = latest.arg ? truncateLongLine(latest.arg) : "";
    headerRuns.push({ text: "  " });
    headerRuns.push({ text: glyph, color: WORK_STATUS_COLOR[latest.status] });
    headerRuns.push({ text: ` ${latest.tool}`, color: theme.color.t1 });
    if (arg) headerRuns.push({ text: `  ${arg}`, color: theme.color.t3 });
  }
  const out: RenderedChatRow[] = [{
    id: block.id,
    tone: "work",
    text: runsPlainText(headerRuns),
    runs: headerRuns,
    rail: null,
    expandableGroupId: expandKey,
  }];
  if (!expanded) return out;
  for (const entry of block.entries) {
    out.push(toolCallEntryRow(block.id, entry, spinFrame));
    out.push(...webSearchResultRows(block.id, entry));
  }
  return out;
}

function fileBadgeFor(entry: FileChangeEntry): { label: string; color: string } {
  const badges = theme.color.fileBadge as Record<string, string>;
  const lower = entry.path.toLowerCase();
  const lastDot = lower.lastIndexOf(".");
  const ext = lastDot >= 0 ? lower.slice(lastDot + 1) : "";
  const color = badges[ext] ?? badges.default ?? theme.color.t4;
  const label = (ext || "•").slice(0, 3).toUpperCase();
  return { label, color };
}

function fileChangeEntryRow(
  blockId: string,
  entry: FileChangeEntry,
  pathWidth: number,
  spinFrame: string,
  indent: string,
): RenderedChatRow {
  const badge = fileBadgeFor(entry);
  const glyph = statusGlyph(entry.status, spinFrame);
  const trimmedPath = compactPath(entry.path, pathWidth);
  const stats = entry.deleted ? "Deleted" : `+${entry.additions} −${entry.deletions}`;
  const statsColor = entry.deleted ? theme.color.error : theme.color.t4;
  const runs: InlineRun[] = [
    { text: indent },
    { text: glyph, color: WORK_STATUS_COLOR[entry.status] },
    { text: " " },
    { text: badge.label.padEnd(3, " "), color: badge.color, bold: true },
    { text: "  " },
    { text: trimmedPath, color: theme.color.t1 },
    { text: "  " },
    { text: stats, color: statsColor },
    { text: "  " },
    { text: "diff", color: theme.color.t4 },
  ];
  return {
    id: `${blockId}:${entry.itemId}`,
    tone: "work",
    text: runsPlainText(runs),
    runs,
    rail: null,
    actionId: workFileDiffKey(blockId, entry.itemId),
  };
}

// File changes collapse to ONE clickable header row by default, exactly like
// toolCallsGroupRows — `▸ Files changed (N)  M src/foo.ts  +12 −3` previewing
// the most recent edit. Clicking the header expands every edit one line each.
function filesChangedGroupRows(
  block: Extract<AggregatedBlock, { kind: "files-changed-group" }>,
  width: number,
  spinFrame: string,
  expandedGroupIds: Set<string>,
): RenderedChatRow[] {
  if (!block.entries.length) return [];
  const expandKey = workGroupExpandKey(block.id);
  const expanded = expandedGroupIds.has(expandKey);
  const total = block.entries.length;
  const collapsedPathWidth = Math.max(20, width - 26);
  const expandedPathWidth = Math.max(20, width - 18);

  const headerRuns: InlineRun[] = [
    { text: expanded ? "▾ " : "▸ ", color: theme.color.t3 },
    { text: "Files changed", color: theme.color.t2, bold: true },
    { text: ` (${total})`, color: theme.color.t4 },
  ];
  if (!expanded) {
    const latest = block.entries[block.entries.length - 1]!;
    const badge = fileBadgeFor(latest);
    const glyph = statusGlyph(latest.status, spinFrame);
    const trimmedPath = compactPath(latest.path, collapsedPathWidth);
    const stats = latest.deleted ? "Deleted" : `+${latest.additions} −${latest.deletions}`;
    const statsColor = latest.deleted ? theme.color.error : theme.color.t4;
    headerRuns.push({ text: "  " });
    headerRuns.push({ text: glyph, color: WORK_STATUS_COLOR[latest.status] });
    headerRuns.push({ text: " " });
    headerRuns.push({ text: badge.label.padEnd(3, " "), color: badge.color, bold: true });
    headerRuns.push({ text: "  " });
    headerRuns.push({ text: trimmedPath, color: theme.color.t1 });
    headerRuns.push({ text: "  " });
    headerRuns.push({ text: stats, color: statsColor });
  }
  const out: RenderedChatRow[] = [{
    id: block.id,
    tone: "work",
    text: runsPlainText(headerRuns),
    runs: headerRuns,
    rail: null,
    expandableGroupId: expandKey,
  }];
  if (!expanded) return out;
  for (const entry of block.entries) {
    out.push(fileChangeEntryRow(block.id, entry, expandedPathWidth, spinFrame, "    "));
  }
  return out;
}

function runtimeActivityRows(
  block: Extract<AggregatedBlock, { kind: "runtime-activity" }>,
  spinFrame: string,
): RenderedChatRow[] {
  if (!block.entries.length) return [];
  const ok = block.entries.filter((entry) => entry.status === "ok").length;
  const failed = block.entries.filter((entry) => entry.status === "failed").length;
  const out: RenderedChatRow[] = [{
    id: block.id,
    tone: "work",
    text: `▸ Runtime (${block.entries.length})`,
    runs: groupHeaderRuns("Runtime", block.entries.length, block.live ? null : { ok, failed }, spinFrame),
    rail: null,
  }];
  const { shown, remaining } = visibleEntries(block.entries);
  for (const entry of shown) {
    const glyph = activityStatusGlyph(entry.status, spinFrame);
    const runs: InlineRun[] = [
      { text: "    " },
      { text: glyph, color: ACTIVITY_STATUS_COLOR[entry.status] },
      { text: ` ${entry.label}`, color: theme.color.t1 },
    ];
    if (entry.detail) runs.push({ text: `  ${truncateLongLine(entry.detail)}`, color: theme.color.t3 });
    out.push({
      id: `${block.id}:${entry.id}`,
      tone: "work",
      text: `    ${glyph} ${entry.label}${entry.detail ? `  ${entry.detail}` : ""}`,
      runs,
      rail: null,
    });
  }
  if (remaining > 0) out.push(moreLineRow(block.id, remaining));
  return out;
}

function activityKindLabel(kind: ActivityBundleEntry["kind"]): string {
  if (kind === "task") return "task";
  if (kind === "schedule") return "schedule";
  if (kind === "workflow") return "workflow";
  return "agent";
}

function activityBundleRows(
  block: Extract<AggregatedBlock, { kind: "activity-bundle" }>,
  spinFrame: string,
  expandedGroupIds: Set<string>,
): RenderedChatRow[] {
  if (!block.entries.length) return [];
  const expandKey = workGroupExpandKey(block.id);
  const expanded = expandedGroupIds.has(expandKey);
  const latest = block.entries[block.entries.length - 1]!;
  const glyph = activityStatusGlyph(latest.status, spinFrame);
  const headerRuns: InlineRun[] = [
    { text: expanded ? "▾ " : "▸ ", color: theme.color.t3 },
    { text: "Activity", color: theme.color.t2, bold: true },
    { text: ` (${block.entries.length})`, color: theme.color.t4 },
  ];
  if (!expanded) {
    headerRuns.push({ text: "  " });
    headerRuns.push({ text: glyph, color: ACTIVITY_STATUS_COLOR[latest.status] });
    headerRuns.push({ text: ` ${activityKindLabel(latest.kind)}`, color: theme.color.t1 });
    headerRuns.push({ text: `  ${truncateLongLine(latest.label)}`, color: theme.color.t3 });
    if (latest.detail) headerRuns.push({ text: `  ${truncateLongLine(latest.detail)}`, color: theme.color.t4 });
  }
  const out: RenderedChatRow[] = [{
    id: block.id,
    tone: "work",
    text: runsPlainText(headerRuns),
    runs: headerRuns,
    rail: null,
    expandableGroupId: expandKey,
  }];
  if (!expanded) return out;
  const { shown, remaining } = visibleEntries(block.entries);
  for (const entry of shown) {
    const entryGlyph = activityStatusGlyph(entry.status, spinFrame);
    const runs: InlineRun[] = [
      { text: "    " },
      { text: entryGlyph, color: ACTIVITY_STATUS_COLOR[entry.status] },
      { text: ` ${activityKindLabel(entry.kind)}`, color: theme.color.t1 },
      { text: `  ${truncateLongLine(entry.label)}`, color: theme.color.t3 },
    ];
    if (entry.detail) runs.push({ text: `  ${truncateLongLine(entry.detail)}`, color: theme.color.t4 });
    out.push({
      id: `${block.id}:${entry.id}`,
      tone: "work",
      text: runsPlainText(runs),
      runs,
      rail: null,
    });
  }
  if (remaining > 0) out.push(moreLineRow(block.id, remaining));
  return out;
}

/**
 * Collapsed reasoning row — mirrors the desktop MinimalThought line:
 * `▸ Thinking… <preview>` while live, `▸ Thought · <preview>` once done.
 */
function reasoningRows(
  block: Extract<AggregatedBlock, { kind: "reasoning" }>,
  spinFrame: string,
): RenderedChatRow[] {
  const preview = block.text.replace(/\s+/g, " ").trim();
  const clipped = preview.length > 96 ? `${preview.slice(0, 96)}...` : preview;
  const label = block.live ? "Thinking…" : "Thought";
  const runs: InlineRun[] = [
    { text: "▸ ", color: theme.color.t4 },
    ...(block.live
      ? [
          { text: spinFrame, color: theme.color.violet } as InlineRun,
          { text: ` ${label}`, color: theme.color.violet, italic: true } as InlineRun,
        ]
      : [{ text: label, color: theme.color.t3, italic: true } as InlineRun]),
  ];
  if (clipped) runs.push({ text: `  ${clipped}`, color: theme.color.t4, italic: true });
  return [{
    id: block.id,
    tone: "work",
    text: `▸ ${label}${clipped ? `  ${clipped}` : ""}`,
    runs,
    rail: null,
  }];
}

function compactionRows(block: Extract<AggregatedBlock, { kind: "compaction" }>, brailleFrame: string): RenderedChatRow[] {
  const trigger = block.trigger === "manual" ? "MANUAL" : "AUTO";
  const pre = typeof block.preTokens === "number" ? formatCompactTokenCount(block.preTokens) : null;
  const post = typeof block.postTokens === "number" ? formatCompactTokenCount(block.postTokens) : null;
  const duration = typeof block.durationMs === "number" ? formatCompactDuration(block.durationMs) : null;
  const countSuffix = typeof block.sessionCompactionCount === "number" && block.sessionCompactionCount >= 2
    ? ` (${block.sessionCompactionCount}×)`
    : "";
  const metadata = [
    trigger,
    pre && post ? `${pre} → ${post}` : pre ? `before ${pre}` : null,
    duration,
  ].filter(Boolean).join(" · ");
  const text = block.live
    ? `        ◌ Compacting context… ${brailleFrame}`
    : `        ✓ Context compacted${countSuffix}${metadata ? ` · ${metadata}` : ""}`;
  return [{
    id: block.id,
    tone: "work",
    text,
    color: theme.color.violet,
    bold: block.live,
    rail: null,
  }];
}

function formatCompactTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

function formatCompactDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(1, Math.round(durationMs))}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds - minutes * 60);
  return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
}

function queuedSteerRows(block: Extract<AggregatedBlock, { kind: "queued-steer" }>, width: number): RenderedChatRow[] {
  const out: RenderedChatRow[] = [{
    id: block.id,
    tone: "work",
    text: "staged message · sends after turn",
    color: theme.color.violet,
    bold: true,
    rail: null,
  }];
  for (const line of wrapText(block.text, Math.max(8, width - 2), "  ", "  ")) {
    out.push({
      id: `${block.id}:text`,
      tone: "work",
      text: line,
      color: theme.color.t2,
      rail: null,
    });
  }
  return out;
}

function planRows(block: Extract<AggregatedBlock, { kind: "plan" }>, spinFrame: string): RenderedChatRow[] {
  const out: RenderedChatRow[] = [];
  out.push({
    id: block.id,
    tone: "plan",
    text: `PLAN · ${block.current}/${block.total}`,
    color: theme.color.violet,
    bold: true,
    rail: null,
  });
  for (const step of block.steps.slice(0, 12)) {
    let glyph: string = "○";
    let color: string = theme.color.t4;
    if (step.status === "completed") {
      glyph = "✓";
      color = theme.color.running;
    } else if (step.status === "in_progress") {
      glyph = block.live ? spinFrame : "●";
      color = theme.color.running;
    } else if (step.status === "failed") {
      glyph = "✗";
      color = theme.color.error;
    }
    out.push({
      id: `${block.id}:${step.text}`,
      tone: "plan",
      text: `${glyph} ${step.text}`,
      color,
      rail: null,
    });
  }
  return out;
}

const WORKING_LABEL = "✦ model working";

// A bright cell sweeps left→right across the label, then a gap before repeating —
// a terminal "shimmer" like Claude Code's working indicator. shimmerPos < 0 (the
// default, used by the non-animated selection/plain-text paths) renders it flat.
function workingShimmerRuns(shimmerPos: number): InlineRun[] {
  const chars = [...WORKING_LABEL];
  return chars.map((ch, index) => {
    const dist = shimmerPos < 0 ? 99 : shimmerPos - index;
    if (dist === 0) return { text: ch, color: theme.color.t1, bold: true };
    if (dist === 1) return { text: ch, color: theme.color.fg, bold: true };
    if (dist === 2 || dist === -1) return { text: ch, color: theme.color.violet };
    return { text: ch, color: theme.color.t3 };
  });
}

function activeTurnRows(dots: string, showWorkingIndicator = true, shimmerPos = -1): RenderedChatRow[] {
  if (!showWorkingIndicator) return [];
  return [{
    id: "model-working",
    tone: "work",
    runs: [...workingShimmerRuns(shimmerPos), { text: dots, color: theme.color.violet }],
    text: `${WORKING_LABEL}${dots}`,
    bold: true,
    rail: null,
  }];
}

function modelInterruptedRows(): RenderedChatRow[] {
  return [{
    id: "model-interrupted",
    tone: "work",
    text: "Interrupted · chat to continue",
    color: theme.color.error,
    bold: true,
    rail: null,
  }];
}

// ─────────────────────────────────────────────────────────────────────────────
// Passthrough renderers (user-bubble, assistant-text, approval, error, notice)
// ─────────────────────────────────────────────────────────────────────────────

function passthroughRows(line: RenderedChatLine, width: number): RenderedChatRow[] {
  const rows: RenderedChatRow[] = [];
  const push = (row: Omit<RenderedChatRow, "id">) => rows.push({ id: line.id, ...row });

  if (line.tone === "user") {
    const maxContentWidth = Math.max(8, Math.min(width - 8, 74));
    const preliminaryRows = wrapText(line.body, maxContentWidth);
    const contentWidth = Math.max(8, Math.min(maxContentWidth, maxRenderedLineWidth(preliminaryRows)));
    const bubbleWidth = contentWidth + 4;
    if (line.header) push({ tone: "user", text: alignRight(line.header, width), dim: true, rail: null });
    const bodyRows = wrapText(line.body, contentWidth);
    push({ tone: "user", text: alignRight(`╭${repeat("─", bubbleWidth - 2)}╮`, width), color: theme.color.accent, rail: null });
    for (const bodyRow of bodyRows) {
      push({ tone: "user", text: alignRight(`│ ${padRight(bodyRow, contentWidth)} │`, width), color: theme.color.fg, rail: null });
    }
    push({ tone: "user", text: alignRight(`╰${repeat("─", bubbleWidth - 2)}╯`, width), color: theme.color.accent, rail: null });
    return rows;
  }

  if (line.tone === "error") {
    for (const text of line.body.split(/\r?\n/)) {
      for (const wrapped of wrapText(text, width, "  ", "  ")) {
        push({ tone: "error", text: wrapped, color: theme.color.danger });
      }
    }
    return rows;
  }

  if (line.tone === "notice" || line.tone === "approval" || line.tone === "tool" || line.tone === "reasoning") {
    if (line.header) push({ tone: line.tone, text: line.header, color: theme.tone(line.tone), dim: true });
    for (const wrapped of wrapText(line.body, width)) {
      push({ tone: line.tone, text: wrapped, color: theme.tone(line.tone), dim: line.tone !== "approval" });
    }
    return rows;
  }

  // assistant
  if (line.header) push({ tone: "assistant", text: line.header, dim: true });
  if (line.blocks?.length) {
    rows.push(...markdownRows(line.blocks, width, line.id));
  } else {
    for (const wrapped of wrapText(line.body, width)) {
      push({ tone: "assistant", text: wrapped, color: theme.color.fg });
    }
  }
  return rows;
}

function rowsForBlock(
  block: AggregatedBlock,
  width: number,
  brailleFrame: string,
  spinFrame: string,
  expandedGroupIds: Set<string>,
): RenderedChatRow[] {
  switch (block.kind) {
    case "user-bubble":
    case "approval":
    case "error":
    case "notice":
      return passthroughRows(block.line, width);
    case "assistant-text":
      return passthroughRows(block.line, width);
    case "tool-calls-group":
      return toolCallsGroupRows(block, spinFrame, expandedGroupIds);
    case "files-changed-group":
      return filesChangedGroupRows(block, width, spinFrame, expandedGroupIds);
    case "runtime-activity":
      return runtimeActivityRows(block, spinFrame);
    case "activity-bundle":
      return activityBundleRows(block, spinFrame, expandedGroupIds);
    case "reasoning":
      return reasoningRows(block, spinFrame);
    case "compaction":
      return compactionRows(block, brailleFrame);
    case "queued-steer":
      return queuedSteerRows(block, width);
    case "plan":
      return planRows(block, spinFrame);
    default:
      return [];
  }
}

function rowsForBlocks(
  blocks: AggregatedBlock[],
  width: number,
  brailleFrame: string,
  spinFrame: string,
  expandedGroupIds: Set<string> = EMPTY_EXPANDED_GROUP_IDS,
): RenderedChatRow[] {
  const rows: RenderedChatRow[] = [];
  let prevKind: AggregatedBlock["kind"] | null = null;
  for (const block of blocks) {
    if (prevKind && shouldInsertSpacer(prevKind, block.kind)) {
      rows.push(spacerRow(`${block.id}:spacer`));
    }
    rows.push(...rowsForBlock(block, width, brailleFrame, spinFrame, expandedGroupIds));
    prevKind = block.kind;
  }
  return rows;
}

function shouldInsertSpacer(prev: AggregatedBlock["kind"], next: AggregatedBlock["kind"]): boolean {
  if (prev === next) return false;
  return true;
}

// A block is "live" (animating) when its group is still in progress. Only live
// blocks read the spinner frame; everything before the first live block renders
// identically regardless of the tick, so it can be memoized independently.
function isLiveBlock(block: AggregatedBlock): boolean {
  return "live" in block && (block as { live?: boolean }).live === true;
}

function maxScrollOffsetForRows(rowCount: number, maxRows?: number): number {
  if (!maxRows || maxRows <= 0 || rowCount <= maxRows) return 0;
  return Math.max(0, rowCount - Math.max(1, maxRows - 1));
}

function spacerRow(
  id: string,
  tone: RenderedChatRow["tone"] = "indicator",
): RenderedChatRow {
  return { id, tone, text: BLANK_ROW_TEXT, dim: true, rail: null };
}

function sliceRows(
  rows: RenderedChatRow[],
  maxRows?: number,
  scrollOffsetRows = 0,
  unseenMessageCount = 0,
  olderHistoryLoading = false,
): RenderedChatRow[] {
  // Preserve object identity when sourceRowIndex is already correct (pre-indexed
  // historical rows), so React.memo(ChatRow) can skip re-rendering unchanged rows
  // on every spinner tick. Rows without a matching index are cloned as before.
  const indexedRows = rows.map((row, index) => (
    row.sourceRowIndex === index ? row : { ...row, sourceRowIndex: index }
  ));
  if (!maxRows || maxRows <= 0) return indexedRows;
  const viewportRows = Math.max(1, maxRows);
  if (indexedRows.length <= viewportRows) {
    return [
      ...indexedRows,
      ...Array.from({ length: viewportRows - indexedRows.length }, (_, index) => (
        spacerRow(`scroll-filler:${indexedRows.length + index}`)
      )),
    ];
  }
  const offset = Math.max(0, Math.min(scrollOffsetRows, maxScrollOffsetForRows(indexedRows.length, viewportRows)));
  const end = Math.max(1, indexedRows.length - offset);
  const hasNewer = offset > 0;
  let contentRows = Math.max(1, viewportRows - (hasNewer ? 1 : 0));
  let start = Math.max(0, end - contentRows);
  const hasOlder = start > 0;
  if (hasOlder) {
    contentRows = Math.max(1, viewportRows - 1 - (hasNewer ? 1 : 0));
    start = Math.max(0, end - contentRows);
  }
  const visible = indexedRows.slice(start, end);
  const result: RenderedChatRow[] = [];
  if (hasOlder) {
    // While a scroll-back page fetch is in flight the indicator swaps text in
    // place — same row, same count — so the scroll math is untouched.
    result.push({
      id: "older-indicator",
      tone: "indicator",
      text: olderHistoryLoading ? "↑ loading earlier…" : "↑ older messages",
      dim: true,
      rail: null,
    });
  }
  result.push(...visible);
  while (result.length < viewportRows - (hasNewer ? 1 : 0)) {
    result.push(spacerRow(`scroll-filler:${result.length}`));
  }
  if (hasNewer) {
    // If we know how many unseen messages arrived since the user scrolled away,
    // surface that count as the "↓ N new" pill. Falls back to the plain indicator.
    const pillText = unseenMessageCount > 0
      ? `↓ ${unseenMessageCount} new message${unseenMessageCount === 1 ? "" : "s"} · press End`
      : "↓ newer messages";
    result.push({
      id: "newer-indicator",
      tone: "indicator",
      text: pillText,
      color: unseenMessageCount > 0 ? theme.color.violet : undefined,
      bold: unseenMessageCount > 0,
      rail: null,
    });
  }
  return result;
}

function railColorForTone(_tone: RenderedChatRow["tone"]): string | null {
  // User-facing decision: drop the left vertical bar entirely. Subagent rows
  // get their own colored side rail via the row's explicit `rail` field.
  return null;
}

const InlineSpans = React.memo(function InlineSpans({ runs }: { runs: InlineRun[] }) {
  return (
    <>
      {runs.map((run, index) => {
        const key = `${index}:${run.text}`;
        if (run.code) {
          // Codex-style: green foreground, no background chip.
          return (
            <Text key={key} color={run.color ?? theme.color.codeInline}>
              {run.text}
            </Text>
          );
        }
        if (run.link) {
          const content = run.href
            ? `\u001B]8;;${run.href}\u0007${run.text}\u001B]8;;\u0007`
            : run.text;
          return (
            <Text key={key} color={run.color ?? LINK_COLOR} underline>
              {content}
            </Text>
          );
        }
        return (
          <Text key={key} color={run.color} dimColor={run.dim} bold={run.bold} italic={run.italic}>
            {run.text}
          </Text>
        );
      })}
    </>
  );
});

function normalizeSelection(selection: ChatTextSelection): ChatTextSelection {
  if (
    selection.startRow < selection.endRow
    || (selection.startRow === selection.endRow && selection.startColumn <= selection.endColumn)
  ) {
    return selection;
  }
  return {
    startRow: selection.endRow,
    startColumn: selection.endColumn,
    endRow: selection.startRow,
    endColumn: selection.startColumn,
  };
}

function selectedRangeForRow(rowIndex: number, selection: ChatTextSelection, lineWidth: number): [number, number] | null {
  const normalized = normalizeSelection(selection);
  if (rowIndex < normalized.startRow || rowIndex > normalized.endRow) return null;
  const rawStart = rowIndex === normalized.startRow ? normalized.startColumn : 0;
  const rawEnd = rowIndex === normalized.endRow ? normalized.endColumn + 1 : Math.max(lineWidth, 1);
  const start = Math.max(0, Math.min(rawStart, Math.max(lineWidth, 1)));
  const end = Math.max(start, Math.min(rawEnd, Math.max(lineWidth, 1)));
  return end > start ? [start, end] : null;
}

function splitTextByColumns(value: string, start: number, end: number): [string, string, string] {
  const parts = splitByDisplayCells(value || BLANK_ROW_TEXT, start, end);
  return [parts.before, parts.selected, parts.after];
}

const ChatRow = React.memo(function ChatRow({
  row,
  selection,
}: {
  row: RenderedChatRow;
  selection?: ChatTextSelection | null;
}) {
  const railColor = row.rail === undefined ? railColorForTone(row.tone) : row.rail;
  const plainText = row.text || BLANK_ROW_TEXT;
  const selectedRange = selection && typeof row.sourceRowIndex === "number"
    ? selectedRangeForRow(row.sourceRowIndex, selection, textWidth(renderedRowText(row)))
    : null;
  // Every transcript row is exactly one terminal line — the scroll math and
  // mouse selection both assume it. Truncate instead of letting Ink wrap long
  // tool/work lines onto a second row.
  if (selectedRange) {
    const [before, selected, after] = splitTextByColumns(renderedRowText(row), selectedRange[0], selectedRange[1]);
    return (
      <Text
        color={row.color ?? (row.tone === "indicator" ? theme.color.accent : undefined)}
        dimColor={row.dim}
        bold={row.bold}
        italic={row.italic}
        wrap="truncate-end"
      >
        {railColor ? <Text color={railColor}>{"▎ "}</Text> : null}
        {before}
        <Text inverse>{selected || BLANK_ROW_TEXT}</Text>
        {after}
      </Text>
    );
  }
  return (
    <Text
      color={row.color ?? (row.tone === "indicator" ? theme.color.accent : undefined)}
      dimColor={row.dim}
      bold={row.bold}
      italic={row.italic}
      wrap="truncate-end"
    >
      {railColor ? <Text color={railColor}>{"▎ "}</Text> : null}
      {row.runs ? <InlineSpans runs={row.runs} /> : plainText}
    </Text>
  );
});

function renderedRowText(row: RenderedChatRow): string {
  if (!row.runs && row.text === BLANK_ROW_TEXT) return "";
  return row.runs ? runsPlainText(row.runs) : row.text;
}

function isPaginationIndicatorRow(row: RenderedChatRow): boolean {
  return row.id === "older-indicator" || row.id === "newer-indicator";
}

function selectableRowsForBlocks({
  blocks,
  width = DEFAULT_VIEW_WIDTH,
  streaming = false,
  interrupted = false,
  brailleFrame = "·",
  spinFrame = "◐",
  dotPulse = "",
  showWorkingIndicator = true,
  expandedGroupIds = EMPTY_EXPANDED_GROUP_IDS,
}: {
  blocks: AggregatedBlock[];
  width?: number;
  streaming?: boolean;
  interrupted?: boolean;
  brailleFrame?: string;
  spinFrame?: string;
  dotPulse?: string;
  showWorkingIndicator?: boolean;
  expandedGroupIds?: Set<string>;
}): RenderedChatRow[] {
  const innerWidth = Math.max(24, width - 4);
  const baseRows = rowsForBlocks(blocks, innerWidth, brailleFrame, spinFrame, expandedGroupIds);
  if (streaming) return [...baseRows, ...activeTurnRows(dotPulse, showWorkingIndicator)];
  if (interrupted) return [...baseRows, ...modelInterruptedRows()];
  return baseRows;
}

export function renderChatSelectableRows({
  blocks,
  width = DEFAULT_VIEW_WIDTH,
  streaming = false,
  interrupted = false,
  showWorkingIndicator = true,
  expandedLineIds,
}: {
  blocks: AggregatedBlock[];
  width?: number;
  streaming?: boolean;
  interrupted?: boolean;
  showWorkingIndicator?: boolean;
  expandedLineIds?: Set<string>;
}): RenderedChatRow[] {
  return selectableRowsForBlocks({
    blocks,
    width,
    streaming,
    interrupted,
    showWorkingIndicator,
    expandedGroupIds: expandedLineIds,
  });
}

export function chatScrollMaxOffsetFromSelectableRows({
  rows,
  maxRows,
}: {
  rows: ReadonlyArray<RenderedChatRow>;
  maxRows?: number;
}): number {
  return maxScrollOffsetForRows(rows.length, maxRows);
}

export function renderChatSelectableRowTextsFromRows(rows: ReadonlyArray<RenderedChatRow>): string[] {
  return rows.map(renderedRowText);
}

export function renderChatVisibleSelectionRowsFromRows({
  rows,
  maxRows,
  scrollOffsetRows = 0,
  unseenMessageCount = 0,
}: {
  rows: RenderedChatRow[];
  maxRows?: number;
  scrollOffsetRows?: number;
  unseenMessageCount?: number;
}): ChatVisibleSelectionRow[] {
  return sliceRows(rows, maxRows, scrollOffsetRows, unseenMessageCount).map((row) => ({
    sourceRow: typeof row.sourceRowIndex === "number" ? row.sourceRowIndex : null,
    text: renderedRowText(row),
    expandableId: row.expandableGroupId ?? null,
    actionId: row.actionId ?? null,
  }));
}

function visibleRowsForBlocks({
  blocks,
  maxRows,
  scrollOffsetRows = 0,
  unseenMessageCount = 0,
  width = DEFAULT_VIEW_WIDTH,
  streaming = false,
  interrupted = false,
  brailleFrame = "·",
  spinFrame = "◐",
  dotPulse = "",
  showWorkingIndicator = true,
  expandedGroupIds = EMPTY_EXPANDED_GROUP_IDS,
}: {
  blocks: AggregatedBlock[];
  maxRows?: number;
  scrollOffsetRows?: number;
  unseenMessageCount?: number;
  width?: number;
  streaming?: boolean;
  interrupted?: boolean;
  brailleFrame?: string;
  spinFrame?: string;
  dotPulse?: string;
  showWorkingIndicator?: boolean;
  expandedGroupIds?: Set<string>;
}): RenderedChatRow[] {
  return sliceRows(
    selectableRowsForBlocks({
      blocks,
      width,
      streaming,
      interrupted,
      brailleFrame,
      spinFrame,
      dotPulse,
      showWorkingIndicator,
      expandedGroupIds,
    }),
    maxRows,
    scrollOffsetRows,
    unseenMessageCount,
  );
}

export function renderChatVisibleRowTexts({
  events,
  notices,
  activeSession,
  expandedLineIds,
  maxRows,
  scrollOffsetRows = 0,
  unseenMessageCount = 0,
  width = DEFAULT_VIEW_WIDTH,
  streaming = false,
  interrupted = false,
  showWorkingIndicator = true,
}: {
  events: AgentChatEventEnvelope[];
  notices: LocalNotice[];
  activeSession: AgentChatSessionSummary | null;
  expandedLineIds?: Set<string>;
  maxRows?: number;
  scrollOffsetRows?: number;
  unseenMessageCount?: number;
  width?: number;
  streaming?: boolean;
  interrupted?: boolean;
  showWorkingIndicator?: boolean;
}): string[] {
  const blocks = aggregateChatBlocks({
    events,
    notices,
    activeSession,
    expandedLineIds,
  });
  return visibleRowsForBlocks({
    blocks,
    maxRows,
    scrollOffsetRows,
    unseenMessageCount,
    width,
    streaming,
    interrupted,
    showWorkingIndicator,
    expandedGroupIds: expandedLineIds,
  }).map(renderedRowText);
}

export function renderChatVisibleSelectionRows({
  events,
  blocks: providedBlocks,
  notices,
  activeSession,
  expandedLineIds,
  maxRows,
  scrollOffsetRows = 0,
  unseenMessageCount = 0,
  width = DEFAULT_VIEW_WIDTH,
  streaming = false,
  interrupted = false,
  showWorkingIndicator = true,
}: {
  events: AgentChatEventEnvelope[];
  blocks?: AggregatedBlock[];
  notices: LocalNotice[];
  activeSession: AgentChatSessionSummary | null;
  expandedLineIds?: Set<string>;
  maxRows?: number;
  scrollOffsetRows?: number;
  unseenMessageCount?: number;
  width?: number;
  streaming?: boolean;
  interrupted?: boolean;
  showWorkingIndicator?: boolean;
}): ChatVisibleSelectionRow[] {
  const blocks = providedBlocks ?? aggregateChatBlocks({
    events,
    notices,
    activeSession,
    expandedLineIds,
  });
  return visibleRowsForBlocks({
    blocks,
    maxRows,
    scrollOffsetRows,
    unseenMessageCount,
    width,
    streaming,
    interrupted,
    showWorkingIndicator,
    expandedGroupIds: expandedLineIds,
  }).map((row) => ({
    sourceRow: typeof row.sourceRowIndex === "number" ? row.sourceRowIndex : null,
    text: renderedRowText(row),
    expandableId: row.expandableGroupId ?? null,
    actionId: row.actionId ?? null,
  }));
}

export function renderChatSelectableRowTexts({
  events,
  blocks: providedBlocks,
  notices,
  activeSession,
  expandedLineIds,
  width = DEFAULT_VIEW_WIDTH,
  streaming = false,
  interrupted = false,
  showWorkingIndicator = true,
}: {
  events: AgentChatEventEnvelope[];
  blocks?: AggregatedBlock[];
  notices: LocalNotice[];
  activeSession: AgentChatSessionSummary | null;
  expandedLineIds?: Set<string>;
  width?: number;
  streaming?: boolean;
  interrupted?: boolean;
  showWorkingIndicator?: boolean;
}): string[] {
  const blocks = providedBlocks ?? aggregateChatBlocks({
    events,
    notices,
    activeSession,
    expandedLineIds,
  });
  return selectableRowsForBlocks({
    blocks,
    width,
    streaming,
    interrupted,
    showWorkingIndicator,
    expandedGroupIds: expandedLineIds,
  }).map(renderedRowText);
}

export function selectedTextFromChatRows(rows: string[], selection: ChatTextSelection): string {
  const normalized = normalizeSelection(selection);
  const selected: string[] = [];
  for (let rowIndex = normalized.startRow; rowIndex <= normalized.endRow; rowIndex += 1) {
    const row = rows[rowIndex] ?? "";
    const range = selectedRangeForRow(rowIndex, normalized, textWidth(row));
    if (!range) {
      selected.push("");
      continue;
    }
    selected.push(sliceByDisplayCells(row, range[0], range[1]));
  }
  return selected.join("\n");
}

export function renderChatTranscriptPlainText({
  events,
  notices,
  activeSession,
  expandedLineIds,
  maxRows,
  scrollOffsetRows = 0,
  width = DEFAULT_VIEW_WIDTH,
}: {
  events: AgentChatEventEnvelope[];
  notices: LocalNotice[];
  activeSession: AgentChatSessionSummary | null;
  expandedLineIds?: Set<string>;
  maxRows?: number;
  scrollOffsetRows?: number;
  width?: number;
}): string {
  const blocks = aggregateChatBlocks({
    events,
    notices,
    activeSession,
    expandedLineIds,
  });
  const innerWidth = Math.max(24, width - 4);
  return sliceRows(rowsForBlocks(blocks, innerWidth, "·", "◐", expandedLineIds), maxRows, scrollOffsetRows)
    .filter((row) => !isPaginationIndicatorRow(row))
    .map(renderedRowText)
    .join("\n")
    .trimEnd();
}

// The splash (BootHero) stays on screen until the chat has real conversation
// content. Informational notices ("Model set to …", "No prompt history", nav
// hints) aggregate into `notice` blocks but must NOT dismiss the splash — only
// a sent prompt or a streaming response (any non-notice block) makes it "a
// chat." Keeps the new-chat surface clean: nothing but the splash until send.
export function hasConversationContent(blocks: ReadonlyArray<{ kind: string }>): boolean {
  return blocks.some((block) => block.kind !== "notice");
}

export function computeChatScrollMaxOffset({
  events,
  blocks: providedBlocks,
  notices,
  activeSession,
  expandedLineIds,
  maxRows,
  streaming = false,
  interrupted = false,
  showWorkingIndicator = true,
  width = DEFAULT_VIEW_WIDTH,
}: {
  events: AgentChatEventEnvelope[];
  blocks?: AggregatedBlock[];
  notices: LocalNotice[];
  activeSession: AgentChatSessionSummary | null;
  expandedLineIds?: Set<string>;
  maxRows?: number;
  streaming?: boolean;
  interrupted?: boolean;
  showWorkingIndicator?: boolean;
  width?: number;
}): number {
  const blocks = providedBlocks ?? aggregateChatBlocks({
    events,
    notices,
    activeSession,
    expandedLineIds,
  });
  if (!hasConversationContent(blocks) && !streaming && !interrupted) return 0;
  const innerWidth = Math.max(24, width - 4);
  let statusRows = 0;
  if (streaming) statusRows = activeTurnRows("", showWorkingIndicator).length;
  else if (interrupted) statusRows = modelInterruptedRows().length;
  const rowCount = rowsForBlocks(blocks, innerWidth, "·", "◐", expandedLineIds).length + statusRows;
  return maxScrollOffsetForRows(rowCount, maxRows);
}

function ChatViewComponent({
  events,
  blocks: providedBlocks,
  notices,
  activeSession,
  projectName,
  laneName,
  lane,
  provider,
  modelDisplay,
  streaming = false,
  interrupted = false,
  worktreeAvailable = true,
  expandedLineIds,
  maxRows,
  scrollOffsetRows = 0,
  unseenMessageCount = 0,
  olderHistory = null,
  selection = null,
  width = DEFAULT_VIEW_WIDTH,
  focused = false,
  hovered = false,
  removeHovered = false,
  onRemove,
}: {
  events: AgentChatEventEnvelope[];
  /** Pre-aggregated blocks. When provided, skips the internal aggregation pass. */
  blocks?: AggregatedBlock[];
  notices: LocalNotice[];
  activeSession: AgentChatSessionSummary | null;
  projectName: string;
  laneName: string;
  lane?: LaneSummary | null;
  provider?: AdeCodeProvider | null;
  modelDisplay?: string | null;
  streaming?: boolean;
  interrupted?: boolean;
  worktreeAvailable?: boolean;
  expandedLineIds?: Set<string>;
  maxRows?: number;
  scrollOffsetRows?: number;
  unseenMessageCount?: number;
  /**
   * Scroll-back pagination state for the ACTIVE single-chat view. "loading"
   * swaps the top indicator text to "↑ loading earlier…" in place (row count
   * is identical in all states); "available"/"exhausted"/null keep the
   * existing indicator behavior.
   */
  olderHistory?: "loading" | "available" | "exhausted" | null;
  selection?: ChatTextSelection | null;
  width?: number;
  focused?: boolean;
  hovered?: boolean;
  removeHovered?: boolean;
  onRemove?: () => void;
}) {
  // Memoize the heavy aggregation pass — it walks the entire transcript and
  // shouldn't re-run on every spinner tick. Events identity changes only when
  // the underlying chat history advances, which is the right invalidation key.
  const blocks = useMemo(
    () => providedBlocks ?? aggregateChatBlocks({ events, notices, activeSession, expandedLineIds }),
    [providedBlocks, events, notices, activeSession, expandedLineIds],
  );
  const tileMode = focused || Boolean(onRemove);
  const bodyRows = tileMode ? Math.max(1, (maxRows ?? 4) - 4) : maxRows;
  const brailleFrame = useBrailleSpin();
  const spinFrame = useSpinFrame();
  const dotPulse = useDotPulse();
  const shimmerTick = useShimmerTick();
  const showWorkingIndicator = provider !== "claude" && activeSession?.provider !== "claude";
  const rowInnerWidth = Math.max(24, width - 4);
  // Split the transcript at the first live (animating) block. Everything before
  // it is frame-independent, so we memoize those rows on [blocks, width] and the
  // 100ms spinner tick no longer rebuilds the whole transcript — only the few
  // trailing live blocks (the current turn's running tool/plan/compaction groups)
  // are rebuilt per tick.
  const { historicalBlocks, tailBlocks } = useMemo(() => {
    const idx = blocks.findIndex(isLiveBlock);
    return idx < 0
      ? { historicalBlocks: blocks, tailBlocks: [] as AggregatedBlock[] }
      : { historicalBlocks: blocks.slice(0, idx), tailBlocks: blocks.slice(idx) };
  }, [blocks]);
  const historicalRows = useMemo(
    // Pre-index historical rows by their final position (they always occupy
    // slots 0..H-1, before the seam spacer + live tail). sliceRows then reuses
    // these stable objects instead of cloning them every tick.
    () => rowsForBlocks(historicalBlocks, rowInnerWidth, STATIC_SPIN_FRAME, STATIC_SPIN_FRAME, expandedLineIds)
      .map((row, index) => ({ ...row, sourceRowIndex: index })),
    [historicalBlocks, rowInnerWidth, expandedLineIds],
  );
  const rows = useMemo(() => {
    const tailRows = tailBlocks.length
      ? rowsForBlocks(tailBlocks, rowInnerWidth, brailleFrame, spinFrame, expandedLineIds)
      : [];
    let baseRows: RenderedChatRow[];
    if (historicalBlocks.length && tailBlocks.length) {
      // Match single-pass rowsForBlocks: the seam spacer is keyed off the
      // adjacent block KINDS (its prevKind), not whether the historical blocks
      // happened to produce any rows — a zero-row historical block (e.g. an
      // empty group) still seeds prevKind there.
      const lastHistKind = historicalBlocks[historicalBlocks.length - 1]?.kind;
      const firstTailKind = tailBlocks[0]?.kind;
      const needSpacer = lastHistKind != null && firstTailKind != null
        && shouldInsertSpacer(lastHistKind, firstTailKind);
      baseRows = needSpacer
        ? [...historicalRows, spacerRow(`${tailBlocks[0]!.id}:spacer`), ...tailRows]
        : [...historicalRows, ...tailRows];
    } else {
      baseRows = tailBlocks.length ? [...historicalRows, ...tailRows] : historicalRows;
    }
    let withSuffix = baseRows;
    if (streaming) {
      // Sweep a bright cell across the label, with a short gap before repeating.
      const sweepLength = WORKING_LABEL.length + 6;
      const shimmerPos = shimmerTick % sweepLength;
      withSuffix = [...baseRows, ...activeTurnRows(dotPulse, showWorkingIndicator, shimmerPos)];
    } else if (interrupted) {
      withSuffix = [...baseRows, ...modelInterruptedRows()];
    }
    return sliceRows(withSuffix, bodyRows, scrollOffsetRows, unseenMessageCount, olderHistory === "loading");
  }, [historicalRows, historicalBlocks, tailBlocks, rowInnerWidth, brailleFrame, spinFrame, dotPulse, shimmerTick, streaming, interrupted, showWorkingIndicator, bodyRows, scrollOffsetRows, unseenMessageCount, olderHistory, expandedLineIds]);
  const isEmpty = !hasConversationContent(blocks) && !streaming && !interrupted;
  let content: React.ReactNode;
  if (isEmpty && tileMode) {
    content = (
      <Box flexDirection="column" paddingX={1} height={bodyRows}>
        <Text color={theme.color.t4} dimColor>No transcript yet.</Text>
      </Box>
    );
  } else if (isEmpty) {
    content = (
      <BootHero
        projectName={projectName}
        laneName={laneName}
        lane={lane ?? null}
        provider={provider}
        modelDisplay={modelDisplay}
        worktreeAvailable={worktreeAvailable}
        width={width}
      />
    );
  } else {
    content = (
      <Box flexDirection="column" paddingX={1} height={bodyRows}>
        {rows.map((row, index) => (
          <ChatRow key={`${row.id}:${index}`} row={row} selection={selection} />
        ))}
      </Box>
    );
  }

  if (!tileMode) return content;

  const innerWidth = Math.max(8, width - 4);
  const title = activeSession?.title ?? activeSession?.goal ?? activeSession?.summary ?? activeSession?.sessionId ?? "chat";
  const removeSlot = onRemove ? " ×" : "";
  // Lane identity: an explicit lane color tints the rail + border so tiles for
  // the same lane read at a glance (the focused tile still wins with cyan).
  const laneAccent = lane?.color ?? null;
  const railSlot = laneAccent ? 2 : 0;
  // Multi-state status glyph (mirrors the desktop board's per-card state dot).
  let statusGlyph: string;
  let statusColor: string;
  if (streaming) {
    statusGlyph = brailleFrame;
    statusColor = theme.color.running;
  } else if (interrupted) {
    statusGlyph = "◌";
    statusColor = theme.color.attention;
  } else if (activeSession?.status === "ended") {
    statusGlyph = "○";
    statusColor = theme.color.t5;
  } else {
    statusGlyph = "·";
    statusColor = theme.color.t4;
  }
  const available = Math.max(4, innerWidth - railSlot - 2 /* status */ - removeSlot.length - 3);
  const lanePart = truncateEnd(laneName || "(lane removed)", Math.max(3, Math.floor(available * 0.4)));
  const titlePart = truncateEnd(title, Math.max(3, available - textWidth(lanePart) - 3));
  const header = truncateEnd(`${lanePart} / ${titlePart}`, Math.max(4, innerWidth - railSlot - removeSlot.length - 2));
  // Borders stay neutral; only the focused tile is accented (violet). Lane
  // identity lives INSIDE the tile (the colored rail + title), never the border,
  // so the grid doesn't read as a jumble of differently-colored frames.
  let tileBorderColor: string;
  if (focused) tileBorderColor = theme.color.violet;
  else if (hovered) tileBorderColor = theme.color.borderActive;
  else tileBorderColor = theme.color.border;
  let headerColor: string;
  if (focused) headerColor = theme.color.violet;
  else if (activeSession?.status === "ended") headerColor = theme.color.t4;
  else headerColor = theme.color.t2;
  return (
    <Box
      flexDirection="column"
      borderStyle={focused ? "double" : "round"}
      borderColor={tileBorderColor}
      height={maxRows}
      width={width}
    >
      <Box paddingX={1} flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <Box flexDirection="row" flexShrink={1}>
          {laneAccent ? <Text color={laneAccent}>{"▎ "}</Text> : null}
          <Text color={headerColor} wrap="truncate-end">
            {header}
          </Text>
        </Box>
        <Box flexDirection="row" flexShrink={0}>
          <Text color={statusColor}>{statusGlyph}</Text>
          {onRemove ? (
            <Text color={removeHovered ? theme.color.error : theme.color.t4} inverse={removeHovered}>
              {" ×"}
            </Text>
          ) : null}
        </Box>
      </Box>
      {content}
    </Box>
  );
}

export const ChatView = React.memo(ChatViewComponent);
