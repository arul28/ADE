import { EnvelopeSink, isRecord, str, textOf, toIso, type JsonlConverter } from "./common";

/**
 * GitHub Copilot CLI events (`~/.copilot/session-state/<id>/events.jsonl`).
 * Rows are `{ type, id, timestamp, data }`: `user.message` (`content`),
 * `assistant.message` (`content`, `reasoningText`, `toolRequests
 * [{ toolCallId, name, arguments }]`), `tool.execution_start` and
 * `tool.execution_complete` (`toolCallId`, `success`, `result.content`,
 * `error`). Rows with `parentToolCallId` belong to a subagent run and are left
 * out; the parent tool call and its result stand for that run.
 */
export const copilotRecordsToEvents: JsonlConverter = (records, ctx) => {
  const sink = new EnvelopeSink(ctx.options);
  const toolNames = new Map<string, string>();
  records.forEach((record, index) => {
    if (!isRecord(record) || !isRecord(record.data)) return;
    const data = record.data;
    if (str(data.parentToolCallId)) return;
    const rowId = str(record.id) ?? `copilot:${ctx.lineKeys[index] ?? index}`;
    const timestamp = toIso(record.timestamp, ctx.fallbackMs(index));
    switch (str(record.type)) {
      case "user.message":
        sink.user(textOf(data.content), timestamp, rowId);
        return;
      case "assistant.message": {
        const itemId = str(data.messageId) ?? rowId;
        sink.reasoning(str(data.reasoningText) ?? "", timestamp, `${itemId}:reasoning`);
        sink.text(textOf(data.content), timestamp, itemId);
        const requests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
        for (const request of requests) {
          if (!isRecord(request)) continue;
          const callId = str(request.toolCallId);
          if (!callId || toolNames.has(callId)) continue;
          const name = str(request.name) ?? "tool";
          toolNames.set(callId, name);
          sink.toolCall(name, request.arguments ?? {}, timestamp, callId);
        }
        return;
      }
      case "tool.execution_start": {
        const callId = str(data.toolCallId);
        if (!callId || toolNames.has(callId)) return;
        const name = str(data.toolName) ?? "tool";
        toolNames.set(callId, name);
        sink.toolCall(name, data.arguments ?? {}, timestamp, callId);
        return;
      }
      case "tool.execution_complete": {
        const callId = str(data.toolCallId);
        if (!callId) return;
        const result = isRecord(data.result) ? data.result.content ?? data.result.detailedContent ?? "" : data.result;
        const error = isRecord(data.error) ? str(data.error.message) ?? data.error : data.error;
        const failed = data.success === false;
        sink.toolResult(toolNames.get(callId) ?? "tool", failed && error != null ? error : result, timestamp, callId, failed);
        return;
      }
      default:
    }
  });
  return sink.out;
};
