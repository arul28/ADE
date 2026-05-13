import React from "react";
import { Box, Text } from "ink";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import type { LocalNotice } from "../types";
import {
  parseInlineRuns,
  type AssistantMarkdownBlock,
  type InlineRun,
  type RenderedChatLine,
} from "../format";
import { aggregateChatBlocks, type AggregatedBlock, type PlanStep, type WorkTool } from "../aggregate";
import { theme } from "../theme";
import { useBrailleSpin, useDotPulse, useSpinFrame } from "../spinTick";
import { AdeWordmark } from "./AdeWordmark";
import { laneIconGlyph } from "./Header";
import type { AdeCodeProvider } from "../types";

const HERO_TARGET_HALO_WIDTH = 56;
const HERO_MIN_HALO_WIDTH = 28;
const HERO_WORDMARK_MIN_USABLE = 24;
const DEFAULT_VIEW_WIDTH = 88;
const BLANK_ROW_TEXT = " ";

type RenderedChatRow = {
  id: string;
  text: string;
  tone: RenderedChatLine["tone"] | "indicator" | "work" | "memory" | "plan" | "footer";
  color?: string;
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
  rail?: string | null;
  runs?: InlineRun[];
};

function textWidth(value: string): number {
  return [...value].length;
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
  if (textWidth(value) <= max) return value;
  if (max <= 1) return value.slice(0, Math.max(0, max));
  return `${[...value].slice(0, max - 1).join("")}…`;
}

