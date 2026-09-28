import type { AgentChatEventEnvelope } from "../../../../shared/types";
import type { ExternalChatHistoryImportOptions } from "../../chat/externalChatHistoryImport";
import type { ExternalSessionDiscoveryArgs } from "../discoveryUtils";
import { openUserOpenCodeStore, readOpenCodeStoreMessages, type OpenCodeStoreMessageRow } from "../openCodeStore";
import { EnvelopeSink, isRecord, str, toIso } from "./common";

/** A long session with screenshots stores tens of MB; past this the oldest messages are dropped. */
export const OPENCODE_TRANSCRIPT_MAX_BYTES = 96 * 1024 * 1024;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * A session from the user's own OpenCode store as content events, read-only.
 * Returns null when the store or the session cannot be read — the caller falls
 * back to the sampled messages.
 */
export function loadOpenCodeStoreEvents(args: {
  sessionId: string;
  options: ExternalChatHistoryImportOptions;
  fallbackBaseMs: number;
} & Pick<ExternalSessionDiscoveryArgs, "homeDir" | "env">): { events: AgentChatEventEnvelope[]; truncated: boolean } | null {
  const store = openUserOpenCodeStore(args);
  if (!store) return null;
  try {
    const { messages, truncated } = readOpenCodeStoreMessages(store, {
      sessionId: args.sessionId,
      maxBytes: OPENCODE_TRANSCRIPT_MAX_BYTES,
    });
    if (!messages.length) return null;
    const events = store.schema === "v2"
      ? openCodeV2MessagesToEvents(messages, args.options, args.fallbackBaseMs)
      : openCodeExportToEvents(v1MessagesAsExport(messages), args.options, args.fallbackBaseMs);
    return events ? { events, truncated } : null;
  } catch {
    return null;
  } finally {
    store.close();
  }
}

/** 1.x rows in the `{ messages: [{ info, parts }] }` shape its `export` printed. */
function v1MessagesAsExport(messages: readonly OpenCodeStoreMessageRow[]): unknown {
  return {
    messages: messages.map((message) => {
      const info = parseJson(message.data);
      return {
        info: { ...(isRecord(info) ? info : {}), id: message.id },
        parts: (message.parts ?? []).map((part) => {
          const parsed = parseJson(part.data);
          return { ...(isRecord(parsed) ? parsed : {}), id: part.id };
        }),
      };
    }),
  };
}

/**
 * A 1.x session (`{ messages: [{ info, parts }] }`) as content events. User and
 * assistant `text` parts, `reasoning` parts, and `tool` parts (`callID`,
 * `tool`, `state { status, input, output, error }`) map one to one; step
 * markers, patches, snapshots and synthetic user parts are dropped.
 */
export function openCodeExportToEvents(
  exported: unknown,
  options: ExternalChatHistoryImportOptions,
  fallbackBaseMs: number,
): AgentChatEventEnvelope[] | null {
  if (!isRecord(exported) || !Array.isArray(exported.messages)) return null;
  const sink = new EnvelopeSink(options);
  let tick = 0;
  for (const entry of exported.messages) {
    if (!isRecord(entry) || !isRecord(entry.info)) continue;
    const info = entry.info;
    const role = str(info.role);
    const messageId = str(info.id) ?? `opencode:${tick}`;
    const created = isRecord(info.time) ? info.time.created : null;
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    const userTexts: string[] = [];
    parts.forEach((part, partIndex) => {
      tick += 1;
      if (!isRecord(part)) return;
      const partTime = isRecord(part.time) ? part.time.start : null;
      const timestamp = toIso(partTime ?? created, fallbackBaseMs + tick);
      const partId = str(part.id) ?? `${messageId}:${partIndex}`;
      const type = str(part.type);
      if (role === "user") {
        if (type === "text" && part.synthetic !== true && part.ignored !== true) userTexts.push(str(part.text) ?? "");
        return;
      }
      if (role !== "assistant") return;
      if (type === "text" && part.synthetic !== true) {
        sink.text(str(part.text) ?? "", timestamp, partId);
      } else if (type === "reasoning") {
        sink.reasoning(str(part.text) ?? "", timestamp, partId);
      } else if (type === "tool") {
        const state = isRecord(part.state) ? part.state : {};
        const itemId = str(part.callID) ?? partId;
        const tool = str(part.tool) ?? "tool";
        sink.toolCall(tool, state.input ?? {}, timestamp, itemId);
        const status = str(state.status);
        if (status === "completed" || status === "error") {
          const endTime = isRecord(state.time) ? state.time.end : null;
          sink.toolResult(
            tool,
            status === "error" ? state.error ?? "" : state.output ?? "",
            toIso(endTime ?? partTime ?? created, fallbackBaseMs + tick),
            itemId,
            status === "error",
          );
        }
      }
    });
    if (role === "user" && userTexts.length) {
      sink.user(userTexts.join("\n"), toIso(created, fallbackBaseMs + tick), messageId);
    }
  }
  return sink.out;
}

