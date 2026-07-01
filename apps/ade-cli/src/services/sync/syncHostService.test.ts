import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentChatEventEnvelope,
  CrsqlChangeRow,
  SyncMobileProjectSummary,
  SyncPeerMetadata,
  SyncRemoteCommandDescriptor,
} from "../../../../desktop/src/shared/types";
import {
  CHAT_EVENT_REPLAY_MAX_BYTES,
  CHAT_EVENT_REPLAY_MAX_EVENTS,
  SYNC_HOST_CHAT_ACTIVE_BACKGROUND_BACKPRESSURE_BYTES,
  buildSyncHostHelloOkPayload,
  createChatEventReplayBuffer,
  createSyncHostService,
  planChatEventResume,
  recordChatEventInReplayBuffer,
  resolveSyncHostInboundProjectScope,
  selectChangesetBatchChunk,
} from "./syncHostService";
import { createBrainProjectActionsSyncHandler } from "./brainProjectActionsSyncHandler";
import { buildChangesetBatchPayload } from "./changesetPump";
import { createSharedSyncListener } from "./sharedSyncListener";
import { createSyncPinStore } from "./syncPinStore";
import { encodeSyncEnvelope, parseSyncEnvelope, wsDataToText, type ParsedSyncEnvelope } from "./syncProtocol";
import { EncryptedFileCredentialStore } from "../credentials/credentialStore";

// The sync host now binds to all interfaces (0.0.0.0) by default so phones on
// the LAN can reach it. These tests assert the LOOPBACK-only posture (no LAN
// Bonjour advertisement), which is now an opt-in mode selected via
// ADE_SYNC_BIND_HOST=127.0.0.1. SYNC_HOST_BIND_HOST is captured at module-load,
// so this must be set (via vi.hoisted) before syncHostService.ts is imported.
const ORIGINAL_ADE_SYNC_BIND_HOST = vi.hoisted(() => process.env.ADE_SYNC_BIND_HOST);
vi.hoisted(() => {
  process.env.ADE_SYNC_BIND_HOST = "127.0.0.1";
});

afterAll(() => {
  if (ORIGINAL_ADE_SYNC_BIND_HOST === undefined) {
    delete process.env.ADE_SYNC_BIND_HOST;
  } else {
    process.env.ADE_SYNC_BIND_HOST = ORIGINAL_ADE_SYNC_BIND_HOST;
  }
});

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
    expect(resolveSyncHostInboundProjectScope("terminal_history", null, "project-1")).toEqual({
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

  it("accepts project-scoped envelopes that use the hosted DB project id alias", () => {
    expect(resolveSyncHostInboundProjectScope(
      "changeset_ack",
      "24b96ceb-7ff6-4852-af99-2c36ffa6e9bf",
      "project_80c9b7785de5e4060adf68c2",
      ["24b96ceb-7ff6-4852-af99-2c36ffa6e9bf"],
    )).toEqual({
      ok: true,
      projectId: "project_80c9b7785de5e4060adf68c2",
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
      projectActionsEnabled: false,
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
    expect(payload.features.projectActions).toEqual({ enabled: false });
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

describe("brain project actions fallback handler", () => {
  it("does not send a second switch result if post-response project completion fails", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    const credentialStore = new EncryptedFileCredentialStore({
      secretsDir,
      keyMaterialProvider: () => null,
    });
    credentialStore.setSync("test.bootstrap", "bootstrap-token");

    const project = createDiscoveryProject({
      id: "project-1",
      rootPath: projectRoot,
      isOpen: true,
    });
    const logger = createDiscoveryLogger();
    const handler = createBrainProjectActionsSyncHandler({
      logger,
      projectCatalogProvider: {
        listProjects: vi.fn(async () => ({ projects: [project] })),
        prepareProjectConnection: vi.fn(async () => ({
          ok: true,
          project,
          connection: null,
        })),
        completeProjectConnection: vi.fn(async () => {
          throw new Error("activation failed");
        }),
      },
      bootstrapCredentialStore: credentialStore,
      bootstrapTokenKey: "test.bootstrap",
      pairingSecretsPath: path.join(secretsDir, "sync-paired-devices.json"),
      pinPath: path.join(secretsDir, "sync-pin.json"),
      localDeviceIdPath: path.join(secretsDir, "sync-device-id"),
      localSiteIdPath: path.join(secretsDir, "sync-site-id"),
    });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (ws, request) => {
      handler({
        ws,
        remoteAddress: request.socket.remoteAddress ?? null,
        remotePort: request.socket.remotePort ?? null,
      });
    });

    let client: WebSocket | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", () => resolve());
        server.once("error", reject);
      });
      const address = server.address();
      expect(typeof address).toBe("object");
      const port = typeof address === "object" && address ? address.port : 0;
      expect(port).toBeGreaterThan(0);

      client = new WebSocket(`ws://127.0.0.1:${port}`);
      const { envelopes } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", () => resolve());
        client!.once("error", reject);
      });
      sendHello(client, "bootstrap-token");
      await waitForValue(
        () => envelopes.find((envelope) => envelope.type === "hello_ok"),
        "fallback hello_ok",
      );

      client.send(encodeSyncEnvelope({
        type: "project_switch_request",
        requestId: "switch-1",
        payload: { projectId: "project-1" },
      }));
      const result = await waitForEnvelope(envelopes, "project_switch_result", "switch-1");
      expect(result.payload).toMatchObject({ ok: true });

      await new Promise((resolve) => setTimeout(resolve, 100));
      const switchResults = envelopes.filter(
        (envelope) => envelope.type === "project_switch_result" && envelope.requestId === "switch-1",
      );
      expect(switchResults).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "sync_brain.project_switch_failed",
        expect.objectContaining({ message: "activation failed" }),
      );
    } finally {
      try {
        client?.close();
      } catch {
        // ignore
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanup();
    }
  });

  it("rate-limits failed PIN pairing attempts before a project host owns the listener", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    const pinPath = path.join(secretsDir, "sync-pin.json");
    createSyncPinStore({ filePath: pinPath }).setPin("428193");

    const logger = createDiscoveryLogger();
    const bootstrapTokenPath = path.join(secretsDir, "sync-bootstrap-token");
    const handler = createBrainProjectActionsSyncHandler({
      logger,
      projectCatalogProvider: {
        listProjects: vi.fn(async () => ({ projects: [] })),
        prepareProjectConnection: vi.fn(async () => ({
          ok: false,
          message: "No hosted project is ready.",
        })),
      },
      bootstrapCredentialStore: new EncryptedFileCredentialStore({
        secretsDir,
        keyMaterialProvider: () => null,
      }),
      pairingSecretsPath: path.join(secretsDir, "sync-paired-devices.json"),
      pinPath,
      localDeviceIdPath: path.join(secretsDir, "sync-device-id"),
      localSiteIdPath: path.join(secretsDir, "sync-site-id"),
    });
    expect(fs.existsSync(bootstrapTokenPath)).toBe(false);
    expect(fs.existsSync(path.join(secretsDir, "credentials.json.enc"))).toBe(true);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (ws, request) => {
      handler({
        ws,
        remoteAddress: request.socket.remoteAddress ?? null,
        remotePort: request.socket.remotePort ?? null,
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", () => resolve());
        server.once("error", reject);
      });
      const address = server.address();
      expect(typeof address).toBe("object");
      const port = typeof address === "object" && address ? address.port : 0;
      expect(port).toBeGreaterThan(0);

      const sendPairingRequest = async (requestId: string, code: string, deviceId: string) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const envelopes: ParsedSyncEnvelope[] = [];
        ws.on("message", (raw) => {
          envelopes.push(parseSyncEnvelope(wsDataToText(raw)));
        });
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", reject);
        });
        const closed = new Promise<{ code: number; reason: string }>((resolve) => {
          ws.once("close", (closeCode, reason) => {
            resolve({ code: closeCode, reason: reason.toString("utf8") });
          });
        });
        ws.send(encodeSyncEnvelope({
          type: "pairing_request",
          requestId,
          payload: {
            code,
            peer: {
              deviceId,
              deviceName: "Fallback iPhone",
              platform: "iOS",
              deviceType: "phone",
              siteId: `${deviceId}-site`,
              dbVersion: 0,
            },
          },
        }));
        const response = await waitForValue(
          () => envelopes.find((envelope) => envelope.type === "pairing_result"),
          `pairing_result ${requestId}`,
        );
        return {
          payload: response.payload as {
            ok: boolean;
            error?: { code?: string; message?: string };
          },
          closed: await closed,
        };
      };

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const failed = await sendPairingRequest(`bad-pin-${attempt}`, "000000", `ios-bad-${attempt}`);
        expect(failed.payload.ok).toBe(false);
        expect(failed.payload.error?.code).toBe("invalid_pin");
        expect(failed.closed.code).toBe(4003);
      }

      const limited = await sendPairingRequest("bad-pin-cooldown", "000000", "ios-rate-limited");
      expect(limited.payload.ok).toBe(false);
      expect(limited.payload.error?.code).toBe("pairing_failed");
      expect(limited.payload.error?.message).toMatch(/Too many failed PIN attempts/i);
      expect(limited.closed.code).toBe(4004);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanup();
    }
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
      hasLivePty: () => true,
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

  it("closes inbound sockets that never authenticate", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const host = createSyncHostService({
      ...createHostArgs(projectRoot, [createDiscoveryProject({ id: "project-1" })]),
      authTimeoutMs: 1_000,
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let client: WebSocket | null = null;

    try {
      const port = await host.waitUntilListening();
      client = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", () => resolve());
        client!.once("error", reject);
      });

      const closeEvent = await Promise.race([
        new Promise<{ code: number; reason: string }>((resolve) => {
          client!.once("close", (code, reason) => {
            resolve({ code, reason: reason.toString("utf8") });
          });
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Timed out waiting for unauthenticated socket close.")), 3_000);
        }),
      ]);
      expect(closeEvent).toEqual({
        code: 4003,
        reason: "Authentication timed out",
      });
    } finally {
      try {
        client?.close();
      } catch {
        // ignore close failures
      }
      await host.dispose();
      cleanup();
    }
  });

  it("does not publish LAN Bonjour metadata when the sync host is loopback-bound", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const projects = [
      createDiscoveryProject({ id: "project-1", displayName: "API, Server\nOne", rootPath: "/srv/api" }),
      createDiscoveryProject({ id: "project-2", displayName: "Worker", rootPath: "/srv/worker" }),
    ];
    const host = createSyncHostService(
      createHostArgs(projectRoot, projects) as unknown as Parameters<typeof createSyncHostService>[0],
    );

    try {
      await host.waitUntilListening();
      host.refreshLanDiscovery({ forceLan: true });
      expect(publishedAnnouncements()).toEqual([]);
      expect(bonjourConstructorMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await host.dispose();
      cleanup();
    }
  });

  it("keeps LAN discovery unpublished when discovery is explicitly refreshed", async () => {
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
      publishMock.mockClear();

      host.refreshLanDiscovery();
      expect(publishMock).not.toHaveBeenCalled();

      host.refreshLanDiscovery({ forceLan: true });

      expect(publishMock).not.toHaveBeenCalled();
      expect(publishedServices).toEqual([]);
    } finally {
      await host.dispose();
      cleanup();
    }
  });

  it("does not publish native LAN discovery when running under Electron on macOS", async () => {
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

      expect(bonjourConstructorMock).not.toHaveBeenCalled();
      expect(publishMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      expect(nativeProcesses).toEqual([]);
    } finally {
      await host.dispose();
      cleanup();
    }
  });
});

