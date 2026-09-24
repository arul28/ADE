import { EnvelopeSink, isRecord, str, textOf, type JsonlConverter } from "./common";

/**
 * Cursor agent transcripts
 * (`~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`). Rows are
 * `{ role, message: { content: [text | tool_use] } }` with no timestamps, no
 * tool ids and no tool results — Cursor keeps outputs only in `store.db`. A
 * tool call is closed with an empty completed result so a finished transcript
 * does not render as still running. A session known only through `store.db`
 * has no converter and falls back to the sampled messages (text only).
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
