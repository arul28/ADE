// cd apps/ade-cli && npx tsx ../../scripts/perf/service/chat-backfill.bench.mts [file.chat.jsonl ...]
// What the renderer pays to backfill a long chat's older history in idle slots.
//
// AgentChatMessageList pages the rest of a transcript in one 256 KB page per
// idle slot, and each landed page is a new event list, so the pane commits it
// and the list rebuilds its rows for the whole resident transcript. This runs
// that loop without the app: the pager's byte window and turn anchoring, the
// capped merge, then the row pipeline the list memo runs for the new events
// (`chatDisplayEvents` -> collapse -> visible filter -> group -> fold).
//
// Per page it reports the pipeline cost, so a term that grows with the
// transcript (rather than with the page) shows up as a rising ms/page.
//
// With no argument: the five largest chats in <project>/.ade/transcripts (transcript-files.mts), where
// <project> is $ADE_PROJECT_ROOT or the checkout this script is in. `--synthetic N`
// builds an N-turn transcript instead (the shape used when no real transcript
// may be read). Transcripts are only read.
import path from "node:path";
import { largestTranscripts, loadTranscript } from "./transcript-files.mts";
import type { AgentChatEventEnvelope } from "../../../apps/desktop/src/shared/types/chat";
import {
  CHAT_HISTORY_PAGE_MAX_BYTES,
  INITIAL_SELECTED_CHAT_HISTORY_EVENTS,
  MAX_SELECTED_CHAT_SESSION_RESIDENT_BYTES,
  MAX_SELECTED_CHAT_SESSION_RESIDENT_EVENTS,
  chatDisplayEvents,
  mergeOlderChatHistoryPageWithCap,
  readOlderHistoryBatch,
} from "../../../apps/desktop/src/renderer/components/chat/chatHistoryWindow";
import {
  collapseChatTranscriptEventsIncrementalWithContext,
  collapseChatTranscriptEventsWithContext,
  filterVisibleTranscriptRows,
  groupChatTranscriptRows,
  type CollapseTranscriptResult,
} from "../../../apps/desktop/src/renderer/components/chat/chatTranscriptRows";
import { foldTurnFailureRows } from "../../../apps/desktop/src/renderer/components/chat/turnFailureRows";

const PAGE_BYTES = CHAT_HISTORY_PAGE_MAX_BYTES;

const defaultTranscripts = () => largestTranscripts(5);
const load = loadTranscript;

/** A long chat of the shape a real one has, for a run that may not read one. */
function synthetic(turns: number): AgentChatEventEnvelope[] {
  const sessionId = "synthetic-backfill";
  let sequence = 0;
  const out: AgentChatEventEnvelope[] = [];
  const push = (event: AgentChatEventEnvelope["event"]) => {
    sequence += 1;
    out.push({
      sessionId,
      timestamp: new Date(1_700_000_000_000 + sequence * 250).toISOString(),
      sequence,
      event,
    });
  };
  for (let turn = 0; turn < turns; turn += 1) {
    const turnId = `turn-${turn}`;
    push({ type: "user_message", text: `Turn ${turn}: look at the module and change the thing I asked for.`, turnId, messageId: `m-${turn}` });
    for (let delta = 0; delta < 40; delta += 1) {
      push({ type: "text", text: `chunk ${delta} of the assistant reply, a reasonably long sentence.`, turnId, messageId: `m-${turn}`, itemId: `i-${turn}` });
    }
    for (let tool = 0; tool < 6; tool += 1) {
      const itemId = `t-${turn}-${tool}`;
      push({ type: "tool_call", tool: "Read", args: { path: `apps/desktop/src/file-${turn}-${tool}.ts` }, itemId, turnId });
      push({ type: "tool_result", tool: "Read", result: "line of tool output\n".repeat(150), itemId, turnId, status: "completed" });
    }
    push({ type: "done", turnId, status: "completed" });
  }
  return out;
}

/** The raw JSONL byte offset of each envelope, as the pager's cursors use. */
function byteOffsets(envelopes: AgentChatEventEnvelope[]): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const envelope of envelopes) {
    offsets.push(at);
    at += Buffer.byteLength(`${JSON.stringify(envelope)}\n`, "utf8");
  }
  return offsets;
}

/** One page of `[end - PAGE_BYTES, end)`, clamped to a line start, like the pager. */
function pageAt(envelopes: AgentChatEventEnvelope[], offsets: number[], end: number, sessionId: string) {
  const windowStart = Math.max(0, end - PAGE_BYTES);
  let from = 0;
  for (let index = 0; index < offsets.length; index += 1) {
    if (offsets[index]! >= windowStart) { from = index; break; }
  }
  // One event larger than a page (a big tool output) has no line start inside the window; the page is
  // then that event alone, so the cursor always moves back.
  while (from > 0 && offsets[from]! >= end) from -= 1;
  let to = from;
  while (to < envelopes.length && offsets[to]! < end) to += 1;
  return {
    sessionId,
    sessionFound: true,
    events: envelopes.slice(from, to),
    startOffset: from === 0 ? 0 : offsets[from]!,
    hasMore: from > 0,
  };
}

