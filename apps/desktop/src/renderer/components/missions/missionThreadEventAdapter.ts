import type { AgentChatEvent, AgentChatEventEnvelope, ModelId, OrchestratorChatMessage } from "../../../shared/types";

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function normalizeTurnStatus(value: string | null): Extract<AgentChatEvent, { type: "status" }>["turnStatus"] {
  switch (value) {
    case "completed":
    case "interrupted":
    case "failed":
      return value;
    default:
      return "started";
  }
}

function normalizeDoneStatus(value: string | null): Extract<AgentChatEvent, { type: "done" }>["status"] {
  switch (value) {
    case "interrupted":
    case "failed":
      return value;
    default:
      return "completed";
  }
}

function normalizeToolStatus(value: string | null): Extract<AgentChatEvent, { type: "tool_result" }>["status"] {
  switch (value) {
    case "completed":
    case "failed":
      return value;
    default:
      return "running";
  }
}

function resolveSessionId(message: OrchestratorChatMessage, structuredStream: Record<string, unknown> | null): string {
  return (
    readString(structuredStream?.sessionId)
    ?? readString(message.sourceSessionId)
    ?? readString(message.threadId)
    ?? readString(message.attemptId)
    ?? readString(message.runId)
    ?? `mission-thread:${message.id}`
  );
}

function resolveItemId(message: OrchestratorChatMessage, structuredStream: Record<string, unknown> | null, suffix: string): string {
  return readString(structuredStream?.itemId) ?? `${message.id}:${suffix}`;
}

function resolveTurnId(message: OrchestratorChatMessage, structuredStream: Record<string, unknown> | null, sessionId: string): string | undefined {
  return readString(structuredStream?.turnId) ?? (message.role === "user" ? `${sessionId}:user:${message.id}` : undefined);
}

function resolveErrorInfo(value: unknown): Extract<AgentChatEvent, { type: "error" }>["errorInfo"] | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  const record = readRecord(value);
  const category = readString(record?.category);
  if (!record || !category) return undefined;
  if (!["auth", "rate_limit", "budget", "network", "unknown"].includes(category)) return undefined;
  return {
    category: category as "auth" | "rate_limit" | "budget" | "network" | "unknown",
    provider: readString(record.provider) ?? undefined,
    model: readString(record.model) ?? undefined,
  };
}

function toToolEvents(
  message: OrchestratorChatMessage,
  structuredStream: Record<string, unknown>,
  sessionId: string,
  turnId: string | undefined,
): AgentChatEventEnvelope[] {
  const tool = readString(structuredStream.tool) ?? "tool";
  const itemId = resolveItemId(message, structuredStream, "tool");
  const envelopes: AgentChatEventEnvelope[] = [];

  if (hasOwn(structuredStream, "args")) {
    envelopes.push({
      sessionId,
      timestamp: message.timestamp,
      event: {
        type: "tool_call",
        tool,
        args: structuredStream.args,
        itemId,
        turnId,
      },
    });
  }

  if (hasOwn(structuredStream, "result")) {
    envelopes.push({
      sessionId,
      timestamp: message.timestamp,
      event: {
        type: "tool_result",
        tool,
        result: structuredStream.result,
        itemId,
        turnId,
        status: normalizeToolStatus(readString(structuredStream.status)),
      },
    });
  } else if (!hasOwn(structuredStream, "args")) {
    envelopes.push({
      sessionId,
      timestamp: message.timestamp,
      event: {
        type: "tool_call",
        tool,
        args: {},
        itemId,
        turnId,
      },
    });
  }

  return envelopes;
}

function toStructuredEvents(message: OrchestratorChatMessage): AgentChatEventEnvelope[] | null {
  const metadata = readRecord(message.metadata);
  const structuredStream = readRecord(metadata?.structuredStream);
  const kind = readString(structuredStream?.kind);
  if (!structuredStream || !kind) return null;

  const sessionId = resolveSessionId(message, structuredStream);
  const turnId = resolveTurnId(message, structuredStream, sessionId);

  switch (kind) {
    case "text":
      return [{
        sessionId,
        timestamp: message.timestamp,
        event: {
          type: "text",
          text: message.content,
          turnId,
          itemId: resolveItemId(message, structuredStream, "text"),
        },
      }];
    case "reasoning":
      return [{
        sessionId,
        timestamp: message.timestamp,
        event: {
          type: "reasoning",
          text: message.content,
          turnId,
          itemId: resolveItemId(message, structuredStream, "reasoning"),
          summaryIndex: typeof structuredStream.summaryIndex === "number" ? structuredStream.summaryIndex : undefined,
        },
      }];
    case "tool":
      return toToolEvents(message, structuredStream, sessionId, turnId);
    case "status":
      return [{
        sessionId,
        timestamp: message.timestamp,
        event: {
          type: "status",
          turnStatus: normalizeTurnStatus(readString(structuredStream.status)),
          turnId,
          message: readString(structuredStream.message) ?? undefined,
        },
      }];
    case "done":
      return [{
        sessionId,
        timestamp: message.timestamp,
        event: {
          type: "done",
          turnId: turnId ?? `${sessionId}:done:${message.id}`,
          status: normalizeDoneStatus(readString(structuredStream.status)),
          model: readString(structuredStream.model) ?? undefined,
          modelId: (readString(structuredStream.modelId) ?? undefined) as ModelId | undefined,
          usage: (() => {
            const usageRecord = readRecord(structuredStream.usage);
            if (!usageRecord) return undefined;
            return {
              inputTokens: typeof usageRecord.inputTokens === "number" ? usageRecord.inputTokens : null,
              outputTokens: typeof usageRecord.outputTokens === "number" ? usageRecord.outputTokens : null,
            };
          })(),
        },
      }];
    case "error":
      return [{
        sessionId,
        timestamp: message.timestamp,
        event: {
          type: "error",
          message: readString(structuredStream.message) ?? message.content,
          turnId,
          itemId: resolveItemId(message, structuredStream, "error"),
          errorInfo: resolveErrorInfo(structuredStream.errorInfo),
        },
      }];
    default:
      return null;
  }
}

function toFallbackEvent(message: OrchestratorChatMessage): AgentChatEventEnvelope | null {
  const sessionId = resolveSessionId(message, null);
  if (message.role === "user") {
    return {
      sessionId,
      timestamp: message.timestamp,
      event: {
        type: "user_message",
        text: message.content,
        turnId: `${sessionId}:user:${message.id}`,
      },
    };
  }

  if (!message.content.trim().length) return null;

  return {
    sessionId,
    timestamp: message.timestamp,
    event: {
      type: "text",
      text: message.content,
      itemId: `${message.id}:text`,
    },
  };
}

export function adaptMissionThreadMessagesToAgentEvents(messages: OrchestratorChatMessage[]): AgentChatEventEnvelope[] {
  const sortedMessages = [...messages]
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const delta = Date.parse(a.message.timestamp) - Date.parse(b.message.timestamp);
      return Number.isFinite(delta) && delta !== 0 ? delta : a.index - b.index;
    });

  const events: AgentChatEventEnvelope[] = [];
  for (const { message } of sortedMessages) {
    const structuredEvents = toStructuredEvents(message);
    if (structuredEvents?.length) {
      events.push(...structuredEvents);
      continue;
    }
    const fallbackEvent = toFallbackEvent(message);
    if (fallbackEvent) events.push(fallbackEvent);
  }

  return events;
}
