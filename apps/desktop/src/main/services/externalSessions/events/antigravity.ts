import type { AgentChatEventEnvelope } from "../../../../shared/types";
import type { ExternalChatHistoryImportOptions } from "../../chat/externalChatHistoryImport";
import {
  readAntigravityStepsBefore,
  type AntigravityStep,
} from "../../chat/acpHost/acpDialects/antigravitySessionLog";
import { EnvelopeSink } from "./common";
import { cutPage, type EventsCursor, type PageCut } from "./paging";

/** Steps read per query while paging back through a conversation. */
const STEP_BATCH = 200;
/** A tool result longer than this is clipped in the copy. */
const TOOL_RESULT_CHARS = 16_000;

function parsedArgs(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return args ? { input: args } : {};
  }
}

function stepToEvents(step: AntigravityStep, sink: EnvelopeSink, timestamp: string): void {
  const key = `agy:${step.idx}`;
  switch (step.kind) {
    case "user":
      sink.user(step.text, timestamp, key);
      return;
    case "reply":
      sink.reasoning(step.thinking, timestamp, `${key}:thinking`);
      sink.text(step.text, timestamp, `${key}:text`);
      step.toolCalls.forEach((call, index) => {
        sink.toolCall(call.name, parsedArgs(call.args), timestamp, `agy-tool:${call.id || `${step.idx}:${index}`}`);
      });
      return;
    case "tool": {
      const text = step.text.length > TOOL_RESULT_CHARS ? `${step.text.slice(0, TOOL_RESULT_CHARS)}…` : step.text;
      sink.toolResult(step.toolCall.name, text, timestamp, `agy-tool:${step.toolCall.id || step.idx}`, false);
      return;
    }
    case "message":
      // A subagent's report to this conversation.
      sink.text(step.content || step.title, timestamp, `${key}:message`);
      return;
    default:
      return;
  }
}

/**
 * One page of an agy conversation as ADE chat events, newest last, read
 * backwards from the cursor's step index within `maxBytes` of payload.
 */
export function loadAntigravityStorePage(args: {
  file: string;
  options: ExternalChatHistoryImportOptions;
  cursor: EventsCursor | null;
  maxEvents: number;
  maxBytes: number;
  fallbackBaseMs: number;
}): (PageCut & { bytesTruncated: boolean }) | null {
  const end = args.cursor?.end ?? null;
  const chunks: AgentChatEventEnvelope[][] = [];
  let before = end;
  let lowest: number | null = null;
  let highest: number | null = null;
  let count = 0;
  let bytes = 0;
  let bytesTruncated = false;
  let first = true;
  // Read newest first: a user's message (no time of its own) takes the time
  // of the reply that followed it.
  let laterAt = args.fallbackBaseMs;
  outer: while (count < args.maxEvents) {
    const batch = readAntigravityStepsBefore(args.file, before, STEP_BATCH);
    if (!batch) {
      if (first) return null;
      break;
    }
    first = false;
    if (!batch.length) break;
    for (const { step, bytes: size } of batch) {
      if (bytes + size > args.maxBytes && bytes > 0) {
        bytesTruncated = true;
        break outer;
      }
      bytes += size;
      lowest = step.idx;
      highest ??= step.idx;
      const sink = new EnvelopeSink(args.options);
      const at = ("atMs" in step && step.atMs) || laterAt;
      laterAt = at;
      // `+ idx` keeps steps that share a second in order.
      stepToEvents(step, sink, new Date(at + step.idx).toISOString());
      chunks.push(sink.out);
      count += sink.out.length;
    }
    before = batch[batch.length - 1]!.step.idx;
    if (batch.length < STEP_BATCH) break;
  }
  const cut = cutPage(chunks.reverse().flat(), {
    maxEvents: args.maxEvents,
    index: args.cursor?.index ?? null,
    // Step indexes stand in for file offsets: older pages read before `lowest`.
    windowStart: lowest !== null && lowest > 0 && (bytesTruncated || count >= args.maxEvents) ? lowest : null,
    // A conversation still running grows past the first page; later pages
    // stay anchored to what this one read.
    windowEnd: end ?? (highest !== null ? highest + 1 : null),
    windowBytes: null,
  });
  return { ...cut, bytesTruncated };
}