type RowCache = { displayed: AgentChatEventEnvelope[] } & CollapseTranscriptResult;

/** The list's `rows` memo, on the new event list a landed page produced. */
function buildRows(events: AgentChatEventEnvelope[], previous: RowCache | null): RowCache {
  const displayed = chatDisplayEvents(events);
  const collapsed = previous
    ? collapseChatTranscriptEventsIncrementalWithContext(
      displayed,
      previous.displayed,
      previous.rows,
      previous.context,
    )
    : collapseChatTranscriptEventsWithContext(displayed);
  foldTurnFailureRows(groupChatTranscriptRows(filterVisibleTranscriptRows(collapsed.rows)));
  return { displayed, rows: collapsed.rows, context: collapsed.context };
}

async function measure(label: string, envelopes: AgentChatEventEnvelope[]) {
  const sessionId = envelopes[0]?.sessionId ?? "session";
  const offsets = byteOffsets(envelopes);
  const initialFrom = Math.max(0, envelopes.length - INITIAL_SELECTED_CHAT_HISTORY_EVENTS);
  let events = envelopes.slice(initialFrom);
  let cursor = initialFrom === 0 ? 0 : offsets[initialFrom]!;
  let cache = buildRows(events, null);

  const pageCosts: number[] = [];
  let pages = 0;
  let pipelineMs = 0;
  let mergeMs = 0;
  let hitResidentCap = false;
  while (cursor > 0 && !hitResidentCap) {
    const before = cursor;
    const batch = await readOlderHistoryBatch({
      sessionId,
      beforeOffset: cursor,
      isCurrent: () => true,
      readPage: async (beforeOffset) => pageAt(envelopes, offsets, beforeOffset, sessionId),
    });
    if (!batch || batch.nextCursor >= before) break;
    pages += 1;
    cursor = batch.nextCursor;
    const mergeStarted = performance.now();
    const merged = mergeOlderChatHistoryPageWithCap({
      older: batch.events,
      existing: events,
      maxEvents: MAX_SELECTED_CHAT_SESSION_RESIDENT_EVENTS,
      maxBytes: MAX_SELECTED_CHAT_SESSION_RESIDENT_BYTES,
    });
    mergeMs += performance.now() - mergeStarted;
    if (merged.hitResidentCap) { hitResidentCap = true; break; }
    events = merged.events;
    const started = performance.now();
    cache = buildRows(events, cache);
    const cost = performance.now() - started;
    pageCosts.push(cost);
    pipelineMs += cost;
  }

  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  return {
    transcript: label.slice(0, 8),
    events: envelopes.length,
    pages,
    hitResidentCap,
    residentEvents: events.length,
    residentRows: cache.rows.length,
    pipelineMs: Math.round(pipelineMs),
    mergeMs: Math.round(mergeMs),
    msPerPage: +mean(pageCosts).toFixed(1),
    firstPageMs: +(pageCosts[0] ?? 0).toFixed(1),
    lastPageMs: +(pageCosts[pageCosts.length - 1] ?? 0).toFixed(1),
    lastFiveMsPerPage: +mean(pageCosts.slice(-5)).toFixed(1),
  };
}

const syntheticAt = process.argv.indexOf("--synthetic");
const inputs: { label: string; envelopes: AgentChatEventEnvelope[] }[] = syntheticAt >= 0
  ? [{ label: `synthetic-${process.argv[syntheticAt + 1] ?? "1000"}`, envelopes: synthetic(Number(process.argv[syntheticAt + 1] ?? 1000)) }]
  : (process.argv.slice(2).length ? process.argv.slice(2) : defaultTranscripts())
    .map((file) => ({ label: path.basename(file), envelopes: load(file) }));

const rows: Record<string, unknown>[] = [];
for (const input of inputs) {
  if (input.envelopes.length <= INITIAL_SELECTED_CHAT_HISTORY_EVENTS) continue;
  rows.push(await measure(input.label, input.envelopes));
}
for (const row of rows) console.log(JSON.stringify(row));
if (rows.length) {
  const mean = (key: string) => +(rows.reduce((sum, row) => sum + (row[key] as number), 0) / rows.length).toFixed(1);
  console.log(JSON.stringify({
    transcripts: rows.length,
    pages: mean("pages"),
    pipelineMs: mean("pipelineMs"),
    msPerPage: mean("msPerPage"),
    firstPageMs: mean("firstPageMs"),
    lastPageMs: mean("lastPageMs"),
  }));
}
