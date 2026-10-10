// cd apps/ade-cli && npx tsx ../../scripts/perf/service/chat-transcript.bench.mts [file.chat.jsonl ...]
// What the chat renderer pays to turn a transcript into rows, without the app.
// For each transcript: one full pass over all but the last 500 events (a chat
// opening), then the last 500 one at a time through the live merge, the
// display filter and the incremental row builder (a turn streaming). Every
// 50 events the incremental rows are checked against a full pass.
// `stepsOverFrame` counts streamed events that cost more than 4 ms.
// With no argument: the five largest files in <project>/.ade/transcripts, where
// <project> is $ADE_PROJECT_ROOT or the checkout this script is in.
// Transcripts are only read.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentChatEventEnvelope } from "../../../apps/desktop/src/shared/types/chat";
import { mergeAgentChatLiveEvents } from "../../../apps/desktop/src/shared/chatHistoryMerge";
import { chatDisplayEvents } from "../../../apps/desktop/src/renderer/components/chat/chatHistoryWindow";
import {
  collapseChatTranscriptEventsIncrementalWithContext,
  collapseChatTranscriptEventsWithContext,
} from "../../../apps/desktop/src/renderer/components/chat/chatTranscriptRows";

const STREAMED_EVENTS = 500;
const CHECK_EVERY = 50;
/** One frame at 240 Hz: a step over this drops a frame on a fast display. */
const FRAME_MS = 4;

function defaultTranscripts(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const checkout = path.resolve(here, "../../..");
  // A lane worktree lives under <project>/.ade/worktrees/<lane>.
  const marker = `${path.sep}.ade${path.sep}worktrees${path.sep}`;
  const project = process.env.ADE_PROJECT_ROOT
    ?? (checkout.includes(marker) ? checkout.slice(0, checkout.indexOf(marker)) : checkout);
  const dir = path.join(project, ".ade", "transcripts");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".chat.jsonl"))
    .map((name) => path.join(dir, name))
    .map((file) => ({ file, size: statSync(file).size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 5)
    .map((entry) => entry.file);
}

function load(file: string): AgentChatEventEnvelope[] {
  return readFileSync(file, "utf8").split("\n").flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed?.event?.type ? [parsed as AgentChatEventEnvelope] : [];
    } catch {
      return [];
    }
  });
}

const files = process.argv.slice(2).length ? process.argv.slice(2) : defaultTranscripts();
const rows: Record<string, unknown>[] = [];
for (const file of files) {
  const envelopes = load(file);
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