async function waitForValue<T>(get: () => T | null | undefined, label: string, timeoutMs = 4_000): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = get();
    if (value != null) return value;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type HandoffDbOptions = {
  siteId: string;
  dbVersion: number;
  changes: CrsqlChangeRow[];
};

function createHandoffHostArgs(
  projectRoot: string,
  bootstrapTokenPath: string,
  db: HandoffDbOptions,
) {
  const base = createHostArgs(projectRoot, []);
  return {
    ...base,
    db: {
      sync: {
        getSiteId: () => db.siteId,
        getDbVersion: () => db.dbVersion,
        exportChangesSince: (fromDbVersion: number) =>
          db.changes.filter((change) => Number(change.db_version) > fromDbVersion),
        applyChanges: () => ({ appliedCount: 0 }),
        discardUnpublishedChangesForTables: () => {},
      },
    },
    deviceRegistryService: {
      ...base.deviceRegistryService,
      upsertPeerMetadata: vi.fn(),
    },
    bootstrapTokenPath,
  };
}

function trackClientEnvelopes(client: WebSocket): {
  envelopes: ParsedSyncEnvelope[];
  closeEvents: Array<{ code: number; reason: string }>;
} {
  const envelopes: ParsedSyncEnvelope[] = [];
  const closeEvents: Array<{ code: number; reason: string }> = [];
  client.on("message", (data) => {
    envelopes.push(parseSyncEnvelope(wsDataToText(data)));
  });
  client.on("close", (code, reason) => {
    closeEvents.push({ code, reason: reason.toString("utf8") });
  });
  return { envelopes, closeEvents };
}

function sendHello(client: WebSocket, token: string): void {
  client.send(encodeSyncEnvelope({
    type: "hello",
    payload: {
      peer: {
        deviceId: "ios-device-1",
        deviceName: "Test iPhone",
        platform: "iOS",
        deviceType: "phone",
        siteId: "ios-site-1",
        dbVersion: 0,
      },
      auth: { kind: "bootstrap", token },
    },
  }));
}

