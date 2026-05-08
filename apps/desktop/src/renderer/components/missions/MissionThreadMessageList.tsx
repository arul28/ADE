import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentChatApprovalDecision, AgentChatEvent, AgentChatEventEnvelope, OrchestratorChatMessage } from "../../../shared/types";
import { parseAgentChatTranscript } from "../../../shared/chatTranscript";
import { AgentChatMessageList } from "../chat/AgentChatMessageList";
import { ChatSubagentsPanel } from "../chat/ChatSubagentsPanel";
import { deriveChatSubagentSnapshots } from "../chat/chatExecutionSummary";
import { eventHasPayload } from "../chat/chatTranscriptRows";
import { isMissionControlToolName, rewriteMissionControlTextToolEvents } from "../chat/missionControlTextTools";
import { derivePendingInputRequests, type DerivedPendingInput } from "../chat/pendingInput";
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
    answers?: Record<string, string | string[]>,
  ) => void;
};

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

function collectFilesChangedFromJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value.trim());
    const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
    const files = Array.isArray(record?.filesChanged)
      ? record.filesChanged
      : Array.isArray(record?.files_changed)
        ? record.files_changed
        : [];
    return files
      .map((entry) => String(entry ?? "").trim())
      .filter((entry, index, entries) => entry.length > 0 && entries.indexOf(entry) === index);
  } catch {
    return [];
  }
}

function cleanMissionThreadText(value: string): string {
  const filesChanged: string[] = [];
  const cleaned = value.replace(
    /(?:\*{0,2}Changed Files\*{0,2}:?\s*)?```(?:json)?\s*([\s\S]*?)```/gi,
    (match, body: string) => {
      const files = collectFilesChangedFromJson(body);
      if (files.length === 0) return match;
      filesChanged.push(...files);
      return "";
    },
  )
    .replace(
      /\s*\*{0,2}\s*Changed\s+Files\s*\*{0,2}:?\s*```(?:json)?[\s\S]*$/i,
      "",
    )
    .replace(
      /\s*\*{0,2}\s*Tests\s+Run\s*\*{0,2}:?\s*```(?:json)?[\s\S]*$/i,
      "",
    )
    .replace(
      /\s*\*{0,2}\s*(?:Risks\s*\/\s*Notes|Risks|Notes)\s*\*{0,2}:?[\s\S]*$/i,
      "",
    )
    .replace(/\s*\*{0,2}Changed Files\*{0,2}:?\s*```(?:json)?\s*$/i, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const uniqueFiles = filesChanged.filter((entry, index, entries) => entries.indexOf(entry) === index);
  if (uniqueFiles.length === 0) return cleaned;
  return [
    cleaned,
    `Changed files:\n- ${uniqueFiles.join("\n- ")}`,
  ].filter(Boolean).join("\n\n");
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
    case "reasoning":
      if (itemId) return [...baseParts, "item", itemId].join("::");
      if (turnId) return [...baseParts, "turn", turnId].join("::");
      if (messageId) return [...baseParts, "message", messageId].join("::");
      return [...baseParts, normalizeInlineText(event.text)].join("::");
    case "text":
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

const INTERNAL_COORDINATOR_DISPLAY_TEXT = new Set([
  "Start mission coordination.",
  "Continue mission coordination.",
]);

function looksLikeInternalCoordinatorPrompt(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("## ADE Mission-Control Tool Transport")
    || trimmed.startsWith("You are ADE's mission lead for a software engineering mission.")
    || trimmed.startsWith("RECOVERED TOOL CALLS EXECUTED");
}

function isCoordinatorSessionId(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().startsWith("coordinator:");
}

function isCoordinatorEnvelope(envelope: AgentChatEventEnvelope): boolean {
  return envelope.provenance?.targetKind === "coordinator"
    || isCoordinatorSessionId(envelope.sessionId)
    || isCoordinatorSessionId(envelope.provenance?.sourceSessionId);
}

function looksLikeCoordinatorReplayMessage(value: string | null | undefined): boolean {
  return typeof value === "string"
    && value.includes("coordinator wrote mission-control calls as text");
}

function looksLikeCleanCodexAppServerExit(value: string | null | undefined): boolean {
  return typeof value === "string"
    && /^Codex app-server exited \(code=0, signal=null\)\.?$/i.test(value.trim());
}

function looksLikeMissionControlTransportText(value: string): boolean {
  const lines = value
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstPayloadLine = lines.find((line) => !line.startsWith("```"));
  const match = /^\/\/\s*([A-Za-z0-9_.:-]+)/.exec(firstPayloadLine ?? "");
  if (!match) return false;
  const label = match[1] ?? "";
  return /^(?:multi_tool_use\.)?parallel$/i.test(label) || isMissionControlToolName(label);
}

function looksLikeGenericTurnStatus(value: string | null | undefined): boolean {
  return typeof value === "string"
    && /^(Turn started|Turn completed)\.?$/i.test(value.trim());
}

function looksLikeInternalValidationControlMessage(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = normalizeInlineText(value);
  return /\bValidation System:\s*Required validation is missing\b/i.test(normalized)
    || /\|\s*next:\s*"[^"]+"\s*—\s*triggering plan adjustment\b/i.test(normalized);
}

function looksLikeDanglingTextFragment(value: string): boolean {
  const trimmed = normalizeInlineText(value);
  if (trimmed.length === 0 || trimmed.length >= 32) return false;
  if (/[.!?:;]$/.test(trimmed)) return false;
  return /\b(?:a|an|and|at|for|from|in|of|or|the|then|to|with)$/i.test(trimmed);
}

