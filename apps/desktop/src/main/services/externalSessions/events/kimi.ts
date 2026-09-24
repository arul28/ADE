import { EnvelopeSink, isRecord, maybeParseJson, str, textOf, toIso, type JsonRecord, type JsonlConverter } from "./common";
import { isKimiUserOrigin } from "../discoverKimi";

/**
 * Kimi Code wire log (`~/.kimi-code/sessions/.../agents/main/wire.jsonl`, or
 * legacy `context.jsonl`). It accepts persisted `context.append_message` and
 * `turn_begin` rows, the streamed `{ message: { type, payload } }` protocol,
 * and OpenAI-style role messages. An empty result falls back to sampled text.
 */
export const kimiRecordsToEvents: JsonlConverter = (records, ctx) => {
  const sink = new EnvelopeSink(ctx.options);
  const toolNames = new Map<string, string>();
  let textBuffer = "";
  let thinkBuffer = "";
  let bufferKey = "";
  let bufferTimestamp = "";
  let lastCall: { id: string; name: string; args: string; timestamp: string } | null = null;
  const hasAppendUser = records.some((record) => (
    isRecord(record)
      && record.type === "context.append_message"
      && isRecord(record.message)
      && str(record.message.role) === "user"
  ));

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
    const timestamp = toIso(record.timestamp ?? record.time ?? record.created_at, ctx.fallbackMs(index));
    const appendedMessage = record.type === "context.append_message" && isRecord(record.message)
      ? record.message
      : null;

    if (appendedMessage) {
      flushCall();
      flushText();
      openAiRow(sink, appendedMessage, key, timestamp, toolNames, true);
      return;
    }
    if (record.type === "turn_begin") {
      flushCall();
      flushText();
      if (!hasAppendUser && typeof record.userInput === "string") {
        sink.user(record.userInput, timestamp, key);
      }
      return;
    }

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
      if (!hasAppendUser) sink.user(typeof input === "string" ? input : textOf(input), timestamp, key);
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
  filterUserOrigin = false,
): void {
  const role = str(record.role);
  if (role === "user") {
    if (!filterUserOrigin || isKimiUserOrigin(record)) sink.user(textOf(record.content), timestamp, key);
  } else if (role === "assistant") {
    const content = Array.isArray(record.content) ? record.content : [record.content];
    const text: string[] = [];
    const reasoning: string[] = [];
    content.forEach((part) => {
      if (isRecord(part)) {
        const type = str(part.type);
        if (type === "think" || type === "thinking" || type === "reasoning" || part.thought === true) {
          const value = str(part.think) ?? str(part.thinking) ?? textOf(part);
          if (value) reasoning.push(value);
          return;
        }
      }
      const value = textOf(part);
      if (value) text.push(value);
    });
    const explicitReasoning = textOf(record.reasoning) || textOf(record.reasoningText);
    if (explicitReasoning) reasoning.unshift(explicitReasoning);
    sink.reasoning(reasoning.join("\n"), timestamp, `${key}:reasoning`);
    sink.text(text.join("\n"), timestamp, `${key}:text`);
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
    const id = str(record.tool_call_id) ?? str(record.toolCallId) ?? `${key}:result`;
    const name = toolNames.get(id) ?? str(record.name) ?? "tool";
    const failed = record.is_error === true || record.isError === true || record.error != null;
    const result = failed && record.error != null ? record.error : record.content ?? record.output ?? "";
    sink.toolResult(name, textOf(result) || result, timestamp, id, failed);
  }
}
