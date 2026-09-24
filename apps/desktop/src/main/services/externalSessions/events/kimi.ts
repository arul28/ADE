import { EnvelopeSink, isRecord, maybeParseJson, str, textOf, toIso, type JsonRecord, type JsonlConverter } from "./common";

/**
 * Kimi Code wire log
 * (`~/.kimi-code/sessions/wd_<slug>_<hash>/<id>/agents/main/wire.jsonl`).
 *
 * UNVERIFIED: no Kimi session exists on the machine this was written on. The
 * reader follows the Kimi CLI wire protocol — rows `{ timestamp, message:
 * { type, payload } }` with `TurnBegin { user_input }`, streamed `ContentPart`
 * (`text` / `think`), `ToolCall { id, function: { name, arguments } }`,
 * `ToolCallPart { arguments_part }` and `ToolResult { tool_call_id,
 * return_value }` — and also accepts OpenAI-style `{ role, content,
 * tool_calls, tool_call_id }` rows. Anything else is ignored, and an empty
 * result falls back to the sampled messages.
 */
export const kimiRecordsToEvents: JsonlConverter = (records, ctx) => {
  const sink = new EnvelopeSink(ctx.options);
  const toolNames = new Map<string, string>();
  let textBuffer = "";
  let thinkBuffer = "";
  let bufferKey = "";
  let bufferTimestamp = "";
  let lastCall: { id: string; name: string; args: string; timestamp: string } | null = null;

  const flushText = () => {
    if (thinkBuffer) sink.reasoning(thinkBuffer, bufferTimestamp, `${bufferKey}:think`);
    if (textBuffer) sink.text(textBuffer, bufferTimestamp, `${bufferKey}:text`);
    textBuffer = "";
    thinkBuffer = "";
  };
  const flushCall = () => {
    if (!lastCall) return;
    sink.toolCall(lastCall.name, maybeParseJson(lastCall.args), lastCall.timestamp, lastCall.id);
    lastCall = null;
  };

  records.forEach((record, index) => {
    if (!isRecord(record)) return;
    const key = `kimi:${ctx.lineKeys[index] ?? index}`;
    const timestamp = toIso(record.timestamp, ctx.fallbackMs(index));
    const message = isRecord(record.message) && str(record.message.type) ? record.message : null;

    if (!message) {
      flushCall();
      flushText();
      openAiRow(sink, record, key, timestamp, toolNames);
      return;
    }
    const type = str(message.type);
    const payload = isRecord(message.payload) ? message.payload : message;
    if (type === "ContentPart") {
      flushCall();
      if (!textBuffer && !thinkBuffer) {
        bufferKey = key;
        bufferTimestamp = timestamp;
      }
      if (str(payload.type) === "think") thinkBuffer += typeof payload.think === "string" ? payload.think : "";
      else textBuffer += typeof payload.text === "string" ? payload.text : "";
      return;
    }
    if (type === "ToolCallPart") {
      if (lastCall && typeof payload.arguments_part === "string") lastCall.args += payload.arguments_part;
      return;
    }
    flushCall();
    flushText();
    if (type === "TurnBegin") {
      const input = payload.user_input;
      sink.user(typeof input === "string" ? input : textOf(input), timestamp, key);
    } else if (type === "ToolCall") {
      const fn = isRecord(payload.function) ? payload.function : payload;
      const id = str(payload.id) ?? `${key}:tool`;
      const name = str(fn.name) ?? "tool";
      toolNames.set(id, name);
      lastCall = { id, name, args: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}), timestamp };
    } else if (type === "ToolResult") {
      const id = str(payload.tool_call_id) ?? `${key}:result`;
      const value = isRecord(payload.return_value) ? payload.return_value : payload;
      const failed = value.is_error === true;
      const result = textOf(value.output) || str(value.message) || value.output || "";
      sink.toolResult(toolNames.get(id) ?? "tool", result, timestamp, id, failed);
    }
  });
  flushCall();
  flushText();
  return sink.out;
};

function openAiRow(
  sink: EnvelopeSink,
  record: JsonRecord,
  key: string,
  timestamp: string,
  toolNames: Map<string, string>,
): void {
  const role = str(record.role);
  if (role === "user") {
    sink.user(textOf(record.content), timestamp, key);
  } else if (role === "assistant") {
    sink.text(textOf(record.content), timestamp, `${key}:text`);
    const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
    calls.forEach((call, callIndex) => {
      if (!isRecord(call)) return;
      const fn = isRecord(call.function) ? call.function : call;
      const id = str(call.id) ?? `${key}:tool:${callIndex}`;
      const name = str(fn.name) ?? "tool";
      toolNames.set(id, name);
      sink.toolCall(name, maybeParseJson(fn.arguments), timestamp, id);
    });
  } else if (role === "tool") {
    const id = str(record.tool_call_id) ?? `${key}:result`;
    sink.toolResult(toolNames.get(id) ?? "tool", textOf(record.content), timestamp, id, false);
  }
}
