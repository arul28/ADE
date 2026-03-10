import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentChatApprovalDecision, AgentChatEventEnvelope, OrchestratorChatMessage } from "../../../shared/types";
import { parseAgentChatTranscript } from "../../../shared/chatTranscript";
import { AgentChatMessageList } from "../chat/AgentChatMessageList";
import { AgentQuestionModal } from "../chat/AgentQuestionModal";
import { adaptMissionThreadMessagesToAgentEvents } from "./missionThreadEventAdapter";
import { useMissionPolling } from "./useMissionPolling";

type MissionThreadMessageListProps = {
  messages: OrchestratorChatMessage[];
  sessionId?: string | null;
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

function buildEventSignature(envelope: AgentChatEventEnvelope): string {
  const event = envelope.event;
  const baseParts = [
    envelope.sessionId,
    envelope.timestamp,
    event.type,
  ];
  if ("itemId" in event && typeof event.itemId === "string") baseParts.push(event.itemId);
  if ("turnId" in event && typeof event.turnId === "string") baseParts.push(event.turnId);
  if (event.type === "text" || event.type === "reasoning") baseParts.push(event.text);
  if (event.type === "tool_call" || event.type === "tool_result") baseParts.push(event.tool);
  if (event.type === "command") baseParts.push(event.command, event.cwd);
  if (event.type === "file_change") baseParts.push(event.path);
  if (event.type === "error") baseParts.push(event.message);
  return baseParts.join("::");
}

function mergeMissionThreadEvents(
  fallbackEvents: AgentChatEventEnvelope[],
  sessionEvents: AgentChatEventEnvelope[] | null,
): AgentChatEventEnvelope[] {
  const merged = new Map<string, AgentChatEventEnvelope>();
  for (const event of fallbackEvents) {
    merged.set(buildEventSignature(event), event);
  }
  for (const event of sessionEvents ?? []) {
    merged.set(buildEventSignature(event), event);
  }
  return [...merged.values()].sort((left, right) => {
    const delta = Date.parse(left.timestamp) - Date.parse(right.timestamp);
    return Number.isFinite(delta) && delta !== 0 ? delta : buildEventSignature(left).localeCompare(buildEventSignature(right));
  });
}

export const MissionThreadMessageList = React.memo(function MissionThreadMessageList({
  messages,
  sessionId = null,
  showStreamingIndicator = false,
  className,
  onApproval,
}: MissionThreadMessageListProps) {
  const [sessionEvents, setSessionEvents] = useState<AgentChatEventEnvelope[] | null>(null);
  const fallbackEvents = useMemo(() => adaptMissionThreadMessagesToAgentEvents(messages), [messages]);

  useEffect(() => {
    setSessionEvents(null);
  }, [sessionId]);

  const refreshSessionTranscript = useCallback(() => {
    if (!sessionId) {
      setSessionEvents(null);
      return;
    }
    window.ade.sessions.readTranscriptTail({
      sessionId,
      maxBytes: 1_800_000,
      raw: true,
    }).then(
      (raw) => {
        const parsed = parseAgentChatTranscript(raw).filter((entry) => entry.sessionId === sessionId);
        setSessionEvents(parsed);
      },
      () => setSessionEvents([]),
    );
  }, [sessionId]);

  useEffect(() => {
    refreshSessionTranscript();
  }, [refreshSessionTranscript]);

  useMissionPolling(refreshSessionTranscript, 2_000, Boolean(sessionId));

  const events = useMemo(() => {
    return mergeMissionThreadEvents(fallbackEvents, sessionEvents);
  }, [fallbackEvents, sessionEvents]);
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
