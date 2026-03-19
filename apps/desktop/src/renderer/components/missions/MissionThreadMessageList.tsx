import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentChatApprovalDecision, AgentChatEvent, AgentChatEventEnvelope, OrchestratorChatMessage } from "../../../shared/types";
import { parseAgentChatTranscript } from "../../../shared/chatTranscript";
import { AgentChatMessageList } from "../chat/AgentChatMessageList";
import { AgentQuestionModal } from "../chat/AgentQuestionModal";
import { ChatSubagentStrip } from "../chat/ChatSubagentStrip";
import { deriveChatSubagentSnapshots } from "../chat/chatExecutionSummary";
import { looksLikeLowSignalNoise } from "./missionHelpers";
import { adaptMissionThreadMessagesToAgentEvents } from "./missionThreadEventAdapter";
import { useMissionPolling } from "./useMissionPolling";

type MissionThreadMessageListProps = {
  messages: OrchestratorChatMessage[];
  sessionId?: string | null;
  showStreamingIndicator?: boolean;
  transcriptPollingEnabled?: boolean;
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

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function textJoinSeparator(left: string, right: string): string {
  if (left.length > 0 && right.length > 0 && !/\s$/.test(left) && !/^\s/.test(right)) return " ";
  return "";
}

function mergeInlineText(existing: string, incoming: string): string {
  if (!existing.length) return incoming;
  if (!incoming.length) return existing;
  if (existing === incoming) return existing;
  if (incoming.startsWith(existing)) return incoming;
  if (existing.startsWith(incoming)) return existing;
  if (existing.includes(incoming)) return existing;
  if (incoming.includes(existing)) return incoming;
  return `${existing}${textJoinSeparator(existing, incoming)}${incoming}`;
}

function pickLaterTimestamp(left: string, right: string): string {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) return rightMs >= leftMs ? right : left;
  if (Number.isFinite(rightMs)) return right;
  return left;
}

function provenanceRichness(envelope: AgentChatEventEnvelope): number {
  return [
    envelope.provenance?.messageId,
    envelope.provenance?.threadId,
    envelope.provenance?.role,
    envelope.provenance?.targetKind,
    envelope.provenance?.sourceSessionId,
    envelope.provenance?.attemptId,
    envelope.provenance?.stepKey,
    envelope.provenance?.laneId,
    envelope.provenance?.runId,
  ].filter((value) => typeof value === "string" && value.trim().length > 0).length;
}

function eventHasPayload(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return false;
}

function choosePreferredEnvelope(
  existing: AgentChatEventEnvelope,
  incoming: AgentChatEventEnvelope,
): AgentChatEventEnvelope {
  const existingRichness = provenanceRichness(existing);
  const incomingRichness = provenanceRichness(incoming);
  if (incomingRichness !== existingRichness) return incomingRichness > existingRichness ? incoming : existing;
  const existingMs = Date.parse(existing.timestamp);
  const incomingMs = Date.parse(incoming.timestamp);
  if (Number.isFinite(existingMs) && Number.isFinite(incomingMs) && incomingMs !== existingMs) {
    return incomingMs > existingMs ? incoming : existing;
  }
  return incoming;
}

