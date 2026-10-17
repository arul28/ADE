// cd apps/desktop && ./node_modules/.bin/vite-node ../../scripts/perf/web/web-chat-load.bench.mts -- --transcript <file.chat.jsonl> [--runs 3] [--rtt 80,150] [--bw 4] [--root <apps/desktop dir>]
//
// What a hosted web client pays to open a long remote chat, through the REAL
// web adapter (createAdeWebAdapter -> agentChat namespace -> CommandCaller ->
// sync client seam), against a fake relay with injected latency and a
// downstream bandwidth cap. The fake brain answers the two history commands
// with the real pager (readTranscriptHistoryPage) and the brain's response
// budget (min(8 MB, requested maxBytes)) and tail windowing.
//
// The renderer's open sequence is replayed the way AgentChatPane and the
// message list drive it: one getEventHistory (1000 events / 256 KB asked, the
// adapter clamps to its own caps), then getEventHistoryPage one page at a time
// from the snapshot's tailStartOffset until the head. The idle-slot gate the
// message list puts in front of each backfill page is NOT modelled (it needs a
// real browser), so "settled" here is the transport + adapter floor, not the
// full in-app time. Renderer row/paint cost is not measured here either.
//
// Parity: the assembled history must equal the file's own envelope list
// (same count, same order, same identities). A mismatch is reported as a bug.
//
// Output: one JSON row per run, then a median summary per (rtt, bw).
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Envelope = { sessionId: string; timestamp: string; event: { type: string }; sequence?: number };

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1]! : fallback;
};
const transcriptFile = flag("--transcript", "");
if (!transcriptFile) throw new Error("--transcript <file.chat.jsonl> is required");
const runs = Math.max(1, Number(flag("--runs", "3")));
const rtts = flag("--rtt", "80,150").split(",").map(Number);
const bandwidths = flag("--bw", "4").split(",").map(Number); // MB/s downstream; 0 = unlimited
const desktopRoot = path.resolve(flag("--root", path.join(process.cwd(), ".")));

// Desktop renderer asks for these (chatHistoryWindow.ts). The web adapter clamps them to its caps.
const RENDERER_INITIAL_EVENTS = 1_000;
const RENDERER_PAGE_BYTES = 256 * 1024;
const BRAIN_RESPONSE_MAX_CHARS = 8_000_000;
const BRAIN_RESPONSE_MAX_PER_SESSION = 20_000;
const SUBSCRIBE_SNAPSHOT_BYTES_WEB = 128 * 1024; // web adapter, ensureChatSubscription

const { readTranscriptHistoryPage } = await import(
  pathToFileURL(path.join(desktopRoot, "src/main/services/chat/chatTranscriptHistoryPager.ts")).href
);
const { createAdeWebAdapter } = await import(
  pathToFileURL(path.join(desktopRoot, "src/renderer/webclient/adapter/index.ts")).href
);

const sessionId = (JSON.parse(readFileSync(transcriptFile, "utf8").split("\n")[0]!) as Envelope).sessionId;
const fileBytes = statSync(transcriptFile).size;
const fileEnvelopes = readFileSync(transcriptFile, "utf8").split("\n").flatMap((line) => {
  try {
    const parsed = JSON.parse(line) as Envelope;
    return parsed?.event?.type ? [parsed] : [];
  } catch {
    return [];
  }
});
const identityOf = (envelope: Envelope) => createHash("sha1").update(JSON.stringify(envelope)).digest("hex");
const fileIdentities = fileEnvelopes.map(identityOf);

/** The brain's history snapshot: tail window of `responseBytes`, newest `maxEvents`, byte budget applied. */
async function brainTail(maxEvents: number, requestedMaxBytes: number) {
  const responseMaxChars = Math.max(1_024, Math.min(BRAIN_RESPONSE_MAX_CHARS, requestedMaxBytes));
  const size = statSync(transcriptFile).size;
  const tail = await readTranscriptHistoryPage({
    transcriptPath: transcriptFile,
    sessionId,
    beforeOffset: size,
    maxBytes: responseMaxChars,
  });
  const cap = Math.min(maxEvents, BRAIN_RESPONSE_MAX_PER_SESSION);
  let start = Math.max(0, tail.envelopes.length - cap);
  let bytes = 0;
  for (let index = tail.envelopes.length - 1; index >= start; index -= 1) {
    bytes += Buffer.byteLength(JSON.stringify(tail.envelopes[index]), "utf8");
    if (bytes > responseMaxChars) {
      start = index + 1;
      break;
    }
  }
  const events = tail.envelopes.slice(start);
  const windowTruncated = start > 0;
  const tailStartOffset = events.length && start < tail.envelopeStartOffsets.length
    ? tail.envelopeStartOffsets[start]!
    : null;
  return {
    sessionId,
    events,
    truncated: tail.hasMore || windowTruncated,
    hasOlderHistory: tail.hasMore || windowTruncated,
    sessionFound: true,
    tailStartOffset: tailStartOffset && tailStartOffset > 0 ? tailStartOffset : null,
  };
}

