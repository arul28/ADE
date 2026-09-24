import { EnvelopeSink, isRecord, str, toIso, type JsonRecord, type JsonlConverter } from "./common";
import { isQwenPromptRecord } from "../discoverQwen";

/**
 * Qwen Code chat JSONL (`~/.qwen/projects/<slug>/chats/<id>.jsonl`), a Gemini
 * CLI descendant. Rows are `{ uuid, timestamp, type, message: { role, parts } }`:
 * `user` rows carry text parts, `assistant` rows (role `model`) carry text
 * parts (`thought: true` = reasoning) and `functionCall { id, name, args }`
 * parts, and `tool_result` rows carry `functionResponse { id, name, response }`
 * parts plus `toolCallResult`. `system` rows are telemetry.
 *
 * Verified on this Mac only for text turns; the tool shapes follow the Gemini
 * CLI chat-recording format and are read tolerantly.
 */
export const qwenRecordsToEvents: JsonlConverter = (records, ctx) => {
  const sink = new EnvelopeSink(ctx.options);
  // Calls without an id are paired with the next result of the same name.
  const pendingByName = new Map<string, string[]>();
  records.forEach((record, index) => {
    if (!isRecord(record)) return;
    const type = str(record.type);
    if (type !== "user" && type !== "assistant" && type !== "tool_result") return;
    if (type === "user" && !isQwenPromptRecord(record)) return;
    const message = isRecord(record.message) ? record.message : null;
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    const rowId = str(record.uuid) ?? `qwen:${ctx.lineKeys[index] ?? index}`;
    const timestamp = toIso(record.timestamp, ctx.fallbackMs(index));
    const texts: string[] = [];

    parts.forEach((part, partIndex) => {
      if (!isRecord(part)) return;
      if (isRecord(part.functionCall)) {
        const call = part.functionCall;
        const name = str(call.name) ?? "tool";
        const itemId = str(call.id) ?? `${rowId}:call:${partIndex}`;
        if (!str(call.id)) pendingByName.set(name, [...(pendingByName.get(name) ?? []), itemId]);
        sink.toolCall(name, call.args ?? call.arguments ?? {}, timestamp, itemId);
        return;
      }
      if (isRecord(part.functionResponse)) {
        emitResult(sink, part.functionResponse, record, pendingByName, timestamp, `${rowId}:result:${partIndex}`);
        return;
      }
      const text = str(part.text);
      if (!text) return;
      if (part.thought === true) {
        sink.reasoning(text, timestamp, `${rowId}:thought:${partIndex}`);
      } else if (type === "assistant") {
        sink.text(text, timestamp, `${rowId}:text:${partIndex}`);
      } else if (type === "user") {
        texts.push(text);
      }
    });

    if (texts.length) sink.user(texts.join("\n"), timestamp, rowId);
  });
  return sink.out;
};

function emitResult(
  sink: EnvelopeSink,
  response: JsonRecord,
  record: JsonRecord,
  pendingByName: Map<string, string[]>,
  timestamp: string,
  fallbackId: string,
): void {
  const name = str(response.name) ?? "tool";
  const callResult = isRecord(record.toolCallResult) ? record.toolCallResult : null;
  let itemId = str(response.id) ?? str(callResult?.callId);
  if (!itemId) {
    const queue = pendingByName.get(name) ?? [];
    itemId = queue.shift() ?? fallbackId;
    pendingByName.set(name, queue);
  }
  const body = isRecord(response.response) ? response.response : null;
  const error = body?.error ?? callResult?.error ?? null;
  const result = error ?? body?.output ?? body?.content ?? callResult?.resultDisplay ?? response.response ?? "";
  const failed = error != null || str(callResult?.status) === "error";
  sink.toolResult(name, result, timestamp, itemId, failed);
}
