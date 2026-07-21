import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type RawData, type WebSocket as ServerWebSocket } from "ws";
import type { CrsqlChangeRow, SyncChangesetAckPayload, SyncChangesetBatchPayload, SyncPeerMetadata } from "../../../../desktop/src/shared/types";
import type { AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import { createSyncPeerService, peerHeartbeatFallbackDelayMs } from "./syncPeerService";
import { encodeSyncEnvelope, parseSyncEnvelope } from "./syncProtocol";
import type { ParsedSyncEnvelope } from "./syncProtocol";

const servers: WebSocketServer[] = [];
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (disposers.length > 0) {
    await disposers.pop()?.();
  }
  while (servers.length > 0) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function toText(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

async function nextEnvelope(ws: ServerWebSocket, type: ParsedSyncEnvelope["type"], timeoutMs = 1_000): Promise<ParsedSyncEnvelope> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeoutMs);
    const onMessage = (raw: RawData) => {
      const envelope = parseSyncEnvelope(toText(raw));
      if (envelope.type !== type) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(envelope);
    };
    ws.on("message", onMessage);
  });
}

function makeChange(dbVersion: number, siteId: string): CrsqlChangeRow {
  return {
    table: "kv",
    pk: `key-${dbVersion}`,
    cid: "value",
    val: `value-${dbVersion}`,
    col_version: dbVersion,
    db_version: dbVersion,
    site_id: siteId,
    cl: 1,
    seq: dbVersion,
  };
}

