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
/** Payload bytes one batch holds at most, whatever the page's budget. */
const BATCH_BYTES = 4 * 1024 * 1024;
/** Steps one page scans at most: bookkeeping steps show nothing and must not be read forever. */
const MAX_SCANNED_STEPS = 2_000;

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
      // A tool still running or waiting for approval has no outcome yet.
      if (step.status === "running" || step.status === "waiting") return;
      const text = step.text.length > TOOL_RESULT_CHARS ? `${step.text.slice(0, TOOL_RESULT_CHARS)}…` : step.text;
      // Denied, failed and cancelled calls keep their failed status.
      const failed = step.status === "failed" || step.status === "cancelled";
      sink.toolResult(step.toolCall.name, text, timestamp, `agy-tool:${step.toolCall.id || step.idx}`, failed);
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
  let scanned = 0;
  let scanLimited = false;
  let readFailed = false;
  let first = true;
  // Read newest first: a user's message (no time of its own) takes the time
  // of the reply that followed it, else of the dated step before it, so it
  // never sorts ahead of earlier turns.
  let laterAt: number | null = null;
  const undated: Array<{ chunk: AgentChatEventEnvelope[]; idx: number }> = [];
  outer: while (count < args.maxEvents) {
    // Until the page shows something its budget does not stop it, so hold a full batch.
    const batchBytes = count > 0 ? Math.min(BATCH_BYTES, Math.max(args.maxBytes - bytes, 1)) : BATCH_BYTES;
    const read = readAntigravityStepsBefore(args.file, before, STEP_BATCH, batchBytes);
    if (!read) {
      if (first) return null;
      // The log stopped answering mid-page: what is older is unknown, not absent.
      readFailed = true;
      break;
    }
    first = false;
    const batch = read.rows;
    if (!batch.length) break;
    for (const { step, bytes: size, clipped } of batch) {
      // The byte budget ends a page only once it shows something, so a run of
      // bookkeeping steps cannot leave the first page empty.
      if (bytes + size > args.maxBytes && count > 0) {
        bytesTruncated = true;
        break outer;
      }
      if (scanned >= MAX_SCANNED_STEPS) {
        scanLimited = true;
        break outer;
      }
      scanned += 1;
      bytes += size;
      lowest = step.idx;
      highest ??= step.idx;
      const sink = new EnvelopeSink(args.options);
      const dated = ("atMs" in step && step.atMs) || null;
      if (dated !== null) {
        laterAt = dated;
        // Newer undated steps go just after this one.
        for (const pending of undated.splice(0)) {
          const stamp = new Date(dated + pending.idx).toISOString();
          for (const envelope of pending.chunk) envelope.timestamp = stamp;
        }
      }
      const at = laterAt ?? args.fallbackBaseMs;
      // `+ idx` keeps steps that share a second in order.
      const timestamp = new Date(at + step.idx).toISOString();
      stepToEvents(step, sink, timestamp);
      if (clipped && sink.out.length && (step.kind === "user" || step.kind === "reply" || step.kind === "message")) {
        // Say so: a silently shortened message reads as the whole message.
        sink.push({
          type: "system_notice",
          noticeKind: "info",
          severity: "info",
          message: "This message was longer than ADE reads from Antigravity's log; the copy shows its start.",
        }, timestamp, `agy:${step.idx}:clipped`);
      }
      if (laterAt === null && sink.out.length) undated.push({ chunk: sink.out, idx: step.idx });
      chunks.push(sink.out);
      count += sink.out.length;
    }
    before = batch[batch.length - 1]!.step.idx;
    if (!read.more) break;
  }
  // Older steps were left unread: by the byte or event budget, the scan bound,
  // or a read that failed part way.
  const leftOlder = lowest !== null && lowest > 0 && (bytesTruncated || scanLimited || readFailed || count >= args.maxEvents);
  const cut = cutPage(chunks.reverse().flat(), {
    maxEvents: args.maxEvents,
    index: args.cursor?.index ?? null,
    // Step indexes stand in for file offsets: older pages read before `lowest`.
    windowStart: leftOlder ? lowest : null,
    // A conversation still running grows past the first page; later pages
    // stay anchored to what this one read.
    windowEnd: end ?? (highest !== null ? highest + 1 : null),
    windowBytes: null,
  });
  // An import reports any of them, as a JSONL window that starts past 0 does.
  return { ...cut, bytesTruncated: leftOlder || readFailed };
}