function waitForEnvelope(envelopes: ParsedSyncEnvelope[], type: string, requestId: string) {
  return waitForValue(
    () => envelopes.find((envelope) => envelope.type === type && envelope.requestId === requestId),
    `${type} response ${requestId}`,
  );
}

async function connectPeer(
  port: number,
  token: string,
  deviceId: string,
  peerOverrides: Partial<SyncPeerMetadata> = {},
) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const tracked = trackClientEnvelopes(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(encodeSyncEnvelope({
    type: "hello",
    payload: {
      peer: {
        deviceId,
        deviceName: deviceId,
        platform: "iOS",
        deviceType: "phone",
        siteId: `${deviceId}-site`,
        dbVersion: 0,
        ...peerOverrides,
      },
      auth: { kind: "bootstrap", token },
    },
  }));
  await waitForValue(
    () => tracked.envelopes.find((envelope) => envelope.type === "hello_ok"),
    `hello_ok for ${deviceId}`,
  );
  return { ws, ...tracked };
}

describe("outbound changeset ack retries", () => {
  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    spawnMock.mockImplementation(() => ({ kill: vi.fn(), once: vi.fn(), unref: vi.fn() }));
  });

  function createAckRetryHost(projectRoot: string) {
    const base = createHostArgs(projectRoot, []);
    const changes = [makeChange(1, 0)];
    return createSyncHostService({
      ...base,
      pollIntervalMs: 25,
      projectId: "project-1",
      db: {
        sync: {
          getSiteId: () => "site-host-ack",
          getDbVersion: () => 1,
          exportChangesSince: (fromDbVersion: number) =>
            changes.filter((change) => Number(change.db_version) > fromDbVersion),
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
  }

  it("processes pending ACK retries before active-chat background deferral", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const host = createAckRetryHost(projectRoot);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let bufferedAmountSpy: { mockRestore(): void } | null = null;
    let dateNowSpy: { mockRestore(): void } | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-ack-retry", {
        capabilities: ["changesetAck"],
      });

      const firstBatch = await waitForValue(
        () => peer?.envelopes.find((envelope) => envelope.type === "changeset_batch"),
        "initial changeset batch",
      );
      const firstPayload = firstBatch.payload as { batchId: string; toDbVersion: number };

      peer.ws.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "chat-subscribe",
        payload: { sessionId: "session-1" },
      }));
      await waitForEnvelope(peer.envelopes, "chat_subscribe", "chat-subscribe");

      bufferedAmountSpy = vi
        .spyOn(WebSocket.prototype, "bufferedAmount", "get")
        .mockReturnValue(SYNC_HOST_CHAT_ACTIVE_BACKGROUND_BACKPRESSURE_BYTES);
      const realDateNow = Date.now.bind(Date);
      dateNowSpy = vi
        .spyOn(Date, "now")
        .mockImplementation(() => realDateNow() + 11_000);

      const resentBatch = await waitForValue(
        () => peer?.envelopes.filter((envelope) =>
          envelope.type === "changeset_batch"
          && (envelope.payload as { batchId?: string }).batchId === firstPayload.batchId
        )[1],
        "resent changeset batch under chat backpressure",
      );
      expect(resentBatch.payload).toMatchObject({
        batchId: firstPayload.batchId,
        toDbVersion: firstPayload.toDbVersion,
      });
    } finally {
      dateNowSpy?.mockRestore();
      bufferedAmountSpy?.mockRestore();
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });
});

describe("mobile command result ledger", () => {
  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    spawnMock.mockImplementation(() => ({ kill: vi.fn(), once: vi.fn(), unref: vi.fn() }));
  });

  it("persists chat.send results so restart replays do not duplicate messages", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const sendMessage = vi.fn(async () => {});
    let firstHost: ReturnType<typeof createSyncHostService> | null = null;
    let secondHost: ReturnType<typeof createSyncHostService> | null = null;
    let firstClient: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let secondClient: Awaited<ReturnType<typeof connectPeer>> | null = null;
    const commandId = "cmd-chat-send-1";

    const makeHost = () => {
      const base = createHostArgs(projectRoot, []);
      return createSyncHostService({
        ...base,
        projectId: "project-1",
        deviceRegistryService: {
          ...base.deviceRegistryService,
          upsertPeerMetadata: vi.fn(),
        },
        agentChatService: {
          sendMessage,
          subscribeToEvents: vi.fn(() => vi.fn()),
        },
      } as unknown as Parameters<typeof createSyncHostService>[0]);
    };
    const sendChatCommand = (client: Awaited<ReturnType<typeof connectPeer>>, requestId: string): void => {
      client.ws.send(encodeSyncEnvelope({
        type: "command",
        requestId,
        projectId: "project-1",
        payload: {
          commandId,
          action: "chat.send",
          projectId: "project-1",
          args: {
            sessionId: "session-1",
            text: "hello from iOS",
          },
        },
      }));
    };

    try {
      firstHost = makeHost();
      const firstPort = await firstHost.waitUntilListening();
      const token = firstHost.getBootstrapToken();
      firstClient = await connectPeer(firstPort, token, "ios-chat-1");
      sendChatCommand(firstClient, "send-1");
      await waitForEnvelope(firstClient.envelopes, "command_ack", "send-1");
      const firstResult = await waitForEnvelope(firstClient.envelopes, "command_result", "send-1");
      expect(firstResult.payload).toMatchObject({
        commandId,
        ok: true,
        result: { ok: true },
      });
      expect(sendMessage).toHaveBeenCalledTimes(1);

      firstClient.ws.close();
      await firstHost.dispose();
      firstHost = null;

      secondHost = makeHost();
      const secondPort = await secondHost.waitUntilListening();
      secondClient = await connectPeer(secondPort, token, "ios-chat-1");
      sendChatCommand(secondClient, "send-2");
      await waitForEnvelope(secondClient.envelopes, "command_ack", "send-2");
      const replayResult = await waitForEnvelope(secondClient.envelopes, "command_result", "send-2");
      expect(replayResult.payload).toMatchObject({
        commandId,
        ok: true,
        result: { ok: true },
      });
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      try {
        firstClient?.ws.close();
        secondClient?.ws.close();
      } catch {
        // ignore
      }
      await firstHost?.dispose();
      await secondHost?.dispose();
      cleanup();
    }
  });
});

