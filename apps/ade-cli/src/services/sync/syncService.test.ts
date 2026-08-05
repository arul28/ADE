import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openKvDb, type AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import { createSyncService, type SyncService } from "./syncService";
import {
  buildDegradedProjectlessSyncSnapshot,
  buildProjectlessSyncSnapshot,
  type ProjectlessSyncSnapshotArgs,
} from "./projectlessSyncSnapshot";
import { buildRelayRouteHealth, deriveListenerHealth } from "./syncRouteHealth";
import type { SyncLoopbackValidationStatus } from "./syncLoopbackProbe";
import type { SyncTunnelClientStatus } from "./syncTunnelClientService";
import { createSyncAccountDirectoryHealth } from "../../../../desktop/src/shared/types";
import { removeTestTree } from "../../test/filesystem";

vi.mock("../../../../desktop/src/main/services/state/crsqliteExtension", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../../../desktop/src/main/services/state/crsqliteExtension")
  >();
  return process.platform === "win32"
    ? { ...original, resolveCrsqliteExtensionPath: () => null }
    : original;
});

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
    ...overrides,
  });
}

describe("createSyncService", () => {
  const cleanupRoots: string[] = [];

  afterEach(async () => {
    for (const root of cleanupRoots.splice(0)) {
      await removeTestTree(root);
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
    const getUsageSnapshot = vi.fn(() => ({ windows: [], lastPolledAt: "2026-07-09T12:00:00.000Z", errors: [] }));
    const forceRefresh = vi.fn(async () => ({ windows: [], lastPolledAt: "2026-07-09T12:01:00.000Z", errors: [] }));
    const service = createService(db, projectRoot, {
      usageTrackingService: { getAdeUsageStats, getUsageSnapshot, forceRefresh } as any,
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
      await expect(service.executeRemoteCommand({
        commandId: "cmd-usage-quota",
        action: "usage.getQuotaSnapshot",
        args: {},
      })).resolves.toMatchObject({ lastPolledAt: "2026-07-09T12:00:00.000Z" });
      await expect(service.executeRemoteCommand({
        commandId: "cmd-refresh-quota",
        action: "usage.refreshQuota",
        args: {},
      })).resolves.toMatchObject({ lastPolledAt: "2026-07-09T12:01:00.000Z" });
      expect(getUsageSnapshot).toHaveBeenCalledTimes(1);
      expect(forceRefresh).toHaveBeenCalledWith({ allowInteractiveAuth: false });
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
    const importExternalSession = vi.fn(async (args: { laneId: string }) => ({
      kind: "chat" as const,
      chatSessionId: "chat-imported",
      laneId: args.laneId,
      chatSummary: {
        sessionId: "chat-imported",
        laneId: args.laneId,
        title: "Persisted imported chat",
      },
    }));
    const externalSessionsService = { list, importExternalSession };
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

      const imported = await service.executeRemoteCommand({
        commandId: "cmd-2",
        action: "work.importExternalSession",
        args: {
          provider: "claude",
          sessionId: "session-1",
          laneId: "lane-1",
          target: "chat",
          mode: "fork",
        },
      });
      expect(importExternalSession).toHaveBeenCalledWith({
        provider: "claude",
        sessionId: "session-1",
        laneId: "lane-1",
        target: "chat",
        mode: "fork",
      });
      expect(imported).toEqual({
        kind: "chat",
        chatSessionId: "chat-imported",
        laneId: "lane-1",
        chatSummary: {
          sessionId: "chat-imported",
          laneId: "lane-1",
          title: "Persisted imported chat",
        },
      });
    } finally {
      await service.dispose();
      db.close();
    }
  });
});

describe("buildProjectlessSyncSnapshot", () => {
  const cleanupRoots: string[] = [];

  afterEach(async () => {
    for (const root of cleanupRoots.splice(0)) {
      await removeTestTree(root);
    }
  });

  function makeSecretsDir(): string {
    const root = makeTempRoot("ade-projectless-snapshot-");
    cleanupRoots.push(root);
    const secretsDir = path.join(root, "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(path.join(secretsDir, "sync-device-id"), "device-machine\n");
    fs.writeFileSync(path.join(secretsDir, "sync-site-id"), "site-machine\n");
    return secretsDir;
  }

  function args(
    secretsDir: string,
    overrides: Partial<ProjectlessSyncSnapshotArgs> = {},
  ): ProjectlessSyncSnapshotArgs {
    return {
      secretsDir,
      listener: {
        getPort: () => 8791,
        getLoopbackValidationStatus: () => ({
          port: 8791,
          loopbackAdeValidated: true,
          lastFailureAt: null,
          reason: null,
          lastSuccessAt: "2026-07-16T00:00:00.000Z",
        }),
      },
      holdsSyncHostLease: true,
      relay: { accountSignedIn: false, wssUrl: null, status: null },
      accountDirectory: createSyncAccountDirectoryHealth("published", null),
      ...overrides,
    };
  }

  it("reports the bound listener and real pairing connect info while hosting without a project", () => {
    const secretsDir = makeSecretsDir();

    const snapshot = buildProjectlessSyncSnapshot(args(secretsDir));

    expect(snapshot.routeHealth.listener).toMatchObject({
      listenerBound: true,
      loopbackAdeValidated: true,
      port: 8791,
      reason: null,
    });
    expect(snapshot.runtimeRole).toBe("host");
    expect(snapshot.pairingConnectInfo).not.toBeNull();
    expect(snapshot.pairingConnectInfo?.port).toBe(8791);
    expect(snapshot.pairingConnectInfo?.hostIdentity.deviceId).toBe("device-machine");
    expect(snapshot.pairingConnectInfo?.hostIdentity.siteId).toBe("site-machine");
    // A published machine needs no pairing code: account membership is the auth
    // path and the PIN is only a fallback for nearby unsigned-in devices.
    expect(snapshot.pairingPinConfigured).toBe(false);
    expect(snapshot.localDevice.lastPort).toBe(8791);
  });

  it("stays pessimistic when the lease is not held or the listener is unbound", () => {
    const secretsDir = makeSecretsDir();

    const noLease = buildProjectlessSyncSnapshot(args(secretsDir, { holdsSyncHostLease: false }));
    const noListener = buildProjectlessSyncSnapshot(args(secretsDir, { listener: null }));
    const degraded = buildDegradedProjectlessSyncSnapshot({ secretsDir });

    for (const snapshot of [noLease, noListener, degraded]) {
      expect(snapshot.routeHealth.listener.listenerBound).toBe(false);
      expect(snapshot.routeHealth.listener.port).toBeNull();
      expect(snapshot.pairingConnectInfo).toBeNull();
      expect(snapshot.routeHealth.relay.enabled).toBe(false);
      expect(snapshot.routeHealth.listener.reason).toBe("No active sync project scope.");
    }
  });

  it("enables relay purely from hosting plus a signed-in account, with no project", () => {
    const secretsDir = makeSecretsDir();

    const signedOut = buildProjectlessSyncSnapshot(args(secretsDir));
    const signedIn = buildProjectlessSyncSnapshot(args(secretsDir, {
      relay: {
        accountSignedIn: true,
        wssUrl: "wss://relay.example/connect/machine-key",
        status: {
          accountLeaseValid: true,
          connected: true,
          relayBridgeValidated: true,
          activeTunnels: 0,
          lastError: null,
          bridgeOpenFailure: null,
          lastControlError: null,
          validatedPort: 8791,
          lastFailureAt: null,
          lastControlOpenAt: "2026-07-16T00:00:00.000Z",
          lastBridgeValidationAt: "2026-07-16T00:00:00.000Z",
          relayEndToEndVerifiedAt: "2026-07-16T00:00:01.000Z",
          relayEndToEndFailure: null,
          relayEndToEndRoundTripMs: 42,
          controlSuppressed: false,
          controlSuppressedReason: null,
          controlFailingSinceMs: null,
        } as ProjectlessSyncSnapshotArgs["relay"]["status"],
      },
    }));

    expect(signedOut.routeHealth.relay.enabled).toBe(false);
    expect(signedOut.routeHealth.relay.skipReason).toBe("Sign in to ADE to use ADE Relay.");
    expect(signedIn.routeHealth.relay).toMatchObject({
      enabled: true,
      relayControlConnected: true,
      relayBridgeValidated: true,
      skipReason: null,
    });
    expect(signedIn.pairingConnectInfo?.addressCandidates).toContainEqual({
      kind: "relay",
      host: "wss://relay.example/connect/machine-key",
    });
  });
});

describe("syncRouteHealth", () => {
  const validated: SyncLoopbackValidationStatus = {
    port: 8791,
    loopbackAdeValidated: true,
    lastFailureAt: null,
    reason: null,
    lastSuccessAt: "2026-07-16T00:00:00.000Z",
  };

  function tunnelStatus(overrides: Partial<SyncTunnelClientStatus>): SyncTunnelClientStatus {
    return {
      connected: true,
      activeTunnels: 0,
      lastError: null,
      lastControlError: null,
      relayBridgeValidated: true,
      validatedPort: 8791,
      lastFailureAt: null,
      lastControlOpenAt: "2026-07-16T00:00:00.000Z",
      lastBridgeValidationAt: "2026-07-16T00:00:00.000Z",
      relayEndToEndVerifiedAt: null,
      relayEndToEndFailure: null,
      relayEndToEndRoundTripMs: null,
      relayUrl: "wss://relay.example",
      machineKey: "machine-key",
      ...overrides,
    };
  }

  it("keeps each caller's wording for an unbound listener and hides the port", () => {
    const scoped = deriveListenerHealth({
      listenerPort: null,
      rawValidation: { ...validated, port: null, loopbackAdeValidated: false },
      bound: false,
      notBoundReason: "The ADE sync listener is not bound.",
    });
    // A projectless brain can hold a bound port without the machine-wide
    // sync-host lease. It is not the host, so it must not advertise the port.
    const projectless = deriveListenerHealth({
      listenerPort: 8791,
      rawValidation: validated,
      bound: false,
      notBoundReason: "No active sync project scope.",
    });

    expect(scoped.listener.reason).toBe("The ADE sync listener is not bound.");
    expect(projectless.listener.reason).toBe("No active sync project scope.");
    expect(projectless.listener.port).toBeNull();
    expect(projectless.loopbackAdeValidated).toBe(false);
  });

  it("discards a validation result that describes a different port", () => {
    const health = deriveListenerHealth({
      listenerPort: 8792,
      rawValidation: validated,
      bound: true,
      notBoundReason: "The ADE sync listener is not bound.",
    });

    expect(health.loopbackAdeValidated).toBe(false);
    expect(health.listener.reason).toBe("127.0.0.1:8792 did not answer as ADE.");
  });

  it("fills probe timestamps from accumulated history only where the current result has none", () => {
    const health = deriveListenerHealth({
      listenerPort: 8791,
      rawValidation: validated,
      bound: true,
      notBoundReason: "The ADE sync listener is not bound.",
      validationHistory: {
        lastFailureAt: "2026-07-15T00:00:00.000Z",
        lastSuccessAt: "2026-07-01T00:00:00.000Z",
      },
    });

    expect(health.listener.lastFailureAt).toBe("2026-07-15T00:00:00.000Z");
    expect(health.listener.lastSuccessAt).toBe("2026-07-16T00:00:00.000Z");
  });

  it("borrows the loopback failure time only while relay is enabled and skipped", () => {
    const base = {
      relayConfigured: true,
      loopbackAdeValidated: false,
      listenerReason: "127.0.0.1:8791 did not answer as ADE.",
      listenerPort: 8791,
      tunnelStatus: null,
      lastFailureAtFallback: "2026-07-15T00:00:00.000Z",
    };

    const skipped = buildRelayRouteHealth({ ...base, relayAccountSignedIn: true });
    const signedOut = buildRelayRouteHealth({ ...base, relayAccountSignedIn: false });
    const noFallback = buildRelayRouteHealth({
      ...base,
      relayAccountSignedIn: true,
      lastFailureAtFallback: null,
    });

    expect(skipped.skipReason)
      .toBe("Relay route is unusable because 127.0.0.1:8791 did not answer as ADE.");
    expect(skipped.lastFailureAt).toBe("2026-07-15T00:00:00.000Z");
    // Relay is not enabled at all, so there is no relay failure to date-stamp.
    expect(signedOut.skipReason).toBe("Sign in to ADE to use ADE Relay.");
    expect(signedOut.lastFailureAt).toBeNull();
    // A caller with no probe history reports no time rather than borrowing one.
    expect(noFallback.lastFailureAt).toBeNull();
  });

  it("ranks the 4505 eviction reason above the raw close text", () => {
    const health = buildRelayRouteHealth({
      relayConfigured: true,
      relayAccountSignedIn: true,
      loopbackAdeValidated: true,
      listenerReason: null,
      listenerPort: 8791,
      tunnelStatus: tunnelStatus({
        connected: false,
        controlSuppressed: true,
        controlSuppressedReason: "Another ADE process on this machine owns ADE Relay.",
        lastControlError: "Relay control closed with code 4505.",
        lastError: "socket hang up",
      }),
      lastFailureAtFallback: null,
    });

    expect(health.skipReason).toBe("Another ADE process on this machine owns ADE Relay.");
    expect(health.relayControlSuppressed).toBe(true);
    expect(health.enabled).toBe(true);
  });

  it("reports a bridge-open failure once control and bridge are both up", () => {
    const healthy = buildRelayRouteHealth({
      relayConfigured: true,
      relayAccountSignedIn: true,
      loopbackAdeValidated: true,
      listenerReason: null,
      listenerPort: 8791,
      tunnelStatus: tunnelStatus({}),
      lastFailureAtFallback: null,
    });
    const bridgeBlocked = buildRelayRouteHealth({
      relayConfigured: true,
      relayAccountSignedIn: true,
      loopbackAdeValidated: true,
      listenerReason: null,
      listenerPort: 8791,
      tunnelStatus: tunnelStatus({ bridgeOpenFailure: "Local bridge socket refused." }),
      lastFailureAtFallback: null,
    });

    expect(healthy.skipReason).toBeNull();
    expect(bridgeBlocked.skipReason).toBe("Local bridge socket refused.");
  });
});
