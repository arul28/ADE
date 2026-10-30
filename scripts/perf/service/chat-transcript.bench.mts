// cd apps/ade-cli && npx tsx ../../scripts/perf/service/chat-transcript.bench.mts [file.chat.jsonl ...]
// What the chat renderer pays to turn a transcript into rows, without the app.
// For each transcript: one full pass over all but the last 500 events (a chat
// opening), then the last 500 one at a time through the live merge, the
// display filter and the incremental row builder (a turn streaming). Every
// 50 events the incremental rows are checked against a full pass.
// `stepsOverFrame` counts streamed events that cost more than 4 ms.
// With no argument: the five largest chats in <project>/.ade/transcripts (transcript-files.mts), where
// <project> is $ADE_PROJECT_ROOT or the checkout this script is in.
// Transcripts are only read.
//
// The second section (below) replays a chat AT ITS RESIDENT CAP, the cost the
// first section cannot reach. Set RESIDENT_STREAM_EVENTS to stream more than
// the default 300 events; a run long enough to cross one trim step is what
// shows the trim itself rather than only the steady state.
import path from "node:path";
import { largestTranscripts, loadTranscript } from "./transcript-files.mts";
import type { AgentChatEventEnvelope } from "../../../apps/desktop/src/shared/types/chat";
import { agentChatEventIdentityKey, mergeAgentChatLiveEvents } from "../../../apps/desktop/src/shared/chatHistoryMerge";
import {
  chatDisplayEvents,
  estimatedChatEventResidentBytes,
  MAX_SELECTED_CHAT_SESSION_RESIDENT_BYTES,
  MAX_SELECTED_CHAT_SESSION_RESIDENT_EVENTS,
  trimChatEventHistory,
} from "../../../apps/desktop/src/renderer/components/chat/chatHistoryWindow";
import {
  collapseChatTranscriptEventsIncrementalWithContext,
  collapseChatTranscriptEventsWithContext,
} from "../../../apps/desktop/src/renderer/components/chat/chatTranscriptRows";

const STREAMED_EVENTS = 500;
const CHECK_EVERY = 50;
/** One frame at 240 Hz: a step over this drops a frame on a fast display. */
const FRAME_MS = 4;


const files = process.argv.slice(2).length ? process.argv.slice(2) : largestTranscripts(5);
const rows: Record<string, unknown>[] = [];
for (const file of files) {
  const envelopes = loadTranscript(file);
  if (envelopes.length <= STREAMED_EVENTS) continue;
  const split = envelopes.length - STREAMED_EVENTS;
  let events = mergeAgentChatLiveEvents([], envelopes.slice(0, split));
  let started = performance.now();
  let state = collapseChatTranscriptEventsWithContext(chatDisplayEvents(events));
  const openMs = performance.now() - started;
  let displayed = chatDisplayEvents(events);
  let mergeMs = 0;
  let rowsMs = 0;
  let worstStepMs = 0;
  let stepsOverFrame = 0;
  let resends = 0;
  let mismatches = 0;
  for (let index = split; index < envelopes.length; index += 1) {
    started = performance.now();
    const next = mergeAgentChatLiveEvents(events, [envelopes[index]!]);
    const merged = performance.now() - started;
    mergeMs += merged;
    if (next === events) continue;
    if (next.length === events.length) resends += 1;
    events = next;
    started = performance.now();
    const nextDisplayed = chatDisplayEvents(events);
    state = collapseChatTranscriptEventsIncrementalWithContext(nextDisplayed, displayed, state.rows, state.context);
    displayed = nextDisplayed;
    const built = performance.now() - started;
    rowsMs += built;
    worstStepMs = Math.max(worstStepMs, merged + built);
    if (merged + built > FRAME_MS) stepsOverFrame += 1;
    if ((index - split) % CHECK_EVERY === 0 || index === envelopes.length - 1) {
      const full = collapseChatTranscriptEventsWithContext(displayed).rows;
      if (JSON.stringify(full) !== JSON.stringify(state.rows)) mismatches += 1;
    }
  }
  rows.push({
    transcript: path.basename(file).slice(0, 8),
    events: envelopes.length,
    rows: state.rows.length,
    openMs: +openMs.toFixed(1),
    mergeMsPerEvent: +(mergeMs / STREAMED_EVENTS).toFixed(3),
    rowsMsPerEvent: +(rowsMs / STREAMED_EVENTS).toFixed(3),
    worstStepMs: +worstStepMs.toFixed(1),
    stepsOverFrame,
    resends,
    mismatches,
  });
}
for (const row of rows) console.log(JSON.stringify(row));
const mean = (key: string) => +(rows.reduce((sum, row) => sum + (row[key] as number), 0) / Math.max(1, rows.length)).toFixed(3);
console.log(JSON.stringify({
  transcripts: rows.length,
  openMs: mean("openMs"),
  mergeMsPerEvent: mean("mergeMsPerEvent"),
  rowsMsPerEvent: mean("rowsMsPerEvent"),
  worstStepMs: Math.max(0, ...rows.map((row) => row.worstStepMs as number)),
  stepsOverFrame: rows.reduce((sum, row) => sum + (row.stepsOverFrame as number), 0),
  mismatches: rows.reduce((sum, row) => sum + (row.mismatches as number), 0),
}));
if (rows.some((row) => (row.mismatches as number) > 0)) process.exit(1);

