import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserAccountClient } from "../../account/client";
import type {
  AdeSyncClient,
  AdeSyncClientStatus,
  WebClientEnvironmentRecord,
} from "../../sync";
import {
  applyProjectHostHello,
  recoverProjectHost,
  resetProjectHostRecoveryStore,
} from "../../sync/projectHostRecoveryStore";
import { WEB_MACHINE_SESSION_LIMIT, WebMachineSessionManager } from "../WebMachineSessionManager";

function environment(index: number): WebClientEnvironmentRecord {
  return {
    envId: `machine-${index}`,
    machineName: `Machine ${index}`,
    hostDeviceId: `device-${index}`,
    accountOwnerUserId: null,
    relayUrl: null,
    machineKeyUrl: null,
    addressCandidates: [],
    explicitWssEndpoints: [`wss://machine-${index}.example/sync`],
    port: 8787,
    pairedDeviceId: "browser-device",
    secret: "secret",
    dpopKeys: {} as CryptoKeyPair,
    siteId: "site-id",
    localDeviceId: "browser-device",
    localDeviceName: "ADE Web",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function idleStatus(): AdeSyncClientStatus {
  return {
    state: "idle",
    endpoint: null,
    envId: null,
    hostDeviceId: null,
    hostName: null,
    connectedAt: null,
    lastSeenAt: null,
    error: null,
    activeProjectId: null,
    selectedEnvId: null,
    readiness: "disconnected",
  };
}

class FakeSyncClient {
  status = idleStatus();
  connect = vi.fn(async (envId: string) => {
    this.status = {
      ...idleStatus(),
      state: "connected",
      endpoint: `wss://${envId}.example/sync`,
      envId,
      hostDeviceId: envId,
      hostName: envId,
      connectedAt: new Date(Date.now()).toISOString(),
      lastSeenAt: new Date(Date.now()).toISOString(),
      selectedEnvId: envId,
      activeProjectId: `project-${envId}`,
      readiness: "ready",
    };
    this.statusListeners.forEach((listener) => listener(this.status));
  });
  disconnect = vi.fn(() => {
    this.status = idleStatus();
    this.statusListeners.forEach((listener) => listener(this.status));
  });
  switchProject = vi.fn(async (projectId: string) => {
    this.status = { ...this.status, activeProjectId: projectId };
    return {
      ok: true,
      project: this.project(projectId),
    };
  });
  removeEnvironment = vi.fn(async () => undefined);
  sendCommand = vi.fn(async () => ({
    operationId: "op-1",
    ok: true,
    status: "succeeded",
    snapshot: {
      state: "ready",
      headline: "Connected",
      body: "This machine's project connection is ready.",
      conflict: null,
      recoveryEligible: false,
    },
    steps: [{ id: "stop", status: "done" }],
    message: "Project connection is ready.",
  }));
  listEnvironments = vi.fn(async () => []);
  private readonly statusListeners = new Set<(status: AdeSyncClientStatus) => void>();
  private readonly catalogListeners = new Set<(payload: {
    projects: ReturnType<FakeSyncClient["project"]>[];
  }) => void>();

  getStatus() {
    return this.status;
  }

  getProjectCatalog = vi.fn(async () => ({
    projects: [
      this.project(`project-${this.status.selectedEnvId}`),
      this.project(`alternate-${this.status.selectedEnvId}`),
    ],
  }));

  subscribe(listener: (status: AdeSyncClientStatus) => void) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onProjectCatalog(listener: (payload: {
    projects: ReturnType<FakeSyncClient["project"]>[];
  }) => void) {
    this.catalogListeners.add(listener);
    return () => this.catalogListeners.delete(listener);
  }

  emitProjectCatalog(projects: Array<{ id: string; displayName?: string }>) {
    const payload = {
      projects: projects.map(({ id, displayName }) => ({
        ...this.project(id),
        ...(displayName ? { displayName } : {}),
      })),
    };
    this.catalogListeners.forEach((listener) => listener(payload));
  }

  failAuthentication() {
    this.status = {
      ...this.status,
      state: "auth_failed",
      readiness: "failed",
      error: "Pairing revoked",
    };
    this.statusListeners.forEach((listener) => listener(this.status));
  }

  private project(id: string) {
    return {
      id,
      displayName: id,
      rootPath: `/repos/${id}`,
      defaultBaseRef: "main",
      lastOpenedAt: null,
      iconDataUrl: null,
      laneCount: 1,
      isAvailable: true,
      isCached: true,
      isOpen: true,
    };
  }

  asClient(): AdeSyncClient {
    return this as unknown as AdeSyncClient;
  }
}

const accountClient = {
  getAccessToken: vi.fn(async () => "token"),
} as unknown as BrowserAccountClient;

afterEach(() => {
  vi.restoreAllMocks();
  resetProjectHostRecoveryStore();
});

const conflictSnapshot = {
  state: "conflict" as const,
  headline: "Another ADE is blocking this machine",
  body: "A development runtime is using the connection your phone needs.",
  recoveryEligible: true,
  conflict: {
    reason: "listener" as const,
    ownerKind: "development" as const,
    ownerLabel: "Development runtime",
    projectLabel: "improving-browser lane",
    impact: "May interrupt improving-browser lane.",
    recoveryEligible: true,
    technicalDetail: "pid: 4242",
  },
};

describe("WebMachineSessionManager", () => {
  it("parks the least recently used machine when the four-session pool is full", async () => {
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => ++clock);
    const clients = Array.from(
      { length: WEB_MACHINE_SESSION_LIMIT + 1 },
      () => new FakeSyncClient(),
    );
    let nextClient = 1;
    const manager = new WebMachineSessionManager(
      clients[0].asClient(),
      accountClient,
      () => clients[nextClient++].asClient(),
    );
    manager.replaceEnvironments(clients.map((_, index) => environment(index + 1)));

    for (let index = 1; index <= clients.length; index += 1) {
      await manager.connectEnvironment(`machine-${index}`);
    }

    const snapshot = manager.getSnapshot();
    expect(snapshot.sessions.filter((session) => session.state === "live")).toHaveLength(
      WEB_MACHINE_SESSION_LIMIT,
    );
    expect(manager.getSession("machine-1")?.state).toBe("parked");
    expect(clients[0].disconnect).toHaveBeenCalledOnce();
    expect(manager.getConnectionSnapshot().connections.find(
      (entry) => entry.target.id === "machine-1",
    )?.state).toBe("parked");
  });

  it("resumes a parked machine on demand and parks the next LRU session", async () => {
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => ++clock);
    const clients = Array.from(
      { length: WEB_MACHINE_SESSION_LIMIT + 1 },
      () => new FakeSyncClient(),
    );
    let nextClient = 1;
    const manager = new WebMachineSessionManager(
      clients[0].asClient(),
      accountClient,
      () => clients[nextClient++].asClient(),
    );
    manager.replaceEnvironments(clients.map((_, index) => environment(index + 1)));
    for (let index = 1; index <= clients.length; index += 1) {
      await manager.connectEnvironment(`machine-${index}`);
    }

    await manager.connectEnvironment("machine-1");

    expect(manager.getSession("machine-1")?.state).toBe("live");
    expect(clients.slice(0, WEB_MACHINE_SESSION_LIMIT).reduce(
      (count, client) => count + client.connect.mock.calls.length,
      0,
    )).toBe(WEB_MACHINE_SESSION_LIMIT + 2);
    expect(clients[WEB_MACHINE_SESSION_LIMIT].connect).not.toHaveBeenCalled();
    expect(manager.getSnapshot().sessions.filter(
      (session) => session.state === "parked",
    )).toHaveLength(1);
  });

  it("never automatically parks the target protected by the federated workspace", async () => {
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => ++clock);
    const clients = Array.from(
      { length: WEB_MACHINE_SESSION_LIMIT + 1 },
      () => new FakeSyncClient(),
    );
    let nextClient = 1;
    const manager = new WebMachineSessionManager(
      clients[0].asClient(),
      accountClient,
      () => clients[nextClient++].asClient(),
    );
    manager.replaceEnvironments(clients.map((_, index) => environment(index + 1)));
    for (let index = 1; index <= WEB_MACHINE_SESSION_LIMIT; index += 1) {
      await manager.connectEnvironment(`machine-${index}`);
    }
    manager.setProtectedTargetId("machine-1");

    await manager.connectEnvironment(`machine-${WEB_MACHINE_SESSION_LIMIT + 1}`);

    expect(manager.getSession("machine-1")?.state).toBe("live");
    expect(manager.getSession("machine-2")?.state).toBe("parked");
  });

  it("reconnects a protected target after it was explicitly parked", async () => {
    const clients = Array.from(
      { length: WEB_MACHINE_SESSION_LIMIT },
      () => new FakeSyncClient(),
    );
    let nextClient = 1;
    const manager = new WebMachineSessionManager(
      clients[0].asClient(),
      accountClient,
      () => clients[nextClient++].asClient(),
    );
    manager.replaceEnvironments(clients.map((_, index) => environment(index + 1)));
    await manager.connectEnvironment("machine-1");
    manager.setProtectedTargetId("machine-1");
    await manager.park("machine-1");

    await manager.connectEnvironment("machine-1");

    expect(manager.getSession("machine-1")?.state).toBe("live");
    expect(clients[0].connect).toHaveBeenCalledTimes(2);
  });

  it("switches projects inside one machine without disturbing other sessions", async () => {
    const primary = new FakeSyncClient();
    const secondary = new FakeSyncClient();
    const manager = new WebMachineSessionManager(
      primary.asClient(),
      accountClient,
      () => secondary.asClient(),
    );
    manager.replaceEnvironments([environment(1), environment(2)]);
    await manager.connectEnvironment("machine-1");
    await manager.connectEnvironment("machine-2");

    const result = await manager.openProject("machine-1", "alternate-machine-1");

    expect(result.project.id).toBe("alternate-machine-1");
    expect(primary.switchProject).toHaveBeenCalledWith("alternate-machine-1");
    expect(manager.getSession("machine-2")?.state).toBe("live");
  });

  it("opens a project without a second catalog round-trip and converges on the push", async () => {
    const primary = new FakeSyncClient();
    const manager = new WebMachineSessionManager(primary.asClient(), accountClient);
    manager.replaceEnvironments([environment(1)]);
    await manager.connectEnvironment("machine-1");
    const catalogCallsAfterConnect = primary.getProjectCatalog.mock.calls.length;

    const result = await manager.openProject("machine-1", "alternate-machine-1");

    // The switch result is authoritative for the project we asked for, so the
    // activation path must not wait on another catalog fetch.
    expect(primary.getProjectCatalog).toHaveBeenCalledTimes(catalogCallsAfterConnect);
    expect(result.project.id).toBe("alternate-machine-1");
    expect(manager.getSession("machine-1")?.activeProjectId).toBe("alternate-machine-1");
    // One machine hosts one open project.
    expect(
      manager.getCatalog("machine-1").filter((entry) => entry.isOpen).map((entry) => entry.id),
    ).toEqual(["alternate-machine-1"]);

    primary.emitProjectCatalog([
      { id: "alternate-machine-1", displayName: "Renamed by the host" },
    ]);

    expect(manager.getCatalog("machine-1").map((entry) => entry.displayName)).toEqual([
      "Renamed by the host",
    ]);
  });

  it("rejects a fifth concurrent admission instead of exceeding the pool", async () => {
    const clients = Array.from(
      { length: WEB_MACHINE_SESSION_LIMIT + 1 },
      () => new FakeSyncClient(),
    );
    const releases: Array<() => void> = [];
    for (const client of clients.slice(0, WEB_MACHINE_SESSION_LIMIT)) {
      client.connect.mockImplementation(async (envId: string) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        client.status = {
          ...idleStatus(),
          state: "connected",
          readiness: "ready",
          selectedEnvId: envId,
          envId,
          activeProjectId: `project-${envId}`,
        };
      });
    }
    let nextClient = 1;
    const manager = new WebMachineSessionManager(
      clients[0].asClient(),
      accountClient,
      () => clients[nextClient++].asClient(),
    );
    manager.replaceEnvironments(clients.map((_, index) => environment(index + 1)));

    const attempts = clients.map((_, index) => manager.connectEnvironment(`machine-${index + 1}`));
    await expect(attempts[WEB_MACHINE_SESSION_LIMIT]).rejects.toThrow(
      "All four machine sessions are currently active",
    );
    for (const release of releases) release();
    await Promise.all(attempts.slice(0, WEB_MACHINE_SESSION_LIMIT));

    expect(manager.getSnapshot().sessions.filter(
      (session) => session.state === "live",
    )).toHaveLength(WEB_MACHINE_SESSION_LIMIT);
    expect(clients[WEB_MACHINE_SESSION_LIMIT].connect).not.toHaveBeenCalled();
  });

  it("points the destructive host repair at the active machine, not the newest client", async () => {
    const primary = new FakeSyncClient();
    const secondary = new FakeSyncClient();
    const manager = new WebMachineSessionManager(
      primary.asClient(),
      accountClient,
      () => secondary.asClient(),
    );
    manager.replaceEnvironments([environment(1), environment(2)]);
    await manager.connectEnvironment("machine-1");
    await manager.connectEnvironment("machine-2");

    // Machine 2 connected last, so the store must now answer for it — and the
    // parked-but-still-live machine 1 must not be able to write to the screen.
    applyProjectHostHello(conflictSnapshot, primary.asClient());
    applyProjectHostHello(conflictSnapshot, secondary.asClient());
    await recoverProjectHost();
    expect(secondary.sendCommand).toHaveBeenCalledWith("sync.recoverHost", {}, { projectId: null });
    expect(primary.sendCommand).not.toHaveBeenCalled();

    // Switching back re-aims it.
    await manager.connectEnvironment("machine-1");
    applyProjectHostHello(conflictSnapshot, primary.asClient());
    await recoverProjectHost();
    expect(primary.sendCommand).toHaveBeenCalledWith("sync.recoverHost", {}, { projectId: null });
    expect(secondary.sendCommand).toHaveBeenCalledTimes(1);
  });

  it("disarms the host repair when the active session is parked", async () => {
    const primary = new FakeSyncClient();
    const manager = new WebMachineSessionManager(primary.asClient(), accountClient);
    manager.replaceEnvironments([environment(1)]);
    await manager.connectEnvironment("machine-1");
    applyProjectHostHello(conflictSnapshot, primary.asClient());

    await manager.park("machine-1");

    await recoverProjectHost();
    expect(primary.sendCommand).not.toHaveBeenCalled();
  });

  it("removes stale browser trust after terminal authentication failure", async () => {
    const client = new FakeSyncClient();
    const manager = new WebMachineSessionManager(client.asClient(), accountClient);
    manager.replaceEnvironments([environment(1)]);
    await manager.connectEnvironment("machine-1");

    client.failAuthentication();

    await vi.waitFor(() => {
      expect(client.removeEnvironment).toHaveBeenCalledWith("machine-1");
      expect(manager.getSession("machine-1")).toBeNull();
    });
  });
});
