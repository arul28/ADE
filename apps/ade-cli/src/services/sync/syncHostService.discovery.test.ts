import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncMobileProjectSummary } from "../../../../desktop/src/shared/types";
import { createSyncHostService } from "./syncHostService";

const publishMock = vi.hoisted(() => vi.fn());
const bonjourDestroyMock = vi.hoisted(() => vi.fn());
const bonjourConstructorMock = vi.hoisted(() => vi.fn());

vi.mock("bonjour-service", () => ({
  Bonjour: bonjourConstructorMock,
}));

type BonjourPublishArgs = {
  name: string;
  type: string;
  protocol: string;
  port: number;
  txt: Record<string, string>;
  disableIPv6: boolean;
};

function createLogger() {
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

function createProject(overrides: Partial<SyncMobileProjectSummary>): SyncMobileProjectSummary {
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
      },
    },
    logger: createLogger(),
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
  beforeEach(() => {
    publishMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    bonjourConstructorMock.mockImplementation(() => ({
      publish: publishMock,
      destroy: bonjourDestroyMock,
    }));
    publishMock.mockImplementation(() => ({
      on: vi.fn(),
      stop: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes headless runtime project metadata in Bonjour TXT records", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const projects = [
      createProject({ id: "project-1", displayName: "API, Server\nOne", rootPath: "/srv/api" }),
      createProject({ id: "project-2", displayName: "Worker", rootPath: "/srv/worker" }),
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
});
