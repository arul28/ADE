import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openKvDb, type AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import { createSharedSyncListener } from "./sharedSyncListener";
import { createSyncCloudRelayStore } from "./syncCloudRelayStore";
import { createSyncService, type SyncService } from "./syncService";
import { probeAdeLoopbackListener, type SyncLoopbackProbeResult } from "./syncLoopbackProbe";
import type { SyncTunnelClientStatus } from "./syncTunnelClientService";

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

async function bindForeignBare426Listener(): Promise<{ server: http.Server; port: number }> {
  // A bare `ws`-style server answers plain GETs with 426 Upgrade Required but
  // WITHOUT the ADE loopback marker header — exactly what the probe must reject.
  for (let port = 8787; port <= 8800; port += 1) {
    const server = http.createServer((_request, response) => {
      const body = "Upgrade Required";
      response.writeHead(426, {
        "Content-Type": "text/plain",
        "Content-Length": Buffer.byteLength(body),
      });
      response.end(body);
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
  throw new Error("No free legacy sync port was available for the bare-426 test.");
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
        await expect(probeAdeLoopbackListener(
          foreign.port,
          listener.getExpectedLoopbackNonce(),
        )).resolves.toMatchObject({
          ok: false,
          statusCode: 404,
        });
        await expect(probeAdeLoopbackListener(
          resolvedPort!,
          listener.getExpectedLoopbackNonce(),
        )).resolves.toMatchObject({
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
    const loopbackProbe = vi.fn(async (port: number, expectedNonce: string) => {
      if (firstProbePort == null) {
        firstProbePort = port;
        return await firstProbe;
      }
      return await probeAdeLoopbackListener(port, expectedNonce);
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
        markerValue: null,
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

  // Regression for PR #816: when relay is participating and the loopback listener is
  // genuinely ADE-validated, but the relay bridge has NOT been validated against
  // the current sync port, the relay route must report a non-null reason (an
  // unhealthy/failing route) rather than swallowing it as a null lastError.
  it.runIf(process.platform === "darwin")(
    "flags the relay route unhealthy when the relay bridge is not validated against the current sync port",
    async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sync-relay-bridge-"));
      const lockPath = path.join(projectRoot, "sync-host.lock");
      const previousLockPath = process.env.ADE_SYNC_HOST_LOCK_PATH;
      process.env.ADE_SYNC_HOST_LOCK_PATH = lockPath;
      const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
      const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
      (db.sync as { isAvailable?: () => boolean }).isAvailable = () => true;
      const cloudRelayStore = createSyncCloudRelayStore({
        filePath: path.join(projectRoot, ".ade", "secrets", "sync", "cloud-relay.json"),
      });
      // Relay control is up, but the bridge has not been validated against the
      // live sync port — exactly the state that must surface as a failing route.
      const tunnelStatus: SyncTunnelClientStatus = {
        connected: true,
        activeTunnels: 0,
        lastError: null,
        relayBridgeValidated: false,
        validatedPort: null,
        lastFailureAt: null,
        lastSuccessAt: null,
        relayUrl: "https://relay.test.ade",
        machineKey: "a".repeat(32),
      };
      const service = createService(db, projectRoot, {
        sharedSyncListener: listener,
        cloudRelayStore,
        syncTunnelClientService: { getStatus: () => tunnelStatus },
        accountAuthService: {
          getStatus: () => ({ signedIn: true, userId: "relay-owner" }),
        } as any,
      });
      const preferredPort = await findFreeLegacyPort();
      service.getDeviceRegistryService().touchLocalDevice({ lastPort: preferredPort });

      try {
        await service.initialize();
        const status = await service.getStatus({ includeTransferReadiness: false });

        // Sanity: the loopback listener really is ADE-validated, so the relay
        // reason below cannot be attributed to a bad loopback branch.
        expect(status.routeHealth.listener.loopbackAdeValidated).toBe(true);
        expect(status.routeHealth.relay.enabled).toBe(true);
        expect(status.routeHealth.relay.relayControlConnected).toBe(true);

        // The regression: an unvalidated relay bridge must yield a non-null reason.
        expect(status.routeHealth.relay.relayBridgeValidated).toBe(false);
        expect(typeof status.routeHealth.relay.reason).toBe("string");
        expect(status.routeHealth.relay.reason).toMatch(/not been validated/);
      } finally {
        await service.dispose();
        await listener.close();
        db.close();
        fs.rmSync(projectRoot, { recursive: true, force: true });
        if (previousLockPath === undefined) delete process.env.ADE_SYNC_HOST_LOCK_PATH;
        else process.env.ADE_SYNC_HOST_LOCK_PATH = previousLockPath;
      }
    },
  );

  // Finding #1: a bare `ws`-style 426 (no ADE marker) must be rejected, while the
  // real ADE listener — whose 426 carries the marker — passes. Status code alone
  // cannot tell ADE apart from any other WebSocket process.
  it("rejects a foreign bare-426 listener without the ADE marker but accepts the real ADE listener", async () => {
    const foreign = await bindForeignBare426Listener();
    const adeListener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    try {
      const adePort = await adeListener.ensureListening([0]);

      const expectedNonce = adeListener.getExpectedLoopbackNonce();
      const foreignResult = await probeAdeLoopbackListener(foreign.port, expectedNonce);
      expect(foreignResult).toMatchObject({ ok: false, statusCode: 426 });
      expect(foreignResult.reason).toMatch(/did not present a loopback identity/);

      const adeResult = await probeAdeLoopbackListener(adePort, expectedNonce);
      expect(adeResult).toMatchObject({ ok: true, statusCode: 426 });
    } finally {
      await adeListener.close();
      await close(foreign.server);
    }
  });

  // Finding #3: an ephemeral [0] bind whose first resolved port is loopback-
  // shadowed must re-bind to a fresh OS-assigned port and succeed.
  it("re-binds an ephemeral [0] listener onto a fresh port when the first resolved port is shadowed", async () => {
    const shadowedPorts: number[] = [];
    let shadowsRemaining = 1;
    const loopbackProbe = vi.fn(async (
      port: number,
      expectedNonce: string,
    ): Promise<SyncLoopbackProbeResult> => {
      if (shadowsRemaining > 0) {
        shadowsRemaining -= 1;
        shadowedPorts.push(port);
        return {
          ok: false,
          port,
          statusCode: 404,
          statusMessage: "Not Found",
          markerValue: null,
          checkedAt: new Date().toISOString(),
          reason: "ephemeral loopback shadow",
        };
      }
      // Once past the injected shadow, run the REAL probe against the real ADE
      // listener (which now emits the marker), proving an end-to-end fresh bind.
      return await probeAdeLoopbackListener(port, expectedNonce);
    });
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1", loopbackProbe });
    try {
      const port = await listener.ensureListening([0]);
      expect(shadowedPorts).toHaveLength(1);
      expect(port).toBeGreaterThan(0);
      expect(port).not.toBe(shadowedPorts[0]);
      expect(listener.isListening()).toBe(true);
      expect(listener.getLoopbackValidationStatus().loopbackAdeValidated).toBe(true);
    } finally {
      await listener.close();
    }
  }, 15_000);

  // Finding #3 (bound): a persistently-shadowed ephemeral bind must still
  // terminate with a failure rather than spin forever.
  it("gives up an ephemeral [0] bind that is persistently loopback-shadowed", async () => {
    const loopbackProbe = vi.fn(async (port: number): Promise<SyncLoopbackProbeResult> => ({
      ok: false,
      port,
      statusCode: 404,
      statusMessage: "Not Found",
      markerValue: null,
      checkedAt: new Date().toISOString(),
      reason: "persistent loopback shadow",
    }));
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1", loopbackProbe });
    try {
      await expect(listener.ensureListening([0])).rejects.toThrow(/persistent loopback shadow/);
      // Bounded: it must not probe forever.
      expect(loopbackProbe.mock.calls.length).toBeGreaterThan(1);
      expect(loopbackProbe.mock.calls.length).toBeLessThanOrEqual(16);
      expect(listener.isListening()).toBe(false);
    } finally {
      await listener.close();
    }
  }, 15_000);
});
