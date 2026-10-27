// cd apps/ade-cli && npx tsx ../../scripts/perf/net/phone-sync.bench.mts <command> [options]
//
// A headless "phone": it speaks ADE's sync protocol the way the iOS app does (apps/ios/ADE/Services/
// SyncService.swift) and times each step of a connect through the slow-network proxy
// (scripts/perf/net/slow-proxy.mjs). Same hello peer metadata and capabilities, same post-hello requests
// and arguments, the same per-envelope deflate and binary frames (iOS cannot negotiate permessage-deflate,
// so neither does this client), and a changeset_ack for every batch.
//
// Commands:
//   pair      --target host:port --pin 123456 --state <file>     PIN-pair once; writes the device's secret
//   cold      --target ... --state <file> [--profile 3g|lte|lan] [--runs 3] [--project <id>] [--chat <id>]
//   reconnect (same options)  warm cursor: one cold connect to fill the cache, then timed reconnects
//   all       (same options)  cold + reconnect for each of --profiles 3g,lte,lan, interleaved runs
//   summarize <runs.jsonl>... medians of runs appended with --json <runs.jsonl> (run one per heavy lock)
//
// --phone new|legacy (default new). legacy copies the iOS app before the P1 phone work: it drops its
// roster seq on every disconnect, sends no commandRoutingDigest, and always asks for the catalog after
// hello. new copies the current app: it keeps the roster seq (sent as sinceSeq), sends the saved
// commandRoutingDigest, skips the catalog request when hello_ok carried the catalog, asks for the
// conditional work list, and declares rosterChatDeltaV1 (per-chat roster deltas). Against an older
// brain both behave the same (the brain ignores what it does not know).
//
// --during-drop "<shell command>" runs while the reconnecting phone is away (after the 5 s drop), e.g. a
// measurement-brain CLI call that renames one chat, so the reconnect finds a project that changed.
//
// Run it only against a measurement brain on its own HOME and socket (scripts/perf/net/README.md),
// never against the machine's brain or 8787.
//
// What "cold" means: the phone was paired and knows its project, but has no replica (dbVersion 0), no
// roster seq, no lane signature and no chat cursor: a fresh install or a cleared cache.
// What "reconnect" means: the same phone after a dropped link, holding everything the cold connect gave it.
//
// Steps timed from the moment the socket starts to open:
//   helloOk       hello_ok received (socket open + hello round trip)
//   projectRow    the phone's project-row gate passes: the replica has the projects row. iOS polls this
//                 gate every 200 ms (InitialHydrationGate), so this client polls on the same 200 ms grid
//   workList      work.listSessions answered: the Work screen shows (it waits on the work domain only)
//   workUsable    lanes.refreshSnapshots and work.listSessions both answered (they start after the gate)
//   caughtUp      the host has delivered everything up to hello_ok's serverDbVersion: a batch reaching it,
//                 or brain_status reporting this phone's lag past it (the host skips versions it
//                 filters for phones without sending anything)
//   roster        first roster_snapshot (or roster_delta) after roster_subscribe
//   catalog       the post-hello project_catalog_request answered
//   chat          chat_subscribe answered for the biggest chat (opened as soon as Work is usable)
//   prs           prs.list, then prs.refresh for active PRs, answered
//   done          the last of the above, except caughtUp: a phone is usable before its replica is
//                 complete, and a big backlog can take minutes. caughtUp keeps running until
//                 --catchup-cap-ms (default 120 s); past the cap the run records how far behind it was.
// Bytes: per message type, wire bytes (what crossed the socket, frames as sent) and decoded bytes (JSON
// the client parses). Proxy totals cover everything on the TCP connection, WebSocket framing included.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  createSyncEnvelopeChunkAssembler,
  encodeSyncEnvelopeFrames,
  parseSyncEnvelopeChunkPayload,
  parseSyncEnvelopeFrame,
  syncFrameByteLength,
} from "../../../apps/ade-cli/src/services/sync/syncProtocol";
// @ts-expect-error plain ESM helper without types
import { startSlowProxy, NETWORK_PROFILES } from "./slow-proxy.mjs";

// `ws` lives in apps/ade-cli's node_modules, not next to this script.
const WebSocket = createRequire(path.resolve(import.meta.dirname, "../../../apps/ade-cli/package.json"))("ws") as typeof import("ws").default;
type WebSocket = import("ws").default;

type Options = {
  command: string;
  target: { host: string; port: number };
  state: string;
  pin: string | null;
  profiles: string[];
  runs: number;
  project: string | null;
  chat: string | null;
  json: string | null;
  timeoutMs: number;
  catchupCapMs: number;
  phone: "new" | "legacy";
  duringDrop: string | null;
  relaunchBefore: boolean;
};

type PhoneState = {
  deviceId: string;
  secret: string | null;
  siteId: string;
  projectId: string | null;
  projectRootPath: string | null;
  /** A caught-up phone's cursors, kept between invocations so a reconnect run needs no fill. */
  warmCache?: WarmCache | null;
};

type WarmCache = {
  dbVersion: number;
  serverDbSiteId: string | null;
  rosterSeq: number | null;
  laneSignature: string | null;
  chatSinceSeq: number | null;
  chatSinceSequence: number | null;
  chatGeneration: string | null;
  commandRoutingDigest?: string | null;
  workSignature?: string | null;
  /** The full work list behind workSignature, so a delta reply can be applied. */
  workRows?: Array<Record<string, unknown>> | null;
  prsSignature?: string | null;
  lastHandshakeMs?: number | null;
  prsRows?: Array<Record<string, unknown>> | null;
  projectCatalogDigest?: string | null;
};

type TypeBytes = Record<string, { frames: number; messages: number; wireBytes: number; decodedBytes: number }>;

type RunResult = {
  scenario: "cold" | "reconnect";
  profile: string;
  run: number;
  ms: Record<string, number | null>;
  down: TypeBytes;
  up: TypeBytes;
  proxy: { connections: number; upBytes: number; downBytes: number };
  decodedDownBytes: number;
  wireDownBytes: number;
  requests: number;
  changesetBatches: number;
  changesetRows: number;
  /** Versions between the phone's cursor and hello_ok's serverDbVersion. */
  versionsBehindAtHello: number;
  /** Still behind hello_ok's serverDbVersion when the catch-up cap ran out (null when caught up). */
  versionsBehindAtCap: number | null;
  chatSessionId: string | null;
  notes: string[];
  /** Bytes down (proxy) when the chat's first page had arrived. */
  downBytesAtChat?: number | null;
  /** Wire bytes of the envelopes received when the chat showed (downBytesAtChat counts proxy ingress). */
  receivedBytesAtChat?: number | null;
};