// ---------------------------------------------------------------------------
// A chat at its resident cap.
//
// The section above streams into a chat that still has room, where the live
// merge, the display filter and the row builder all carry their work forward
// and one streamed event costs one event. A chat that has filled its window
// (60,000 events or 32 MB) is the case the docs call out: it drops history on
// every flush, and a list that is new on every flush takes the full path every
// time. No real transcript reaches that size — the largest is about half the
// byte budget — so this builds one by tiling a real transcript: each copy
// shifted in time and given its own turn and item ids, so the copies are
// distinct turns to the merge and the row builder, as a longer chat's are.
//
// Every scenario opens a window of that size, then streams events through the
// pane's flush in order — `mergeAgentChatLiveEvents`, `trimChatEventHistory`,
// `chatDisplayEvents`, the incremental row builder — and checks every 50 events
// that the incremental rows still equal a full pass, that the newest streamed
// event is resident, that the retained events are in their original order with
// none dropped from the middle, and that the window is inside its budgets.
//
// `fullRebuildMs` is one explicit cold pass at that window size: the cost a
// trim pays, and so the cost a step is amortized over. `trims` counts the
// flushes that produced a new list. `msPerEvent` is the whole flush.
const RESIDENT_STREAM_EVENTS = Number(process.env.RESIDENT_STREAM_EVENTS ?? 300);
const COPY_SHIFT_MS = 7 * 24 * 60 * 60 * 1000;

/** One more copy of a transcript, as a later stretch of the same chat. */
function tileCopy(source: AgentChatEventEnvelope[], copy: number): AgentChatEventEnvelope[] {
  const shift = copy * COPY_SHIFT_MS;
  return source.map((envelope) => {
    const event = { ...(envelope.event as unknown as Record<string, unknown>) };
    for (const key of ["turnId", "itemId", "logicalItemId"]) {
      const value = event[key];
      if (typeof value === "string" && value) event[key] = `${value}~${copy}`;
    }
    return {
      ...envelope,
      timestamp: new Date(Date.parse(envelope.timestamp) + shift).toISOString(),
      event,
    } as AgentChatEventEnvelope;
  });
}

function residentBytes(events: readonly AgentChatEventEnvelope[]): number {
  let total = 0;
  for (const event of events) total += estimatedChatEventResidentBytes(event);
  return total;
}

function tiledTo(
  source: AgentChatEventEnvelope[],
  target: { events?: number; bytes?: number },
): { events: AgentChatEventEnvelope[]; copies: number } {
  let events: AgentChatEventEnvelope[] = [];
  let copies = 0;
  for (;;) {
    events = events.concat(tileCopy(source, copies));
    copies += 1;
    if (target.events !== undefined && events.length >= target.events) break;
    if (target.bytes !== undefined && residentBytes(events) >= target.bytes) break;
  }
  return { events, copies };
}