function mergeDuplicateEnvelope(
  existing: AgentChatEventEnvelope,
  incoming: AgentChatEventEnvelope,
): AgentChatEventEnvelope {
  const preferred = choosePreferredEnvelope(existing, incoming);
  const provenance =
    provenanceRichness(incoming) >= provenanceRichness(existing)
      ? incoming.provenance ?? existing.provenance
      : existing.provenance ?? incoming.provenance;

  if (existing.event.type === "text" && incoming.event.type === "text") {
    const preferredEvent = preferred.event as Extract<AgentChatEvent, { type: "text" }>;
    return {
      ...preferred,
      timestamp: pickLaterTimestamp(existing.timestamp, incoming.timestamp),
      provenance,
      event: {
        ...preferredEvent,
        turnId: incoming.event.turnId ?? existing.event.turnId,
        itemId: incoming.event.itemId ?? existing.event.itemId,
        text: mergeInlineText(existing.event.text, incoming.event.text),
      },
    };
  }

  if (existing.event.type === "reasoning" && incoming.event.type === "reasoning") {
    const preferredEvent = preferred.event as Extract<AgentChatEvent, { type: "reasoning" }>;
    return {
      ...preferred,
      timestamp: pickLaterTimestamp(existing.timestamp, incoming.timestamp),
      provenance,
      event: {
        ...preferredEvent,
        turnId: incoming.event.turnId ?? existing.event.turnId,
        itemId: incoming.event.itemId ?? existing.event.itemId,
        summaryIndex: incoming.event.summaryIndex ?? existing.event.summaryIndex,
        text: mergeInlineText(existing.event.text, incoming.event.text),
      },
    };
  }

  if (existing.event.type === "command" && incoming.event.type === "command") {
    const preferredEvent = preferred.event as Extract<AgentChatEvent, { type: "command" }>;
    return {
      ...preferred,
      timestamp: pickLaterTimestamp(existing.timestamp, incoming.timestamp),
      provenance,
      event: {
        ...preferredEvent,
        output: mergeInlineText(existing.event.output, incoming.event.output),
        exitCode: incoming.event.exitCode ?? existing.event.exitCode,
        durationMs: incoming.event.durationMs ?? existing.event.durationMs,
        status: incoming.event.status ?? existing.event.status,
      },
    };
  }

  if (existing.event.type === "file_change" && incoming.event.type === "file_change") {
    const preferredEvent = preferred.event as Extract<AgentChatEvent, { type: "file_change" }>;
    return {
      ...preferred,
      timestamp: pickLaterTimestamp(existing.timestamp, incoming.timestamp),
      provenance,
      event: {
        ...preferredEvent,
        diff: mergeInlineText(existing.event.diff, incoming.event.diff),
        status: incoming.event.status ?? existing.event.status,
      },
    };
  }

  if (existing.event.type === "tool_result" && incoming.event.type === "tool_result") {
    const preferredEvent = preferred.event as Extract<AgentChatEvent, { type: "tool_result" }>;
    return {
      ...preferred,
      timestamp: pickLaterTimestamp(existing.timestamp, incoming.timestamp),
      provenance,
      event: {
        ...preferredEvent,
        result: eventHasPayload(incoming.event.result) ? incoming.event.result : existing.event.result,
        status: incoming.event.status ?? existing.event.status,
      },
    };
  }

  return {
    ...preferred,
    timestamp: pickLaterTimestamp(existing.timestamp, incoming.timestamp),
    provenance,
  };
}

export function buildMissionThreadEventMergeKey(envelope: AgentChatEventEnvelope): string {
  const event = envelope.event;
  const baseParts = [envelope.sessionId, event.type];
  const turnId = "turnId" in event && typeof event.turnId === "string" && event.turnId.trim().length > 0
    ? event.turnId
    : null;
  const itemId = "itemId" in event && typeof event.itemId === "string" && event.itemId.trim().length > 0
    ? event.itemId
    : null;
  const messageId = typeof envelope.provenance?.messageId === "string" && envelope.provenance.messageId.trim().length > 0
    ? envelope.provenance.messageId
    : null;

  switch (event.type) {
    case "text":
    case "reasoning":
      if (turnId) return [...baseParts, "turn", turnId].join("::");
      if (itemId) return [...baseParts, "item", itemId].join("::");
      if (messageId) return [...baseParts, "message", messageId].join("::");
      return [...baseParts, normalizeInlineText(event.text)].join("::");
    case "tool_call":
    case "tool_result":
      return [...baseParts, turnId ?? "turn", event.tool, itemId ?? "item"].join("::");
    case "command":
      return [...baseParts, turnId ?? "turn", itemId ?? "item", event.command, event.cwd].join("::");
    case "file_change":
      return [...baseParts, turnId ?? "turn", itemId ?? "item", event.path].join("::");
    case "plan":
      return [...baseParts, turnId ?? "turn"].join("::");
    case "approval_request":
      return [...baseParts, turnId ?? "turn", itemId ?? "item"].join("::");
    case "status":
      return [...baseParts, turnId ?? "turn", event.turnStatus, normalizeInlineText(event.message ?? "")].join("::");
    case "delegation_state":
      return [
        ...baseParts,
        turnId ?? "turn",
        event.contract.contractId,
        event.contract.status,
        normalizeInlineText(event.message ?? ""),
      ].join("::");
    case "activity":
      return [...baseParts, turnId ?? "turn", event.activity, normalizeInlineText(event.detail ?? "")].join("::");
    case "error":
      if (itemId) return [...baseParts, turnId ?? "turn", itemId].join("::");
      return [...baseParts, turnId ?? "turn", normalizeInlineText(event.message)].join("::");
    case "done":
      return [...baseParts, event.turnId, event.status].join("::");
    case "step_boundary":
      return [...baseParts, turnId ?? "turn", String(event.stepNumber)].join("::");
    case "user_message":
      if (turnId) return [...baseParts, "turn", turnId].join("::");
      if (messageId) return [...baseParts, "message", messageId].join("::");
      return [...baseParts, normalizeInlineText(event.text)].join("::");
    default:
      return [...baseParts, envelope.timestamp].join("::");
  }
}

