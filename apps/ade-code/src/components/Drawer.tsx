import React from "react";
import { Box, Text } from "ink";
import type { AgentChatSessionSummary, LaneSummary } from "../../../desktop/src/shared/types";
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
}: {
  lanes: LaneSummary[];
  sessions: AgentChatSessionSummary[];
  activeLaneId: string | null;
  activeSessionId: string | null;
  browsingLaneId: string | null;
  selectedLaneIndex: number;
  selectedChatIndex: number;
}) {
  const browsingLane = lanes.find((lane) => lane.id === browsingLaneId) ?? null;
  const laneSessions = sessions.filter((session) => session.laneId === browsingLaneId).slice(0, 12);
  return (
    <Box width={28} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold>LANES</Text>
      {lanes.slice(0, 10).map((lane, index) => (
        <Text key={lane.id} color={lane.id === activeLaneId ? AMBER : lane.id === browsingLaneId ? "white" : undefined}>
          {index === selectedLaneIndex ? "›" : " "} {lane.id === activeLaneId ? "●" : lane.id === browsingLaneId ? "◐" : "○"} {formatLaneLabel(lane).slice(0, 20)}
        </Text>
      ))}
      <Text dimColor>+ new lane</Text>
      <Text dimColor>{"─".repeat(24)}</Text>
      <Text bold>CHATS · {browsingLane?.name ?? "no lane"}</Text>
      {laneSessions.length === 0 ? (
        <Text dimColor>No chats in lane.</Text>
      ) : laneSessions.map((session, index) => (
        <Text key={session.sessionId} color={session.sessionId === activeSessionId ? PURPLE : undefined}>
          {index === selectedChatIndex ? "›" : " "} {session.sessionId === activeSessionId ? "●" : " "} {formatSessionLabel(session).slice(0, 20)}
        </Text>
      ))}
      <Text dimColor>+ new chat</Text>
      <Text dimColor>enter opens selected · arrows move</Text>
    </Box>
  );
}
