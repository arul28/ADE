import { EnvelopeSink, isRecord, str, textOf, toIso, type JsonlConverter } from "./common";

/**
 * Pi session JSONL (`~/.pi/agent/sessions/--<cwd slug>--/<ts>_<id>.jsonl`).
 * Conversation rows are `{ type: "message", id, timestamp, message }` where
 * `message.role` is `user` (text blocks), `assistant` (`text`, `thinking`,
 * `toolCall { id, name, arguments }` blocks) or `toolResult`
 * (`toolCallId`, `toolName`, `content`, `isError`). Other row types (model and
 * thinking changes, compaction, custom) carry no conversation.
 */
export const piRecordsToEvents: JsonlConverter = (records, ctx) => {
  const sink = new EnvelopeSink(ctx.options);
  records.forEach((record, index) => {
    if (!isRecord(record) || str(record.type) !== "message" || !isRecord(record.message)) return;
    const message = record.message;
    const role = str(message.role);
    const rowId = str(record.id) ?? `pi:${ctx.lineKeys[index] ?? index}`;
    const timestamp = toIso(record.timestamp ?? message.timestamp, ctx.fallbackMs(index));
    const blocks = Array.isArray(message.content) ? message.content : [message.content];

    if (role === "user") {
      sink.user(textOf(blocks), timestamp, rowId);
      return;
    }
    if (role === "assistant") {
      blocks.forEach((block, blockIndex) => {
        if (typeof block === "string") {
          sink.text(block, timestamp, `${rowId}:text:${blockIndex}`);
          return;
        }
        if (!isRecord(block)) return;
        const type = str(block.type);
        if (type === "thinking") {
          sink.reasoning(str(block.thinking) ?? "", timestamp, `${rowId}:thinking:${blockIndex}`);
        } else if (type === "toolCall") {
          const itemId = str(block.id) ?? `${rowId}:tool:${blockIndex}`;
          sink.toolCall(str(block.name) ?? "tool", block.arguments ?? block.input ?? {}, timestamp, itemId);
        } else if (type === "text") {
          sink.text(str(block.text) ?? "", timestamp, `${rowId}:text:${blockIndex}`);
        }
      });
      return;
    }
    if (role === "toolResult") {
      const itemId = str(message.toolCallId) ?? `${rowId}:result`;
      sink.toolResult(
        str(message.toolName) ?? "tool",
        textOf(blocks) || (message.details ?? ""),
        timestamp,
        itemId,
        message.isError === true,
      );
    }
  });
  return sink.out;
};