describe("createSyncPeerService", () => {
  it("uses a two-interval heartbeat only as the peer fallback", () => {
    expect(peerHeartbeatFallbackDelayMs(30_000)).toBe(60_000);
    expect(peerHeartbeatFallbackDelayMs(60_000)).toBe(120_000);
    expect(peerHeartbeatFallbackDelayMs(1_000)).toBe(10_000);
  });

  it("chunks peer outbound changesets and advances after each ack", async () => {
    const localSiteId = "site-peer";
    const localDeviceId = "peer-device";
    const changes: CrsqlChangeRow[] = [];
    let currentDbVersion = 0;
    const db = {
      sync: {
        getDbVersion: () => currentDbVersion,
        exportChangesSince: (fromDbVersion: number) => changes.filter((change) => Number(change.db_version) > fromDbVersion),
        applyChanges: vi.fn(() => ({ appliedCount: 0 })),
      },
    } as unknown as AdeDb;
    const peerService = createSyncPeerService({
      db,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as any,
      deviceRegistryService: {
        getLocalSiteId: () => localSiteId,
        getLocalDeviceId: () => localDeviceId,
        ensureLocalDevice: () => ({
          deviceId: localDeviceId,
          name: "Peer Device",
          platform: "macOS",
          deviceType: "desktop",
          siteId: localSiteId,
          createdAt: "2026-05-31T00:00:00.000Z",
          updatedAt: "2026-05-31T00:00:00.000Z",
          lastSeenAt: "2026-05-31T00:00:00.000Z",
          lastHost: null,
          lastPort: null,
          tailscaleIp: null,
          ipAddresses: [],
          metadata: {},
        }),
      } as any,
    });
    disposers.push(async () => peerService.dispose());

    const server = new WebSocketServer({ port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const serverSocketPromise = new Promise<ServerWebSocket>((resolve) => server.once("connection", resolve));
    const connectPromise = peerService.connect({
      host: "127.0.0.1",
      port,
      token: "bootstrap-token",
      authKind: "bootstrap",
    });
    const serverSocket = await serverSocketPromise;
    const hello = await nextEnvelope(serverSocket, "hello");
    const brain: SyncPeerMetadata = {
      deviceId: "host-device",
      deviceName: "Host Device",
      platform: "macOS",
      deviceType: "desktop",
      siteId: "site-host",
      dbVersion: 0,
    };
    serverSocket.send(encodeSyncEnvelope({
      type: "hello_ok",
      requestId: hello.requestId,
      payload: {
        peer: brain,
        brain,
        serverDbVersion: 0,
        heartbeatIntervalMs: 30_000,
        pollIntervalMs: 400,
        features: {},
      },
    }));
    await connectPromise;

    changes.push(...Array.from({ length: 300 }, (_, index) => makeChange(index + 1, localSiteId)));
    currentDbVersion = 300;
    peerService.flushLocalChanges();

    const firstBatch = await nextEnvelope(serverSocket, "changeset_batch");
    const firstPayload = firstBatch.payload as SyncChangesetBatchPayload;
    expect(firstPayload.fromDbVersion).toBe(0);
    expect(firstPayload.toDbVersion).toBe(250);
    expect(firstPayload.changes).toHaveLength(250);

    serverSocket.send(encodeSyncEnvelope({
      type: "changeset_ack",
      requestId: firstPayload.batchId,
      payload: {
        batchId: firstPayload.batchId,
        fromDbVersion: firstPayload.fromDbVersion,
        toDbVersion: firstPayload.toDbVersion,
        appliedDbVersion: firstPayload.toDbVersion,
        appliedCount: firstPayload.changes.length,
        ok: true,
      } satisfies SyncChangesetAckPayload,
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    peerService.flushLocalChanges();

    const secondBatch = await nextEnvelope(serverSocket, "changeset_batch");
    const secondPayload = secondBatch.payload as SyncChangesetBatchPayload;
    expect(secondPayload.fromDbVersion).toBe(250);
    expect(secondPayload.toDbVersion).toBe(300);
    expect(secondPayload.changes).toHaveLength(50);
  });

  it("rewindows ACK exhaustion without disconnecting or advancing, ignores late ACKs, then resets", async () => {
    const localSiteId = "site-peer-recovery";
    const localDeviceId = "peer-device-recovery";
    const changes = Array.from({ length: 600 }, (_, index) => makeChange(index + 1, localSiteId));
    let currentDbVersion = 0;
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const db = {
      sync: {
        getDbVersion: () => currentDbVersion,
        exportChangesSince: (fromDbVersion: number, options?: { maxRows?: number; throughDbVersion?: number }) =>
          changes
            .filter((change) => Number(change.db_version) > fromDbVersion)
            .filter((change) => Number(change.db_version) <= (options?.throughDbVersion ?? Number.MAX_SAFE_INTEGER))
            .slice(0, options?.maxRows ?? changes.length),
        applyChanges: vi.fn(() => ({ appliedCount: 0 })),
      },
    } as unknown as AdeDb;
    const peerService = createSyncPeerService({
      db,
      logger: logger as any,
      deviceRegistryService: {
        getLocalSiteId: () => localSiteId,
        getLocalDeviceId: () => localDeviceId,
        ensureLocalDevice: () => ({
          deviceId: localDeviceId,
          name: "Recovery Peer",
          platform: "macOS",
          deviceType: "desktop",
          siteId: localSiteId,
          createdAt: "2026-05-31T00:00:00.000Z",
          updatedAt: "2026-05-31T00:00:00.000Z",
          lastSeenAt: "2026-05-31T00:00:00.000Z",
          lastHost: null,
          lastPort: null,
          tailscaleIp: null,
          ipAddresses: [],
          metadata: {},
        }),
      } as any,
    });
    disposers.push(async () => peerService.dispose());

    const server = new WebSocketServer({ port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const serverSocketPromise = new Promise<ServerWebSocket>((resolve) => server.once("connection", resolve));
    const connectPromise = peerService.connect({
      host: "127.0.0.1",
      port,
      token: "bootstrap-token",
      authKind: "bootstrap",
    });
    const serverSocket = await serverSocketPromise;
    const hello = await nextEnvelope(serverSocket, "hello");
    const brain: SyncPeerMetadata = {
      deviceId: "host-recovery",
      deviceName: "Recovery Host",
      platform: "macOS",
      deviceType: "desktop",
      siteId: "site-host-recovery",
      dbVersion: 0,
    };
    serverSocket.send(encodeSyncEnvelope({
      type: "hello_ok",
      requestId: hello.requestId,
      payload: {
        peer: brain,
        brain,
        serverDbVersion: 0,
        heartbeatIntervalMs: 30_000,
        pollIntervalMs: 400,
        features: {},
      },
    }));
    await connectPromise;

    const realDateNow = Date.now.bind(Date);
    let clockOffsetMs = 0;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + clockOffsetMs);
    try {
      currentDbVersion = 600;
      const firstPromise = nextEnvelope(serverSocket, "changeset_batch");
      peerService.flushLocalChanges();
      const firstPayload = (await firstPromise).payload as SyncChangesetBatchPayload;
      expect(firstPayload.fromDbVersion).toBe(0);
      expect(firstPayload.changes).toHaveLength(250);

      for (let attemptCount = 2; attemptCount <= 6; attemptCount += 1) {
        const retryPromise = nextEnvelope(serverSocket, "changeset_batch");
        clockOffsetMs += 11_000;
        peerService.flushLocalChanges();
        const retryPayload = (await retryPromise).payload as SyncChangesetBatchPayload;
        expect(retryPayload.batchId).toBe(firstPayload.batchId);
      }

      clockOffsetMs += 11_000;
      peerService.flushLocalChanges();
      expect(logger.warn).toHaveBeenCalledWith(
        "sync_peer.changeset_recovery_started",
        expect.objectContaining({
          abandonedBatchId: firstPayload.batchId,
          attemptCount: 6,
          recoveryLevel: 1,
          maxRows: 125,
        }),
      );
      expect(serverSocket.readyState).toBe(1);
      await expect(nextEnvelope(serverSocket, "changeset_batch", 100)).rejects.toThrow(/Timed out/);

      const recoveredPromise = nextEnvelope(serverSocket, "changeset_batch");
      clockOffsetMs += 500;
      peerService.flushLocalChanges();
      const recoveredPayload = (await recoveredPromise).payload as SyncChangesetBatchPayload;
      expect(recoveredPayload.batchId).not.toBe(firstPayload.batchId);
      expect(recoveredPayload.fromDbVersion).toBe(0);
      expect(recoveredPayload.changes).toHaveLength(125);

      serverSocket.send(encodeSyncEnvelope({
        type: "changeset_ack",
        requestId: firstPayload.batchId,
        payload: {
          batchId: firstPayload.batchId,
          fromDbVersion: firstPayload.fromDbVersion,
          toDbVersion: firstPayload.toDbVersion,
          appliedDbVersion: firstPayload.toDbVersion,
          appliedCount: firstPayload.changes.length,
          ok: true,
        } satisfies SyncChangesetAckPayload,
      }));
      await expect(nextEnvelope(serverSocket, "changeset_batch", 100)).rejects.toThrow(/Timed out/);

      const resetPromise = nextEnvelope(serverSocket, "changeset_batch");
      serverSocket.send(encodeSyncEnvelope({
        type: "changeset_ack",
        requestId: recoveredPayload.batchId,
        payload: {
          batchId: recoveredPayload.batchId,
          fromDbVersion: recoveredPayload.fromDbVersion,
          toDbVersion: recoveredPayload.toDbVersion,
          appliedDbVersion: recoveredPayload.toDbVersion,
          appliedCount: recoveredPayload.changes.length,
          ok: true,
        } satisfies SyncChangesetAckPayload,
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      peerService.flushLocalChanges();
      const resetPayload = (await resetPromise).payload as SyncChangesetBatchPayload;
      expect(resetPayload.fromDbVersion).toBe(recoveredPayload.toDbVersion);
      expect(resetPayload.changes).toHaveLength(250);
      expect(logger.debug).toHaveBeenCalledWith(
        "sync_peer.changeset_recovery_reset",
        { previousRecoveryLevel: 1 },
      );
    } finally {
      dateNowSpy.mockRestore();
    }
  }, 15_000);
});
