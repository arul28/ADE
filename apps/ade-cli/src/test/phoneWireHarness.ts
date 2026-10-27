// A real sync host over one project database, and a phone that talks to it the way the iOS app
// does. Shared by the phone wire-budget test (services/sync/syncWireBudget.test.ts) and the replica
// catch-up bench (scripts/perf/net/replica-catchup.bench.mts).
//
// The host is the production createSyncHostService with a real kvDb, a real session service, a real
// chat service (transcript reads) and the real roster builder. Lane and PR services are inert stubs:
// nothing here runs git or touches a worktree, so the database may be a copy of a real project's.
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { createAgentChatService } from "../../../desktop/src/main/services/chat/agentChatService";
import { createProjectConfigService } from "../../../desktop/src/main/services/config/projectConfigService";
import { createSessionService } from "../../../desktop/src/main/services/sessions/sessionService";
import { openKvDb, type AdeDb } from "../../../desktop/src/main/services/state/kvDb";
import { resolveAdeLayout } from "../../../desktop/src/shared/adeLayout";
import { buildRosterSnapshot } from "../services/sync/rosterBuilder";
import { createSyncHostService } from "../services/sync/syncHostService";
import { createSyncPinStore } from "../services/sync/syncPinStore";
import {
  createSyncEnvelopeChunkAssembler,
  encodeSyncEnvelopeFrames,
  parseSyncEnvelopeChunkPayload,
  parseSyncEnvelopeFrame,
  syncFrameByteLength,
} from "../services/sync/syncProtocol";

/** The capabilities the iOS app declares in hello (SyncService.currentPeerMetadata). */
export const PHONE_CAPABILITIES = ["changesetAck", "chunkedEnvelopes", "relayReauthorizeV1", "binaryEnvelopes", "foldedReplay", "mobileChatSlimV1"];
export const PHONE_CHAT_SUBSCRIBE_MAX_BYTES = 256 * 1024;

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const noop = () => undefined;

export type MeasurementSyncHost = {
  port: number;
  db: AdeDb;
  pin: string;
  dispose: () => Promise<void>;
};

/** Start a real sync host for `projectRoot` (its `.ade/ade.db` unless `dbPath` names another). */
export async function startMeasurementSyncHost(args: {
  projectRoot: string;
  projectId: string;
  secretsDir: string;
  dbPath?: string;
  pollIntervalMs?: number;
  pin?: string;
}): Promise<MeasurementSyncHost> {
  const projectRoot = args.projectRoot;
  const layout = resolveAdeLayout(projectRoot);
  const db = await openKvDb(args.dbPath ?? path.join(projectRoot, ".ade", "ade.db"), silentLogger as never);
  const sessionService = createSessionService({ db, logger: silentLogger as never });
  const projectConfigService = createProjectConfigService({ projectRoot, adeDir: path.join(projectRoot, ".ade"), projectId: args.projectId, db, logger: silentLogger as never });
  const agentChatService = createAgentChatService({
    getAccountUsage: () => null,
    projectRoot,
    transcriptsDir: path.dirname(layout.chatTranscriptsDir),
    laneService: { list: () => [], get: () => null, getLaneBaseAndBranch: () => null } as never,
    sessionService: sessionService as never,
    projectConfigService: projectConfigService as never,
    aiIntegrationService: { getMode: () => "subscription", summarizeTerminal: async () => ({ text: "" }) } as never,
    logger: silentLogger as never,
    appVersion: "0.0.0-measure",
    nativeTitleWaitMs: 0,
    getDirtyFileTextForPath: () => undefined,
    db: db as never,
  } as never);
  const registryRecord = {
    projectId: args.projectId,
    rootPath: projectRoot,
    displayName: path.basename(projectRoot),
    gitOriginUrl: null,
    lastOpenedAt: Date.parse("2026-10-20T12:00:00.000Z"),
    catalogVisibility: "recent" as const,
  };
  fs.mkdirSync(args.secretsDir, { recursive: true });
  const pin = args.pin ?? "424242";
  const pinStore = createSyncPinStore({ filePath: path.join(args.secretsDir, "sync-pin.json") });
  pinStore.setPin(pin);
  const host = createSyncHostService({
    db,
    logger: silentLogger,
    projectId: args.projectId,
    projectRoot,
    port: 0,
    pollIntervalMs: args.pollIntervalMs ?? 400,
    brainStatusIntervalMs: 600_000,
    heartbeatIntervalMs: 600_000,
    discoveryEnabled: false,
    pinStore,
    fileService: {},
    laneService: { list: async () => [], create: noop, archive: noop },
    prService: { listAll: async () => [] },
    sessionService,
    agentChatService,
    ptyService: { create: noop, readTranscriptTail: async () => "", hasLivePty: () => false, enrichSessions: (rows: unknown[]) => rows },
    computerUseArtifactBrokerService: { listArtifacts: () => [] },
    rosterProvider: {
      buildSnapshot: () => buildRosterSnapshot({
        projectRegistry: { list: () => [registryRecord] },
        scopeRegistry: { getIfBooted: () => null },
        hostProjectId: null,
      }),
    },
    projectCatalogProvider: {
      listProjects: async () => ({
        projects: [{
          id: args.projectId,
          displayName: registryRecord.displayName,
          rootPath: projectRoot,
          repoOwner: null,
          repoName: null,
          defaultBaseRef: "main",
          lastOpenedAt: "2026-10-20T12:00:00.000Z",
          laneCount: 0,
          isAvailable: true,
          isCached: true,
          isOpen: true,
        }],
      }),
      prepareProjectConnection: async () => ({ ok: false, message: "not supported here" }),
    },
  } as unknown as Parameters<typeof createSyncHostService>[0]);
  const port = await host.waitUntilListening();
  return {
    port,
    db,
    pin,
    dispose: async () => {
      await host.dispose();
      db.close();
    },
  };
}

