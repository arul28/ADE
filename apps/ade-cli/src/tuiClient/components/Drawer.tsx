import React from "react";
import { Box, Text, useStdout } from "ink";
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
  const { stdout } = useStdout();
  const panelHeight = stdout?.rows ?? 40;
  const laneSessions = sessions.filter((session) => session.laneId === browsingLaneId).slice(0, 12);
  // Adaptive 50% cap: LANES section uses up to half the column height (header + rows + "+ new lane").
  const lanesMaxRows = Math.max(2, Math.floor(panelHeight / 2) - 3);
  const laneRows = lanes.slice(0, Math.min(10, lanesMaxRows));
  return (
    <Box width={28} flexDirection="column" borderStyle="single" borderColor={focused ? PURPLE : "gray"} paddingX={1}>
      <Box flexDirection="column" flexShrink={1}>
        <Text bold color={focused ? PURPLE : undefined}>LANES</Text>
        {laneRows.map((lane, index) => (
          <Text key={lane.id} color={lane.id === activeLaneId ? AMBER : lane.id === browsingLaneId ? "white" : undefined}>
            {index === selectedLaneIndex ? "›" : " "} {lane.id === activeLaneId ? "●" : lane.id === browsingLaneId ? "◐" : "○"} {formatLaneLabel(lane).slice(0, 20)}
          </Text>
        ))}
        <Text color={selectedLaneIndex === laneRows.length ? PURPLE : undefined} dimColor={selectedLaneIndex !== laneRows.length}>
          {selectedLaneIndex === laneRows.length ? "›" : " "} + new lane
        </Text>
      </Box>
      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle="single"
        borderTop
        borderLeft={false}
        borderRight={false}
        borderBottom={false}
        borderColor="gray"
      >
        <Text bold>CHATS</Text>
        {laneSessions.length === 0 ? (
          <Text dimColor>No chats in lane.</Text>
        ) : laneSessions.map((session, index) => (
          <Text key={session.sessionId} color={session.sessionId === activeSessionId ? PURPLE : undefined}>
            {index === selectedChatIndex ? "›" : " "} {formatSessionLabel(session).slice(0, 22)}
          </Text>
        ))}
        <Text color={selectedChatIndex === laneSessions.length ? PURPLE : undefined} dimColor={selectedChatIndex !== laneSessions.length}>
          {selectedChatIndex === laneSessions.length ? "›" : " "} + new chat
        </Text>
      </Box>
    </Box>
  );
}