/** The logical tool call an event belongs to, or null. */
function logicalToolItemKey(entry: AgentChatEventEnvelope): string | null {
  const event = entry.event as { type: string; turnId?: string; itemId?: string; logicalItemId?: string };
  if (event.type !== "tool_call" && event.type !== "tool_result") return null;
  const itemId = event.logicalItemId?.trim() || event.itemId?.trim();
  return itemId ? `${event.turnId ?? ""}\u0000${itemId}` : null;
}

function timestampsAreAscending(events: readonly AgentChatEventEnvelope[]): boolean {
  for (let index = 1; index < events.length; index += 1) {
    if (Date.parse(events[index]!.timestamp) < Date.parse(events[index - 1]!.timestamp)) return false;
  }
  return true;
}

function replayAtResidentCap(args: {
  scenario: string;
  base: AgentChatEventEnvelope[];
  stream: AgentChatEventEnvelope[];
  maxEvents: number;
  maxBytes: number;
  copies: number;
}): Record<string, unknown> {
  const { base, stream, maxEvents, maxBytes } = args;
  let events = mergeAgentChatLiveEvents([], base);
  let started = performance.now();
  let displayed = chatDisplayEvents(events);
  let state = collapseChatTranscriptEventsWithContext(displayed);
  const openMs = performance.now() - started;

  // One cold pass at this size: what a flush pays when it has to rebuild.
  started = performance.now();
  const coldEvents = events.slice();
  const coldDisplay = chatDisplayEvents(coldEvents);
  collapseChatTranscriptEventsWithContext(coldDisplay);
  const fullRebuildMs = performance.now() - started;

  let previousDisplayed = displayed;
  let mergeMs = 0;
  let trimMs = 0;
  let displayMs = 0;
  let rowsMs = 0;
  let worstStepMs = 0;
  let stepsOverFrame = 0;
  let trims = 0;
  let duplicates = 0;
  let mismatches = 0;
  let drops = 0;
  let missing = 0;
  let reordered = 0;
  let overBudget = 0;
  for (let index = 0; index < stream.length; index += 1) {
    const envelope = stream[index]!;
    const t0 = performance.now();
    const combined = mergeAgentChatLiveEvents(events, [envelope]);
    const t1 = performance.now();
    if (combined === events) {
      duplicates += 1;
      continue;
    }
    events = trimChatEventHistory(combined, maxEvents, maxBytes);
    const t2 = performance.now();
    if (events !== combined) trims += 1;
    displayed = chatDisplayEvents(events);
    const t3 = performance.now();
    state = collapseChatTranscriptEventsIncrementalWithContext(
      displayed,
      previousDisplayed,
      state.rows,
      state.context,
    );
    const t4 = performance.now();
    previousDisplayed = displayed;
    mergeMs += t1 - t0;
    trimMs += t2 - t1;
    displayMs += t3 - t2;
    rowsMs += t4 - t3;
    const step = t4 - t0;
    worstStepMs = Math.max(worstStepMs, step);
    if (step > FRAME_MS) stepsOverFrame += 1;
    if ((index + 1) % CHECK_EVERY === 0 || index === stream.length - 1) {
      if (JSON.stringify(collapseChatTranscriptEventsWithContext(displayed).rows) !== JSON.stringify(state.rows)) {
        mismatches += 1;
      }
      // The newest event is on screen, not queued behind a window that could
      // not take it. A repeated tool call is folded into its first entry (same
      // logical item) instead of appended, so it is on screen there rather than
      // last. An evicted newer event is caught by `missing` below.
      const newestKey = agentChatEventIdentityKey(envelope);
      const newestToolKey = logicalToolItemKey(envelope);
      const newestOnScreen = events[events.length - 1] === envelope
        || events.some((entry) => agentChatEventIdentityKey(entry) === newestKey
          || (newestToolKey !== null && logicalToolItemKey(entry) === newestToolKey));
      if (!newestOnScreen) drops += 1;
      if (!timestampsAreAscending(events)) reordered += 1;
      if (events.length > maxEvents || residentBytes(events) > maxBytes) overBudget += 1;
      // Every event of this run is still resident. A repeated tool call is
      // rewritten in place rather than appended, so it is matched by its
      // logical item as well as by its own identity.
      const identityKeys = new Set(events.map((entry) => agentChatEventIdentityKey(entry)));
      const toolKeys = new Set(events.map(logicalToolItemKey).filter((key) => key !== null));
      for (const streamed of stream.slice(0, index + 1)) {
        const toolKey = logicalToolItemKey(streamed);
        if (identityKeys.has(agentChatEventIdentityKey(streamed))) continue;
        if (toolKey !== null && toolKeys.has(toolKey)) continue;
        missing += 1;
      }
    }
  }
  const streamed = stream.length;
  const perEvent = (ms: number) => +(ms / streamed).toFixed(3);
  return {
    scenario: args.scenario,
    events: events.length,
    copies: args.copies,
    residentMB: +(residentBytes(events) / (1024 * 1024)).toFixed(1),
    rows: state.rows.length,
    streamed,
    openMs: +openMs.toFixed(1),
    fullRebuildMs: +fullRebuildMs.toFixed(1),
    mergeMsPerEvent: perEvent(mergeMs),
    trimMsPerEvent: perEvent(trimMs),
    displayMsPerEvent: perEvent(displayMs),
    rowsMsPerEvent: perEvent(rowsMs),
    msPerEvent: perEvent(mergeMs + trimMs + displayMs + rowsMs),
    worstStepMs: +worstStepMs.toFixed(1),
    stepsOverFrame,
    trims,
    duplicates,
    mismatches,
    drops,
    missing,
    reordered,
    overBudget,
  };
}

