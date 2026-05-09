import React from "react";
import { Box, Text } from "ink";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../desktop/src/shared/types";
import type { LocalNotice } from "../types";
import { renderChatLines } from "../format";

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

export function ChatView({
  events,
  notices,
  activeSession,
  projectName,
  laneName,
  expandedLineIds,
}: {
  events: AgentChatEventEnvelope[];
  notices: LocalNotice[];
  activeSession: AgentChatSessionSummary | null;
  projectName: string;
  laneName: string;
  expandedLineIds?: Set<string>;
}) {
  const lines = renderChatLines({ events, notices, activeSession, expandedLineIds, maxLines: 64 });
  if (!lines.length) {
    return <BootHero projectName={projectName} laneName={laneName} />;
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      {lines.map((line) => (
        <Box key={line.id} flexDirection="column" marginBottom={line.header ? 1 : 0}>
          {line.header ? <Text color={COLORS[line.tone]}>{line.header}</Text> : null}
          <Text color={COLORS[line.tone]}>{line.body}</Text>
        </Box>
      ))}
    </Box>
  );
}
