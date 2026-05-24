import type { Client } from "ssh2";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RemoteRuntimeConnectResult,
  RemoteRuntimeTarget,
} from "../../../shared/types/remoteRuntime";
import type { RuntimeRpcClient } from "./runtimeRpcClient";
import type { RemoteTargetRegistry } from "./remoteTargetRegistry";

const bootstrapRemoteRuntimeMock = vi.hoisted(() => vi.fn());
const ensureRemoteProjectMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/mock/app",
  },
}));

vi.mock("./remoteBootstrap", () => ({
  bootstrapRemoteRuntime: bootstrapRemoteRuntimeMock,
  ensureRemoteProject: ensureRemoteProjectMock,
}));

import { RemoteConnectionPool } from "./remoteConnectionPool";

type DisconnectListener = (error: Error) => void;

type FakeRuntimeRpcClient = RuntimeRpcClient & {
  call: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  emitDisconnect(error?: Error): void;
  emitNotification(method: string, params: unknown): void;
  onDisconnect: ReturnType<typeof vi.fn>;
  onNotification: ReturnType<typeof vi.fn>;
};

type SshListener = (...args: unknown[]) => void;

type FakeSshClient = Client & {
  emitOnce(event: "close" | "error", ...args: unknown[]): void;
  end: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
};

const target: RemoteRuntimeTarget = {
  id: "target-1",
  name: "Remote",
  hostname: "remote.example.test",
  sshUser: "ade",
  port: 22,
  sshKeyPath: null,
  lastSeenArch: null,
  runtimeBinaryVersion: null,
  lastConnectedAt: null,
};

function connectResult(version: string): RemoteRuntimeConnectResult {
  return {
    target,
    arch: "linux-x64",
    version,
    projects: [],
  };
}

function createClient(): FakeRuntimeRpcClient {
  const listeners = new Set<DisconnectListener>();
  const notificationListeners = new Map<
    string,
    Set<(params: unknown) => void>
  >();
  const client = {
    call: vi.fn(),
    close: vi.fn(() => {
      for (const listener of [...listeners]) {
        listener(new Error("closed"));
      }
    }),
    onDisconnect: vi.fn((callback: DisconnectListener) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    }),
    onNotification: vi.fn(
      (method: string, callback: (params: unknown) => void) => {
        const existing =
          notificationListeners.get(method) ??
          new Set<(params: unknown) => void>();
        existing.add(callback);
        notificationListeners.set(method, existing);
        return () => {
          existing.delete(callback);
          if (existing.size === 0) {
            notificationListeners.delete(method);
          }
        };
      },
    ),
    emitDisconnect(error = new Error("lost")) {
      for (const listener of [...listeners]) {
        listener(error);
      }
    },
    emitNotification(method: string, params: unknown) {
      for (const listener of [...(notificationListeners.get(method) ?? [])]) {
        listener(params);
      }
    },
  };
  return client as unknown as FakeRuntimeRpcClient;
}

function createSsh(): FakeSshClient {
  const listeners = new Map<string, SshListener[]>();
  const fake = {} as {
    emitOnce?: FakeSshClient["emitOnce"];
    end?: ReturnType<typeof vi.fn>;
    once?: ReturnType<typeof vi.fn>;
  };
  fake.end = vi.fn();
  fake.once = vi.fn((event: string, callback: SshListener): FakeSshClient => {
    const existing = listeners.get(event) ?? [];
    existing.push(callback);
    listeners.set(event, existing);
    return fake as unknown as FakeSshClient;
  });
  fake.emitOnce = (event: "close" | "error", ...args: unknown[]): void => {
    const callbacks = listeners.get(event) ?? [];
    listeners.delete(event);
    for (const callback of callbacks) {
      callback(...args);
    }
  };
  return fake as unknown as FakeSshClient;
}