const residentSource = loadTranscript(largestTranscripts(5)[0]!);
const residentScenarios = [
  {
    scenario: "below-cap",
    ...tiledTo(residentSource, { events: residentSource.length }),
    maxEvents: MAX_SELECTED_CHAT_SESSION_RESIDENT_EVENTS,
    maxBytes: MAX_SELECTED_CHAT_SESSION_RESIDENT_BYTES,
  },
  {
    scenario: "at-byte-cap",
    ...tiledTo(residentSource, { bytes: MAX_SELECTED_CHAT_SESSION_RESIDENT_BYTES }),
    maxEvents: MAX_SELECTED_CHAT_SESSION_RESIDENT_EVENTS,
    maxBytes: MAX_SELECTED_CHAT_SESSION_RESIDENT_BYTES,
  },
  {
    // Diagnostic: no real payload reaches 60,000 events inside 32 MB, so the
    // count cap is measured on its own.
    scenario: "at-count-cap",
    ...tiledTo(residentSource, { events: MAX_SELECTED_CHAT_SESSION_RESIDENT_EVENTS }),
    maxEvents: MAX_SELECTED_CHAT_SESSION_RESIDENT_EVENTS,
    maxBytes: Number.POSITIVE_INFINITY,
  },
];
const residentRows = residentScenarios.map((scenario) => replayAtResidentCap({
  scenario: scenario.scenario,
  base: scenario.events,
  stream: tileCopy(residentSource, scenario.copies).slice(0, RESIDENT_STREAM_EVENTS),
  maxEvents: scenario.maxEvents,
  maxBytes: scenario.maxBytes,
  copies: scenario.copies,
}));
for (const row of residentRows) console.log(JSON.stringify(row));
if (residentRows.some((row) => (
  (row.mismatches as number) > 0
  || (row.drops as number) > 0
  || (row.missing as number) > 0
  || (row.reordered as number) > 0
  || (row.overBudget as number) > 0
  || (row.duplicates as number) > 0
))) process.exit(1);
