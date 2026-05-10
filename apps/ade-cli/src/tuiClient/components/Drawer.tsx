import React from "react";
import { Box, Text } from "ink";
import type { AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import { formatLaneLabel, formatSessionLabel } from "../format";

const PURPLE = "#A78BFA";
const AMBER = "#F59E0B";

export function Drawer({
  lanes,
  sessions,
  activeLaneId,
  activeSessionId,
  browsingLaneId,
  selectedLaneIndex,
  selectedChatIndex,
  focused = false,
}: {
  lanes: LaneSummary[];
  sessions: AgentChatSessionSummary[];
  activeLaneId: string | null;
  activeSessionId: string | null;
  browsingLaneId: string | null;
  selectedLaneIndex: number;
  selectedChatIndex: number;
  focused?: boolean;
}) {
  const browsingLane = lanes.find((lane) => lane.id === browsingLaneId) ?? null;
  const laneSessions = sessions.filter((session) => session.laneId === browsingLaneId).slice(0, 12);
  const laneRows = lanes.slice(0, 10);
  return (
    <Box width={28} flexDirection="column" borderStyle="single" borderColor={focused ? PURPLE : "gray"} paddingX={1}>
      <Text bold color={focused ? PURPLE : undefined}>LANES{focused ? " · focused" : ""}</Text>
      {laneRows.map((lane, index) => (
        <Text key={lane.id} color={lane.id === activeLaneId ? AMBER : lane.id === browsingLaneId ? "white" : undefined}>
          {index === selectedLaneIndex ? "›" : " "} {lane.id === activeLaneId ? "●" : lane.id === browsingLaneId ? "◐" : "○"} {formatLaneLabel(lane).slice(0, 20)}
        </Text>
      ))}
      <Text color={selectedLaneIndex === laneRows.length ? PURPLE : undefined} dimColor={selectedLaneIndex !== laneRows.length}>
        {selectedLaneIndex === laneRows.length ? "›" : " "} + new lane
      </Text>
      <Text dimColor>{"─".repeat(24)}</Text>
      <Text bold>CHATS · {browsingLane?.name ?? "no lane"}</Text>
      {laneSessions.length === 0 ? (
        <Text dimColor>No chats in lane.</Text>
      ) : laneSessions.map((session, index) => (
        <Text key={session.sessionId} color={session.sessionId === activeSessionId ? PURPLE : undefined}>
          {index === selectedChatIndex ? "›" : " "} {session.sessionId === activeSessionId ? "●" : " "} {formatSessionLabel(session).slice(0, 20)}
        </Text>
      ))}
      <Text color={selectedChatIndex === laneSessions.length ? PURPLE : undefined} dimColor={selectedChatIndex !== laneSessions.length}>
        {selectedChatIndex === laneSessions.length ? "›" : " "} + new chat
      </Text>
      <Text dimColor>enter switches · + opens details</Text>
    </Box>
  );
}
