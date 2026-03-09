import React, { useMemo } from "react";
import type { AgentChatApprovalDecision, AgentChatEventEnvelope, OrchestratorChatMessage } from "../../../shared/types";
import { AgentChatMessageList } from "../chat/AgentChatMessageList";
import { AgentQuestionModal } from "../chat/AgentQuestionModal";
import { adaptMissionThreadMessagesToAgentEvents } from "./missionThreadEventAdapter";

type MissionThreadMessageListProps = {
  messages: OrchestratorChatMessage[];
  showStreamingIndicator?: boolean;
  className?: string;
  onApproval?: (
    sessionId: string,
    itemId: string,
    decision: AgentChatApprovalDecision,
    responseText?: string | null,
  ) => void;
};

type PendingApproval = {
  sessionId: string;
  itemId: string;
  kind: "command" | "file_change" | "tool_call";
  detail?: unknown;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function derivePendingApprovals(events: AgentChatEventEnvelope[]): PendingApproval[] {
  const pending = new Map<string, PendingApproval>();

  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "done") {
      pending.clear();
      continue;
    }
    if (event.type === "approval_request") {
      pending.set(event.itemId, {
        sessionId: envelope.sessionId,
        itemId: event.itemId,
        kind: event.kind,
        detail: event.detail,
      });
      continue;
    }
    if (event.type === "tool_result" || event.type === "command" || event.type === "file_change") {
      pending.delete(event.itemId);
    }
  }

  return [...pending.values()];
}

function extractAskUserQuestion(approval: PendingApproval | null): string | null {
  if (!approval || approval.kind !== "tool_call") return null;
  const detail = readRecord(approval.detail);
  const tool = typeof detail?.tool === "string" ? detail.tool.trim() : "";
  const question = typeof detail?.question === "string" ? detail.question.trim() : "";
  const normalizedTool = tool.toLowerCase();
  if ((normalizedTool !== "askuser" && normalizedTool !== "ask_user") || !question.length) return null;
  return question;
}

export const MissionThreadMessageList = React.memo(function MissionThreadMessageList({
  messages,
  showStreamingIndicator = false,
  className,
  onApproval,
}: MissionThreadMessageListProps) {
  const events = useMemo(() => adaptMissionThreadMessagesToAgentEvents(messages), [messages]);
  const pendingApproval = useMemo(() => derivePendingApprovals(events)[0] ?? null, [events]);
  const pendingQuestion = useMemo(() => extractAskUserQuestion(pendingApproval), [pendingApproval]);

  return (
    <>
      <AgentChatMessageList
        events={events}
        showStreamingIndicator={showStreamingIndicator}
        className={className}
        onApproval={onApproval
          ? (itemId, decision, responseText) => {
              const approval = pendingApproval?.itemId === itemId
                ? pendingApproval
                : derivePendingApprovals(events).find((entry) => entry.itemId === itemId) ?? null;
              if (!approval) return;
              onApproval(approval.sessionId, itemId, decision, responseText);
            }
          : undefined}
      />
      {pendingQuestion && pendingApproval && onApproval ? (
        <AgentQuestionModal
          question={pendingQuestion}
          onClose={() => onApproval(pendingApproval.sessionId, pendingApproval.itemId, "cancel")}
          onSubmit={(answer) => onApproval(pendingApproval.sessionId, pendingApproval.itemId, "accept", answer)}
          onDecline={() => onApproval(pendingApproval.sessionId, pendingApproval.itemId, "decline")}
        />
      ) : null}
    </>
  );
});