const PHONE_CAPABILITIES = [
  "changesetAck",
  "chunkedEnvelopes",
  "relayReauthorizeV1",
  "binaryEnvelopes",
  "foldedReplay",
  "mobileChatSlimV1",
];
const CHAT_SUBSCRIBE_MAX_BYTES = 256 * 1024; // syncChatSubscriptionMaxBytes
const WEAK_LINK_CHAT_SUBSCRIBE_MAX_BYTES = 96 * 1024; // syncWeakLinkChatSubscriptionMaxBytes
const WEAK_LINK_HANDSHAKE_MS = 700; // syncLinkIsWeak
const PROJECT_ROW_POLL_MS = 200; // InitialHydrationGate

function parseArgs(argv: string[]): Options {
  const [command = "all", ...rest] = argv;
  const read = (name: string): string | null => {
    const index = rest.indexOf(name);
    return index >= 0 ? rest[index + 1] ?? null : null;
  };
  const targetText = read("--target");
  if (!targetText) throw new Error("--target host:port (the measurement brain's sync port) is required");
  const colon = targetText.lastIndexOf(":");
  const target = { host: colon > 0 ? targetText.slice(0, colon) : "127.0.0.1", port: Number(targetText.slice(colon + 1)) };
  if (target.port === 8787) throw new Error("Refusing to measure 8787: that is the machine brain. Use a measurement brain.");
  const profiles = (read("--profiles") ?? read("--profile") ?? "3g,lte,lan").split(",").map((p) => p.trim()).filter(Boolean);
  for (const profile of profiles) if (!NETWORK_PROFILES[profile]) throw new Error(`Unknown profile ${profile}`);
  return {
    command,
    target,
    state: read("--state") ?? path.join(os.tmpdir(), "ade-phone-sync-state.json"),
    pin: read("--pin"),
    profiles,
    runs: Math.max(1, Number(read("--runs") ?? 3)),
    project: read("--project"),
    chat: read("--chat"),
    json: read("--json"),
    timeoutMs: Number(read("--timeout-ms") ?? 180_000),
    catchupCapMs: Number(read("--catchup-cap-ms") ?? 120_000),
    phone: read("--phone") === "legacy" ? "legacy" : "new",
    duringDrop: read("--during-drop"),
    relaunchBefore: rest.includes("--relaunch-before"),
  };
}

function loadState(file: string): PhoneState {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as PhoneState;
  return { deviceId: randomUUID().toUpperCase(), secret: null, siteId: randomUUID().replace(/-/g, ""), projectId: null, projectRootPath: null };
}

