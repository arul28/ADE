import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RemoteRuntimeConnectResult,
  RemoteRuntimeTarget,
} from "../../../shared/types/remoteRuntime";
import { RemoteRuntimeConnectError } from "../../../shared/types/remoteRuntime";
import type { RemoteConnectionPool } from "./remoteConnectionPool";
import { RemoteConnectionService } from "./remoteConnectionService";
import type { RemoteTargetRegistry } from "./remoteTargetRegistry";
import { PairedRuntimeSshTrustRequiredError } from "./pairedRuntimeErrors";

const getSshHostKeyTrustForTargetMock = vi.hoisted(() => vi.fn());
const trustSshHostKeyForTargetMock = vi.hoisted(() => vi.fn());

vi.mock("./sshTransport", () => ({
  getSshHostKeyTrustForTarget: getSshHostKeyTrustForTargetMock,
  trustSshHostKeyForTarget: trustSshHostKeyForTargetMock,
}));

function target(
  id: string,
  lastConnectedAt: number | null,
): RemoteRuntimeTarget {
  return {
    id,
    name: id,
    hostname: `${id}.example.test`,
    sshUser: "ade",
    port: 22,
    sshKeyPath: null,
    lastSeenArch: null,
    runtimeBinaryVersion: null,
    lastConnectedAt,
  };
}

function connectResult(
  target: RemoteRuntimeTarget,
): RemoteRuntimeConnectResult {
  return {
    target,
    arch: "darwin-arm64",
    version: "1.0.0",
    projects: [],
    capabilities: {
      projects: true,
      machineProjects: {
        browseDirectories: true,
        getDetail: true,
        getWorkSummary: true,
        getDefaultParentDir: true,
        create: true,
        clone: true,
        listMyGitHubRepos: true,
      },
    },
  };
}