function shouldSuppressLowSignalEphemeralEvent(envelope: AgentChatEventEnvelope): boolean {
  if (envelope.provenance?.messageId) return false;
  const event = envelope.event;
  return (event.type === "text" || event.type === "reasoning") && looksLikeLowSignalNoise(event.text);
}

export function mergeMissionThreadEvents(
  fallbackEvents: AgentChatEventEnvelope[],
  sessionEvents: AgentChatEventEnvelope[] | null,
): AgentChatEventEnvelope[] {
  const merged = new Map<string, AgentChatEventEnvelope>();
  for (const event of fallbackEvents) {
    merged.set(buildMissionThreadEventMergeKey(event), event);
  }
  for (const event of sessionEvents ?? []) {
    const key = buildMissionThreadEventMergeKey(event);
    const existing = merged.get(key);
    merged.set(key, existing ? mergeDuplicateEnvelope(existing, event) : event);
  }
  return [...merged.values()].filter((entry) => !shouldSuppressLowSignalEphemeralEvent(entry)).sort((left, right) => {
    const delta = Date.parse(left.timestamp) - Date.parse(right.timestamp);
    return Number.isFinite(delta) && delta !== 0
      ? delta
      : buildMissionThreadEventMergeKey(left).localeCompare(buildMissionThreadEventMergeKey(right));
  });
}

function filterLowSignalStructuredEvents(events: AgentChatEventEnvelope[]): AgentChatEventEnvelope[] {
  const filtered = events.filter((envelope) => {
    const event = envelope.event;
    if ((event.type === "text" || event.type === "reasoning") && looksLikeLowSignalNoise(event.text)) {
      return false;
    }
    if (event.type === "activity") {
      const detail = normalizeInlineText(event.detail ?? "");
      if (!detail.length) return false;
      if (event.activity === "thinking" && looksLikeLowSignalNoise(detail)) return false;
    }
    return true;
  });

  return filtered.filter((envelope, index, entries) => {
    if (envelope.event.type !== "activity") return true;
    const previous = entries[index - 1];
    if (!previous || previous.event.type !== "activity") return true;
    return previous.event.activity !== envelope.event.activity
      || normalizeInlineText(previous.event.detail ?? "") !== normalizeInlineText(envelope.event.detail ?? "");
  });
}

export const MissionThreadMessageList = React.memo(function MissionThreadMessageList({
  messages,
  sessionId = null,
  showStreamingIndicator = false,
  transcriptPollingEnabled = true,
  className,
  onApproval,
}: MissionThreadMessageListProps) {
  const [sessionEvents, setSessionEvents] = useState<AgentChatEventEnvelope[] | null>(null);
  const fallbackEvents = useMemo(() => adaptMissionThreadMessagesToAgentEvents(messages), [messages]);
  const lastTranscriptRawRef = React.useRef<string | null>(null);

  useEffect(() => {
    setSessionEvents(null);
    lastTranscriptRawRef.current = null;
  }, [sessionId]);

  const refreshSessionTranscript = useCallback(() => {
    if (!sessionId) {
      setSessionEvents(null);
      lastTranscriptRawRef.current = null;
      return;
    }
    window.ade.sessions.readTranscriptTail({
      sessionId,
      maxBytes: 320_000,
      raw: true,
    }).then(
      (raw) => {
        if (raw === lastTranscriptRawRef.current) return;
        lastTranscriptRawRef.current = raw;
        const parsed = parseAgentChatTranscript(raw).filter((entry) => entry.sessionId === sessionId);
        setSessionEvents(parsed);
      },
      () => setSessionEvents([]),
    );
  }, [sessionId]);

  useEffect(() => {
    refreshSessionTranscript();
  }, [refreshSessionTranscript]);

  useMissionPolling(refreshSessionTranscript, 4_000, Boolean(sessionId && transcriptPollingEnabled));

  const events = useMemo(() => {
    return filterLowSignalStructuredEvents(mergeMissionThreadEvents(fallbackEvents, sessionEvents));
  }, [fallbackEvents, sessionEvents]);
  const subagentSnapshots = useMemo(() => deriveChatSubagentSnapshots(events), [events]);
  const pendingApproval = useMemo(() => derivePendingApprovals(events)[0] ?? null, [events]);
  const pendingQuestion = useMemo(() => extractAskUserQuestion(pendingApproval), [pendingApproval]);

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        <AgentChatMessageList
          events={events}
          showStreamingIndicator={showStreamingIndicator}
          className={className}
          surfaceMode={sessionId ? "mission-thread" : "mission-feed"}
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
        {subagentSnapshots.length ? (
          <div className="border-t border-white/[0.05] bg-[#0d0d10]">
            <ChatSubagentStrip
              snapshots={subagentSnapshots}
              placement="read-only"
              className="pb-2"
            />
          </div>
        ) : null}
      </div>
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
