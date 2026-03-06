import React, { useMemo } from "react";
import type { OrchestratorChatMessage } from "../../../shared/types";
import { AgentChatMessageList } from "../chat/AgentChatMessageList";
import { adaptMissionThreadMessagesToAgentEvents } from "./missionThreadEventAdapter";

type MissionThreadMessageListProps = {
  messages: OrchestratorChatMessage[];
  showStreamingIndicator?: boolean;
  className?: string;
};

export const MissionThreadMessageList = React.memo(function MissionThreadMessageList({
  messages,
  showStreamingIndicator = false,
  className,
}: MissionThreadMessageListProps) {
  const events = useMemo(() => adaptMissionThreadMessagesToAgentEvents(messages), [messages]);

  return (
    <AgentChatMessageList
      events={events}
      showStreamingIndicator={showStreamingIndicator}
      className={className}
    />
  );
});