export type ReceivedEnvelope = { type: string; wireBytes: number; payload: any; requestId: string | null; atMs: number };

/** A phone socket: iOS hello, per-envelope deflate, binary frames, no permessage-deflate. */
export class MeasurementPhone {
  readonly ws: WebSocket;
  readonly received: ReceivedEnvelope[] = [];
  readonly startedAt = performance.now();
  private readonly assembler = createSyncEnvelopeChunkAssembler();
  private readonly chunkWire = new Map<string, number>();
  private readonly listeners: Array<(message: ReceivedEnvelope) => void> = [];
  compression = false;
  binaryFrames = false;
  maxFrameBytes: number | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url, { perMessageDeflate: false });
    this.ws.on("message", (data: Buffer, isBinary: boolean) => {
      const frame = isBinary ? data : data.toString("utf8");
      const wire = syncFrameByteLength(frame);
      let parsed = parseSyncEnvelopeFrame(frame);
      let wireBytes = wire;
      if (parsed.type === "envelope_chunk") {
        const chunk = parsed.binaryChunk ?? parseSyncEnvelopeChunkPayload(parsed.payload);
        if (!chunk) return;
        this.chunkWire.set(chunk.chunkId, (this.chunkWire.get(chunk.chunkId) ?? 0) + wire);
        const whole = parsed.binaryChunk ? this.assembler.addBinary(parsed.binaryChunk, parsed.binaryChunk.body) : this.assembler.add(chunk as never);
        if (whole == null) return;
        wireBytes = this.chunkWire.get(chunk.chunkId) ?? wire;
        this.chunkWire.delete(chunk.chunkId);
        parsed = parseSyncEnvelopeFrame(whole);
      }
      const message = { type: parsed.type, wireBytes, payload: parsed.payload as any, requestId: parsed.requestId, atMs: performance.now() - this.startedAt };
      this.received.push(message);
      for (const listener of this.listeners) listener(message);
    });
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  send(type: string, payload: unknown, requestId: string | null = null): void {
    for (const frame of encodeSyncEnvelopeFrames({
      type: type as never,
      requestId,
      payload,
      compressionCodec: this.compression ? "deflate" : "none",
      compressionThresholdBytes: this.compression ? 512 : Number.POSITIVE_INFINITY,
      maxFrameBytes: this.maxFrameBytes,
      binaryFrames: this.binaryFrames,
    })) this.ws.send(frame);
  }

  next(match: (message: ReceivedEnvelope) => boolean, label: string, timeoutMs = 30_000): Promise<ReceivedEnvelope> {
    const found = this.received.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      this.listeners.push((message) => {
        if (!match(message)) return;
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  bytes(): number {
    return this.received.reduce((sum, message) => sum + message.wireBytes, 0);
  }

  bytesByType(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const message of this.received) out[message.type] = (out[message.type] ?? 0) + message.wireBytes;
    return out;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

export type PhoneIdentity = { deviceId: string; siteId: string; secret: string };

/** PIN-pair a phone; returns the identity a paired hello uses. */
export async function pairMeasurementPhone(url: string, pin: string, deviceId: string, siteId: string): Promise<PhoneIdentity> {
  const phone = new MeasurementPhone(url);
  await phone.opened();
  phone.send("pairing_request", {
    code: pin,
    peer: { deviceId, deviceName: "measurement phone", platform: "iOS", deviceType: "phone", siteId, dbVersion: 0 },
  }, "pair");
  const result = await phone.next((message) => message.type === "pairing_result", "pairing_result");
  await phone.close();
  if (!result.payload?.ok || !result.payload.secret) throw new Error(`pairing failed: ${JSON.stringify(result.payload)}`);
  return { deviceId: result.payload.deviceId ?? deviceId, siteId, secret: result.payload.secret };
}

/** Open a socket and complete the iOS hello; returns the phone with codecs applied and hello_ok. */
export async function helloMeasurementPhone(url: string, identity: PhoneIdentity, dbVersion: number): Promise<{ phone: MeasurementPhone; hello: ReceivedEnvelope }> {
  const phone = new MeasurementPhone(url);
  await phone.opened();
  phone.send("hello", {
    peer: { deviceId: identity.deviceId, deviceName: "measurement phone", platform: "iOS", deviceType: "phone", siteId: identity.siteId, dbVersion, capabilities: PHONE_CAPABILITIES },
    compression: ["deflate"],
    auth: { kind: "paired", deviceId: identity.deviceId, secret: identity.secret },
  }, "hello");
  const hello = await phone.next((message) => message.type === "hello_ok" || message.type === "hello_error", "hello_ok");
  if (hello.type !== "hello_ok") throw new Error(`hello failed: ${JSON.stringify(hello.payload).slice(0, 300)}`);
  phone.compression = hello.payload.compression?.codec === "deflate";
  phone.binaryFrames = Boolean(hello.payload.features?.binaryEnvelopes);
  phone.maxFrameBytes = Number(hello.payload.features?.chunkedEnvelopes?.maxFrameBytes) || null;
  return { phone, hello };
}

/** Ack every changeset batch until the phone holds `target`. Returns the applied version and counts. */
export async function catchUpMeasurementPhone(
  phone: MeasurementPhone,
  from: number,
  target: number,
  timeoutMs = 30_000,
): Promise<{ applied: number; batches: number; rows: number }> {
  let applied = from;
  let batches = 0;
  let rows = 0;
  const acked = new Set<string>();
  while (applied < target) {
    const batch = await phone.next(
      (message) => message.type === "changeset_batch" && !acked.has(message.payload.batchId),
      `changeset batch past ${applied}`,
      timeoutMs,
    );
    acked.add(batch.payload.batchId);
    batches += 1;
    rows += batch.payload.changes?.length ?? 0;
    applied = Math.max(applied, Number(batch.payload.toDbVersion));
    phone.send("changeset_ack", {
      batchId: batch.payload.batchId,
      fromDbVersion: batch.payload.fromDbVersion,
      toDbVersion: batch.payload.toDbVersion,
      appliedDbVersion: batch.payload.toDbVersion,
      appliedCount: batch.payload.changes?.length ?? 0,
      ok: true,
    }, batch.payload.batchId);
  }
  return { applied, batches, rows };
}
