import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCrsqliteAvailable } from "../state/crsqliteExtension";
import { openKvDb } from "../state/kvDb";
import { createSyncService } from "./syncService";

const { createSyncHostServiceMock } = vi.hoisted(() => ({
  createSyncHostServiceMock: vi.fn(() => ({
    async waitUntilListening() {
      return 8787;
    },
    getPort() {
      return 8787;
    },
    getBootstrapToken() {
      return "test-bootstrap-token";
    },
    revokePairedDevice() {},
    getPeerStates() {
      return [];
    },
    getTailnetDiscoveryStatus() {
      return {
        state: "disabled",
        serviceName: "svc:ade-sync",
        servicePort: 8787,
        target: null,
        updatedAt: null,
        error: null,
        stderr: null,
      };
    },
    getBrainStatusSnapshot() {
      return {};
    },
    handlePtyData() {},
    handlePtyExit() {},
    async dispose() {},
  })),
}));

// Prevent real WebSocket servers from binding to port 8787 during tests.
// Tests only exercise role/transfer/pairing logic, not the sync transport.
vi.mock("./syncHostService", () => ({
  createSyncHostService: createSyncHostServiceMock,
  SYNC_TAILNET_DISCOVERY_SERVICE_NAME: "svc:ade-sync",
  SYNC_TAILNET_DISCOVERY_SERVICE_PORT: 8787,
}));

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

function makeProjectRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, ".ade", "artifacts"), { recursive: true });
  return root;
}

function insertProjectAndLane(
  db: Awaited<ReturnType<typeof openKvDb>>,
  laneId = "lane-1",
): void {
  const now = "2026-03-15T00:00:00.000Z";
  db.run(
    `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["project-1", "/repo/a", "Repo A", "main", now, now],
  );
  db.run(
    `insert into lanes(
      id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path, attached_root_path,
      is_edit_protected, parent_lane_id, color, icon, tags_json, folder, status, created_at, archived_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      laneId,
      "project-1",
      "Lane 1",
      null,
      "worktree",
      "main",
      "feature/sync",
      `/repo/a/.ade/worktrees/${laneId}`,
      null,
      0,
      null,
      null,
      null,
      null,
      null,
      "active",
      now,
      null,
    ],
  );
}

const activeDisposers: Array<() => Promise<void>> = [];

beforeEach(() => {
  createSyncHostServiceMock.mockClear();
});

afterEach(async () => {
  while (activeDisposers.length > 0) {
    const dispose = activeDisposers.pop();
    if (dispose) await dispose();
  }
});

