import React from "react";
import { Box, Text } from "ink";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import type { LocalNotice } from "../types";
import { renderChatLines, type AssistantMarkdownBlock, type RenderedChatLine } from "../format";
import { theme } from "../theme";
import { AdeWordmark } from "./AdeWordmark";
import { laneIconGlyph } from "./Header";

const HERO_TARGET_HALO_WIDTH = 56;
const HERO_MIN_HALO_WIDTH = 28;
const HERO_WORDMARK_MIN_USABLE = 24;
const DEFAULT_VIEW_WIDTH = 88;

type RenderedChatRow = {
  id: string;
  text: string;
  tone: RenderedChatLine["tone"] | "indicator";
  color?: string;
  dim?: boolean;
  bold?: boolean;
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

function HeroDivider({ width }: { width: number }) {
  return <Text color={theme.color.border} dimColor>{"─".repeat(Math.max(4, width))}</Text>;
}

function HeroMetaRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box flexDirection="row">
      <Box width={9}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text color={color ?? theme.color.fg}>{value}</Text>
    </Box>
  );
}

export function BootHero({
  projectName,
  laneName,
  lane,
  width = DEFAULT_VIEW_WIDTH,
}: {
  projectName: string;
  laneName: string;
  lane?: LaneSummary | null;
  width?: number;
}) {
  const laneColor = theme.lane(lane ?? null);
  const laneGlyph = laneIconGlyph(lane?.icon ?? null);
  const trimmedProject = projectName.trim();
  const projectLabel = trimmedProject || "—";
  const branchLabel = lane?.branchRef?.trim() || "—";

  // Outer halo border + inner card border = 4 chars of horizontal chrome.
  // Card border 2 + paddingX 4 + inner paddingX 2 = 8 chars between halo edge
  // and content. Clamp so we don't blow out narrow terminals.
  const haloWidth = Math.max(HERO_MIN_HALO_WIDTH, Math.min(HERO_TARGET_HALO_WIDTH, width - 2));
  const cardWidth = haloWidth - 4;
  const usableWidth = Math.max(4, cardWidth - 8);
  const showWordmark = usableWidth >= HERO_WORDMARK_MIN_USABLE;

  return (
    <Box flexDirection="column" alignItems="center" paddingY={1}>
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
              <Text>
                <Text color={theme.color.fg} bold>ade code</Text>
                <Text dimColor>  ·  v0.1</Text>
              </Text>
            </Box>
            <Box height={1} />
            <HeroMetaRow label="Project" value={projectLabel} />
            <HeroMetaRow label="Lane" value={`${laneGlyph} ${laneName}`} color={laneColor} />
            <HeroMetaRow label="Branch" value={branchLabel === "—" ? branchLabel : `⎇ ${branchLabel}`} />
            <Box height={1} />
            <HeroDivider width={usableWidth} />
            <Box height={1} />
            <Text color={theme.color.fg}>type to chat</Text>
            <Box height={1} />
            <Text>
              <Text color={theme.color.accent} bold>/</Text>
              <Text dimColor>  commands     </Text>
              <Text color={theme.color.accent} bold>@</Text>
              <Text dimColor>  files     </Text>
              <Text color={theme.color.accent} bold>?</Text>
              <Text dimColor>  help</Text>
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

function markdownRows(blocks: AssistantMarkdownBlock[], width: number, id: string): RenderedChatRow[] {
  const rows: RenderedChatRow[] = [];
  const pushWrapped = (
    text: string,
    firstPrefix = "",
    restPrefix = firstPrefix,
    options: Partial<RenderedChatRow> = {},
  ) => {
    for (const wrapped of wrapText(text, width, firstPrefix, restPrefix)) {
      rows.push({ id, tone: "assistant", text: wrapped, color: theme.color.fg, ...options });
    }
  };

  for (const block of blocks) {
    if (rows.length) rows.push({ id, tone: "assistant", text: "" });
    if (block.kind === "heading") {
      pushWrapped(block.text, "", "", { color: theme.color.accent, bold: true });
      continue;
    }
    if (block.kind === "bullet") {
      pushWrapped(block.text, "• ", "  ");
      continue;
    }
    if (block.kind === "numbered") {
      const prefix = `${block.number}. `;
      pushWrapped(block.text, prefix, repeat(" ", textWidth(prefix)));
      continue;
    }
    if (block.kind === "quote") {
      pushWrapped(block.text, "> ", "> ", { dim: true });
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
    if (block.kind === "hr") {
      rows.push({ id, tone: "assistant", text: repeat("─", Math.min(width, 72)), color: theme.color.border, dim: true });
      continue;
    }
    pushWrapped(block.text);
  }
  return rows;
}

function rowsForLine(line: RenderedChatLine, prevTone: RenderedChatLine["tone"] | null, width: number): RenderedChatRow[] {
  const isChatTurn = line.tone === "user" || line.tone === "assistant";
  const speakerChanged = prevTone !== line.tone;
  const showSpacer = isChatTurn && speakerChanged && prevTone !== null;
  const rows: RenderedChatRow[] = [];
  const push = (row: Omit<RenderedChatRow, "id">) => rows.push({ id: line.id, ...row });
  if (showSpacer) push({ tone: line.tone, text: "" });

  if (line.tone === "user") {
    const bubbleWidth = Math.max(12, Math.min(width - 4, 78));
    const contentWidth = Math.max(1, bubbleWidth - 4);
    if (line.header) push({ tone: "user", text: alignRight(line.header, width), dim: true });
    const bodyRows = wrapText(line.body, contentWidth);
    push({ tone: "user", text: alignRight(`╭${repeat("─", bubbleWidth - 2)}╮`, width), color: theme.color.accent });
    for (const bodyRow of bodyRows) {
      push({ tone: "user", text: alignRight(`│ ${padRight(bodyRow, contentWidth)} │`, width), color: theme.color.fg });
    }
    push({ tone: "user", text: alignRight(`╰${repeat("─", bubbleWidth - 2)}╯`, width), color: theme.color.accent });
    return rows;
  }

  if (line.tone === "tool" || line.tone === "error") {
    const isErrorTone = line.tone === "error";
    for (const text of line.body.split(/\r?\n/)) {
      for (const wrapped of wrapText(text, width, "  ", "  ")) {
        push({ tone: line.tone, text: wrapped, color: isErrorTone ? theme.color.danger : theme.color.tool, dim: !isErrorTone });
      }
    }
    return rows;
  }

  if (line.tone === "reasoning" || line.tone === "notice" || line.tone === "approval") {
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

function rowsForLines(lines: RenderedChatLine[], width: number): RenderedChatRow[] {
  return lines.flatMap((line, index) => rowsForLine(line, index > 0 ? lines[index - 1]!.tone : null, width));
}

function sliceRows(rows: RenderedChatRow[], maxRows?: number, scrollOffsetRows = 0): RenderedChatRow[] {
  if (!maxRows || maxRows <= 0 || rows.length <= maxRows) return rows;
  let offset = Math.max(0, Math.min(scrollOffsetRows, rows.length - maxRows));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const end = rows.length - offset;
    const start = Math.max(0, end - maxRows);
    const hasOlder = start > 0;
    const hasNewer = end < rows.length;
    const contentRows = Math.max(1, maxRows - (hasOlder ? 1 : 0) - (hasNewer ? 1 : 0));
    const nextEnd = rows.length - offset;
    const nextStart = Math.max(0, nextEnd - contentRows);
    const nextHasOlder = nextStart > 0;
    const nextHasNewer = nextEnd < rows.length;
    if (nextHasOlder === hasOlder && nextHasNewer === hasNewer) {
      const visible = rows.slice(nextStart, nextEnd);
      return [
        ...(nextHasOlder ? [{ id: "older-indicator", tone: "indicator" as const, text: "↑ older messages", dim: true }] : []),
        ...visible,
        ...(nextHasNewer ? [{ id: "newer-indicator", tone: "indicator" as const, text: "↓ newer messages", dim: true }] : []),
      ];
    }
    offset = Math.max(0, Math.min(offset, rows.length - contentRows));
  }
  return rows.slice(-maxRows);
}

function ChatRow({ row }: { row: RenderedChatRow }) {
  return (
    <Text color={row.color ?? (row.tone === "indicator" ? theme.color.accent : undefined)} dimColor={row.dim} bold={row.bold}>
      {row.text}
    </Text>
  );
}

export function ChatView({
  events,
  notices,
  activeSession,
  projectName,
  laneName,
  lane,
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
  expandedLineIds?: Set<string>;
  maxRows?: number;
  scrollOffsetRows?: number;
  width?: number;
}) {
  const lines = renderChatLines({ events, notices, activeSession, expandedLineIds, maxLines: 200 });
  if (!lines.length) {
    return <BootHero projectName={projectName} laneName={laneName} lane={lane ?? null} width={width} />;
  }
  const rows = sliceRows(rowsForLines(lines, Math.max(24, width - 2)), maxRows, scrollOffsetRows);
  return (
    <Box flexDirection="column" paddingX={1}>
      {rows.map((row, index) => (
        <ChatRow key={`${row.id}:${index}`} row={row} />
      ))}
    </Box>
  );
}