describe("inbound changeset_batch guards", () => {
  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    spawnMock.mockImplementation(() => ({ kill: vi.fn(), once: vi.fn(), unref: vi.fn() }));
  });

  function makePeerChange(table: string, dbVersion: number, seq: number, val = `value-${seq}`): CrsqlChangeRow {
    return {
      table,
      pk: `${table}-pk-${seq}`,
      cid: "value",
      val,
      col_version: dbVersion,
      db_version: dbVersion,
      site_id: "peer-site-1",
      cl: 1,
      seq,
    };
  }

  function createGuardHost(projectRoot: string, applyChanges: ReturnType<typeof vi.fn>) {
    const base = createHostArgs(projectRoot, []);
    return createSyncHostService({
      ...base,
      projectId: "project-1",
      db: {
        sync: {
          getSiteId: () => "site-host-guard",
          getDbVersion: () => 0,
          exportChangesSince: () => [],
          applyChanges,
          discardUnpublishedChangesForTables: () => {},
        },
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
  }

  it("rejects an oversized inbound batch with changeset_too_large and does not apply it (M6)", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const applyChanges = vi.fn(() => ({ appliedCount: 0 }));
    const host = createGuardHost(projectRoot, applyChanges);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-oversized");

      // 10_001 rows is one past MAX_INBOUND_CHANGESET_ROWS (250 * 40).
      const tooMany = Array.from({ length: 10_001 }, (_, seq) => makePeerChange("kv", 1, seq));
      const requestId = "batch-too-large";
      peer.ws.send(encodeSyncEnvelope({
        type: "changeset_batch",
        requestId,
        payload: { batchId: requestId, fromDbVersion: 0, toDbVersion: 1, changes: tooMany },
      }));

      const ack = await waitForEnvelope(peer.envelopes, "changeset_ack", requestId);
      const ackPayload = ack.payload as { ok?: boolean; appliedCount?: number; error?: { code?: string } };
      expect(ackPayload.ok).toBe(false);
      expect(ackPayload.error?.code).toBe("changeset_too_large");
      expect(ackPayload.appliedCount).toBe(0);
      expect(applyChanges).not.toHaveBeenCalled();
    } finally {
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("applies an at/under-cap inbound batch (M6)", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const applyChanges = vi.fn((changes: CrsqlChangeRow[]) => ({ appliedCount: changes.length }));
    const host = createGuardHost(projectRoot, applyChanges);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-undercap");

      const okBatch = Array.from({ length: 5 }, (_, seq) => makePeerChange("kv", 1, seq));
      const requestId = "batch-under-cap";
      peer.ws.send(encodeSyncEnvelope({
        type: "changeset_batch",
        requestId,
        payload: { batchId: requestId, fromDbVersion: 0, toDbVersion: 1, changes: okBatch },
      }));

      const ack = await waitForEnvelope(peer.envelopes, "changeset_ack", requestId);
      const ackPayload = ack.payload as { ok?: boolean; appliedCount?: number };
      expect(ackPayload.ok).toBe(true);
      expect(ackPayload.appliedCount).toBe(5);
      expect(applyChanges).toHaveBeenCalledTimes(1);
      expect(applyChanges.mock.calls[0]?.[0]).toHaveLength(5);
    } finally {
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("strips a peer's sync_cluster_state row so brain ownership cannot be seized (M7)", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const applyChanges = vi.fn((changes: CrsqlChangeRow[]) => ({ appliedCount: changes.length }));
    const host = createGuardHost(projectRoot, applyChanges);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-seizer");

      // The peer tries to author a winning sync_cluster_state row that would
      // flip brain_device_id to itself, alongside a benign kv row.
      const brainSeizure = makePeerChange("sync_cluster_state", 1, 0, "ios-seizer-device");
      brainSeizure.cid = "brain_device_id";
      brainSeizure.pk = "default-cluster";
      const benign = makePeerChange("kv", 2, 1);
      const requestId = "batch-seizure";
      peer.ws.send(encodeSyncEnvelope({
        type: "changeset_batch",
        requestId,
        payload: { batchId: requestId, fromDbVersion: 0, toDbVersion: 2, changes: [brainSeizure, benign] },
      }));

      const ack = await waitForEnvelope(peer.envelopes, "changeset_ack", requestId);
      const ackPayload = ack.payload as { ok?: boolean; appliedCount?: number };
      expect(ackPayload.ok).toBe(true);
      // Only the benign kv row reaches applyChanges; the brain row is filtered out.
      expect(applyChanges).toHaveBeenCalledTimes(1);
      const appliedRows = applyChanges.mock.calls[0]?.[0] as CrsqlChangeRow[];
      expect(appliedRows).toHaveLength(1);
      expect(appliedRows.every((row) => row.table !== "sync_cluster_state")).toBe(true);
      expect(ackPayload.appliedCount).toBe(1);
    } finally {
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });
});

describe("sync host handoff over a shared listener", () => {
  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    spawnMock.mockImplementation(() => ({ kill: vi.fn(), once: vi.fn(), unref: vi.fn() }));
  });

  function makeHostChange(dbVersion: number, seq: number): CrsqlChangeRow {
    return {
      table: "kv",
      pk: `key-${seq}`,
      cid: "value",
      val: `value-${seq}`,
      col_version: dbVersion,
      db_version: dbVersion,
      site_id: "site-host-origin",
      cl: 1,
      seq,
    };
  }

  it("keeps an authenticated peer connected across a host service swap and streams the new host's changesets", async () => {
    const rootA = createTempProjectRoot();
    const rootB = createTempProjectRoot();
    const tokenPath = path.join(rootA.projectRoot, "shared-bootstrap-token");
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    let client: WebSocket | null = null;
    let hostB: ReturnType<typeof createSyncHostService> | null = null;
    try {
      const port = await listener.ensureListening([0]);
      const hostA = createSyncHostService({
        ...createHandoffHostArgs(rootA.projectRoot, tokenPath, {
          siteId: "site-a",
          dbVersion: 0,
          changes: [],
        }),
        sharedListener: listener,
      } as unknown as Parameters<typeof createSyncHostService>[0]);
      expect(await hostA.waitUntilListening()).toBe(port);

      client = new WebSocket(`ws://127.0.0.1:${port}`);
      const { envelopes, closeEvents } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", () => resolve());
        client!.once("error", reject);
      });
      sendHello(client, hostA.getBootstrapToken());
      await waitForValue(
        () => envelopes.find((envelope) => envelope.type === "hello_ok"),
        "hello_ok from host A",
      );
      expect(hostA.getPeerStates()).toHaveLength(1);

      // Project switch: host A dies, host B (a different project DB) takes
      // over the shared listener and must adopt the live socket.
      await hostA.dispose();
      const envelopeCountAfterDispose = envelopes.length;
      hostB = createSyncHostService({
        ...createHandoffHostArgs(rootB.projectRoot, tokenPath, {
          siteId: "site-b",
          dbVersion: 2,
          changes: [makeHostChange(1, 0), makeHostChange(2, 1)],
        }),
        sharedListener: listener,
      } as unknown as Parameters<typeof createSyncHostService>[0]);
      expect(await hostB.waitUntilListening()).toBe(port);

      const changesetBatch = await waitForValue(
        () => envelopes.slice(envelopeCountAfterDispose).find((envelope) => envelope.type === "changeset_batch"),
        "changeset_batch from host B",
      );
      const payload = changesetBatch.payload as { changes?: CrsqlChangeRow[] };
      expect(payload.changes).toHaveLength(2);
      expect(payload.changes?.every((change) => change.site_id === "site-host-origin")).toBe(true);
      // The adopting host re-announces context so the phone notices the
      // hosted project changed without re-helloing.
      expect(envelopes.slice(envelopeCountAfterDispose).some((envelope) => envelope.type === "brain_status")).toBe(true);
      expect(envelopes.slice(envelopeCountAfterDispose).some((envelope) => envelope.type === "project_catalog")).toBe(true);
      // The whole point: the socket never closed during the swap.
      expect(closeEvents).toEqual([]);
      expect(client.readyState).toBe(WebSocket.OPEN);
      const adoptedPeer = hostB.getPeerStates();
      expect(adoptedPeer).toHaveLength(1);
      expect(adoptedPeer[0]?.deviceId).toBe("ios-device-1");
    } finally {
      try {
        client?.close();
      } catch {
        // ignore
      }
      await hostB?.dispose();
      await listener.close();
      rootA.cleanup();
      rootB.cleanup();
    }
  });

  it("parks a connection that arrives while no host owns the listener and replays its hello to the next host", async () => {
    const root = createTempProjectRoot();
    const tokenPath = path.join(root.projectRoot, "shared-bootstrap-token");
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    let client: WebSocket | null = null;
    let host: ReturnType<typeof createSyncHostService> | null = null;
    try {
      const port = await listener.ensureListening([0]);
      // No host service attached yet: the socket is parked and its frames buffered.
      client = new WebSocket(`ws://127.0.0.1:${port}`);
      const { envelopes, closeEvents } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", () => resolve());
        client!.once("error", reject);
      });
      const hostArgs = createHandoffHostArgs(root.projectRoot, tokenPath, {
        siteId: "site-a",
        dbVersion: 0,
        changes: [],
      });
      // The bootstrap token file is created by the host; pre-create it via a
      // throwaway self-owned host so the parked hello can carry a valid token.
      const tokenSeedHost = createSyncHostService({
        ...hostArgs,
        port: 0,
      } as unknown as Parameters<typeof createSyncHostService>[0]);
      const token = tokenSeedHost.getBootstrapToken();
      await tokenSeedHost.dispose();
      sendHello(client, token);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(envelopes).toEqual([]);

      host = createSyncHostService({
        ...hostArgs,
        sharedListener: listener,
      } as unknown as Parameters<typeof createSyncHostService>[0]);
      await host.waitUntilListening();
      await waitForValue(
        () => envelopes.find((envelope) => envelope.type === "hello_ok"),
        "hello_ok replayed after adoption",
      );
      expect(closeEvents).toEqual([]);
    } finally {
      try {
        client?.close();
      } catch {
        // ignore
      }
      await host?.dispose();
      await listener.close();
      root.cleanup();
    }
  });

  it("parks new connections during handler handoff instead of dispatching them to the fallback handler", async () => {
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1", parkedPeerGraceMs: 500 });
    const fallbackHandler = vi.fn((connection: { ws: WebSocket }) => {
      connection.ws.close(4010, "Fallback claimed socket");
    });
    const primaryHandler = vi.fn((connection: { ws: WebSocket }) => {
      connection.ws.close(4011, "Primary claimed socket");
    });
    let client: WebSocket | null = null;

    try {
      const port = await listener.ensureListening([0]);
      const detachPrimary = listener.setConnectionHandler(primaryHandler);
      listener.setFallbackConnectionHandler(fallbackHandler);
      detachPrimary();

      client = new WebSocket(`ws://127.0.0.1:${port}`);
      const { closeEvents } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", () => resolve());
        client!.once("error", reject);
      });
      client.send("hello-during-handoff");
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(primaryHandler).not.toHaveBeenCalled();
      expect(fallbackHandler).not.toHaveBeenCalled();
      const parkedPeers = listener.takePeers();
      expect(parkedPeers).toHaveLength(1);
      expect(parkedPeers[0]?.bufferedMessages).toHaveLength(1);
      expect(wsDataToText(parkedPeers[0]!.bufferedMessages![0]!.data)).toBe("hello-during-handoff");
      expect(closeEvents).toEqual([]);
    } finally {
      try {
        client?.close();
      } catch {
        // ignore
      }
      await listener.close();
    }
  });

  it("closes parked peers with 4002 when no host adopts them in time", async () => {
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1", parkedPeerGraceMs: 150 });
    let client: WebSocket | null = null;
    try {
      const port = await listener.ensureListening([0]);
      expect(await listener.ensureListening([0])).toBe(port);
      client = new WebSocket(`ws://127.0.0.1:${port}`);
      const { closeEvents } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", () => resolve());
        client!.once("error", reject);
      });
      const closeEvent = await waitForValue(
        () => closeEvents[0],
        "grace-period close",
      );
      expect(closeEvent.code).toBe(4002);
      expect(closeEvent.reason).toBe("Sync host changed projects");
    } finally {
      try {
        client?.close();
      } catch {
        // ignore
      }
      await listener.close();
    }
  });
});