function hardWrapWord(word: string, width: number): string[] {
  if (width <= 1) return [word];
  const chars = [...word];
  const chunks: string[] = [];
  for (let index = 0; index < chars.length; index += width) {
    chunks.push(chars.slice(index, index + width).join(""));
  }
  return chunks;
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
  const showWordmark = usableWidth >= HERO_WORDMARK_MIN_USABLE;

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
              {showWordmark ? (
                <AdeWordmark />
              ) : (
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

function markdownRows(blocks: AssistantMarkdownBlock[], width: number, id: string): RenderedChatRow[] {
  const rows: RenderedChatRow[] = [];

  for (const block of blocks) {
    if (rows.length) rows.push(spacerRow(`${id}:markdown-spacer:${rows.length}`, "assistant"));
    if (block.kind === "heading") {
      rows.push(...inlineRowsFromText(block.text, width, id, "", "", { color: theme.color.accent, bold: true }));
      continue;
    }
    if (block.kind === "bullet") {
      rows.push(...inlineRowsFromText(block.text, width, id, "• ", "  "));
      continue;
    }
    if (block.kind === "numbered") {
      const prefix = `${block.number}. `;
      rows.push(...inlineRowsFromText(block.text, width, id, prefix, repeat(" ", textWidth(prefix))));
      continue;
    }
    if (block.kind === "quote") {
      rows.push(...inlineRowsFromText(block.text, width, id, "> ", "> ", { dim: true }));
      continue;
    }
    if (block.kind === "code") {
      const label = block.language ? ` ${block.language}` : "";
      rows.push({ id, tone: "assistant", text: `  ┌${repeat("─", Math.max(1, Math.min(width - 5, 24)))}${label}`, color: theme.color.border, dim: true });
      for (const codeLine of block.lines.length ? block.lines : [""]) {
        const available = Math.max(1, width - 4);
        const chunks = hardWrapWord(codeLine || " ", available);
        for (const chunk of chunks) {
          rows.push({ id, tone: "assistant", text: `  │ ${chunk}`, color: theme.color.tool, dim: true });
        }
      }
      rows.push({ id, tone: "assistant", text: "  └", color: theme.color.border, dim: true });
      continue;
    }
    if (block.kind === "table") {
      rows.push(...tableRows(block, width, id));
      continue;
    }
    if (block.kind === "hr") {
      rows.push({ id, tone: "assistant", text: repeat("─", Math.min(width, 72)), color: theme.color.border, dim: true });
      continue;
    }
    rows.push(...inlineRowsFromText(block.text, width, id, "", ""));
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Block renderers
// ─────────────────────────────────────────────────────────────────────────────

const LINK_COLOR = theme.color.info;
const MEMORY_COLOR = theme.color.tool;
const WORK_STATUS_COLOR: Record<WorkTool["status"], string> = {
  running: theme.color.violet,
  ok: theme.color.running,
  failed: theme.color.error,
};

function formatDurationMs(ms: number | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remSeconds}s`;
}

function workBlockRows(
  block: Extract<AggregatedBlock, { kind: "work-block" }>,
  width: number,
  brailleFrame: string,
  spinFrame: string,
): RenderedChatRow[] {
  if (!block.tools.length) return [];
  const out: RenderedChatRow[] = [];
  const total = block.tools.length;
  const ok = block.tools.filter((tool) => tool.status === "ok").length;
  const failed = block.tools.filter((tool) => tool.status === "failed").length;

  const headerText = block.live
    ? `▸ working · ${total} tool${total === 1 ? "" : "s"} so far ${brailleFrame}`
    : (() => {
        const parts: string[] = [`▸ ${total} tool${total === 1 ? "" : "s"}`];
        if (ok > 0) parts.push(`${ok} ok`);
        if (failed > 0) parts.push(`${failed} failed`);
        const dur = formatDurationMs(block.durationMs);
        if (dur) parts.push(dur);
        return parts.join(" · ");
      })();

  out.push({
    id: block.id,
    tone: "work",
    text: headerText,
    color: theme.color.t3,
    rail: null,
  });

  type Display = { tool: WorkTool; faded: boolean };
  let displays: Display[];
  if (block.live) {
    const recent = block.tools.slice(-3).reverse();
    displays = recent.map((tool, index) => ({ tool, faded: index === recent.length - 1 && total > 3 }));
  } else {
    const failedTools = block.tools.filter((tool) => tool.status === "failed");
    if (failedTools.length === 0) {
      const lastOk = [...block.tools].reverse().find((tool) => tool.status === "ok");
      displays = lastOk ? [{ tool: lastOk, faded: false }] : [];
    } else {
      displays = failedTools.map((tool) => ({ tool, faded: false }));
      if (failed < total) {
        const lastOk = [...block.tools].reverse().find((tool) => tool.status === "ok");
        if (lastOk) displays.push({ tool: lastOk, faded: false });
      }
    }
  }

  for (const { tool, faded } of displays) {
    const glyph = tool.status === "failed" ? "✗" : tool.status === "running" ? spinFrame : "✓";
    const statusColor = faded ? theme.color.t5 : WORK_STATUS_COLOR[tool.status];
    const dur = formatDurationMs(tool.durationMs);
    const nameColor = faded ? theme.color.t5 : theme.color.t1;
    const argColor = faded ? theme.color.t5 : theme.color.t3;
    const tailColor = faded ? theme.color.t5 : theme.color.t4;
    const argText = tool.arg ? ` · ${tool.arg}` : "";
    const tailText = dur ? `  ${dur}` : "";
    const runs: InlineRun[] = [
      { text: "  " },
      { text: glyph, color: statusColor },
      { text: ` ${tool.tool}`, color: nameColor },
    ];
    if (argText) runs.push({ text: argText, color: argColor });
    if (tailText) runs.push({ text: tailText, color: tailColor });
    const lineText = `  ${glyph} ${tool.tool}${argText}${tailText}`;
    out.push({
      id: `${block.id}:${tool.itemId}`,
      tone: "work",
      text: lineText,
      runs,
      rail: null,
    });
  }
  return out;
}

function memoryRows(block: Extract<AggregatedBlock, { kind: "memory" }>, brailleFrame: string): RenderedChatRow[] {
  const text = block.live
    ? `· memory ${brailleFrame}`
    : `· memory${typeof block.hitCount === "number" ? ` · ${block.hitCount} hit${block.hitCount === 1 ? "" : "s"}` : ""}`;
  return [{
    id: block.id,
    tone: "memory",
    text,
    color: MEMORY_COLOR,
    rail: null,
  }];
}

function compactionRows(block: Extract<AggregatedBlock, { kind: "compaction" }>, brailleFrame: string): RenderedChatRow[] {
  const preTokens = typeof block.preTokens === "number" ? ` · before ${block.preTokens.toLocaleString()} tokens` : "";
  const text = block.live
    ? `⟳ compacting context · ${block.trigger} ${brailleFrame}`
    : `⟳ context compacted · ${block.trigger}${preTokens}`;
  return [{
    id: block.id,
    tone: "work",
    text,
    color: theme.color.violet,
    bold: block.live,
    rail: null,
  }];
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

function modelWorkingRows(dots: string): RenderedChatRow[] {
  return [{
    id: "model-working",
    tone: "work",
    text: `✦ model working${dots}`,
    color: theme.color.violet,
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
): RenderedChatRow[] {
  switch (block.kind) {
    case "user-bubble":
    case "approval":
    case "error":
    case "notice":
      return passthroughRows(block.line, width);
    case "assistant-text": {
      const rows = passthroughRows(block.line, width);
      if (block.precededByHeavy) {
        rows.unshift(spacerRow(`${block.id}:leading-spacer`, "assistant"));
      }
      return rows;
    }
    case "work-block":
      return workBlockRows(block, width, brailleFrame, spinFrame);
    case "memory":
      return memoryRows(block, brailleFrame);
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
): RenderedChatRow[] {
  const rows: RenderedChatRow[] = [];
  let prevKind: AggregatedBlock["kind"] | null = null;
  for (const block of blocks) {
    if (prevKind && shouldInsertSpacer(prevKind, block.kind)) {
      rows.push(spacerRow(`${block.id}:spacer`));
    }
    rows.push(...rowsForBlock(block, width, brailleFrame, spinFrame));
    prevKind = block.kind;
  }
  return rows;
}

function shouldInsertSpacer(prev: AggregatedBlock["kind"], next: AggregatedBlock["kind"]): boolean {
  if (prev === next) return false;
  return true;
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

function sliceRows(rows: RenderedChatRow[], maxRows?: number, scrollOffsetRows = 0): RenderedChatRow[] {
  if (!maxRows || maxRows <= 0) return rows;
  const viewportRows = Math.max(1, maxRows);
  if (rows.length <= viewportRows) {
    return [
      ...rows,
      ...Array.from({ length: viewportRows - rows.length }, (_, index) => (
        spacerRow(`scroll-filler:${rows.length + index}`)
      )),
    ];
  }
  const offset = Math.max(0, Math.min(scrollOffsetRows, maxScrollOffsetForRows(rows.length, viewportRows)));
  const end = Math.max(1, rows.length - offset);
  const hasNewer = offset > 0;
  let contentRows = Math.max(1, viewportRows - (hasNewer ? 1 : 0));
  let start = Math.max(0, end - contentRows);
  const hasOlder = start > 0;
  if (hasOlder) {
    contentRows = Math.max(1, viewportRows - 1 - (hasNewer ? 1 : 0));
    start = Math.max(0, end - contentRows);
  }
  const visible = rows.slice(start, end);
  const result: RenderedChatRow[] = [];
  if (hasOlder) {
    result.push({ id: "older-indicator", tone: "indicator", text: "↑ older messages", dim: true, rail: null });
  }
  result.push(...visible);
  while (result.length < viewportRows - (hasNewer ? 1 : 0)) {
    result.push(spacerRow(`scroll-filler:${result.length}`));
  }
  if (hasNewer) {
    result.push({ id: "newer-indicator", tone: "indicator", text: "↓ newer messages", dim: true, rail: null });
  }
  return result;
}

function railColorForTone(tone: RenderedChatRow["tone"]): string | null {
  switch (tone) {
    case "assistant":
      return theme.color.t1;
    case "tool":
      return theme.color.tool;
    case "reasoning":
      return theme.color.violet;
    case "notice":
      return theme.color.t4;
    case "error":
      return theme.color.danger;
    case "approval":
      return theme.color.attention;
    default:
      return null;
  }
}

function InlineSpans({ runs }: { runs: InlineRun[] }) {
  return (
    <>
      {runs.map((run, index) => {
        const key = `${index}:${run.text}`;
        if (run.code) {
          return (
            <Text key={key} backgroundColor={theme.color.surface1} color={run.color ?? theme.color.t1}>
              {run.text}
            </Text>
          );
        }
        if (run.link) {
          return (
            <Text key={key} color={run.color ?? LINK_COLOR} underline>
              {run.text}
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
}

function ChatRow({ row }: { row: RenderedChatRow }) {
  const railColor = row.rail === undefined ? railColorForTone(row.tone) : row.rail;
  const plainText = row.text || BLANK_ROW_TEXT;
  return (
    <Text
      color={row.color ?? (row.tone === "indicator" ? theme.color.accent : undefined)}
      dimColor={row.dim}
      bold={row.bold}
      italic={row.italic}
    >
      {railColor ? <Text color={railColor}>{"▎ "}</Text> : null}
      {row.runs ? <InlineSpans runs={row.runs} /> : plainText}
    </Text>
  );
}

function renderedRowText(row: RenderedChatRow): string {
  if (!row.runs && row.text === BLANK_ROW_TEXT) return "";
  return row.runs ? runsPlainText(row.runs) : row.text;
}

function isPaginationIndicatorRow(row: RenderedChatRow): boolean {
  return row.id === "older-indicator" || row.id === "newer-indicator";
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
  return sliceRows(rowsForBlocks(blocks, innerWidth, "·", "◐"), maxRows, scrollOffsetRows)
    .filter((row) => !isPaginationIndicatorRow(row))
    .map(renderedRowText)
    .join("\n")
    .trimEnd();
}

export function computeChatScrollMaxOffset({
  events,
  notices,
  activeSession,
  expandedLineIds,
  maxRows,
  streaming = false,
  width = DEFAULT_VIEW_WIDTH,
}: {
  events: AgentChatEventEnvelope[];
  notices: LocalNotice[];
  activeSession: AgentChatSessionSummary | null;
  expandedLineIds?: Set<string>;
  maxRows?: number;
  streaming?: boolean;
  width?: number;
}): number {
  const blocks = aggregateChatBlocks({
    events,
    notices,
    activeSession,
    expandedLineIds,
  });
  if (!blocks.length && !streaming) return 0;
  const innerWidth = Math.max(24, width - 4);
  const rowCount = rowsForBlocks(blocks, innerWidth, "·", "◐").length + (streaming ? modelWorkingRows("").length : 0);
  return maxScrollOffsetForRows(rowCount, maxRows);
}

export function ChatView({
  events,
  notices,
  activeSession,
  projectName,
  laneName,
  lane,
  provider,
  modelDisplay,
  streaming = false,
  worktreeAvailable = true,
  expandedLineIds,
  maxRows,
  scrollOffsetRows = 0,
  width = DEFAULT_VIEW_WIDTH,
}: {
  events: AgentChatEventEnvelope[];
  notices: LocalNotice[];
  activeSession: AgentChatSessionSummary | null;
  projectName: string;
  laneName: string;
  lane?: LaneSummary | null;
  provider?: AdeCodeProvider | null;
  modelDisplay?: string | null;
  streaming?: boolean;
  worktreeAvailable?: boolean;
  expandedLineIds?: Set<string>;
  maxRows?: number;
  scrollOffsetRows?: number;
  width?: number;
}) {
  const blocks = aggregateChatBlocks({
    events,
    notices,
    activeSession,
    expandedLineIds,
  });
  const brailleFrame = useBrailleSpin();
  const spinFrame = useSpinFrame();
  const dotPulse = useDotPulse();
  if (!blocks.length && !streaming) {
    return (
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
  }
  const innerWidth = Math.max(24, width - 4);
  const baseRows = rowsForBlocks(blocks, innerWidth, brailleFrame, spinFrame);
  const rows = sliceRows(
    streaming ? [...baseRows, ...modelWorkingRows(dotPulse)] : baseRows,
    maxRows,
    scrollOffsetRows,
  );
  return (
    <Box flexDirection="column" paddingX={1} height={maxRows}>
      {rows.map((row, index) => (
        <ChatRow key={`${row.id}:${index}`} row={row} />
      ))}
    </Box>
  );
}
