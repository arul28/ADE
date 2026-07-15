import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openKvDb, type AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import { createSharedSyncListener } from "./sharedSyncListener";
import { createSyncService, type SyncService } from "./syncService";
import { probeAdeLoopbackListener, type SyncLoopbackProbeResult } from "./syncLoopbackProbe";

const ORIGINAL_BIND_HOST = vi.hoisted(() => process.env.ADE_SYNC_BIND_HOST);
vi.hoisted(() => {
  process.env.ADE_SYNC_BIND_HOST = "0.0.0.0";
});

const publishMock = vi.hoisted(() => vi.fn());
const bonjourDestroyMock = vi.hoisted(() => vi.fn());
const bonjourConstructorMock = vi.hoisted(() => vi.fn());

vi.mock("bonjour-service", () => ({
  Bonjour: bonjourConstructorMock,
}));

afterAll(() => {
  if (ORIGINAL_BIND_HOST === undefined) delete process.env.ADE_SYNC_BIND_HOST;
  else process.env.ADE_SYNC_BIND_HOST = ORIGINAL_BIND_HOST;
});

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
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
    hostStartupEnabled: true,
    hostDiscoveryEnabled: true,
    forceHostRole: true,
    localDeviceIdPath: path.join(projectRoot, ".ade", "secrets", "sync-device-id"),
    phonePairingStateDir: path.join(projectRoot, ".ade", "secrets", "sync"),
    fileService: {} as any,
    laneService: { list: vi.fn(async () => []) } as any,
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
    computerUseArtifactBrokerService: { listArtifacts: vi.fn(() => []) } as any,
    agentChatService: {
      listSessions: vi.fn(async () => []),
      subscribeToEvents: vi.fn(() => () => {}),
    } as any,
    processService: { listRuntime: vi.fn(() => []) } as any,
    ...overrides,
  });
}