describe("RemoteConnectionPool", () => {
  beforeEach(() => {
    bootstrapRemoteRuntimeMock.mockReset();
    ensureRemoteProjectMock.mockReset();
  });

  it("evicts cached entries after the RPC client disconnects", async () => {
    const firstClient = createClient();
    const firstSsh = createSsh();
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: firstSsh,
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");
    const onEvicted = vi.fn();
    pool.onEntryEvicted(onEvicted);

    await expect(pool.connect(target)).resolves.toMatchObject({
      version: "1.0.0",
    });
    firstClient.emitDisconnect(new Error("stream closed"));

    expect(firstSsh.end).toHaveBeenCalledTimes(1);
    expect(onEvicted).toHaveBeenCalledWith(target.id, expect.objectContaining({
      message: "stream closed",
    }));

    const secondClient = createClient();
    const secondSsh = createSsh();
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: secondClient,
      ssh: secondSsh,
      result: connectResult("1.0.1"),
    });

    await expect(pool.connect(target)).resolves.toMatchObject({
      version: "1.0.1",
    });
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
  });

  it("does not emit an eviction notification for intentional disconnects", async () => {
    const client = createClient();
    const ssh = createSsh();
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client,
      ssh,
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");
    const onEvicted = vi.fn();
    pool.onEntryEvicted(onEvicted);

    await pool.connect(target);
    pool.disconnect(target.id);
    await Promise.resolve();

    expect(client.close).toHaveBeenCalledTimes(1);
    expect(ssh.end).toHaveBeenCalledTimes(1);
    expect(onEvicted).not.toHaveBeenCalled();
  });

  it("evicts cached entries and closes the RPC client after SSH closes", async () => {
    const firstClient = createClient();
    const firstSsh = createSsh();
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: firstSsh,
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await pool.connect(target);
    firstSsh.emitOnce("close");

    expect(firstClient.close).toHaveBeenCalledTimes(1);
    expect(firstSsh.end).toHaveBeenCalledTimes(1);

    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: createClient(),
      ssh: createSsh(),
      result: connectResult("1.0.1"),
    });

    await expect(pool.connect(target)).resolves.toMatchObject({
      version: "1.0.1",
    });
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
  });

  it("connects before streaming events and reconnects after disconnect", async () => {
    const firstClient = createClient();
    firstClient.call.mockResolvedValueOnce({
      ok: true,
      events: [
        {
          id: 1,
          timestamp: "2026-05-10T00:00:00.000Z",
          category: "runtime",
          payload: {},
        },
      ],
      nextCursor: 2,
      hasMore: false,
    });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: createSsh(),
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await expect(
      pool.streamEventsForTarget(target, "project-1", { cursor: 1, limit: 10 }),
    ).resolves.toMatchObject({
      nextCursor: 2,
      events: [{ id: 1, category: "runtime" }],
    });
    expect(firstClient.call).toHaveBeenCalledWith("ade/actions/call", {
      projectId: "project-1",
      name: "stream_events",
      arguments: {
        cursor: 1,
        limit: 10,
      },
    });

    firstClient.emitDisconnect(new Error("lost"));

    const secondClient = createClient();
    secondClient.call.mockResolvedValueOnce({
      ok: true,
      events: [],
      nextCursor: 2,
      hasMore: false,
    });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: secondClient,
      ssh: createSsh(),
      result: connectResult("1.0.1"),
    });

    await expect(
      pool.streamEventsForTarget(target, "project-1", { cursor: 2 }),
    ).resolves.toMatchObject({
      nextCursor: 2,
      events: [],
    });
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
  });

  it("retries idempotent reads once when the connection closes during the request", async () => {
    const firstClient = createClient();
    const firstSsh = createSsh();
    firstClient.call.mockRejectedValueOnce(
      new Error("Remote runtime connection closed."),
    );
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: firstSsh,
      result: connectResult("1.0.0"),
    });
    const secondClient = createClient();
    secondClient.call.mockResolvedValueOnce([
      {
        projectId: "project-1",
        rootPath: "/srv/app",
        displayName: "app",
        addedAt: 1,
        lastOpenedAt: 2,
        gitOriginUrl: null,
      },
    ]);
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: secondClient,
      ssh: createSsh(),
      result: connectResult("1.0.1"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await expect(pool.projectsForTarget(target)).resolves.toEqual([
      {
        projectId: "project-1",
        rootPath: "/srv/app",
        displayName: "app",
        addedAt: 1,
        lastOpenedAt: 2,
        gitOriginUrl: null,
      },
    ]);

    expect(firstSsh.end).toHaveBeenCalledTimes(1);
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
    expect(firstClient.call).toHaveBeenCalledWith("projects.list", {});
    expect(secondClient.call).toHaveBeenCalledWith("projects.list", {});
  });

  it("does not replay non-idempotent machine calls after a connection interruption", async () => {
    const firstClient = createClient();
    firstClient.call.mockRejectedValueOnce(
      new Error("Remote ADE service connection closed."),
    );
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: createSsh(),
      result: connectResult("1.0.0"),
    });
    const secondClient = createClient();
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: secondClient,
      ssh: createSsh(),
      result: connectResult("1.0.1"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await expect(
      pool.callMachineForTarget(
        target,
        "projects.clone",
        { url: "https://github.com/acme/app", parentDir: "/srv" },
        { retryOnConnectionError: false },
      ),
    ).rejects.toThrow(/retry the action/i);

    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
    expect(firstClient.call).toHaveBeenCalledWith("projects.clone", {
      url: "https://github.com/acme/app",
      parentDir: "/srv",
    });
    expect(secondClient.call).not.toHaveBeenCalled();
  });

  it("reconnects after interrupted mutating actions and asks the caller to retry", async () => {
    const firstClient = createClient();
    firstClient.call.mockRejectedValueOnce(
      new Error("Remote runtime connection failed: channel closed"),
    );
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: createSsh(),
      result: connectResult("1.0.0"),
    });
    const secondClient = createClient();
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: secondClient,
      ssh: createSsh(),
      result: connectResult("1.0.1"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await expect(
      pool.callActionForTarget(target, "project-1", {
        domain: "lane",
        action: "create",
        args: { name: "work" },
      }),
    ).rejects.toThrow(/retry the action/i);

    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
    expect(firstClient.call).toHaveBeenCalledTimes(1);
    expect(firstClient.call).toHaveBeenCalledWith("ade/actions/call", {
      projectId: "project-1",
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "create",
        args: { name: "work" },
      },
    });
    expect(secondClient.call).not.toHaveBeenCalled();
  });

  it("retries read-only project actions once after reconnecting", async () => {
    const firstClient = createClient();
    const firstSsh = createSsh();
    firstClient.call.mockRejectedValueOnce(
      new Error("Remote runtime connection failed: stream closed"),
    );
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: firstSsh,
      result: connectResult("1.0.0"),
    });
    const secondClient = createClient();
    secondClient.call.mockResolvedValueOnce({
      ok: true,
      domain: "lane",
      action: "list",
      result: [{ id: "lane-main" }],
      statusHints: { reconnected: true },
    });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: secondClient,
      ssh: createSsh(),
      result: connectResult("1.0.1"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await expect(
      pool.callActionForTarget(target, "project-1", {
        domain: "lane",
        action: "list",
      }),
    ).resolves.toEqual({
      domain: "lane",
      action: "list",
      result: [{ id: "lane-main" }],
      statusHints: { reconnected: true },
    });

    expect(firstSsh.end).toHaveBeenCalledTimes(1);
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
    expect(firstClient.call).toHaveBeenCalledTimes(1);
    expect(firstClient.call).toHaveBeenCalledWith("ade/actions/call", {
      projectId: "project-1",
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "list",
      },
    });
    expect(secondClient.call).toHaveBeenCalledTimes(1);
    expect(secondClient.call).toHaveBeenCalledWith("ade/actions/call", {
      projectId: "project-1",
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "list",
      },
    });
  });

  it("lists remote ADE actions as grouped registry entries", async () => {
    const client = createClient();
    client.call.mockResolvedValueOnce({
      count: 3,
      actions: [
        {
          domain: "git",
          action: "push",
          name: "git.push",
          usage: "ade actions run git.push",
        },
        {
          domain: "chat",
          action: "codexOpenInCli",
          name: "chat.codexOpenInCli",
          usage: "ade actions run chat.codexOpenInCli",
        },
        {
          domain: "git",
          action: "status",
          name: "git.status",
          usage: "ade actions run git.status",
        },
      ],
    });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client,
      ssh: createSsh(),
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await expect(
      pool.listActionRegistryForTarget(target, "project-1"),
    ).resolves.toEqual([
      {
        domain: "chat",
        actions: [{ name: "codexOpenInCli" }],
      },
      {
        domain: "git",
        actions: [{ name: "push" }, { name: "status" }],
      },
    ]);

    expect(client.call).toHaveBeenCalledWith("ade/actions/call", {
      projectId: "project-1",
      name: "list_ade_actions",
      arguments: { domain: "all" },
    });
  });

  it("reconnects before running a target-scoped action after the cached SSH session drops", async () => {
    const firstClient = createClient();
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: createSsh(),
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await expect(pool.connect(target)).resolves.toMatchObject({
      version: "1.0.0",
    });
    firstClient.emitDisconnect(new Error("lost"));

    const secondClient = createClient();
    secondClient.call.mockResolvedValueOnce({
      ok: true,
      domain: "lane",
      action: "list",
      result: [{ id: "lane-main" }],
      statusHints: { reconnected: true },
    });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: secondClient,
      ssh: createSsh(),
      result: connectResult("1.0.1"),
    });

    await expect(
      pool.callActionForTarget(target, "project-1", {
        domain: "lane",
        action: "list",
      }),
    ).resolves.toEqual({
      domain: "lane",
      action: "list",
      result: [{ id: "lane-main" }],
      statusHints: { reconnected: true },
    });

    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
    expect(firstClient.call).not.toHaveBeenCalled();
    expect(secondClient.call).toHaveBeenCalledWith("ade/actions/call", {
      projectId: "project-1",
      name: "run_ade_action",
      arguments: {
        domain: "lane",
        action: "list",
      },
    });
  });

  it("calls project-scoped sync methods on the connected runtime", async () => {
    const client = createClient();
    client.call.mockResolvedValueOnce({
      pairingPin: "123456",
      connectedPeers: [],
    });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client,
      ssh: createSsh(),
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await expect(
      pool.callSyncForTarget(target, "project-1", "sync.getStatus", {
        includeTransferReadiness: true,
      }),
    ).resolves.toEqual({ pairingPin: "123456", connectedPeers: [] });

    expect(client.call).toHaveBeenCalledWith("sync.getStatus", {
      projectId: "project-1",
      includeTransferReadiness: true,
    });
  });

  it("retries project-scoped sync reads once when the connection closes during the request", async () => {
    const firstClient = createClient();
    const firstSsh = createSsh();
    firstClient.call.mockRejectedValueOnce(
      new Error("Remote ADE service connection closed."),
    );
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: firstClient,
      ssh: firstSsh,
      result: connectResult("1.0.0"),
    });
    const secondClient = createClient();
    secondClient.call.mockResolvedValueOnce({
      pairingPin: "654321",
      connectedPeers: [{ id: "phone-1" }],
    });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client: secondClient,
      ssh: createSsh(),
      result: connectResult("1.0.1"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");

    await expect(
      pool.callSyncForTarget(target, "project-1", "sync.getStatus", {
        includeTransferReadiness: true,
      }),
    ).resolves.toEqual({
      pairingPin: "654321",
      connectedPeers: [{ id: "phone-1" }],
    });

    expect(firstSsh.end).toHaveBeenCalledTimes(1);
    expect(bootstrapRemoteRuntimeMock).toHaveBeenCalledTimes(2);
    expect(firstClient.call).toHaveBeenCalledWith("sync.getStatus", {
      projectId: "project-1",
      includeTransferReadiness: true,
    });
    expect(secondClient.call).toHaveBeenCalledWith("sync.getStatus", {
      projectId: "project-1",
      includeTransferReadiness: true,
    });
  });

  it("subscribes to runtime event notifications and unsubscribes on cleanup", async () => {
    const client = createClient();
    client.call.mockImplementation(async (method: string) => {
      if (method === "runtimeEvents.subscribe") {
        client.emitNotification("runtime/event", {
          subscriptionId: "runtime-events-7",
          projectId: "project-1",
          event: {
            id: 12,
            timestamp: "2026-05-10T12:00:00.000Z",
            category: "pty",
            payload: { type: "pty_data" },
          },
        });
        client.emitNotification("runtime/event", {
          subscriptionId: "runtime-events-8",
          projectId: "project-1",
          event: {
            id: 13,
            timestamp: "2026-05-10T12:00:01.000Z",
            category: "runtime",
            payload: { type: "other_subscription" },
          },
        });
        return {
          subscriptionId: "runtime-events-7",
          nextCursor: 13,
          hasMore: false,
        };
      }
      if (method === "runtimeEvents.unsubscribe") {
        return { removed: true };
      }
      return null;
    });
    bootstrapRemoteRuntimeMock.mockResolvedValueOnce({
      client,
      ssh: createSsh(),
      result: connectResult("1.0.0"),
    });
    const pool = new RemoteConnectionPool({} as RemoteTargetRegistry, "1.0.0");
    const onEvent = vi.fn();

    const cleanup = await pool.subscribeEventsForTarget(
      target,
      "project-1",
      {
        cursor: 5,
        limit: 10,
        category: "pty",
      },
      onEvent,
    );

    expect(client.call).toHaveBeenCalledWith("runtimeEvents.subscribe", {
      projectId: "project-1",
      cursor: 5,
      limit: 10,
      category: "pty",
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({
      id: 12,
      timestamp: "2026-05-10T12:00:00.000Z",
      category: "pty",
      payload: { type: "pty_data" },
    });

    client.emitNotification("runtime/event", {
      subscriptionId: "runtime-events-7",
      projectId: "project-1",
      event: {
        id: 14,
        timestamp: "2026-05-10T12:00:02.000Z",
        category: "runtime",
        payload: { type: "live" },
      },
    });
    expect(onEvent).toHaveBeenCalledTimes(2);

    cleanup();
    expect(client.call).toHaveBeenCalledWith("runtimeEvents.unsubscribe", {
      subscriptionId: "runtime-events-7",
    });
    client.emitNotification("runtime/event", {
      subscriptionId: "runtime-events-7",
      projectId: "project-1",
      event: {
        id: 15,
        timestamp: "2026-05-10T12:00:03.000Z",
        category: "runtime",
        payload: { type: "after_cleanup" },
      },
    });
    expect(onEvent).toHaveBeenCalledTimes(2);
  });
});
