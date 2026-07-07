import fs from "node:fs";
import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatImportProvider,
} from "../../../shared/types";

const DEFAULT_MAX_IMPORTED_EVENTS = 2000;
export const MAX_IMPORT_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

export type ExternalChatHistoryImportOptions = {
  sessionId: string;
  provider: AgentChatImportProvider;
  externalSessionId: string;
  importedAt?: number;
  maxEvents?: number;
  laneId?: string | null;
  transcriptBytesTruncated?: boolean;
  transcriptByteLimit?: number;
};

export type TailLinesReadResult = {
  lines: string[];
  truncated: boolean;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value : null;
}

function timestampFrom(value: unknown, fallbackMs: number): string {
  if (typeof value === "string" && value.trim().length) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
}

export function readTailLines(
  filePath: string,
  maxBytes = MAX_IMPORT_TRANSCRIPT_BYTES,
): TailLinesReadResult {
  const limit = Math.max(1, Math.floor(maxBytes));
  const stat = fs.statSync(filePath);
  if (stat.size <= limit) {
    return { lines: nonEmptyLines(fs.readFileSync(filePath, "utf8")), truncated: false };
  }

  const offset = stat.size - limit;
  const buffer = Buffer.allocUnsafe(limit);
  const fd = fs.openSync(filePath, "r");
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, limit, offset);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u);
    lines.shift();
    return { lines: lines.filter((line) => line.trim().length > 0), truncated: true };
  } finally {
    fs.closeSync(fd);
  }
}

export function shortExternalSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (trimmed.length <= 12) return trimmed;
  return trimmed.slice(0, 8);
}

function parseJsonObject(line: string): JsonRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function maybeParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function contentBlockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (!isRecord(block)) return "";
  const type = stringOrNull(block.type)?.toLowerCase() ?? "";
  if (type === "text" || type === "output_text" || type === "input_text") {
    return stringOrNull(block.text) ?? "";
  }
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) return contentToText(block.content);
  if (type === "image" || type === "input_image") return "[Image attachment]";
  if (type === "document" || type === "input_file") return "[File attachment]";
  return "";
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(contentBlockText)
      .filter((part) => part.trim().length > 0)
      .join("\n")
      .trim();
  }
  if (isRecord(content)) {
    return contentBlockText(content);
  }
  return "";
}

function stringifyResult(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = contentToText(value);
    return text || value;
  }
  return value ?? "";
}

function importedRoleForEvent(event: AgentChatEvent): NonNullable<AgentChatEventEnvelope["provenance"]>["role"] {
  if (event.type === "user_message") return "user";
  if (event.type === "text") return "agent";
  return null;
}

function makeEnvelope(
  event: AgentChatEvent,
  options: ExternalChatHistoryImportOptions,
  timestamp: string,
  messageId?: string | null,
): AgentChatEventEnvelope {
  return {
    sessionId: options.sessionId,
    timestamp,
    event,
    provenance: {
      ...(messageId ? { messageId } : {}),
      role: importedRoleForEvent(event),
      targetKind: "external_import",
      sourceSessionId: options.externalSessionId,
      laneId: options.laneId ?? null,
    },
  };
}

function systemNoticeEnvelope(
  message: string,
  options: ExternalChatHistoryImportOptions,
  timestamp: string,
): AgentChatEventEnvelope {
  return makeEnvelope({
    type: "system_notice",
    noticeKind: "info",
    severity: "info",
    message,
  }, options, timestamp);
}