describe("chat event replay buffer (resumable chat streams)", () => {
  const sessionId = "session-replay";

  function chatEnvelope(sequence: number, text = `event-${sequence}`, session = sessionId): AgentChatEventEnvelope {
    return {
      sessionId: session,
      timestamp: new Date(1_700_000_000_000 + sequence * 1_000).toISOString(),
      sequence,
      event: { type: "text", text } as AgentChatEventEnvelope["event"],
    };
  }

  it("assigns monotonically increasing seqs and dedupes by delivery key", () => {
    const buffer = createChatEventReplayBuffer();
    const first = chatEnvelope(1);
    expect(recordChatEventInReplayBuffer(buffer, first)).toBe(1);
    expect(recordChatEventInReplayBuffer(buffer, chatEnvelope(2))).toBe(2);
    // Same logical event observed again (live broadcast + transcript pump)
    // must resolve to the seq already assigned, not mint a new one.
    expect(recordChatEventInReplayBuffer(buffer, first)).toBe(1);
    expect(buffer.latestSeq).toBe(2);
    expect(buffer.entries.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("falls back to snapshot for a fresh subscribe without sinceSeq", () => {
    const buffer = createChatEventReplayBuffer();
    recordChatEventInReplayBuffer(buffer, chatEnvelope(1));
    expect(planChatEventResume(buffer, undefined)).toEqual({ mode: "snapshot" });
    expect(planChatEventResume(buffer, null)).toEqual({ mode: "snapshot" });
    expect(planChatEventResume(buffer, "3")).toEqual({ mode: "snapshot" });
    expect(planChatEventResume(buffer, -1)).toEqual({ mode: "snapshot" });
    expect(planChatEventResume(buffer, 1.5)).toEqual({ mode: "snapshot" });
    // No buffer for the session at all (e.g. host restart) → snapshot.
    expect(planChatEventResume(undefined, 3)).toEqual({ mode: "snapshot" });
  });

  it("replays exactly the missed events when the buffer covers the gap", () => {
    const buffer = createChatEventReplayBuffer();
    for (let index = 1; index <= 6; index += 1) {
      recordChatEventInReplayBuffer(buffer, chatEnvelope(index));
    }
    const plan = planChatEventResume(buffer, 3);
    expect(plan.mode).toBe("replay");
    if (plan.mode !== "replay") throw new Error("expected replay");
    expect(plan.entries.map((entry) => entry.seq)).toEqual([4, 5, 6]);
    // sinceSeq of 0 resumes from the very beginning while the buffer is intact.
    const fromStart = planChatEventResume(buffer, 0);
    if (fromStart.mode !== "replay") throw new Error("expected replay");
    expect(fromStart.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("replays nothing when the client is already current", () => {
    const buffer = createChatEventReplayBuffer();
    recordChatEventInReplayBuffer(buffer, chatEnvelope(1));
    recordChatEventInReplayBuffer(buffer, chatEnvelope(2));
    expect(planChatEventResume(buffer, 2)).toEqual({ mode: "replay", entries: [] });
  });

  it("falls back to snapshot when the gap predates the ring buffer", () => {
    const buffer = createChatEventReplayBuffer();
    for (let index = 1; index <= CHAT_EVENT_REPLAY_MAX_EVENTS + 10; index += 1) {
      recordChatEventInReplayBuffer(buffer, chatEnvelope(index));
    }
    expect(buffer.entries.length).toBe(CHAT_EVENT_REPLAY_MAX_EVENTS);
    const oldestBuffered = buffer.entries[0]!.seq;
    // Client last saw an event that has been evicted → cannot prove
    // continuity → snapshot.
    expect(planChatEventResume(buffer, oldestBuffered - 2)).toEqual({ mode: "snapshot" });
    // But the boundary case (sinceSeq + 1 is still buffered) replays fine.
    const boundary = planChatEventResume(buffer, oldestBuffered - 1);
    expect(boundary.mode).toBe("replay");
    if (boundary.mode !== "replay") throw new Error("expected replay");
    expect(boundary.entries[0]!.seq).toBe(oldestBuffered);
    expect(boundary.entries.at(-1)!.seq).toBe(buffer.latestSeq);
  });

  it("falls back to snapshot when sinceSeq is from a newer epoch than the buffer", () => {
    const buffer = createChatEventReplayBuffer();
    recordChatEventInReplayBuffer(buffer, chatEnvelope(1));
    // e.g. host restarted and reset its counter; the client's watermark is
    // ahead of everything the host has ever assigned.
    expect(planChatEventResume(buffer, 42)).toEqual({ mode: "snapshot" });
  });

  it("evicts oldest events when the byte budget is exceeded", () => {
    const buffer = createChatEventReplayBuffer();
    const bigText = "x".repeat(900_000);
    recordChatEventInReplayBuffer(buffer, chatEnvelope(1, bigText));
    recordChatEventInReplayBuffer(buffer, chatEnvelope(2, bigText));
    recordChatEventInReplayBuffer(buffer, chatEnvelope(3, bigText));
    expect(buffer.totalBytes).toBeLessThanOrEqual(CHAT_EVENT_REPLAY_MAX_BYTES);
    expect(buffer.entries[0]!.seq).toBeGreaterThan(1);
    expect(buffer.latestSeq).toBe(3);
    // The evicted event forces a snapshot for clients that far behind…
    expect(planChatEventResume(buffer, 0)).toEqual({ mode: "snapshot" });
    // …while recent clients still resume.
    const plan = planChatEventResume(buffer, buffer.entries[0]!.seq);
    expect(plan.mode).toBe("replay");
  });
});

describe("terminal byte-offset streaming, history paging, and resize ownership", () => {
  // 5000 ASCII bytes so byte offsets equal string indices in assertions.
  const TRANSCRIPT_CONTENT = "0123456789".repeat(500);

  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    spawnMock.mockImplementation(() => ({ kill: vi.fn(), once: vi.fn(), unref: vi.fn() }));
  });

  function createTerminalHost(projectRoot: string) {
    const transcriptPath = path.join(projectRoot, "transcripts", "session-1.log");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, TRANSCRIPT_CONTENT);
    const session = {
      id: "session-1",
      laneId: "lane-1",
      transcriptPath,
      status: "running",
      runtimeState: "running",
      lastOutputPreview: "preview",
    };
    const readTranscriptTail = vi.fn(async () => "tail-snapshot");
    const readTranscriptRange = vi.fn(async (args: { sessionId: string; startOffset: number; endOffset: number }) => ({
      data: TRANSCRIPT_CONTENT.slice(args.startOffset, args.endOffset),
      startOffset: args.startOffset,
      endOffset: args.endOffset,
    }));
    const resizeBySessionId = vi.fn().mockReturnValue(true);
    const restoreDesktopSizeBySessionId = vi.fn().mockReturnValue(true);
    const hasLivePty = vi.fn().mockReturnValue(true);
    const base = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...base,
      projectId: "project-1",
      db: {
        sync: {
          getSiteId: () => "site-host-terminal",
          getDbVersion: () => 0,
          exportChangesSince: () => [],
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
      sessionService: {
        list: () => [session],
        get: (id: string) => (id === "session-1" ? session : null),
        readTranscriptTail: async () => "",
      },
      ptyService: {
        create: vi.fn(),
        readTranscriptTail,
        readTranscriptRange,
        writeBySessionId: vi.fn().mockReturnValue(true),
        resizeBySessionId,
        restoreDesktopSizeBySessionId,
        hasLivePty,
        enrichSessions: (rows: unknown[]) => rows,
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    return { host, readTranscriptTail, readTranscriptRange, resizeBySessionId, restoreDesktopSizeBySessionId, hasLivePty };
  }

  async function connectTerminalPeer(port: number, token: string, deviceId: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const tracked = trackClientEnvelopes(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(encodeSyncEnvelope({
      type: "hello",
      payload: {
        peer: {
          deviceId,
          deviceName: deviceId,
          platform: "iOS",
          deviceType: "phone",
          siteId: `${deviceId}-site`,
          dbVersion: 0,
        },
        auth: { kind: "bootstrap", token },
      },
    }));
    await waitForValue(
      () => tracked.envelopes.find((envelope) => envelope.type === "hello_ok"),
      `hello_ok for ${deviceId}`,
    );
    return { ws, ...tracked };
  }

  function nextResponse(envelopes: ParsedSyncEnvelope[], type: string, requestId: string) {
    return waitForValue(
      () => envelopes.find((envelope) => envelope.type === type && envelope.requestId === requestId),
      `${type} response ${requestId}`,
    );
  }

  it("answers terminal_subscribe with a delta when sinceOffset fits the budget, else a tail snapshot with offsets", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const { host, readTranscriptTail, readTranscriptRange } = createTerminalHost(projectRoot);
    let client: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      client = await connectTerminalPeer(port, host.getBootstrapToken(), "ios-terminal-1");

      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "sub-delta",
        payload: { sessionId: "session-1", maxBytes: 32_000, sinceOffset: 4_988 },
      }));
      const delta = await nextResponse(client.envelopes, "terminal_snapshot", "sub-delta");
      expect(delta.payload).toMatchObject({
        sessionId: "session-1",
        transcript: TRANSCRIPT_CONTENT.slice(4_988),
        delta: true,
        startOffset: 4_988,
        endOffset: 5_000,
      });
      expect(readTranscriptRange).toHaveBeenCalledWith({
        sessionId: "session-1",
        startOffset: 4_988,
        endOffset: 5_000,
      });
      expect(readTranscriptTail).not.toHaveBeenCalled();

      // Gap larger than the budget → full tail snapshot (delta omitted).
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "sub-full",
        payload: { sessionId: "session-1", maxBytes: 1_024, sinceOffset: 0 },
      }));
      const full = await nextResponse(client.envelopes, "terminal_snapshot", "sub-full");
      expect(full.payload).toMatchObject({
        sessionId: "session-1",
        transcript: "tail-snapshot",
        startOffset: 5_000 - Buffer.byteLength("tail-snapshot", "utf8"),
        endOffset: 5_000,
      });
      expect((full.payload as { delta?: boolean }).delta).toBeUndefined();
      expect(readTranscriptTail).toHaveBeenCalledWith({
        sessionId: "session-1",
        maxBytes: 1_024,
        raw: true,
        alignToLineBoundary: true,
      });

      // sinceOffset beyond the transcript end (host restarted with a fresh
      // file, client watermark stale) → full snapshot, not a delta.
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "sub-stale",
        payload: { sessionId: "session-1", maxBytes: 32_000, sinceOffset: 9_999 },
      }));
      const stale = await nextResponse(client.envelopes, "terminal_snapshot", "sub-stale");
      expect((stale.payload as { delta?: boolean }).delta).toBeUndefined();
      expect((stale.payload as { transcript: string }).transcript).toBe("tail-snapshot");

      readTranscriptTail.mockResolvedValueOnce(`${TRANSCRIPT_CONTENT}buffered`);
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "sub-buffered",
        payload: { sessionId: "session-1", maxBytes: 1_024, sinceOffset: 0 },
      }));
      const buffered = await nextResponse(client.envelopes, "terminal_snapshot", "sub-buffered");
      expect(buffered.payload).toMatchObject({
        sessionId: "session-1",
        transcript: `${TRANSCRIPT_CONTENT}buffered`,
        startOffset: null,
        endOffset: null,
      });
    } finally {
      try {
        client?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("serves terminal_history pages to subscribed peers and refuses unsubscribed ones", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const { host, readTranscriptRange } = createTerminalHost(projectRoot);
    let client: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      client = await connectTerminalPeer(port, host.getBootstrapToken(), "ios-terminal-2");

      client.ws.send(encodeSyncEnvelope({
        type: "terminal_history",
        requestId: "hist-wrong-project",
        projectId: "project-2",
        payload: { sessionId: "session-1", beforeOffset: 4_000 },
      }));
      const wrongProject = await nextResponse(client.envelopes, "terminal_history", "hist-wrong-project");
      expect(wrongProject.payload).toEqual({
        sessionId: "session-1",
        data: "",
        startOffset: 4_000,
        endOffset: 4_000,
        atStart: true,
      });
      expect(readTranscriptRange).not.toHaveBeenCalled();

      // Not subscribed yet: same access gate as terminal_input.
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_history",
        requestId: "hist-refused",
        payload: { sessionId: "session-1", beforeOffset: 4_000 },
      }));
      const refused = await nextResponse(client.envelopes, "terminal_history", "hist-refused");
      expect(refused.payload).toEqual({
        sessionId: "session-1",
        data: "",
        startOffset: 4_000,
        endOffset: 4_000,
        atStart: true,
      });
      expect(readTranscriptRange).not.toHaveBeenCalled();

      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "sub-1",
        payload: { sessionId: "session-1", maxBytes: 32_000 },
      }));
      await nextResponse(client.envelopes, "terminal_snapshot", "sub-1");

      client.ws.send(encodeSyncEnvelope({
        type: "terminal_history",
        requestId: "hist-1",
        payload: { sessionId: "session-1", beforeOffset: 5_000, maxBytes: 4_096 },
      }));
      const page = await nextResponse(client.envelopes, "terminal_history", "hist-1");
      expect(readTranscriptRange).toHaveBeenCalledWith({
        sessionId: "session-1",
        startOffset: 5_000 - 4_096,
        endOffset: 5_000,
        alignStartToSafeBoundary: true,
      });
      expect(page.payload).toEqual({
        sessionId: "session-1",
        data: TRANSCRIPT_CONTENT.slice(904),
        startOffset: 904,
        endOffset: 5_000,
        atStart: false,
      });

      // beforeOffset inside the first page → page starts at 0 and atStart=true.
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_history",
        requestId: "hist-first",
        payload: { sessionId: "session-1", beforeOffset: 800, maxBytes: 4_096 },
      }));
      const firstPage = await nextResponse(client.envelopes, "terminal_history", "hist-first");
      expect(firstPage.payload).toEqual({
        sessionId: "session-1",
        data: TRANSCRIPT_CONTENT.slice(0, 800),
        startOffset: 0,
        endOffset: 800,
        atStart: true,
      });

      // beforeOffset past EOF clamps to the flushed transcript size.
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_history",
        requestId: "hist-clamped",
        payload: { sessionId: "session-1", beforeOffset: 999_999, maxBytes: 4_096 },
      }));
      const clamped = await nextResponse(client.envelopes, "terminal_history", "hist-clamped");
      expect(clamped.payload).toMatchObject({ startOffset: 904, endOffset: 5_000, atStart: false });
    } finally {
      try {
        client?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("restores the desktop terminal size only after the last subscribed peer detaches", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const { host, resizeBySessionId, restoreDesktopSizeBySessionId } = createTerminalHost(projectRoot);
    let clientA: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    let clientB: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      clientA = await connectTerminalPeer(port, host.getBootstrapToken(), "ios-terminal-a");
      clientB = await connectTerminalPeer(port, host.getBootstrapToken(), "ios-terminal-b");

      clientA.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "sub-a",
        payload: { sessionId: "session-1", maxBytes: 32_000 },
      }));
      await nextResponse(clientA.envelopes, "terminal_snapshot", "sub-a");
      clientB.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "sub-b",
        payload: { sessionId: "session-1", maxBytes: 32_000 },
      }));
      await nextResponse(clientB.envelopes, "terminal_snapshot", "sub-b");

      clientA.ws.send(encodeSyncEnvelope({
        type: "terminal_resize",
        payload: { sessionId: "session-1", cols: 61.7, rows: 21.2 },
      }));
      await waitForValue(
        () => (resizeBySessionId.mock.calls.length > 0 ? resizeBySessionId.mock.calls[0] : null),
        "mobile resize forwarded",
      );
      expect(resizeBySessionId).toHaveBeenCalledWith("session-1", 61, 21, { source: "mobile" });

      // Peer A detaches while peer B still watches: no restore. The follow-up
      // history request (refused because A just unsubscribed) fences ordering.
      clientA.ws.send(encodeSyncEnvelope({
        type: "terminal_unsubscribe",
        payload: { sessionId: "session-1" },
      }));
      clientA.ws.send(encodeSyncEnvelope({
        type: "terminal_history",
        requestId: "fence-a",
        payload: { sessionId: "session-1", beforeOffset: 100 },
      }));
      const fence = await nextResponse(clientA.envelopes, "terminal_history", "fence-a");
      expect((fence.payload as { atStart: boolean }).atStart).toBe(true);
      expect(restoreDesktopSizeBySessionId).not.toHaveBeenCalled();

      // Last watcher disconnects → snap back to the desktop size.
      clientB.ws.close();
      await waitForValue(
        () => (restoreDesktopSizeBySessionId.mock.calls.length > 0 ? restoreDesktopSizeBySessionId.mock.calls[0] : null),
        "desktop size restore after last peer detached",
      );
      expect(restoreDesktopSizeBySessionId).toHaveBeenCalledTimes(1);
      expect(restoreDesktopSizeBySessionId).toHaveBeenCalledWith("session-1");
    } finally {
      try {
        clientA?.ws.close();
      } catch {
        // ignore
      }
      try {
        clientB?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("marks terminal snapshots live:false when no PTY backs the session", async () => {
    // A brain restart orphans "running" sessions; the phone needs the truth
    // up front so it shows the resume bar instead of accepting keystrokes.
    const { projectRoot, cleanup } = createTempProjectRoot();
    const { host, hasLivePty } = createTerminalHost(projectRoot);
    hasLivePty.mockReturnValue(false);
    let client: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      client = await connectTerminalPeer(port, host.getBootstrapToken(), "ios-terminal-live");
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "sub-dead",
        payload: { sessionId: "session-1", maxBytes: 32_000 },
      }));
      const snapshot = await nextResponse(client.envelopes, "terminal_snapshot", "sub-dead");
      expect((snapshot.payload as { live?: boolean }).live).toBe(false);

      hasLivePty.mockReturnValue(true);
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "sub-live",
        payload: { sessionId: "session-1", maxBytes: 32_000 },
      }));
      const liveSnapshot = await nextResponse(client.envelopes, "terminal_snapshot", "sub-live");
      expect((liveSnapshot.payload as { live?: boolean }).live).toBe(true);
    } finally {
      try {
        client?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });
});