async function listen(server: http.Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function bindForeignLegacyListener(): Promise<{ server: http.Server; port: number }> {
  for (let port = 8787; port <= 8800; port += 1) {
    const server = http.createServer((_request, response) => {
      response.writeHead(404, "Not Found");
      response.end("foreign");
    });
    try {
      await listen(server, port, "127.0.0.1");
      return { server, port };
    } catch {
      try {
        server.close();
      } catch {}
    }
  }
  throw new Error("No free legacy sync port was available for the collision test.");
}

async function findFreeLegacyPort(): Promise<number> {
  for (let port = 8787; port <= 8800; port += 1) {
    const server = http.createServer();
    try {
      await listen(server, port, "127.0.0.1");
      await close(server);
      return port;
    } catch {
      try {
        server.close();
      } catch {}
    }
  }
  throw new Error("No free legacy sync port was available for the startup-order test.");
}

function publishedPorts(): number[] {
  return publishMock.mock.calls
    .map(([options]) => (options as { port?: unknown }).port)
    .filter((port): port is number => typeof port === "number");
}

describe("sync loopback collision recovery", () => {
  beforeEach(() => {
    publishMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    publishMock.mockImplementation(() => ({ on: vi.fn(), stop: vi.fn() }));
    bonjourConstructorMock.mockImplementation(() => ({
      publish: publishMock,
      destroy: bonjourDestroyMock,
    }));
  });

  it.runIf(process.platform === "darwin")(
    "scans past a foreign 127.0.0.1 listener and publishes only the ADE-validated port",
    async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sync-loopback-shadow-"));
      const lockPath = path.join(projectRoot, "sync-host.lock");
      const previousLockPath = process.env.ADE_SYNC_HOST_LOCK_PATH;
      process.env.ADE_SYNC_HOST_LOCK_PATH = lockPath;
      const foreign = await bindForeignLegacyListener();
      const listener = createSharedSyncListener({ bindHost: "0.0.0.0" });
      const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
      (db.sync as { isAvailable?: () => boolean }).isAvailable = () => true;
      const service = createService(db, projectRoot, { sharedSyncListener: listener });
      service.getDeviceRegistryService().touchLocalDevice({ lastPort: foreign.port });

      try {
        await service.initialize();
        const status = await service.getStatus({ includeTransferReadiness: false });
        const resolvedPort = status.routeHealth.listener.port;

        expect(resolvedPort).not.toBe(foreign.port);
        expect(status.routeHealth.listener).toMatchObject({
          listenerBound: true,
          loopbackAdeValidated: true,
        });
        expect(status.routeHealth.listener.lastFailureAt).not.toBeNull();
        expect(status.localDevice.lastPort).toBe(resolvedPort);
        expect(status.pairingConnectInfo?.port).toBe(resolvedPort);
        expect(status.tailnetDiscovery).toMatchObject({
          servicePort: resolvedPort,
          updatedAt: expect.any(String),
        });
        expect(publishedPorts()).not.toContain(foreign.port);
        expect(new Set(publishedPorts())).toEqual(new Set([resolvedPort!]));
        await expect(probeAdeLoopbackListener(foreign.port)).resolves.toMatchObject({
          ok: false,
          statusCode: 404,
        });
        await expect(probeAdeLoopbackListener(resolvedPort!)).resolves.toMatchObject({
          ok: true,
          statusCode: 426,
        });
      } finally {
        await service.dispose();
        await listener.close();
        db.close();
        await close(foreign.server);
        fs.rmSync(projectRoot, { recursive: true, force: true });
        if (previousLockPath === undefined) delete process.env.ADE_SYNC_HOST_LOCK_PATH;
        else process.env.ADE_SYNC_HOST_LOCK_PATH = previousLockPath;
      }
    },
  );

  it("does not publish or persist a candidate until its loopback check passes", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sync-loopback-order-"));
    const lockPath = path.join(projectRoot, "sync-host.lock");
    const previousLockPath = process.env.ADE_SYNC_HOST_LOCK_PATH;
    process.env.ADE_SYNC_HOST_LOCK_PATH = lockPath;
    const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
    (db.sync as { isAvailable?: () => boolean }).isAvailable = () => true;
    const preferredPort = await findFreeLegacyPort();
    let releaseFirstProbe: ((result: SyncLoopbackProbeResult) => void) | null = null;
    let firstProbePort: number | null = null;
    const firstProbe = new Promise<SyncLoopbackProbeResult>((resolve) => {
      releaseFirstProbe = resolve;
    });
    const loopbackProbe = vi.fn(async (port: number) => {
      if (firstProbePort == null) {
        firstProbePort = port;
        return await firstProbe;
      }
      return await probeAdeLoopbackListener(port);
    });
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1", loopbackProbe });
    const service = createService(db, projectRoot, { sharedSyncListener: listener });
    service.getDeviceRegistryService().touchLocalDevice({ lastPort: preferredPort });

    try {
      const initializing = service.initialize();
      await vi.waitFor(() => expect(firstProbePort).not.toBeNull());
      expect(publishMock).not.toHaveBeenCalled();
      expect(service.getDeviceRegistryService().ensureLocalDevice().lastPort).toBe(preferredPort);

      releaseFirstProbe!({
        ok: false,
        port: firstProbePort!,
        statusCode: 404,
        statusMessage: "Not Found",
        checkedAt: new Date().toISOString(),
        reason: "foreign loopback listener",
      });
      await initializing;

      const status = await service.getStatus({ includeTransferReadiness: false });
      const resolvedPort = status.routeHealth.listener.port;
      expect(resolvedPort).not.toBe(firstProbePort);
      expect(status.localDevice.lastPort).toBe(resolvedPort);
      expect(status.routeHealth.listener.lastFailureAt).not.toBeNull();
      expect(status.tailnetDiscovery).toMatchObject({
        servicePort: resolvedPort,
        updatedAt: expect.any(String),
      });
      expect(publishedPorts()).not.toContain(firstProbePort);
      expect(new Set(publishedPorts())).toEqual(new Set([resolvedPort!]));
    } finally {
      await service.dispose();
      await listener.close();
      db.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      if (previousLockPath === undefined) delete process.env.ADE_SYNC_HOST_LOCK_PATH;
      else process.env.ADE_SYNC_HOST_LOCK_PATH = previousLockPath;
    }
  });
});
