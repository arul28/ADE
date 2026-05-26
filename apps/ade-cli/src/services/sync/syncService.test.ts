import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openKvDb, type AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import { createSyncService, type SyncService } from "./syncService";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function getUnusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function createService(db: AdeDb, projectRoot: string): SyncService {
  return createSyncService({
    db,
    logger: createLogger() as any,
    projectRoot,
    hostStartupEnabled: false,
    localDeviceIdPath: path.join(projectRoot, ".ade", "secrets", "sync-device-id"),
    phonePairingStateDir: path.join(projectRoot, ".ade", "secrets", "sync"),
    fileService: {} as any,
    laneService: {
      list: vi.fn(async () => []),
    } as any,
    prService: {} as any,
    sessionService: {
      list: vi.fn(() => []),
      get: vi.fn(() => null),
      readTranscriptTail: vi.fn(async () => ""),
    } as any,
    ptyService: {
      readTranscriptTail: vi.fn(async () => ""),
      enrichSessions: vi.fn((rows: unknown[]) => rows),
    } as any,
    computerUseArtifactBrokerService: {
      listArtifacts: vi.fn(() => []),
    } as any,
    agentChatService: {
      listSessions: vi.fn(async () => []),
    } as any,
    processService: {
      listRuntime: vi.fn(() => []),
    } as any,
  });
}

describe("createSyncService", () => {
  const cleanupRoots: string[] = [];

  afterEach(() => {
    for (const root of cleanupRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the local device registry when connectToBrain fails before handshake", async () => {
    const projectRoot = makeTempRoot("ade-sync-service-connect-fail-");
    cleanupRoots.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
    (db.sync as { isAvailable?: () => boolean }).isAvailable = () => true;
    const service = createService(db, projectRoot);
    const registry = service.getDeviceRegistryService();
    registry.upsertPeerMetadata({
      deviceId: "peer-old",
      deviceName: "Previous host",
      platform: "macOS",
      deviceType: "desktop",
      siteId: "peer-site",
      dbVersion: 12,
    });

    expect(registry.getDevice("peer-old")?.name).toBe("Previous host");

    try {
      await expect(service.connectToBrain({
        host: "127.0.0.1",
        port: await getUnusedPort(),
        token: "bad-token",
      })).rejects.toThrow();

      expect(registry.getDevice("peer-old")?.name).toBe("Previous host");
    } finally {
      await service.dispose();
      db.close();
    }
  });
});
