import { describe, expect, it, vi } from "vitest";
import type {
  RemoteRuntimeConnectResult,
  RemoteRuntimeTarget,
} from "../../../shared/types/remoteRuntime";
import type { RemoteConnectionPool } from "./remoteConnectionPool";
import { RemoteConnectionService } from "./remoteConnectionService";
import type { RemoteTargetRegistry } from "./remoteTargetRegistry";

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

  it("does not spend the reconnect budget on ordinary remote action errors", async () => {
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
      callActionForTarget: vi.fn(async () => {
        throw new Error("Action 'pr.listQueueStates' is not callable.");
      }),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(
        service.callAction(previouslyConnected.id, "project-1", {
          domain: "pr",
          action: "listQueueStates",
        }),
      ).rejects.toThrow(/not callable/i);
    }

    await expect(
      service.callAction(previouslyConnected.id, "project-1", {
        domain: "pr",
        action: "listQueueStates",
      }),
    ).rejects.toThrow(/not callable/i);
    expect(pool.callActionForTarget).toHaveBeenCalledTimes(11);
    expect(service.snapshot().connections[0]?.lastError).toMatch(
      /not callable/i,
    );
  });
});
