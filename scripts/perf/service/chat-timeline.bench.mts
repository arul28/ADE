// cd apps/ade-cli && npx tsx ../../scripts/perf/service/chat-timeline.bench.mts --project <copy root> [--chat <id>] [--runs 5]
//   [--scenario stream-1000|rebuild|tool-done] (default: all three; one scenario keeps a CPU profile to it)
// Three chat timeline costs, each against an outside target, on a project's real
// transcripts (read with transcript-files.mts; only read). Every scenario runs two warm-ups, then --runs measured runs from a
// fresh state, and prints the median with the slowest run.
//
//   stream-1000: 1,000 events loaded, then 200 streamed updates, each through
//     the live merge, the display filter and the incremental row builder; total
//     ms for the 200 (target: 15.48 ms per 200 updates at 1,000 items).
//   rebuild: one full pass (display filter + row builder) over the chat's whole
//     history (target: 8.6 ms at ~15.7k items / 10,336 entries).
//   tool-done: one tool_result applied to the full chat, the step a running tool
//     pays when it completes (target: 0.28 ms). The 20 newest tool_results are
//     each applied to the history before them.
//
// The chat for rebuild and tool-done is --chat, else the transcript closest to
// 15,700 events. stream-1000 uses every transcript with at least 1,200 events
// (at most five, the largest first).
import path from "node:path";
import { mergeAgentChatLiveEvents } from "../../../apps/desktop/src/shared/chatHistoryMerge";
import { chatDisplayEvents } from "../../../apps/desktop/src/renderer/components/chat/chatHistoryWindow";
import {
  collapseChatTranscriptEventsIncrementalWithContext,
  collapseChatTranscriptEventsWithContext,
} from "../../../apps/desktop/src/renderer/components/chat/chatTranscriptRows";
import { largestTranscripts, loadTranscript } from "./transcript-files.mts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const project = flag("--project");
if (!project) throw new Error("usage: chat-timeline.bench.mts --project <copy root> [--chat <id>] [--runs 5]");
const runs = Number(flag("--runs") ?? 5);
const only = flag("--scenario");
const wants = (scenario: string) => !only || only === scenario;
const WARMUPS = 2;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const round = (x: number, digits = 2) => +x.toFixed(digits);

/** Two warm-ups, then `runs` measured; each call of `once` returns its own ms. */
function measure(once: () => number): { medianMs: number; worstMs: number; runsMs: number[] } {
  for (let i = 0; i < WARMUPS; i += 1) once();
  const ms: number[] = [];
  for (let i = 0; i < runs; i += 1) ms.push(once());
  return { medianMs: round(median(ms), 3), worstMs: round(Math.max(...ms), 3), runsMs: ms.map((x) => round(x, 3)) };
}

// Load the 12 largest transcripts (and --chat, wherever it ranks).
const chatFlag = flag("--chat");
const sized = largestTranscripts(chatFlag ? Number.POSITIVE_INFINITY : 12, project)
  .filter((file, rank) => rank < 12 || (chatFlag !== undefined && path.basename(file).startsWith(chatFlag)))
  .map((file) => ({ file, events: loadTranscript(file) }))
  .sort((a, b) => b.events.length - a.events.length);
if (!sized.length) throw new Error(`no chat transcripts in ${path.join(project, ".ade", "transcripts")}`);

const id = (file: string) => path.basename(file).slice(0, 8);

// stream-1000
for (const { file, events: envelopes } of wants("stream-1000") ? sized.filter((entry) => entry.events.length >= 1_200).slice(0, 5) : []) {
  const base = envelopes.slice(0, 1_000);
  const stream = envelopes.slice(1_000, 1_200);
  const result = measure(() => {
    let events = mergeAgentChatLiveEvents([], base);
    let displayed = chatDisplayEvents(events);
    let state = collapseChatTranscriptEventsWithContext(displayed);
    const started = performance.now();
    for (const envelope of stream) {
      const next = mergeAgentChatLiveEvents(events, [envelope]);
      if (next === events) continue;
      events = next;
      const nextDisplayed = chatDisplayEvents(events);
      state = collapseChatTranscriptEventsIncrementalWithContext(nextDisplayed, displayed, state.rows, state.context);
      displayed = nextDisplayed;
    }
    return performance.now() - started;
  });
  console.log(JSON.stringify({ scenario: "stream-1000", chat: id(file), updates: stream.length, ...result, targetMs: 15.48 }));
}

// rebuild + tool-done on one long chat
const chosenId = chatFlag;
const target = chosenId
  ? sized.find((entry) => path.basename(entry.file).startsWith(chosenId))
  : [...sized].sort((a, b) => Math.abs(a.events.length - 15_700) - Math.abs(b.events.length - 15_700))[0];
if (!target) throw new Error(`no transcript ${chosenId} in ${project}`);
const all = mergeAgentChatLiveEvents([], target.events);
const displayedAll = chatDisplayEvents(all);
if (wants("rebuild")) {
const rebuild = measure(() => {
  const started = performance.now();
  collapseChatTranscriptEventsWithContext(chatDisplayEvents(all));
  return performance.now() - started;
});
const rowCount = collapseChatTranscriptEventsWithContext(displayedAll).rows.length;
console.log(JSON.stringify({
  scenario: "rebuild",
  chat: id(target.file),
  events: all.length,
  displayEvents: displayedAll.length,
  rows: rowCount,
  ...rebuild,
  targetMs: 8.6,
}));
}

// The history before each result is built the way the pane holds it: opened
// STREAM_LEAD events earlier, then streamed in one event at a time, so the list
// carries the live merge's index and the collapse its checkpoints where a live
// chat has them. (A plain slice would make the merge rebuild its index, and
// opening right before the result would put a checkpoint on the measured step;
// the pane does neither.) The merge index moves to each merged list, so every
// run builds its own history.
const STREAM_LEAD = 300;
const raw = target.events;
const toolResults = !wants("tool-done") ? [] : raw
  .map((envelope, index) => ({ envelope, index }))
  .filter(({ envelope, index }) => envelope.event.type === "tool_result" && index > STREAM_LEAD)
  .slice(-20);
const perResult: number[] = [];
const perResultWorst: number[] = [];
for (const { index } of toolResults) {
  const step = measure(() => {
    let events = mergeAgentChatLiveEvents([], raw.slice(0, index - STREAM_LEAD));
    let displayed = chatDisplayEvents(events);
    let state = collapseChatTranscriptEventsWithContext(displayed);
    for (let lead = index - STREAM_LEAD; lead < index; lead += 1) {
      const next = mergeAgentChatLiveEvents(events, [raw[lead]!]);
      if (next === events) continue;
      events = next;
      const nextDisplayed = chatDisplayEvents(events);
      state = collapseChatTranscriptEventsIncrementalWithContext(nextDisplayed, displayed, state.rows, state.context);
      displayed = nextDisplayed;
    }
    const started = performance.now();
    const next = mergeAgentChatLiveEvents(events, [raw[index]!]);
    collapseChatTranscriptEventsIncrementalWithContext(chatDisplayEvents(next), displayed, state.rows, state.context);
    return performance.now() - started;
  });
  perResult.push(step.medianMs);
  perResultWorst.push(step.worstMs);
}
if (wants("tool-done")) console.log(JSON.stringify({
  scenario: "tool-done",
  chat: id(target.file),
  events: all.length,
  toolResults: perResult.length,
  medianMs: perResult.length ? round(median(perResult), 3) : null,
  // Median over the results of each result's median run; worst single run over all.
  worstMs: perResultWorst.length ? round(Math.max(...perResultWorst), 3) : null,
  targetMs: 0.28,
}));