/** Relay model: one request up, the brain answers, the response queues on one downstream pipe. */
function makeRelay(rttMs: number, bandwidthMBps: number) {
  let downFreeAt = 0;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  return {
    requests: 0,
    bytesIn: 0,
    async respond<T>(compute: () => Promise<T>): Promise<T> {
      this.requests += 1;
      await sleep(rttMs / 2);
      const value = await compute();
      const bytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
      this.bytesIn += bytes;
      const now = performance.now();
      const start = Math.max(now, downFreeAt);
      const transferMs = bandwidthMBps > 0 ? (bytes / (bandwidthMBps * 1024 * 1024)) * 1000 : 0;
      downFreeAt = start + transferMs;
      await sleep(downFreeAt - now + rttMs / 2);
      return value;
    },
  };
}

function fakeSyncClient(relay: ReturnType<typeof makeRelay>, stats: { snapshotCpuMs: number; snapshotEvents: number; snapshotBytes: number }) {
  const descriptor = (action: string) => ({ action, scope: "project", policy: { viewerAllowed: true } });
  const actions = ["chat.getChatEventHistory", "chat.getChatEventHistoryPage"];
  const base: Record<string, unknown> = {
    activeProjectId: "project-1",
    getCommandDescriptors: () => actions.map(descriptor),
    sendCommand: async (action: string, args: Record<string, unknown>) => relay.respond(async () => {
      if (action === "chat.getChatEventHistory") {
        return brainTail(Number(args.maxEvents), Number(args.maxBytes));
      }
      if (action === "chat.getChatEventHistoryPage") {
        const page = await readTranscriptHistoryPage({
          transcriptPath: transcriptFile,
          sessionId,
          beforeOffset: Number(args.beforeOffset),
          maxBytes: Number(args.maxBytes),
        });
        return { sessionId, events: page.envelopes, envelopeStartOffsets: page.envelopeStartOffsets, startOffset: page.startOffset, hasMore: page.hasMore, sessionFound: true };
      }
      throw new Error(`unexpected action ${action}`);
    }),
    // The web client pushes the subscribe snapshot down the same pipe. The adapter
    // runs every snapshot event through its dedup hash, so that CPU is timed here.
    subscribeChat: (_sid: string, opts: { maxBytes?: number }, handlers: { snapshot?: (p: unknown) => void }) => {
      void relay.respond(async () => {
        const snapshot = await brainTail(BRAIN_RESPONSE_MAX_PER_SESSION, Number(opts.maxBytes ?? SUBSCRIBE_SNAPSHOT_BYTES_WEB));
        return {
          sessionId,
          capturedAt: new Date(0).toISOString(),
          truncated: snapshot.truncated,
          tailStartOffset: snapshot.tailStartOffset ?? undefined,
          hasOlderHistory: snapshot.hasOlderHistory,
          events: snapshot.events.map((event) => ({ sessionId, seq: event.sequence, sequence: event.sequence, timestamp: event.timestamp, event: event.event })),
        };
      }).then((payload) => {
        const started = performance.now();
        handlers.snapshot?.(payload);
        stats.snapshotCpuMs += performance.now() - started;
        stats.snapshotEvents += (payload as { events: unknown[] }).events.length;
        stats.snapshotBytes += Buffer.byteLength(JSON.stringify(payload), "utf8");
      });
      return () => undefined;
    },
    onChatEvent: () => () => undefined,
    onTablesChanged: () => () => undefined,
    getProjectCatalog: async () => ({ projects: [] }),
    getStatus: () => ({ state: "connected", activeProjectId: "project-1" }),
    subscribe: () => () => undefined,
  };
  return new Proxy(base, {
    get: (target, key: string) => (key in target ? target[key] : () => () => undefined),
  });
}