function saveState(file: string, state: PhoneState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function peerMetadata(state: PhoneState, dbVersion: number, serverDbSiteId: string | null, newPhone = false): Record<string, unknown> {
  return {
    deviceId: state.deviceId,
    deviceName: "ADE perf phone",
    platform: "iOS",
    deviceType: "phone",
    siteId: state.siteId,
    dbVersion,
    capabilities: newPhone ? [...PHONE_CAPABILITIES, "rosterChatDeltaV1", "changesetAckWindowV1", "rosterPrioritySnapshotV1", "rosterChatPagesV1", "commandRoutingGroupsV1"] : PHONE_CAPABILITIES,
    appVersion: "perf",
    appBuild: "perf",
    bundleIdentifier: "com.ade.ios.perf",
    connectionAttempt: { id: randomUUID().toUpperCase(), startedAtMs: Date.now() },
    ...(serverDbSiteId && dbVersion > 0 ? { dbVersionBySite: { [serverDbSiteId]: dbVersion } } : {}),
  };
}

const median = (values: number[]): number | null => {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null;
};
const r0 = (value: number) => Math.round(value);

/** One live connection with request/response plumbing and byte accounting. */
class PhoneSocket {
  readonly ws: WebSocket;
  readonly started = performance.now();
  readonly down: TypeBytes = {};
  readonly up: TypeBytes = {};
  requests = 0;
  compression: { codec: "deflate"; thresholdBytes: number } | null = null;
  maxFrameBytes: number | null = null;
  binaryFrames = false;
  projectId: string | null = null;
  private readonly waiters = new Map<string, (envelope: { type: string; payload: any }) => void>();
  private readonly listeners: Array<(envelope: { type: string; payload: any; requestId: string | null }) => void> = [];
  private readonly assembler = createSyncEnvelopeChunkAssembler();
  private pendingChunkWire = new Map<string, number>();

  constructor(url: string, headers: Record<string, string> = {}) {
    // iOS URLSessionWebSocketTask cannot negotiate permessage-deflate; the phone path is per-envelope deflate.
    this.ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 30_000, headers });
    this.ws.binaryType = "nodebuffer";
    this.ws.on("message", (data: Buffer, isBinary: boolean) => this.onFrame(data, isBinary));
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  elapsed(): number {
    return performance.now() - this.started;
  }

  on(listener: (envelope: { type: string; payload: any; requestId: string | null }) => void): void {
    this.listeners.push(listener);
  }

  private count(table: TypeBytes, type: string, wire: number, decoded: number, frames: number): void {
    const row = (table[type] ??= { frames: 0, messages: 0, wireBytes: 0, decodedBytes: 0 });
    row.frames += frames;
    row.messages += 1;
    row.wireBytes += wire;
    row.decodedBytes += decoded;
  }

  private onFrame(data: Buffer, isBinary: boolean): void {
    const frame: Buffer | string = isBinary ? data : data.toString("utf8");
    const wire = syncFrameByteLength(frame);
    let parsed = parseSyncEnvelopeFrame(frame);
    let frames = 1;
    let wireTotal = wire;
    if (parsed.type === "envelope_chunk") {
      const chunk = parsed.binaryChunk ?? parseSyncEnvelopeChunkPayload(parsed.payload);
      if (!chunk) return;
      const chunkId = chunk.chunkId;
      this.pendingChunkWire.set(chunkId, (this.pendingChunkWire.get(chunkId) ?? 0) + wire);
      const whole = parsed.binaryChunk
        ? this.assembler.addBinary(parsed.binaryChunk, parsed.binaryChunk.body)
        : this.assembler.add(chunk as never);
      if (whole == null) return;
      wireTotal = this.pendingChunkWire.get(chunkId) ?? wire;
      frames = (chunk as { total: number }).total;
      this.pendingChunkWire.delete(chunkId);
      parsed = parseSyncEnvelopeFrame(whole);
    }
    const decoded = Buffer.byteLength(JSON.stringify(parsed.payload ?? null), "utf8");
    this.count(this.down, parsed.type, wireTotal, decoded, frames);
    const envelope = { type: parsed.type, payload: parsed.payload as any, requestId: parsed.requestId };
    // PHONE_SYNC_DUMP=<file.jsonl>: every received envelope, decoded, with its wire size (for
    // compression models: compression-model.mts).
    if (process.env.PHONE_SYNC_DUMP) {
      fs.appendFileSync(process.env.PHONE_SYNC_DUMP, `${JSON.stringify({ at: Math.round(this.elapsed()), wire: wireTotal, type: parsed.type, requestId: parsed.requestId ?? null, payload: parsed.payload ?? null })}\n`);
    }
    if (process.env.PHONE_SYNC_DEBUG === "1") {
      process.stderr.write(`[phone] ${this.elapsed().toFixed(0)}ms <- ${parsed.type} ${wireTotal}B ${JSON.stringify(parsed.payload ?? null).slice(0, 160)}\n`);
    }
    if (parsed.type === "heartbeat" && (parsed.payload as { kind?: string } | null)?.kind === "ping") {
      this.send("heartbeat", { kind: "pong", sentAt: new Date().toISOString() }, parsed.requestId);
    }
    if (parsed.requestId && this.waiters.has(parsed.requestId)) {
      const waiter = this.waiters.get(parsed.requestId)!;
      // command_ack precedes command_result for the same id; wait for the result.
      if (parsed.type !== "command_ack") {
        this.waiters.delete(parsed.requestId);
        waiter(envelope);
      }
    }
    for (const listener of this.listeners) listener(envelope);
  }

  send(type: string, payload: unknown, requestId: string | null = null): void {
    const frames = encodeSyncEnvelopeFrames({
      type: type as never,
      requestId,
      projectId: this.projectId,
      payload,
      compressionCodec: this.compression ? "deflate" : "none",
      compressionThresholdBytes: this.compression?.thresholdBytes ?? Number.POSITIVE_INFINITY,
      maxFrameBytes: this.maxFrameBytes,
      binaryFrames: this.binaryFrames,
    });
    let wire = 0;
    for (const frame of frames) {
      wire += syncFrameByteLength(frame);
      this.ws.send(frame);
    }
    this.count(this.up, type, wire, Buffer.byteLength(JSON.stringify(payload ?? null), "utf8"), frames.length);
  }

  request(type: string, payload: unknown, timeoutMs = 60_000, presetRequestId?: string): Promise<{ type: string; payload: any }> {
    const requestId = presetRequestId ?? randomUUID().toUpperCase();
    this.requests += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        reject(new Error(`${type} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.set(requestId, (envelope) => {
        clearTimeout(timer);
        resolve(envelope);
      });
      this.send(type, payload, requestId);
    });
  }

  /** Wait for the reply to a request sent some other way (a pipelined hello). */
  expect(requestId: string, timeoutMs = 90_000): Promise<{ type: string; payload: any }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        reject(new Error(`${requestId} timed out`));
      }, timeoutMs);
      this.waiters.set(requestId, (envelope) => {
        clearTimeout(timer);
        resolve(envelope);
      });
    });
  }

  async command(action: string, args: Record<string, unknown>, projectId: string | null, rootPath: string | null): Promise<any> {
    const commandId = randomUUID().toUpperCase();
    const requestId = commandId;
    this.requests += 1;
    const response = await new Promise<{ type: string; payload: any }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        reject(new Error(`${action} timed out`));
      }, 90_000);
      this.waiters.set(requestId, (envelope) => {
        clearTimeout(timer);
        resolve(envelope);
      });
      this.send("command", {
        commandId,
        action,
        args,
        ...(projectId ? { projectId } : {}),
        ...(rootPath ? { projectRootPath: rootPath } : {}),
      }, requestId);
    });
    if (!response.payload?.ok) throw new Error(`${action} failed: ${JSON.stringify(response.payload?.error ?? response.payload).slice(0, 300)}`);
    return response.payload.result;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once("close", () => resolve());
      this.ws.close(1000, "perf run done");
      setTimeout(() => { this.ws.terminate(); resolve(); }, 2_000).unref();
    });
  }
}

function applyHelloOk(socket: PhoneSocket, payload: any): void {
  const compression = payload?.compression;
  socket.compression = compression?.codec === "deflate" ? { codec: "deflate", thresholdBytes: Number(compression.thresholdBytes ?? 512) } : null;
  const chunked = payload?.features?.chunkedEnvelopes;
  socket.maxFrameBytes = chunked && typeof chunked === "object" && Number(chunked.maxFrameBytes) > 0 ? Number(chunked.maxFrameBytes) : null;
  socket.binaryFrames = Boolean(payload?.features?.binaryEnvelopes);
}

function authFor(state: PhoneState): Record<string, unknown> {
  if (!state.secret) throw new Error("This phone is not paired yet; run the pair command first.");
  return { kind: "paired", deviceId: state.deviceId, secret: state.secret };
}

async function pair(opts: Options): Promise<void> {
  if (!opts.pin) throw new Error("--pin is required for pair");
  const state = loadState(opts.state);
  const socket = new PhoneSocket(`ws://${opts.target.host}:${opts.target.port}/`);
  await socket.opened();
  const result = await socket.request("pairing_request", { code: opts.pin, peer: peerMetadata(state, 0, null) });
  if (!result.payload?.ok || !result.payload?.secret) throw new Error(`pairing failed: ${JSON.stringify(result.payload)}`);
  state.deviceId = result.payload.deviceId ?? state.deviceId;
  state.secret = result.payload.secret;
  saveState(opts.state, state);
  await socket.close();
  // A legacy-commit pairing (no pairingCommitVersion) is committed by the first paired hello.
  const check = new PhoneSocket(`ws://${opts.target.host}:${opts.target.port}/`);
  await check.opened();
  const hello = await check.request("hello", { peer: peerMetadata(state, 0, null), compression: ["deflate"], auth: authFor(state) });
  if (hello.type !== "hello_ok") throw new Error(`paired hello failed: ${JSON.stringify(hello.payload).slice(0, 300)}`);
  const projects = (hello.payload?.projects ?? []) as Array<{ id: string; displayName: string; rootPath: string | null; isOpen: boolean }>;
  await check.close();
  console.log(JSON.stringify({ paired: true, deviceId: state.deviceId, projects: projects.map((p) => ({ id: p.id, name: p.displayName, open: p.isOpen })) }));
}

/** Pick the chat with the most transcript: largest chat in the roster by the fields it carries. */
function pickBiggestChat(roster: any, projectId: string | null): string | null {
  const projects = (roster?.projects ?? roster?.changed ?? []) as any[];
  let best: { id: string; score: number } | null = null;
  for (const project of projects) {
    if (projectId && project.projectId !== projectId && project.id !== projectId) continue;
    for (const chat of project.chats ?? []) {
      const score = Number(chat.transcriptBytes ?? chat.eventCount ?? chat.turnCount ?? 0) || Date.parse(chat.lastActivityAt ?? chat.updatedAt ?? "") || 0;
      if (!best || score > best.score) best = { id: chat.id ?? chat.sessionId, score };
    }
  }
  return best?.id ?? null;
}

/**
 * The new app's work list: a full reply (array or { sessions }), a notModified, or a delta against
 * the rows it holds (`acceptDelta`), rebuilt into the full list exactly as the app does.
 */
/** prs.list: the bare array (older brains, today's app) or the conditional reply. */
function applyPrsListReply(next: WarmCache, reply: any, notes: string[]): unknown[] {
  if (Array.isArray(reply)) return reply;
  if (reply?.notModified && next.prsRows) {
    notes.push("prs notModified");
    return next.prsRows;
  }
  next.prsSignature = reply?.signature ?? null;
  next.prsRows = Array.isArray(reply?.prs) ? reply.prs : [];
  return next.prsRows!;
}

function applyWorkListReply(next: WarmCache, work: any, notes: string[]): void {
  if (Array.isArray(work)) {
    next.workSignature = null;
    next.workRows = null;
    return;
  }
  if (work?.partial) {
    // Head rows: the full list follows (the caller asks for it 5 s later).
    notes.push(`work head ${Array.isArray(work.sessions) ? work.sessions.length : 0} rows`);
    return;
  }
  if (work?.notModified) {
    notes.push("work notModified");
    return;
  }
  const signature = typeof work?.signature === "string" ? work.signature : null;
  if (work?.delta) {
    const delta = work.delta as { baseSignature: string; upserted: Array<Record<string, unknown>>; removedIds: string[]; order?: string[] };
    if (!next.workRows || delta.baseSignature !== next.workSignature) throw new Error("work delta against a list this phone does not hold");
    const byId = new Map(next.workRows.map((row) => [String(row.id), row]));
    for (const row of delta.upserted) byId.set(String(row.id), row);
    for (const id of delta.removedIds) byId.delete(id);
    const order = delta.order ?? next.workRows.map((row) => String(row.id)).filter((id) => byId.has(id));
    next.workRows = order.map((id) => byId.get(id)).filter((row): row is Record<string, unknown> => row != null);
    next.workSignature = signature;
    notes.push(`work delta ${delta.upserted.length} rows`);
    return;
  }
  next.workRows = Array.isArray(work?.sessions) ? work.sessions : null;
  next.workSignature = next.workRows ? signature : null;
}

async function connectOnce(args: {
  opts: Options;
  state: PhoneState;
  profile: string;
  scenario: "cold" | "reconnect";
  run: number;
  cache: WarmCache | null;
}): Promise<{ result: RunResult; cache: WarmCache }> {
  const { opts, state, profile, scenario, run, cache } = args;
  const proxy = await startSlowProxy({ targetHost: opts.target.host, targetPort: opts.target.port, profile });
  const notes: string[] = [];
  const ms: Record<string, number | null> = {
    helloOk: null, projectRow: null, workList: null, workUsable: null, lanesExact: null, caughtUp: null, roster: null, catalog: null, chat: null, prs: null, done: null,
    rosterComplete: null,
  };
  const next: WarmCache = cache
    ? { ...cache }
    : { dbVersion: 0, serverDbSiteId: null, rosterSeq: null, laneSignature: null, chatSinceSeq: null, chatSinceSequence: null, chatGeneration: null };
  const newPhone = opts.phone === "new";
  // The legacy app cleared its roster seq on every disconnect.
  if (!newPhone) next.rosterSeq = null;
    const laneArgs: Record<string, unknown> = {
      includeArchived: true,
      includeStatus: true,
      includeConflictStatus: true,
      includeRebaseSuggestions: true,
      includeAutoRebaseStatus: true,
      ...(next.laneSignature ? { ifNoneMatch: next.laneSignature } : {}),
      // The current app lets a newer brain answer from each lane's last status (`revalidating`).
      ...(newPhone ? { allowCachedStatus: true } : {}),
    };
    const fullWorkArgs: Record<string, unknown> = newPhone
      ? { limit: 200, conditional: true, acceptDelta: true, omitNullFields: true, ...(next.workSignature ? { ifNoneMatch: next.workSignature } : {}) }
      : { limit: 200 };
    // The current app's first load of the list asks for head rows; the full list follows 5 s later.
    // A reconnecting app holds its list (in memory, or the file it saves), so only a cold one asks for
    // head rows.
    const workArgs: Record<string, unknown> = newPhone && scenario === "cold" && !next.workSignature ? { ...fullWorkArgs, headRows: 20 } : fullWorkArgs;
    const prsListArgs: Record<string, unknown> = newPhone
      ? { conditional: true, omitNullFields: true, ...(next.prsSignature ? { ifNoneMatch: next.prsSignature } : {}) }
      : {};
    const chatPayloadFor = (sessionId: string, chatLogV2: boolean): Record<string, unknown> => {
      // The current app asks for a smaller first page when this connection's handshake (dial to
      // hello_ok) took 700 ms or more; the reconnect plan is built before the socket opens and uses the
      // previous connection's measurement.
      const weakLink = newPhone && (ms.helloOk ?? next.lastHandshakeMs ?? 0) >= WEAK_LINK_HANDSHAKE_MS;
      const payload: Record<string, unknown> = { sessionId, maxBytes: weakLink ? WEAK_LINK_CHAT_SUBSCRIBE_MAX_BYTES : CHAT_SUBSCRIBE_MAX_BYTES };
      if (chatLogV2) payload.chatLogV2 = true;
      if (scenario === "reconnect") {
        if (next.chatSinceSequence != null) payload.sinceSequence = next.chatSinceSequence;
        if (next.chatGeneration != null) payload.generation = Number(next.chatGeneration);
        if (next.chatSinceSeq != null) payload.sinceSeq = next.chatSinceSeq;
      }
      return payload;
    };
    // The new app on a reconnect (it holds the project row and knows the open chat) sends its first
    // requests inside the hello; a brain that takes them answers right behind hello_ok.
    const commandEnvelope = (action: string, args: Record<string, unknown>) => {
      const requestId = randomUUID().toUpperCase();
      return {
        type: "command",
        requestId,
        projectId: state.projectId,
        payload: { commandId: requestId, action, args, ...(state.projectId ? { projectId: state.projectId } : {}), ...(state.projectRootPath ? { projectRootPath: state.projectRootPath } : {}) },
      };
    };
    // A cold app also bundles them (it knows its project; the answers wait for the project-row gate),
    // but it has no open chat yet.
    const pipeline = newPhone && state.projectId && (scenario === "cold" || opts.chat)
      ? {
          lanes: commandEnvelope("lanes.refreshSnapshots", laneArgs),
          work: commandEnvelope("work.listSessions", workArgs),
          roster: { type: "roster_subscribe", requestId: null, projectId: state.projectId, payload: next.rosterSeq != null ? { sinceSeq: next.rosterSeq } : {} },
          chat: scenario === "reconnect" && opts.chat
            ? { type: "chat_subscribe", requestId: null, projectId: state.projectId, payload: chatPayloadFor(opts.chat, true) }
            : null,
        }
      : null;
    // The chat resume and the roster first: the brain runs a hello's requests in order, and the lane
    // refresh is the slow one (~300 ms of brain time), so what the user looks at should not wait on it.
    const pipelinedEnvelopes = pipeline
      ? [pipeline.chat, pipeline.work, pipeline.roster, newPhone && !next.laneSignature ? null : pipeline.lanes].filter((entry) => entry != null)
      : [];
    const helloRequestId = randomUUID().toUpperCase();
    const helloPayload = {
      peer: peerMetadata(state, next.dbVersion, next.serverDbSiteId, newPhone),
      compression: ["deflate"],
      auth: authFor(state),
      ...(newPhone && next.commandRoutingDigest ? { commandRoutingDigest: next.commandRoutingDigest } : {}),
      ...(newPhone && next.projectCatalogDigest ? { projectCatalogDigest: next.projectCatalogDigest } : {}),
      ...(pipelinedEnvelopes.length ? { pipelined: pipelinedEnvelopes } : {}),
    };
    // The new app sends its hello with the upgrade request too (direct routes only); a brain that
    // reads it answers hello_ok as the first frame, and drops the frame copy sent below.
    const upgradeHeaders: Record<string, string> = newPhone
      ? { "X-ADE-Hello": `v1.${Buffer.from(JSON.stringify({ requestId: helloRequestId, payload: helloPayload })).toString("base64url")}` }
      : {};
  const socket = new PhoneSocket(`ws://127.0.0.1:${proxy.port}/`, upgradeHeaders);
  socket.projectId = state.projectId;
  let changesetBatches = 0;
  let changesetRows = 0;
  let sawProjectRow = scenario === "reconnect"; // a warm replica already has its project row
  let batchApplied: (() => void) | null = null;
  let fullWorkList: Promise<void> | null = null;
  let serverDbVersion = 0;
  let rosterPayload: any = null;
  let resolveCaughtUp: () => void = () => {};
  const caughtUp = new Promise<void>((resolve) => { resolveCaughtUp = resolve; });
  let resolveRoster: () => void = () => {};
  const rosterReceived = new Promise<void>((resolve) => { resolveRoster = resolve; });
  // A partial first roster (rosterPrioritySnapshotV1) is completed by a later delta.
  let resolveRosterComplete: () => void = () => {};
  const rosterComplete = new Promise<void>((resolve) => { resolveRosterComplete = resolve; });
  let rosterPartial = false;
  let helloDone = false;
  let downBytesAtChat: number | null = null;
  let receivedBytesAtChat: number | null = null;

  socket.on((envelope) => {
    if (envelope.type === "changeset_batch") {
      const batch = envelope.payload as { batchId: string; fromDbVersion: number; toDbVersion: number; changes: Array<{ table?: string }> };
      changesetBatches += 1;
      changesetRows += batch.changes?.length ?? 0;
      if (!sawProjectRow && batch.changes?.some((change) => change.table === "projects")) sawProjectRow = true;
      batchApplied?.();
      next.dbVersion = Math.max(next.dbVersion, Number(batch.toDbVersion) || 0);
      socket.send("changeset_ack", {
        batchId: batch.batchId,
        fromDbVersion: batch.fromDbVersion,
        toDbVersion: batch.toDbVersion,
        appliedDbVersion: batch.toDbVersion,
        appliedCount: batch.changes?.length ?? 0,
        ok: true,
      }, batch.batchId);
      if (helloDone && next.dbVersion >= serverDbVersion && ms.caughtUp == null) {
        ms.caughtUp = socket.elapsed();
        resolveCaughtUp();
      }
    } else if (envelope.type === "brain_status" && helloDone && ms.caughtUp == null) {
      // The host's own view of this phone: it advances past versions it filters out for phones
      // without sending a batch, so the batches alone cannot say "caught up". brain_status follows
      // every ack (and ticks every 5 s), so a silent advance is seen within one tick.
      const self = (envelope.payload?.connectedPeers ?? []).find((peer: { deviceId?: string }) => peer.deviceId === state.deviceId);
      const hostDbVersion = Number(envelope.payload?.metrics?.dbVersion);
      if (self && Number.isFinite(hostDbVersion) && hostDbVersion - Number(self.syncLag ?? Infinity) >= serverDbVersion) {
        ms.caughtUp = socket.elapsed();
        resolveCaughtUp();
      }
    } else if (envelope.type === "roster_snapshot" || envelope.type === "roster_delta") {
      if (ms.roster == null) {
        ms.roster = socket.elapsed();
        if (envelope.type === "roster_delta") notes.push("roster resumed");
      }
      if (envelope.type === "roster_snapshot") {
        rosterPayload = envelope.payload;
        rosterPartial = envelope.payload?.partial === true;
        if (rosterPartial) notes.push("roster partial first");
      }
      if (!rosterPartial || envelope.type === "roster_delta") {
        if (ms.rosterComplete == null) ms.rosterComplete = socket.elapsed();
        rosterPartial = false;
        resolveRosterComplete();
      }
      next.rosterSeq = Number(envelope.payload?.seq ?? next.rosterSeq ?? 0);
      resolveRoster();
    }
  });

  const deadline = setTimeout(() => {
    // Hard stop for a wedged run; the catch-up cap ends a slow-but-moving one earlier.
    notes.push(`timed out after ${opts.timeoutMs} ms`);
    socket.ws.terminate();
  }, opts.timeoutMs);

  // Every waiter exists before the socket opens: with an upgrade hello the answers can arrive in the
  // same read as the 101.
  const pipelinedReplies = pipeline
    ? { lanes: socket.expect(pipeline.lanes.requestId), work: socket.expect(pipeline.work.requestId) }
    : null;
  for (const reply of Object.values(pipelinedReplies ?? {})) reply.catch(() => {});
  let pipelinedChat: Promise<any> | null = null;
  if (pipeline?.chat && opts.chat) {
    pipelinedChat = new Promise((resolve) => {
      socket.on((envelope) => {
        if (envelope.type === "chat_subscribe" && envelope.payload?.sessionId === opts.chat) resolve(envelope.payload);
      });
    });
  }
  const helloReply = socket.expect(helloRequestId, 60_000);
  helloReply.catch(() => {});
  try {
    await socket.opened();
    socket.requests += 1;
    socket.send("hello", helloPayload, helloRequestId);
    const hello = await helloReply;
    if (hello.type !== "hello_ok") throw new Error(`hello failed: ${JSON.stringify(hello.payload).slice(0, 400)}`);
    ms.helloOk = socket.elapsed();
    next.lastHandshakeMs = ms.helloOk;
    const routing = hello.payload?.features?.commandRouting;
    if (routing?.actionsUnchanged) notes.push("command descriptors unchanged");
    next.commandRoutingDigest = typeof routing?.actionsDigest === "string" ? routing.actionsDigest : null;
    if (hello.payload?.projectCatalogUnchanged) notes.push("catalog unchanged");
    next.projectCatalogDigest = typeof hello.payload?.projectCatalogDigest === "string" ? hello.payload.projectCatalogDigest : null;
    applyHelloOk(socket, hello.payload);
    serverDbVersion = Number(hello.payload?.serverDbVersion ?? 0);
    const serverSite = typeof hello.payload?.serverDbSiteId === "string" ? hello.payload.serverDbSiteId.toLowerCase() : null;
    if (next.serverDbSiteId && serverSite && serverSite !== next.serverDbSiteId) notes.push("server DB site changed; cursor reset");
    next.serverDbSiteId = serverSite;
    helloDone = true;
    if (next.dbVersion >= serverDbVersion && ms.caughtUp == null) {
      ms.caughtUp = socket.elapsed();
      resolveCaughtUp();
    }
    const helloProjects = (hello.payload?.projects ?? []) as Array<{ id: string; rootPath: string | null }>;
    const project = state.projectId
      ? helloProjects.find((p) => p.id === state.projectId) ?? { id: state.projectId, rootPath: state.projectRootPath }
      : helloProjects[0] ?? null;
    if (!project) throw new Error("hello_ok carried no project; pass --project");
    state.projectId = project.id;
    state.projectRootPath = project.rootPath ?? state.projectRootPath;
    socket.projectId = state.projectId;

    const pipelined = pipeline != null
      && Number(hello.payload?.features?.pipelinedHello?.accepted ?? -1) === pipelinedEnvelopes.length;
    if (pipelined) notes.push("hello pipelined");
    const commandResult = (envelope: { payload: any }, action: string) => {
      if (!envelope.payload?.ok) throw new Error(`${action} failed: ${JSON.stringify(envelope.payload?.error ?? envelope.payload).slice(0, 300)}`);
      return envelope.payload.result;
    };

    // applyHelloPayload → subscribeRosterIfNeeded; schedulePostHelloWork → project_catalog_request.
    if (!pipelined) socket.send("roster_subscribe", next.rosterSeq != null ? { sinceSeq: next.rosterSeq } : {});
    const helloCarriedCatalog = hello.payload?.projectCatalogUnchanged === true
      || (Array.isArray(hello.payload?.projects) && hello.payload.projects.length > 0);
    const catalog = newPhone && helloCarriedCatalog
      ? Promise.resolve().then(() => { ms.catalog = socket.elapsed(); })
      : socket.request("project_catalog_request", {}).then(() => { ms.catalog = socket.elapsed(); });

    // performInitialHydration: the project-row gate polls every 200 ms, then lanes + work in parallel.
    // The current app's gate also wakes when a changeset batch is applied (once); the older app only
    // polls every 200 ms.
    let earlyWakeUsed = !newPhone;
    const gate = (async () => {
      while (!sawProjectRow) {
        if (!earlyWakeUsed) {
          const wokeByBatch = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), PROJECT_ROW_POLL_MS);
            batchApplied = () => { clearTimeout(timer); resolve(true); };
          });
          batchApplied = null;
          if (wokeByBatch) earlyWakeUsed = true;
          if (socket.ws.readyState !== WebSocket.OPEN) throw new Error("socket closed before the project row arrived");
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, PROJECT_ROW_POLL_MS));
        if (socket.ws.readyState !== WebSocket.OPEN) throw new Error("socket closed before the project row arrived");
      }
      ms.projectRow = socket.elapsed();
    })();
    // The Work screen shows once the work list is in (its own domain status); the lane refresh runs
    // beside it. workList times the first, workUsable both.
    const loadWorkList = async () => {
      const work = pipelined && pipelinedReplies
        ? commandResult(await pipelinedReplies.work, "work.listSessions")
        : await socket.command("work.listSessions", workArgs, state.projectId, state.projectRootPath);
      applyWorkListReply(next, work, notes);
      ms.workList = socket.elapsed();
      if ((work as any)?.partial) {
        fullWorkList = new Promise<void>((resolve) => {
          setTimeout(() => {
            if (socket.ws.readyState !== WebSocket.OPEN) return resolve();
            void socket.command("work.listSessions", fullWorkArgs, state.projectId, state.projectRootPath)
              .then((full: any) => { applyWorkListReply(next, full, notes); })
              .catch(() => {})
              .finally(resolve);
          }, 5_000);
        });
      }
    };
    const loadLanes = async () => {
      // The current app does not bundle a full lane list (no signature held), and on a weak link asks
      // for it 2.5 s after the work list, behind the chat.
      const lanesBundled = pipelined && pipelinedReplies && !(newPhone && !next.laneSignature);
      if (newPhone && !lanesBundled && (ms.helloOk ?? 0) >= WEAK_LINK_HANDSHAKE_MS) {
        await workListDone;
        await new Promise((resolve) => setTimeout(resolve, 2_500));
      }
      const lanes = lanesBundled
        ? commandResult(await pipelinedReplies.lanes, "lanes.refreshSnapshots")
        : await socket.command("lanes.refreshSnapshots", laneArgs, state.projectId, state.projectRootPath);
      if (lanes?.signature) next.laneSignature = String(lanes.signature);
      if (lanes?.notModified) notes.push("lanes notModified");
      // A cached first answer: the current app asks for the exact re-check in the background.
      if (newPhone && lanes?.revalidating) {
        notes.push("lanes cached");
        const exactStarted = socket.elapsed();
        void socket.command("lanes.refreshSnapshots", { ...laneArgs, allowCachedStatus: undefined, awaitRevalidation: true, ...(next.laneSignature ? { ifNoneMatch: next.laneSignature } : {}) }, state.projectId, state.projectRootPath)
          .then((exact: any) => {
            ms.lanesExact = socket.elapsed();
            if (exact?.signature) next.laneSignature = String(exact.signature);
            notes.push(`lanes exact in ${Math.round(socket.elapsed() - exactStarted)} ms${exact?.notModified ? " (notModified)" : ""}`);
          })
          .catch(() => {});
      }
    };
    // The current app sends the work list first (the Work screen waits on it alone); the app before
    // the P1 pass sent the lane refresh first.
    const [workListDone, lanesDone] = newPhone
      ? (() => { const w = gate.then(loadWorkList); const l = gate.then(loadLanes); return [w, l] as const; })()
      : (() => { const l = gate.then(loadLanes); const w = gate.then(loadWorkList); return [w, l] as const; })();
    const work = Promise.all([workListDone, lanesDone]).then(() => {
      ms.workUsable = socket.elapsed();
    });
    // schedulePullRequestHydration: off the readiness path.
    // The current app starts the PR refresh once the work list is in; the app before the P1 pass
    // started it right after the project-row gate.
    // The current app with no saved PR list asks for the open PRs first and the full list 5 s later.
    const prsActiveFirst = newPhone && !next.prsSignature;
    const prs = (newPhone ? workListDone : gate).then(async () => {
      const reply = await socket.command("prs.list", prsActiveFirst ? { activeOnly: true, conditional: true, omitNullFields: true } : prsListArgs, state.projectId, state.projectRootPath) as any;
      if (prsActiveFirst) {
        setTimeout(() => {
          if (socket.ws.readyState !== WebSocket.OPEN) return;
          void socket.command("prs.list", prsListArgs, state.projectId, state.projectRootPath)
            .then((full: any) => { applyPrsListReply(next, full, notes); })
            .catch(() => {});
        }, 5_000);
      }
      const list = (prsActiveFirst ? (Array.isArray(reply?.prs) ? reply.prs : reply) : applyPrsListReply(next, reply, notes)) as Array<{ id: string; state?: string; laneId?: string | null }>;
      const active = (Array.isArray(list) ? list : []).filter((pr) => pr.state === "open" || pr.state === "draft").map((pr) => pr.id);
      for (let i = 0; i < active.length; i += 10) {
        await socket.command("prs.refresh", { prIds: active.slice(i, i + 10), includeSnapshots: "active" }, state.projectId, state.projectRootPath);
      }
      ms.prs = socket.elapsed();
    }).catch((error) => {
      // A measurement brain has no GitHub sign-in, so a project with open PRs (a real-load copy) cannot
      // refresh them. Record it; the other steps do not wait on PRs.
      notes.push(`prs: ${error instanceof Error ? error.message : String(error)}`.slice(0, 160));
    });
    // The user opens the biggest chat as soon as Work is usable.
    // The user opens the biggest chat as soon as Work is usable; a pipelined reconnect re-opens the
    // chat it had open inside the hello.
    const chat = (pipelined && pipelinedChat ? pipelinedChat.then((response) => [opts.chat!, response] as const) : Promise.all([workListDone, rosterReceived]).then(async () => {
      const sessionId = opts.chat ?? pickBiggestChat(rosterPayload, state.projectId);
      if (!sessionId) {
        notes.push("no chat to open");
        return null;
      }
      const payload = chatPayloadFor(sessionId, Boolean(hello.payload?.features?.chatLogV2));
      const response = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("chat_subscribe timed out")), 90_000);
        socket.on((envelope) => {
          if (envelope.type === "chat_subscribe" && envelope.payload?.sessionId === sessionId) {
            clearTimeout(timer);
            resolve(envelope.payload);
          }
        });
        socket.requests += 1;
        socket.send("chat_subscribe", payload);
      });
      return [sessionId, response] as const;
    })).then((opened) => {
      if (!opened) return null;
      const [sessionId, response] = opened;
      ms.chat = socket.elapsed();
      downBytesAtChat = proxy.stats().downBytes;
      // What the phone had received when the chat showed (whole envelopes, framing excluded). The
      // proxy counts bytes as they enter it, so downBytesAtChat also holds bytes still queued behind
      // the chat on a slow link.
      receivedBytesAtChat = Object.values(socket.down).reduce((sum, row) => sum + row.wireBytes, 0);
      const events = (response?.events ?? []) as Array<Record<string, any>>;
      const seqs = events.map((event) => Number(event.seq)).filter(Number.isFinite);
      if (seqs.length) next.chatSinceSeq = Math.max(...seqs);
      else if (Number.isFinite(Number(response?.latestSeq))) next.chatSinceSeq = Number(response.latestSeq);
      // Same resume point as the app (ChatThreadEngine.resumePoint): the last event's sequence and the
      // snapshot's historyGeneration. A resumed ack carries no events; its replayed rows arrive as
      // chat_event, so a resume keeps the previous cursor.
      const sequences = events.map((event) => Number(event.sequence)).filter(Number.isFinite);
      if (sequences.length) next.chatSinceSequence = Math.max(...sequences);
      else if (!response?.resumed && Number.isFinite(Number(response?.maxSequence))) next.chatSinceSequence = Number(response.maxSequence);
      if (response?.historyGeneration != null) next.chatGeneration = String(response.historyGeneration);
      if (response?.resumed) notes.push("chat resumed");
      return sessionId;
    });

    const [, , , sessionId] = await Promise.all([catalog, work, prs, chat, rosterReceived]);
    ms.done = socket.elapsed();
    const capLeft = Math.max(0, opts.catchupCapMs - socket.elapsed());
    await Promise.race([caughtUp, new Promise((resolve) => setTimeout(resolve, capLeft))]);
    // Untimed: a phone that is kept for a reconnect run must hold the whole roster, as an app that
    // stayed connected for a few seconds does.
    await Promise.race([rosterComplete, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    // Untimed too: the full work list a head-rows answer is followed by, which the app saves.
    if (fullWorkList) await Promise.race([fullWorkList, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    clearTimeout(deadline);
    const proxyStats = proxy.stats();
    const result: RunResult = {
      scenario,
      profile,
      run,
      ms: Object.fromEntries(Object.entries(ms).map(([key, value]) => [key, value == null ? null : r0(value)])),
      down: socket.down,
      up: socket.up,
      proxy: { connections: proxyStats.connections, upBytes: proxyStats.upBytes, downBytes: proxyStats.downBytes },
      decodedDownBytes: Object.values(socket.down).reduce((sum, row) => sum + row.decodedBytes, 0),
      wireDownBytes: Object.values(socket.down).reduce((sum, row) => sum + row.wireBytes, 0),
      requests: socket.requests,
      changesetBatches,
      changesetRows,
      versionsBehindAtHello: Math.max(0, serverDbVersion - (cache?.dbVersion ?? 0)),
      versionsBehindAtCap: ms.caughtUp == null ? Math.max(0, serverDbVersion - next.dbVersion) : null,
      chatSessionId: (sessionId as string | null) ?? null,
      notes,
      downBytesAtChat,
      receivedBytesAtChat,
    };
    return { result, cache: next };
  } finally {
    clearTimeout(deadline);
    await socket.close();
    await proxy.close();
  }
}

function summarize(results: RunResult[]): void {
  const groups = new Map<string, RunResult[]>();
  for (const result of results) {
    const key = `${result.scenario} ${result.profile}`;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  for (const [key, rows] of groups) {
    const steps = Object.keys(rows[0]!.ms);
    const msMedian = Object.fromEntries(steps.map((step) => [step, median(rows.map((row) => row.ms[step] ?? Number.NaN))]));
    const types = new Set(rows.flatMap((row) => Object.keys(row.down)));
    const byType = Object.fromEntries([...types].map((type) => [type, {
      wireKB: +((median(rows.map((row) => row.down[type]?.wireBytes ?? 0)) ?? 0) / 1024).toFixed(1),
      decodedKB: +((median(rows.map((row) => row.down[type]?.decodedBytes ?? 0)) ?? 0) / 1024).toFixed(1),
      messages: median(rows.map((row) => row.down[type]?.messages ?? 0)),
    }]).sort((a, b) => b[1].wireKB - a[1].wireKB));
    console.log(JSON.stringify({
      summary: key,
      runs: rows.length,
      ms: msMedian,
      proxyDownKB: +((median(rows.map((row) => row.proxy.downBytes)) ?? 0) / 1024).toFixed(1),
      proxyUpKB: +((median(rows.map((row) => row.proxy.upBytes)) ?? 0) / 1024).toFixed(1),
      decodedDownKB: +((median(rows.map((row) => row.decodedDownBytes)) ?? 0) / 1024).toFixed(1),
      requests: median(rows.map((row) => row.requests)),
      changesetBatches: median(rows.map((row) => row.changesetBatches)),
      changesetRows: median(rows.map((row) => row.changesetRows)),
      versionsBehindAtHello: median(rows.map((row) => row.versionsBehindAtHello)),
      versionsBehindAtCap: median(rows.map((row) => row.versionsBehindAtCap ?? 0)),
      byType,
    }));
  }
}

/**
 * The brain hosts one project's sync at a time. A phone that opens another project sends
 * project_switch_request, then reconnects. Done once, untimed, so every timed run measures a phone
 * whose project is the hosted one (the common case: the phone reopens the project it had open).
 */
async function ensureHosted(opts: Options, state: PhoneState): Promise<void> {
  const socket = new PhoneSocket(`ws://${opts.target.host}:${opts.target.port}/`);
  await socket.opened();
  try {
    const hello = await socket.request("hello", { peer: peerMetadata(state, 0, null), compression: ["deflate"], auth: authFor(state) });
    if (hello.type !== "hello_ok") throw new Error(`hello failed: ${JSON.stringify(hello.payload).slice(0, 300)}`);
    const projects = (hello.payload?.projects ?? []) as Array<{ id: string; rootPath: string | null; isOpen: boolean }>;
    const target = projects.find((project) => project.id === state.projectId) ?? (state.projectId ? null : projects[0]);
    if (!target) throw new Error(`project ${state.projectId} is not in this machine's catalog`);
    state.projectId = target.id;
    state.projectRootPath = target.rootPath;
    if (target.isOpen) return;
    applyHelloOk(socket, hello.payload);
    const result = await socket.request("project_switch_request", { projectId: target.id, rootPath: target.rootPath }, 120_000);
    if (!result.payload?.ok) throw new Error(`project switch failed: ${JSON.stringify(result.payload).slice(0, 300)}`);
    console.log(JSON.stringify({ setup: "project_switch_request", projectId: target.id }));
  } finally {
    await socket.close();
  }
}

async function measure(opts: Options): Promise<void> {
  const state = loadState(opts.state);
  if (opts.project) state.projectId = opts.project;
  await ensureHosted(opts, state);
  const results: RunResult[] = [];
  const scenarios = opts.command === "cold" ? ["cold"] : opts.command === "reconnect" ? ["reconnect"] : ["cold", "reconnect"];
  const loadStart = os.loadavg();
  let warmCache: WarmCache | null = state.warmCache ?? null;
  // Interleave profiles run by run, so machine noise lands on every profile alike.
  for (let run = 1; run <= opts.runs; run += 1) {
    for (const profile of opts.profiles) {
      if (scenarios.includes("cold")) {
        const cold = await connectOnce({ opts, state, profile, scenario: "cold", run, cache: null });
        console.log(JSON.stringify(cold.result));
        results.push(cold.result);
      }
      if (scenarios.includes("reconnect")) {
        // The phone that reconnects held a complete replica. Reuse the last reconnect's cache when it
        // caught up; otherwise fill one on LAN, untimed, with no cap.
        if (!warmCache) {
          const fill = await connectOnce({
            opts: { ...opts, catchupCapMs: 900_000, timeoutMs: 960_000 },
            state,
            profile: "lan",
            scenario: "cold",
            run: 0,
            cache: null,
          });
          if (fill.result.ms.caughtUp == null) console.log(JSON.stringify({ warning: "fill connection did not catch up", behind: fill.result.versionsBehindAtCap }));
          warmCache = fill.cache;
        }
        // A short drop: the brain keeps writing while the phone is away. --during-drop runs a command
        // meanwhile (one chat renamed, say), so a reconnect finds a project that moved.
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        if (opts.duringDrop) execSync(opts.duringDrop, { stdio: "ignore", timeout: 60_000 });
        // --relaunch-before: the app was relaunched and, as before P1, kept nothing in memory but its
        // replica and command list (no lane, work or PR list signature, no roster seq or catalog digest).
        const reconnectCache = opts.relaunchBefore
          ? { ...warmCache, laneSignature: null, workSignature: null, workRows: null, prsSignature: null, prsRows: null, rosterSeq: null, projectCatalogDigest: null }
          : warmCache;
        const warm = await connectOnce({ opts, state, profile, scenario: "reconnect", run, cache: reconnectCache });
        console.log(JSON.stringify(warm.result));
        results.push(warm.result);
        warmCache = warm.result.ms.caughtUp != null ? warm.cache : null;
      }
    }
  }
  state.warmCache = warmCache;
  saveState(opts.state, state);
  console.log(JSON.stringify({ loadavg: { start: loadStart.map((v) => +v.toFixed(2)), end: os.loadavg().map((v) => +v.toFixed(2)) } }));
  summarize(results);
  if (opts.json) fs.appendFileSync(opts.json, results.map((result) => `${JSON.stringify(result)}\n`).join(""));
}

/** `summarize <file.jsonl>...`: the medians across runs written by --json (one run per line). */
function summarizeFiles(files: string[]): void {
  const results = files.flatMap((file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as RunResult));
  summarize(results);
}

if (process.argv[2] === "summarize") {
  summarizeFiles(process.argv.slice(3));
  process.exit(0);
}
const opts = parseArgs(process.argv.slice(2));
if (opts.command === "pair") await pair(opts);
else await measure(opts);
process.exit(0);
