import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CrsqlChangeRow,
  SyncMobileProjectSummary,
  SyncPeerMetadata,
  SyncRemoteCommandDescriptor,
} from "../../../../desktop/src/shared/types";
import {
  buildSyncHostHelloOkPayload,
  createSyncHostService,
  resolveSyncHostInboundProjectScope,
  selectChangesetBatchChunk,
} from "./syncHostService";
import { buildChangesetBatchPayload } from "./changesetPump";

const publishMock = vi.hoisted(() => vi.fn());
const bonjourDestroyMock = vi.hoisted(() => vi.fn());
const bonjourConstructorMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("bonjour-service", () => ({
  Bonjour: bonjourConstructorMock,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

type BonjourPublishArgs = {
  name: string;
  type: string;
  protocol: string;
  port: number;
  txt: Record<string, string>;
  disableIPv6: boolean;
};

describe("resolveSyncHostInboundProjectScope", () => {
  it("keeps runtime-scoped envelopes projectless", () => {
    expect(resolveSyncHostInboundProjectScope("hello", "project-1", "project-1")).toEqual({
      ok: true,
      projectId: null,
      usedSingleProjectFallback: false,
    });
    expect(resolveSyncHostInboundProjectScope("project_catalog_request", null, "project-1")).toEqual({
      ok: true,
      projectId: null,
      usedSingleProjectFallback: false,
    });
  });

  it("resolves missing project id through the single-active-project fallback", () => {
    expect(resolveSyncHostInboundProjectScope("file_request", null, " project-1 ")).toEqual({
      ok: true,
      projectId: "project-1",
      usedSingleProjectFallback: true,
    });
    expect(resolveSyncHostInboundProjectScope("terminal_input", "  ", "project-1")).toEqual({
      ok: true,
      projectId: "project-1",
      usedSingleProjectFallback: true,
    });
  });

  it("accepts matching project-scoped envelopes", () => {
    expect(resolveSyncHostInboundProjectScope("changeset_batch", " project-1 ", "project-1")).toEqual({
      ok: true,
      projectId: "project-1",
      usedSingleProjectFallback: false,
    });
    expect(resolveSyncHostInboundProjectScope("chat_subscribe", "project-1", " project-1 ")).toEqual({
      ok: true,
      projectId: "project-1",
      usedSingleProjectFallback: false,
    });
  });

  it("rejects project-scoped envelopes for a different active project", () => {
    expect(resolveSyncHostInboundProjectScope("changeset_ack", "project-2", "project-1")).toMatchObject({
      ok: false,
      code: "project_mismatch",
      expectedProjectId: "project-1",
      receivedProjectId: "project-2",
    });
  });

  it("rejects project-scoped envelopes when no project is open", () => {
    expect(resolveSyncHostInboundProjectScope("terminal_subscribe", "project-1", null)).toMatchObject({
      ok: false,
      code: "project_not_open",
      expectedProjectId: null,
      receivedProjectId: "project-1",
    });
  });
});

describe("buildSyncHostHelloOkPayload", () => {
  it("advertises daemon-hosted project catalog support in hello_ok without desktop", () => {
    const peer = {
      deviceId: "ios-phone-1",
      deviceName: "Arul iPhone",
      platform: "iOS",
      deviceType: "phone",
      siteId: "ios-site-1",
      dbVersion: 0,
    } satisfies SyncPeerMetadata;
    const brain = {
      deviceId: "daemon-host-1",
      deviceName: "ADE daemon",
      platform: "linux",
      deviceType: "vps",
      siteId: "daemon-site-1",
      dbVersion: 7,
    } satisfies SyncPeerMetadata;
    const project = {
      id: "project-1",
      displayName: "ADE",
      rootPath: "/Users/admin/Projects/ADE",
      defaultBaseRef: "main",
      lastOpenedAt: "2026-04-22T12:00:00.000Z",
      laneCount: 3,
      isAvailable: true,
      isCached: true,
      isOpen: false,
    } satisfies SyncMobileProjectSummary;
    const remoteCommand = {
      action: "work.runQuickCommand",
      scope: "project",
      policy: { viewerAllowed: true },
    } satisfies SyncRemoteCommandDescriptor;
    const localPresenceCommand = {
      action: "lanes.presence.announce",
      scope: "project",
      policy: { viewerAllowed: true },
    } satisfies SyncRemoteCommandDescriptor;

    const payload = buildSyncHostHelloOkPayload({
      peer,
      brain,
      serverDbVersion: 7,
      heartbeatIntervalMs: 30_000,
      pollIntervalMs: 400,
      projectCatalog: { projects: [project] },
      projectCatalogEnabled: true,
      remoteCommandSupportedActions: [remoteCommand.action],
      remoteCommandDescriptors: [remoteCommand],
      localCommandDescriptors: [localPresenceCommand],
      compressionThresholdBytes: 100_000,
    });

    expect(payload.peer).toBe(peer);
    expect(payload.brain).toBe(brain);
    expect(payload.serverDbVersion).toBe(7);
    expect(payload.projects).toEqual([project]);
    expect(payload.features.projectCatalog).toEqual({ enabled: true });
    expect(payload.features.fileAccess).toBe(true);
    expect(payload.features.terminalStreaming).toBe(true);
    expect(payload.features.chatStreaming).toEqual({ enabled: true });
    expect(payload.features.commandRouting).toEqual({
      mode: "allowlisted",
      supportedActions: [remoteCommand.action, localPresenceCommand.action],
      actions: [remoteCommand, localPresenceCommand],
    });
  });
});

function makeChange(dbVersion: number, seq: number, value = `value-${seq}`): CrsqlChangeRow {
  return {
    table: "kv",
    pk: `key-${seq}`,
    cid: "value",
    val: value,
    col_version: dbVersion,
    db_version: dbVersion,
    site_id: "site-host",
    cl: 1,
    seq,
  };
}

describe("selectChangesetBatchChunk", () => {
  it("keeps a single db_version together when the row limit would split it", () => {
    const changes = [
      ...Array.from({ length: 400 }, (_, seq) => makeChange(7, seq)),
      makeChange(8, 400),
    ];

    const chunk = selectChangesetBatchChunk({
      changes,
      fromDbVersion: 0,
      toDbVersion: 8,
      maxRows: 250,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(chunk?.changes).toHaveLength(400);
    expect(chunk?.changes.every((change) => change.db_version === 7)).toBe(true);
    expect(chunk?.toDbVersion).toBe(7);
  });

  it("does not spread an unbounded same-db_version chunk to compute the watermark", () => {
    const changes = Array.from({ length: 70_000 }, (_, seq) => makeChange(9, seq));

    const chunk = selectChangesetBatchChunk({
      changes,
      fromDbVersion: 0,
      toDbVersion: 9,
      maxRows: 250,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(chunk?.changes).toHaveLength(70_000);
    expect(chunk?.toDbVersion).toBe(9);
  });

  it("keeps a single db_version together when the byte limit would split it", () => {
    const largeValue = "x".repeat(180_000);
    const changes = [
      makeChange(4, 0, largeValue),
      makeChange(4, 1, largeValue),
      makeChange(5, 2, "next-version"),
    ];

    const chunk = selectChangesetBatchChunk({
      changes,
      fromDbVersion: 0,
      toDbVersion: 5,
      maxRows: 250,
      maxBytes: 256 * 1024,
    });

    expect(chunk?.changes).toEqual(changes.slice(0, 2));
    expect(chunk?.toDbVersion).toBe(4);
  });

  it("includes one oversized row so sync can keep making progress", () => {
    const oversizedChange = makeChange(4, 0, "x".repeat(1024));
    const nextChange = makeChange(5, 1, "next-version");

    const chunk = selectChangesetBatchChunk({
      changes: [oversizedChange, nextChange],
      fromDbVersion: 0,
      toDbVersion: 5,
      maxRows: 250,
      maxBytes: 16,
    });

    expect(chunk?.changes).toEqual([oversizedChange]);
    expect(chunk?.toDbVersion).toBe(4);
  });

  it("can advance an empty changeset when all changes were filtered locally", () => {
    const chunk = selectChangesetBatchChunk({
      changes: [],
      fromDbVersion: 3,
      toDbVersion: 4,
      maxRows: 250,
      maxBytes: 256 * 1024,
    });

    expect(chunk).toEqual({ changes: [], toDbVersion: 4 });
  });
});

describe("buildChangesetBatchPayload", () => {
  it("does not build sendable payloads with empty changes", () => {
    const payload = buildChangesetBatchPayload({
      deviceId: "device-1",
      reason: "broadcast",
      fromDbVersion: 3,
      toDbVersion: 4,
      changes: [],
      maxRows: 250,
      maxBytes: 256 * 1024,
    });

    expect(payload).toBeNull();
  });
});

function createDiscoveryLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createTempProjectRoot(): { projectRoot: string; cleanup: () => void } {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sync-discovery-"));
  return {
    projectRoot,
    cleanup: () => fs.rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function createDiscoveryProject(overrides: Partial<SyncMobileProjectSummary>): SyncMobileProjectSummary {
  return {
    id: "project-1",
    displayName: "Project",
    rootPath: "/srv/project",
    defaultBaseRef: "main",
    lastOpenedAt: "2026-05-10T12:00:00.000Z",
    laneCount: 0,
    isAvailable: true,
    isCached: true,
    isOpen: false,
    ...overrides,
  };
}

function publishedAnnouncements(): BonjourPublishArgs[] {
  return publishMock.mock.calls.map(([payload]) => payload as BonjourPublishArgs);
}

type NativeDiscoveryProcess = {
  child: {
    kill: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn<[string, (...args: unknown[]) => void], NativeDiscoveryProcess["child"]>>;
    unref: ReturnType<typeof vi.fn>;
  };
  handlers: Map<string, (...args: unknown[]) => void>;
};

function createNativeDiscoveryProcess(): NativeDiscoveryProcess {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const child = {} as NativeDiscoveryProcess["child"];
  child.kill = vi.fn();
  child.once = vi.fn<[string, (...args: unknown[]) => void], NativeDiscoveryProcess["child"]>((event, handler) => {
    handlers.set(event, handler);
    return child;
  });
  child.unref = vi.fn();
  return { child, handlers };
}

function createHostArgs(projectRoot: string, projects: SyncMobileProjectSummary[]) {
  return {
    db: {
      sync: {
        getSiteId: () => "site-host-1",
        getDbVersion: () => 7,
        discardUnpublishedChangesForTables: () => {},
      },
    },
    logger: createDiscoveryLogger(),
    projectRoot,
    port: 0,
    discoveryEnabled: true,
    runtimeKind: "headless" as const,
    runtimeVersion: "2.0.0",
    heartbeatIntervalMs: 60_000,
    pollIntervalMs: 60_000,
    brainStatusIntervalMs: 60_000,
    pinStore: {
      getPin: () => null,
      hasPin: () => false,
      verifyPin: () => false,
      setPin: vi.fn(),
      clearPin: vi.fn(),
    },
    deviceRegistryService: {
      ensureLocalDevice: () => ({
        deviceId: "host-device-1",
        siteId: "host-site-1",
        name: "ADE Build Host",
        platform: "linux",
        deviceType: "vps",
        createdAt: "2026-05-10T12:00:00.000Z",
        updatedAt: "2026-05-10T12:00:00.000Z",
        lastSeenAt: "2026-05-10T12:00:00.000Z",
        lastHost: "build-host.local",
        lastPort: 8787,
        tailscaleIp: "100.64.0.10",
        ipAddresses: ["192.168.1.50"],
        metadata: { tailscaleDnsName: "ade-build.tailnet.ts.net." },
      }),
    },
    fileService: {},
    laneService: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      archive: vi.fn(),
    },
    prService: {
      listAll: vi.fn().mockResolvedValue([]),
      getDetail: vi.fn(),
      getStatus: vi.fn(),
      getChecks: vi.fn(),
      getReviews: vi.fn(),
      getComments: vi.fn(),
      getFiles: vi.fn(),
      createFromLane: vi.fn(),
      land: vi.fn(),
      closePr: vi.fn(),
      requestReviewers: vi.fn(),
    },
    sessionService: {
      list: () => [],
      get: () => null,
      readTranscriptTail: async () => "",
    },
    ptyService: {
      create: vi.fn(),
      readTranscriptTail: vi.fn(async () => ""),
      enrichSessions: (rows: unknown[]) => rows,
    },
    computerUseArtifactBrokerService: {
      listArtifacts: () => [],
    },
    projectCatalogProvider: {
      listProjects: vi.fn(async () => ({ projects })),
      prepareProjectConnection: vi.fn(),
    },
  };
}

describe("createSyncHostService LAN discovery", () => {
  let originalPlatform: PropertyDescriptor | undefined;
  let originalElectronVersion: PropertyDescriptor | undefined;

  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    originalElectronVersion = Object.getOwnPropertyDescriptor(process.versions, "electron");
    bonjourConstructorMock.mockImplementation(() => ({
      publish: publishMock,
      destroy: bonjourDestroyMock,
    }));
    spawnMock.mockImplementation(() => ({
      kill: vi.fn(),
      once: vi.fn(),
      unref: vi.fn(),
    }));
    publishMock.mockImplementation(() => ({
      on: vi.fn(),
      stop: vi.fn(),
    }));
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    if (originalElectronVersion) {
      Object.defineProperty(process.versions, "electron", originalElectronVersion);
    } else {
      Reflect.deleteProperty(process.versions, "electron");
    }
    vi.restoreAllMocks();
  });

  it("publishes headless runtime project metadata in Bonjour TXT records", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const projects = [
      createDiscoveryProject({ id: "project-1", displayName: "API, Server\nOne", rootPath: "/srv/api" }),
      createDiscoveryProject({ id: "project-2", displayName: "Worker", rootPath: "/srv/worker" }),
    ];
    const host = createSyncHostService(
      createHostArgs(projectRoot, projects) as unknown as Parameters<typeof createSyncHostService>[0],
    );

    try {
      const port = await host.waitUntilListening();
      await vi.waitFor(() => {
        expect(publishedAnnouncements().some((announcement) => announcement.txt.projectCount === "2")).toBe(true);
      });

      const announcement = publishedAnnouncements()
        .find((candidate) => candidate.txt.projectCount === "2");
      expect(announcement).toBeDefined();
      expect(announcement).toMatchObject({
        name: `ADE Sync ADE Build Host ${port}`,
        type: "ade-sync",
        protocol: "tcp",
        port,
        disableIPv6: true,
      });
      expect(announcement?.txt).toEqual({
        version: "1",
        runtimeKind: "headless",
        runtimeVersion: "2.0.0",
        projects: "project-1,project-2",
        projectNames: "API Server One,Worker",
        projectCount: "2",
        deviceId: "host-device-1",
        siteId: "host-site-1",
        deviceName: "ADE Build Host",
        port: String(port),
        host: "192.168.1.50",
        addresses: "192.168.1.50,100.64.0.10",
        tailscaleIp: "100.64.0.10",
        tailscaleDnsName: "ade-build.tailnet.ts.net",
      });
    } finally {
      await host.dispose();
      cleanup();
    }
  });

  it("forces a fresh LAN Bonjour announcement when discovery is explicitly refreshed", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const publishedServices: Array<{ on: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
    publishMock.mockImplementation(() => {
      const service = { on: vi.fn(), stop: vi.fn() };
      publishedServices.push(service);
      return service;
    });
    const host = createSyncHostService(
      createHostArgs(projectRoot, [createDiscoveryProject({ id: "project-1" })]) as unknown as Parameters<
        typeof createSyncHostService
      >[0],
    );

    try {
      await host.waitUntilListening();
      await vi.waitFor(() => {
        expect(publishedAnnouncements().some((announcement) => announcement.txt.projectCount === "1")).toBe(true);
      });

      const activeAnnouncement = publishedServices[publishedServices.length - 1];
      publishMock.mockClear();

      host.refreshLanDiscovery();
      expect(publishMock).not.toHaveBeenCalled();
      expect(activeAnnouncement.stop).not.toHaveBeenCalled();

      host.refreshLanDiscovery({ forceLan: true });

      expect(activeAnnouncement.stop).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(publishMock).toHaveBeenCalledTimes(1);
      });
      expect(publishedAnnouncements()[0]?.txt.projectCount).toBe("1");
    } finally {
      await host.dispose();
      cleanup();
    }
  });

  it("publishes LAN discovery through native dns-sd when running under Electron on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    Object.defineProperty(process.versions, "electron", {
      value: "35.0.0",
      configurable: true,
    });
    const { projectRoot, cleanup } = createTempProjectRoot();
    const nativeProcesses: Array<{ kill: ReturnType<typeof vi.fn>; once: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }> = [];
    spawnMock.mockImplementation(() => {
      const child = { kill: vi.fn(), once: vi.fn(), unref: vi.fn() };
      nativeProcesses.push(child);
      return child;
    });
    const host = createSyncHostService(
      createHostArgs(projectRoot, [createDiscoveryProject({ id: "project-1" })]) as unknown as Parameters<
        typeof createSyncHostService
      >[0],
    );

    try {
      await host.waitUntilListening();
      await vi.waitFor(() => {
        expect(spawnMock.mock.calls.some(([, args]) => Array.isArray(args) && args.includes("projectCount=1"))).toBe(true);
      });

      expect(bonjourConstructorMock).not.toHaveBeenCalled();
      expect(publishMock).not.toHaveBeenCalled();
      const [, args] = spawnMock.mock.calls.find(([, candidateArgs]) =>
        Array.isArray(candidateArgs) && candidateArgs.includes("projectCount=1")
      )!;
      const publishedPort = String(args[4]);
      expect(args).toEqual(expect.arrayContaining([
        "-R",
        `ADE Sync ADE Build Host ${publishedPort}`,
        "_ade-sync._tcp",
        "local",
        publishedPort,
        "projects=project-1",
        "projectNames=Project",
        "addresses=192.168.1.50,100.64.0.10",
      ]));
      expect(nativeProcesses.at(-1)?.unref).toHaveBeenCalledTimes(1);
    } finally {
      await host.dispose();
      cleanup();
    }
    expect(nativeProcesses.at(-1)?.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("falls back to Bonjour when the native dns-sd publisher exits", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    Object.defineProperty(process.versions, "electron", {
      value: "35.0.0",
      configurable: true,
    });
    const { projectRoot, cleanup } = createTempProjectRoot();
    const nativeProcesses: ReturnType<typeof createNativeDiscoveryProcess>[] = [];
    spawnMock.mockImplementation(() => {
      const nativeProcess = createNativeDiscoveryProcess();
      nativeProcesses.push(nativeProcess);
      return nativeProcess.child;
    });
    const host = createSyncHostService(
      createHostArgs(projectRoot, [createDiscoveryProject({ id: "project-1" })]) as unknown as Parameters<
        typeof createSyncHostService
      >[0],
    );

    try {
      await host.waitUntilListening();
      await vi.waitFor(() => {
        expect(spawnMock.mock.calls.some(([, args]) => Array.isArray(args) && args.includes("projectCount=1"))).toBe(true);
      });

      const nativeSpawnCount = spawnMock.mock.calls.length;
      publishMock.mockClear();
      nativeProcesses.at(-1)?.handlers.get("exit")?.(1, null);

      await vi.waitFor(() => {
        expect(publishMock).toHaveBeenCalledTimes(1);
      }, { timeout: 2_000 });
      expect(spawnMock).toHaveBeenCalledTimes(nativeSpawnCount);
      expect(publishedAnnouncements()[0]?.txt.projectCount).toBe("1");
    } finally {
      await host.dispose();
      cleanup();
    }
  });
});
