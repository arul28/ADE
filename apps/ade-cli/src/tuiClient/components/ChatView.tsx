import React from "react";
import { Box, Text } from "ink";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { LocalNotice } from "../types";
import { renderChatLines, type RenderedChatLine } from "../format";

const COLORS = {
  user: "#A78BFA",
  assistant: "white",
  tool: "cyan",
  error: "red",
  notice: "gray",
  reasoning: "gray",
  approval: "yellow",
} as const;

export function BootHero({
  projectName,
  laneName,
}: {
  projectName: string;
  laneName: string;
}) {
  return (
  <Box flexDirection="column" alignItems="center" paddingY={1}>
      <Text color="#A78BFA">██▄  ██▄  ██▀</Text>
      <Text color="#A78BFA">█ █  █ █  █▀ </Text>
      <Text color="#A78BFA">██▀  ██▀  ██▄</Text>
      <Text dimColor>code · v0.1</Text>
      <Text dimColor>{projectName} · {laneName}</Text>
      <Text dimColor>type to chat · / for commands</Text>
      <Text dimColor>try: inspect the current diff</Text>
      <Text dimColor>try: @file then ask for a focused review</Text>
      <Text dimColor>try: /status or /new chat</Text>
    </Box>
  );
}

function clipBodyToRows(body: string, rows: number): string {
  if (rows <= 0) return "";
  const lines = body.split(/\r?\n/);
  if (lines.length <= rows) return body;
  return lines.slice(-rows).join("\n");
}

function rowCount(line: RenderedChatLine): number {
  return (line.header ? 1 : 0) + Math.max(1, line.body.split(/\r?\n/).length);
}

function visibleRows(lines: RenderedChatLine[], maxRows: number): RenderedChatLine[] {
  if (maxRows <= 0) return [];
  const visible: RenderedChatLine[] = [];
  let remaining = maxRows;
  for (let index = lines.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const line = lines[index]!;
    const needed = rowCount(line);
    if (needed <= remaining) {
      visible.unshift(line);
      remaining -= needed;
      continue;
    }
    const headerRows = line.header ? 1 : 0;
    const bodyRows = Math.max(0, remaining - headerRows);
    if (bodyRows > 0) {
      visible.unshift({
        ...line,
        body: clipBodyToRows(line.body, bodyRows),
      });
    }
    break;
  }
  return visible;
}

export function ChatView({
  events,
  notices,
  activeSession,
  projectName,
  laneName,
  expandedLineIds,
  maxLines = 64,
  maxRows = 24,
}: {
  events: AgentChatEventEnvelope[];
  notices: LocalNotice[];
  activeSession: AgentChatSessionSummary | null;
  projectName: string;
  laneName: string;
  expandedLineIds?: Set<string>;
  maxLines?: number;
  maxRows?: number;
}) {
  const lines = renderChatLines({ events, notices, activeSession, expandedLineIds, maxLines });
  if (!lines.length) {
    return <BootHero projectName={projectName} laneName={laneName} />;
  }
  const clippedLines = visibleRows(lines, maxRows);
  return (
    <Box flexDirection="column" paddingX={1}>
      {clippedLines.map((line) => (
        <Box key={line.id} flexDirection="column" marginBottom={line.header ? 1 : 0}>
          {line.header ? <Text color={COLORS[line.tone]}>{line.header}</Text> : null}
          <Text color={COLORS[line.tone]}>{line.body}</Text>
        </Box>
      ))}
    </Box>
  );
}
