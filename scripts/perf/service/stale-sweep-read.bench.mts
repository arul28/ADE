// cd apps/ade-cli && npx tsx ../../scripts/perf/service/stale-sweep-read.bench.mts --project <copy root> [--runs 5] [--chats 3]
// What the chat stale-run sweep's timer pass costs per chat, the old way and the new way, on the largest
// transcripts of <copy root> (a make-real-load-copy copy):
//   full      the whole transcript read and parsed synchronously (readHistoryFileSync +
//             parseAgentChatTranscript), as the sync reconcile still does. All of it holds the event loop.
//   filtered  the timer pass's read: chunked async reads (readHistoryFileRange, 1 MB) and only the lines that
//             name one of STALE_RUN_EVENT_TYPES parsed, as agentChatService's scan does.
// Reports wall time and the longest event-loop block (a 1 ms timer beside the read) per path, and checks both
// reads give the same background and subagent snapshots. Prints each chat's median of <runs> with the worst.
import path from "node:path";
import { flag, median, requireCopyRoot } from "./bench-kit.mts";
import { largestTranscripts } from "./transcript-files.mts";

const root = requireCopyRoot(flag("--project"));
process.env.ADE_PROJECT_ROOT = root;
const runs = Number(flag("--runs") ?? 5);
const chats = Number(flag("--chats") ?? 3);

const { readHistoryFileRange, readHistoryFileSize, readHistoryFileSync } = await import("../../../apps/desktop/src/main/services/storage/historyCompression");
const { parseAgentChatTranscript } = await import("../../../apps/desktop/src/shared/chatTranscript");
const { deriveBackgroundItems } = await import("../../../apps/desktop/src/shared/chatScheduledWork");
const { subagentSnapshotsFromEvents } = await import("../../../apps/desktop/src/shared/chatSubagents");
const { STALE_RUN_EVENT_TYPES } = await import("../../../apps/desktop/src/main/services/chat/chatStaleRunSweep");

const CHUNK_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const needles = STALE_RUN_EVENT_TYPES.map((type) => Buffer.from(`"${type}"`));
type Envelope = ReturnType<typeof parseAgentChatTranscript>[number];

const snapshots = (envelopes: Envelope[]) =>
  JSON.stringify([deriveBackgroundItems(envelopes), subagentSnapshotsFromEvents(envelopes)]);

/** Runs `work` with a 1 ms timer beside it; returns its wall time and the longest gap between ticks. */
async function timed<T>(work: () => Promise<T> | T): Promise<{ value: T; wallMs: number; blockMs: number }> {
  let last = performance.now();
  let worst = 0;
  const tick = setInterval(() => {
    const at = performance.now();
    worst = Math.max(worst, at - last);
    last = at;
  }, 1);
  const started = performance.now();
  last = started;
  const value = await work();
  const done = performance.now();
  worst = Math.max(worst, done - last);
  clearInterval(tick);
  return { value, wallMs: done - started, blockMs: worst };
}

async function filteredRead(file: string, sessionId: string): Promise<{ envelopes: Envelope[]; complete: boolean }> {
  const size = await readHistoryFileSize(file);
  const envelopes: Envelope[] = [];
  let complete = true;
  let offset = 0;
  let carry = Buffer.alloc(0);
  const visit = (line: Buffer) => {
    if (line.length > MAX_LINE_BYTES) complete = false;
    if (line.length === 0 || line.length > MAX_LINE_BYTES) return;
    if (!needles.some((needle) => line.includes(needle))) return;
    for (const envelope of parseAgentChatTranscript(line.toString("utf8"))) if (envelope.sessionId === sessionId) envelopes.push(envelope);
  };
  while (offset < size) {
    const chunk = await readHistoryFileRange(file, offset, Math.min(CHUNK_BYTES, size - offset));
    if (chunk.length === 0) break;
    offset += chunk.length;
    const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let start = 0;
    for (let newline = buffer.indexOf(0x0a); newline >= 0; newline = buffer.indexOf(0x0a, start)) {
      visit(buffer.subarray(start, newline));
      start = newline + 1;
    }
    carry = buffer.subarray(start);
  }
  if (carry.length) visit(carry);
  return { envelopes, complete };
}

for (const file of largestTranscripts(chats)) {
  const sessionId = path.basename(file).replace(/\.jsonl(\.gz)?$/, "").replace(/\.chat$/, "");
  const full: Array<{ wallMs: number; blockMs: number }> = [];
  const filtered: Array<{ wallMs: number; blockMs: number }> = [];
  let same = true;
  let complete = true;
  let events = 0;
  let kept = 0;
  for (let run = 0; run < runs; run++) {
    const a = await timed(() => parseAgentChatTranscript(readHistoryFileSync(file).toString("utf8")).filter((e) => e.sessionId === sessionId));
    const b = await timed(() => filteredRead(file, sessionId));
    full.push(a);
    filtered.push(b);
    same &&= snapshots(a.value) === snapshots(b.value.envelopes);
    complete &&= b.value.complete;
    events = a.value.length;
    kept = b.value.envelopes.length;
  }
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const stat = (rows: Array<{ wallMs: number; blockMs: number }>, key: "wallMs" | "blockMs") =>
    `${r1(median(rows.map((row) => row[key])))} (${r1(Math.max(...rows.map((row) => row[key])))})`;
  console.log(JSON.stringify({
    chat: sessionId.slice(0, 8),
    decompressedMB: r1((await readHistoryFileSize(file)) / 1e6),
    events,
    eventsParsedFiltered: kept,
    sameSnapshots: same,
    filteredSawWholeFile: complete,
    fullWallMs: stat(full, "wallMs"),
    fullBlockMs: stat(full, "blockMs"),
    filteredWallMs: stat(filtered, "wallMs"),
    filteredBlockMs: stat(filtered, "blockMs"),
  }));
}
process.exit(0);
