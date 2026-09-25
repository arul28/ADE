import { EnvelopeSink, isRecord, maybeParseJson, str, textOf, type JsonlConverter } from "./common";

/**
 * Grok Build chat history
 * (`~/.grok/sessions/<url-encoded cwd>/<id>/chat_history.jsonl`). Rows:
 * `user` (content blocks; `synthetic_reason` marks injected context),
 * `assistant` (`content` string + `tool_calls [{ id, name, arguments }]`),
 * `tool_result` (`tool_call_id`, `content`), `reasoning` (`summary` texts)
 * and `system`. Rows carry no timestamps.
 */
export const grokRecordsToEvents: JsonlConverter = (records, ctx) => {
  const sink = new EnvelopeSink(ctx.options);
  const toolNames = new Map<string, string>();
  records.forEach((record, index) => {
    if (!isRecord(record)) return;
    const key = `grok:${ctx.lineKeys[index] ?? index}`;
    const timestamp = new Date(ctx.fallbackMs(index)).toISOString();
    switch (str(record.type)) {
      case "user":
        if (record.synthetic_reason != null) return;
        sink.user(textOf(record.content), timestamp, key);
        return;
      case "assistant": {
        sink.text(textOf(record.content), timestamp, `${key}:text`);
        const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
        calls.forEach((call, callIndex) => {
          if (!isRecord(call)) return;
          const fn = isRecord(call.function) ? call.function : call;
          const name = str(fn.name) ?? "tool";
          const itemId = str(call.id) ?? `${key}:tool:${callIndex}`;
          toolNames.set(itemId, name);
          sink.toolCall(name, maybeParseJson(fn.arguments), timestamp, itemId);
        });
        return;
      }
      case "tool_result": {
        const itemId = str(record.tool_call_id) ?? `${key}:result`;
        sink.toolResult(toolNames.get(itemId) ?? "tool", textOf(record.content), timestamp, itemId, record.is_error === true);
        return;
      }
      case "reasoning": {
        const summary = Array.isArray(record.summary) ? record.summary : [];
        sink.reasoning(textOf(summary), timestamp, str(record.id) ?? `${key}:reasoning`);
        return;
      }
      default:
    }
  });
  return sink.out;
};