describe("createSyncHostService all-projects roster", () => {
  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    spawnMock.mockImplementation(() => ({ kill: vi.fn(), once: vi.fn(), unref: vi.fn() }));
  });

  function rosterProject(projectId: string, runningCount: number) {
    return {
      projectId,
      rootPath: `/tmp/${projectId}`,
      displayName: projectId,
      booted: false,
      runningCount,
      attentionCount: 0,
      lanes: [],
      chats: [],
    };
  }

  function createRosterHost(
    projectRoot: string,
    rosterState: { projects: ReturnType<typeof rosterProject>[] },
    options: { withRosterProvider?: boolean } = {},
  ) {
    const base = createHostArgs(projectRoot, []);
    const args = {
      ...base,
      projectId: "project-host",
      db: {
        sync: {
          getSiteId: () => "site-host-roster",
          getDbVersion: () => 0,
          exportChangesSince: () => [],
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
      projectCatalogProvider: {
        listProjects: vi.fn(async () => ({ projects: [] })),
        prepareProjectConnection: vi.fn(),
        forgetProject: vi.fn(async () => ({ ok: true })),
      },
      ...(options.withRosterProvider === false
        ? {}
        : { rosterProvider: { buildSnapshot: async () => rosterState.projects } }),
    } as unknown as Parameters<typeof createSyncHostService>[0];
    return createSyncHostService(args);
  }

  it("answers roster_subscribe with a seq:1 snapshot and bumps per-peer seq on re-subscribe", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const rosterState = { projects: [rosterProject("project-a", 1), rosterProject("project-b", 0)] };
    const host = createRosterHost(projectRoot, rosterState);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-roster-1");

      peer.ws.send(encodeSyncEnvelope({ type: "roster_subscribe", requestId: "roster-1", payload: {} }));
      const snapshot = await waitForEnvelope(peer.envelopes, "roster_snapshot", "roster-1");
      expect(snapshot.payload).toMatchObject({ seq: 1 });
      expect((snapshot.payload as { projects: unknown[] }).projects).toHaveLength(2);

      peer.ws.send(encodeSyncEnvelope({ type: "roster_subscribe", requestId: "roster-2", payload: {} }));
      const second = await waitForEnvelope(peer.envelopes, "roster_snapshot", "roster-2");
      expect(second.payload).toMatchObject({ seq: 2 });
    } finally {
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("pushes a coalesced roster_delta carrying only the changed project", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const rosterState = { projects: [rosterProject("project-a", 1), rosterProject("project-b", 0)] };
    const host = createRosterHost(projectRoot, rosterState);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-roster-2");

      peer.ws.send(encodeSyncEnvelope({ type: "roster_subscribe", requestId: "roster-1", payload: {} }));
      await waitForEnvelope(peer.envelopes, "roster_snapshot", "roster-1");

      // Mutate one project, then dirty the roster via a project-catalog change.
      rosterState.projects = [rosterProject("project-a", 5), rosterProject("project-b", 0)];
      peer.ws.send(encodeSyncEnvelope({
        type: "project_forget_request",
        requestId: "forget-1",
        payload: { projectId: "project-x" },
      }));

      const delta = await waitForValue(
        () => peer?.envelopes.find((envelope) => envelope.type === "roster_delta"),
        "roster_delta after dirty",
      );
      expect(delta.payload).toMatchObject({ seq: 2 });
      const changed = (delta.payload as { changed?: Array<{ projectId: string; runningCount: number }> }).changed ?? [];
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({ projectId: "project-a", runningCount: 5 });
      expect((delta.payload as { removed?: string[] }).removed).toBeUndefined();
    } finally {
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("stays silent on roster_subscribe when no roster provider is wired (older host)", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const rosterState = { projects: [] as ReturnType<typeof rosterProject>[] };
    const host = createRosterHost(projectRoot, rosterState, { withRosterProvider: false });
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-roster-3");

      peer.ws.send(encodeSyncEnvelope({ type: "roster_subscribe", requestId: "roster-1", payload: {} }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(peer.envelopes.some((envelope) => envelope.type === "roster_snapshot")).toBe(false);
      expect(peer.envelopes.some((envelope) => envelope.type === "roster_delta")).toBe(false);
    } finally {
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });
});