function hasMissionVisibleDoneDetails(event: Extract<AgentChatEvent, { type: "done" }>): boolean {
  const usage = event.usage;
  return [
    usage?.inputTokens,
    usage?.outputTokens,
    usage?.cacheReadTokens,
    usage?.cacheCreationTokens,
    event.costUsd,
  ].some((value) => typeof value === "number" && value > 0)
    || event.runtime === "cloud";
}

function shouldSuppressMissionControlToolEvent(envelope: AgentChatEventEnvelope): boolean {
  const event = envelope.event;
  if (event.type !== "tool_call" && event.type !== "tool_result") return false;
  const itemId = typeof event.itemId === "string" ? event.itemId : "";
  if (itemId.startsWith("mission-control-text:")) return true;
  return isMissionControlToolName(event.tool) && isCoordinatorEnvelope(envelope);
}

export function shouldSuppressMissionThreadEvent(envelope: AgentChatEventEnvelope): boolean {
  const event = envelope.event;
  if (shouldSuppressMissionControlToolEvent(envelope)) return true;
  if (event.type === "user_message") {
    const displayText = event.displayText?.trim();
    if (displayText && INTERNAL_COORDINATOR_DISPLAY_TEXT.has(displayText)) return true;
    if (looksLikeInternalCoordinatorPrompt(event.text)) return true;
  }
  if (event.type === "status") {
    if (looksLikeGenericTurnStatus(event.message)) return true;
    if (looksLikeCoordinatorReplayMessage(event.message)) return true;
    if (looksLikeCleanCodexAppServerExit(event.message)) return true;
    if (looksLikeInternalValidationControlMessage(event.message)) return true;
  }
  if (event.type === "error" && looksLikeCleanCodexAppServerExit(event.message)) return true;
  if (event.type === "done" && event.status === "completed" && !hasMissionVisibleDoneDetails(event)) return true;
  if (event.type === "text" || event.type === "reasoning") {
    if (event.text.trim() === "Agent event") return true;
    if (event.type === "text" && looksLikeDanglingTextFragment(event.text)) return true;
    if (looksLikeInternalValidationControlMessage(event.text)) return true;
    if (looksLikeMissionControlTransportText(event.text)) return true;
  }
  return shouldSuppressLowSignalEphemeralEvent(envelope);
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
  return [...merged.values()].filter((entry) => !shouldSuppressMissionThreadEvent(entry)).sort((left, right) => {
    const delta = Date.parse(left.timestamp) - Date.parse(right.timestamp);
    return Number.isFinite(delta) && delta !== 0
      ? delta
      : buildMissionThreadEventMergeKey(left).localeCompare(buildMissionThreadEventMergeKey(right));
  });
}

function filterLowSignalStructuredEvents(events: AgentChatEventEnvelope[]): AgentChatEventEnvelope[] {
  const filtered = events.map((envelope) => {
    const event = envelope.event;
    if (event.type === "text" || event.type === "reasoning") {
      const text = cleanMissionThreadText(event.text);
      if (text !== event.text) {
        return {
          ...envelope,
          event: {
            ...event,
            text,
          },
        };
      }
    }
    return envelope;
  }).filter((envelope) => {
    if (shouldSuppressMissionThreadEvent(envelope)) return false;
    const event = envelope.event;
    if ((event.type === "text" || event.type === "reasoning") && looksLikeLowSignalNoise(event.text)) {
      return false;
    }
    if (event.type === "activity") {
      const detail = normalizeInlineText(event.detail ?? "");
      if (!detail.length) return false;
      if (event.activity === "thinking" && /^thinking through the answer\.?$/i.test(detail)) return false;
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
    if (!sessionId || !transcriptPollingEnabled) {
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
  }, [sessionId, transcriptPollingEnabled]);

  useEffect(() => {
    refreshSessionTranscript();
  }, [refreshSessionTranscript]);

  useMissionPolling(refreshSessionTranscript, 4_000, Boolean(sessionId && transcriptPollingEnabled));

  const events = useMemo(() => {
    return filterLowSignalStructuredEvents(
      rewriteMissionControlTextToolEvents(mergeMissionThreadEvents(fallbackEvents, sessionEvents)),
    );
  }, [fallbackEvents, sessionEvents]);
  const subagentSnapshots = useMemo(() => deriveChatSubagentSnapshots(events), [events]);
  const pendingInput = useMemo<DerivedPendingInput | null>(() => derivePendingInputRequests(events)[0] ?? null, [events]);

  return (
    <>
      <div className="flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden">
        <AgentChatMessageList
          key={sessionId ?? "mission-feed"}
          events={events}
          showStreamingIndicator={showStreamingIndicator}
          className={className}
          surfaceMode={sessionId ? "mission-thread" : "mission-feed"}
          onApproval={onApproval
            ? (itemId, decision, responseText, answers) => {
                const request = pendingInput?.itemId === itemId
                  ? pendingInput
                  : derivePendingInputRequests(events).find((entry) => entry.itemId === itemId) ?? null;
                if (!request) return;
                onApproval(request.sessionId, itemId, decision, responseText, answers);
              }
            : undefined}
        />
        {subagentSnapshots.length ? (
          <ChatSubagentsPanel
            snapshots={subagentSnapshots}
            events={events}
          />
        ) : null}
      </div>
    </>
  );
});
