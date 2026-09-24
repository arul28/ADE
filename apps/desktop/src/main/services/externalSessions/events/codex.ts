import { fileURLToPath } from "node:url";
import { codexTurnsToContentEvents } from "../../chat/externalChatHistoryImport";
import { isRecord, str, type JsonRecord, type JsonlConverter } from "./common";

/**
 * Codex rollout JSONL (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).
 *
 * Three layouts exist in the wild, and one file uses one of them:
 *
 * - Current (0.15x): every finished thread item is an `event_msg` of type
 *   `item_completed` carrying the app-server item (`UserMessage`,
 *   `AgentMessage`, `Reasoning`, `CommandExecution`, `FileChange`,
 *   `McpToolCall`, …). The same turn is mirrored as `response_item`s; those are
 *   dropped except `function_call`s no item covers (e.g. `spawn_agent`).
 *   `custom_tool_call` (the code-mode `exec` wrapper) and its `wait` polls are
 *   dropped: the commands and patches they ran are already
 *   `CommandExecution` / `FileChange` items.
 * - Legacy: `event_msg` `user_message` / `agent_message` / `agent_reasoning`
 *   plus `response_item` tool calls. The `response_item` `message` and
 *   `reasoning` mirrors are dropped; `function_call`, `function_call_output`,
 *   `custom_tool_call(_output)` and `local_shell_call` are kept.
 * - Bare: only `response_item`s. Everything is kept.
 *
 * Each record becomes a pseudo-turn for `codexTurnsToContentEvents`, so the
 * item mapping is the one import already uses.
 */
export const codexRecordsToEvents: JsonlConverter = (records, ctx) => {
  const objects = records.map((record) => (isRecord(record) ? record : null));
  const hasItemCompleted = objects.some((record) => eventMsgType(record) === "item_completed");
  const hasLegacyEvents = !hasItemCompleted && objects.some((record) => {
    const type = eventMsgType(record);
    return type === "user_message" || type === "agent_message";
  });

  const coveredCallIds = new Set<string>();
  if (hasItemCompleted) {
    for (const record of objects) {
      if (eventMsgType(record) !== "item_completed") continue;
      const item = isRecord(record?.payload) && isRecord(record.payload.item) ? record.payload.item : null;
      const id = str(item?.id);
      if (item && id && EMITTED_ITEM_TYPES.has(str(item.type) ?? "")) coveredCallIds.add(id);
    }
  }

  const toolNames = new Map<string, string>();
  const keptCalls = new Set<string>();
  const turns: JsonRecord[] = [];
  let currentTurnId: string | null = null;

  objects.forEach((record, index) => {
    if (!record) return;
    const payload = isRecord(record.payload) ? record.payload : null;
    if (!payload) return;
    const passthrough = isRecord(payload.internal_chat_message_metadata_passthrough)
      ? payload.internal_chat_message_metadata_passthrough
      : null;
    const realTurnId = str(payload.turn_id) ?? str(passthrough?.turn_id);
    if (realTurnId) currentTurnId = realTurnId;
    const timestamp = str(record.timestamp) ?? new Date(ctx.fallbackMs(index)).toISOString();
    const recordType = str(record.type);
    const payloadType = str(payload.type) ?? "";

    let items: JsonRecord[] = [];
    if (recordType === "event_msg") {
      if (payloadType === "item_completed" && isRecord(payload.item)) {
        items = normalizeThreadItem(payload.item);
      } else if (hasLegacyEvents && LEGACY_EVENT_TYPES.has(payloadType)) {
        items = [{ ...payload, id: `codex-event:${ctx.lineKeys[index] ?? index}` }];
      }
    } else if (recordType === "response_item") {
      items = normalizeResponseItem(payload, {
        keepMessages: !hasItemCompleted && !hasLegacyEvents,
        keepCustomTools: !hasItemCompleted,
        coveredCallIds,
        toolNames,
        keptCalls,
      });
    }
    if (!items.length) return;
    if (!realTurnId && items.some((item) => item.type === "userMessage" || item.type === "user_message")) {
      currentTurnId = `codex-turn:${ctx.lineKeys[index] ?? index}`;
    }
    turns.push({
      id: currentTurnId ?? "codex-turn:0",
      items: items.map((item) => ({ ...item, timestamp })),
    });
  });

  return codexTurnsToContentEvents(turns, ctx.options);
};

const EMITTED_ITEM_TYPES = new Set([
  "UserMessage",
  "AgentMessage",
  "Reasoning",
  "CommandExecution",
  "FileChange",
  "McpToolCall",
  "DynamicToolCall",
  "WebSearch",
  "Extension",
  "ImageView",
]);

const LEGACY_EVENT_TYPES = new Set(["user_message", "agent_message", "agent_reasoning"]);

function eventMsgType(record: JsonRecord | null): string | null {
  if (!record || str(record.type) !== "event_msg" || !isRecord(record.payload)) return null;
  return str(record.payload.type);
}

function commandLine(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!Array.isArray(value)) return null;
  const parts = value.filter((part): part is string => typeof part === "string");
  // `["/bin/zsh", "-lc", "<script>"]` / `["bash", "-c", …]`: show the script.
  if (parts.length >= 3 && (parts[1] === "-lc" || parts[1] === "-c")) return parts.slice(2).join(" ");
  return parts.join(" ").trim() || null;
}