describe.skipIf(!isCrsqliteAvailable())("syncService", () => {
  it("reports W3 transfer blockers while keeping paused and idle state survivable", async () => {
    const projectRoot = makeProjectRoot("ade-sync-service-blockers-");
    const db = await openKvDb(
      path.join(projectRoot, ".ade", "ade.db"),
      createLogger() as any,
    );
    insertProjectAndLane(db);

    const service = createSyncService({
      db,
      logger: createLogger() as any,
      projectRoot,
      fileService: { dispose: () => {} } as any,
      laneService: {
        list: async () => [],
        create: async () => ({}),
        archive: async () => {},
      } as any,
      prService: {
        listAll: async () => [],
        getDetail: async () => null,
        getStatus: async () => null,
        getChecks: async () => [],
        getReviews: async () => [],
        getComments: async () => [],
        getFiles: async () => [],
        createFromLane: async () => ({}),
        land: async () => ({}),
        closePr: async () => {},
        requestReviewers: async () => {},
      } as any,
      sessionService: {
        list: ({ status }: { status?: string } = {}) => {
          if (status === "running") {
            return [
              {
                id: "chat-1",
                laneId: "lane-1",
                title: "CTO delegation thread",
                status: "running",
                toolType: "codex-chat",
              },
              {
                id: "term-1",
                laneId: "lane-1",
                title: "Build shell",
                status: "running",
                toolType: "shell",
              },
            ];
          }
          return [];
        },
      } as any,
      ptyService: {} as any,
      computerUseArtifactBrokerService: {} as any,
      missionService: {
        list: ({ status }: { status?: string } = {}) =>
          status === "active"
            ? [{ id: "mission-1", title: "Ship W3", status: "active" }]
            : [],
      } as any,
      agentChatService: {
        listSessions: async () => [
          {
            sessionId: "chat-1",
            title: "CTO delegation thread",
            identityKey: "cto",
            status: "idle",
          },
          {
            sessionId: "chat-2",
            title: "Idle worker chat",
            identityKey: "agent:worker-1",
            status: "idle",
          },
          {
            sessionId: "chat-3",
            title: "Finished worker chat",
            identityKey: "agent:worker-2",
            status: "ended",
          },
        ],
      } as any,
      processService: {
        listRuntime: (laneId: string) =>
          laneId === "lane-1"
            ? [{ processId: "dev-server", status: "running" }]
            : [],
      } as any,
    });

    activeDisposers.push(async () => {
      await service.dispose();
      db.close();
    });

    const readiness = await service.getTransferReadiness();

    expect(readiness.ready).toBe(false);
    expect(readiness.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "mission_run", id: "mission-1" }),
        expect.objectContaining({
          kind: "chat_runtime",
          id: "chat-1",
          label: "CTO delegation thread",
        }),
        expect.objectContaining({ kind: "terminal_session", id: "term-1" }),
        expect.objectContaining({
          kind: "managed_process",
          id: "lane-1:dev-server",
        }),
      ]),
    );
    expect(readiness.survivableState).toEqual(
      expect.arrayContaining([
        "Paused missions remain paused and can resume on the new host.",
        "CTO history and idle threads remain available on the new host.",
        "Idle and ended agent chats remain available and resumable on the new host.",
      ]),
    );
  });

  it("transfers the host role to the local device when only durable state remains", async () => {
    const projectRoot = makeProjectRoot("ade-sync-service-transfer-");
    const db = await openKvDb(
      path.join(projectRoot, ".ade", "ade.db"),
      createLogger() as any,
    );

    const service = createSyncService({
      db,
      logger: createLogger() as any,
      projectRoot,
      fileService: { dispose: () => {} } as any,
      laneService: {
        list: async () => [],
        create: async () => ({}),
        archive: async () => {},
      } as any,
      prService: {
        listAll: async () => [],
        getDetail: async () => null,
        getStatus: async () => null,
        getChecks: async () => [],
        getReviews: async () => [],
        getComments: async () => [],
        getFiles: async () => [],
        createFromLane: async () => ({}),
        land: async () => ({}),
        closePr: async () => {},
        requestReviewers: async () => {},
      } as any,
      sessionService: { list: () => [] } as any,
      ptyService: {} as any,
      computerUseArtifactBrokerService: {} as any,
      missionService: { list: () => [] } as any,
      agentChatService: { listSessions: async () => [] } as any,
      processService: { listRuntime: () => [] } as any,
    });

    activeDisposers.push(async () => {
      await service.dispose();
      db.close();
    });

    const initial = await service.getStatus();
    const localDevice = initial.localDevice;
    const now = "2026-03-15T01:00:00.000Z";

    db.run(
      `insert into devices(
        device_id, site_id, name, platform, device_type, created_at, updated_at, last_seen_at, last_host, last_port, tailscale_ip, ip_addresses_json, metadata_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "remote-brain",
        "remote-site",
        "Remote host",
        "macOS",
        "desktop",
        now,
        now,
        now,
        "10.0.0.9",
        8787,
        null,
        JSON.stringify(["10.0.0.9"]),
        JSON.stringify({}),
      ],
    );
    db.run(
      `insert into sync_cluster_state(cluster_id, brain_device_id, brain_epoch, updated_at, updated_by_device_id)
       values (?, ?, ?, ?, ?)`,
      ["default", "remote-brain", 3, now, "remote-brain"],
    );

    const beforeTransfer = await service.getStatus();
    expect(beforeTransfer.role).toBe("viewer");
    expect(beforeTransfer.currentBrain?.deviceId).toBe("remote-brain");

    const transferred = await service.transferBrainToLocal();

    expect(transferred.role).toBe("brain");
    expect(transferred.clusterState?.brainDeviceId).toBe(localDevice.deviceId);
    expect(transferred.clusterState?.brainEpoch).toBe(4);
    expect(transferred.currentBrain?.deviceId).toBe(localDevice.deviceId);
    expect(transferred.transferReadiness.ready).toBe(true);
  }, 30_000);

  it("builds pairing QR payloads with LAN-first address candidates and tailscale fallback", async () => {
    const projectRoot = makeProjectRoot("ade-sync-service-pairing-");
    const db = await openKvDb(
      path.join(projectRoot, ".ade", "ade.db"),
      createLogger() as any,
    );

    const service = createSyncService({
      db,
      logger: createLogger() as any,
      projectRoot,
      fileService: { dispose: () => {} } as any,
      laneService: {
        list: async () => [],
        create: async () => ({}),
        archive: async () => {},
      } as any,
      prService: {
        listAll: async () => [],
        getDetail: async () => null,
        getStatus: async () => null,
        getChecks: async () => [],
        getReviews: async () => [],
        getComments: async () => [],
        getFiles: async () => [],
        createFromLane: async () => ({}),
        land: async () => ({}),
        closePr: async () => {},
        requestReviewers: async () => {},
      } as any,
      sessionService: { list: () => [] } as any,
      ptyService: {} as any,
      computerUseArtifactBrokerService: {} as any,
      missionService: { list: () => [] } as any,
      agentChatService: { listSessions: async () => [] } as any,
      processService: { listRuntime: () => [] } as any,
    });

    activeDisposers.push(async () => {
      await service.dispose();
      db.close();
    });

    await service.initialize();
    const initialStatus = await service.getStatus();
    const localDeviceId = initialStatus.localDevice.deviceId;
    const now = "2026-03-17T00:00:00.000Z";
    db.run(
      `update devices
         set ip_addresses_json = ?,
             last_host = ?,
             last_port = ?,
             tailscale_ip = ?,
             updated_at = ?,
             last_seen_at = ?
       where device_id = ?`,
      [
        JSON.stringify(["192.168.0.5", "192.168.0.8"]),
        "192.168.0.20",
        8787,
        "100.100.12.4",
        now,
        now,
        localDeviceId,
      ],
    );

    const status = await service.getStatus();
    expect(status.mode === "brain" || status.mode === "standalone").toBe(true);
    expect(status.pairingConnectInfo).toBeTruthy();
    const addressCandidates =
      status.pairingConnectInfo?.addressCandidates ?? [];
    const loopbackCandidateIndex = addressCandidates.findIndex(
      (entry) => entry.kind === "loopback" && entry.host === "127.0.0.1",
    );
    expect(addressCandidates.length).toBeGreaterThan(0);
    expect(loopbackCandidateIndex).toBe(addressCandidates.length - 1);
    expect(addressCandidates.slice(0, Math.max(loopbackCandidateIndex, 0)).every((entry) => entry.kind !== "loopback")).toBe(true);

    db.run(
      `update devices
         set last_host = ?,
             updated_at = ?
       where device_id = ?`,
      [
        "192.168.0.8",
        "2026-03-17T00:05:00.000Z",
        localDeviceId,
      ],
    );

    const refreshedStatus = await service.getStatus();
    const refreshedCandidates = refreshedStatus.pairingConnectInfo?.addressCandidates ?? [];
    expect(refreshedCandidates[0]?.kind).toBe("saved");
    expect(refreshedCandidates[0]?.host).toBe(refreshedStatus.localDevice.lastHost);

    const encodedPayload =
      status.pairingConnectInfo?.qrPayloadText.split("payload=")[1] ?? "";
    const parsedPayload = JSON.parse(decodeURIComponent(encodedPayload)) as {
      version: number;
      hostIdentity: { deviceId: string };
      addressCandidates: Array<{ host: string; kind: string }>;
    };
    expect(parsedPayload.version).toBe(2);
    expect(parsedPayload.hostIdentity.deviceId).toBe(localDeviceId);
    expect(parsedPayload.addressCandidates.some((c) => c.kind === "loopback" && c.host === "127.0.0.1")).toBe(true);
  }, 30_000);

  it("does not start the sync host or expose pairing details when host startup is disabled", async () => {
    const projectRoot = makeProjectRoot("ade-sync-service-host-disabled-");
    const db = await openKvDb(
      path.join(projectRoot, ".ade", "ade.db"),
      createLogger() as any,
    );

    const service = createSyncService({
      db,
      logger: createLogger() as any,
      projectRoot,
      fileService: { dispose: () => {} } as any,
      laneService: {
        list: async () => [],
        create: async () => ({}),
        archive: async () => {},
      } as any,
      prService: {
        listAll: async () => [],
        getDetail: async () => null,
        getStatus: async () => null,
        getChecks: async () => [],
        getReviews: async () => [],
        getComments: async () => [],
        getFiles: async () => [],
        createFromLane: async () => ({}),
        land: async () => ({}),
        closePr: async () => {},
        requestReviewers: async () => {},
      } as any,
      sessionService: { list: () => [] } as any,
      ptyService: {} as any,
      computerUseArtifactBrokerService: {} as any,
      missionService: { list: () => [] } as any,
      agentChatService: { listSessions: async () => [] } as any,
      processService: { listRuntime: () => [] } as any,
      hostStartupEnabled: false,
    } as any);

    activeDisposers.push(async () => {
      await service.dispose();
      db.close();
    });

    await service.initialize();
    const status = await service.getStatus();

    expect(createSyncHostServiceMock).not.toHaveBeenCalled();
    expect(service.getHostService()).toBeNull();
    expect(status.role).toBe("brain");
    expect(status.mode).toBe("standalone");
    expect(status.bootstrapToken).toBeNull();
    expect(status.pairingPin).toBeNull();
    expect(status.pairingConnectInfo).toBeNull();
    await expect(service.setPin("123456")).rejects.toThrow(
      "Phone pairing is unavailable because the sync host is disabled for this ADE process.",
    );
    expect(service.getPin()).toBeNull();
  }, 30_000);

  it("retries the sync host on bind conflicts so another project can still initialize", async () => {
    const projectRoot = makeProjectRoot("ade-sync-service-port-retry-");
    const db = await openKvDb(
      path.join(projectRoot, ".ade", "ade.db"),
      createLogger() as any,
    );

    const disposeFirstAttempt = vi.fn(async () => {});
    const disposeSecondAttempt = vi.fn(async () => {});
    createSyncHostServiceMock.mockImplementation((({ port }: { port?: number }) => {
      const attemptedPort = port ?? 8787;
      return {
        async waitUntilListening() {
          if (attemptedPort === 8787) {
            const error = Object.assign(new Error("address already in use"), {
              code: "EADDRINUSE",
            });
            throw error;
          }
          return attemptedPort;
        },
        getPort() {
          return attemptedPort;
        },
        getBootstrapToken() {
          return "test-bootstrap-token";
        },
        revokePairedDevice() {},
        getPeerStates() {
          return [];
        },
        getTailnetDiscoveryStatus() {
          return {
            state: "disabled",
            serviceName: "svc:ade-sync",
            servicePort: 8787,
            target: null,
            updatedAt: null,
            error: null,
            stderr: null,
          };
        },
        getBrainStatusSnapshot() {
          return {};
        },
        handlePtyData() {},
        handlePtyExit() {},
        dispose: attemptedPort === 8787 ? disposeFirstAttempt : disposeSecondAttempt,
      };
    }) as any);

    const service = createSyncService({
      db,
      logger: createLogger() as any,
      projectRoot,
      fileService: { dispose: () => {} } as any,
      laneService: {
        list: async () => [],
        create: async () => ({}),
        archive: async () => {},
      } as any,
      prService: {
        listAll: async () => [],
        getDetail: async () => null,
        getStatus: async () => null,
        getChecks: async () => [],
        getReviews: async () => [],
        getComments: async () => [],
        getFiles: async () => [],
        createFromLane: async () => ({}),
        land: async () => ({}),
        closePr: async () => {},
        requestReviewers: async () => {},
      } as any,
      sessionService: { list: () => [] } as any,
      ptyService: {} as any,
      computerUseArtifactBrokerService: {} as any,
      missionService: { list: () => [] } as any,
      agentChatService: { listSessions: async () => [] } as any,
      processService: { listRuntime: () => [] } as any,
    });

    activeDisposers.push(async () => {
      await service.dispose();
      db.close();
    });

    await service.initialize();

    expect(createSyncHostServiceMock.mock.calls.map((call: any[]) => call[0]?.port)).toEqual([8787, 8788]);
    expect(disposeFirstAttempt).toHaveBeenCalledTimes(1);
    expect(service.getHostService()?.getPort()).toBe(8788);
  }, 30_000);
});
