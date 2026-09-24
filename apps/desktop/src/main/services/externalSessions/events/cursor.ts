import type { AgentChatEventEnvelope } from "../../../../shared/types";
import type { ExternalChatHistoryImportOptions } from "../../chat/externalChatHistoryImport";
import {
  CURSOR_STORE_MAX_MESSAGE_BYTES,
  isCursorEnvironmentMessage,
  openCursorStoreConversation,
} from "../discoverCursor";
import { EnvelopeSink, isRecord, str, textOf, type JsonRecord, type JsonlConverter } from "./common";
import { cutPage, type EventsCursor, type PageCut } from "./paging";

/**
 * Cursor agent transcripts
 * (`~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`). Rows are
 * `{ role, message: { content: [text | tool_use] } }` with no timestamps, no
 * tool ids and no tool results — Cursor keeps outputs only in `store.db`. A
 * tool call is closed with an empty completed result so a finished transcript
 * does not render as still running. A session known only through `store.db`
 * is read by `loadCursorStorePage` below.
 */
export const cursorRecordsToEvents: JsonlConverter = (records, ctx) => {
  const sink = new EnvelopeSink(ctx.options);
  records.forEach((record, index) => {
    if (!isRecord(record)) return;
    const message = isRecord(record.message) ? record.message : null;
    const role = str(record.role) ?? str(message?.role);
    if (!message || (role !== "user" && role !== "assistant")) return;
    const key = `cursor:${ctx.lineKeys[index] ?? index}`;
    const timestamp = new Date(ctx.fallbackMs(index)).toISOString();
    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    if (role === "user") {
      const raw = textOf(blocks).replace(/<timestamp>[\s\S]*?<\/timestamp>/giu, " ");
      sink.user(raw, timestamp, key);
      return;
    }
    blocks.forEach((block, blockIndex) => {
      if (typeof block === "string") {
        sink.text(block, timestamp, `${key}:text:${blockIndex}`);
        return;
      }
      if (!isRecord(block)) return;
      if (str(block.type) === "tool_use") {
        const itemId = str(block.id) ?? `${key}:tool:${blockIndex}`;
        const tool = str(block.name) ?? "tool";
        sink.toolCall(tool, block.input ?? {}, timestamp, itemId);
        sink.toolResult(tool, "", timestamp, itemId, false);
      } else if (str(block.type) === "text") {
        sink.text(str(block.text) ?? "", timestamp, `${key}:text:${blockIndex}`);
      }
    });
  });
  return sink.out;
};

/**
 * One `store.db` message (AI SDK JSON) as events. User text, assistant text,
 * readable reasoning, tool calls and tool results convert; system prompts,
 * redacted reasoning and images carry nothing to show.
 */
function cursorStoreMessageToEvents(message: JsonRecord, sink: EnvelopeSink, key: string, timestamp: string): void {
  const role = str(message.role);
  const parts = Array.isArray(message.content) ? message.content : [message.content];
  if (role === "user") {
    const text = parts
      .filter((part) => typeof part === "string" || (isRecord(part) && str(part.type) === "text"))
      .map(textOf)
      .join("\n");
    if (isCursorEnvironmentMessage(text)) return;
    sink.user(text, timestamp, key);
    return;
  }
  // Cursor joins the two halves of an OpenAI call id with a newline.
  const toolId = (value: unknown, fallback: string): string => str(value)?.replace(/\s*\n\s*/gu, "|") ?? fallback;
  parts.forEach((part, index) => {
    const partKey = `${key}:${index}`;
    if (typeof part === "string") {
      if (role === "assistant") sink.text(part, timestamp, `${partKey}:text`);
      return;
    }
    if (!isRecord(part)) return;
    const type = str(part.type);
    if (role === "assistant" && type === "text") {
      sink.text(str(part.text) ?? "", timestamp, `${partKey}:text`);
    } else if (role === "assistant" && type === "reasoning") {
      sink.reasoning(str(part.text) ?? "", timestamp, `${partKey}:reasoning`);
    } else if (role === "assistant" && type === "tool-call") {
      sink.toolCall(str(part.toolName) ?? "tool", part.args ?? {}, timestamp, toolId(part.toolCallId, `${partKey}:tool`));
    } else if (role === "tool" && type === "tool-result") {
      sink.toolResult(
        str(part.toolName) ?? "tool",
        part.result ?? "",
        timestamp,
        toolId(part.toolCallId, `${partKey}:tool`),
        part.isError === true,
      );
    }
  });
}

/**
 * A page of a Cursor chat that exists only as `store.db`. The cursor's `end`
 * is a message index (the store's message list only grows at its end), and a
 * page reads back from it one message at a time until it holds `maxEvents`
 * events or `maxBytes` of message blobs, so a large store is never loaded
 * whole. The same `end` always yields the same window, which `index` cuts.
 */
export function loadCursorStorePage(args: {
  storePath: string;
  options: ExternalChatHistoryImportOptions;
  cursor: EventsCursor | null;
  maxEvents: number;
  maxBytes: number;
  fallbackBaseMs: number;
}): (PageCut & { bytesTruncated: boolean }) | null {
  const conversation = openCursorStoreConversation(args.storePath, null);
  if (!conversation) return null;
  try {
    const { messageIds, summaryIndex, summaryId } = conversation;
    const end = Math.min(messageIds.length, args.cursor?.end ?? messageIds.length);
    const chunks: AgentChatEventEnvelope[][] = [];
    let start = end;
    let count = 0;
    let bytes = 0;
    let bytesTruncated = false;
    while (start > 0 && count < args.maxEvents) {
      const index = start - 1;
      const id = messageIds[index]!;
      const size = conversation.messageSize(id) ?? 0;
      const oversized = size > CURSOR_STORE_MAX_MESSAGE_BYTES;
      // One oversized blob (a huge tool output) is left out, not the page, and
      // so never spends the page's byte budget.
      if (!oversized && bytes + size > args.maxBytes && bytes > 0) {
        bytesTruncated = true;
        break;
      }
      start = index;
      const sink = new EnvelopeSink(args.options);
      const timestamp = new Date(args.fallbackBaseMs + index).toISOString();
      if (oversized) {
        // Say where it was: a silent gap reads as a complete conversation.
        sink.push({
          type: "system_notice",
          noticeKind: "info",
          severity: "info",
          message: `One message (${Math.round(size / (1024 * 1024))} MB) was left out of this Cursor chat.`,
        }, timestamp, `cursor-store:${index}:omitted`);
      } else {
        bytes += size;
        if (index === summaryIndex) {
          sink.push({
            type: "context_compact",
            trigger: "auto",
            provider: "cursor",
            ...(summaryId ? { compactionId: summaryId } : {}),
            state: "completed",
          }, timestamp, `cursor-store:${index}:compact`);
        }
        const message = conversation.readMessage(id);
        if (message) cursorStoreMessageToEvents(message, sink, `cursor-store:${index}`, timestamp);
      }
      chunks.push(sink.out);
      count += sink.out.length;
    }
    const events = chunks.reverse().flat();
    const cut = cutPage(events, {
      maxEvents: args.maxEvents,
      index: args.cursor?.index ?? null,
      windowStart: start,
      windowEnd: end,
      windowBytes: null,
    });
    return { ...cut, bytesTruncated };
  } finally {
    conversation.close();
  }
}