function cwdFrom(value: unknown): string {
  const raw = str(value) ?? "";
  if (!raw.startsWith("file://")) return raw;
  try {
    return fileURLToPath(raw);
  } catch {
    return raw;
  }
}

function durationMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!isRecord(value)) return null;
  const secs = typeof value.secs === "number" ? value.secs : 0;
  const nanos = typeof value.nanos === "number" ? value.nanos : 0;
  return Math.round(secs * 1000 + nanos / 1_000_000);
}

/** A current-layout `item_completed` item in the shape the import mapper reads. */
function normalizeThreadItem(item: JsonRecord): JsonRecord[] {
  const id = str(item.id);
  if (!id) return [];
  switch (str(item.type)) {
    case "UserMessage":
      return [{ type: "userMessage", id, content: item.content }];
    case "AgentMessage":
      return [{ type: "agentMessage", id, content: item.content }];
    case "Reasoning":
      return [{ type: "reasoning", id, summary: item.summary_text ?? item.summary, content: item.raw_content ?? item.content }];
    case "CommandExecution": {
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
      return [{
        type: "commandExecution",
        id,
        command: commandLine(item.command) ?? "command",
        cwd: cwdFrom(item.cwd),
        aggregatedOutput: item.aggregated_output ?? item.formatted_output ?? item.stdout ?? "",
        ...(exitCode !== null ? { exitCode } : {}),
        ...(durationMs(item.duration) !== null ? { durationMs: durationMs(item.duration) } : {}),
        status: exitCode !== null && exitCode !== 0 ? "failed" : item.status,
      }];
    }
    case "FileChange": {
      const changes = isRecord(item.changes)
        ? Object.entries(item.changes).map(([path, change]) => ({
          path,
          kind: isRecord(change) ? change.type : null,
          diff: isRecord(change) ? str(change.unified_diff) ?? str(change.content) ?? "" : "",
        }))
        : Array.isArray(item.changes) ? item.changes : [];
      return changes.length ? [{ type: "fileChange", id, changes, status: item.status }] : [];
    }
    case "McpToolCall":
    case "DynamicToolCall": {
      const server = str(item.server) ?? str(item.namespace);
      const toolName = str(item.tool) ?? "tool";
      const failed = item.success === false || str(item.status) === "failed" || item.error != null;
      const resultValue = isRecord(item.result)
        ? item.result.content ?? item.result.structuredContent ?? item.result
        : item.content_items ?? item.result ?? item.error ?? "";
      return [
        { type: "mcpToolCall", id, server, tool: toolName, arguments: item.arguments ?? {} },
        {
          type: "tool_result",
          id,
          tool: server ? `${server}:${toolName}` : toolName,
          output: failed && item.error != null ? item.error : resultValue,
          status: failed ? "failed" : "completed",
        },
      ];
    }
    case "WebSearch":
    case "Extension": {
      if (str(item.type) === "Extension" && str(item.kind) !== "web.search") return [];
      const action = isRecord(item.action) ? item.action : null;
      const query = str(item.query) ?? str(action?.query);
      if (!query) return [];
      return [{
        type: "webSearch",
        id,
        query,
        ...(str(action?.type) ? { action: str(action?.type) } : {}),
        ...(Array.isArray(item.results) ? { results: item.results } : {}),
        status: "completed",
      }];
    }
    case "ImageView":
      return [{ type: "imageView", id, path: item.path, status: "completed" }];
    default:
      // CollabAgentToolCall / SubAgentActivity / ContextCompaction: the
      // matching `function_call` (spawn_agent, …) is kept instead.
      return [];
  }
}

function normalizeResponseItem(
  payload: JsonRecord,
  state: {
    keepMessages: boolean;
    keepCustomTools: boolean;
    coveredCallIds: Set<string>;
    toolNames: Map<string, string>;
    keptCalls: Set<string>;
  },
): JsonRecord[] {
  const type = str(payload.type) ?? "";
  const callId = str(payload.call_id) ?? str(payload.id);
  switch (type) {
    case "message":
    case "reasoning":
      return state.keepMessages ? [payload] : [];
    case "function_call":
    case "custom_tool_call":
    case "local_shell_call": {
      if (!callId || state.coveredCallIds.has(callId)) return [];
      if (type === "custom_tool_call" && !state.keepCustomTools) return [];
      const name = type === "local_shell_call" ? "shell" : str(payload.name) ?? "tool";
      const namespace = str(payload.namespace);
      // Code mode's `wait` polls an `exec` cell; the cell's work is already
      // shown by its `CommandExecution` / `FileChange` items.
      if (!state.keepCustomTools && !namespace && name === "wait") return [];
      state.toolNames.set(callId, namespace ? `${namespace}:${name}` : name);
      state.keptCalls.add(callId);
      return [{
        type: "function_call",
        id: callId,
        name,
        ...(namespace ? { server: namespace } : {}),
        arguments: type === "local_shell_call" ? payload.action ?? {} : payload.arguments ?? payload.input ?? {},
      }];
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      if (!callId || !state.keptCalls.has(callId)) return [];
      const output = payload.output;
      const failed = isRecord(output) && output.success === false;
      return [{
        type: "function_call_output",
        id: callId,
        name: state.toolNames.get(callId) ?? "tool",
        output: isRecord(output) && "content" in output ? output.content : output,
        status: failed ? "failed" : "completed",
      }];
    }
    default:
      return [];
  }
}
