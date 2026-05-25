import type { AgentChatEvent } from "../../../shared/types";

type SdkRecord = Record<string, unknown>;

export type DroidSdkEventMapperState = {
  assistantDeltaItemIds: Set<string>;
  thinkingDeltaItemIds: Set<string>;
  toolNamesByUseId: Map<string, string>;
  latestUsage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  } | null;
};

export function createDroidSdkEventMapperState(): DroidSdkEventMapperState {
  return {
    assistantDeltaItemIds: new Set(),
    thinkingDeltaItemIds: new Set(),
    toolNamesByUseId: new Map(),
    latestUsage: null,
  };
}

function asRecord(value: unknown): SdkRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as SdkRecord : null;
}

function readString(value: unknown): string | null {
  const text = typeof value === "string" ? value : "";
  return text.length ? text : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function itemIdFor(record: SdkRecord, kind: "text" | "thinking"): string {
  const messageId = readString(record.messageId) ?? `droid-${kind}`;
  const blockIndex = readNumber(record.blockIndex) ?? 0;
  return `${messageId}:${kind}:${blockIndex}`;
}

function summarize(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractCommand(args: unknown): string | null {
  const record = asRecord(args);
  return readString(record?.command)
    ?? readString(record?.fullCommand)
    ?? readString(record?.cmd)
    ?? readString(record?.shellCommand);
}

function extractCwd(args: unknown, fallback: string): string {
  const record = asRecord(args);
  return readString(record?.cwd) ?? readString(record?.workingDirectory) ?? fallback;
}

function toolResultStatus(event: SdkRecord): "completed" | "failed" {
  return event.isError === true ? "failed" : "completed";
}

function extractTextBlocks(content: unknown): Array<{ text: string; kind: "text" | "thinking"; id?: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ text: string; kind: "text" | "thinking"; id?: string }> = [];
  for (const block of content) {
    const record = asRecord(block);
    if (!record) continue;
    const type = readString(record.type);
    const text = readString(record.text);
    if (!text) continue;
    out.push({
      text,
      kind: type === "thinking" ? "thinking" : "text",
      ...(readString(record.id) ? { id: readString(record.id)! } : {}),
    });
  }
  return out;
}

function usageFrom(record: SdkRecord | null): DroidSdkEventMapperState["latestUsage"] {
  if (!record) return null;
  const inputTokens = readNumber(record.inputTokens);
  const outputTokens = readNumber(record.outputTokens);
  const cacheReadTokens = readNumber(record.cacheReadTokens);
  const cacheCreationTokens = readNumber(record.cacheCreationTokens);
  const usage = {
    ...(inputTokens != null ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {}),
    ...(cacheReadTokens != null ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens != null ? { cacheCreationTokens } : {}),
  };
  return Object.keys(usage).length ? usage : null;
}

export function mapDroidSdkMessageToChatEvents(
  message: unknown,
  meta: {
    turnId: string;
    cwd: string;
    state: DroidSdkEventMapperState;
  },
): AgentChatEvent[] {
  const record = asRecord(message);
  if (!record) return [];
  const type = readString(record.type);
  const turnId = meta.turnId;

  switch (type) {
    case "assistant_text_delta": {
      const text = readString(record.text);
      if (!text) return [];
      const itemId = itemIdFor(record, "text");
      meta.state.assistantDeltaItemIds.add(itemId);
      return [{ type: "text", text, itemId, turnId }];
    }
    case "thinking_text_delta": {
      const text = readString(record.text);
      if (!text) return [];
      const itemId = itemIdFor(record, "thinking");
      meta.state.thinkingDeltaItemIds.add(itemId);
      return [{ type: "reasoning", text, itemId, turnId }];
    }
    case "create_message": {
      const role = readString(record.role);
      if (role !== "assistant") return [];
      return extractTextBlocks(record.content).flatMap((block, index): AgentChatEvent[] => {
        const messageId = readString(record.messageId) ?? `droid-${block.kind === "thinking" ? "thinking" : "text"}`;
        const itemId = block.id ?? `${messageId}:${block.kind}:${index}`;
        if (block.kind === "thinking") {
          if (meta.state.thinkingDeltaItemIds.has(itemId)) return [];
          return [{ type: "reasoning", text: block.text, itemId, turnId }];
        }
        if (meta.state.assistantDeltaItemIds.has(itemId)) return [];
        return [{ type: "text", text: block.text, itemId, turnId }];
      });
    }
    case "tool_use": {
      const toolUseId = readString(record.toolUseId) ?? `droid-tool-${Date.now()}`;
      const tool = readString(record.toolName) ?? "tool";
      meta.state.toolNamesByUseId.set(toolUseId, tool);
      const command = extractCommand(record.toolInput);
      if (command) {
        return [{
          type: "command",
          command,
          cwd: extractCwd(record.toolInput, meta.cwd),
          output: "",
          itemId: toolUseId,
          turnId,
          status: "running",
        }];
      }
      return [{ type: "tool_call", tool, args: record.toolInput ?? {}, itemId: toolUseId, turnId }];
    }
    case "tool_progress": {
      const toolUseId = readString(record.toolUseId) ?? `droid-tool-${Date.now()}`;
      const tool = readString(record.toolName) ?? meta.state.toolNamesByUseId.get(toolUseId) ?? "tool";
      const content = readString(record.content) ?? summarize(record.update);
      return [{
        type: "tool_result",
        tool,
        result: content,
        itemId: `${toolUseId}:progress`,
        logicalItemId: toolUseId,
        turnId,
        status: "running",
      }];
    }
    case "tool_result": {
      const toolUseId = readString(record.toolUseId) ?? `droid-tool-${Date.now()}`;
      const tool = readString(record.toolName) ?? meta.state.toolNamesByUseId.get(toolUseId) ?? "tool";
      return [{
        type: "tool_result",
        tool,
        result: record.content,
        itemId: toolUseId,
        turnId,
        status: toolResultStatus(record),
      }];
    }
    case "working_state_changed": {
      const state = readString(record.state);
      if (!state || state.toLowerCase() === "idle") return [];
      return [{
        type: "activity",
        activity: "working",
        detail: `Droid ${state}`,
        turnId,
      }];
    }
    case "token_usage_update": {
      const usage = usageFrom(record);
      meta.state.latestUsage = usage;
      if (!usage) return [];
      return [{
        type: "tokens",
        turnId,
        ...(usage.inputTokens != null ? { inputTokens: usage.inputTokens } : {}),
        ...(usage.outputTokens != null ? { outputTokens: usage.outputTokens } : {}),
        ...(usage.cacheReadTokens != null ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(usage.cacheCreationTokens != null ? { cacheWriteTokens: usage.cacheCreationTokens } : {}),
      }];
    }
    case "session_title_updated":
    case "settings_updated":
    case "permission_resolved":
    case "turn_complete":
    case "mcp_status_changed":
    case "mcp_auth_required":
    case "mcp_auth_completed":
      return [];
    case "error":
      return [{
        type: "error",
        message: readString(record.message) ?? "Droid SDK reported an error.",
        turnId,
      }];
    default:
      return [];
  }
}

export function mapDroidSdkRunResultToDoneEvent(
  result: unknown,
  meta: {
    turnId: string;
    model: string;
    modelId?: string;
    state: DroidSdkEventMapperState;
    interrupted?: boolean;
  },
): Extract<AgentChatEvent, { type: "done" }> {
  const record = asRecord(result);
  const tokenUsage = asRecord(record?.tokenUsage) ?? meta.state.latestUsage;
  const usage = usageFrom(tokenUsage);
  return {
    type: "done",
    turnId: meta.turnId,
    status: meta.interrupted ? "interrupted" : record?.success === false ? "failed" : "completed",
    model: meta.model,
    ...(meta.modelId ? { modelId: meta.modelId } : {}),
    ...(usage ? { usage } : {}),
  };
}