describe("RemoteConnectionService", () => {
  beforeEach(() => {
    getSshHostKeyTrustForTargetMock.mockReset();
    trustSshHostKeyForTargetMock.mockReset();
  });

  it("upgrades a discovered ADE sync machine to a paired-first target", () => {
    const savedCredentials = {
      version: 1 as const,
      hostIdentity: {
        deviceId: "host-1",
        siteId: "site-1",
        name: "Studio",
        platform: "macOS" as const,
        deviceType: "desktop" as const,
      },
      deviceId: "desktop-1",
      siteId: "desktop-site-1",
      deviceName: "Laptop",
      secret: "secret",
      dpopPrivateKey: "private",
      dpopPublicKey: "public",
      endpoints: ["wss://relay.example/connect/machine-1"],
      machineKey: "machine-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const registry = {
      list: vi.fn(() => []),
      get: vi.fn(() => null),
      save: vi.fn((input) => ({
        id: "paired-target-1",
        ...input,
        sshUser: input.sshUser ?? null,
        port: input.port ?? null,
        sshKeyPath: input.sshKeyPath ?? null,
        lastSeenArch: null,
        runtimeBinaryVersion: null,
        lastConnectedAt: null,
      })),
    } as unknown as RemoteTargetRegistry;
    const pool = {
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;
    const pairedStore = {
      get: vi.fn(() => savedCredentials),
      save: vi.fn((value) => value),
    };
    const service = new RemoteConnectionService(
      registry,
      pool,
      {},
      pairedStore as any,
    );

    const target = service.saveTarget({
      name: "Studio",
      hostname: "studio.example.ts.net",
      sshUser: null,
      port: null,
      sshKeyPath: null,
      routes: [],
    }, {
      id: "host-1::service",
      serviceName: "ADE Sync Studio",
      machineName: "Studio",
      hostIdentity: "host-1",
      hostName: "studio.local",
      port: 8787,
      addresses: ["192.168.1.20", "100.70.0.2"],
      primaryRoute: "192.168.1.20",
      tailscaleAddress: "100.70.0.2",
      runtimeKind: "brain",
      runtimeVersion: "1.0.0",
      connectable: true,
      projectIds: [],
      projectCount: 0,
      lastSeenAt: 1,
    });

    expect(target).toMatchObject({
      transport: "paired",
      pairedMachine: {
        hostIdentity: "host-1",
        machineKey: "machine-1",
      },
    });
    expect(pairedStore.save).toHaveBeenCalledWith(expect.objectContaining({
      endpoints: [
        "ws://192.168.1.20:8787/",
        "ws://100.70.0.2:8787/",
        "ws://studio.local:8787/",
        "wss://relay.example/connect/machine-1",
      ],
    }));
  });

  it("stores structured connect errors with bounded detail and legacy text", async () => {
    const remote = target("disk-full", null);
    const registry = {
      list: vi.fn(() => [remote]),
      get: vi.fn((id: string) => id === remote.id ? remote : null),
    } as unknown as RemoteTargetRegistry;
    const error = new RemoteRuntimeConnectError({
      kind: "disk_full",
      message: "The remote machine is out of disk space. Free up space and try again.",
      detail: `tar: No space left on device\n${"x".repeat(6_000)}TAIL`,
      freeBytes: 1024,
      requiredBytes: 2048,
    });
    const pool = {
      connect: vi.fn(async () => {
        throw error;
      }),
      disconnect: vi.fn(),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool);
    await expect(service.connect(remote.id, { explicit: true })).rejects.toBe(error);

    const status = service.snapshot().connections[0]!;
    expect(status.lastError).toBe(error.message);
    expect(status.lastErrorInfo).toMatchObject({
      kind: "disk_full",
      message: error.message,
      freeBytes: 1024,
      requiredBytes: 2048,
    });
    expect(status.lastErrorInfo?.detail?.length).toBeLessThanOrEqual(4_000);
    expect(status.lastErrorInfo?.detail).toContain("truncated");
    expect(status.lastErrorInfo?.detail).toContain("TAIL");
  });

  it("publishes the transport route and connect latency in connection status", async () => {
    const remote = target("route-status", null);
    const registry = {
      list: vi.fn(() => [remote]),
      get: vi.fn((id: string) => id === remote.id ? remote : null),
    } as unknown as RemoteTargetRegistry;
    const pool = {
      connect: vi.fn(async () => ({
        ...connectResult(remote),
        route: {
          kind: "tailnet" as const,
          endpoint: "ws://100.70.0.2:8787/",
          latencyMs: 12,
        },
      })),
      disconnect: vi.fn(),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool);
    await service.connect(remote.id, { explicit: true });

    expect(service.snapshot().connections[0]?.route).toEqual({
      kind: "tailnet",
      endpoint: "ws://100.70.0.2:8787/",
      latencyMs: 12,
    });
  });

  it("caps legacy connection error text at 500 characters", async () => {
    const remote = target("verbose-error", null);
    const registry = {
      list: vi.fn(() => [remote]),
      get: vi.fn((id: string) => id === remote.id ? remote : null),
    } as unknown as RemoteTargetRegistry;
    const pool = {
      connect: vi.fn(async () => {
        throw new Error("x".repeat(1_000));
      }),
      disconnect: vi.fn(),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool);
    await expect(service.connect(remote.id, { explicit: true })).rejects.toThrow();
    expect(service.snapshot().connections[0]?.lastError?.length).toBe(500);
  });

  it("exposes paired fallback SSH trust only after connect fails and clears it after trust", async () => {
    const remote: RemoteRuntimeTarget = {
      ...target("paired-trust", null),
      transport: "paired",
      pairedMachine: { hostIdentity: "host-1", machineKey: "machine-1" },
      routes: [{
        hostname: "studio.local",
        port: 22,
        source: "bonjour",
        lastSucceededAt: null,
      }],
    };
    const trustStatus = {
      state: "needs_trust" as const,
      targetId: remote.id,
      host: "studio.local",
      port: 22,
      route: remote.routes![0]!,
      keyType: "ssh-ed25519",
      fingerprintSha256: "SHA256:paired-fallback",
      knownHostsPath: "/home/test/.ssh/known_hosts",
    };
    const registry = {
      list: vi.fn(() => [remote]),
      get: vi.fn((id: string) => id === remote.id ? remote : null),
    } as unknown as RemoteTargetRegistry;
    const pool = {
      connect: vi.fn(async () => {
        throw new PairedRuntimeSshTrustRequiredError(trustStatus);
      }),
      disconnect: vi.fn(),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;
    const credentials = { hostIdentity: { deviceId: "host-1" } };
    const pairedStore = {
      get: vi.fn(() => credentials),
      getForReference: vi.fn(() => credentials),
    };
    trustSshHostKeyForTargetMock.mockResolvedValue({
      trusted: true,
      identity: trustStatus,
    });
    const service = new RemoteConnectionService(registry, pool, {}, pairedStore as any);

    await expect(service.getSshHostKeyTrust(remote.id)).resolves.toEqual({ state: "trusted" });
    expect(getSshHostKeyTrustForTargetMock).not.toHaveBeenCalled();

    await expect(service.connect(remote.id, { explicit: true })).rejects.toBeInstanceOf(
      PairedRuntimeSshTrustRequiredError,
    );
    await expect(service.getSshHostKeyTrust(remote.id)).resolves.toEqual(trustStatus);

    await service.trustSshHostKey(remote.id, trustStatus.fingerprintSha256);
    expect(trustSshHostKeyForTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "studio.local",
        routes: [trustStatus.route],
      }),
      trustStatus.fingerprintSha256,
    );
    await expect(service.getSshHostKeyTrust(remote.id)).resolves.toEqual({ state: "trusted" });
  });

  it("forgets paired credentials when removing a paired target", () => {
    const remote: RemoteRuntimeTarget = {
      ...target("paired-remove", null),
      transport: "paired",
      pairedMachine: { hostIdentity: "host-1", machineKey: "machine-1" },
    };
    const credentials = { hostIdentity: { deviceId: "host-1" } };
    const registry = {
      list: vi.fn(() => []),
      get: vi.fn((id: string) => id === remote.id ? remote : null),
      remove: vi.fn(() => true),
    } as unknown as RemoteTargetRegistry;
    const pool = {
      disconnect: vi.fn(),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;
    const pairedStore = {
      getForReference: vi.fn(() => credentials),
      remove: vi.fn(() => true),
    };
    const service = new RemoteConnectionService(registry, pool, {}, pairedStore as any);

    expect(service.removeTarget(remote.id)).toBe(true);
    expect(pairedStore.getForReference).toHaveBeenCalledWith(remote.pairedMachine);
    expect(pairedStore.remove).toHaveBeenCalledWith("host-1");
  });

  it("only autoconnects targets that have connected successfully before", async () => {
    const neverConnected = target("never-connected", null);
    const previouslyConnected = target("previously-connected", 1_700_000_000);
    const registry = {
      list: vi.fn(() => [neverConnected, previouslyConnected]),
      get: vi.fn((id: string) =>
        id === neverConnected.id
          ? neverConnected
          : id === previouslyConnected.id
            ? previouslyConnected
            : null,
      ),
    } as unknown as RemoteTargetRegistry;
    const pool = {
      connect: vi.fn(async (target: RemoteRuntimeTarget) =>
        connectResult(target),
      ),
      disconnect: vi.fn(),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool);
    service.startAutoconnect();
    await Promise.resolve();
    service.stopAutoconnect();

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.connect).toHaveBeenCalledWith(previouslyConnected);
  });

  it("does not autoconnect a manually disconnected saved target", async () => {
    const previouslyConnected = target("previously-connected", 1_700_000_000);
    const registry = {
      list: vi.fn(() => [previouslyConnected]),
      get: vi.fn((id: string) =>
        id === previouslyConnected.id ? previouslyConnected : null,
      ),
      update: vi.fn((_id: string, patch: Partial<RemoteRuntimeTarget>) => ({
        ...previouslyConnected,
        ...patch,
      })),
    } as unknown as RemoteTargetRegistry;
    const pool = {
      connect: vi.fn(async (target: RemoteRuntimeTarget) =>
        connectResult(target),
      ),
      disconnect: vi.fn(),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool);
    service.disconnect(previouslyConnected.id, { manual: true });
    service.startAutoconnect();
    await Promise.resolve();
    service.stopAutoconnect();

    expect(pool.disconnect).toHaveBeenCalledWith(previouslyConnected.id);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("disconnects the pool even when persisting the manual marker fails", () => {
    const previouslyConnected = target("previously-connected", 1_700_000_000);
    const registry = {
      list: vi.fn(() => [previouslyConnected]),
      get: vi.fn((id: string) =>
        id === previouslyConnected.id ? previouslyConnected : null,
      ),
      update: vi.fn(() => {
        throw new Error("disk full");
      }),
    } as unknown as RemoteTargetRegistry;
    const pool = {
      disconnect: vi.fn(),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool);

    expect(() => service.disconnect(previouslyConnected.id, { manual: true }))
      .toThrow(/disk full/i);
    expect(pool.disconnect).toHaveBeenCalledWith(previouslyConnected.id);
    expect(service.snapshot().connections[0]).toMatchObject({
      target: { id: previouslyConnected.id },
      state: "idle",
      lastError: null,
    });
  });

  it("blocks implicit RPC reconnect after manual disconnect until explicit connect", async () => {
    const previouslyConnected = target("previously-connected", 1_700_000_000);
    const registry = {
      list: vi.fn(() => [previouslyConnected]),
      get: vi.fn((id: string) =>
        id === previouslyConnected.id ? previouslyConnected : null,
      ),
      update: vi.fn((_id: string, patch: Partial<RemoteRuntimeTarget>) => ({
        ...previouslyConnected,
        ...patch,
      })),
    } as unknown as RemoteTargetRegistry;
    const actionResult = {
      domain: "file",
      action: "read",
      result: { ok: true },
      statusHints: {},
    };
    const pool = {
      connect: vi.fn(async (target: RemoteRuntimeTarget) =>
        connectResult(target),
      ),
      disconnect: vi.fn(),
      callActionForTarget: vi.fn(async () => actionResult),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool);
    service.disconnect(previouslyConnected.id, { manual: true });

    await expect(
      service.callAction(previouslyConnected.id, "project-1", {
        domain: "file",
        action: "read",
      }),
    ).rejects.toThrow(/manually disconnected/i);
    expect(pool.callActionForTarget).not.toHaveBeenCalled();

    await service.connect(previouslyConnected.id, { explicit: true });
    await expect(
      service.callAction(previouslyConnected.id, "project-1", {
        domain: "file",
        action: "read",
      }),
    ).resolves.toEqual(actionResult);

    expect(pool.connect).toHaveBeenCalledWith(previouslyConnected, {
      bypassFailureBackoff: true,
    });
    expect(pool.callActionForTarget).toHaveBeenCalledTimes(1);
  });

  it("does not publish connected after a manual disconnect during pending connect", async () => {
    const previouslyConnected = target("previously-connected", 1_700_000_000);
    const registry = {
      list: vi.fn(() => [previouslyConnected]),
      get: vi.fn((id: string) =>
        id === previouslyConnected.id ? previouslyConnected : null,
      ),
      update: vi.fn((_id: string, patch: Partial<RemoteRuntimeTarget>) => ({
        ...previouslyConnected,
        ...patch,
      })),
    } as unknown as RemoteTargetRegistry;
    let resolveConnect!: (result: RemoteRuntimeConnectResult) => void;
    const pool = {
      connect: vi.fn(
        () =>
          new Promise<RemoteRuntimeConnectResult>((resolve) => {
            resolveConnect = resolve;
          }),
      ),
      disconnect: vi.fn(),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool);
    const pendingConnect = service.connect(previouslyConnected.id, {
      explicit: true,
    });
    await Promise.resolve();
    expect(service.snapshot().connections[0]?.state).toBe("connecting");

    service.disconnect(previouslyConnected.id, { manual: true });
    resolveConnect(connectResult(previouslyConnected));

    await expect(pendingConnect).rejects.toThrow(
      /disconnected before ADE finished connecting/i,
    );
    expect(service.snapshot().connections[0]).toMatchObject({
      state: "idle",
      lastError: null,
    });
    expect(service.snapshot().connectedCount).toBe(0);
    expect(pool.disconnect).toHaveBeenCalledWith(previouslyConnected.id);
  });

  it("does not autoconnect a persisted manually disconnected target after restart", async () => {
    let persistedTarget: RemoteRuntimeTarget = {
      ...target("previously-connected", 1_700_000_000),
      manuallyDisconnectedAt: 1_700_000_100,
    };
    const registry = {
      list: vi.fn(() => [persistedTarget]),
      get: vi.fn((id: string) =>
        id === persistedTarget.id ? persistedTarget : null,
      ),
      update: vi.fn((_id: string, patch: Partial<RemoteRuntimeTarget>) => {
        persistedTarget = { ...persistedTarget, ...patch };
        return persistedTarget;
      }),
    } as unknown as RemoteTargetRegistry;
    const pool = {
      connect: vi.fn(async (target: RemoteRuntimeTarget) =>
        connectResult(target),
      ),
      disconnect: vi.fn(),
      callActionForTarget: vi.fn(),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool);
    service.startAutoconnect();
    await Promise.resolve();
    service.stopAutoconnect();

    expect(pool.connect).not.toHaveBeenCalled();
    await expect(
      service.callAction(persistedTarget.id, "project-1", {
        domain: "file",
        action: "read",
      }),
    ).rejects.toThrow(/manually disconnected/i);

    await expect(
      service.connect(persistedTarget.id, { explicit: true }),
    ).resolves.toMatchObject({ target: { manuallyDisconnectedAt: null } });
    expect(registry.update).toHaveBeenCalledWith(persistedTarget.id, {
      manuallyDisconnectedAt: null,
    });
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });

  it("keeps the persisted manual disconnect marker when explicit reconnect fails", async () => {
    let persistedTarget: RemoteRuntimeTarget = {
      ...target("previously-connected", 1_700_000_000),
      manuallyDisconnectedAt: 1_700_000_100,
    };
    const registry = {
      list: vi.fn(() => [persistedTarget]),
      get: vi.fn((id: string) =>
        id === persistedTarget.id ? persistedTarget : null,
      ),
      update: vi.fn((_id: string, patch: Partial<RemoteRuntimeTarget>) => {
        persistedTarget = { ...persistedTarget, ...patch };
        return persistedTarget;
      }),
    } as unknown as RemoteTargetRegistry;
    const pool = {
      connect: vi.fn(async () => {
        throw new Error("Remote ADE service connection failed.");
      }),
      disconnect: vi.fn(),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool);

    await expect(
      service.connect(persistedTarget.id, { explicit: true }),
    ).rejects.toThrow(/connection failed/i);

    expect(persistedTarget.manuallyDisconnectedAt).toBe(1_700_000_100);
    expect(registry.update).not.toHaveBeenCalledWith(persistedTarget.id, {
      manuallyDisconnectedAt: null,
    });
    service.startAutoconnect();
    await Promise.resolve();
    service.stopAutoconnect();
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });

  it("allows overlapping connect callers to share a successful pending connection", async () => {
    const previouslyConnected = target("previously-connected", 1_700_000_000);
    const registry = {
      list: vi.fn(() => [previouslyConnected]),
      get: vi.fn((id: string) =>
        id === previouslyConnected.id ? previouslyConnected : null,
      ),
    } as unknown as RemoteTargetRegistry;
    let resolveConnect!: (result: RemoteRuntimeConnectResult) => void;
    const connectPromise = new Promise<RemoteRuntimeConnectResult>((resolve) => {
      resolveConnect = resolve;
    });
    const pool = {
      connect: vi.fn(() => connectPromise),
      disconnect: vi.fn(),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool);
    const implicitConnect = service.connect(previouslyConnected.id);
    const explicitConnect = service.connect(previouslyConnected.id, {
      explicit: true,
    });
    await Promise.resolve();
    resolveConnect(connectResult(previouslyConnected));

    await expect(
      Promise.all([implicitConnect, explicitConnect]),
    ).resolves.toHaveLength(2);
    expect(service.snapshot().connections[0]).toMatchObject({
      state: "connected",
      lastError: null,
    });
    expect(service.snapshot().connectedCount).toBe(1);
  });

  it("pauses automatic reconnect after repeated implicit connection failures", async () => {
    const previouslyConnected = target("previously-connected", 1_700_000_000);
    const registry = {
      list: vi.fn(() => [previouslyConnected]),
      get: vi.fn((id: string) =>
        id === previouslyConnected.id ? previouslyConnected : null,
      ),
    } as unknown as RemoteTargetRegistry;
    let failConnect = true;
    const pool = {
      connect: vi.fn(async (target: RemoteRuntimeTarget) => {
        if (failConnect) {
          throw new Error("Remote ADE service connection failed.");
        }
        return connectResult(target);
      }),
      disconnect: vi.fn(),
      callActionForTarget: vi.fn(),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(service.connect(previouslyConnected.id)).rejects.toThrow(
        /connection failed/i,
      );
    }

    expect(pool.connect).toHaveBeenCalledTimes(10);
    expect(service.snapshot().connections[0]?.lastError).toMatch(
      /stopped automatic reconnecting after 10 failed attempts/i,
    );

    await expect(service.connect(previouslyConnected.id)).rejects.toThrow(
      /stopped automatic reconnecting/i,
    );
    await expect(
      service.callAction(previouslyConnected.id, "project-1", {
        domain: "file",
        action: "read",
      }),
    ).rejects.toThrow(/stopped automatic reconnecting/i);
    expect(pool.connect).toHaveBeenCalledTimes(10);
    expect(pool.callActionForTarget).not.toHaveBeenCalled();

    failConnect = false;
    await expect(
      service.connect(previouslyConnected.id, { explicit: true }),
    ).resolves.toMatchObject({ target: previouslyConnected });
    expect(pool.connect).toHaveBeenCalledTimes(11);
    expect(service.snapshot().connections[0]?.lastError).toBeNull();
  });

  it("does not spend the reconnect budget on pool backoff throttle errors", async () => {
    const previouslyConnected = target("previously-connected", 1_700_000_000);
    const registry = {
      list: vi.fn(() => [previouslyConnected]),
      get: vi.fn((id: string) =>
        id === previouslyConnected.id ? previouslyConnected : null,
      ),
    } as unknown as RemoteTargetRegistry;
    const pool = {
      connect: vi.fn(async () => {
        throw new Error(
          "Remote ADE service connection failed recently (ssh reset). Retrying in 3s.",
        );
      }),
      disconnect: vi.fn(),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(service.connect(previouslyConnected.id)).rejects.toThrow(
        /Retrying in 3s/i,
      );
    }

    expect(service.snapshot().connections[0]?.lastError).toMatch(
      /Retrying in 3s/i,
    );
    await expect(service.connect(previouslyConnected.id)).rejects.toThrow(
      /Retrying in 3s/i,
    );
    expect(pool.connect).toHaveBeenCalledTimes(11);
  });

  it("spends the reconnect budget on normalized SSH handshake failures", async () => {
    const previouslyConnected = target("previously-connected", 1_700_000_000);
    const registry = {
      list: vi.fn(() => [previouslyConnected]),
      get: vi.fn((id: string) =>
        id === previouslyConnected.id ? previouslyConnected : null,
      ),
    } as unknown as RemoteTargetRegistry;
    const pool = {
      connect: vi.fn(async () => {
        throw new Error(
          "SSH server at studio.local:22 closed the connection before ADE could finish the SSH handshake.",
        );
      }),
      disconnect: vi.fn(),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(service.connect(previouslyConnected.id)).rejects.toThrow(
        /SSH handshake/i,
      );
    }

    expect(service.snapshot().connections[0]?.lastError).toMatch(
      /stopped automatic reconnecting after 10 failed attempts/i,
    );
    await expect(service.connect(previouslyConnected.id)).rejects.toThrow(
      /stopped automatic reconnecting/i,
    );
    expect(pool.connect).toHaveBeenCalledTimes(10);
  });

  it("keeps the connection healthy and spends no budget on ordinary remote action errors", async () => {
    const previouslyConnected = target("previously-connected", 1_700_000_000);
    const registry = {
      list: vi.fn(() => [previouslyConnected]),
      get: vi.fn((id: string) =>
        id === previouslyConnected.id ? previouslyConnected : null,
      ),
    } as unknown as RemoteTargetRegistry;
    let succeed = true;
    const pool = {
      connect: vi.fn(async (target: RemoteRuntimeTarget) =>
        connectResult(target),
      ),
      disconnect: vi.fn(),
      callActionForTarget: vi.fn(async () => {
        if (succeed) {
          return { domain: "file", action: "read", result: { ok: true }, statusHints: {} };
        }
        throw new Error("Action 'pr.listQueueStates' is not callable.");
      }),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool);
    // Establish a healthy connection via a successful call.
    await service.callAction(previouslyConnected.id, "project-1", {
      domain: "file",
      action: "read",
    });
    expect(service.snapshot().connections[0]?.state).toBe("connected");

    succeed = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(
        service.callAction(previouslyConnected.id, "project-1", {
          domain: "pr",
          action: "listQueueStates",
        }),
      ).rejects.toThrow(/not callable/i);
    }

    // An application-level error came back over a live channel — the host is
    // reachable, so the connection must stay connected (no "unreachable" toast,
    // no reconnect loop) and the auto-reconnect budget is untouched.
    expect(pool.callActionForTarget).toHaveBeenCalledTimes(11);
    expect(service.snapshot().connections[0]?.state).toBe("connected");
    expect(service.snapshot().connections[0]?.lastError).toBeNull();
  });

  it("keeps the connection healthy when one remote request times out", async () => {
    const previouslyConnected = target("previously-connected", 1_700_000_000);
    const registry = {
      list: vi.fn(() => [previouslyConnected]),
      get: vi.fn((id: string) =>
        id === previouslyConnected.id ? previouslyConnected : null,
      ),
    } as unknown as RemoteTargetRegistry;
    let succeed = true;
    const pool = {
      connect: vi.fn(async (target: RemoteRuntimeTarget) =>
        connectResult(target),
      ),
      disconnect: vi.fn(),
      callActionForTarget: vi.fn(async () => {
        if (succeed) {
          return { domain: "file", action: "read", result: { ok: true }, statusHints: {} };
        }
        throw new Error(
          "Remote ADE service timed out waiting for method ade/actions/call (25000ms).",
        );
      }),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool);
    await service.callAction(previouslyConnected.id, "project-1", {
      domain: "file",
      action: "read",
    });

    succeed = false;
    await expect(
      service.callAction(previouslyConnected.id, "project-1", {
        domain: "file",
        action: "read",
      }),
    ).rejects.toThrow(/timed out waiting for method ade\/actions\/call/i);

    expect(service.snapshot().connections[0]?.state).toBe("connected");
    expect(service.snapshot().connections[0]?.lastError).toBeNull();
  });

  it("does not disconnect a healthy client when a resume probe request times out", async () => {
    const previouslyConnected = target("previously-connected", 1_700_000_000);
    const registry = {
      list: vi.fn(() => [previouslyConnected]),
      get: vi.fn((id: string) =>
        id === previouslyConnected.id ? previouslyConnected : null,
      ),
    } as unknown as RemoteTargetRegistry;
    const pool = {
      connect: vi.fn(async (target: RemoteRuntimeTarget) =>
        connectResult(target),
      ),
      disconnect: vi.fn(),
      callMachineForTarget: vi.fn(async () => {
        throw new Error(
          "Remote ADE service timed out waiting for method ping (5000ms).",
        );
      }),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool, {
      pingTimeoutMs: 5_000,
    });
    await service.connect(previouslyConnected.id, { explicit: true });

    service.probeSavedConnections();
    await vi.waitFor(() => {
      expect(pool.callMachineForTarget).toHaveBeenCalledWith(
        previouslyConnected,
        "ping",
        {},
        { timeoutMs: 5_000 },
      );
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(pool.disconnect).not.toHaveBeenCalled();
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(service.snapshot().connections[0]?.state).toBe("connected");
    expect(service.snapshot().connections[0]?.lastError).toBeNull();
  });

  it("does not flag the remote unreachable when adding a project fails with a host-side error", async () => {
    const previouslyConnected = target("previously-connected", 1_700_000_000);
    const registry = {
      list: vi.fn(() => [previouslyConnected]),
      get: vi.fn((id: string) =>
        id === previouslyConnected.id ? previouslyConnected : null,
      ),
    } as unknown as RemoteTargetRegistry;
    const pool = {
      connect: vi.fn(async (target: RemoteRuntimeTarget) =>
        connectResult(target),
      ),
      disconnect: vi.fn(),
      addProjectForTarget: vi.fn(async () => {
        throw new Error(
          "no such function: crsql_internal_sync_bit [sql=delete from process_definitions where project_id = ?]",
        );
      }),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool);
    await service.connect(previouslyConnected.id, { explicit: true });
    expect(service.snapshot().connections[0]?.state).toBe("connected");

    await expect(
      service.addProject(previouslyConnected.id, "/repo/versic"),
    ).rejects.toThrow(/crsql_internal_sync_bit/i);

    expect(service.snapshot().connections[0]?.state).toBe("connected");
    expect(service.snapshot().connections[0]?.lastError).toBeNull();
  });

  it("flips to error when a remote call fails with a transport-level error", async () => {
    const previouslyConnected = target("previously-connected", 1_700_000_000);
    const registry = {
      list: vi.fn(() => [previouslyConnected]),
      get: vi.fn((id: string) =>
        id === previouslyConnected.id ? previouslyConnected : null,
      ),
    } as unknown as RemoteTargetRegistry;
    let succeed = true;
    const pool = {
      connect: vi.fn(async (target: RemoteRuntimeTarget) =>
        connectResult(target),
      ),
      disconnect: vi.fn(),
      callActionForTarget: vi.fn(async () => {
        if (succeed) {
          return { domain: "file", action: "read", result: { ok: true }, statusHints: {} };
        }
        throw new Error("remote ADE service connection closed");
      }),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool);
    await service.callAction(previouslyConnected.id, "project-1", {
      domain: "file",
      action: "read",
    });

    succeed = false;
    await expect(
      service.callAction(previouslyConnected.id, "project-1", {
        domain: "file",
        action: "read",
      }),
    ).rejects.toThrow(/connection closed/i);
    expect(service.snapshot().connections[0]?.state).toBe("error");
    expect(service.snapshot().connections[0]?.lastError).toMatch(
      /connection closed/i,
    );
  });
});
