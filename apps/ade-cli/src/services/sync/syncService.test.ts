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

function createService(
  db: AdeDb,
  projectRoot: string,
  overrides: Partial<Parameters<typeof createSyncService>[0]> = {},
): SyncService {
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
    ...overrides,
  });
}

describe("createSyncService", () => {
  const cleanupRoots: string[] = [];

  afterEach(() => {
    for (const root of cleanupRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("forwards the usage service to the paired-client remote command surface", async () => {
    const projectRoot = makeTempRoot("ade-sync-service-usage-stats-");
    cleanupRoots.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
    const getAdeUsageStats = vi.fn(async () => ({
      generatedAt: "2026-07-09T12:00:00.000Z",
      preset: "year",
      daily: [],
    }));
    const service = createService(db, projectRoot, {
      usageTrackingService: { getAdeUsageStats } as any,
    });

    try {
      expect(service.getRemoteCommandDescriptor("usage.getAdeStats")).toEqual({
        action: "usage.getAdeStats",
        scope: "project",
        policy: { viewerAllowed: true },
      });
      await expect(service.executeRemoteCommand({
        commandId: "cmd-usage-stats",
        action: "usage.getAdeStats",
        args: { preset: "year" },
      })).resolves.toMatchObject({ preset: "year", daily: [] });
      expect(getAdeUsageStats).toHaveBeenCalledWith({ preset: "year" });
    } finally {
      await service.dispose();
      db.close();
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

  it("revokes paired phone secrets even when the sync host is stopped", async () => {
    const projectRoot = makeTempRoot("ade-sync-service-forget-device-");
    cleanupRoots.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
    const service = createService(db, projectRoot);
    const pairedDevicesPath = path.join(projectRoot, ".ade", "secrets", "sync", "sync-paired-devices.json");
    fs.mkdirSync(path.dirname(pairedDevicesPath), { recursive: true });
    fs.writeFileSync(
      pairedDevicesPath,
      `${JSON.stringify({
        "phone-1": {
          secretHash: "not-a-real-hash",
          createdAt: "2026-05-10T00:00:00.000Z",
          lastUsedAt: null,
          peerName: "Arul iPhone",
          peerPlatform: "iOS",
          peerDeviceType: "phone",
        },
      }, null, 2)}\n`,
    );

    try {
      await service.forgetDevice("phone-1");

      const records = JSON.parse(fs.readFileSync(pairedDevicesPath, "utf8")) as Record<string, unknown>;
      expect(records["phone-1"]).toBeUndefined();
    } finally {
      await service.dispose();
      db.close();
    }
  });

  it("persists peer app provenance in device metadata", async () => {
    const projectRoot = makeTempRoot("ade-sync-service-device-provenance-");
    cleanupRoots.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
    (db.sync as { isAvailable?: () => boolean }).isAvailable = () => true;
    const service = createService(db, projectRoot);
    const registry = service.getDeviceRegistryService();

    registry.upsertPeerMetadata({
      deviceId: "phone-1",
      deviceName: "Arul iPhone",
      platform: "iOS",
      deviceType: "phone",
      siteId: "phone-site",
      dbVersion: 14,
      appVersion: "1.1.10",
      appBuild: "4",
      bundleIdentifier: "com.ade.ios",
    });

    expect(registry.getDevice("phone-1")?.metadata).toMatchObject({
      dbVersion: 14,
      appVersion: "1.1.10",
      appBuild: "4",
      bundleIdentifier: "com.ade.ios",
    });

    await service.dispose();
    db.close();
  });

  it("routes external-session remote commands through the lazy service getter", async () => {
    const projectRoot = makeTempRoot("ade-sync-service-external-sessions-");
    cleanupRoots.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
    const list = vi.fn(async () => [{
      provider: "codex",
      id: "thread-1",
      cwd: projectRoot,
      title: "Thread one",
      preview: "Working",
      createdAt: 10,
      updatedAt: 20,
      messageCount: 2,
      alreadyImported: false,
      possiblyActive: false,
      cwdMatchesRequestedLane: true,
      capabilities: {
        resumeInPlace: true,
        resumeInDifferentCwd: true,
        fork: true,
        forkIntoDifferentCwd: true,
        importToChat: true,
      },
    }]);
    const externalSessionsService = {
      list,
      importExternalSession: vi.fn(),
    };
    const service = createService(db, projectRoot, {
      getExternalSessionsService: () => externalSessionsService as any,
    });

    try {
      expect(service.getRemoteCommandDescriptor("work.listExternalSessions")).toEqual({
        action: "work.listExternalSessions",
        scope: "project",
        policy: { viewerAllowed: true },
      });

      const result = await service.executeRemoteCommand({
        commandId: "cmd-1",
        action: "work.listExternalSessions",
        args: {
          providers: ["codex"],
          laneId: "lane-1",
          scope: "project",
        },
      });

      expect(list).toHaveBeenCalledWith({
        providers: ["codex"],
        laneId: "lane-1",
        scope: "project",
      });
      expect(result).toEqual(await list.mock.results[0]!.value);
    } finally {
      await service.dispose();
      db.close();
    }
  });
});