/** Text of a 2.0 tool result's content blocks; file blocks are named, not inlined. */
function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type === "text") return str(block.text) ?? "";
      const name = str(block.name) ?? str(block.uri);
      return name ? `[file: ${name}]` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function structuredErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (!isRecord(error)) return "";
  return str(error.message) ?? str(error.type) ?? JSON.stringify(error);
}

/**
 * 2.0 `session_message` rows as content events. `user` rows carry their text;
 * `assistant` rows carry ordered text, reasoning, and tool blocks; a `shell` row
 * is a command the user ran and reads as a shell tool call. Agent/model
 * switches, compaction, idle markers, and synthetic/system rows are dropped.
 */
export function openCodeV2MessagesToEvents(
  messages: readonly Pick<OpenCodeStoreMessageRow, "id" | "type" | "createdAt" | "data">[],
  options: ExternalChatHistoryImportOptions,
  fallbackBaseMs: number,
): AgentChatEventEnvelope[] {
  const sink = new EnvelopeSink(options);
  let tick = 0;
  for (const message of messages) {
    tick += 1;
    const data = parseJson(message.data);
    if (!isRecord(data)) continue;
    const time = isRecord(data.time) ? data.time : {};
    const created = time.created ?? message.createdAt;
    if (message.type === "user") {
      sink.user(str(data.text) ?? "", toIso(created, fallbackBaseMs + tick), message.id);
      continue;
    }
    if (message.type === "shell") {
      const command = str(data.command);
      if (!command) continue;
      const output = isRecord(data.output) ? str(data.output.output) ?? "" : "";
      sink.toolCall("shell", { command }, toIso(created, fallbackBaseMs + tick), message.id);
      sink.toolResult(
        "shell",
        output,
        toIso(time.completed ?? created, fallbackBaseMs + tick),
        message.id,
        data.status !== "exited" || (typeof data.exit === "number" && data.exit !== 0),
      );
      continue;
    }
    if (message.type !== "assistant") continue;
    const content = Array.isArray(data.content) ? data.content : [];
    content.forEach((block, index) => {
      tick += 1;
      if (!isRecord(block)) return;
      const blockTime = isRecord(block.time) ? block.time : {};
      const timestamp = toIso(blockTime.created ?? created, fallbackBaseMs + tick);
      const blockId = `${message.id}:${index}`;
      if (block.type === "text") {
        sink.text(str(block.text) ?? "", timestamp, blockId);
      } else if (block.type === "reasoning") {
        sink.reasoning(str(block.text) ?? "", timestamp, blockId);
      } else if (block.type === "tool") {
        const state = isRecord(block.state) ? block.state : {};
        const itemId = str(block.id) ?? blockId;
        const tool = str(block.name) ?? "tool";
        sink.toolCall(tool, isRecord(state.input) ? state.input : {}, timestamp, itemId);
        const status = str(state.status);
        if (status === "completed" || status === "error") {
          const resultTime = toIso(blockTime.completed ?? blockTime.created ?? created, fallbackBaseMs + tick);
          const failed = status === "error";
          const text = toolContentText(state.content);
          sink.toolResult(tool, failed ? structuredErrorText(state.error) || text : text, resultTime, itemId, failed);
        }
      }
    });
  }
  return sink.out;
}