function byteLimitLabel(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`;
  return `${bytes} bytes`;
}

function finalizeImportEvents(
  envelopes: AgentChatEventEnvelope[],
  options: ExternalChatHistoryImportOptions,
): AgentChatEventEnvelope[] {
  const importedAt = options.importedAt ?? Date.now();
  let noticeOffset = 0;
  const noticeTimestamp = () => new Date(importedAt + noticeOffset++).toISOString();
  const maxContentEvents = Math.max(1, Math.floor(options.maxEvents ?? DEFAULT_MAX_IMPORTED_EVENTS));
  const omitted = Math.max(0, envelopes.length - maxContentEvents);
  const contentEvents = omitted > 0 ? envelopes.slice(-maxContentEvents) : envelopes;
  const notices = [
    systemNoticeEnvelope(
      `Session imported from ${options.provider} CLI (${shortExternalSessionId(options.externalSessionId)})`,
      options,
      noticeTimestamp(),
    ),
  ];
  if (options.transcriptBytesTruncated) {
    notices.push(systemNoticeEnvelope(
      `Imported: earlier transcript bytes truncated to the last ${byteLimitLabel(options.transcriptByteLimit ?? MAX_IMPORT_TRANSCRIPT_BYTES)}`,
      options,
      noticeTimestamp(),
    ));
  }
  if (omitted > 0) {
    notices.push(systemNoticeEnvelope(
      `Imported: ${omitted} earlier messages truncated`,
      options,
      noticeTimestamp(),
    ));
  }
  return [
    ...notices,
    ...contentEvents,
  ];
}

function sourceRecordTimestamp(record: JsonRecord, fallbackMs: number): string {
  const message = isRecord(record.message) ? record.message : null;
  return timestampFrom(
    record.timestamp ?? record.createdAt ?? record.created_at ?? message?.timestamp,
    fallbackMs,
  );
}

function sourceRecordId(record: JsonRecord, fallback: string): string {
  return stringOrNull(record.uuid)
    ?? stringOrNull(record.id)
    ?? stringOrNull(record.messageId)
    ?? stringOrNull(record.message_id)
    ?? fallback;
}

function claudeToolResultEvent(block: JsonRecord, fallbackItemId: string): Extract<AgentChatEvent, { type: "tool_result" }> {
  const itemId = stringOrNull(block.tool_use_id)
    ?? stringOrNull(block.id)
    ?? fallbackItemId;
  return {
    type: "tool_result",
    tool: stringOrNull(block.name) ?? "tool",
    result: stringifyResult(block.content ?? block.result ?? block.output ?? ""),
    itemId,
    status: "completed",
  };
}

function claudeToolCallEvent(block: JsonRecord, fallbackItemId: string): Extract<AgentChatEvent, { type: "tool_call" }> {
  const itemId = stringOrNull(block.id) ?? fallbackItemId;
  return {
    type: "tool_call",
    tool: stringOrNull(block.name) ?? stringOrNull(block.tool) ?? "tool",
    args: block.input ?? block.arguments ?? {},
    itemId,
  };
}

function claudeRecordToEvents(
  record: JsonRecord,
  options: ExternalChatHistoryImportOptions,
  index: number,
): AgentChatEventEnvelope[] {
  const message = isRecord(record.message) ? record.message : record;
  const role = stringOrNull(message.role) ?? stringOrNull(record.type) ?? "";
  const sourceId = sourceRecordId(record, `claude-import:${index}`);
  const timestamp = sourceRecordTimestamp(record, (options.importedAt ?? Date.now()) + index);
  const content = message.content ?? record.content;
  const blocks = Array.isArray(content) ? content : [content];
  const out: AgentChatEventEnvelope[] = [];

  if (role === "user") {
    const textParts: string[] = [];
    blocks.forEach((block, blockIndex) => {
      if (isRecord(block) && stringOrNull(block.type) === "tool_result") {
        const itemId = `${sourceId}:tool-result:${blockIndex}`;
        out.push(makeEnvelope(claudeToolResultEvent(block, itemId), options, timestamp, itemId));
        return;
      }
      const text = contentBlockText(block);
      if (text.trim().length) textParts.push(text);
    });
    const text = textParts.join("\n").trim();
    if (text.length) {
      out.unshift(makeEnvelope({ type: "user_message", text, messageId: sourceId }, options, timestamp, sourceId));
    }
    return out;
  }

  if (role === "assistant") {
    blocks.forEach((block, blockIndex) => {
      if (isRecord(block)) {
        const type = stringOrNull(block.type);
        if (type === "thinking" || type === "redacted_thinking") return;
        const itemId = stringOrNull(block.id) ?? `${sourceId}:block:${blockIndex}`;
        if (type === "tool_use" || type === "server_tool_use") {
          out.push(makeEnvelope(claudeToolCallEvent(block, itemId), options, timestamp, itemId));
          return;
        }
        if (type === "tool_result") {
          out.push(makeEnvelope(claudeToolResultEvent(block, itemId), options, timestamp, itemId));
          return;
        }
      }
      const text = contentBlockText(block);
      if (text.trim().length) {
        out.push(makeEnvelope({ type: "text", text, itemId: `${sourceId}:text:${blockIndex}` }, options, timestamp, sourceId));
      }
    });
  }

  return out;
}

export function claudeJsonlToChatEvents(
  lines: readonly string[],
  options: ExternalChatHistoryImportOptions,
): AgentChatEventEnvelope[] {
  const envelopes: AgentChatEventEnvelope[] = [];
  lines.forEach((line, index) => {
    const record = parseJsonObject(line);
    if (!record) return;
    envelopes.push(...claudeRecordToEvents(record, options, index));
  });
  return finalizeImportEvents(envelopes, options);
}

function mapStatus(value: unknown): "running" | "completed" | "failed" {
  const status = typeof value === "string" ? value.toLowerCase() : "";
  if (status === "running" || status === "in_progress" || status === "inprogress") return "running";
  if (status === "failed" || status === "error") return "failed";
  return "completed";
}

function mapFileChangeKind(value: unknown): "create" | "modify" | "delete" {
  const raw = isRecord(value) ? value.type : value;
  const kind = typeof raw === "string" ? raw.toLowerCase() : "";
  if (kind === "create" || kind === "add" || kind === "added") return "create";
  if (kind === "delete" || kind === "remove" || kind === "removed") return "delete";
  return "modify";
}

function codexItemId(item: JsonRecord, fallback: string): string {
  return stringOrNull(item.id)
    ?? stringOrNull(item.itemId)
    ?? stringOrNull(item.item_id)
    ?? stringOrNull(item.call_id)
    ?? fallback;
}

function codexTurnId(turn: JsonRecord, fallback: string): string {
  return stringOrNull(turn.id)
    ?? stringOrNull(turn.turnId)
    ?? stringOrNull(turn.turn_id)
    ?? fallback;
}

function codexMessageRole(item: JsonRecord): string | null {
  return stringOrNull(item.role)
    ?? (stringOrNull(item.type) === "user_message" ? "user" : null)
    ?? (stringOrNull(item.type) === "agent_message" ? "assistant" : null);
}

function codexMessageText(item: JsonRecord): string {
  return contentToText(item.text ?? item.content ?? item.message ?? item.output ?? item.delta);
}

function codexThreadItemToEvents(
  item: JsonRecord,
  turn: JsonRecord,
  options: ExternalChatHistoryImportOptions,
  turnIndex: number,
  itemIndex: number,
): AgentChatEventEnvelope[] {
  const turnId = codexTurnId(turn, `codex-turn:${turnIndex}`);
  const itemId = codexItemId(item, `codex-item:${turnIndex}:${itemIndex}`);
  const itemType = stringOrNull(item.type) ?? "";
  const timestamp = timestampFrom(
    item.timestamp ?? item.createdAt ?? item.created_at ?? turn.startedAt ?? turn.createdAt ?? turn.created_at,
    (options.importedAt ?? Date.now()) + turnIndex + itemIndex,
  );
  const base = (event: AgentChatEvent, messageId: string = itemId): AgentChatEventEnvelope =>
    makeEnvelope(event, options, timestamp, messageId);

  switch (itemType) {
    case "agentMessage":
    case "agent_message": {
      const text = codexMessageText(item);
      return text.trim().length ? [base({ type: "text", text, itemId, turnId })] : [];
    }
    case "userMessage":
    case "user_message": {
      const text = codexMessageText(item);
      return text.trim().length ? [base({ type: "user_message", text, messageId: itemId, turnId })] : [];
    }
    case "message": {
      const role = codexMessageRole(item);
      const text = codexMessageText(item);
      if (!text.trim().length) return [];
      if (role === "user") return [base({ type: "user_message", text, messageId: itemId, turnId })];
      if (role === "assistant") return [base({ type: "text", text, itemId, turnId })];
      return [];
    }
    case "reasoning":
    case "agent_reasoning": {
      const text = [
        contentToText(item.summary),
        contentToText(item.content),
        contentToText(item.text),
      ].filter((part) => part.trim().length > 0).join("\n").trim();
      return text ? [base({ type: "reasoning", text, itemId, turnId })] : [];
    }
    case "plan": {
      const text = codexMessageText(item);
      return text.trim().length
        ? [base({ type: "plan", steps: [], explanation: text, streamingText: text, state: "complete", itemId, turnId })]
        : [];
    }
    case "commandExecution":
    case "command_execution": {
      const command = stringOrNull(item.command) ?? stringOrNull(item.cmd) ?? "command";
      const output = contentToText(item.aggregatedOutput ?? item.output ?? item.stdout ?? item.stderr);
      const cwd = stringOrNull(item.cwd) ?? "";
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : typeof item.exit_code === "number" ? item.exit_code : null;
      const durationMs = typeof item.durationMs === "number" ? item.durationMs : typeof item.duration_ms === "number" ? item.duration_ms : null;
      return [base({
        type: "command",
        command,
        cwd,
        output,
        itemId,
        turnId,
        status: mapStatus(item.status),
        ...(exitCode !== null ? { exitCode } : {}),
        ...(durationMs !== null ? { durationMs } : {}),
      })];
    }
    case "fileChange":
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : [item];
      return changes
        .map((change, changeIndex): AgentChatEventEnvelope | null => {
          if (!isRecord(change)) return null;
          const path = stringOrNull(change.path);
          if (!path) return null;
          return base({
            type: "file_change",
            path,
            diff: stringOrNull(change.unifiedDiff) ?? stringOrNull(change.diff) ?? "",
            kind: mapFileChangeKind(change.kind ?? change.type),
            itemId: changeIndex === 0 ? itemId : `${itemId}:${changeIndex}`,
            turnId,
            status: mapStatus(item.status),
          }, changeIndex === 0 ? itemId : `${itemId}:${changeIndex}`);
        })
        .filter((event): event is AgentChatEventEnvelope => event !== null);
    }
    case "webSearch":
    case "web_search": {
      const query = stringOrNull(item.query) ?? stringOrNull(item.input) ?? "";
      if (!query) return [];
      const action = isRecord(item.action) ? stringOrNull(item.action.kind) : stringOrNull(item.action);
      return [base({ type: "web_search", query, itemId, turnId, status: mapStatus(item.status), ...(action ? { action } : {}) })];
    }
    case "imageGeneration":
    case "image_generation": {
      return [base({
        type: "codex_image_generation",
        itemId,
        turnId,
        status: mapStatus(item.status),
        prompt: stringOrNull(item.prompt),
        revisedPrompt: stringOrNull(item.revisedPrompt) ?? stringOrNull(item.revised_prompt),
        result: stringOrNull(item.result),
        savedPath: stringOrNull(item.savedPath) ?? stringOrNull(item.saved_path),
      })];
    }
    case "imageView":
    case "image_view": {
      return [base({
        type: "codex_image_view",
        itemId,
        turnId,
        status: mapStatus(item.status),
        path: stringOrNull(item.path),
        url: stringOrNull(item.url),
        title: stringOrNull(item.title),
      })];
    }
    case "mcpToolCall":
    case "dynamicToolCall":
    case "tool_call":
    case "function_call": {
      const toolName = stringOrNull(item.tool) ?? stringOrNull(item.name) ?? itemType;
      const server = stringOrNull(item.server);
      const tool = server ? `${server}:${toolName}` : toolName;
      const args = typeof item.arguments === "string" ? maybeParseJson(item.arguments) : item.arguments ?? item.input ?? {};
      return [base({ type: "tool_call", tool, args, itemId, turnId })];
    }
    case "tool_result":
    case "function_call_output": {
      return [base({
        type: "tool_result",
        tool: stringOrNull(item.tool) ?? stringOrNull(item.name) ?? "tool",
        result: stringifyResult(item.output ?? item.result ?? item.content ?? ""),
        itemId,
        turnId,
        status: mapStatus(item.status),
      })];
    }
    default:
      return [];
  }
}

function codexTurnFallbackEvents(
  turn: JsonRecord,
  options: ExternalChatHistoryImportOptions,
  turnIndex: number,
): AgentChatEventEnvelope[] {
  const turnId = codexTurnId(turn, `codex-turn:${turnIndex}`);
  const timestamp = timestampFrom(turn.startedAt ?? turn.createdAt ?? turn.created_at, (options.importedAt ?? Date.now()) + turnIndex);
  const out: AgentChatEventEnvelope[] = [];
  const userText = contentToText(turn.input ?? turn.userInput ?? turn.prompt);
  if (userText.trim().length) {
    out.push(makeEnvelope({ type: "user_message", text: userText, messageId: `${turnId}:user`, turnId }, options, timestamp, `${turnId}:user`));
  }
  const assistantText = contentToText(turn.output ?? turn.response ?? turn.assistantMessage ?? turn.assistant_message);
  if (assistantText.trim().length) {
    out.push(makeEnvelope({ type: "text", text: assistantText, itemId: `${turnId}:assistant`, turnId }, options, timestamp, `${turnId}:assistant`));
  }
  return out;
}

export function codexTurnsToChatEvents(
  turns: readonly unknown[],
  options: ExternalChatHistoryImportOptions,
): AgentChatEventEnvelope[] {
  const envelopes: AgentChatEventEnvelope[] = [];
  turns.forEach((turn, turnIndex) => {
    if (!isRecord(turn)) return;
    const items = Array.isArray(turn.items)
      ? turn.items
      : Array.isArray(turn.events)
        ? turn.events
        : Array.isArray(turn.messages)
          ? turn.messages
          : [];
    if (items.length > 0) {
      items.forEach((item, itemIndex) => {
        if (!isRecord(item)) return;
        envelopes.push(...codexThreadItemToEvents(item, turn, options, turnIndex, itemIndex));
      });
      return;
    }
    envelopes.push(...codexTurnFallbackEvents(turn, options, turnIndex));
  });
  return finalizeImportEvents(envelopes, options);
}

export function deriveImportedChatTitle(
  envelopes: readonly AgentChatEventEnvelope[],
  provider: AgentChatImportProvider,
): string {
  const firstUser = envelopes.find((envelope) => envelope.event.type === "user_message");
  const firstAssistant = envelopes.find((envelope) => envelope.event.type === "text");
  const text = firstUser?.event.type === "user_message"
    ? firstUser.event.text
    : firstAssistant?.event.type === "text"
      ? firstAssistant.event.text
      : "";
  const normalized = normalizeWhitespace(text);
  if (normalized.length) {
    return normalized.length <= 72 ? normalized : `${normalized.slice(0, 71).trimEnd()}...`;
  }
  return provider === "claude" ? "Imported Claude chat" : "Imported Codex chat";
}
