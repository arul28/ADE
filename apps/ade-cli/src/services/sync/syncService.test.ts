import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openKvDb, type AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import {
  createSyncService,
  shouldReclaimStaleViewerDraftAfterTransportFailure,
  type SyncService,
} from "./syncService";
import {
  buildDegradedProjectlessSyncSnapshot,
  buildProjectlessSyncSnapshot,
  type ProjectlessSyncSnapshotArgs,
} from "./projectlessSyncSnapshot";
import { buildRelayRouteHealth, deriveListenerHealth } from "./syncRouteHealth";
import type { SyncLoopbackValidationStatus } from "./syncLoopbackProbe";
import type { SyncTunnelClientStatus } from "./syncTunnelClientService";
import {
  createSyncAccountDirectoryHealth,
  type SyncRoleSnapshot,
} from "../../../../desktop/src/shared/types";
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

  const failedDial = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
  const testDraft = {
    host: "192.0.2.20",
    port: 45872,
    token: "token",
    authKind: "bootstrap" as const,
    pairedDeviceId: null,
    lastRemoteDbVersion: 0,
  };
  const rolePolicyLocalDevice = (hostname = "MacBook-Pro-567.local") => ({
    deviceId: "this-device",
    ipAddresses: [],
    tailscaleIp: null,
    metadata: { hostname },
  } as any);

  it("reclaims a same-hostname ghost brain after its failed viewer dial", () => {
    const now = Date.now();
    const localDevice = rolePolicyLocalDevice();
    expect(shouldReclaimStaleViewerDraftAfterTransportFailure({
      hostStartupEnabled: true,
      crdtSyncAvailable: true,
      cluster: { brainDeviceId: "ghost-brain" },
      localDevice,
      brain: {
        lastSeenAt: new Date(now - 2 * 60 * 60_000).toISOString(),
        updatedAt: new Date(now).toISOString(),
        metadata: { hostname: "MacBook-Pro-567.local" },
      },
      draft: testDraft,
      error: failedDial,
      now,
    })).toBe(true);
  });

  it("does not reclaim a same-hostname brain seen five minutes ago", () => {
    const now = Date.now();
    expect(shouldReclaimStaleViewerDraftAfterTransportFailure({
      hostStartupEnabled: true,
      crdtSyncAvailable: true,
      cluster: { brainDeviceId: "recent-collision" },
      localDevice: rolePolicyLocalDevice(),
      brain: {
        lastSeenAt: new Date(now - 5 * 60_000).toISOString(),
        updatedAt: new Date(now).toISOString(),
        metadata: { hostname: "MacBook-Pro-567.local" },
      },
      draft: testDraft,
      error: failedDial,
      now,
    })).toBe(false);
  });

  it("does not reclaim a recently seen remote brain after its failed dial", () => {
    const now = Date.now();
    expect(shouldReclaimStaleViewerDraftAfterTransportFailure({
      hostStartupEnabled: true,
      crdtSyncAvailable: true,
      cluster: { brainDeviceId: "recent-remote" },
      localDevice: rolePolicyLocalDevice(),
      brain: {
        lastSeenAt: new Date(now - 2 * 60_000).toISOString(),
        updatedAt: new Date(now).toISOString(),
        metadata: { hostname: "different-machine.local" },
      },
      draft: testDraft,
      error: failedDial,
      now,
    })).toBe(false);
  });

  // The viewer branch dials only when the CRDT extension is available; the win32 mock above turns it off.
  it.skipIf(process.platform === "win32")("never dials this machine for a fresh remote brain that has no address", async () => {
    const projectRoot = makeTempRoot("ade-sync-service-addressless-brain-");
    cleanupRoots.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
    // This machine's own listener: a viewer that dials 127.0.0.1 for the remote brain lands here.
    let selfDials = 0;
    const selfListener = net.createServer((socket) => {
      selfDials += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => selfListener.listen(0, "127.0.0.1", resolve));
    const logger = createLogger();
    const service = createService(db, projectRoot, { hostStartupEnabled: false, logger: logger as any });
    const registry = service.getDeviceRegistryService();
    registry.upsertPeerMetadata({
      deviceId: "addressless-brain",
      deviceName: "Addressless brain",
      platform: "macOS",
      deviceType: "desktop",
      siteId: "addressless-site",
      dbVersion: 1,
    } as any, { lastSeenAt: new Date().toISOString(), lastPort: (selfListener.address() as net.AddressInfo).port });
    registry.setClusterState({ brainDeviceId: "addressless-brain", brainEpoch: 1 });
    fs.mkdirSync(path.join(projectRoot, ".ade", "secrets", "sync"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".ade", "secrets", "sync", "sync-bootstrap-token"), "token\n");
    try {
      await service.reevaluateHostRole();
      expect(selfDials).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith("sync.role.viewer_no_reachable_address", {
        brainDeviceId: "addressless-brain",
        brainRecordKnown: true,
      });
    } finally {
      await service.dispose();
      await new Promise<void>((resolve) => selfListener.close(() => resolve()));
      db.close();
    }
  });

  describe("a project's legacy sync draft and the shared pairing directory", () => {
    // One machine-wide pairing directory, shared by every project in a test.
    const makeMachineDir = () => {
      const machineDir = makeTempRoot("ade-sync-machine-");
      cleanupRoots.push(machineDir);
      fs.writeFileSync(path.join(machineDir, "sync-bootstrap-token"), "token\n");
      return machineDir;
    };
    const openProject = async (machineDir: string) => {
      const projectRoot = makeTempRoot("ade-sync-project-");
      cleanupRoots.push(projectRoot);
      const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
      const service = createService(db, projectRoot, { phonePairingStateDir: machineDir });
      return { db, service, registry: service.getDeviceRegistryService() };
    };

    it("does not let an untagged draft in the shared file redirect another project", async () => {
      const machineDir = makeMachineDir();
      fs.writeFileSync(path.join(machineDir, "sync-peer-draft.json"), JSON.stringify({
        host: "192.168.1.89", port: 45872, authKind: "bootstrap", pairedDeviceId: null, lastRemoteDbVersion: 0,
      }));
      const following = await openProject(machineDir);
      const unjoined = await openProject(machineDir);
      try {
        following.registry.upsertPeerMetadata({
          deviceId: "brain-b", deviceName: "brain-b", platform: "macOS", deviceType: "desktop", siteId: "brain-b-site", dbVersion: 1,
        } as any, { lastSeenAt: new Date(Date.now() - 2 * 60_000).toISOString(), lastHost: "192.0.2.30", lastPort: 45872 });
        following.registry.setClusterState({ brainDeviceId: "brain-b", brainEpoch: 1 });
        expect(following.service.getHostBlocker()).toEqual({ reason: "cluster_record", host: "192.0.2.30", port: 45872 });
        expect(unjoined.service.getHostBlocker()).toBeNull();
      } finally {
        await following.service.dispose();
        following.db.close();
        await unjoined.service.dispose();
        unjoined.db.close();
      }
    });

    it("refuses disconnectFromBrain on the brain and keeps its devices and cluster record", async () => {
      const project = await openProject(makeMachineDir());
      try {
        const { registry } = project;
        registry.setClusterState({ brainDeviceId: registry.getLocalDeviceId(), brainEpoch: 1 });
        registry.upsertPeerMetadata({
          deviceId: "phone-1", deviceName: "Phone", platform: "iOS", deviceType: "phone", siteId: "phone-1-site", dbVersion: 1,
        } as any, { lastSeenAt: new Date().toISOString() });
        await expect(project.service.disconnectFromBrain()).rejects.toThrow("This project is the sync brain");
        expect(registry.getClusterState()?.brainDeviceId).toBe(registry.getLocalDeviceId());
        expect(registry.listDevices().map((device) => device.deviceId)).toContain("phone-1");
      } finally {
        await project.service.dispose();
        project.db.close();
      }
    });
  });

  it("leaves a dead brain's cluster record alone when this runtime may not host", async () => {
    const projectRoot = makeTempRoot("ade-sync-service-no-draft-failover-");
    cleanupRoots.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
    const service = createService(db, projectRoot, { hostStartupEnabled: false });
    const registry = service.getDeviceRegistryService();
    registry.upsertPeerMetadata({
      deviceId: "dead-brain",
      deviceName: "Dead brain",
      platform: "macOS",
      deviceType: "desktop",
      siteId: "dead-site",
      dbVersion: 1,
    } as any, { lastSeenAt: new Date(Date.now() - 6 * 60_000).toISOString() });
    registry.setClusterState({ brainDeviceId: "dead-brain", brainEpoch: 3 });
    try {
      await service.reevaluateHostRole();
      // A non-host runtime must not take over a dead brain's record: it could
      // never serve sync, and it would block the host-capable runtime's failover.
      expect(registry.getClusterState()?.brainDeviceId).toBe("dead-brain");
      expect(registry.getClusterState()?.brainEpoch).toBe(3);
    } finally {
      await service.dispose();
      db.close();
    }
  });

  const seedDeadBrainRecord = (registry: ReturnType<SyncService["getDeviceRegistryService"]>) => {
    registry.upsertPeerMetadata({
      deviceId: "dead-brain",
      deviceName: "Dead brain",
      platform: "macOS",
      deviceType: "desktop",
      siteId: "dead-site",
      dbVersion: 1,
    } as any, { lastSeenAt: new Date(Date.now() - 6 * 60_000).toISOString() });
    registry.setClusterState({ brainDeviceId: "dead-brain", brainEpoch: 3 });
  };

  it.each([
    { label: "no cluster record", seedDeadBrain: false, expectedEpoch: 1 },
    { label: "a dead remote brain's record", seedDeadBrain: true, expectedEpoch: 4 },
  ])("the machine brain's cold serve scope claims the cluster record at startup ($label)", async ({
    seedDeadBrain,
    expectedEpoch,
  }) => {
    const projectRoot = makeTempRoot("ade-sync-service-machine-brain-claim-");
    cleanupRoots.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
    // The serve scope of the machine's ADE home, before its project is selected
    // as the host: host startup is off, but the machine brain may still claim.
    const service = createService(db, projectRoot, { hostStartupEnabled: false, mayClaimCluster: true });
    const registry = service.getDeviceRegistryService();
    if (seedDeadBrain) seedDeadBrainRecord(registry);
    try {
      await service.initialize();
      expect(registry.getClusterState()?.brainDeviceId).toBe(registry.getLocalDeviceId());
      expect(registry.getClusterState()?.brainEpoch).toBe(expectedEpoch);
    } finally {
      await service.dispose();
      db.close();
    }
  }, 30_000);

  it("refuses an explicit host transfer from a runtime that may not host, leaving the record alone", async () => {
    const projectRoot = makeTempRoot("ade-sync-service-non-host-transfer-");
    cleanupRoots.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
    const service = createService(db, projectRoot, { hostStartupEnabled: false });
    const registry = service.getDeviceRegistryService();
    seedDeadBrainRecord(registry);
    try {
      await expect(service.transferBrainToLocal()).rejects.toThrow();
      expect(registry.getClusterState()?.brainDeviceId).toBe("dead-brain");
      expect(registry.getClusterState()?.brainEpoch).toBe(3);
    } finally {
      await service.dispose();
      db.close();
    }
  });

  it("lets the machine brain take the host role by explicit transfer", async () => {
    const projectRoot = makeTempRoot("ade-sync-service-machine-brain-transfer-");
    cleanupRoots.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
    const service = createService(db, projectRoot, { hostStartupEnabled: false, mayClaimCluster: true });
    const registry = service.getDeviceRegistryService();
    seedDeadBrainRecord(registry);
    try {
      const transferred = await service.transferBrainToLocal();
      expect(transferred.role).toBe("brain");
      expect(transferred.clusterState?.brainDeviceId).toBe(registry.getLocalDeviceId());
      expect(transferred.clusterState?.brainEpoch).toBe(4);
    } finally {
      await service.dispose();
      db.close();
    }
  }, 30_000);

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

  it("reaches the sync-host role without waiting on the status snapshot", async () => {
    const projectRoot = makeTempRoot("ade-sync-service-activation-drain-");
    cleanupRoots.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
    // Keep the listener itself out of this test: it pins the drain, not the host.
    (db.sync as { isAvailable?: () => boolean }).isAvailable = () => false;
    const sessionList = vi.fn(() => []);
    let releaseEnumeration: () => void = () => undefined;
    const enumeration = new Promise<unknown[]>((resolve) => {
      releaseEnumeration = () => resolve([]);
    });
    let signalEmitted: (snapshot: SyncRoleSnapshot) => void = () => undefined;
    const emittedOnce = new Promise<SyncRoleSnapshot>((resolve) => {
      signalEmitted = resolve;
    });
    const service = createService(db, projectRoot, {
      sessionService: {
        list: sessionList,
        get: vi.fn(() => null),
        readTranscriptTail: vi.fn(async () => ""),
      } as any,
      agentChatService: { listSessions: vi.fn(() => enumeration) } as any,
      onStatusChanged: (snapshot) => signalEmitted(snapshot),
    });

    try {
      vi.useFakeTimers();
      let activationSettled = false;
      const activation = service.setHostStartupEnabled(true).then(() => {
        activationSettled = true;
      });
      // Flushes microtasks only: the status snapshot's chat enumeration is
      // still pending, so nothing below can have run.
      await vi.advanceTimersByTimeAsync(0);

      expect(activationSettled).toBe(true);
      expect(sessionList).not.toHaveBeenCalled();

      vi.useRealTimers();
      releaseEnumeration();
      await activation;
      const snapshot = await emittedOnce;

      // The snapshot is offered after the role, not instead of it: it is still
      // the real, complete one, readiness included.
      expect(snapshot.transferReadiness.ready).toBe(true);
      expect(sessionList).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await service.dispose();
      db.close();
    }
  });

  // ADE-BRAIN-1V/3H: a status snapshot was still enumerating sessions when the
  // runtime closed the project database under it. The read then threw
  // "database is not open" as an unhandled rejection and a false warning.
  it("drops a status snapshot that a dispose overtakes, quietly", async () => {
    const projectRoot = makeTempRoot("ade-sync-service-dispose-emit-");
    cleanupRoots.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
    (db.sync as { isAvailable?: () => boolean }).isAvailable = () => false;
    let releaseEnumeration: () => void = () => undefined;
    const enumeration = new Promise<unknown[]>((resolve) => {
      releaseEnumeration = () => resolve([]);
    });
    const logger = createLogger();
    const onStatusChanged = vi.fn();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const service = createService(db, projectRoot, {
      logger: logger as any,
      sessionService: {
        // A real read of the project database, like the session service's.
        list: vi.fn(() => db.all("select 1 as one")),
        get: vi.fn(() => null),
        readTranscriptTail: vi.fn(async () => ""),
      } as any,
      agentChatService: { listSessions: vi.fn(() => enumeration) } as any,
      onStatusChanged,
    });
    try {
      service.notifyRouteStateChanged();
      await service.dispose();
      db.close();
      releaseEnumeration();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).not.toHaveBeenCalled();
      expect(onStatusChanged).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalledWith("sync.status_emit_failed", expect.anything());
    } finally {
      process.off("unhandledRejection", unhandled);
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

  it("gives a lightweight status read the real readiness while the first computation is in flight", async () => {
    const projectRoot = makeTempRoot("ade-sync-service-readiness-inflight-");
    cleanupRoots.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
    (db.sync as { isAvailable?: () => boolean }).isAvailable = () => false;
    let releaseChats: () => void = () => undefined;
    const chatsEnumeration = new Promise<unknown[]>((resolve) => {
      releaseChats = () => resolve([]);
    });
    const listSessions = vi.fn(() => chatsEnumeration);
    const service = createService(db, projectRoot, {
      agentChatService: { listSessions } as any,
    });

    try {
      const full = service.getStatus();
      await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));

      let lightSettled = false;
      const light = service.getStatus({ includeTransferReadiness: false }).then((snapshot) => {
        lightSettled = true;
        return snapshot;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The skipped placeholder reads "not ready"; the light read must wait for the real answer instead.
      expect(lightSettled).toBe(false);

      releaseChats();
      const snapshot = await light;
      expect(snapshot.transferReadiness.ready).toBe(true);
      await full;
      // The light read joined the computation already running; it did not start a second one.
      expect(listSessions).toHaveBeenCalledTimes(1);
    } finally {
      await service.dispose();
      db.close();
    }
  });

  it("gives an awaiting lightweight status read the real readiness before any drain has started a computation", async () => {
    const projectRoot = makeTempRoot("ade-sync-service-readiness-cold-");
    cleanupRoots.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
    (db.sync as { isAvailable?: () => boolean }).isAvailable = () => false;
    const listSessions = vi.fn(async () => []);
    const service = createService(db, projectRoot, {
      agentChatService: { listSessions } as any,
    });

    try {
      // Nothing is in flight and nothing is cached: this is the brain's startup window. The read must
      // compute the answer rather than report the skipped placeholder as "not ready".
      const snapshot = await service.getStatus({ includeTransferReadiness: false, awaitTransferReadiness: true });
      expect(snapshot.transferReadiness.ready).toBe(true);
      expect(listSessions).toHaveBeenCalledTimes(1);

      // Once computed, later light reads take the cache and do not enumerate again.
      await service.getStatus({ includeTransferReadiness: false });
      expect(listSessions).toHaveBeenCalledTimes(1);
    } finally {
      await service.dispose();
      db.close();
    }
  });

  it("returns at once from a plain lightweight status read on a cold cache, without starting the computation", async () => {
    const projectRoot = makeTempRoot("ade-sync-service-readiness-plain-cold-");
    cleanupRoots.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
    (db.sync as { isAvailable?: () => boolean }).isAvailable = () => false;
    // The enumeration never finishes, so a read that waited for it would never return.
    const listSessions = vi.fn(() => new Promise<unknown[]>(() => undefined));
    const service = createService(db, projectRoot, {
      agentChatService: { listSessions } as any,
    });

    try {
      // The desktop top bar reads this way on every focus. It gets the placeholder now and never starts
      // the enumeration, so it cannot wait on it.
      const snapshot = await service.getStatus({ includeTransferReadiness: false });
      expect(snapshot.transferReadiness.ready).toBe(false);
      expect(snapshot.transferReadiness.blockers).toEqual([]);
      expect(listSessions).not.toHaveBeenCalled();
    } finally {
      await service.dispose();
      db.close();
    }
  });

  it("does not hold an awaiting lightweight status read indefinitely when the first computation never finishes", async () => {
    const projectRoot = makeTempRoot("ade-sync-service-readiness-bounded-");
    cleanupRoots.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
    (db.sync as { isAvailable?: () => boolean }).isAvailable = () => false;
    const listSessions = vi.fn(() => new Promise<unknown[]>(() => undefined));
    const service = createService(db, projectRoot, {
      agentChatService: { listSessions } as any,
    });

    try {
      const snapshot = await service.getStatus({ includeTransferReadiness: false, awaitTransferReadiness: true });
      expect(snapshot.transferReadiness.ready).toBe(false);
      expect(snapshot.transferReadiness.blockers).toEqual([]);
    } finally {
      await service.dispose();
      db.close();
    }
  });

  it("does not restart a failed readiness computation for an awaiting light read until the retry cooldown passes", async () => {
    const projectRoot = makeTempRoot("ade-sync-service-readiness-cooldown-");
    cleanupRoots.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
    (db.sync as { isAvailable?: () => boolean }).isAvailable = () => false;
    const listSessions = vi.fn(async () => {
      throw new Error("chat index unavailable");
    });
    const service = createService(db, projectRoot, {
      agentChatService: { listSessions } as any,
    });
    const clock = vi.spyOn(Date, "now");
    const start = Date.now();

    try {
      clock.mockReturnValue(start);
      const first = await service.getStatus({ includeTransferReadiness: false, awaitTransferReadiness: true });
      expect(first.transferReadiness.ready).toBe(false);
      expect(listSessions).toHaveBeenCalledTimes(1);

      // Inside the cooldown a polling read gets the placeholder without a second enumeration.
      clock.mockReturnValue(start + 1_000);
      const polled = await service.getStatus({ includeTransferReadiness: false, awaitTransferReadiness: true });
      expect(polled.transferReadiness.ready).toBe(false);
      expect(listSessions).toHaveBeenCalledTimes(1);

      // The full read is unchanged by the cooldown: it still computes, and it still reports the failure.
      clock.mockReturnValue(start + 1_500);
      await expect(service.getStatus({ includeTransferReadiness: true })).rejects.toThrow("chat index unavailable");
      expect(listSessions).toHaveBeenCalledTimes(2);

      // Once the cooldown has passed since the last failure, an awaiting light read tries again.
      clock.mockReturnValue(start + 1_500 + 6_000);
      await service.getStatus({ includeTransferReadiness: false, awaitTransferReadiness: true });
      expect(listSessions).toHaveBeenCalledTimes(3);
    } finally {
      clock.mockRestore();
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
