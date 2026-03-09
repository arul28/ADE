import type { AgentChatEvent, AgentChatEventEnvelope, ModelId, OrchestratorChatMessage } from "../../../shared/types";

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function looksLikeLowSignalNoise(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.length) return true;
  if (/^streaming(?:\.\.\.)?$/i.test(trimmed)) return true;
  if (/^usage$/i.test(trimmed)) return true;
  if (/^mcp:/i.test(trimmed)) return true;
  if (/^[\-dlcbps][rwx\-@+]{8,}/i.test(trimmed)) return true;
  if (/^[A-Z0-9 .:_()/-]{24,}$/.test(trimmed)) return true;
  // Single-token strings under 24 chars that look like identifiers or noise
  // tokens rather than prose. Allow strings with sentence-ending punctuation
  // (e.g. "Done.", "Error!") since those are genuine assistant responses.
  if (!/\s/.test(trimmed) && trimmed.length < 24 && !/[.!?]/.test(trimmed)) return true;
  if (/^[A-Za-z]+$/.test(trimmed) && trimmed.length < 24) return true;
  return false;
}

function shouldPromoteAssistantText(text: string): boolean {
  return !looksLikeLowSignalNoise(text);
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

function normalizeApprovalKind(value: string | null): "command" | "file_change" | "tool_call" {
  switch (value) {
    case "command":
    case "file_change":
    case "tool_call":
      return value;
    default:
      return "tool_call";
  }
}

function normalizeCommandStatus(value: string | null): "running" | "completed" | "failed" {
  switch (value) {
    case "completed":
    case "failed":
      return value;
    default:
      return "running";
  }
}

function normalizeFileChangeKind(value: string | null): "create" | "modify" | "delete" {
  switch (value) {
    case "create":
    case "delete":
      return value;
    default:
      return "modify";
  }
}

function normalizePlanStepStatus(value: unknown): "pending" | "in_progress" | "completed" | "failed" {
  const status = typeof value === "string" ? value : "";
  switch (status) {
    case "completed":
    case "in_progress":
    case "failed":
      return status;
    default:
      return "pending";
  }
}

function normalizeActivity(value: string | null): "thinking" | "editing_file" | "running_command" | "searching" | "reading" | "tool_calling" {
  switch (value) {
    case "editing_file":
    case "running_command":
    case "searching":
    case "reading":
    case "tool_calling":
      return value;
    default:
      return "thinking";
  }
}

type UserAttachment = NonNullable<Extract<AgentChatEvent, { type: "user_message" }>["attachments"]>[number];

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
      if (!shouldPromoteAssistantText(message.content)) return null;
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
      if (!shouldPromoteAssistantText(message.content)) return null;
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
    case "command":
      return [{
        sessionId,
        timestamp: message.timestamp,
        event: {
          type: "command",
          command: readString(structuredStream.command) ?? "command",
          cwd: readString(structuredStream.cwd) ?? "",
          output: typeof structuredStream.output === "string" ? structuredStream.output : "",
          itemId: resolveItemId(message, structuredStream, "command"),
          turnId,
          exitCode: typeof structuredStream.exitCode === "number" ? structuredStream.exitCode : null,
          durationMs: typeof structuredStream.durationMs === "number" ? structuredStream.durationMs : null,
          status: normalizeCommandStatus(readString(structuredStream.status)),
        },
      }];
    case "file_change":
      return [{
        sessionId,
        timestamp: message.timestamp,
        event: {
          type: "file_change",
          path: readString(structuredStream.path) ?? "(pending file)",
          diff: typeof structuredStream.diff === "string" ? structuredStream.diff : "",
          kind:
            readString(structuredStream.changeKind) === "create" || readString(structuredStream.changeKind) === "delete"
              ? (readString(structuredStream.changeKind) as "create" | "delete")
              : "modify",
          itemId: resolveItemId(message, structuredStream, "file_change"),
          turnId,
          status: normalizeCommandStatus(readString(structuredStream.status)),
        },
      }];
    case "plan": {
      const rawSteps = Array.isArray(structuredStream.steps) ? structuredStream.steps : [];
      return [{
        sessionId,
        timestamp: message.timestamp,
        event: {
          type: "plan",
          turnId,
          explanation: readString(structuredStream.explanation),
          steps: rawSteps
            .map((step) => {
              const record = readRecord(step);
              const text = readString(record?.text);
              if (!text) return null;
              return {
                text,
                status: normalizePlanStepStatus(record?.status),
              };
            })
            .filter((step): step is { text: string; status: "pending" | "in_progress" | "completed" | "failed" } => step != null),
        },
      }];
    }
    case "approval_request":
      return [{
        sessionId,
        timestamp: message.timestamp,
        event: {
          type: "approval_request",
          itemId: resolveItemId(message, structuredStream, "approval"),
          kind: readString(structuredStream.requestKind) === "command" || readString(structuredStream.requestKind) === "file_change"
            ? (readString(structuredStream.requestKind) as "command" | "file_change")
            : "tool_call",
          description: readString(structuredStream.description) ?? message.content,
          turnId,
          detail: structuredStream.detail,
        },
      }];
    case "activity":
      return [{
        sessionId,
        timestamp: message.timestamp,
        event: {
          type: "activity",
          activity: normalizeActivity(readString(structuredStream.activity)),
          detail: readString(structuredStream.detail) ?? undefined,
          turnId,
        },
      }];
    case "step_boundary":
      return [{
        sessionId,
        timestamp: message.timestamp,
        event: {
          type: "step_boundary",
          stepNumber: typeof structuredStream.stepNumber === "number" ? structuredStream.stepNumber : 1,
          turnId,
        },
      }];
    case "user_message":
      return [{
        sessionId,
        timestamp: message.timestamp,
        event: {
          type: "user_message",
          text: readString(structuredStream.text) ?? message.content,
          turnId,
          attachments: Array.isArray(structuredStream.attachments)
            ? structuredStream.attachments
                .map((entry) => {
                  const record = readRecord(entry);
                  const path = readString(record?.path);
                  const type = readString(record?.type);
                  if (!path || (type !== "file" && type !== "image")) return null;
                  return { path, type };
                })
                .filter((entry): entry is { path: string; type: "file" | "image" } => entry != null)
            : undefined,
        },
      }];
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
  if (!shouldPromoteAssistantText(message.content)) return null;

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