type Row = {
  rttMs: number;
  bwMBps: number;
  run: number;
  firstPaintMs: number;
  settledMs: number;
  requests: number;
  pages: number;
  bytesIn: number;
  subscribeEvents: number;
  subscribeBytes: number;
  subscribeCpuMs: number;
  loadedEvents: number;
  parity: "ok" | string;
};

async function openOnce(rttMs: number, bwMBps: number, run: number): Promise<Row> {
  const relay = makeRelay(rttMs, bwMBps);
  const stats = { snapshotCpuMs: 0, snapshotEvents: 0, snapshotBytes: 0 };
  const adapter = createAdeWebAdapter(fakeSyncClient(relay, stats) as never);
  adapter.bindProject({ rootPath: "/repo", displayName: "Repo", baseRef: "main" }, "project-1");
  const agentChat = adapter.ade.agentChat!;

  const started = performance.now();
  const snapshot = await agentChat.getEventHistory!({
    sessionId,
    maxEvents: RENDERER_INITIAL_EVENTS,
    maxBytes: RENDERER_PAGE_BYTES,
  } as never);
  const firstPaintMs = performance.now() - started;
  // Older pages are prepended, so the loaded list is [oldest pages ..., snapshot].
  const olderChunks: Envelope[][] = [];
  let cursor = (snapshot as { tailStartOffset?: number | null }).tailStartOffset ?? 0;
  let pages = 0;
  while (cursor > 0) {
    const page = await agentChat.getEventHistoryPage!({
      sessionId,
      beforeOffset: cursor,
      maxBytes: RENDERER_PAGE_BYTES,
    } as never) as { events: Envelope[]; startOffset: number; hasMore: boolean };
    pages += 1;
    olderChunks.unshift(page.events);
    if (page.startOffset >= cursor) throw new Error("cursor did not move toward the head");
    cursor = page.startOffset;
  }
  const settledMs = performance.now() - started;
  const loaded = [...olderChunks.flat(), ...(snapshot as { events: Envelope[] }).events];
  const loadedIdentities = loaded.map(identityOf);
  // Compare as a multiset-with-order: the snapshot is the tail of the file, so the tail must match exactly.
  const tailMatches = loadedIdentities.length <= fileIdentities.length
    && loadedIdentities.every((id, index) => id === fileIdentities[fileIdentities.length - loadedIdentities.length + index]);
  const parity = loadedIdentities.length === fileIdentities.length && tailMatches
    ? "ok"
    : `mismatch: loaded ${loadedIdentities.length}, file ${fileIdentities.length}, tailMatches ${tailMatches}`;

  return {
    rttMs,
    bwMBps,
    run,
    firstPaintMs: round(firstPaintMs),
    settledMs: round(settledMs),
    requests: relay.requests,
    pages,
    bytesIn: relay.bytesIn,
    subscribeEvents: stats.snapshotEvents,
    subscribeBytes: stats.snapshotBytes,
    subscribeCpuMs: round(stats.snapshotCpuMs),
    loadedEvents: loaded.length,
    parity,
  };
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const rows: Row[] = [];
console.error(`transcript ${path.basename(transcriptFile)}: ${fileEnvelopes.length} envelopes, ${fileBytes} bytes; root ${desktopRoot}`);
// Untimed warm-up so module loading and the first JIT pass stay out of run 1.
await openOnce(0, 0, 0);
for (const rttMs of rtts) {
  for (const bwMBps of bandwidths) {
    for (let run = 1; run <= runs; run += 1) {
      const row = await openOnce(rttMs, bwMBps, run);
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
}

console.log("== medians (ms unless noted)");
for (const rttMs of rtts) {
  for (const bwMBps of bandwidths) {
    const group = rows.filter((row) => row.rttMs === rttMs && row.bwMBps === bwMBps);
    const pick = (key: keyof Row) => median(group.map((row) => Number(row[key])));
    console.log(JSON.stringify({
      rttMs,
      bwMBps,
      runs: group.length,
      firstPaintMs: round(pick("firstPaintMs")),
      settledMs: round(pick("settledMs")),
      requests: pick("requests"),
      pages: pick("pages"),
      bytesIn: pick("bytesIn"),
      subscribeBytes: pick("subscribeBytes"),
      subscribeCpuMs: round(pick("subscribeCpuMs")),
      loadedEvents: pick("loadedEvents"),
      fileEvents: fileEnvelopes.length,
      parityFailures: group.filter((row) => row.parity !== "ok").length,
    }));
  }
}
